// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw verify — Living Documentation Score (12.3)
 *
 * The score combines documentation freshness and architecture conformance. The
 * knowledge-graph checks (spec-to-code grounding and constraint consistency) were
 * removed with the knowledge-graph tables.
 *
 * Usage:
 *   iw verify                      # living documentation score
 *   iw verify --score              # same; kept for the Doc Health action
 *   iw verify --format json        # machine-readable output
 *
 * Exit codes: 0 for grade A or B, 1 for grade C, 2 for grade D or F.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as path from "node:path";
import * as fs from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { livingScore, logSessionEvent } from "@intentweave/index";
import type { LivingScoreResult, IwConfig } from "@intentweave/index";

function resolveDbPath(dbOpt?: string): string {
  return dbOpt ?? path.join(process.cwd(), ".iw", "index.db");
}

/** Load optional `.iw/config.yaml`; returns undefined (silently) if absent/invalid. */
function loadIwConfig(cwd: string): IwConfig | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".iw", "config.yaml"), "utf-8");
    const parsed = yamlLoad(raw) as IwConfig;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const verifyCommand = new Command("verify")
  .description("Compute the living documentation score")
  .option("--db <path>", "Path to index.db")
  .option(
    "-s, --score",
    "Living documentation score (the default; kept for scripts and the Doc Health action)",
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .option("-o, --output <path>", "Write output to file")
  .action(async (opts) => {
    const dbPath = resolveDbPath(opts.db);

    if (!fs.existsSync(dbPath)) {
      console.error(
        chalk.red(
          `Index not found at ${dbPath}. Run \`iw index build\` first.`,
        ),
      );
      process.exit(1);
    }

    const result = livingScore(dbPath);

    await logSessionEvent({
      enabled: loadIwConfig(process.cwd())?.sessionLog === true,
      workspaceRoot: process.cwd(),
      surface: "cli",
      tool: "verify",
      confidence: result.score,
    });

    if (opts.format === "json") {
      const output = JSON.stringify(result, null, 2);
      if (opts.output) {
        fs.writeFileSync(opts.output, output, "utf-8");
        console.log(chalk.green(`Written to ${opts.output}`));
      } else {
        console.log(output);
      }
    } else {
      const output = formatLivingScore(result).join("\n");
      if (opts.output) {
        fs.writeFileSync(opts.output, output, "utf-8");
        console.log(chalk.green(`Written to ${opts.output}`));
      } else {
        console.log(output);
      }
    }

    // Exit code based on grade
    if (result.grade === "F" || result.grade === "D") {
      process.exit(2);
    } else if (result.grade === "C") {
      process.exit(1);
    }
  });

function formatLivingScore(result: LivingScoreResult): string[] {
  const GRADE_COLORS: Record<string, (s: string) => string> = {
    A: chalk.green,
    B: chalk.green,
    C: chalk.yellow,
    D: chalk.red,
    F: chalk.red,
  };
  const gradeColor = GRADE_COLORS[result.grade] ?? chalk.white;
  const lines: string[] = [
    chalk.bold(
      `Living Documentation Score: ${gradeColor(`${result.score}/100`)}  (${gradeColor(`Grade ${result.grade}`)})`,
    ),
    "",
  ];

  const dims = [result.docFreshness, result.archConformance];

  const padLabel = 30;
  for (const d of dims) {
    const label = d.label.padEnd(padLabel);
    if (!d.available) {
      lines.push(
        `  ${chalk.dim(label)}  ${chalk.dim("N/A")}  ${chalk.dim(d.detail)}`,
      );
    } else {
      const scoreStr = `${d.score}%`.padStart(5);
      const bar = renderBar(d.score);
      lines.push(`  ${label}  ${bar}  ${scoreStr}  ${chalk.dim(d.detail)}`);
    }
  }
  return lines;
}

function renderBar(score: number): string {
  const filled = Math.round(score / 10);
  const empty = 10 - filled;
  return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(empty));
}
