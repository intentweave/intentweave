// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw doc-health — Unified documentation health & drift analysis
 *
 * Answers: "Which parts of my documentation are stale, drifted, or missing?"
 *
 * Two modes:
 *   1. --lite    Zero-infra keyword scan (regex grounding, no index)
 *   2. (default) CARI-backed analysis from .iw/index.db
 *
 * Examples:
 *   iw doc-health                                     # CARI mode (default)
 *   iw doc-health --db path/to/index.db               # custom index path
 *   iw doc-health --lite docs/                        # zero-infra preflight
 *   iw doc-health -f json -o report.json              # JSON output
 *
 * @see PHASE-C-SPEC.md §9
 */

import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import {
  preflightDocHealth,
  formatPreflightMarkdown,
} from "../doc-health/index.js";
import { analyzeFromCari } from "../doc-health/cariDocHealth.js";
import { renderUnifiedReport } from "../drift/unifiedReport.js";

// =============================================================================
// Command
// =============================================================================

export const docHealthCommand = new Command("doc-health")
  .description(
    "Documentation health — detect stale, drifted, undocumented, and contradictory entities",
  )
  .argument(
    "[files...]",
    "Document file(s) to analyze (omit to scan all session docs)",
  )
  .option("-f, --format <fmt>", "Output format: markdown | json", "markdown")
  .option("-o, --output <path>", "Write output to file")
  .option("-v, --verbose", "Show progress on stderr")
  .option("--db <path>", "Path to CARI index.db (default: .iw/index.db)")
  .option("--lite", "Lightweight keyword-only mode — no index required")
  .action(async (files: string[], options) => {
    const { format, output, verbose, lite } = options;

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

    // ── Default mode: CARI-backed analysis ────────────────────────────
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
  });
