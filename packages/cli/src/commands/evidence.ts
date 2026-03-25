// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw evidence — Link Canon entities to KWG evidence.
 *
 * Creates EVIDENCED_BY relationships between SKG Canon entities and their
 * matching KWG entities. Zero LLM cost.
 *
 * Usage:
 *   iw evidence -s planpling -v
 *   iw evidence -s my-project -f json
 *
 * @see PHASE-D-SPEC.md §4
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import { createNeo4jDriver } from "../kwg/persistKwg.js";
import { linkEvidencedBy } from "../linker/evidenceLinker.js";

export const evidenceCommand = new Command("evidence")
  .description(
    "Link Canon entities to KWG evidence via EVIDENCED_BY relationships",
  )
  .requiredOption("-s, --session <name>", "Session name")
  .option("-f, --format <fmt>", "Output format: table | json", "table")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts) => {
    const { session, format, verbose } = opts;

    let driver;
    try {
      driver = await createNeo4jDriver();

      const result = await linkEvidencedBy(driver, session, {
        verbose,
        log: verbose
          ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
          : undefined,
      });

      if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          chalk.blue(`\n  ▸ Evidence Linker — session: ${session}\n`),
        );
        console.log(
          `  EVIDENCED_BY links created:  ${chalk.green(String(result.linksCreated))}`,
        );
        console.log(
          `  Canon entities linked:       ${chalk.green(String(result.canonEntitiesLinked))}`,
        );
        console.log(
          `  Canon entities unlinked:     ${chalk.yellow(String(result.canonEntitiesUnlinked))}`,
        );
        console.log(
          `  KWG entities linked:         ${chalk.green(String(result.kwEntitiesLinked))}`,
        );
        console.log(
          chalk.gray(`  Duration: ${result.durationMs.toFixed(0)}ms\n`),
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${msg}\n`));
      process.exit(1);
    } finally {
      if (driver) await driver.close();
    }
  });
