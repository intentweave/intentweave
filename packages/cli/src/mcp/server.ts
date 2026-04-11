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
 *   - cari_retrieve:    Ranked file retrieval from CARI index (SQLite)
 *   - cari_connections: Interconnection discovery + gap detection
 *   - cari_check:       CI drift detection for changed files
 *   - cari_clones:      Exact clone detection (identical body hash)
 *   - cari_structural_clones: Type 2 clone detection (same structure, different identifiers)
 *   - cari_circular_imports:  Import cycle detection
 *   - cari_unused_exports:    Exported symbols never imported
 *   - cari_hotspot_priority:  High-churn low-doc files ranked by urgency
 *   - cari_todos:       TODO/FIXME/HACK/XXX inventory
 *   - cari_module_coverage:   Documentation coverage % per directory
 *   - cari_orphaned_sections: Doc sections with all-ungrounded mentions
 *   - cari_doc_completeness:  Per-doc completeness vs. referenced exports
 *   - cari_cross_group_drift: Cross-group entity coverage conflicts
 *   - cari_mentions_of:       Find doc mentions of an entity (Entity Bridge)
 *   - cari_annotations_for:   List annotations for a document file
 *   - cari_test_coverage:     Map test files → source files, find untested exports
 *   - cari_hubs:              Degree centrality / god-node analysis
 *   - cari_communities:       Label-propagation community detection
 *   - cari_surprises:         Surprising connection ranking
 *   - cari_rationale:         WHY/NOTE/IMPORTANT/DESIGN rationale inventory
 *   - cari_terminology:       Terminology inconsistency detection
 *   - cari_dep_depth:         Transitive import depth + fan-in/fan-out risk
 *   - cari_boundary_violations: Cross-package internal import detection
 *   - cari_layers_infer:     Auto-infer architectural layers from import graph
 *   - cari_layers_check:     Validate imports against layer configuration
 *   - cari_layers_name:      LLM-generated descriptive layer names (5.1c)
 *   - cari_slices:           Vertical slice detection (communities × layers)
 *
 * Usage:
 *   iw mcp --session <id>             # start stdio MCP server
 *   iw mcp --session <id> --verbose   # log activity to stderr
 */

import path from "node:path";
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
      "NEO4J_PASSWORD environment variable is required. Example: export NEO4J_PASSWORD=intentweave",
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
Neo4j Multi-Layer Graph Schema:

Layer 1 — KWG (Keywords):
  :KWEntity (name, mentionCount, session_id)
  :KWDoc (name, filePath, session_id)
  :KWCluster (clusterId, label, members[], size, session_id)
  Edges: CO_OCCURS, MENTIONS, CONTAINS, IN_CLUSTER

Layer 2 — TCG (Temporal):
  :TCGCommit (sha, message, authorName, date, session_id)
  :TCGFile (filePath, session_id)
  :TCGAuthor (name, email, session_id)
  Edges: TOUCHED, AUTHORED, CO_CHANGED

Layer 3 — Drift:
  :DriftSignal (id, name, detector, severity, message, category, files[], session_id)
  Edges: ABOUT→KWEntity, AFFECTS→KWDoc, AFFECTS→TCGFile
  Detectors: doc-code, doc-doc, deps  |  Severities: critical, warning, info

Layer 4 — SKG (Semantic):
  :Canon:Entity (canonId, name, type, aliases[], confidence, session_id, run_id)
  :RawTriple (subject, predicate, object, confidence, rationale, session_id)
  Edges: CANON_REL {predicate}, CANONICALIZED_FROM {role}
  Predicates: CONTAINS, DEPENDS_ON, DECIDED_FOR, DECIDED_AGAINST, ENABLES, BLOCKS, CALLS, USES, RELATED_TO, ...
  Entity types: concept, decision, option, requirement, feature, component, technology, resource, role, risk, phase, constraint, question, tradeoff

Layer 5 — Code:
  :CodeRef (filePath, name, kind, language, session_id)
  Edges: REALIZED_BY {strategy, confidence}

Cross-Layer:
  EVIDENCED_BY (Canon→KWEntity: mentionCount, driftCount, confidence)
  REALIZED_BY (Canon→CodeRef: strategy, confidence)
  ABOUT (DriftSignal→KWEntity)
  AFFECTS (DriftSignal→KWDoc, DriftSignal→TCGFile)

Query tips:
  - CANON_REL predicates stored in predicate property, e.g. {predicate: "DECIDED_FOR"}
  - Always filter by session_id
  - Use toLower/CONTAINS for name matching
  - For KWG: KWEntity.mentionCount, CO_OCCURS.weight
  - For TCG: TCGFile.filePath, CO_CHANGED.weight
  - For Drift: DriftSignal.severity, ABOUT→KWEntity
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
    const targets = args.files && args.files.length > 0 ? args.files : [cwd];
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

function parseLayersYamlForMcp(content: string): {
  layers: Array<{ name: string; patterns: string[] }>;
  allowSkipLayer?: boolean;
} {
  const layers: Array<{ name: string; patterns: string[] }> = [];
  let current: { name: string; patterns: string[] } | null = null;
  let inPatterns = false;

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- name:")) {
      if (current) layers.push(current);
      current = { name: line.slice("- name:".length).trim(), patterns: [] };
      inPatterns = false;
    } else if (line === "patterns:" && current) {
      inPatterns = true;
    } else if (line.startsWith("- ") && inPatterns && current) {
      current.patterns.push(
        line
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, ""),
      );
    }
  }
  if (current) layers.push(current);
  return { layers };
}

function handleCariError(err: { message?: string }): string {
  if (
    err.message?.includes("SQLITE_CANTOPEN") ||
    err.message?.includes("does not exist")
  ) {
    return "CARI index not found. Run `iw index build` first to create .iw/index.db.";
  }
  return `Error: ${err.message}`;
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

  // ── CARI Tools (Code-Aware Retrieval Index) ──────────────────────────
  // These tools query the SQLite-based CARI index (.iw/index.db).
  // No Neo4j or LLM required — pure local, precomputed data.

  /** Resolve the CARI index.db path (workspace .iw/index.db) */
  function resolveIndexDb(): string {
    return path.join(process.cwd(), ".iw", "index.db");
  }

  /** Lazy-load @intentweave/index to avoid import cost when not used */
  async function loadIndex() {
    return await import("@intentweave/index");
  }

  // ── Tool: cari_retrieve ───────────────────────────────────────────
  server.tool(
    "cari_retrieve",
    `Ranked file retrieval from the CARI index. Given a topic or symbol name, returns the most relevant files with scores and reasons.

Use this to find code and documentation related to a concept (e.g. "authentication", "payment flow") or a symbol (e.g. "AuthService", "validateUser").

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      query: z
        .string()
        .describe(
          "Topic or symbol name to search for (e.g. 'authentication', 'PaymentGateway')",
        ),
      scope: z
        .enum(["code", "docs", "all"])
        .optional()
        .default("all")
        .describe("Restrict results to code files, doc files, or all"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum number of files to return"),
    },
    async (args) => {
      log(
        `cari_retrieve: query="${args.query}" scope=${args.scope} limit=${args.limit}`,
      );
      try {
        const { retrieve } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = retrieve(dbPath, {
          query: args.query,
          scope: args.scope,
          limit: args.limit,
        });

        if (result.files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No files found matching "${args.query}". Try a broader query or run \`iw index build\` to rebuild the index.`,
              },
            ],
          };
        }

        const lines = [
          `## Retrieve: "${args.query}"  (scope: ${args.scope}, top ${result.files.length})`,
          "",
          "| # | File | Score | Reason |",
          "|---|------|-------|--------|",
          ...result.files.map(
            (f, i) =>
              `| ${i + 1} | ${f.path} | ${f.score.toFixed(2)} | ${f.reason} |`,
          ),
        ];

        // Append spans if present
        for (const f of result.files) {
          if (f.spans && f.spans.length > 0) {
            lines.push("", `### ${f.path}`);
            for (const s of f.spans.slice(0, 5)) {
              lines.push(`- L${s.line}: ${s.text}`);
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_connections ────────────────────────────────────────
  server.tool(
    "cari_connections",
    `Discover connections for a symbol or concept across three evidence layers:
- **Doc co-occurrence**: entities mentioned together in documentation
- **Git co-change**: files that change together in commits
- **Code structure**: annotations linking doc mentions to code symbols

Highlights **gaps** where evidence layers disagree (hidden couplings, undocumented dependencies).

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      entity: z
        .string()
        .describe(
          "Symbol name or keyword to find connections for (e.g. 'AuthService', 'rate limiting')",
        ),
      include: z
        .array(z.enum(["doc_cooc", "co_change", "code_import"]))
        .optional()
        .describe("Filter to specific evidence sources (default: all three)"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum connections per source type"),
    },
    async (args) => {
      log(
        `cari_connections: entity="${args.entity}" include=${JSON.stringify(args.include)} limit=${args.limit}`,
      );
      try {
        const { connections } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = connections(dbPath, {
          entity: args.entity,
          limit: args.limit,
          include: args.include as any,
        });

        if (result.connections.length === 0 && result.gaps.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No connections found for "${args.entity}". Check that the entity exists in the index (\`iw index retrieve "${args.entity}"\`).`,
              },
            ],
          };
        }

        const lines = [`## Connections: "${result.entity}"`, ""];

        // Group connections by source type
        const bySource = new Map<
          string,
          Array<{ name: string; score: number; detail: string }>
        >();
        for (const conn of result.connections) {
          for (const src of conn.sources) {
            if (!bySource.has(src.type)) bySource.set(src.type, []);
            bySource.get(src.type)!.push({
              name: conn.name,
              score: src.score,
              detail: src.detail,
            });
          }
        }

        const sourceLabels: Record<string, string> = {
          doc_cooc: "Co-mentioned in docs",
          co_change: "Co-changes in git",
          code_import: "Code structure",
        };

        for (const [srcType, items] of bySource) {
          lines.push(
            `### ${sourceLabels[srcType] ?? srcType}`,
            "",
            "| Entity | Score | Detail |",
            "|--------|-------|--------|",
          );
          for (const item of items) {
            lines.push(
              `| ${item.name} | ${item.score.toFixed(2)} | ${item.detail} |`,
            );
          }
          lines.push("");
        }

        // Gaps
        if (result.gaps.length > 0) {
          lines.push("### ⚠ Gaps", "");
          for (const gap of result.gaps) {
            const icon = gap.severity === "warning" ? "⚠" : "ℹ";
            lines.push(
              `- ${icon} **${gap.entities.join(" ↔ ")}**: ${gap.description}`,
            );
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_check ──────────────────────────────────────────────
  server.tool(
    "cari_check",
    `CI drift detection. Given changed file paths (from a PR diff or git status), finds:
- Documentation that references symbols in changed files but hasn't been updated
- Co-change partners missing from the PR (files that usually change together)
- Documentation files referencing hotspot code not included in the PR

Returns actionable findings with severity levels. No LLM or Neo4j needed.`,
    {
      changed: z
        .array(z.string())
        .describe(
          'File paths that changed (e.g. ["src/auth/service.ts", "src/auth/jwt.ts"])',
        ),
      severity: z
        .enum(["info", "warning", "critical"])
        .optional()
        .default("info")
        .describe("Minimum severity to report"),
    },
    async (args) => {
      log(
        `cari_check: changed=${JSON.stringify(args.changed)} severity=${args.severity}`,
      );
      try {
        const { check, formatCheck } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = check(dbPath, {
          changed: args.changed,
          severity: args.severity,
        });

        if (result.findings.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "✓ No drift detected. All documentation and co-change patterns look consistent with the changed files.",
              },
            ],
          };
        }

        const header = `## Drift Check  (${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}, exit code ${result.exitCode})\n\n`;
        const body = formatCheck(result, "text");
        return { content: [{ type: "text", text: header + body }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_clones ───────────────────────────────────────────
  server.tool(
    "cari_clones",
    `Detect exact code clones (Type 1). Finds functions/methods with identical normalised bodies (same body hash). Returns clone groups with file locations.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_clones");
      try {
        const { clones } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = clones(dbPath);

        if (result.totalCloneGroups === 0) {
          return {
            content: [
              { type: "text", text: "No exact clones found in the codebase." },
            ],
          };
        }

        const lines = [
          `## Exact Clones — ${result.totalCloneGroups} group(s), ${result.totalClonedSymbols} symbol(s)`,
          "",
        ];

        for (const group of result.cloneGroups) {
          lines.push(
            `### Clone group (${group.bodyLines} lines, ${group.symbols.length} copies)`,
            "",
            "| Symbol | File | Line | Kind |",
            "|--------|------|------|------|",
          );
          for (const s of group.symbols) {
            lines.push(`| ${s.name} | ${s.filePath} | ${s.line} | ${s.kind} |`);
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_structural_clones ────────────────────────────────
  server.tool(
    "cari_structural_clones",
    `Detect structural code clones (Type 2). Finds functions/methods with the same control-flow structure but different identifiers or literals. Excludes groups that are already exact clones.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_structural_clones");
      try {
        const { structuralClones } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = structuralClones(dbPath);

        if (result.totalCloneGroups === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No structural clones found in the codebase.",
              },
            ],
          };
        }

        const lines = [
          `## Structural Clones — ${result.totalCloneGroups} group(s), ${result.totalClonedSymbols} symbol(s)`,
          "",
        ];

        for (const group of result.cloneGroups) {
          lines.push(
            `### Clone group (${group.bodyLines} lines, ${group.symbols.length} copies)`,
            "",
            "| Symbol | File | Line | Kind |",
            "|--------|------|------|------|",
          );
          for (const s of group.symbols) {
            lines.push(`| ${s.name} | ${s.filePath} | ${s.line} | ${s.kind} |`);
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_circular_imports ─────────────────────────────────
  server.tool(
    "cari_circular_imports",
    `Detect circular import cycles in the codebase. Returns each cycle as an ordered list of files forming the loop.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_circular_imports");
      try {
        const { circularImports } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = circularImports(dbPath);

        if (result.totalCycles === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No circular import cycles detected.",
              },
            ],
          };
        }

        const lines = [
          `## Circular Imports — ${result.totalCycles} cycle(s)`,
          "",
        ];

        for (const cycle of result.cycles) {
          lines.push(
            `- **${cycle.length}-file cycle:** ${cycle.files.join(" → ")} → ${cycle.files[0]}`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_unused_exports ───────────────────────────────────
  server.tool(
    "cari_unused_exports",
    `Find exported symbols that are never imported anywhere in the codebase. Helps identify dead public API surface.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum results to return"),
    },
    async (args) => {
      log(`cari_unused_exports: limit=${args.limit}`);
      try {
        const { unusedExports } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = unusedExports(dbPath);

        if (result.totalUnused === 0) {
          return {
            content: [
              {
                type: "text",
                text: `All ${result.totalExported} exported symbols are imported somewhere.`,
              },
            ],
          };
        }

        const items = result.unused.slice(0, args.limit ?? 50);
        const lines = [
          `## Unused Exports — ${result.totalUnused} of ${result.totalExported} exported symbols`,
          "",
          "| Symbol | File | Line | Kind |",
          "|--------|------|------|------|",
          ...items.map(
            (u) => `| ${u.name} | ${u.filePath} | ${u.line} | ${u.kind} |`,
          ),
        ];

        if (result.totalUnused > items.length) {
          lines.push(
            "",
            `_Showing ${items.length} of ${result.totalUnused}. Increase limit to see more._`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_hotspot_priority ─────────────────────────────────
  server.tool(
    "cari_hotspot_priority",
    `Rank files by documentation urgency: high churn × low documentation coverage = high priority. Helps focus documentation effort where it matters most.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum files to return"),
    },
    async (args) => {
      log(`cari_hotspot_priority: limit=${args.limit}`);
      try {
        const { hotspotPriority } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = hotspotPriority(dbPath);

        if (result.priorities.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No hotspot data available. Ensure the index was built with git history.",
              },
            ],
          };
        }

        const items = result.priorities.slice(0, args.limit ?? 20);
        const lines = [
          `## Hotspot Priority — Top ${items.length} files needing documentation`,
          "",
          "| File | Churn | Documented | Total | Coverage | Priority |",
          "|------|-------|------------|-------|----------|----------|",
          ...items.map(
            (p) =>
              `| ${p.filePath} | ${p.churn} | ${p.documentedSymbols} | ${p.totalExportedSymbols} | ${p.coveragePercent.toFixed(0)}% | ${p.priorityScore.toFixed(2)} |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_todos ────────────────────────────────────────────
  server.tool(
    "cari_todos",
    `List all TODO, FIXME, HACK, and XXX comments found in the codebase. Returns file, line, kind, and comment text.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      kind: z
        .string()
        .optional()
        .describe("Filter by kind: TODO, FIXME, HACK, or XXX (omit for all)"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum results to return"),
    },
    async (args) => {
      log(`cari_todos: kind=${args.kind ?? "all"} limit=${args.limit}`);
      try {
        const { todos } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = todos(dbPath);

        let items = result.todos;
        if (args.kind) {
          items = items.filter(
            (t) => t.kind.toLowerCase() === args.kind!.toLowerCase(),
          );
        }
        const limited = items.slice(0, args.limit ?? 50);

        if (limited.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: args.kind
                  ? `No ${args.kind} comments found.`
                  : "No TODO/FIXME/HACK/XXX comments found.",
              },
            ],
          };
        }

        const kindSummary = Object.entries(result.byKind)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");

        const lines = [
          `## TODOs — ${result.totalCount} total (${kindSummary})`,
          "",
          "| Kind | File | Line | Text |",
          "|------|------|------|------|",
          ...limited.map(
            (t) => `| ${t.kind} | ${t.filePath} | ${t.line} | ${t.text} |`,
          ),
        ];

        if (items.length > limited.length) {
          lines.push(
            "",
            `_Showing ${limited.length} of ${items.length}. Increase limit to see more._`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_module_coverage ──────────────────────────────────
  server.tool(
    "cari_module_coverage",
    `Show documentation coverage percentage per directory/module. Lists how many exported symbols in each directory have at least one documentation mention.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_module_coverage");
      try {
        const { moduleCoverage } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = moduleCoverage(dbPath);

        if (result.modules.length === 0) {
          return {
            content: [
              { type: "text", text: "No module coverage data available." },
            ],
          };
        }

        const lines = [
          `## Module Coverage — ${result.modules.length} module(s)`,
          "",
          "| Module | Documented | Total | Coverage |",
          "|--------|------------|-------|----------|",
          ...result.modules.map(
            (m) =>
              `| ${m.module} | ${m.documented} | ${m.totalExported} | ${m.coveragePercent.toFixed(0)}% |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_orphaned_sections ────────────────────────────────
  server.tool(
    "cari_orphaned_sections",
    `Find documentation sections where all entity mentions are ungrounded (not linked to any code symbol). These sections may reference stale, renamed, or fictional entities.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_orphaned_sections");
      try {
        const { orphanedSections } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = orphanedSections(dbPath);

        if (result.totalOrphaned === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No orphaned documentation sections found. All sections have grounded mentions.",
              },
            ],
          };
        }

        const lines = [
          `## Orphaned Sections — ${result.totalOrphaned} section(s)`,
          "",
          "| Document | Heading | Line | Ungrounded Mentions |",
          "|----------|---------|------|---------------------|",
          ...result.sections.map(
            (s) =>
              `| ${s.docPath} | ${s.heading} | ${s.line} | ${s.ungroundedMentions} |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_doc_completeness ─────────────────────────────────
  server.tool(
    "cari_doc_completeness",
    `Score each document by how completely it covers the exports from the code files it references. Shows which exported symbols are missing from each doc.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_doc_completeness");
      try {
        const { docCompleteness } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = docCompleteness(dbPath);

        if (result.docs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No document completeness data available.",
              },
            ],
          };
        }

        const lines = [
          `## Doc Completeness`,
          "",
          "| Document | Covered | Total | Completeness |",
          "|----------|---------|-------|--------------|",
          ...result.docs.map(
            (d) =>
              `| ${d.docPath} | ${d.coveredExports} | ${d.totalRelevantExports} | ${d.completenessPercent.toFixed(0)}% |`,
          ),
        ];

        // Show missing symbols for incomplete docs
        for (const doc of result.docs) {
          if (doc.missing.length > 0) {
            lines.push(
              "",
              `### Missing from ${doc.docPath}`,
              "",
              "| Symbol | File | Kind |",
              "|--------|------|------|",
              ...doc.missing
                .slice(0, 20)
                .map((m) => `| ${m.name} | ${m.filePath} | ${m.kind} |`),
            );
            if (doc.missing.length > 20) {
              lines.push(`_...and ${doc.missing.length - 20} more._`);
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_cross_group_drift ────────────────────────────────
  server.tool(
    "cari_cross_group_drift",
    `Detect entities mentioned in multiple documentation groups with conflicting qualifiers or coverage patterns. Reveals inconsistencies across docs.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_cross_group_drift");
      try {
        const { crossGroupDrift } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = crossGroupDrift(dbPath);

        if (result.totalDrifts === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No cross-group drift detected. Entity coverage is consistent across doc groups.",
              },
            ],
          };
        }

        const lines = [
          `## Cross-Group Drift — ${result.totalDrifts} finding(s)`,
          "",
        ];

        for (const drift of result.drifts) {
          lines.push(
            `### ${drift.entity}`,
            "",
            `**Reason:** ${drift.reason}`,
            "",
          );
          for (const g of drift.groups) {
            const quals =
              g.qualifiers.length > 0 ? ` [${g.qualifiers.join(", ")}]` : "";
            lines.push(
              `- **${g.docGroup}**: ${g.mentionCount} mention(s) in ${g.docPaths.join(", ")}${quals}`,
            );
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_mentions_of ──────────────────────────────────────
  server.tool(
    "cari_mentions_of",
    `Find all document mentions that reference a given entity (code symbol or external entity). Returns document paths, lines, confidence scores, and match types.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      entityId: z
        .string()
        .describe("Entity ID (symbol ID or external entity ID)"),
      minConfidence: z
        .number()
        .optional()
        .default(0)
        .describe("Minimum confidence threshold (0-1)"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum results to return"),
    },
    async (args) => {
      log(
        `cari_mentions_of: entity=${args.entityId} minConf=${args.minConfidence} limit=${args.limit}`,
      );
      try {
        const { mentionsOf } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = mentionsOf(dbPath, {
          entityId: args.entityId,
          minConfidence: args.minConfidence,
          limit: args.limit,
        });

        if (result.totalCount === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No mentions found for "${args.entityId}".`,
              },
            ],
          };
        }

        const lines = [
          `## Mentions of "${args.entityId}" — ${result.totalCount} found`,
          "",
          "| File | Line | Text | Confidence | Source |",
          "|------|------|------|------------|--------|",
          ...result.mentions.map(
            (m) =>
              `| ${m.docPath} | ${m.line} | ${m.text} | ${m.confidence.toFixed(2)} | ${m.source}${m.qualifier ? ` [${m.qualifier}]` : ""} |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_annotations_for ──────────────────────────────────
  server.tool(
    "cari_annotations_for",
    `List all annotations in a document file, showing which code symbols or external entities each mention maps to. Useful for understanding doc-to-code coverage.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      filePath: z
        .string()
        .describe("Document file path (relative to workspace)"),
      minConfidence: z
        .number()
        .optional()
        .default(0)
        .describe("Minimum confidence threshold (0-1)"),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Maximum results to return"),
    },
    async (args) => {
      log(
        `cari_annotations_for: file=${args.filePath} minConf=${args.minConfidence} limit=${args.limit}`,
      );
      try {
        const { annotationsForFile } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = annotationsForFile(dbPath, {
          filePath: args.filePath,
          minConfidence: args.minConfidence,
          limit: args.limit,
        });

        if (result.totalCount === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No annotations found for "${args.filePath}".`,
              },
            ],
          };
        }

        const lines = [
          `## Annotations in "${args.filePath}" — ${result.totalCount} found`,
          "",
          "| Line | Text | Entity | Source | Confidence |",
          "|------|------|--------|--------|------------|",
          ...result.annotations.map((a) => {
            const entity = a.entityName
              ? `${a.entityName} (${a.entitySource})`
              : "_ungrounded_";
            return `| ${a.line} | ${a.text} | ${entity} | ${a.source}${a.qualifier ? ` [${a.qualifier}]` : ""} | ${a.confidence.toFixed(2)} |`;
          }),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── cari_test_coverage ─────────────────────────────────────────────
  server.tool(
    "cari_test_coverage",
    `Map test files to source files and find untested exported symbols. Uses naming conventions (foo.test.ts → foo.ts, foo.spec.ts, __tests__/) and import analysis to determine coverage.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      limit: z
        .number()
        .optional()
        .describe("Max untested symbols to return (default: all)"),
    },
    async ({ limit }) => {
      log("cari_test_coverage", { limit });
      try {
        const { testCoverage } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = testCoverage(dbPath, { limit });

        if (result.totalExported === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No exported symbols found in the index.",
              },
            ],
          };
        }

        const lines = [
          `## Test Coverage: ${result.covered}/${result.totalExported} exported symbols (${result.coveragePercent}%)`,
          "",
        ];

        if (result.mappings.length > 0) {
          lines.push(
            "### Test → Source Mappings",
            "",
            "| Test File | Source File | Strategy | Imported Names |",
            "|-----------|------------|----------|----------------|",
          );
          for (const m of result.mappings) {
            const names =
              m.importedNames.length > 0 ? m.importedNames.join(", ") : "—";
            lines.push(
              `| ${m.testFile} | ${m.sourceFile} | ${m.strategy} | ${names} |`,
            );
          }
          lines.push("");
        }

        if (result.untested.length > 0) {
          lines.push(
            "### Untested Exported Symbols",
            "",
            "| Symbol | File | Kind | Line |",
            "|--------|------|------|------|",
          );
          for (const u of result.untested) {
            lines.push(`| ${u.name} | ${u.filePath} | ${u.kind} | ${u.line} |`);
          }
          lines.push("");
        }

        if (result.byDirectory.length > 0) {
          lines.push(
            "### Per-Directory Coverage",
            "",
            "| Directory | Covered | Total | Coverage |",
            "|-----------|---------|-------|----------|",
          );
          for (const d of result.byDirectory) {
            lines.push(
              `| ${d.directory} | ${d.covered} | ${d.totalExported} | ${d.coveragePercent.toFixed(0)}% |`,
            );
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_hubs ─────────────────────────────────────────────────
  server.tool(
    "cari_hubs",
    `Rank entities by degree centrality across all edge types (annotations, imports, co-occurrences, co-changes). God nodes are entities everything connects through — highest architectural risk and documentation priority.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum hubs to return"),
    },
    async (args) => {
      log(`cari_hubs: limit=${args.limit}`);
      try {
        const { hubs } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = hubs(dbPath);

        if (result.hubs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No hub data available. Ensure the index is built.",
              },
            ],
          };
        }

        const items = result.hubs.slice(0, args.limit ?? 20);
        const lines = [
          `## Top ${items.length} Hubs (God-Node Analysis)`,
          "",
          "| Entity | Kind | Annotations | Imports | Co-occurrences | Co-changes | Total |",
          "|--------|------|------------|---------|----------------|------------|-------|",
          ...items.map(
            (h) =>
              `| ${h.name} | ${h.kind} | ${h.annotationDegree} | ${h.importDegree} | ${h.coOccurrenceDegree} | ${h.coChangeDegree} | **${h.totalDegree}** |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_communities ──────────────────────────────────────────
  server.tool(
    "cari_communities",
    `Detect natural module clusters via label propagation. Three modes offer different views:
- 'structural' (default): imports + co-changes + file co-occurrences → architectural modules
- 'semantic': full co-occurrence graph → conceptual/topic clusters
- 'temporal': co-change edges only → files that evolve together

Use 'resolution' to control granularity: higher values (2–5) produce more, smaller communities.
Communities larger than 'maxSize' (default 100) are recursively sub-split.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      mode: z
        .enum(["structural", "semantic", "temporal"])
        .optional()
        .describe(
          "Graph mode: structural (architecture), semantic (concepts), temporal (evolution). Default: structural",
        ),
      resolution: z
        .number()
        .optional()
        .describe(
          "Community granularity (default 1.0). Higher → more, smaller communities",
        ),
      maxSize: z
        .number()
        .optional()
        .describe(
          "Max community size before recursive sub-splitting (default 100)",
        ),
    },
    async (params) => {
      log("cari_communities");
      try {
        const { communities } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = communities(dbPath, {
          mode: params.mode,
          resolution: params.resolution,
          maxSize: params.maxSize,
        });

        if (result.communities.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No communities detected. Ensure the index has co-occurrence or import data.",
              },
            ],
          };
        }

        const lines = [
          `## ${result.totalCommunities} Communities Detected (${result.totalNodes} nodes)`,
          "",
        ];

        for (const c of result.communities) {
          lines.push(`### Community ${c.id}: ${c.label} (${c.size} members)`);
          lines.push("");
          const display = c.members.slice(0, 15);
          for (const m of display) {
            lines.push(
              `- **${m.name}**${m.kind !== "unknown" ? ` [${m.kind}]` : ""}`,
            );
          }
          if (c.members.length > 15) {
            lines.push(`- _…and ${c.members.length - 15} more_`);
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_surprises ────────────────────────────────────────────
  server.tool(
    "cari_surprises",
    `Rank connections by composite surprise score — cross-layer weight (code↔doc), community distance, and inverse frequency. Finds unexpected couplings in your codebase.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum surprising connections to return"),
    },
    async (args) => {
      log(`cari_surprises: limit=${args.limit}`);
      try {
        const { surprises } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = surprises(dbPath);

        if (result.surprises.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No surprising connections found. Ensure the index has edges.",
              },
            ],
          };
        }

        const items = result.surprises.slice(0, args.limit ?? 20);
        const lines = [
          `## Top ${items.length} Surprising Connections (of ${result.totalEvaluated} evaluated)`,
          "",
          "| Entity A | Entity B | Score | Reason |",
          "|----------|----------|-------|--------|",
          ...items.map(
            (s) => `| ${s.entityA} | ${s.entityB} | ${s.score} | ${s.reason} |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_rationale ────────────────────────────────────────────
  server.tool(
    "cari_rationale",
    `List WHY/NOTE/IMPORTANT/DESIGN rationale comments found in the codebase. Not just what the code does — why it was written that way.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      kind: z
        .string()
        .optional()
        .describe(
          "Filter by kind: WHY, NOTE, IMPORTANT, or DESIGN (omit for all)",
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum results to return"),
    },
    async (args) => {
      log(`cari_rationale: kind=${args.kind ?? "all"} limit=${args.limit}`);
      try {
        const { rationale } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = rationale(dbPath);

        let items = result.rationale;
        if (args.kind) {
          items = items.filter(
            (r) => r.kind.toLowerCase() === args.kind!.toLowerCase(),
          );
        }
        const limited = items.slice(0, args.limit ?? 50);

        if (limited.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: args.kind
                  ? `No ${args.kind} rationale comments found.`
                  : "No WHY/NOTE/IMPORTANT/DESIGN rationale comments found.",
              },
            ],
          };
        }

        const kindSummary = Object.entries(result.byKind)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        const lines = [
          `## ${result.totalCount} Rationale Comments (${kindSummary})`,
          "",
          "| File | Line | Kind | Text |",
          "|------|------|------|------|",
          ...limited.map(
            (r) =>
              `| ${r.filePath} | ${r.line} | ${r.kind.toUpperCase()} | ${r.text} |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_terminology ──────────────────────────────────────────
  server.tool(
    "cari_terminology",
    `Detect terminology inconsistencies — when docs use different names for the same code symbol (e.g., "auth service", "AuthService", "authentication module" all referring to the same class). Suggests the canonical name for each entity.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum inconsistencies to return"),
    },
    async (args) => {
      log(`cari_terminology: limit=${args.limit}`);
      try {
        const { terminologyInconsistency } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = terminologyInconsistency(dbPath);

        if (result.totalInconsistencies === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No terminology inconsistencies found (${result.totalAnalyzed} entities analyzed).`,
              },
            ],
          };
        }

        const items = result.inconsistencies.slice(0, args.limit ?? 20);
        const lines = [
          `## ${result.totalInconsistencies} Terminology Inconsistencies (${result.totalAnalyzed} entities analyzed)`,
          "",
        ];

        for (const inc of items) {
          lines.push(
            `### ${inc.symbolName} _(${inc.kind})_ — ${inc.severity} — consistency: ${Math.round(inc.consistency * 100)}%`,
          );
          lines.push(`File: \`${inc.filePath}\``);
          lines.push("");
          lines.push("| Variant | Count | Avg Confidence | Documents |");
          lines.push("|---------|-------|----------------|-----------|");
          for (const v of inc.variants) {
            const canonical = v.text === inc.symbolName ? " ✓" : "";
            lines.push(
              `| ${v.text}${canonical} | ${v.count} | ${v.avgConfidence} | ${v.docPaths.join(", ")} |`,
            );
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_dep_depth ──────────────────────────────────────────
  server.tool(
    "cari_dep_depth",
    `Compute transitive import depth per file — flag excessive fan-in (many dependents) or fan-out (many dependencies). Helps identify god-modules, fragile bottlenecks, and deeply-chained imports.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum files to return"),
    },
    async (args) => {
      log(`cari_dep_depth: limit=${args.limit}`);
      try {
        const { dependencyDepth } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = dependencyDepth(dbPath);

        if (result.totalFiles === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No import graph data available. Ensure the index is built.",
              },
            ],
          };
        }

        const items = result.files.slice(0, args.limit ?? 20);
        const lines = [
          `## Dependency Depth — ${result.totalFiles} files (${result.highRiskCount} high/critical risk)`,
          "",
          "| File | Dir Deps | Trans Deps | Dir In | Trans In | Depth | Risk |",
          "|------|----------|------------|--------|----------|-------|------|",
        ];

        for (const f of items) {
          lines.push(
            `| ${f.filePath} | ${f.directDependencies} | ${f.transitiveDependencies} | ${f.directDependents} | ${f.transitiveDependents} | ${f.maxDepth} | ${f.risk} |`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_boundary_violations ──────────────────────────────────
  server.tool(
    "cari_boundary_violations",
    `Detect when files import from another package's internal modules instead of using the public API (index barrel). Finds cross-package coupling violations in monorepos.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_boundary_violations");
      try {
        const { boundaryViolations } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = boundaryViolations(dbPath);

        if (result.totalViolations === 0) {
          return {
            content: [
              {
                type: "text",
                text: "✓ No package boundary violations detected.",
              },
            ],
          };
        }

        const lines = [
          `## ${result.totalViolations} Package Boundary Violation${result.totalViolations === 1 ? "" : "s"}`,
          "",
        ];

        if (result.byPackagePair.length > 0) {
          lines.push("### By package pair");
          lines.push("| Source Package | Target Package | Count |");
          lines.push("|---------------|----------------|-------|");
          for (const pair of result.byPackagePair) {
            lines.push(
              `| ${pair.sourcePackage} | ${pair.targetPackage} | ${pair.count} |`,
            );
          }
          lines.push("");
        }

        lines.push("### Details");
        lines.push("| Source | Target | Reason |");
        lines.push("|--------|--------|--------|");
        for (const v of result.violations) {
          lines.push(`| ${v.sourceFile} | ${v.targetFile} | ${v.reason} |`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_layers_infer ───────────────────────────────────────────
  server.tool(
    "cari_layers_infer",
    `Auto-infer architectural layers from the import graph using topological depth analysis. Files with no outgoing imports form the foundation layer; files that only import from the foundation form the next layer, and so on. Returns 2–7 layers with auto-generated labels and a YAML config suitable for layers-check.

Supports three modes:
- **flat** (default): single-level inference across all files
- **hierarchical**: two-level inference — macro layers across packages, sub-layers within large packages
- **scoped**: infer layers within a single package/directory

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      hierarchical: z
        .boolean()
        .optional()
        .describe(
          "Enable two-level hierarchical inference: macro layers across packages, sub-layers within large packages.",
        ),
      scope: z
        .string()
        .optional()
        .describe(
          "Scope inference to files under this path prefix (e.g. 'packages/core'). Runs flat inference on the subgraph.",
        ),
      minFilesForSubLayers: z
        .number()
        .optional()
        .describe(
          "Minimum files in a package to compute sub-layers (default: 10). Only used with hierarchical mode.",
        ),
    },
    async (args: {
      hierarchical?: boolean;
      scope?: string;
      minFilesForSubLayers?: number;
    }) => {
      log("cari_layers_infer");
      try {
        const { layersInfer } = await loadIndex();
        const dbPath = resolveIndexDb();
        const options: Record<string, unknown> = {};
        if (args.hierarchical) options.hierarchical = true;
        if (args.scope) options.scope = args.scope;
        if (args.minFilesForSubLayers != null)
          options.minFilesForSubLayers = args.minFilesForSubLayers;
        const result = layersInfer(
          dbPath,
          Object.keys(options).length > 0 ? options : undefined,
        );

        if (result.layers.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No import relationships found — cannot infer layers.",
              },
            ],
          };
        }

        const mode = args.hierarchical
          ? "hierarchical"
          : args.scope
            ? `scoped (${args.scope})`
            : "flat";
        const lines = [
          `## ${result.layers.length} Inferred Architectural Layers — ${mode} (${result.totalFiles} files)`,
          "",
          "| # | Label | Files | Depth Range |",
          "|---|-------|-------|-------------|",
        ];
        for (const layer of result.layers) {
          const pkgInfo =
            layer.packages && layer.packages.length > 0
              ? ` (${layer.packages.join(", ")})`
              : "";
          lines.push(
            `| ${layer.index} | ${layer.label}${pkgInfo} | ${layer.files.length} | ${layer.depthRange[0]}–${layer.depthRange[1]} |`,
          );

          // Show sub-layers if present
          if (layer.subLayers && layer.subLayers.length > 0) {
            for (const sub of layer.subLayers) {
              lines.push(
                `|   | ↳ ${sub.package}/${sub.label} | ${sub.files.length} | ${sub.depthRange[0]}–${sub.depthRange[1]} |`,
              );
            }
          }
        }

        if (result.isolatedFiles.length > 0) {
          lines.push("");
          lines.push(
            `_${result.isolatedFiles.length} isolated file(s) with no imports placed in foundation layer._`,
          );
        }

        lines.push("");
        lines.push("### Generated layers.yaml");
        lines.push("```yaml");
        lines.push(result.yaml.trim());
        lines.push("```");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_layers_check ─────────────────────────────────────────
  server.tool(
    "cari_layers_check",
    `Validate imports against a committed layer configuration. Detects two violation types: (1) reverse — a lower layer importing from a higher layer, and (2) skip-layer — an import that skips one or more intermediate layers. Reads the layer config from .iw/layers.yaml by default.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      allowSkipLayer: z
        .boolean()
        .optional()
        .describe(
          "If true, skip-layer violations are suppressed (only reverse violations reported). Default: false.",
        ),
    },
    async (args: { allowSkipLayer?: boolean }) => {
      log("cari_layers_check");
      try {
        const { layersCheck } = await loadIndex();
        const dbPath = resolveIndexDb();

        // Read layers.yaml from workspace
        const fs = await import("node:fs");
        const path = await import("node:path");
        const configPath = path.join(process.cwd(), ".iw", "layers.yaml");

        if (!fs.existsSync(configPath)) {
          return {
            content: [
              {
                type: "text",
                text: "No .iw/layers.yaml found. Run `cari_layers_infer` first to generate a layer config, then save it to .iw/layers.yaml.",
              },
            ],
          };
        }

        const content = fs.readFileSync(configPath, "utf-8");
        const config = parseLayersYamlForMcp(content);
        if (args.allowSkipLayer) {
          config.allowSkipLayer = true;
        }

        const result = layersCheck(dbPath, config);

        if (result.totalViolations === 0) {
          const lines = [
            "✓ No layer violations detected.",
            "",
            "### Layer Summary",
            "| Layer | Index | Files |",
            "|-------|-------|-------|",
          ];
          for (const s of result.layerSummary) {
            lines.push(`| ${s.name} | ${s.index} | ${s.fileCount} |`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        const lines = [
          `## ${result.totalViolations} Layer Violation${result.totalViolations === 1 ? "" : "s"}`,
          "",
        ];

        if (result.byType.reverse > 0 || result.byType.skipLayer > 0) {
          lines.push(
            `- **Reverse**: ${result.byType.reverse} (lower layer imports higher)`,
          );
          lines.push(
            `- **Skip-layer**: ${result.byType.skipLayer} (skips intermediate layers)`,
          );
          lines.push("");
        }

        lines.push(
          "| Source | Source Layer | Target | Target Layer | Type | Reason |",
        );
        lines.push(
          "|--------|-------------|--------|--------------|------|--------|",
        );
        for (const v of result.violations) {
          lines.push(
            `| ${v.sourceFile} | ${v.sourceLayer} | ${v.targetFile} | ${v.targetLayer} | ${v.type} | ${v.reason} |`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_layers_name ──────────────────────────────────────────
  server.tool(
    "cari_layers_name",
    `Generate descriptive architectural layer names using an LLM (5.1c). Takes the output of layersInfer and produces human-friendly names like "HTTP Layer", "Data Access", "Core Types" instead of directory-based labels.

Requires an OpenAI API key (OPENAI_API_KEY env var or api_key parameter).`,
    {
      provider: z
        .enum(["openai", "smart-mock"])
        .default("openai")
        .describe(
          "LLM provider. Use 'openai' for real naming or 'smart-mock' for testing.",
        ),
      model: z
        .string()
        .default("gpt-4o-mini")
        .describe("Model name for the LLM provider."),
      api_key: z
        .string()
        .optional()
        .describe(
          "OpenAI API key. Falls back to OPENAI_API_KEY env var if not provided.",
        ),
    },
    async (args) => {
      log("cari_layers_name");
      try {
        const { layersInfer, nameLayers } = await loadIndex();
        const dbPath = resolveIndexDb();
        const layers = layersInfer(dbPath);

        if (layers.layers.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No layers inferred — cannot generate names.",
              },
            ],
          };
        }

        const { OpenAILLMProvider, SmartMockLLMProvider } =
          await import("@intentweave/analyzer/llm");
        let llm;
        if (args.provider === "openai") {
          const apiKey = args.api_key ?? process.env.OPENAI_API_KEY;
          if (!apiKey) {
            return {
              content: [
                {
                  type: "text",
                  text: "OpenAI API key required. Set OPENAI_API_KEY env var or pass api_key parameter.",
                },
              ],
              isError: true,
            };
          }
          llm = new OpenAILLMProvider({ apiKey, model: args.model });
        } else {
          llm = new SmartMockLLMProvider({ workspaceKey: "mcp" });
        }

        const result = await nameLayers(layers, llm);

        const lines = [
          `## Layer Names (${result.layers.length} layers, ${result.tokensUsed.prompt + result.tokensUsed.completion} tokens, ${result.latencyMs}ms)`,
          "",
          "| # | Heuristic Label | LLM Name | Description |",
          "|---|-----------------|----------|-------------|",
        ];
        for (const l of result.layers) {
          lines.push(
            `| ${l.index} | ${l.heuristicLabel} | **${l.name}** | ${l.description} |`,
          );
        }

        if (result.directories.length > 0) {
          lines.push(
            "",
            `## Directory Names (${result.directories.length} directories)`,
            "",
            "| Directory | LLM Name | Description |",
            "|-----------|----------|-------------|",
          );
          for (const d of result.directories) {
            lines.push(`| ${d.path} | **${d.name}** | ${d.description} |`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_slices ───────────────────────────────────────────────
  server.tool(
    "cari_slices",
    `Detect vertical slices — communities that span multiple architectural layers end-to-end. A vertical slice is a feature cohort (e.g., "auth") that cuts through foundation, core, interface, and entry layers. Communities spanning only 1–2 layers are horizontal modules.

No LLM or Neo4j needed — pure SQLite analysis on the CARI index.`,
    {
      minLayers: z
        .number()
        .optional()
        .default(3)
        .describe(
          "Minimum layers a community must span to be classified as a vertical slice (default: 3)",
        ),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of vertical slices to return"),
    },
    async (args) => {
      log(`cari_slices: minLayers=${args.minLayers}, limit=${args.limit}`);
      try {
        const { slices } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = slices(dbPath, {
          minLayers: args.minLayers,
          limit: args.limit,
        });

        if (
          result.slices.length === 0 &&
          result.horizontal.length === 0
        ) {
          return {
            content: [
              {
                type: "text",
                text: "No slices detected. The index may not have enough community or layer data.",
              },
            ],
          };
        }

        const lines: string[] = [
          `## Vertical Slice Detection`,
          "",
          `**${result.totalLayers} layers, ${result.totalCommunities} communities analysed**`,
          "",
        ];

        if (result.slices.length > 0) {
          lines.push(
            `### ${result.slices.length} Vertical Slice${result.slices.length === 1 ? "" : "s"} (spanning ≥${args.minLayers ?? 3} layers)`,
            "",
          );
          for (const s of result.slices) {
            lines.push(
              `#### ${s.label} — ${s.totalFiles} files across ${s.layerSpan} layers`,
              "",
            );
            for (const layerIdx of [...s.layers].sort((a, b) => b - a)) {
              const files = s.filesByLayer[layerIdx] || [];
              lines.push(
                `- **Layer ${layerIdx}**: ${files.map((f) => f.split("/").pop()).join(", ")}`,
              );
            }
            lines.push("");
          }
        }

        if (result.horizontal.length > 0) {
          lines.push(
            `### ${result.horizontal.length} Horizontal Module${result.horizontal.length === 1 ? "" : "s"} (1–2 layers)`,
            "",
            "| Community | Files | Layers |",
            "|-----------|-------|--------|",
          );
          for (const h of result.horizontal.slice(0, 15)) {
            lines.push(
              `| ${h.label} | ${h.totalFiles} | ${h.layers.join(", ")} |`,
            );
          }
          if (result.horizontal.length > 15) {
            lines.push(
              `| ... | +${result.horizontal.length - 15} more | |`,
            );
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Connect via stdio ───────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server running (stdio transport). Waiting for messages…");
}
