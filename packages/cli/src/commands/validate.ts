// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * validate command - Run validation rules on a completed run
 *
 * Executes validation rules from the profile pack to find issues
 * like missing edges, shape violations, etc.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ArtifactRole,
  LinkProposal,
  Entity,
  Statement,
} from "@intentweave/core";
import {
  runValidation,
  type ValidationInput,
} from "@intentweave/analyzer/validation";
import {
  getDefaultProfilePack,
  loadProfilePack,
  type ProfilePack,
} from "@intentweave/profiles";
import { IW_DIR, CLI_NAME } from "../constants.js";

/**
 * Find the latest run in the workspace
 */
async function findLatestRun(iwDir: string): Promise<string | null> {
  const runsDir = path.join(iwDir, "runs");
  try {
    const runs = await fs.readdir(runsDir);
    const validRuns = runs
      .filter((r) => r.startsWith("run-"))
      .sort()
      .reverse();
    return validRuns[0] || null;
  } catch {
    return null;
  }
}

/**
 * Load entities and statements from a run
 */
async function loadRunData(
  iwDir: string,
  runId: string,
): Promise<{
  entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>;
  statements: Array<
    Statement & { artifactId: string; artifactRole: ArtifactRole }
  >;
  linkProposals: LinkProposal[];
}> {
  const entities: Array<
    Entity & { artifactId: string; artifactRole: ArtifactRole }
  > = [];
  const statements: Array<
    Statement & { artifactId: string; artifactRole: ArtifactRole }
  > = [];
  let linkProposals: LinkProposal[] = [];

  const artifactsDir = path.join(iwDir, "runs", runId, "artifacts");

  try {
    const artifactDirs = await fs.readdir(artifactsDir);

    for (const artifactId of artifactDirs) {
      const artifactDir = path.join(artifactsDir, artifactId);
      const stat = await fs.stat(artifactDir);
      if (!stat.isDirectory()) continue;

      // Load PX output
      const pxPath = path.join(artifactDir, "px.json");
      try {
        const pxData = JSON.parse(await fs.readFile(pxPath, "utf-8"));
        const artifactRole = (pxData.artifact?.artifactRole ||
          "unknown") as ArtifactRole;

        // Add entities with artifact metadata
        for (const entity of pxData.entities || []) {
          entities.push({
            ...entity,
            artifactId,
            artifactRole,
          });
        }

        // Add statements with artifact metadata
        for (const statement of pxData.statements || []) {
          statements.push({
            ...statement,
            artifactId,
            artifactRole,
          });
        }
      } catch {
        // Skip artifacts without PX output
      }
    }

    // Load link proposals if they exist
    const lxPath = path.join(
      iwDir,
      "runs",
      runId,
      "aggregate",
      "lx.proposals.json",
    );
    try {
      const lxData = JSON.parse(await fs.readFile(lxPath, "utf-8"));
      linkProposals = lxData.proposals || [];
    } catch {
      // No link proposals yet
    }
  } catch {
    throw new Error(`No artifacts found in run ${runId}`);
  }

  return { entities, statements, linkProposals };
}

export const validateCommand = new Command("validate")
  .description("Run validation rules on a completed run")
  .option("--run <runId>", "Run to validate (default: latest)")
  .option("-p, --profile <path>", "Path to profile pack (default: built-in)")
  .option(
    "--severity <level>",
    "Minimum severity to show: error, warning, info",
    "warning",
  )
  .option("-o, --output <path>", "Output path for findings")
  .option("-v, --verbose", "Verbose output")
  .action(async (options) => {
    const {
      run: runIdOpt,
      profile: profilePath,
      severity,
      output,
      verbose,
    } = options;

    const cwd = process.cwd();
    const iwDir = path.join(cwd, IW_DIR);

    // Check for workspace
    try {
      await fs.access(iwDir);
    } catch {
      console.error(
        chalk.red(`No IntentWeave workspace found in this directory.`),
      );
      console.log(`Run ${chalk.blue(`${CLI_NAME} init`)} to create one.`);
      process.exit(1);
    }

    // Find run
    const runId = runIdOpt || (await findLatestRun(iwDir));
    if (!runId) {
      console.error(chalk.red("No runs found. Run `iw run` first."));
      process.exit(1);
    }

    // Check run exists
    const runDir = path.join(iwDir, "runs", runId);
    try {
      await fs.access(runDir);
    } catch {
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    }

    // Load or create profile pack
    let profilePack: ProfilePack;
    if (profilePath) {
      try {
        profilePack = await loadProfilePack(profilePath);
      } catch (e) {
        console.error(chalk.red(`Failed to load profile pack: ${e}`));
        process.exit(1);
      }
    } else {
      profilePack = getDefaultProfilePack();
    }

    console.log(chalk.blue("\nIntentWeave Validation"));
    console.log(chalk.blue("═".repeat(40)));
    console.log(`Run: ${runId}`);
    console.log(`Profile: ${profilePack.meta.name}`);
    console.log("");

    // Load run data
    console.log("Loading run data...");
    const { entities, statements, linkProposals } = await loadRunData(
      iwDir,
      runId,
    );

    console.log(
      `Found ${entities.length} entities, ${statements.length} statements`,
    );
    console.log(`Link proposals: ${linkProposals.length}`);
    console.log("");

    // Run validation
    console.log(chalk.blue("Running validation rules..."));
    const startTime = Date.now();

    const validationInput: ValidationInput = {
      entities,
      statements,
      linkProposals,
      profilePack,
    };

    const result = runValidation(validationInput);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("");
    console.log(chalk.green("✓ Validation complete"));
    console.log("");
    console.log(chalk.blue("Summary:"));
    console.log(`  Rules executed: ${result.rulesExecuted}`);
    console.log(`  Duration: ${duration}s`);
    console.log("");
    console.log(`  ${chalk.red(`Errors: ${result.summary.errors}`)}`);
    console.log(`  ${chalk.yellow(`Warnings: ${result.summary.warnings}`)}`);
    console.log(`  ${chalk.blue(`Info: ${result.summary.info}`)}`);
    console.log(`  Total findings: ${result.summary.total}`);

    // Filter findings by severity
    const severityOrder = { error: 0, warning: 1, info: 2 };
    const minSeverityNum =
      severityOrder[severity as keyof typeof severityOrder] ?? 1;
    const filteredFindings = result.findings.filter(
      (f) => severityOrder[f.severity] <= minSeverityNum,
    );

    // Show findings
    if (filteredFindings.length > 0) {
      console.log("");
      console.log(chalk.blue(`Findings (${severity} and above):`));

      const toShow = verbose ? filteredFindings : filteredFindings.slice(0, 10);
      toShow.forEach((f, i) => {
        const severityColor =
          f.severity === "error"
            ? chalk.red
            : f.severity === "warning"
              ? chalk.yellow
              : chalk.blue;
        console.log(
          `  ${i + 1}. ${severityColor(`[${f.severity.toUpperCase()}]`)} ${f.message}`,
        );
        if (verbose && f.entityName) {
          console.log(`     Entity: ${f.entityName}`);
        }
        if (verbose && f.artifactId) {
          console.log(`     Artifact: ${f.artifactId}`);
        }
      });

      if (!verbose && filteredFindings.length > 10) {
        console.log(
          `  ... and ${filteredFindings.length - 10} more. Use -v for full list.`,
        );
      }
    }

    // Write output
    const outputPath =
      output || path.join(runDir, "aggregate", "findings.json");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const outputData = {
      $schema: "intentweave://schemas/findings/v1",
      schemaVersion: "0.1",
      runId,
      generatedAt: new Date().toISOString(),
      profile: profilePack.meta.name,
      summary: result.summary,
      rulesExecuted: result.rulesExecuted,
      findings: result.findings,
    };

    await fs.writeFile(
      outputPath,
      JSON.stringify(outputData, null, 2),
      "utf-8",
    );

    console.log("");
    console.log(
      chalk.green(`Output written to: ${path.relative(cwd, outputPath)}`),
    );
    console.log("");
    console.log("Next steps:");
    console.log(
      `  ${chalk.blue(`${CLI_NAME} aggregate --run ${runId}`)} - Generate run-level summary`,
    );

    // Exit with error code if there are errors
    if (result.summary.errors > 0) {
      process.exit(1);
    }
  });
