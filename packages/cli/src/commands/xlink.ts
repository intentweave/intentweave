// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * xlink command — Cross-layer linker
 *
 * Connects IntentWeave's semantic knowledge graph to actual source code.
 * Scans a codebase and matches Canon entities against:
 *   - package.json dependencies
 *   - import statements
 *   - exported symbol names
 *   - file/directory paths
 *
 * Creates :CodeRef nodes and :REALIZED_BY relationships in Neo4j (--persist).
 *
 * Examples:
 *   iw xlink . --session planpling -v
 *   iw xlink ../planpling --session planpling --persist -v
 *   iw xlink . --session my-project --strategies dep,import -v
 */

import { Command } from "commander";
import chalk from "chalk";
import * as path from "node:path";
import { writeFileSync } from "node:fs";
import {
  runCrossLayerLinker,
  persistCrossLinks,
  formatXLinkReport,
  type MatchStrategy,
} from "../linker/index.js";
import { createGraphRunner } from "../persistence/graphRunner.js";

// =============================================================================
// Command
// =============================================================================

export const xlinkCommand = new Command("xlink")
  .description(
    "Cross-layer linker: connect semantic knowledge graph to source code",
  )
  .argument("[directory]", "Codebase directory to scan", ".")
  .option("-s, --session <id>", "IntentWeave session ID (required)", "")
  .option(
    "--strategies <list>",
    "Matching strategies: dep,import,name,path",
    "dep,import,name,path",
  )
  .option("--min-confidence <n>", "Min confidence threshold (0.0-1.0)", "0.4")
  .option(
    "--persist",
    "Persist links to Neo4j (creates :CodeRef nodes and :REALIZED_BY relationships)",
  )
  .option("-f, --format <fmt>", "Output format: markdown | json", "markdown")
  .option("-o, --output <path>", "Write report to file")
  .option("-v, --verbose", "Verbose output")
  .option("--neo4j-uri <uri>", "Neo4j connection URI")
  .action(async (directory: string, options) => {
    const {
      session: sessionId,
      strategies: strategiesStr,
      minConfidence: minConfStr,
      persist,
      format,
      output,
      verbose,
    } = options;

    if (!sessionId) {
      console.error(chalk.red("Session ID required. Use --session <id>."));
      console.error("");
      console.error("Examples:");
      console.error("  iw xlink . --session planpling -v");
      console.error("  iw xlink . --session my-project --persist -v");
      process.exit(1);
    }

    const strategies = strategiesStr
      .split(",")
      .map((s: string) => s.trim()) as MatchStrategy[];
    const minConfidence = parseFloat(minConfStr) || 0.4;
    const codebaseDir = path.resolve(directory);

    try {
      if (options.neo4jUri) {
        process.env.NEO4J_URI = options.neo4jUri;
      }
      const runner = createGraphRunner();

      if (verbose) {
        console.error(chalk.blue("Connected to graph database"));
        console.error(chalk.blue(`Session: ${sessionId}`));
        console.error(chalk.blue(`Scanning: ${codebaseDir}`));
        console.error(chalk.blue(`Strategies: ${strategies.join(", ")}`));
        console.error("");
      }

      const log = verbose
        ? (msg: string) => console.error(chalk.blue(msg))
        : undefined;

      const result = await runCrossLayerLinker({
        runner,
        sessionId,
        codebaseDir,
        strategies,
        minConfidence,
        log,
      });

      // Report
      if (verbose) {
        console.error("");
        console.error(
          chalk.green(
            `✓ ${result.stats.linkedEntities}/${result.stats.totalCanonEntities} entities linked to code`,
          ),
        );
        console.error(
          chalk.blue(`  ${result.stats.totalCodeRefs} total code references`),
        );
        for (const [strategy, count] of Object.entries(
          result.stats.byStrategy,
        )) {
          if (count > 0) console.error(chalk.gray(`    ${strategy}: ${count}`));
        }
        console.error("");
      }

      // Persist if requested
      if (persist) {
        await persistCrossLinks(runner, sessionId, result.links, log);
        if (verbose) {
          console.error(chalk.green("✓ Cross-links persisted to Neo4j"));
          console.error(
            chalk.gray(
              "  Query with: iw query --cypher \"MATCH (c:Canon)-[r:REALIZED_BY]->(cr:CodeRef) WHERE c.session_id = 'planpling' RETURN c.name, r.strategy, cr.filePath LIMIT 20\"",
            ),
          );
        }
      }

      // Format output
      const formatted =
        format === "json"
          ? JSON.stringify(result, null, 2)
          : formatXLinkReport(result);

      if (output) {
        writeFileSync(output, formatted, "utf-8");
        console.error(chalk.green(`Report written to ${output}`));
      } else {
        console.log(formatted);
      }
    } catch (err: any) {
      console.error(chalk.red("Error:"), err.message ?? err);
      process.exit(1);
    }
  });
