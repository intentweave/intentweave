// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw query — Core retrieval primitive for the knowledge graph.
 *
 * Two modes:
 *   1. Natural-language (default): the LLM translates a question into Cypher,
 *      executes it against Neo4j, then summarises the answer.
 *   2. Raw Cypher (--cypher): executes the query directly and prints rows.
 *
 * Environment variables:
 *   NEO4J_URI      (default: bolt://localhost:7687)
 *   NEO4J_USER     (default: neo4j)
 *   NEO4J_PASSWORD (required)
 *   OPENAI_API_KEY (required for natural-language mode)
 */

import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import {
  MULTI_LAYER_SCHEMA,
  getSchemaForLayer,
  type GraphLayer,
} from "../schema/graphSchema.js";
import { createGraphRunner } from "../persistence/graphRunner.js";

// =============================================================================
// Graph schema description (fed to the LLM for Cypher generation)
// — Now uses the unified multi-layer schema from schema/graphSchema.ts
// =============================================================================

const GRAPH_SCHEMA = MULTI_LAYER_SCHEMA;

const VALID_LAYERS: GraphLayer[] = [
  "kwg",
  "tcg",
  "drift",
  "skg",
  "code",
  "all",
];

// =============================================================================
// Cypher-generation system prompt
// =============================================================================

function buildSystemPrompt(sessionId?: string, layer?: GraphLayer): string {
  const sessionClause = sessionId
    ? `\nThe current session_id is "${sessionId}". Always include \`WHERE ... session_id = "${sessionId}"\` unless the user explicitly asks for cross-session results.`
    : "";

  const schema =
    layer && layer !== "all" ? getSchemaForLayer(layer) : GRAPH_SCHEMA;

  return `You are a Cypher query generator for a Neo4j knowledge graph.

${schema}
${sessionClause}

Rules:
1. Output ONLY the Cypher query — no explanation, no markdown fences, no preamble.
2. Always RETURN useful columns (name, type, relationship type, etc.).
3. Every column alias must be unique — NEVER duplicate AS names.
4. Respect the --limit the user provides (append LIMIT <n> if not already present).
5. Use case-insensitive matching (toLower / CONTAINS) for name searches.
6. If the user's question cannot be answered from the schema, return a comment line starting with // explaining why.
`;
}

// =============================================================================
// Answer-summarisation system prompt
// =============================================================================

const SUMMARISE_SYSTEM = `You are a concise knowledge-graph analyst.
Given a user question and the raw query results (JSON rows), produce a short,
well-structured answer in Markdown. Use bullet lists for multiple items.
If results are empty, say "No results found." and suggest a refined query.
Do NOT fabricate data beyond what the results contain.`;

// =============================================================================
// Cypher execution via PersistenceCapability
// =============================================================================

async function executeCypher(
  runner: {
    run(
      cypher: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]>;
  },
  cypher: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const rows = await runner.run(cypher);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

// =============================================================================
// LLM helpers
// =============================================================================

async function llmComplete(opts: {
  system: string;
  userMessage: string;
  model?: string;
  apiKey?: string;
}): Promise<string> {
  const { OpenAILLMProvider } = await import("@intentweave/analyzer/llm");
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OpenAI API key required for natural-language queries.\n" +
        "Set OPENAI_API_KEY environment variable or use --cypher for raw Cypher.",
    );
  }

  const provider = new OpenAILLMProvider({
    apiKey,
    model: opts.model ?? "gpt-4o-mini",
    timeoutMs: 30_000,
  });

  const response = await provider.complete({
    system: opts.system,
    messages: [{ role: "user", content: opts.userMessage }],
    temperature: 0,
    maxTokens: 2048,
  });

  if (response.finishReason === "error") {
    throw new Error(`LLM error: ${response.error}`);
  }
  return response.content.trim();
}

// =============================================================================
// Result formatting
// =============================================================================

function formatTable(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  if (rows.length === 0) return chalk.yellow("(no results)");

  // Calculate column widths
  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = col.length;
  }
  for (const row of rows) {
    for (const col of columns) {
      const val = stringify(row[col]);
      widths[col] = Math.max(widths[col] ?? 0, val.length);
    }
  }

  // Header
  const header = columns.map((c) => c.padEnd(widths[c])).join(" │ ");
  const separator = columns.map((c) => "─".repeat(widths[c])).join("─┼─");
  const dataRows = rows.map((row) =>
    columns.map((c) => stringify(row[c]).padEnd(widths[c])).join(" │ "),
  );

  return [chalk.bold(header), separator, ...dataRows].join("\n");
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(stringify).join(", ");
  return JSON.stringify(v);
}

function formatJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

// =============================================================================
// Command definition
// =============================================================================

export const queryCommand = new Command("query")
  .description("Query the knowledge graph (natural language or raw Cypher)")
  .argument(
    "<query>",
    "Natural-language question or Cypher query (with --cypher)",
  )
  .option("--cypher", "Interpret <query> as raw Cypher (skip LLM)")
  .option("--limit <n>", "Max rows to return", "50")
  .option("-o, --output <path>", "Write results to file (JSON)")
  .option(
    "-f, --format <fmt>",
    "Output format: table | json | summary",
    "summary",
  )
  .option("-s, --session <id>", "Session ID to scope queries to")
  .option(
    "-l, --layer <layer>",
    "Focus on graph layer: kwg | tcg | drift | skg | code | all",
    "all",
  )
  .option("-v, --verbose", "Show generated Cypher before execution")
  .option(
    "--model <model>",
    "LLM model for NL→Cypher translation",
    "gpt-4o-mini",
  )
  .option("--neo4j-uri <uri>", "Neo4j connection URI")
  .option("--api-key <key>", "OpenAI API key override")
  .action(async (queryArg: string, options) => {
    const {
      cypher: rawCypherMode,
      limit,
      output,
      format,
      session: sessionId,
      layer: layerStr,
      verbose,
      model,
      neoUri,
      apiKey,
    } = options;

    const layer = (
      VALID_LAYERS.includes(layerStr as GraphLayer) ? layerStr : "all"
    ) as GraphLayer;

    const limitN = parseInt(limit, 10) || 50;

    try {
      // ── Set up persistence ────────────────────────────────────────
      if (options.neo4jUri ?? options.neoUri) {
        process.env.NEO4J_URI = options.neo4jUri ?? options.neoUri;
      }
      const runner = createGraphRunner();
      if (verbose) {
        console.log(chalk.blue("Connected to graph database"));
      }

      let cypherQuery: string;

      if (rawCypherMode) {
        // ── Raw Cypher mode ─────────────────────────────────────────────
        cypherQuery = queryArg;
        if (verbose) {
          console.log(chalk.blue("Mode:"), "raw Cypher");
        }
      } else {
        // ── NL → Cypher mode ────────────────────────────────────────────
        if (verbose) {
          console.log(chalk.blue("Translating question to Cypher…"));
        }
        const systemPrompt = buildSystemPrompt(sessionId, layer);
        const userPrompt = `Question: ${queryArg}\nLimit: ${limitN}`;
        cypherQuery = await llmComplete({
          system: systemPrompt,
          userMessage: userPrompt,
          model,
          apiKey,
        });

        // Strip markdown code fences if the LLM wraps them anyway
        cypherQuery = cypherQuery
          .replace(/^```(?:cypher)?\s*\n?/i, "")
          .replace(/\n?```\s*$/i, "")
          .trim();

        // Safety: if the LLM returned a comment instead of a query
        if (cypherQuery.startsWith("//")) {
          console.log(chalk.yellow(cypherQuery));
          return;
        }
      }

      if (verbose) {
        console.log(chalk.blue("\nCypher:"));
        console.log(chalk.gray(cypherQuery));
        console.log();
      }

      // ── Execute Cypher (with auto-retry on syntax errors) ─────────
      let execResult: { columns: string[]; rows: Record<string, unknown>[] };
      try {
        execResult = await executeCypher(runner, cypherQuery);
      } catch (execErr: any) {
        const errMsg = execErr?.message ?? String(execErr);
        // If this was an NL-generated query and it's a syntax/semantic error, retry
        if (
          !rawCypherMode &&
          /SyntaxError|Invalid|unexpected|not supported/i.test(errMsg)
        ) {
          if (verbose) {
            console.log(chalk.yellow("Cypher error, asking LLM to fix…"));
          }
          const fixPrompt = [
            `The following Cypher query failed with an error:`,
            "",
            "```cypher",
            cypherQuery,
            "```",
            "",
            `Error: ${errMsg}`,
            "",
            `Please fix the query and output ONLY the corrected Cypher.`,
          ].join("\n");

          cypherQuery = await llmComplete({
            system: buildSystemPrompt(sessionId, layer),
            userMessage: fixPrompt,
            model,
            apiKey,
          });
          cypherQuery = cypherQuery
            .replace(/^```(?:cypher)?\s*\n?/i, "")
            .replace(/\n?```\s*$/i, "")
            .trim();

          if (verbose) {
            console.log(chalk.blue("Retried Cypher:"));
            console.log(chalk.gray(cypherQuery));
            console.log();
          }
          execResult = await executeCypher(runner, cypherQuery);
        } else {
          throw execErr;
        }
      }

      const { columns, rows } = execResult;

      if (verbose) {
        console.log(chalk.blue(`${rows.length} row(s) returned\n`));
      }

      // ── Format output ─────────────────────────────────────────────
      if (format === "json") {
        const jsonOut = formatJson(rows);
        console.log(jsonOut);
        if (output) {
          writeFileSync(output, jsonOut, "utf-8");
          console.log(chalk.green(`\nWritten to ${output}`));
        }
      } else if (format === "table") {
        console.log(formatTable(columns, rows));
        if (output) {
          writeFileSync(output, formatJson(rows), "utf-8");
          console.log(chalk.green(`\nJSON written to ${output}`));
        }
      } else {
        // "summary" (default) — table + LLM summary (NL mode only)
        console.log(formatTable(columns, rows));

        if (!rawCypherMode && rows.length > 0) {
          console.log();
          if (verbose) console.log(chalk.blue("Generating summary…"));
          const summaryPrompt = [
            `User question: ${queryArg}`,
            "",
            `Query results (${rows.length} rows):`,
            JSON.stringify(rows.slice(0, 100), null, 2), // cap at 100 rows for prompt
          ].join("\n");

          const summary = await llmComplete({
            system: SUMMARISE_SYSTEM,
            userMessage: summaryPrompt,
            model,
            apiKey,
          });

          console.log(chalk.green("─── Summary ───"));
          console.log(summary);
        }

        if (output) {
          writeFileSync(output, formatJson(rows), "utf-8");
          console.log(chalk.green(`\nJSON written to ${output}`));
        }
      }
    } catch (err: any) {
      console.error(chalk.red("Error:"), err.message ?? err);
      process.exit(1);
    }
  });
