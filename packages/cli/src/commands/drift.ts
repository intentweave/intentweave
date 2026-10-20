// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * drift command — Detect divergence between documentation and code.
 *
 * DEPRECATED: use `iw doc-health`, which runs the same CARI-backed analysis.
 * This command delegates to that analysis and keeps its output format.
 *
 * Usage:
 *   iw drift                          # CARI-backed report
 *   iw drift -f json -o drift.json    # JSON report written to a file
 *
 * @version 0.3
 */

import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import { analyzeFromCari } from "../doc-health/cariDocHealth.js";
import { renderUnifiedReport } from "../drift/unifiedReport.js";

export const driftCommand = new Command("drift")
  .description(
    "Detect drift between documentation and code (deprecated — use doc-health)",
  )
  .option("--db <path>", "Path to CARI index.db (default: .iw/index.db)")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .option("-o, --output <file>", "Write output to file")
  .option("-v, --verbose", "Verbose output", false)
  .action((opts) => {
    console.error(
      chalk.yellow(
        "⚠ `iw drift` is deprecated — use `iw doc-health` instead.\n",
      ),
    );

    const { format, output: outputFile, verbose } = opts;

    try {
      const log = verbose
        ? (msg: string) => console.error(chalk.blue(msg))
        : undefined;

      const { report, dbPath } = analyzeFromCari({
        dbPath: opts.db,
        log: log ?? undefined,
      });

      if (verbose) {
        console.error(chalk.blue(`Index: ${dbPath}`));
      }

      const formatted =
        format === "json"
          ? JSON.stringify(report, null, 2)
          : renderUnifiedReport(report);

      if (outputFile) {
        writeFileSync(outputFile, formatted, "utf-8");
        console.error(chalk.green(`Drift report written to ${outputFile}`));
      } else {
        console.log(formatted);
      }
    } catch (err: any) {
      console.error(chalk.red("Error:"), err.message ?? err);
      process.exit(1);
    }
  });
