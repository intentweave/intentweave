// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw embed — Embed entities from the knowledge graph.
 *
 * Runs the local ONNX embedding model (all-MiniLM-L6-v2) to compute
 * 384-dim vectors for KWG, SKG, and cluster entities. Stores embeddings
 * in Neo4j and creates vector indexes for hybrid retrieval.
 *
 * Usage:
 *   iw embed -s intentweave -v
 *   iw embed -s intentweave --layers kwg,skg -v
 *   iw embed -s intentweave --no-skip                # re-embed all
 *
 * @see PHASE-D-SPEC.md §7
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import { createNeo4jDriver } from "../kwg/persistKwg.js";
import { runEmbedPipeline } from "../embed/embedPipeline.js";

export const embedCommand = new Command("embed")
  .description("Embed entities using local ONNX model (all-MiniLM-L6-v2, $0)")
  .requiredOption("-s, --session <name>", "Session name")
  .option(
    "--layers <layers>",
    "Layers to embed: kwg,skg,cluster (comma-separated)",
    "kwg,skg,cluster",
  )
  .option("--batch-size <n>", "Embedding batch size", "100")
  .option("--no-skip", "Re-embed entities even if they already have embeddings")
  .option("-f, --format <fmt>", "Output format: table | json", "table")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts) => {
    const { session, layers: layersStr, batchSize: batchSizeStr, skip, format, verbose } = opts;
    const layers = layersStr.split(",").map((l: string) => l.trim()) as ("kwg" | "skg" | "cluster")[];
    const batchSize = parseInt(batchSizeStr, 10) || 100;

    let driver;
    try {
      driver = await createNeo4jDriver();

      const result = await runEmbedPipeline(driver, {
        sessionId: session,
        layers,
        batchSize,
        skipExisting: skip !== false,
        log: verbose ? (msg: string) => console.log(chalk.gray(`  ${msg}`)) : undefined,
      });

      if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(chalk.blue(`\n  ▸ Embedding Pipeline — session: ${session}\n`));

        const totalEmbedded = Object.values(result.embedded).reduce((a, b) => a + b, 0);
        const totalSkipped = Object.values(result.skipped).reduce((a, b) => a + b, 0);

        for (const [label, count] of Object.entries(result.embedded)) {
          const skipCount = result.skipped[label] ?? 0;
          console.log(`  ${label.padEnd(20)} ${chalk.green(String(count).padStart(5))} embedded  ${chalk.gray(String(skipCount).padStart(5) + " skipped")}`);
        }

        console.log(
          chalk.gray(
            `\n  Total: ${totalEmbedded} embedded, ${totalSkipped} skipped  |  Indexes: ${result.indexesCreated.length}  |  ${result.durationMs.toFixed(0)}ms\n`,
          ),
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
