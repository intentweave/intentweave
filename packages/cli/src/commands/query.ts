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

// =============================================================================
// Graph schema description (fed to the LLM for Cypher generation)
// =============================================================================

const GRAPH_SCHEMA = `
## Neo4j Knowledge-Graph Schema

### Node labels

1. **:Canon:Entity**
   Every canonical entity extracted by the KX stage.
   Properties:
     - canonId   (string, unique per session)  — e.g. "schema_free_extraction"
     - name      (string)                      — human-readable label
     - type      (string)                      — one of: concept, decision, option, requirement,
                                                  feature, component, technology, resource, role,
                                                  risk, phase, constraint, question, tradeoff
     - aliases   (string[])                    — alternate surface forms
     - confidence (float 0-1)
     - session_id (string)                     — workspace / session scope
     - run_id     (string)
     - workspace_id (string)
     - track      (string)                     — always "open"

2. **:RawTriple**
   Every raw (pre-canonicalization) triple from the FX stage.
   Properties:
     - subject      (string)
     - predicate    (string)
     - object       (string)
     - subjectKind  (string)
     - objectKind   (string)
     - confidence   (float 0-1)
     - rationale    (string)
     - session_id   (string)
     - run_id       (string)

### Relationships between :Canon:Entity nodes

All canonical relationships are stored as **:CANON_REL** edges with a
\`predicate\` property that holds the semantic relationship type.

Canonical predicates (stored in r.predicate):
  Structural:  CONTAINS, DEPENDS_ON, ALTERNATIVE_TO
  Behavioral:  HAS_STATE, TRANSITIONS_TO, TRIGGERS
  Decision:    DECIDED_FOR, DECIDED_AGAINST, SUPERSEDES, MOTIVATED_BY,
               ENABLES, BLOCKS, RISKS, DEFERRED_TO
  Interaction: CALLS, USES, PRODUCES, CONSUMES
  Fallback:    RELATED_TO

**Example relationship queries:**
  // Find all "DECIDED_FOR" relationships:
  MATCH (a:Canon)-[r:CANON_REL {predicate: "DECIDED_FOR"}]->(b:Canon) ...

  // Find all relationships for a concept:
  MATCH (a:Canon)-[r:CANON_REL]->(b:Canon) WHERE toLower(a.name) CONTAINS "..." ...

  // Find by multiple predicates:
  MATCH (a:Canon)-[r:CANON_REL]->(b:Canon) WHERE r.predicate IN ["ENABLES","BLOCKS"] ...

### Other relationships

  (:RawTriple)-[:CANONICALIZED_FROM { role: "subject"|"object" }]->(:Canon:Entity)

### Important notes
- Always filter by session_id when the user mentions a workspace.
- Relationship predicates are stored in the \`predicate\` property of :CANON_REL, NOT as separate relationship types.
- Use OPTIONAL MATCH when relationships might not exist.
- Return human-readable columns (name, type) rather than raw IDs.
- When asked about decisions, use predicate "DECIDED_FOR" or "DECIDED_AGAINST".
`.trim();

// =============================================================================
// Cypher-generation system prompt
// =============================================================================

function buildSystemPrompt(sessionId?: string): string {
  const sessionClause = sessionId
    ? `\nThe current session_id is "${sessionId}". Always include \`WHERE ... session_id = "${sessionId}"\` unless the user explicitly asks for cross-session results.`
    : "";

  return `You are a Cypher query generator for a Neo4j knowledge graph.

${GRAPH_SCHEMA}
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
// Neo4j helpers (dynamic import, same pattern as persist-neo4j.ts)
// =============================================================================

interface Neo4jConnection {
  driver: any;
  session: any;
  close: () => Promise<void>;
}

async function connectNeo4j(opts: {
  uri?: string;
  user?: string;
  password?: string;
}): Promise<Neo4jConnection> {
  const neo4j = await import("neo4j-driver");

  const uri = opts.uri ?? process.env.NEO4J_URI ?? "bolt://localhost:7687";
  const user =
    opts.user ??
    process.env.NEO4J_USER ??
    process.env.NEO4J_USERNAME ??
    "neo4j";
  const password = opts.password ?? process.env.NEO4J_PASSWORD;

  if (!password) {
    throw new Error(
      "Neo4j password required. Set NEO4J_PASSWORD environment variable.\n" +
        "Example: export NEO4J_PASSWORD=codegraph",
    );
  }

  const driver = neo4j.default.driver(
    uri,
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

/** Convert Neo4j Integer / other exotic types to plain JS values. */
function toPlainValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  // Neo4j integer
  if (
    typeof v === "object" &&
    v !== null &&
    "toNumber" in v &&
    typeof (v as any).toNumber === "function"
  ) {
    return (v as any).toNumber();
  }
  // Neo4j Node
  if (
    typeof v === "object" &&
    v !== null &&
    "properties" in v &&
    "labels" in v
  ) {
    const node = v as any;
    return { _labels: node.labels, ...plainProps(node.properties) };
  }
  // Neo4j Relationship
  if (
    typeof v === "object" &&
    v !== null &&
    "properties" in v &&
    "type" in v &&
    "start" in v
  ) {
    const rel = v as any;
    return { _type: rel.type, ...plainProps(rel.properties) };
  }
  // Neo4j Path
  if (typeof v === "object" && v !== null && "segments" in v) {
    const path = v as any;
    return {
      _path: path.segments.map((s: any) => ({
        start: toPlainValue(s.start),
        rel: toPlainValue(s.relationship),
        end: toPlainValue(s.end),
      })),
    };
  }
  // Array
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

async function executeCypher(
  conn: Neo4jConnection,
  cypher: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const result = await conn.session.run(cypher);
  const columns =
    result.records.length > 0 ? (result.records[0].keys as string[]) : [];
  const rows = result.records.map((rec: any) => {
    const row: Record<string, unknown> = {};
    for (const key of rec.keys) {
      row[key as string] = toPlainValue(rec.get(key));
    }
    return row;
  });
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
      verbose,
      model,
      neoUri,
      apiKey,
    } = options;

    const limitN = parseInt(limit, 10) || 50;
    let conn: Neo4jConnection | undefined;

    try {
      // ── Connect to Neo4j ──────────────────────────────────────────────
      conn = await connectNeo4j({ uri: options.neo4jUri ?? options.neoUri });
      if (verbose) {
        console.log(chalk.blue("Connected to Neo4j"));
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
        const systemPrompt = buildSystemPrompt(sessionId);
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
        execResult = await executeCypher(conn, cypherQuery);
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
            system: buildSystemPrompt(sessionId),
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
          execResult = await executeCypher(conn, cypherQuery);
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
    } finally {
      if (conn) await conn.close();
    }
  });
