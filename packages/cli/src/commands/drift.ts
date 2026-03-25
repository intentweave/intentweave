// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * drift command — Detect divergence between documentation and code.
 *
 * Compares the KWG (keyword mention graph from docs, persisted in Neo4j)
 * against the AX (AST extraction from code) to find disconnections.
 *
 * Usage:
 *   iw drift --session <name>                     # all drift detectors
 *   iw drift --doc-code --session <name>           # doc ↔ code only
 *   iw drift --doc-code --session X [codePaths...] # specific code dirs
 *   iw drift --doc-code -s X -v                    # verbose output
 *
 * Requires: KWG persisted in Neo4j for the session (run `iw build kwg ... --persist` first).
 *
 * @see LAYERED-GRAPH-ARCHITECTURE.md §4.7
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import * as path from "node:path";
import {
  runAxStage,
  loadAxOutput,
  type AxStageOptions,
  type AxOutput,
} from "@intentweave/analyzer";
import {
  detectDocCodeDrift,
  renderDriftReport,
  type DocCodeDriftOptions,
} from "../drift/docCodeDrift.js";
import { createNeo4jDriver } from "../kwg/persistKwg.js";

// =============================================================================
// CLI Command
// =============================================================================

export const driftCommand = new Command("drift")
  .description(
    "Detect drift between documentation and code — ungrounded mentions, undocumented symbols",
  )
  .argument(
    "[paths...]",
    "Code directories to scan (default: current directory)",
  )
  .requiredOption(
    "-s, --session <name>",
    "Session name (must have KWG persisted)",
  )
  .option("--doc-code", "Run doc ↔ code drift detection only", false)
  .option(
    "--deps",
    "Run dependency/architecture drift detection only (future)",
    false,
  )
  .option("--temporal", "Run temporal drift detection only (future)", false)
  .option(
    "--min-mentions <n>",
    "Minimum KWG mentions to consider entity significant",
    "2",
  )
  .option(
    "--include-internal",
    "Include internal (non-exported) code symbols",
    false,
  )
  .option("--ax-cache <path>", "Path to cached AX output (skip re-extraction)")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .option("-o, --output <file>", "Write output to file")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    const {
      session,
      docCode,
      deps,
      temporal,
      minMentions,
      includeInternal,
      axCache,
      format,
      output: outputFile,
      verbose,
    } = opts;

    // If no specific detector selected, run all available (currently just doc-code)
    const runDocCode = docCode || (!deps && !temporal);
    const runDeps = deps;
    const runTemporal = temporal;

    if (runDeps) {
      console.error(
        chalk.yellow(
          "⚠ Dependency drift detection is not yet implemented (Phase B — requires SCG).",
        ),
      );
      if (!runDocCode && !runTemporal) process.exit(0);
    }
    if (runTemporal) {
      console.error(
        chalk.yellow(
          "⚠ Temporal drift detection is not yet implemented (Phase B — requires TCG).",
        ),
      );
      if (!runDocCode) process.exit(0);
    }

    if (!runDocCode) return;

    // ── Neo4j connection ──────────────────────────────────────────────
    let driver: import("neo4j-driver").Driver;
    try {
      driver = await createNeo4jDriver();
    } catch (err) {
      console.error(
        chalk.red(`Neo4j connection failed: ${(err as Error).message}`),
      );
      process.exit(1);
    }

    try {
      // ── AX extraction (code symbols) ─────────────────────────────────
      const cwd = process.cwd();
      const codePaths = paths.length > 0 ? paths : ["."];
      const workspaceRoot = path.isAbsolute(codePaths[0])
        ? codePaths[0]
        : path.resolve(cwd, codePaths[0]);

      let axOutput: AxOutput;

      if (axCache) {
        // Load cached AX output
        const cached = await loadAxOutput(path.resolve(axCache));
        if (!cached) {
          console.error(chalk.red(`AX cache not found: ${axCache}`));
          process.exit(1);
        }
        axOutput = cached;
        if (verbose) {
          console.log(
            chalk.gray(
              `  Loaded cached AX: ${axOutput.totalFiles} files, ${axOutput.totalSymbols} symbols`,
            ),
          );
        }
      } else {
        // Run AX extraction
        if (verbose) {
          console.log(
            chalk.gray(`  Extracting code symbols from: ${workspaceRoot}`),
          );
        }

        const axOptions: AxStageOptions = {
          workspaceRoot,
          includePrivate: includeInternal,
          includeMembers: true,
          maxDepth: 2,
        };

        const axStart = Date.now();
        axOutput = await runAxStage(axOptions);
        const axMs = Date.now() - axStart;

        if (verbose) {
          console.log(
            chalk.gray(
              `  AX: ${axOutput.totalFiles} files, ${axOutput.totalSymbols} symbols (${axMs}ms)`,
            ),
          );
        }
      }

      // ── Doc ↔ Code drift detection ────────────────────────────────────
      console.log(chalk.blue(`\n  Drift Analysis — session: ${session}\n`));

      const driftOpts: DocCodeDriftOptions = {
        minMentions: parseInt(minMentions, 10),
        exportedOnly: !includeInternal,
        log: verbose ? (msg) => console.log(chalk.gray(`  ${msg}`)) : undefined,
      };

      const report = await detectDocCodeDrift(
        driver,
        session,
        axOutput,
        driftOpts,
      );

      // ── Output ─────────────────────────────────────────────────────────
      if (format === "json") {
        const json = JSON.stringify(report, null, 2);
        if (outputFile) {
          const { writeFile, mkdir } = await import("node:fs/promises");
          await mkdir(path.dirname(path.resolve(outputFile)), {
            recursive: true,
          });
          await writeFile(path.resolve(outputFile), json);
          console.log(chalk.green(`  Output: ${outputFile}`));
        } else {
          console.log(json);
        }
      } else {
        // Formatted text output
        const { stats, signals } = report;

        // Header
        console.log(chalk.bold("  Doc ↔ Code Drift"));
        console.log(chalk.gray("  ──────────────────────────────────────"));

        if (signals.length === 0) {
          console.log(
            chalk.green("  ✓ No drift detected — docs and code are aligned."),
          );
        } else {
          // Ungrounded mentions
          const ungrounded = signals.filter((s) => s.category === "ungrounded");
          if (ungrounded.length > 0) {
            console.log(
              chalk.yellow(
                `    ⚠  ${ungrounded.length} ungrounded mention${ungrounded.length === 1 ? "" : "s"} (entities in docs but not in code)`,
              ),
            );
            if (verbose) {
              for (const s of ungrounded.slice(0, 15)) {
                const qualStr =
                  s.evidence.qualifiers && s.evidence.qualifiers.length > 0
                    ? chalk.gray(` [${s.evidence.qualifiers.join(", ")}]`)
                    : "";
                const nearStr =
                  s.evidence.nearMatchName && s.evidence.nearMatchScore
                    ? chalk.gray(
                        ` (near: "${s.evidence.nearMatchName}" @ ${Math.round(s.evidence.nearMatchScore * 100)}%)`,
                      )
                    : "";
                console.log(
                  `       ${s.name} (${s.evidence.mentionCount ?? 0}×)${qualStr}${nearStr}`,
                );
              }
              if (ungrounded.length > 15) {
                console.log(
                  chalk.gray(`       ... and ${ungrounded.length - 15} more`),
                );
              }
            }
          }

          // Undocumented code
          const undocumented = signals.filter(
            (s) => s.category === "undocumented",
          );
          if (undocumented.length > 0) {
            console.log(
              chalk.yellow(
                `    📄 ${undocumented.length} undocumented entit${undocumented.length === 1 ? "y" : "ies"} (code symbols with no doc mentions)`,
              ),
            );
            if (verbose) {
              for (const s of undocumented.slice(0, 15)) {
                const nearStr =
                  s.evidence.nearMatchName && s.evidence.nearMatchScore
                    ? chalk.gray(
                        ` (near: "${s.evidence.nearMatchName}" @ ${Math.round(s.evidence.nearMatchScore * 100)}%)`,
                      )
                    : "";
                console.log(`       ${s.name} — ${s.files[0]}${nearStr}`);
              }
              if (undocumented.length > 15) {
                console.log(
                  chalk.gray(`       ... and ${undocumented.length - 15} more`),
                );
              }
            }
          }

          // Signature mismatches
          const sigMismatch = signals.filter(
            (s) => s.category === "signature-mismatch",
          );
          if (sigMismatch.length > 0) {
            console.log(
              chalk.red(
                `    ✗  ${sigMismatch.length} signature mismatch${sigMismatch.length === 1 ? "" : "es"} (doc describes wrong interface)`,
              ),
            );
            if (verbose) {
              for (const s of sigMismatch.slice(0, 10)) {
                console.log(`       ${s.name} — ${s.message}`);
              }
            }
          }
        }

        // Footer
        console.log("");
        const critCount = signals.filter(
          (s) => s.severity === "critical",
        ).length;
        const warnCount = signals.filter(
          (s) => s.severity === "warning",
        ).length;
        const infoCount = signals.filter((s) => s.severity === "info").length;
        console.log(
          `  ${chalk[signals.length > 0 ? "yellow" : "green"]("✓")} ${signals.length} drift signal${signals.length === 1 ? "" : "s"}  │  ${critCount} critical  │  ${warnCount} warnings  │  ${infoCount} info  │  ${stats.durationMs}ms  │  $0.00`,
        );

        // Write markdown if output file requested
        if (outputFile) {
          const md = renderDriftReport(report);
          const { writeFile, mkdir } = await import("node:fs/promises");
          await mkdir(path.dirname(path.resolve(outputFile)), {
            recursive: true,
          });
          await writeFile(path.resolve(outputFile), md);
          console.log(chalk.green(`\n  Output: ${outputFile}`));
        }
      }
    } finally {
      await driver.close();
    }
  });
