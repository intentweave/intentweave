// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * persist command — Write open track (KX) results to Neo4j
 *
 * Usage:
 *   iw persist <run-id>                     # Load kx-results.json from a run
 *   iw persist --file path/to/kx-results.json  # Load from explicit path
 *   iw persist --latest                     # Use the most recent run
 *
 * Requires NEO4J_PASSWORD environment variable (or --neo4j-password flag).
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KxStageOutput } from "@intentweave/analyzer";
import { IW_DIR, CLI_NAME } from "../constants.js";

export const persistCommand = new Command("persist")
  .description(
    "Persist open track (KX) results to Neo4j (delta mode by default — only writes changes)",
  )
  .argument("[run-id]", "Run ID to persist (or use --latest)")
  .option("--file <path>", "Path to kx-results.json file")
  .option("--latest", "Use the most recent run")
  .option(
    "--session-id <id>",
    "Session ID for Neo4j isolation (default: workspace name)",
  )
  .option(
    "--mode <mode>",
    "Persist mode: delta (default, diff-only) | full (legacy, may duplicate)",
    "delta",
  )
  .option(
    "--neo4j-uri <uri>",
    "Neo4j connection URI (default: bolt://localhost:7687)",
  )
  .option(
    "--neo4j-password <password>",
    "Neo4j password (default: NEO4J_PASSWORD env var)",
  )
  .option("-v, --verbose", "Verbose output")
  .action(async (runIdArg: string | undefined, options) => {
    const {
      file: filePath,
      latest: useLatest,
      sessionId: customSessionId,
      mode: persistMode,
      neo4jUri,
      neo4jPassword,
      verbose,
    } = options;

    const cwd = process.cwd();
    const iwDir = path.join(cwd, IW_DIR);

    // Determine which run to persist
    let kxResultsPath: string;

    if (filePath) {
      kxResultsPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(cwd, filePath);
    } else {
      const runsDir = path.join(iwDir, "runs");
      let targetRunId = runIdArg;

      if (!targetRunId) {
        if (useLatest) {
          // Find most recent run
          try {
            const runs = await fs.readdir(runsDir);
            const sorted = runs
              .filter((r) => r.startsWith("run-"))
              .sort()
              .reverse();

            if (sorted.length === 0) {
              console.error(chalk.red("No runs found"));
              process.exit(1);
            }

            // Find the most recent run that has open-track output
            for (const run of sorted) {
              const kxPath = path.join(
                runsDir,
                run,
                "open-track",
                "kx-results.json",
              );
              try {
                await fs.access(kxPath);
                targetRunId = run;
                break;
              } catch {
                // try next
              }
            }

            if (!targetRunId) {
              console.error(chalk.red("No runs with open track output found"));
              console.log(
                chalk.dim(
                  `Run with --track open first: ${CLI_NAME} run --track open --provider openai`,
                ),
              );
              process.exit(1);
            }
          } catch {
            console.error(
              chalk.red(
                `No IntentWeave workspace found. Run ${CLI_NAME} init first.`,
              ),
            );
            process.exit(1);
          }
        } else {
          console.error(
            chalk.red("Specify a run ID, --latest, or --file <path>"),
          );
          console.log(`\nUsage:`);
          console.log(`  ${chalk.blue(`${CLI_NAME} persist <run-id>`)}`);
          console.log(`  ${chalk.blue(`${CLI_NAME} persist --latest`)}`);
          console.log(
            `  ${chalk.blue(`${CLI_NAME} persist --file path/to/kx-results.json`)}`,
          );
          process.exit(1);
        }
      }

      kxResultsPath = path.join(
        runsDir,
        targetRunId,
        "open-track",
        "kx-results.json",
      );
    }

    // Load KX results
    console.log(chalk.blue("Loading KX results..."));
    let kxOutputs: KxStageOutput[];
    let runId: string;

    try {
      const raw = await fs.readFile(kxResultsPath, "utf-8");
      const data = JSON.parse(raw);

      if (data.artifacts && Array.isArray(data.artifacts)) {
        // kx-results.json envelope format
        kxOutputs = data.artifacts.map((a: any) => ({
          $schema: "intentweave://schemas/kx/v0.1",
          schemaVersion: "0.1",
          stage: "KX",
          artifactId: a.artifactId,
          filePath: a.filePath ?? "",
          rawTriples: a.rawTriples ?? [],
          canonEntities: a.canonEntities ?? [],
          canonTriples: a.canonTriples ?? [],
          entityResolutions: a.entityResolutions ?? [],
          predicateMappings: a.predicateMappings ?? [],
          evidence: a.evidence ?? [],
          meta: a.meta ?? {},
        })) as KxStageOutput[];
        runId = data.runId ?? "unknown";
      } else if (data.stage === "KX") {
        kxOutputs = [data as KxStageOutput];
        runId = "unknown";
      } else {
        console.error(chalk.red(`Unrecognized format in ${kxResultsPath}`));
        process.exit(1);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(chalk.red(`KX results not found at: ${kxResultsPath}`));
        console.log(chalk.dim("Run with --track open first, then persist."));
      } else {
        console.error(chalk.red(`Failed to load: ${(err as Error).message}`));
      }
      process.exit(1);
    }

    // Summary before persist
    const totalEntities = kxOutputs.reduce(
      (s, o) => s + (o.canonEntities?.length ?? 0),
      0,
    );
    const totalTriples = kxOutputs.reduce(
      (s, o) => s + (o.canonTriples?.length ?? 0),
      0,
    );
    const totalRaw = kxOutputs.reduce(
      (s, o) => s + (o.rawTriples?.length ?? 0),
      0,
    );

    console.log(`  Source: ${chalk.dim(kxResultsPath)}`);
    console.log(`  Artifacts: ${kxOutputs.length}`);
    console.log(`  Canon entities: ${totalEntities}`);
    console.log(`  Canon triples: ${totalTriples}`);
    console.log(`  Raw triples: ${totalRaw}`);
    console.log("");

    // Resolve session ID
    let sessionId = customSessionId;
    if (!sessionId) {
      try {
        const configPath = path.join(iwDir, "config.json");
        const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
        sessionId =
          (config.name || "default")
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 64) || "default";
      } catch {
        sessionId = "default";
      }
    }

    // Persist
    const modeLabel = persistMode === "full" ? "full" : "delta";
    console.log(
      chalk.cyan(
        `Persisting to Neo4j [${modeLabel}] (session: ${sessionId})...`,
      ),
    );

    try {
      const { persistKxToNeo4j } = await import("./persist-neo4j.js");

      const logFn = verbose
        ? (msg: string) => console.error(chalk.blue(msg))
        : undefined;

      const result = await persistKxToNeo4j(kxOutputs, {
        sessionId,
        runId,
        uri: neo4jUri,
        password: neo4jPassword,
        mode: persistMode as "full" | "delta",
        log: logFn,
      });

      console.log("");
      console.log(
        chalk.green(
          `✓ Persisted to Neo4j (${(result.durationMs / 1000).toFixed(1)}s)`,
        ),
      );

      if (result.delta) {
        // Delta mode — show detailed diff stats
        const d = result.delta;
        console.log(
          `  Entities:      +${d.entities.added} added, ~${d.entities.updated} updated, -${d.entities.removed} removed, ${d.entities.unchanged} unchanged`,
        );
        console.log(
          `  Relationships: +${d.relationships.added} added, -${d.relationships.removed} removed, ${d.relationships.unchanged} unchanged`,
        );
        console.log(
          `  Raw triples:   +${d.rawTriples.added} added, -${d.rawTriples.removed} removed, ${d.rawTriples.unchanged} unchanged`,
        );
      } else {
        console.log(`  Canon entities: ${result.canonEntitiesWritten}`);
        console.log(
          `  Canon relationships: ${result.canonRelationshipsWritten}`,
        );
        console.log(`  Raw triples: ${result.rawTriplesWritten}`);
      }
      console.log("");
      console.log("Query examples:");
      console.log(chalk.dim(`  // All entities`));
      console.log(
        chalk.blue(
          `  MATCH (n:Canon:Entity { session_id: '${sessionId}' }) RETURN n.name, n.type ORDER BY n.confidence DESC`,
        ),
      );
      console.log(chalk.dim(`  // All decisions`));
      console.log(
        chalk.blue(
          `  MATCH (a:Canon)-[:DECIDED_FOR]->(b:Canon) RETURN a.name, b.name`,
        ),
      );
      console.log(chalk.dim(`  // What enables what`));
      console.log(
        chalk.blue(
          `  MATCH (a:Canon)-[:ENABLES]->(b:Canon) RETURN a.name, b.name`,
        ),
      );
    } catch (err) {
      console.error(
        chalk.red(`\nPersistence failed: ${(err as Error).message}`),
      );
      if (verbose) {
        console.error(chalk.dim((err as Error).stack));
      }
      process.exit(1);
    }
  });
