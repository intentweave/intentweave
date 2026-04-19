// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw doc-health — Unified documentation health & drift analysis
 *
 * Answers: "Which parts of my documentation are stale, drifted, or missing?"
 *
 * Three modes (least → most infrastructure):
 *   1. --lite    Zero-infra keyword scan (regex grounding, no index)
 *   2. (default) CARI-backed analysis from .iw/index.db (no Neo4j)
 *   3. --neo4j   Full KG-based analysis (requires Neo4j + persisted KWG)
 *
 * Examples:
 *   iw doc-health                                     # CARI mode (default)
 *   iw doc-health --db path/to/index.db               # custom index path
 *   iw doc-health --lite docs/                        # zero-infra preflight
 *   iw doc-health --neo4j -s planpling                # full KG mode
 *   iw doc-health --neo4j -s planpling --only doc-code,deps
 *   iw doc-health -f json -o report.json              # JSON output
 *
 * @see PHASE-C-SPEC.md §9
 */

import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  preflightDocHealth,
  formatPreflightMarkdown,
} from "../doc-health/index.js";
import { analyzeFromCari } from "../doc-health/cariDocHealth.js";

// Drift detectors (used in --neo4j mode)
import { detectDocCodeDrift } from "../drift/docCodeDrift.js";
import { detectTemporalDrift } from "../drift/temporalDrift.js";
import { detectDepsDrift } from "../drift/depsDrift.js";
import { detectDocDocDrift } from "../drift/docDocDrift.js";
import {
  assembleUnifiedReport,
  renderUnifiedReport,
  disabledDetectorStats,
} from "../drift/unifiedReport.js";

// Analyzer stages (used in --neo4j mode)
import {
  runAxStage,
  runTcxStage,
  runCocStage,
  runHotStage,
  runOwnStage,
  runStlStage,
} from "@intentweave/analyzer";
import type { AxOutput } from "@intentweave/analyzer";

// Core types
import type {
  KwgEntityForDrift,
  KwgMentionForDrift,
  TcgPipelineOutput,
  DetectorStats,
  UnifiedDriftReport,
  DriftSignal,
  SignalQualifier,
} from "@intentweave/core";

// Persistence
import { createGraphRunner } from "../persistence/graphRunner.js";

// =============================================================================
// Command
// =============================================================================

const VALID_DETECTORS = new Set(["doc-code", "temporal", "deps", "doc-doc"]);

export const docHealthCommand = new Command("doc-health")
  .description(
    "Documentation health — detect stale, drifted, undocumented, and contradictory entities",
  )
  .argument(
    "[files...]",
    "Document file(s) to analyze (omit to scan all session docs)",
  )
  .option("-s, --session <id>", "Session ID (required for --neo4j mode)", "")
  .option(
    "--only <detectors>",
    "Run specific detectors (comma-separated): doc-code,temporal,deps,doc-doc",
  )
  .option("-f, --format <fmt>", "Output format: markdown | json", "markdown")
  .option("-o, --output <path>", "Write output to file")
  .option("-v, --verbose", "Show progress on stderr")
  .option("--neo4j", "Full KG mode — requires Neo4j + persisted KWG", false)
  .option("--neo4j-uri <uri>", "Neo4j connection URI (implies --neo4j)")
  .option("--db <path>", "Path to CARI index.db (default: .iw/index.db)")
  .option(
    "--lite",
    "Lightweight keyword-only mode — no index or Neo4j required",
  )
  .action(async (files: string[], options) => {
    const { session: sessionId, format, output, verbose, lite } = options;
    const useNeo4j = options.neo4j || !!options.neo4jUri;

    // ── Lite mode: zero-infrastructure preflight ──────────────────────
    if (lite) {
      try {
        const cwd = process.cwd();
        const targets = files.length > 0 ? files : [cwd];
        const log = verbose
          ? (msg: string) => console.error(chalk.blue(msg))
          : undefined;

        const result = await preflightDocHealth({
          files: targets,
          cwd,
          log,
        });

        const formatted =
          format === "json"
            ? JSON.stringify(result, null, 2)
            : formatPreflightMarkdown(result);

        if (output) {
          writeFileSync(output, formatted, "utf-8");
          console.error(
            chalk.green(`Preflight doc health report written to ${output}`),
          );
        } else {
          console.log(formatted);
        }

        if (verbose) {
          const s = result.stats;
          console.error(
            chalk.blue(
              `\nPreflight: ${s.docsAnalyzed} docs, ${s.totalEntities} entities, ` +
                `${s.groundedCount} grounded, ${s.floatingCount} floating, ` +
                `avg grounding: ${s.avgGroundingPercent}%`,
            ),
          );
        }
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message ?? err);
        process.exit(1);
      }
      return;
    }

    // ── Default mode: CARI-backed analysis (no Neo4j) ─────────────────
    if (!useNeo4j) {
      try {
        const log = verbose
          ? (msg: string) => console.error(chalk.blue(msg))
          : undefined;

        const { report, dbPath } = analyzeFromCari({
          dbPath: options.db,
          log: log ?? undefined,
        });

        if (verbose) {
          console.error(chalk.blue(`Index: ${dbPath}`));
        }

        const formatted =
          format === "json"
            ? JSON.stringify(report, null, 2)
            : renderUnifiedReport(report);

        if (output) {
          writeFileSync(output, formatted, "utf-8");
          console.error(chalk.green(`Doc health report written to ${output}`));
        } else {
          console.log(formatted);
        }

        if (verbose) {
          const s = report.stats;
          console.error(
            chalk.blue(
              `\n${s.totalSignals} drift signals: ${s.criticalCount} critical, ${s.warningCount} warning, ${s.infoCount} info | ${(s.totalDurationMs / 1000).toFixed(1)}s`,
            ),
          );
        }
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message ?? err);
        process.exit(1);
      }
      return;
    }

    // ── Neo4j mode: full KG-based drift detection ─────────────────────

    if (!sessionId) {
      console.error(
        chalk.red(
          "Session ID required. Use --session <id> (e.g., --session planpling).",
        ),
      );
      process.exit(1);
    }

    // Parse --only flag
    const enabledDetectors = new Set<string>();
    if (options.only) {
      for (const d of options.only.split(",").map((s: string) => s.trim())) {
        if (!VALID_DETECTORS.has(d)) {
          console.error(
            chalk.red(
              `Unknown detector: "${d}". Valid: ${[...VALID_DETECTORS].join(", ")}`,
            ),
          );
          process.exit(1);
        }
        enabledDetectors.add(d);
      }
    } else {
      // All detectors enabled by default
      for (const d of VALID_DETECTORS) enabledDetectors.add(d);
    }

    const enableDocCode = enabledDetectors.has("doc-code");
    const enableTemporal = enabledDetectors.has("temporal");
    const enableDeps = enabledDetectors.has("deps");
    const enableDocDoc = enabledDetectors.has("doc-doc");

    const log = verbose
      ? (msg: string) => console.error(chalk.blue(msg))
      : () => {};
    const workspaceRoot = process.cwd();

    try {
      if (options.neo4jUri) {
        process.env.NEO4J_URI = options.neo4jUri;
      }
      const runner = createGraphRunner();
      log("Connected to graph database");

      // ─── Step 1: Load KWG data from graph database ────────────────

      const kwgEntities = await loadKwgEntities(runner, sessionId, log);
      const kwgMentions = await loadKwgMentions(runner, sessionId, log);

      const hasKwg = kwgEntities.length > 0;
      if (!hasKwg) {
        log("No KWG data found — doc-code, doc-doc detectors will be skipped");
      }

      // ─── Step 2: Run AX extraction (if needed) ────────────────────

      let axOutput: AxOutput | undefined;
      if (enableDocCode || enableDeps) {
        const axStart = performance.now();
        log("Running AX extraction (code symbols)...");
        try {
          axOutput = await runAxStage({ workspaceRoot });
          log(
            `AX: ${axOutput.totalFiles} files, ${axOutput.totalSymbols} symbols (${((performance.now() - axStart) / 1000).toFixed(1)}s)`,
          );
        } catch (err: any) {
          log(
            `AX extraction failed: ${err.message} — skipping code-dependent detectors`,
          );
        }
      }

      // ─── Step 3: Run TCG pipeline (if needed) ─────────────────────

      let tcgOutput: TcgPipelineOutput | undefined;
      if (enableTemporal) {
        const tcgStart = performance.now();
        log("Running TCG pipeline (git history)...");
        try {
          const tcxOutput = await runTcxStage({
            workspaceRoot,
            depth: "full",
            log: verbose
              ? (msg: string) => console.error(chalk.gray(`  tcx: ${msg}`))
              : undefined,
          });
          const cocOutput = runCocStage({ tcxOutput });
          const hotOutput = runHotStage({ tcxOutput });
          const ownOutput = runOwnStage({ tcxOutput });
          const stlOutput = runStlStage({
            tcxOutput,
            kwgEntities: kwgEntities.map((e) => e.name),
            workspaceRoot,
          });

          tcgOutput = {
            tcx: tcxOutput,
            coc: cocOutput,
            hot: hotOutput,
            own: ownOutput,
            stl: stlOutput,
            meta: {
              session: sessionId,
              workspaceRoot,
              gitDepth: "full history",
              totalDurationMs: performance.now() - tcgStart,
            },
          };
          log(
            `TCG: ${tcxOutput.commits.length} commits, ${cocOutput.edges.length} co-change edges (${((performance.now() - tcgStart) / 1000).toFixed(1)}s)`,
          );
        } catch (err: any) {
          log(
            `TCG pipeline failed: ${err.message} — skipping temporal detector`,
          );
        }
      }

      // ─── Step 4: Run detectors ────────────────────────────────────

      let docCodeSignals: DriftSignal[] = [];
      let docCodeStats: DetectorStats = disabledDetectorStats();

      let temporalSignals: DriftSignal[] = [];
      let temporalStats: DetectorStats = disabledDetectorStats();

      let depsSignals: DriftSignal[] = [];
      let depsStats: DetectorStats = disabledDetectorStats();

      let docDocSignals: DriftSignal[] = [];
      let docDocStats: DetectorStats = disabledDetectorStats();

      // 4a: Doc ↔ Code
      if (enableDocCode && hasKwg && axOutput) {
        const t0 = performance.now();
        log("Running doc-code drift detector...");
        const dcReport = await detectDocCodeDrift(
          runner,
          sessionId,
          axOutput,
          { log },
        );
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
        log(
          `  doc-code: ${dcReport.signals.length} signals (${((performance.now() - t0) / 1000).toFixed(1)}s)`,
        );
      } else if (enableDocCode) {
        log("Skipping doc-code: " + (!hasKwg ? "no KWG data" : "no AX output"));
      }

      // 4b: Temporal
      if (enableTemporal && tcgOutput) {
        const t0 = performance.now();
        log("Running temporal drift detector...");
        const result = detectTemporalDrift({
          tcgOutput,
          kwgEntities: hasKwg ? kwgEntities : undefined,
          kwgMentions: hasKwg ? kwgMentions : undefined,
          workspaceRoot,
          log,
        });
        temporalSignals = result.signals;
        temporalStats = result.stats;
        log(
          `  temporal: ${result.signals.length} signals (${((performance.now() - t0) / 1000).toFixed(1)}s)`,
        );
      } else if (enableTemporal) {
        log("Skipping temporal: no TCG data");
      }

      // 4c: Dependencies
      if (enableDeps && axOutput) {
        const t0 = performance.now();
        log("Running dependency drift detector...");
        const result = detectDepsDrift({
          axOutput,
          kwgEntities: hasKwg ? kwgEntities : undefined,
          kwgMentions: hasKwg ? kwgMentions : undefined,
          workspaceRoot,
          log,
        });
        depsSignals = result.signals;
        depsStats = result.stats;
        log(
          `  deps: ${result.signals.length} signals (${((performance.now() - t0) / 1000).toFixed(1)}s)`,
        );
      } else if (enableDeps) {
        log("Skipping deps: no AX output");
      }

      // 4d: Doc ↔ Doc
      if (enableDocDoc && hasKwg) {
        const t0 = performance.now();
        log("Running doc-doc drift detector...");
        const result = detectDocDocDrift({
          kwgEntities,
          kwgMentions,
          log,
        });
        docDocSignals = result.signals;
        docDocStats = result.stats;
        log(
          `  doc-doc: ${result.signals.length} signals (${((performance.now() - t0) / 1000).toFixed(1)}s)`,
        );
      } else if (enableDocDoc) {
        log("Skipping doc-doc: no KWG data");
      }

      // ─── Step 5: Assemble unified report ──────────────────────────

      const report = assembleUnifiedReport(
        sessionId,
        workspaceRoot,
        docCodeSignals,
        temporalSignals,
        depsSignals,
        docDocSignals,
        {
          docCode: docCodeStats,
          temporal: temporalStats,
          deps: depsStats,
          docDoc: docDocStats,
        },
      );

      // ─── Step 6: Output ───────────────────────────────────────────

      const formatted =
        format === "json"
          ? JSON.stringify(report, null, 2)
          : renderUnifiedReport(report);

      if (output) {
        writeFileSync(output, formatted, "utf-8");
        console.error(chalk.green(`Doc health report written to ${output}`));
      } else {
        console.log(formatted);
      }

      if (verbose) {
        const s = report.stats;
        console.error(
          chalk.blue(
            `\n${s.totalSignals} drift signals: ${s.criticalCount} critical, ${s.warningCount} warning, ${s.infoCount} info | ${(s.totalDurationMs / 1000).toFixed(1)}s`,
          ),
        );
      }
    } catch (err: any) {
      console.error(chalk.red("Error:"), err.message ?? err);
      process.exit(1);
    }
  });

// =============================================================================
// KWG data loaders (graph database → lightweight in-memory types)
// =============================================================================

type Runner = { run(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> };

async function loadKwgEntities(
  runner: Runner,
  session: string,
  log: (msg: string) => void,
): Promise<KwgEntityForDrift[]> {
  const rows = await runner.run(
    `MATCH (e:KWEntity {session_id: $session})
     RETURN e.name AS name,
            e.mentionCount AS mentionCount,
            e.qualifiers AS qualifiers,
            e.filePaths AS filePaths`,
    { session },
  );

  const entities: KwgEntityForDrift[] = rows.map((row) => ({
    name: row.name as string,
    mentionCount: typeof row.mentionCount === "number" ? row.mentionCount : 0,
    qualifiers: toStringArray(row.qualifiers) as SignalQualifier[],
    filePaths: toStringArray(row.filePaths),
  }));

  log(`Loaded ${entities.length} KWG entities`);
  return entities;
}

async function loadKwgMentions(
  runner: Runner,
  session: string,
  log: (msg: string) => void,
): Promise<KwgMentionForDrift[]> {
  const rows = await runner.run(
    `MATCH (m:KWMention {session_id: $session})
     RETURN m.entityName AS entityName,
            m.text AS text,
            m.heading AS heading,
            m.filePath AS filePath,
            m.startLine AS startLine,
            m.qualifiers AS qualifiers`,
    { session },
  );

  const mentions: KwgMentionForDrift[] = rows.map((row) => ({
    entityName: row.entityName as string,
    text: row.text as string,
    heading: row.heading as string | undefined,
    filePath: row.filePath as string,
    startLine: typeof row.startLine === "number" ? row.startLine : 0,
    qualifiers: toStringArray(row.qualifiers) as SignalQualifier[],
  }));

  log(`Loaded ${mentions.length} KWG mentions`);
  return mentions;
}

// =============================================================================
// Value helpers
// =============================================================================

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v ? [v] : [];
  return [];
}
