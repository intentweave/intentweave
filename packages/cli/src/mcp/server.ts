// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * IntentWeave MCP Server
 *
 * Exposes the knowledge graph via Model Context Protocol (stdio transport).
 * Compatible with VS Code (Copilot), Claude Desktop, and any MCP client.
 *
 * Tools:
 *   - kg_query:    Natural-language or raw Cypher query
 *   - kg_context:  Build structured context for a topic / entity
 *   - kg_entities: List / search entities in the graph
 *   - kg_schema:   Describe the graph schema (entity types, predicates)
 *
 * Usage:
 *   iw mcp --session <id>             # start stdio MCP server
 *   iw mcp --session <id> --verbose   # log activity to stderr
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildTopicContext as sharedBuildTopicContext,
  buildEntityContext as sharedBuildEntityContext,
  buildFullContext as sharedBuildFullContext,
  enrichWithDescriptions,
  enrichWithCodeRefs,
  formatContextMarkdown as sharedFormatContextMarkdown,
  type Neo4jRunner,
  type ContextOptions,
  type FormatOptions,
} from "../context/index.js";
import {
  analyzeImpact,
  formatImpactMarkdown,
  type ImpactOptions,
} from "../impact/index.js";
import {
  analyzeDocHealth,
  formatDocHealthMarkdown,
  formatDocHealthForAgent,
  type DocHealthOptions,
  preflightDocHealth,
  formatPreflightForAgent,
} from "../doc-health/index.js";

// =============================================================================
// Neo4j connection (same dynamic import pattern as CLI commands)
// =============================================================================

interface Neo4jConnection {
  driver: any;
  session: any;
  close: () => Promise<void>;
}

let _conn: Neo4jConnection | undefined;
let _connUri: string | undefined;

async function getConnection(uri?: string): Promise<Neo4jConnection> {
  // If we have an existing connection, verify it's still alive
  if (_conn) {
    try {
      await _conn.driver.verifyConnectivity();
      return _conn;
    } catch {
      // Connection is stale — close and recreate
      try {
        await _conn.close();
      } catch {
        /* ignore */
      }
      _conn = undefined;
    }
  }

  const neo4j = await import("neo4j-driver");
  const neoUri =
    uri ?? _connUri ?? process.env.NEO4J_URI ?? "bolt://localhost:7687";
  _connUri = neoUri; // remember for reconnection
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? "neo4j";
  const password = process.env.NEO4J_PASSWORD;

  if (!password) {
    throw new Error(
      "NEO4J_PASSWORD environment variable is required. Example: export NEO4J_PASSWORD=codegraph",
    );
  }

  const driver = neo4j.default.driver(
    neoUri,
    neo4j.default.auth.basic(user, password),
  );
  await driver.verifyConnectivity();
  const session = driver.session();

  _conn = {
    driver,
    session,
    close: async () => {
      await session.close();
      await driver.close();
      _conn = undefined;
    },
  };
  return _conn;
}

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

async function runCypher(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const conn = await getConnection();
  const neo4j = await import("neo4j-driver");

  // Convert numeric params to Neo4j integers
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
}

// =============================================================================
// LLM helper (for NL → Cypher translation)
// =============================================================================

async function llmComplete(
  system: string,
  userMessage: string,
): Promise<string> {
  const { OpenAILLMProvider } = await import("@intentweave/analyzer/llm");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable required for natural-language queries.",
    );
  }

  const provider = new OpenAILLMProvider({
    apiKey,
    model: "gpt-4o-mini",
    timeoutMs: 30_000,
  });

  const response = await provider.complete({
    system,
    messages: [{ role: "user", content: userMessage }],
    temperature: 0,
    maxTokens: 2048,
  });

  if (response.finishReason === "error") {
    throw new Error(`LLM error: ${response.error}`);
  }
  return response.content.trim();
}

// =============================================================================
// Graph schema (shared with LLM prompt)
// =============================================================================

const GRAPH_SCHEMA_TEXT = `
Neo4j Knowledge-Graph Schema:

Node labels:
  :Canon:Entity — canonical entities (properties: canonId, name, type, aliases[], confidence, session_id, run_id)
  :RawTriple — raw extraction triples (properties: subject, predicate, object, confidence, rationale, session_id)

Entity types: concept, decision, option, requirement, feature, component, technology, resource, role, risk, phase, constraint, question, tradeoff

Relationships between :Canon:Entity nodes use :CANON_REL with a predicate property:
  Structural:  CONTAINS, DEPENDS_ON, ALTERNATIVE_TO
  Behavioral:  HAS_STATE, TRANSITIONS_TO, TRIGGERS
  Decision:    DECIDED_FOR, DECIDED_AGAINST, SUPERSEDES, MOTIVATED_BY, ENABLES, BLOCKS, RISKS, DEFERRED_TO
  Interaction: CALLS, USES, PRODUCES, CONSUMES
  Fallback:    RELATED_TO

Cross-layer links (semantic → code):
  :CodeRef — code references (properties: filePath, name, kind, language, session_id)
  (:Canon:Entity)-[:REALIZED_BY { strategy, confidence, detail }]->(:CodeRef)
  CodeRef kinds: package-dep, import, symbol, file, directory
  Strategies: dep (package.json), import (source imports), name (exported symbols), path (file paths)

Other: (:RawTriple)-[:CANONICALIZED_FROM { role: "subject"|"object" }]->(:Canon:Entity)
`.trim();

function buildCypherSystemPrompt(sessionId: string): string {
  return `You are a Cypher query generator for a Neo4j knowledge graph.

${GRAPH_SCHEMA_TEXT}

The current session_id is "${sessionId}". Always filter by session_id = "${sessionId}".

Rules:
1. Output ONLY the Cypher query — no explanation, no markdown fences.
2. Every column alias must be unique.
3. Use :CANON_REL with predicate property for relationship queries (e.g. {predicate: "DECIDED_FOR"}).
4. Use toLower/CONTAINS for name matching.
5. If the question can't be answered, return // comment explaining why.
`;
}

// =============================================================================
// Tool implementations
// =============================================================================

async function toolQuery(args: {
  question: string;
  cypher?: string;
  session_id: string;
  limit: number;
}): Promise<string> {
  let cypherQuery: string;

  if (args.cypher) {
    cypherQuery = args.cypher;
  } else {
    const system = buildCypherSystemPrompt(args.session_id);
    cypherQuery = await llmComplete(
      system,
      `Question: ${args.question}\nLimit: ${args.limit}`,
    );
    cypherQuery = cypherQuery
      .replace(/^```(?:cypher)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();

    if (cypherQuery.startsWith("//")) {
      return cypherQuery;
    }
  }

  const rows = await runCypher(cypherQuery);
  if (rows.length === 0) {
    return `No results found.\n\nCypher used:\n${cypherQuery}`;
  }

  // Format as markdown table
  const columns = Object.keys(rows[0]);
  const header = "| " + columns.join(" | ") + " |";
  const sep = "| " + columns.map(() => "---").join(" | ") + " |";
  const dataRows = rows
    .slice(0, args.limit)
    .map(
      (row) => "| " + columns.map((c) => stringify(row[c])).join(" | ") + " |",
    );

  return [
    `Found ${rows.length} result(s):`,
    "",
    header,
    sep,
    ...dataRows,
    "",
    `Cypher: \`${cypherQuery}\``,
  ].join("\n");
}

/**
 * Create a Neo4jRunner adapter from the MCP connection.
 */
function createMcpRunner(): Neo4jRunner {
  return {
    async run(cypher: string, params?: Record<string, unknown>) {
      return runCypher(cypher, params);
    },
  };
}

/**
 * Create an LLM completer from the MCP server's llmComplete function.
 */
function createMcpLlmCompleter(): (opts: {
  system: string;
  userMessage: string;
}) => Promise<string> {
  return async (opts) => llmComplete(opts.system, opts.userMessage);
}

async function toolContext(args: {
  topic?: string;
  entity?: string;
  session_id: string;
  hops: number;
  limit: number;
}): Promise<string> {
  const runner = createMcpRunner();

  const contextOpts: ContextOptions = {
    runner,
    sessionId: args.session_id,
    limit: args.limit,
    hops: args.hops,
    includeRationales: true,
    includeProvenance: true,
    includeCodeRefs: true,
  };

  let bundle;

  if (args.entity) {
    bundle = await sharedBuildEntityContext(args.entity, contextOpts);
  } else if (args.topic) {
    contextOpts.llm = createMcpLlmCompleter();
    bundle = await sharedBuildTopicContext(args.topic, contextOpts);
  } else {
    bundle = await sharedBuildFullContext(contextOpts);
  }

  // Enrich with descriptions and code references for richer MCP output
  await enrichWithDescriptions(runner, args.session_id, bundle.entities);
  await enrichWithCodeRefs(runner, args.session_id, bundle.entities);

  const formatOpts: FormatOptions = {
    includeRationales: true,
    includeProvenance: true,
    includeDescriptions: true,
    includeCodeRefs: true,
  };

  return sharedFormatContextMarkdown(bundle, formatOpts);
}

// Old inlined context builders removed — now using shared module from ../context/

async function toolEntities(args: {
  session_id: string;
  type?: string;
  search?: string;
  limit: number;
}): Promise<string> {
  let cypher: string;
  const params: Record<string, unknown> = {
    sid: args.session_id,
    lim: args.limit,
  };

  if (args.search) {
    cypher = `MATCH (n:Canon)
      WHERE n.session_id = $sid
        AND (toLower(n.name) CONTAINS toLower($search)
             OR ANY(a IN coalesce(n.aliases, []) WHERE toLower(a) CONTAINS toLower($search)))
      ${args.type ? "AND toLower(n.type) = toLower($type)" : ""}
      RETURN n.name AS name, n.type AS type, n.confidence AS confidence
      ORDER BY n.confidence DESC, n.name
      LIMIT $lim`;
    params.search = args.search;
    if (args.type) params.type = args.type;
  } else if (args.type) {
    cypher = `MATCH (n:Canon)
      WHERE n.session_id = $sid AND toLower(n.type) = toLower($type)
      RETURN n.name AS name, n.type AS type, n.confidence AS confidence
      ORDER BY n.name
      LIMIT $lim`;
    params.type = args.type;
  } else {
    cypher = `MATCH (n:Canon)
      WHERE n.session_id = $sid
      RETURN n.name AS name, n.type AS type, n.confidence AS confidence
      ORDER BY n.type, n.name
      LIMIT $lim`;
  }

  const rows = await runCypher(cypher, params);
  if (rows.length === 0) return "No entities found.";

  const header = "| name | type | confidence |";
  const sep = "| --- | --- | --- |";
  const dataRows = rows.map(
    (r) =>
      `| ${r.name} | ${r.type} | ${typeof r.confidence === "number" ? r.confidence.toFixed(2) : ""} |`,
  );

  return [header, sep, ...dataRows].join("\n");
}

function toolSchema(): string {
  return GRAPH_SCHEMA_TEXT;
}

async function toolDocHealth(args: {
  session_id: string;
  files?: string[];
  lite?: boolean;
}): Promise<string> {
  // Lightweight mode: no Neo4j, no LLM — keyword-only
  if (args.lite) {
    const cwd = process.cwd();
    const targets =
      args.files && args.files.length > 0 ? args.files : [cwd];
    const result = await preflightDocHealth({ files: targets, cwd });
    return formatPreflightForAgent(result);
  }

  // Full mode: requires Neo4j
  const runner = createMcpRunner();

  const opts: DocHealthOptions = {
    runner,
    sessionId: args.session_id,
    files: args.files && args.files.length > 0 ? args.files : undefined,
    minRelCount: 2,
    cwd: process.cwd(),
  };

  const result = await analyzeDocHealth(opts);
  return formatDocHealthForAgent(result);
}

async function toolImpact(args: {
  files: string[];
  session_id: string;
  hops: number;
}): Promise<string> {
  const runner = createMcpRunner();

  const impactOpts: ImpactOptions = {
    runner,
    sessionId: args.session_id,
    hops: args.hops,
    limit: 100,
  };

  const result = await analyzeImpact(args.files, impactOpts);
  return formatImpactMarkdown(result);
}

// =============================================================================
// Helpers
// =============================================================================

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(stringify).join(", ");
  return JSON.stringify(v);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// =============================================================================
// MCP Server setup
// =============================================================================

export interface McpServerOptions {
  sessionId: string;
  neo4jUri?: string;
  verbose?: boolean;
}

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const { sessionId, verbose } = options;
  const log = verbose
    ? (...args: unknown[]) => console.error("[iw-mcp]", ...args)
    : () => {};

  log(`Starting MCP server for session "${sessionId}"…`);

  const server = new McpServer({
    name: "intentweave-kg",
    version: "1.0.0",
  });

  // ── Tool: kg_query ──────────────────────────────────────────────────
  server.tool(
    "kg_query",
    "Query the knowledge graph with a natural-language question or raw Cypher. Returns results as a markdown table.",
    {
      question: z
        .string()
        .describe("Natural-language question about the knowledge graph"),
      cypher: z
        .string()
        .optional()
        .describe("Raw Cypher query (if provided, question is ignored)"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max number of rows to return"),
    },
    async (args) => {
      log(
        `kg_query: ${args.cypher ? "cypher" : "NL"} — "${args.cypher ?? args.question}"`,
      );
      try {
        const result = await toolQuery({
          question: args.question,
          cypher: args.cypher,
          session_id: sessionId,
          limit: args.limit ?? 50,
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: kg_context ────────────────────────────────────────────────
  server.tool(
    "kg_context",
    "Build structured knowledge context (entities + relationships + code references) for a topic or entity. Returns markdown suitable for LLM prompt injection. Includes cross-layer links showing which source files implement each concept.",
    {
      topic: z
        .string()
        .optional()
        .describe(
          "Topic to build context for (uses LLM to select relevant entities)",
        ),
      entity: z
        .string()
        .optional()
        .describe(
          "Seed from a specific entity name and expand its neighborhood",
        ),
      hops: z
        .number()
        .optional()
        .default(2)
        .describe("Neighborhood expansion depth (1-3)"),
      limit: z
        .number()
        .optional()
        .default(200)
        .describe("Max entities to include"),
    },
    async (args) => {
      log(
        `kg_context: topic="${args.topic ?? ""}" entity="${args.entity ?? ""}"`,
      );
      try {
        const result = await toolContext({
          topic: args.topic,
          entity: args.entity,
          session_id: sessionId,
          hops: args.hops ?? 2,
          limit: args.limit ?? 200,
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: kg_entities ───────────────────────────────────────────────
  server.tool(
    "kg_entities",
    "List or search entities in the knowledge graph. Filter by type (concept, decision, component, technology, etc.) and/or search by name.",
    {
      type: z
        .string()
        .optional()
        .describe(
          "Filter to entity type: concept, decision, option, requirement, feature, component, technology, resource, role, risk, phase, constraint, question, tradeoff",
        ),
      search: z
        .string()
        .optional()
        .describe("Search entities by name (case-insensitive substring match)"),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Max entities to return"),
    },
    async (args) => {
      log(
        `kg_entities: type="${args.type ?? ""}" search="${args.search ?? ""}"`,
      );
      try {
        const result = await toolEntities({
          session_id: sessionId,
          type: args.type,
          search: args.search,
          limit: args.limit ?? 100,
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: kg_impact ──────────────────────────────────────────────
  server.tool(
    "kg_impact",
    "Analyze semantic impact of changing file(s). Shows which concepts, decisions, and risks are affected. Use this before making changes to understand the blast radius.",
    {
      files: z
        .array(z.string())
        .describe(
          'Workspace-relative file path(s) to analyze (e.g. ["package.json", "ui/src/App.tsx"])',
        ),
      hops: z
        .number()
        .optional()
        .default(2)
        .describe("Ripple expansion depth (1-3)"),
    },
    async (args) => {
      log(`kg_impact: files=${JSON.stringify(args.files)}`);
      try {
        const result = await toolImpact({
          files: args.files,
          session_id: sessionId,
          hops: args.hops ?? 2,
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: kg_doc_health ─────────────────────────────────────────────
  server.tool(
    "kg_doc_health",
    `Analyze documentation freshness and grounding. Returns a human-readable report PLUS structured JSON for agent reasoning.

Detects:
- **stale**: entities decided against or superseded
- **drift**: new relationships not reflected in docs
- **contradiction**: doc claims conflict with graph state
- **orphaned**: entities with no code references, no cross-doc mentions, and low KG connectivity
  - Each orphaned entity has a \`likelyStatus\` heuristic: "stale" (outdated), "planned" (aspirational), or "unknown"
- **undocumented**: graph entities with no doc provenance

The structured JSON block at the end contains per-document grounding details. Use it to decide whether to remove stale references, leave planned items, or investigate unknowns with \`kg_context\`.`,
    {
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Document file path(s) to analyze (omit to scan all session documents)",
        ),
      lite: z
        .boolean()
        .optional()
        .describe(
          "Lightweight keyword-only mode. No Neo4j or LLM required. " +
            "Extracts entity names from markdown structure (headings, bold, code spans) " +
            "and checks if they appear in source files. Fast pre-flight check.",
        ),
    },
    async (args) => {
      log(
        `kg_doc_health: files=${JSON.stringify(args.files ?? "all")} lite=${args.lite ?? false}`,
      );
      try {
        const result = await toolDocHealth({
          files: args.files,
          session_id: sessionId,
          lite: args.lite,
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: kg_schema ─────────────────────────────────────────────────
  server.tool(
    "kg_schema",
    "Describe the knowledge graph schema: node types, entity types, relationship predicates, and property names.",
    {},
    async () => {
      log("kg_schema");
      return { content: [{ type: "text", text: toolSchema() }] };
    },
  );

  // ── Connect via stdio ───────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server running (stdio transport). Waiting for messages…");
}
