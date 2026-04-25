// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw verify — Spec-to-Code Verification (12.1) & Constraint Consistency (12.2)
 *
 * Checks whether KG entities (extracted from enrichment) are grounded in
 * code symbols. For each entity, reports: grounded, ungrounded, partial,
 * or untested. With --consistency, checks for contradictions across documents.
 *
 * Usage:
 *   iw verify                                   # verify all enriched entities
 *   iw verify docs/AUTH.md docs/API.md           # verify specific spec files
 *   iw verify --types decision,requirement       # only specific entity types
 *   iw verify --consistency                      # check constraint consistency
 *   iw verify --consistency --format json        # machine-readable output
 *
 * @version 0.2
 */

import { Command } from "commander";
import chalk from "chalk";
import * as path from "node:path";
import * as fs from "node:fs";
import { verify, consistency } from "@intentweave/index";
import type {
  VerifyResult,
  VerifyEntityResult,
  ConsistencyResult,
  ConstraintConflict,
} from "@intentweave/index";

function resolveDbPath(dbOpt?: string): string {
  return dbOpt ?? path.join(process.cwd(), ".iw", "index.db");
}

const STATUS_ICONS: Record<string, string> = {
  grounded: chalk.green("✓"),
  untested: chalk.yellow("⚠"),
  partial: chalk.yellow("~"),
  ungrounded: chalk.red("✗"),
};

const STATUS_COLORS: Record<string, (s: string) => string> = {
  grounded: chalk.green,
  untested: chalk.yellow,
  partial: chalk.yellow,
  ungrounded: chalk.red,
};

export const verifyCommand = new Command("verify")
  .description(
    "Verify that spec/doc entities are grounded in code (spec-to-code verification)",
  )
  .argument("[files...]", "Restrict to entities from these source files")
  .option("--db <path>", "Path to index.db")
  .option(
    "--types <types>",
    "Comma-separated entity types to check (e.g., decision,requirement)",
  )
  .option(
    "--min-confidence <n>",
    "Minimum annotation confidence to count as grounded",
    "0.5",
  )
  .option("--no-tests", "Skip test coverage check")
  .option(
    "-c, --consistency",
    "Check constraint consistency across documents (12.2)",
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .option("-o, --output <path>", "Write output to file")
  .option("-v, --verbose", "Show detailed grounding info")
  .action(async (files: string[], opts) => {
    const dbPath = resolveDbPath(opts.db);

    if (!fs.existsSync(dbPath)) {
      console.error(
        chalk.red(
          `Index not found at ${dbPath}. Run \`iw index build\` first.`,
        ),
      );
      process.exit(1);
    }

    const types = opts.types
      ? opts.types.split(",").map((t: string) => t.trim())
      : undefined;
    const minConfidence = parseFloat(opts.minConfidence) || 0.5;
    const checkTests = opts.tests !== false;

    // ── 12.2: Consistency check mode ──────────────────────────────────────
    if (opts.consistency) {
      const result = consistency(dbPath, {
        files: files.length > 0 ? files : undefined,
        types,
        minConfidence,
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
        const lines = formatConsistencyResult(result, !!opts.verbose);
        const output = lines.join("\n");
        if (opts.output) {
          fs.writeFileSync(opts.output, output, "utf-8");
          console.log(chalk.green(`Written to ${opts.output}`));
        } else {
          console.log(output);
        }
      }

      // Exit code: 2 if errors, 1 if only warnings, 0 if consistent
      if (result.summary.errors > 0) {
        process.exit(2);
      } else if (result.summary.warnings > 0) {
        process.exit(1);
      }
      return;
    }

    // ── 12.1: Spec-to-code verification mode ─────────────────────────────
    const result = verify(dbPath, {
      files: files.length > 0 ? files : undefined,
      types,
      minConfidence,
      checkTests,
    });

    if (result.entities.length === 0) {
      console.log(
        chalk.yellow(
          "\n  No KG entities found. Run `iw index enrich` first to extract semantic entities.\n",
        ),
      );
      process.exit(0);
    }

    if (opts.format === "json") {
      const output = JSON.stringify(result, null, 2);
      if (opts.output) {
        fs.writeFileSync(opts.output, output, "utf-8");
        console.log(chalk.green(`Written to ${opts.output}`));
      } else {
        console.log(output);
      }
      return;
    }

    // Text output
    const lines = formatVerifyResult(result, !!opts.verbose);
    const output = lines.join("\n");

    if (opts.output) {
      fs.writeFileSync(opts.output, output, "utf-8");
      console.log(chalk.green(`Written to ${opts.output}`));
    } else {
      console.log(output);
    }

    // Exit code: 2 if any ungrounded, 1 if only untested/partial, 0 if all grounded
    if (result.summary.ungrounded > 0) {
      process.exit(2);
    } else if (result.summary.untested > 0 || result.summary.partial > 0) {
      process.exit(1);
    }
  });

function formatVerifyResult(result: VerifyResult, verbose: boolean): string[] {
  const lines: string[] = [];
  const { summary } = result;

  lines.push("");
  lines.push(
    chalk.bold(
      `  Spec-to-Code Verification: ${summary.total} entities checked`,
    ),
  );
  lines.push("");

  // Group by source file
  const byFile = new Map<string, VerifyEntityResult[]>();
  for (const e of result.entities) {
    const group = byFile.get(e.sourceFile) ?? [];
    group.push(e);
    byFile.set(e.sourceFile, group);
  }

  for (const [file, entities] of byFile) {
    lines.push(chalk.bold(`  ${file}`));

    for (const e of entities) {
      const icon = STATUS_ICONS[e.status] ?? "?";
      const color = STATUS_COLORS[e.status] ?? chalk.white;
      const typeTag = chalk.gray(`[${e.entityType}]`);

      lines.push(`    ${icon} ${color(e.message)} ${typeTag}`);

      if (verbose && e.groundedIn.length > 0) {
        for (const g of e.groundedIn) {
          lines.push(
            chalk.gray(
              `        → ${g.symbolName} (${g.kind}) in ${g.filePath} [conf=${g.confidence.toFixed(2)}]`,
            ),
          );
        }
      }
    }
    lines.push("");
  }

  // Summary
  lines.push(chalk.bold("  Summary:"));
  lines.push(
    `    ${chalk.green("✓")} ${summary.grounded} grounded  ` +
      `${chalk.yellow("⚠")} ${summary.untested} untested  ` +
      `${chalk.yellow("~")} ${summary.partial} partial  ` +
      `${chalk.red("✗")} ${summary.ungrounded} ungrounded`,
  );
  lines.push(
    `    Spec coverage: ${summary.coveragePercent}% (${summary.grounded + summary.untested}/${summary.total} entities have code references)`,
  );

  // Per-file breakdown
  if (result.byFile.length > 1) {
    lines.push("");
    lines.push(chalk.bold("  By file:"));
    for (const f of result.byFile) {
      const pct = f.coveragePercent;
      const pctColor =
        pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;
      lines.push(
        `    ${f.file}: ${pctColor(`${pct}%`)} (${f.grounded}/${f.total} grounded)`,
      );
    }
  }

  lines.push("");
  return lines;
}

// =============================================================================
// Consistency formatting (12.2)
// =============================================================================

function formatConsistencyResult(
  result: ConsistencyResult,
  verbose: boolean,
): string[] {
  const lines: string[] = [];
  const { summary } = result;

  lines.push("");
  lines.push(
    chalk.bold(
      `  Constraint Consistency: ${summary.totalRelationships} relationships checked`,
    ),
  );
  lines.push("");

  if (result.conflicts.length === 0) {
    lines.push(chalk.green("  ✓ All constraints are internally consistent."));
    lines.push("");
    return lines;
  }

  // Group by severity
  const errors = result.conflicts.filter((c) => c.severity === "error");
  const warnings = result.conflicts.filter((c) => c.severity === "warning");

  if (errors.length > 0) {
    lines.push(chalk.bold.red("  Errors (hard contradictions):"));
    for (const c of errors) {
      lines.push(`    ${chalk.red("✗")} ${c.message}`);
      if (verbose) {
        lines.push(
          chalk.gray(
            `        ${c.entityA.name} (${c.entityA.canonId}) → ${c.entityB.name} (${c.entityB.canonId})`,
          ),
        );
        lines.push(
          chalk.gray(
            `        ${c.sourceFileA}: ${c.predicateA}  vs  ${c.sourceFileB}: ${c.predicateB}`,
          ),
        );
      }
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push(chalk.bold.yellow("  Warnings (potential conflicts):"));
    for (const c of warnings) {
      lines.push(`    ${chalk.yellow("⚠")} ${c.message}`);
      if (verbose) {
        lines.push(
          chalk.gray(
            `        ${c.entityA.name} (${c.entityA.canonId}) → ${c.entityB.name} (${c.entityB.canonId})`,
          ),
        );
        lines.push(
          chalk.gray(
            `        ${c.sourceFileA}: ${c.predicateA}  vs  ${c.sourceFileB}: ${c.predicateB}`,
          ),
        );
      }
    }
    lines.push("");
  }

  // Summary
  lines.push(chalk.bold("  Summary:"));
  lines.push(
    `    ${chalk.red("✗")} ${summary.errors} errors  ` +
      `${chalk.yellow("⚠")} ${summary.warnings} warnings  ` +
      `${chalk.green("✓")} ${summary.consistencyPercent}% consistent`,
  );
  lines.push(
    `    ${summary.totalRelationships} relationships, ${summary.totalConflicts} conflicts`,
  );
  lines.push("");

  return lines;
}
