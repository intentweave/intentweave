// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * init command - Initialize a new IntentWeave workspace
 */

import { Command } from "commander";
import { createWorkspaceConfig } from "@intentweave/core";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { IW_DIR, CLI_NAME } from "../constants.js";

export const initCommand = new Command("init")
  .description("Initialize a new IntentWeave workspace")
  .argument("[directory]", "Directory to initialize", ".")
  .option("-n, --name <name>", "Workspace name")
  .option("--force", "Overwrite existing configuration")
  .action(async (directory: string, options) => {
    const { name, force } = options;

    const absoluteDir = path.resolve(directory);
    const configPath = path.join(absoluteDir, IW_DIR, "config.json");

    // Check for existing config
    try {
      await fs.access(configPath);
      if (!force) {
        console.error(
          chalk.red("Workspace already initialized. Use --force to overwrite."),
        );
        process.exit(1);
      }
    } catch {
      // Config doesn't exist, proceed
    }

    // Generate workspace ID
    const workspaceId = crypto.randomBytes(8).toString("hex");
    const workspaceName = name || path.basename(absoluteDir);

    // Create config
    const config = createWorkspaceConfig(
      workspaceId,
      workspaceName,
      absoluteDir,
    );

    // Create directory structure
    const iwDir = path.join(absoluteDir, IW_DIR);
    await fs.mkdir(iwDir, { recursive: true });
    await fs.mkdir(path.join(iwDir, "staging"), { recursive: true });
    await fs.mkdir(path.join(iwDir, "runs"), { recursive: true });
    await fs.mkdir(path.join(iwDir, "curated"), { recursive: true });

    // Write config
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

    // Create .gitignore for IntentWeave directory
    const gitignorePath = path.join(iwDir, ".gitignore");
    await fs.writeFile(gitignorePath, "staging/\nruns/\n*.log\n", "utf-8");

    console.log(chalk.green("✓ IntentWeave workspace initialized"));
    console.log(`  Workspace ID: ${workspaceId}`);
    console.log(`  Workspace Name: ${workspaceName}`);
    console.log(`  Config: ${configPath}`);
    console.log("");
    console.log("Next steps:");
    console.log(
      `  ${chalk.blue(`${CLI_NAME} analyze`)} - Analyze files in this workspace`,
    );
    console.log(
      `  ${chalk.blue(`${CLI_NAME} status`)} - Show workspace status`,
    );
  });
