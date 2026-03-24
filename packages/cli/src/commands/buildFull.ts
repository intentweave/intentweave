// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw build full — Full multi-layer pipeline orchestrator.
 *
 * Runs all layers in optimal order:
 *   Stage 1: Cheap Pipeline (KWG + TCG + AX + Drift)  — $0
 *   Stage 2: Triage (rank entities by evidence)        — $0
 *   Stage 3: Selective SKG (LLM on triage chunks)      — $$
 *   Stage 4: Evidence Linking (EVIDENCED_BY + xlink)   — $0
 *   Stage 5: Embeddings (ONNX local)                   — $0
 *
 * Usage:
 *   iw build full docs/ -s intentweave --persist -v
 *   iw build full docs/ -s myproject --persist --provider openai -v
 *   iw build full docs/ -s myproject --persist --skip-skg -v   # cheap + embed only
 *
 * @see PHASE-D-SPEC.md §6
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

// Analyzer stages
import {
  runInStage,
  runKwxStage,
  runCoxStage,
  runClxStage,
  runAxStage,
  runTcxStage,
  runCocStage,
  runHotStage,
  runOwnStage,
  runStlStage,
  detectVerbHints,
  ConsoleLogger,
  NoopLogger,
} from "@intentweave/analyzer";
import type {
  InStageInput,
  VerbHint,
  VerbDetectorResult,
} from "@intentweave/analyzer";

// Core types
import type {
  KwxStageOutput,
  KwgPipelineOutput,
  TcgPipelineOutput,
  KwgEntityForDrift,
  KwgMentionForDrift,
  DetectorStats,
  DriftSignal,
} from "@intentweave/core";

// KWG / TCG / SCG persistence
import { persistKwg, createNeo4jDriver } from "../kwg/persistKwg.js";
import { persistTcg } from "../tcg/persistTcg.js";
import { persistScg } from "../scg/scgPersist.js";

// Drift detectors
import { detectDocCodeDrift } from "../drift/docCodeDrift.js";
import { detectTemporalDrift } from "../drift/temporalDrift.js";
import { detectDepsDrift } from "../drift/depsDrift.js";
import { detectDocDocDrift } from "../drift/docDocDrift.js";
import {
  assembleUnifiedReport,
  renderUnifiedReport,
  disabledDetectorStats,
} from "../drift/unifiedReport.js";
import { persistDrift } from "../drift/persistDrift.js";

// D1: Triage
import { triageFromEvidence } from "../triage/triageAnalyzer.js";
import type { TriageResult } from "../triage/triageAnalyzer.js";

// D2: Evidence linker
import { linkEvidencedBy } from "../linker/evidenceLinker.js";

// D7: Embedding pipeline
import { runEmbedPipeline } from "../embed/embedPipeline.js";

// =============================================================================
// File Discovery (shared with buildCheap)
// =============================================================================

const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

async function discoverFiles(
  paths: string[],
  cwd: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;

    if (stat.isFile()) {
      if (SUPPORTED_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
        files.push(abs);
      }
    } else if (stat.isDirectory()) {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const subPaths = entries.map((e) =>
        path.join(abs, e.name),
      );
      files.push(...(await discoverFiles(subPaths, cwd)));
    }
  }
  return [...new Set(files)].sort();
}

function toArtifactId(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  return rel.replace(/[/\\]/g, ".").replace(/\.[^.]+$/, "");
}

function createMinimalContext(verbose: boolean) {
  const logger = verbose ? new ConsoleLogger("[full]") : new NoopLogger();
  return {
    logger,
    workspace: { root: process.cwd(), key: "full" },
    runId: `full-${Date.now()}`,
    store: null as any,
    profile: null as any,
    providers: null as any,
    now: () => new Date(),
    timestamp: () => new Date().toISOString(),
  };
}

// =============================================================================
// Stage progress bar
// =============================================================================

function stageBar(name: string, color: (s: string) => string, sec: number): string {
  return `  ${name.padEnd(5)} ${color("████████████████████████████████")}  ${sec.toFixed(1)}s`;
}

// =============================================================================
// Command
// =============================================================================

export const fullSubcommand = new Command("full")
  .description(
    "Full multi-layer pipeline: KWG + TCG + AX + Drift + Triage + SKG + Links + Embed",
  )
  .argument("<paths...>", "Document file(s) or directories to analyze")
  .requiredOption("-s, --session <name>", "Session name")
  .option("--persist", "Persist all layers to Neo4j", false)
  .option("--provider <name>", "LLM provider for SKG stage: openai | smart-mock", "openai")
  .option("--model <name>", "Model for SKG extraction", "gpt-4o-mini")
  .option("--max-candidates <n>", "Max triage candidates for SKG", "50")
  .option("--skip-skg", "Skip SKG extraction (cheap + embed only)", false)
  .option("--skip-embed", "Skip embeddings stage", false)
  .option("--verb-hints", "Detect verb patterns on CO_OCCURS edges", false)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    const {
      session,
      persist,
      provider,
      model,
      maxCandidates: maxCandStr,
      skipSkg,
      skipEmbed,
      verbose,
      verbHints,
    } = opts;
    const maxCandidates = parseInt(maxCandStr, 10) || 50;
    const cwd = process.cwd();
    const log = verbose
      ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
      : () => {};

    console.log(chalk.blue(`\n  ▸ Full Pipeline — session: ${session}`));
    if (skipSkg) {
      console.log(chalk.blue(`  ▸ SKG skipped — $0.00 total (cheap + embed)\n`));
    } else {
      console.log(chalk.blue(`  ▸ Selective SKG via ${provider}/${model} — top ${maxCandidates} candidates\n`));
    }

    const pipelineStart = performance.now();
    let driver: any;

    try {
      // ── Connect Neo4j ────────────────────────────────────────────
      if (persist) {
        driver = await createNeo4jDriver();
        log("Connected to Neo4j");
      }

      // ════════════════════════════════════════════════════════════════
      // Stage 1: Cheap Pipeline (KWG + TCG + AX + Drift)
      // ════════════════════════════════════════════════════════════════

      const stage1Start = performance.now();

      // ── 1a: KWG Pipeline ──────────────────────────────────────────

      const kwgStart = performance.now();
      log("Discovering document files...");
      const docFiles = await discoverFiles(paths, cwd);
      if (docFiles.length === 0) {
        console.error(chalk.red("No document files found in the given paths."));
        process.exit(1);
      }
      log(`Found ${docFiles.length} document files`);

      const ctx = createMinimalContext(verbose);

      // Per-file: IN → KWX
      const kwxOutputs = new Map<string, KwxStageOutput>();
      for (const filePath of docFiles) {
        const relPath = path.relative(cwd, filePath);
        log(`  KWX: ${relPath}`);

        const content = await fs.readFile(filePath, "utf-8");
        const artifactId = toArtifactId(filePath, cwd);

        const inInput: InStageInput = {
          artifactId,
          filePath: relPath,
          content,
        };
        const inOutput = await runInStage(inInput, ctx as any);
        const kwxOutput = await runKwxStage({ inOutput });
        kwxOutputs.set(relPath, kwxOutput);
      }

      // Session-level: COX → CLX
      const coxOutput = await runCoxStage({
        kwxOutputs: [...kwxOutputs.values()],
      });
      const clxOutput = await runClxStage({
        coxOutput,
        kwxOutputs: [...kwxOutputs.values()],
      });

      const kwgOutput: KwgPipelineOutput = {
        kwxOutputs,
        coxOutput,
        clxOutput,
        meta: {
          totalFiles: docFiles.length,
          totalTimeMs: performance.now() - kwgStart,
        },
      };

      const totalEntities = [...kwxOutputs.values()].reduce(
        (acc, o) => acc + o.entities.length,
        0,
      );
      const totalMentions = [...kwxOutputs.values()].reduce(
        (acc, o) => acc + o.mentions.length,
        0,
      );

      // Verb hints
      let verbHintResult: VerbDetectorResult | undefined;
      if (verbHints) {
        const allMentions = [...kwxOutputs.values()].flatMap((o) => o.mentions);
        verbHintResult = detectVerbHints(allMentions);
      }

      // Persist KWG
      if (persist && driver) {
        log("Persisting KWG to Neo4j...");
        await persistKwg(kwgOutput, session, driver, { log });
        log("KWG persisted");

        // Persist verb hints
        if (verbHintResult && verbHintResult.hints.length > 0) {
          log("Persisting verb hints on CO_OCCURS edges...");
          const neo4jSession = driver.session();
          try {
            const edgeHints = new Map<string, string[]>();
            for (const h of verbHintResult.hints) {
              const [a, b] = h.subjectName < h.objectName
                ? [h.subjectName, h.objectName]
                : [h.objectName, h.subjectName];
              const key = `${a}|||${b}`;
              if (!edgeHints.has(key)) edgeHints.set(key, []);
              edgeHints.get(key)!.push(h.predicate);
            }
            const edgeHintArray = [...edgeHints.entries()].map(([key, preds]) => {
              const [entityA, entityB] = key.split("|||");
              return { entityA, entityB, verbHints: [...new Set(preds)] };
            });
            await neo4jSession.run(
              `
              UNWIND $edges AS e
              MATCH (a:KWEntity {name: e.entityA, session_id: $session})-[co:CO_OCCURS]-(b:KWEntity {name: e.entityB, session_id: $session})
              SET co.verbHints = e.verbHints
              `,
              { edges: edgeHintArray, session },
            );
            log(`Verb hints persisted on ${edgeHintArray.length} CO_OCCURS edges`);
          } finally {
            await neo4jSession.close();
          }
        }
      }

      // ── 1b: TCG Pipeline ──────────────────────────────────────────

      const tcgStart = performance.now();
      const tcxOutput = await runTcxStage({
        workspaceRoot: cwd,
        depth: "full",
        log: verbose ? (msg: string) => console.log(chalk.gray(`  tcx: ${msg}`)) : undefined,
      });
      const cocTcgOutput = runCocStage({ tcxOutput });
      const hotOutput = runHotStage({ tcxOutput });
      const ownOutput = runOwnStage({ tcxOutput });
      const stlOutput = runStlStage({
        tcxOutput,
        kwgEntities: [...kwxOutputs.values()]
          .flatMap((o) => o.entities)
          .map((e) => e.name),
        workspaceRoot: cwd,
      });

      const tcgOutput: TcgPipelineOutput = {
        tcx: tcxOutput,
        coc: cocTcgOutput,
        hot: hotOutput,
        own: ownOutput,
        stl: stlOutput,
        meta: {
          session,
          workspaceRoot: cwd,
          gitDepth: "full history",
          totalDurationMs: performance.now() - tcgStart,
        },
      };

      // Persist TCG
      if (persist && driver) {
        log("Persisting TCG to Neo4j...");
        await persistTcg(tcgOutput, session, driver, { log });
        log("TCG persisted");
      }

      // ── 1c: AX Extraction + SCG Persist ──────────────────────────

      const axStart = performance.now();
      const axOutput = await runAxStage({ workspaceRoot: cwd });
      const axMs = performance.now() - axStart;

      // Persist SCG
      if (persist && driver) {
        log("Persisting SCG to Neo4j...");
        const scgResult = await persistScg(axOutput, session, driver, { log });
        log(`SCG persisted: ${scgResult.dirsWritten} dirs, ${scgResult.filesWritten} files, ${scgResult.symbolsWritten} symbols`);
      }

      // ── 1d: Drift Detection ──────────────────────────────────────

      const driftStart = performance.now();

      const kwgEntities: KwgEntityForDrift[] = [...kwxOutputs.values()]
        .flatMap((o) => o.entities)
        .map((e) => ({
          name: e.name,
          mentionCount: e.mentionCount ?? 0,
          qualifiers: (e as any).qualifiers ?? [],
          filePaths: (e as any).filePaths ?? [],
        }));

      const kwgMentions: KwgMentionForDrift[] = [...kwxOutputs.values()]
        .flatMap((o) => o.mentions)
        .map((m) => ({
          entityName: m.entityName,
          text: m.text,
          heading: (m as any).heading,
          filePath: m.filePath,
          startLine: m.startLine ?? 0,
          qualifiers: (m as any).qualifiers ?? [],
        }));

      let docCodeSignals: DriftSignal[] = [];
      let docCodeStats: DetectorStats = disabledDetectorStats();
      if (persist && driver) {
        const t0 = performance.now();
        const dcReport = await detectDocCodeDrift(driver, session, axOutput, { log });
        docCodeSignals = dcReport.signals;
        docCodeStats = {
          enabled: true,
          signalCount: dcReport.signals.length,
          durationMs: performance.now() - t0,
          metrics: {
            ungroundedCount: dcReport.stats.ungroundedCount,
            undocumentedCount: dcReport.stats.undocumentedCount,
            signatureMismatchCount: dcReport.stats.signatureMismatchCount,
          },
        };
      }

      const temporalResult = detectTemporalDrift({
        tcgOutput,
        kwgEntities,
        kwgMentions,
        workspaceRoot: cwd,
        log,
      });

      const depsResult = detectDepsDrift({
        axOutput,
        kwgEntities,
        kwgMentions,
        workspaceRoot: cwd,
        log,
      });

      const docDocResult = detectDocDocDrift({
        kwgEntities,
        kwgMentions,
        log,
      });

      const report = assembleUnifiedReport(
        session,
        cwd,
        docCodeSignals,
        temporalResult.signals,
        depsResult.signals,
        docDocResult.signals,
        {
          docCode: docCodeStats,
          temporal: temporalResult.stats,
          deps: depsResult.stats,
          docDoc: docDocResult.stats,
        },
      );

      // Persist drift signals
      if (persist && driver) {
        log("Persisting drift signals to Neo4j...");
        const driftPersist = await persistDrift(report, session, driver, { log });
        log(`Drift persist: ${driftPersist.nodesCreated} signals, ${driftPersist.relsCreated} rels`);
      }

      const stage1Ms = performance.now() - stage1Start;
      console.log(stageBar("CHEAP", chalk.green, stage1Ms / 1000));
      console.log(
        chalk.gray(
          `       → KWG: ${totalEntities} entities, ${totalMentions} mentions, ${coxOutput.edges.length} co-occ, ${clxOutput.clusters.length} clusters`,
        ),
      );
      console.log(
        chalk.gray(
          `       → TCG: ${tcxOutput.commits.length} commits, ${cocTcgOutput.edges.length} co-change edges`,
        ),
      );
      console.log(
        chalk.gray(
          `       → AXE: ${axOutput.totalFiles} files, ${axOutput.totalSymbols} symbols`,
        ),
      );
      console.log(
        chalk.gray(
          `       → DRF: ${report.stats.totalSignals} drift signals (${report.stats.criticalCount} critical, ${report.stats.warningCount} warning)`,
        ),
      );
      if (verbHintResult) {
        console.log(
          chalk.gray(
            `       → VRB: ${verbHintResult.hints.length} verb hints from ${verbHintResult.stats.pairsScanned} pairs`,
          ),
        );
      }

      // ════════════════════════════════════════════════════════════════
      // Stage 2: Triage (rank entities by evidence)
      // ════════════════════════════════════════════════════════════════

      let triageResult: TriageResult | undefined;

      if (persist && driver && !skipSkg) {
        const stage2Start = performance.now();
        triageResult = await triageFromEvidence(driver, {
          sessionId: session,
          maxCandidates,
          minScore: 5,
          log,
        });
        const stage2Ms = performance.now() - stage2Start;

        console.log(stageBar("TRAGE", chalk.yellow, stage2Ms / 1000));
        console.log(
          chalk.gray(
            `       → ${triageResult.candidates.length} candidates from ${triageResult.totalKwgEntities} entities (${triageResult.skippedAlreadyInSkg} already in SKG)`,
          ),
        );
      }

      // ════════════════════════════════════════════════════════════════
      // Stage 3: Selective SKG (LLM extraction on triage chunks)
      // ════════════════════════════════════════════════════════════════

      if (!skipSkg && triageResult && triageResult.candidates.length > 0) {
        const stage3Start = performance.now();

        // Identify which chunks contain triage candidate entities
        const candidateNames = new Set(
          triageResult.candidates.map((c) => c.entityName.toLowerCase()),
        );

        // Build all chunks from IN outputs (reuse the chunked document structure)
        const allMentions = [...kwxOutputs.values()].flatMap((o) => o.mentions);

        // Find files containing triage candidates (via KWG mentions)
        const candidateFiles = new Set<string>();
        for (const m of allMentions) {
          if (candidateNames.has(m.entityName.toLowerCase())) {
            candidateFiles.add(m.filePath);
          }
        }

        if (candidateFiles.size > 0) {
          log(`Selective SKG: ${candidateFiles.size} files contain triage candidates`);

          // Import the open track runner
          try {
            const {
              runOpenTrackBatch,
              createPipelineContext,
              createFileStore,
              createDefaultExtractionProvider,
              convertProfileForAnalyzer,
            } = await import("@intentweave/analyzer");
            const { OpenAILLMProvider, SmartMockLLMProvider } = await import(
              "@intentweave/analyzer/llm"
            );
            const { createWorkspaceRef } = await import("@intentweave/core");
            const { profileRegistry } = await import("@intentweave/profiles");

            // Set up LLM provider
            let llmProvider: any;
            if (provider === "openai") {
              const apiKey = process.env.OPENAI_API_KEY;
              if (!apiKey) {
                console.log(
                  chalk.yellow("  ⚠ OPENAI_API_KEY not set — skipping SKG stage"),
                );
                console.log(
                  chalk.yellow('    Set OPENAI_API_KEY="sk-proj-..." to enable SKG'),
                );
              } else {
                llmProvider = new OpenAILLMProvider({ apiKey, model });
              }
            } else {
              llmProvider = new SmartMockLLMProvider({ workspaceKey: session });
            }

            if (llmProvider) {
              const extractionProvider = createDefaultExtractionProvider(llmProvider, {
                parallelChunks: 5,
              });
              const workspace = createWorkspaceRef(session, session);
              const store = createFileStore({
                rootDir: path.join(cwd, ".iw", "runs", `full-${Date.now()}`),
              });

              // Resolve profile (default: standard)
              const registryProfile = profileRegistry.resolve("standard");
              const profile = convertProfileForAnalyzer(registryProfile!);

              // Build artifact inputs for candidate files only
              const artifacts: any[] = [];
              for (const relPath of candidateFiles) {
                const absPath = path.resolve(cwd, relPath);
                try {
                  const content = await fs.readFile(absPath, "utf-8");
                  artifacts.push({
                    artifactId: toArtifactId(absPath, cwd),
                    filePath: relPath,
                    content,
                  });
                } catch {
                  log(`  Skipping ${relPath} (read error)`);
                }
              }

              if (artifacts.length > 0) {
                const pipelineCtx = createPipelineContext({
                  workspace,
                  runId: `full-skg-${Date.now()}`,
                  store,
                  profile,
                  providers: {
                    llm: llmProvider,
                    extraction: extractionProvider,
                  },
                });

                log(`Running open track on ${artifacts.length} files...`);
                const openResults = await runOpenTrackBatch(artifacts, pipelineCtx, {
                  llmProvider,
                  concurrency: 5,
                  onStage: (stage: any) => {
                    if (verbose) {
                      log(`  FX/KX: ${stage.artifactId ?? ''} — ${stage.stage ?? stage}`);
                    }
                  },
                });

                // Count results
                const totalEntitiesSKG = openResults.reduce(
                  (acc: number, r: any) => acc + (r.kx?.canonEntities?.length ?? 0),
                  0,
                );
                const totalRels = openResults.reduce(
                  (acc: number, r: any) => acc + (r.kx?.canonTriples?.length ?? 0),
                  0,
                );

                const stage3Ms = performance.now() - stage3Start;
                console.log(stageBar("SKG", chalk.magenta, stage3Ms / 1000));
                console.log(
                  chalk.gray(
                    `       → ${artifacts.length} files, ${totalEntitiesSKG} entities, ${totalRels} relationships`,
                  ),
                );

                // Persist open track results to Neo4j
                if (persist && driver) {
                  try {
                    const { persistKxToNeo4j } = await import("./persist-neo4j.js");
                    const kxOutputs = openResults.map((r: any) => r.kx);
                    const persistResult = await persistKxToNeo4j(kxOutputs, {
                      sessionId: session,
                      runId: `full-skg-${Date.now()}`,
                      workspaceId: session,
                      mode: "delta",
                      log: verbose ? (msg: string) => console.log(chalk.dim(`  ${msg}`)) : undefined,
                    });
                    log(`SKG persisted: ${persistResult.canonEntitiesWritten ?? totalEntitiesSKG} entities, ${persistResult.canonRelationshipsWritten ?? totalRels} rels`);
                  } catch (err: any) {
                    log(`SKG persist failed: ${err.message}`);
                  }
                }
              }
            }
          } catch (err: any) {
            const stage3Ms = performance.now() - stage3Start;
            console.log(stageBar("SKG", chalk.red, stage3Ms / 1000));
            console.log(chalk.yellow(`       → SKG skipped: ${err.message}`));
          }
        } else {
          console.log(`  SKG   ${chalk.gray("(no candidate files found)")}`);
        }
      } else if (skipSkg) {
        console.log(`  SKG   ${chalk.gray("(skipped via --skip-skg)")}`);
      } else if (!persist) {
        console.log(`  SKG   ${chalk.gray("(skipped — requires --persist)")}`);
      }

      // ════════════════════════════════════════════════════════════════
      // Stage 4: Evidence Linking (EVIDENCED_BY + REALIZED_BY)
      // ════════════════════════════════════════════════════════════════

      if (persist && driver) {
        const stage4Start = performance.now();

        // D2: EVIDENCED_BY (Canon → KWEntity)
        let evidenceLinks = 0;
        try {
          const evResult = await linkEvidencedBy(driver, session, { log });
          evidenceLinks = evResult.linksCreated;
        } catch (err: any) {
          log(`Evidence linking: ${err.message}`);
        }

        // Cross-layer: REALIZED_BY (Canon → CodeRef via xlink)
        let realizedByLinks = 0;
        try {
          const { runCrossLayerLinker, persistCrossLinks } = await import(
            "../linker/index.js"
          );

          // Load Canon entities from Neo4j to check if linking is needed
          const xlinkSession = driver.session();
          try {
            const res = await xlinkSession.run(
              `MATCH (c:Canon:Entity {session_id: $sid})
               RETURN count(c) AS cnt`,
              { sid: session },
            );
            const entityCount = res.records[0]?.get("cnt")?.toNumber?.() ?? res.records[0]?.get("cnt") ?? 0;

            if (entityCount > 0) {
              const xlinkResult = await runCrossLayerLinker({
                runner: driver,
                sessionId: session,
                codebaseDir: cwd,
                strategies: ["dep", "import", "name", "path"],
                log,
              });

              if (xlinkResult.links.length > 0) {
                await persistCrossLinks(
                  driver,
                  session,
                  xlinkResult.links,
                  log,
                );
                realizedByLinks = xlinkResult.links.length;
              }
            }
          } finally {
            await xlinkSession.close();
          }
        } catch (err: any) {
          log(`Cross-layer linking: ${err.message}`);
        }

        const stage4Ms = performance.now() - stage4Start;
        console.log(stageBar("LINK", chalk.cyan, stage4Ms / 1000));
        console.log(
          chalk.gray(
            `       → ${evidenceLinks} EVIDENCED_BY, ${realizedByLinks} REALIZED_BY`,
          ),
        );
      } else {
        console.log(`  LINK  ${chalk.gray("(skipped — requires --persist)")}`);
      }

      // ════════════════════════════════════════════════════════════════
      // Stage 5: Embeddings (ONNX local)
      // ════════════════════════════════════════════════════════════════

      if (!skipEmbed && persist && driver) {
        const stage5Start = performance.now();

        try {
          const embedResult = await runEmbedPipeline(driver, {
            sessionId: session,
            layers: ["kwg", "skg", "cluster"],
            batchSize: 100,
            skipExisting: true,
            log,
          });

          const stage5Ms = performance.now() - stage5Start;
          const totalEmbedded = Object.values(embedResult.embedded).reduce(
            (a, b) => a + b,
            0,
          );
          const totalSkipped = Object.values(embedResult.skipped).reduce(
            (a, b) => a + b,
            0,
          );

          console.log(stageBar("EMBED", chalk.blue, stage5Ms / 1000));
          console.log(
            chalk.gray(
              `       → ${totalEmbedded} embedded, ${totalSkipped} skipped, ${embedResult.indexesCreated.length} indexes`,
            ),
          );
        } catch (err: any) {
          const stage5Ms = performance.now() - stage5Start;
          console.log(stageBar("EMBED", chalk.red, stage5Ms / 1000));
          console.log(
            chalk.yellow(
              `       → Embedding skipped: ${err.message}`,
            ),
          );
          if (err.message.includes("@huggingface/transformers") || err.message.includes("onnxruntime")) {
            console.log(
              chalk.yellow(
                `       → Install: pnpm add @huggingface/transformers -w`,
              ),
            );
          }
        }
      } else if (skipEmbed) {
        console.log(`  EMBED ${chalk.gray("(skipped via --skip-embed)")}`);
      } else {
        console.log(`  EMBED ${chalk.gray("(skipped — requires --persist)")}`);
      }

      // ════════════════════════════════════════════════════════════════
      // Summary
      // ════════════════════════════════════════════════════════════════

      const totalMs = performance.now() - pipelineStart;
      const layers = ["KWG", "TCG", "SCG", "Drift"];
      if (!skipSkg) layers.push("SKG");
      layers.push("Links");
      if (!skipEmbed) layers.push("Embed");

      console.log(
        chalk.green(
          `\n  ✓ Full graph built  │  ${layers.join(" + ")}  │  ${(totalMs / 1000).toFixed(1)}s\n`,
        ),
      );

      // Print drift highlights
      if (report.stats.criticalCount > 0 && verbose) {
        console.log(renderUnifiedReport(report));
      }
    } catch (err: any) {
      console.error(chalk.red("Error:"), err.message ?? err);
      if (verbose && err.stack) console.error(err.stack);
      process.exit(1);
    } finally {
      if (driver) {
        try {
          await driver.close();
        } catch {
          /* ignore */
        }
      }
    }
  });
