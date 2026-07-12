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
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { IW_DIR, CLI_NAME } from "../constants.js";

/** Where the bundled skill file template ships inside the published package. */
const SKILL_TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/skill/SKILL.md",
);

/** Relative destinations (within the initialized directory) to scaffold the skill file into. */
const SKILL_DESTINATIONS = [
  ".claude/skills/intentweave/SKILL.md",
  ".github/skills/intentweave/SKILL.md",
];

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${question} [Y/n] `);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "" || trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}

async function scaffoldSkillFile(absoluteDir: string): Promise<void> {
  const template = await fs.readFile(SKILL_TEMPLATE_PATH, "utf-8");
  for (const dest of SKILL_DESTINATIONS) {
    const destPath = path.join(absoluteDir, dest);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, template, "utf-8");
    console.log(chalk.green(`  ✓ ${dest}`));
  }
}

export const initCommand = new Command("init")
  .description("Initialize a new IntentWeave workspace")
  .argument("[directory]", "Directory to initialize", ".")
  .option("-n, --name <name>", "Workspace name")
  .option("--force", "Overwrite existing configuration")
  .option(
    "--skill",
    "Install the agent skill file (.claude/skills, .github/skills) without prompting",
  )
  .option(
    "--skip-skill",
    "Skip installing the agent skill file without prompting",
  )
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

    // Offer to scaffold an agent skill file so AI coding agents (Claude Code,
    // Copilot, Cursor, etc.) know to call `iw` on their own instead of guessing.
    let installSkill: boolean;
    if (options.skill) {
      installSkill = true;
    } else if (options.skipSkill) {
      installSkill = false;
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      installSkill = await promptYesNo(
        "Install a skill file so your AI coding agent knows how to use IntentWeave (.claude/skills, .github/skills)?",
      );
    } else {
      // Non-interactive (e.g. CI) — skip by default, don't hang waiting for input.
      installSkill = false;
    }

    if (installSkill) {
      console.log("");
      console.log("Installing agent skill file:");
      try {
        await scaffoldSkillFile(absoluteDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.yellow(`  ⚠ Could not install skill file: ${msg}`));
      }
    }

    console.log("");
    console.log("Next steps:");
    console.log(
      `  ${chalk.blue(`${CLI_NAME} analyze`)} - Analyze files in this workspace`,
    );
    console.log(
      `  ${chalk.blue(`${CLI_NAME} status`)} - Show workspace status`,
    );
  });
