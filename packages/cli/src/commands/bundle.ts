// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * bundle command - Generate consolidated graph bundle from run
 */

import { Command } from "commander";
import chalk from "chalk";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { generateBundle, type BundleOptions } from "@intentweave/core";
import { IW_DIR, CLI_NAME } from "../constants.js";

export const bundleCommand = new Command("bundle")
  .description("Generate consolidated graph bundle from a run")
  .option("--run <runId>", "Run ID to bundle (default: latest)")
  .option(
    "--jsonl-threshold <n>",
    "Record count threshold for JSONL format",
    parseInt,
  )
  .action(async (options) => {
    const { run: runId, jsonlThreshold } = options;

    const cwd = process.cwd();
    const iwDir = path.join(cwd, IW_DIR);
    const runsDir = path.join(iwDir, "runs");

    if (!existsSync(runsDir)) {
      console.error(
        chalk.red("No runs found. Run the pipeline first with `iw run`."),
      );
      process.exit(1);
    }

    // Find run directory
    let targetRunId = runId;
    if (!targetRunId) {
      // Find latest run
      const runs = await fs.readdir(runsDir, { withFileTypes: true });
      const runDirs = runs
        .filter((d) => d.isDirectory() && d.name.startsWith("run-"))
        .map((d) => d.name)
        .sort()
        .reverse();

      if (runDirs.length === 0) {
        console.error(chalk.red("No runs found."));
        process.exit(1);
      }

      targetRunId = runDirs[0];
    }

    const runDir = path.join(runsDir, targetRunId);

    if (!existsSync(runDir)) {
      console.error(chalk.red(`Run not found: ${targetRunId}`));
      process.exit(1);
    }

    console.log(chalk.blue(`Generating bundle for run: ${targetRunId}`));

    try {
      const bundleOptions: BundleOptions = {};
      if (jsonlThreshold) {
        bundleOptions.jsonlThreshold = jsonlThreshold;
      }

      const result = await generateBundle({
        runDir,
        options: bundleOptions,
      });

      console.log(chalk.green("✓ Bundle generated successfully\n"));
      console.log(
        `  Format: ${result.format === "jsonl" ? "JSONL (streaming)" : "JSON"}`,
      );
      console.log(`  Entities: ${result.entityCount}`);
      console.log(`  Statements: ${result.statementCount}`);
      console.log(`  LX Proposals: ${result.lxCount}`);
      console.log(`\n  Files:`);
      console.log(`    ${path.join(runDir, "overview.json")}`);

      if (result.format === "jsonl") {
        console.log(`    ${path.join(runDir, "bundle", "artifacts.json")}`);
        console.log(`    ${path.join(runDir, "bundle", "entities.jsonl")}`);
        console.log(`    ${path.join(runDir, "bundle", "statements.jsonl")}`);
        console.log(`    ${path.join(runDir, "bundle", "lx.jsonl")}`);
      } else {
        console.log(`    ${result.bundlePath}`);
      }
    } catch (error) {
      console.error(chalk.red("Failed to generate bundle:"), error);
      process.exit(1);
    }
  });
