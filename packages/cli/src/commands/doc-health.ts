// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw doc-health — Documentation health analysis
 *
 * Answers: "Which parts of my documentation are stale, drifted, or missing?"
 *
 * Scans documents in a session and compares their extracted entities against
 * the current graph state to detect staleness, drift, and contradictions.
 *
 * Examples:
 *   iw doc-health -s planpling
 *   iw doc-health docs/*.md -s planpling -v
 *   iw doc-health docs/ARCHITECTURE.md -s planpling --format json -o health.json
 */

import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import {
  analyzeDocHealth,
  formatDocHealthMarkdown,
  formatDocHealthJson,
  type DocHealthOptions,
  preflightDocHealth,
  formatPreflightMarkdown,
  formatPreflightForAgent,
} from "../doc-health/index.js";
import type { Neo4jRunner } from "../context/index.js";

// =============================================================================
// Neo4j connection (same pattern as other commands)
// =============================================================================

interface Neo4jConnection {
  driver: any;
  session: any;
  close: () => Promise<void>;
}

async function connectNeo4j(uri?: string): Promise<Neo4jConnection> {
  const neo4j = await import("neo4j-driver");
  const neoUri = uri ?? process.env.NEO4J_URI ?? "bolt://localhost:7687";
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? "neo4j";
  const password = process.env.NEO4J_PASSWORD;

  if (!password) {
    throw new Error(
      "Neo4j password required. Set NEO4J_PASSWORD environment variable.\n" +
        "Example: export NEO4J_PASSWORD=codegraph",
    );
  }

  const driver = neo4j.default.driver(
    neoUri,
    neo4j.default.auth.basic(user, password),
  );
  await driver.verifyConnectivity();
  const session = driver.session();

  return {
    driver,
    session,
    close: async () => {
      await session.close();
      await driver.close();
    },
  };
}

// =============================================================================
// Runner adapter
// =============================================================================

function toPlainValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (
    typeof v === "object" &&
    v !== null &&
    "toNumber" in v &&
    typeof (v as any).toNumber === "function"
  ) {
    return (v as any).toNumber();
  }
  if (Array.isArray(v)) return v.map(toPlainValue);
  return v;
}

function plainProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = toPlainValue(v);
  }
  return out;
}

function createRunner(conn: Neo4jConnection): Neo4jRunner {
  return {
    async run(
      cypher: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>[]> {
      const neo4j = await import("neo4j-driver");
      const cleanParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        cleanParams[k] =
          typeof v === "number" ? neo4j.default.int(Math.round(v)) : v;
      }
      const result = await conn.session.run(cypher, cleanParams);
      return result.records.map((rec: any) => {
        const row: Record<string, unknown> = {};
        for (const key of rec.keys) {
          const v = rec.get(key);
          if (v !== null && typeof v === "object" && "properties" in v) {
            row[key as string] = plainProps(v.properties);
          } else {
            row[key as string] = toPlainValue(v);
          }
        }
        return row;
      });
    },
  };
}

// =============================================================================
// Command
// =============================================================================

export const docHealthCommand = new Command("doc-health")
  .description(
    "Analyze documentation freshness — detect stale, drifted, and undocumented entities",
  )
  .argument(
    "[files...]",
    "Document file(s) to analyze (omit to scan all session docs)",
  )
  .option("-s, --session <id>", "Session ID (required)", "")
  .option(
    "--min-rel <n>",
    "Min relationships for undocumented entity flagging",
    "2",
  )
  .option("-f, --format <fmt>", "Output format: markdown | json", "markdown")
  .option("-o, --output <path>", "Write output to file")
  .option("-v, --verbose", "Show progress on stderr")
  .option("--neo4j-uri <uri>", "Neo4j connection URI")
  .option(
    "--lite",
    "Lightweight keyword-only mode — no Neo4j or LLM required",
  )
  .action(async (files: string[], options) => {
    const {
      session: sessionId,
      minRel: minRelStr,
      format,
      output,
      verbose,
      lite,
    } = options;

    // ── Lite mode: zero-infrastructure preflight ──────────────────────
    if (lite) {
      try {
        const cwd = process.cwd();
        const targets = files.length > 0 ? files : [cwd];
        const log = verbose
          ? (msg: string) => console.error(chalk.blue(msg))
          : undefined;

        const result = await preflightDocHealth({
          files: targets,
          cwd,
          log,
        });

        const formatted =
          format === "json"
            ? JSON.stringify(result, null, 2)
            : formatPreflightMarkdown(result);

        if (output) {
          writeFileSync(output, formatted, "utf-8");
          console.error(
            chalk.green(`Preflight doc health report written to ${output}`),
          );
        } else {
          console.log(formatted);
        }

        if (verbose) {
          const s = result.stats;
          console.error(
            chalk.blue(
              `\nPreflight: ${s.docsAnalyzed} docs, ${s.totalEntities} entities, ` +
                `${s.groundedCount} grounded, ${s.floatingCount} floating, ` +
                `avg grounding: ${s.avgGroundingPercent}%`,
            ),
          );
        }
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message ?? err);
        process.exit(1);
      }
      return;
    }

    // ── Full mode: requires Neo4j ─────────────────────────────────────

    if (!sessionId) {
      console.error(
        chalk.red(
          "Session ID required. Use --session <id> (e.g., --session planpling).",
        ),
      );
      process.exit(1);
    }

    const minRelCount = parseInt(minRelStr, 10) || 2;

    let conn: Neo4jConnection | undefined;

    try {
      conn = await connectNeo4j(options.neo4jUri);
      if (verbose) console.error(chalk.blue("Connected to Neo4j"));

      const runner = createRunner(conn);
      const log = verbose
        ? (msg: string) => console.error(chalk.blue(msg))
        : undefined;

      const healthOpts: DocHealthOptions = {
        runner,
        sessionId,
        files: files.length > 0 ? files : undefined,
        minRelCount,
        cwd: process.cwd(),
        log,
      };

      const result = await analyzeDocHealth(healthOpts);

      const formatted =
        format === "json"
          ? formatDocHealthJson(result)
          : formatDocHealthMarkdown(result);

      if (output) {
        writeFileSync(output, formatted, "utf-8");
        console.error(chalk.green(`Doc health report written to ${output}`));
      } else {
        console.log(formatted);
      }

      if (verbose) {
        const s = result.stats;
        console.error(
          chalk.blue(
            `\n${s.docsAnalyzed} docs: ${s.freshDocs} fresh, ${s.warningDocs} warning, ${s.rottenDocs} rotten` +
              ` | ${s.totalIssues} issues | ${s.undocumentedCount} undocumented`,
          ),
        );
      }
    } catch (err: any) {
      console.error(chalk.red("Error:"), err.message ?? err);
      process.exit(1);
    } finally {
      if (conn) await conn.close();
    }
  });
