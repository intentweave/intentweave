// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw triage — Rank KWG entities for LLM extraction based on evidence scores.
 *
 * Queries the evidence graph (KWG + Drift + SKG) and outputs a ranked list
 * of entities that would benefit most from LLM extraction. Zero LLM cost.
 *
 * Usage:
 *   iw triage -s intentweave -v
 *   iw triage -s intentweave --max 20 --min 10
 *   iw triage -s intentweave -f json -o triage.json
 *
 * @see PHASE-D-SPEC.md §3
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import { createNeo4jDriver } from "../kwg/persistKwg.js";
import { triageFromEvidence } from "../triage/triageAnalyzer.js";
import type { TriageCandidate, TriageResult } from "../triage/triageAnalyzer.js";

// =============================================================================
// Rendering
// =============================================================================

function renderTable(result: TriageResult, verbose: boolean): void {
  const { candidates, totalKwgEntities, totalSkgEntities, skippedAlreadyInSkg, skippedBelowThreshold, durationMs } = result;

  console.log(chalk.blue(`\n  ▸ Triage — evidence-guided extraction ranking\n`));
  console.log(
    chalk.gray(
      `  KWG entities: ${totalKwgEntities} │ ` +
      `Already in SKG: ${totalSkgEntities} │ ` +
      `Below threshold: ${skippedBelowThreshold} │ ` +
      `${durationMs.toFixed(0)}ms\n`,
    ),
  );

  if (candidates.length === 0) {
    console.log(chalk.yellow("  No candidates above score threshold.\n"));
    return;
  }

  // Header
  const header = `  ${"#".padStart(3)}  ${"Entity".padEnd(35)}  ${"Score".padStart(6)}  ${"Mentions".padStart(8)}  ${"Co-occ".padStart(6)}  ${"Drift".padStart(5)}  ${"In SKG".padStart(6)}`;
  console.log(chalk.bold(header));
  console.log(chalk.gray("  " + "─".repeat(header.length - 2)));

  for (const c of candidates) {
    const severityIcon = c.driftMaxSeverity === "critical"
      ? chalk.red("✗")
      : c.driftMaxSeverity === "warning"
        ? chalk.yellow("⚠")
        : c.driftSignalCount > 0
          ? chalk.blue("ℹ")
          : " ";

    const skgIcon = c.isInSkg ? chalk.green("✓") : chalk.gray("✗");

    const name = c.entityName.length > 33
      ? c.entityName.slice(0, 32) + "…"
      : c.entityName;

    console.log(
      `  ${String(c.rank).padStart(3)}  ${name.padEnd(35)}  ${c.score.toFixed(1).padStart(6)}  ${String(c.mentionCount).padStart(8)}  ${String(c.coOccurrenceDegree).padStart(6)}  ${severityIcon}${String(c.driftSignalCount).padStart(4)}  ${skgIcon}`,
    );
  }

  console.log(
    chalk.gray(
      `\n  ${candidates.length} candidate(s) ready for LLM extraction\n`,
    ),
  );
}

// =============================================================================
// Command
// =============================================================================

export const triageCommand = new Command("triage")
  .description(
    "Rank KWG entities for LLM extraction based on evidence scores ($0)",
  )
  .requiredOption("-s, --session <name>", "Session name")
  .option("--max <n>", "Maximum candidates to return", "50")
  .option("--min <n>", "Minimum score threshold", "5")
  .option("-f, --format <fmt>", "Output format: table | json", "table")
  .option("-o, --output <file>", "Write output to file")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts) => {
    const {
      session,
      max,
      min,
      format,
      output,
      verbose,
    } = opts;

    const maxCandidates = parseInt(max, 10);
    const minScore = parseInt(min, 10);

    let driver;
    try {
      driver = await createNeo4jDriver();

      const result = await triageFromEvidence(driver, {
        sessionId: session,
        maxCandidates,
        minScore,
        log: verbose ? (msg: string) => console.log(chalk.gray(`  ${msg}`)) : undefined,
      });

      if (format === "json") {
        const json = JSON.stringify(result, null, 2);
        if (output) {
          await fs.writeFile(output, json, "utf-8");
          console.log(chalk.green(`  ✓ Written to ${output}`));
        } else {
          console.log(json);
        }
      } else {
        renderTable(result, verbose);
        if (output) {
          await fs.writeFile(output, JSON.stringify(result, null, 2), "utf-8");
          console.log(chalk.green(`  ✓ JSON written to ${output}`));
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${msg}\n`));
      process.exit(1);
    } finally {
      if (driver) await driver.close();
    }
  });
