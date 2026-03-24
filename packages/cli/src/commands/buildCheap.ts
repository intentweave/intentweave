// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw build cheap — Full non-LLM evidence pipeline in one command.
 *
 * Runs: KWG → TCG → AX → Drift detection
 * Cost: $0.00 (no LLM calls, all heuristic)
 *
 * Usage:
 *   iw build cheap docs/ -s planpling --persist -v
 *
 * @see PHASE-C-SPEC.md §10
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
  ConsoleLogger,
  NoopLogger,
  detectVerbHints,
} from "@intentweave/analyzer";
import type { VerbHint, VerbDetectorResult } from "@intentweave/analyzer";
import type {
  InStageInput,
  AxOutput,
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

// =============================================================================
// File Discovery (same as buildKwg)
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
  const logger = verbose ? new ConsoleLogger("[cheap]") : new NoopLogger();
  return {
    logger,
    workspace: { root: process.cwd(), key: "cheap" },
    runId: `cheap-${Date.now()}`,
    store: null as any,
    profile: null as any,
    providers: null as any,
    now: () => new Date(),
    timestamp: () => new Date().toISOString(),
  };
}

// =============================================================================
// Command
// =============================================================================

export const cheapSubcommand = new Command("cheap")
  .description(
    "Full non-LLM pipeline: KWG + TCG + AX + drift ($0.00, all heuristic)",
  )
  .argument("<paths...>", "Document file(s) or directories to analyze")
  .requiredOption("-s, --session <name>", "Session name")
  .option("--persist", "Persist KWG + TCG to Neo4j", false)
  .option("--verb-hints", "Detect verb patterns on CO_OCCURS edges", false)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    const { session, persist, verbose, verbHints } = opts;
    const cwd = process.cwd();
    const log = verbose
      ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
      : () => {};

    console.log(chalk.blue(`\n  ▸ Cheap Pipeline — session: ${session}`));
    console.log(chalk.blue(`  ▸ $0.00 — no LLM calls, all heuristic\n`));

    const pipelineStart = performance.now();
    let driver: any;

    try {
      // ── Connect Neo4j if persisting ──────────────────────────────
      if (persist) {
        driver = await createNeo4jDriver();
        log("Connected to Neo4j");
      }

      // ════════════════════════════════════════════════════════════════
      // Stage 1: KWG Pipeline (IN → KWX → COX → CLX)
      // ════════════════════════════════════════════════════════════════

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

      const kwgMs = performance.now() - kwgStart;
      const totalEntities = [...kwxOutputs.values()].reduce(
        (acc, o) => acc + o.entities.length,
        0,
      );
      const totalMentions = [...kwxOutputs.values()].reduce(
        (acc, o) => acc + o.mentions.length,
        0,
      );

      console.log(
        `  KWG  ${chalk.green("████████████████████████████████")}  ${(kwgMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `       → ${totalEntities} entities, ${totalMentions} mentions, ${coxOutput.edges.length} co-occurrence edges, ${clxOutput.clusters.length} clusters`,
        ),
      );

      // Optional: Verb hint detection
      let verbHintResult: VerbDetectorResult | undefined;
      if (verbHints) {
        const verbStart = performance.now();
        const allMentions = [...kwxOutputs.values()].flatMap((o) => o.mentions);
        verbHintResult = detectVerbHints(allMentions);
        const verbMs = performance.now() - verbStart;
        console.log(
          `  VERB ${chalk.cyan("████████████████████████████████")}  ${(verbMs / 1000).toFixed(1)}s`,
        );
        console.log(
          chalk.gray(
            `       → ${verbHintResult.hints.length} verb hints from ${verbHintResult.stats.pairsScanned} pairs`,
          ),
        );
        if (verbose && verbHintResult.hints.length > 0) {
          const top = verbHintResult.hints.slice(0, 10);
          for (const h of top) {
            log(`  ${h.subjectName} --${h.predicate}--> ${h.objectName} (${h.confidence.toFixed(2)})`);
          }
        }
      }

      // Persist KWG
      if (persist && driver) {
        log("Persisting KWG to Neo4j...");
        await persistKwg(kwgOutput, session, driver, { log });
        log("KWG persisted");

        // Persist verb hints on CO_OCCURS edges (if available)
        if (verbHintResult && verbHintResult.hints.length > 0) {
          log("Persisting verb hints on CO_OCCURS edges...");
          const neo4jSession = driver.session();
          try {
            const hintParams = verbHintResult.hints.map((h: VerbHint) => ({
              subjectName: h.subjectName,
              objectName: h.objectName,
              predicate: h.predicate,
              confidence: h.confidence,
            }));
            // Group hints by edge (subject+object pair) and collect predicates
            const edgeHints = new Map<string, string[]>();
            for (const h of hintParams) {
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

      // ════════════════════════════════════════════════════════════════
      // Stage 2: TCG Pipeline (TCX → COC → HOT → OWN → STL)
      // ════════════════════════════════════════════════════════════════

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

      const tcgMs = performance.now() - tcgStart;
      console.log(
        `  TCG  ${chalk.green("████████████████████████████████")}  ${(tcgMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `       → ${tcxOutput.commits.length} commits, ${tcxOutput.meta.authorCount} authors, ${cocTcgOutput.edges.length} co-change edges, ${hotOutput.meta.hotspotCount} hotspots`,
        ),
      );

      // Persist TCG
      if (persist && driver) {
        log("Persisting TCG to Neo4j...");
        await persistTcg(tcgOutput, session, driver, { log });
        log("TCG persisted");
      }

      // ════════════════════════════════════════════════════════════════
      // Stage 3: AX Extraction (code symbols)
      // ════════════════════════════════════════════════════════════════

      const axStart = performance.now();
      const axOutput = await runAxStage({ workspaceRoot: cwd });
      const axMs = performance.now() - axStart;
      console.log(
        `  AXE  ${chalk.green("████████████████████████████████")}  ${(axMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `       → ${axOutput.totalFiles} files, ${axOutput.totalSymbols} code symbols`,
        ),
      );

      // Persist SCG
      if (persist && driver) {
        log("Persisting SCG to Neo4j...");
        const scgResult = await persistScg(axOutput, session, driver, { log });
        log(`SCG persisted: ${scgResult.dirsWritten} dirs, ${scgResult.filesWritten} files, ${scgResult.symbolsWritten} symbols`);
      }

      // ════════════════════════════════════════════════════════════════
      // Stage 4: Drift Detection (all 4 detectors)
      // ════════════════════════════════════════════════════════════════

      const driftStart = performance.now();

      // Build KWG data in lightweight form for detectors
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

      // 4a: Doc ↔ Code (needs driver for its own Neo4j queries)
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

      // 4b: Temporal
      const temporalResult = detectTemporalDrift({
        tcgOutput,
        kwgEntities,
        kwgMentions,
        workspaceRoot: cwd,
        log,
      });

      // 4c: Dependencies
      const depsResult = detectDepsDrift({
        axOutput,
        kwgEntities,
        kwgMentions,
        workspaceRoot: cwd,
        log,
      });

      // 4d: Doc ↔ Doc
      const docDocResult = detectDocDocDrift({
        kwgEntities,
        kwgMentions,
        log,
      });

      const driftMs = performance.now() - driftStart;

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

      console.log(
        `  DRF  ${chalk.green("████████████████████████████████")}  ${(driftMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `       → ${report.stats.totalSignals} drift signals (${report.stats.criticalCount} critical, ${report.stats.warningCount} warning, ${report.stats.infoCount} info)`,
        ),
      );

      // Persist drift signals
      if (persist && driver) {
        log("Persisting drift signals to Neo4j...");
        const driftPersist = await persistDrift(report, session, driver, { log });
        log(`Drift persist: ${driftPersist.nodesCreated} signals, ${driftPersist.relsCreated} rels`);
      }

      // ════════════════════════════════════════════════════════════════
      // Summary
      // ════════════════════════════════════════════════════════════════

      const totalMs = performance.now() - pipelineStart;
      console.log(
        chalk.green(
          `\n  ✓ Evidence graph built  │  KWG + TCG + SCG + Drift  │  ${(totalMs / 1000).toFixed(1)}s  │  $0.00\n`,
        ),
      );

      // Print drift report
      if (report.stats.totalSignals > 0) {
        console.log(renderUnifiedReport(report));
      }
    } catch (err: any) {
      console.error(chalk.red("Error:"), err.message ?? err);
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
