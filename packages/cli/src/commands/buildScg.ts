// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw build scg — Build the SCG (Static Code Graph) layer.
 *
 * Runs: AX extraction → (optional) Neo4j persistence
 * Cost: $0.00 (AST parsing, no LLM)
 *
 * Usage:
 *   iw build scg -s intentweave --persist -v
 *
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import { performance } from "node:perf_hooks";
import { runAxStage } from "@intentweave/analyzer";
import { createNeo4jDriver } from "../kwg/persistKwg.js";
import { persistScg } from "../scg/scgPersist.js";

// =============================================================================
// Command
// =============================================================================

export const scgSubcommand = new Command("scg")
  .description("Build the SCG (code symbols) layer: AX extraction + Neo4j persist ($0.00)")
  .requiredOption("-s, --session <name>", "Session name")
  .option("--persist", "Persist SCG to Neo4j", false)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts) => {
    const { session, persist, verbose } = opts;
    const cwd = process.cwd();
    const log = verbose
      ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
      : () => {};

    console.log(chalk.blue(`\n  ▸ SCG Build — session: ${session}\n`));

    const pipelineStart = performance.now();
    let driver: any;

    try {
      // ── AX Extraction ──────────────────────────────────────────────
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

      // ── Persist to Neo4j ───────────────────────────────────────────
      if (persist) {
        driver = await createNeo4jDriver();
        log("Connected to Neo4j");

        const result = await persistScg(axOutput, session, driver, { log });

        console.log(
          chalk.gray(
            `       → Persisted: ${result.dirsWritten} dirs, ${result.filesWritten} files, ${result.symbolsWritten} symbols, ${result.containsEdges} edges`,
          ),
        );
        if (result.staleRemoved > 0) {
          console.log(
            chalk.gray(
              `       → Cleaned ${result.staleRemoved} stale nodes`,
            ),
          );
        }
      }

      // ── Done ───────────────────────────────────────────────────────
      const totalMs = performance.now() - pipelineStart;
      console.log(
        chalk.green(
          `\n  ✓ SCG built in ${(totalMs / 1000).toFixed(1)}s  │  $0.00\n`,
        ),
      );
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
