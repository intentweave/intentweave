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
 *   - cari_resolve:          Ground a diagram component name to code symbols + doc files
 *   - cari_arch_diff:        Validate diagram flows against entity evidence (annotations + co-occurrences)
 *   - cari_component_evidence: All CARI evidence for a single architecture component
 *   - cari_living_score:     Composite living documentation score (12.3): spec + consistency + freshness + arch
 *   - cari_cypher:           CypherLite query over the full CARI graph projection (FILE/SYMBOL/DOCSPAN + CALLS/DEFINES/CO_CHANGES/…)
 *   - cari_graph_schema:     Return node labels, relationship types, property names + all built-in templates
 *
 * Usage:
 *   iw mcp --session <id>             # start stdio MCP server
 *   iw mcp --session <id> --verbose   # log activity to stderr
 */

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPluginRegistry } from "@intentweave/core";
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
  preflightDocHealth,
  formatPreflightForAgent,
} from "../doc-health/index.js";
import {
  createGraphRunner,
  hasPersistence,
} from "../persistence/graphRunner.js";

// =============================================================================
// LLM helper (for NL → Cypher translation)
// =============================================================================

async function llmComplete(
  system: string,
  userMessage: string,
): Promise<string> {
  const { OpenAILLMProvider } = await import("@intentweave/plugin-llm");
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

  const runner = createGraphRunner();
  const rows = await runner.run(cypherQuery);
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
  const runner = createGraphRunner();

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

  const runner = createGraphRunner();
  const rows = await runner.run(cypher, params);
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
  const cwd = process.cwd();
  const targets = args.files && args.files.length > 0 ? args.files : [cwd];
  const result = await preflightDocHealth({ files: targets, cwd });
  return formatPreflightForAgent(result);
}

async function toolImpact(_args: {
  files: string[];
  session_id: string;
  hops: number;
}): Promise<string> {
  return "Impact analysis via Neo4j is not available in this build. Use `cari_check` or `cari_connections` for CARI-based impact analysis.";
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

function handleCariError(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as any).message === "string"
  ) {
    const msg = (err as any).message;
    if (msg.includes("SQLITE_CANTOPEN") || msg.includes("does not exist")) {
      return "CARI index not found. Run `iw index build` first to create .iw/index.db.";
    }
    return `Error: ${msg}`;
  }
  return `Error: ${String(err)}`;
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

  /**
   * Opt-in local session log (`.iw/config.yaml` → `sessionLog: true`).
   * Reads the workspace config fresh on each call (cheap, and config may
   * change between tool invocations within a long-running MCP server).
   */
  async function logMcpSessionEvent(input: {
    tool: string;
    confidence?: number;
    resultCount?: number;
  }): Promise<void> {
    const { logSessionEvent } = await loadIndex();
    let sessionLogEnabled = false;
    try {
      const { readFile } = await import("node:fs/promises");
      const { load: yamlLoad } = await import("js-yaml");
      const raw = await readFile(
        path.join(process.cwd(), ".iw", "config.yaml"),
        "utf-8",
      );
      const parsed = yamlLoad(raw) as
        | import("@intentweave/index").IwConfig
        | undefined;
      sessionLogEnabled =
        !!parsed && typeof parsed === "object" && parsed.sessionLog === true;
    } catch {
      // No config file, or unreadable — session logging stays disabled.
    }
    await logSessionEvent({
      enabled: sessionLogEnabled,
      workspaceRoot: process.cwd(),
      surface: "mcp",
      tool: input.tool,
      sessionId,
      confidence: input.confidence,
      resultCount: input.resultCount,
    });
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

        await logMcpSessionEvent({
          tool: "cari_retrieve",
          confidence: result.files[0]?.score,
          resultCount: result.files.length,
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

        await logMcpSessionEvent({
          tool: "cari_connections",
          confidence: result.connections[0]?.sources[0]?.score,
          resultCount: result.connections.length,
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

        await logMcpSessionEvent({
          tool: "cari_check",
          // CheckFinding carries a severity, not a numeric confidence.
          resultCount: result.findings.length,
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
    {
      layerAnalysis: z
        .boolean()
        .optional()
        .describe(
          "Annotate each clone group with inferred layer context, classifying groups as DRY violations (within-layer) or architectural violations (cross-layer reimplementations). Default: false.",
        ),
    },
    async (args) => {
      log("cari_clones");
      try {
        const { clones } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = clones(dbPath, { layerAnalysis: args.layerAnalysis });

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
          const la = group.layerAnalysis;
          const layerBadge = la
            ? la.kind === "architectural"
              ? ` 🔴 ARCHITECTURAL VIOLATION (layers ${la.uniqueLayers.join(", ")})`
              : la.kind === "dry"
                ? ` 🟡 DRY VIOLATION (layer ${la.uniqueLayers[0]})`
                : ""
            : "";
          lines.push(
            `### Clone group (${group.bodyLines} lines, ${group.symbols.length} copies)${layerBadge}`,
            "",
            "| Symbol | File | Line | Kind | Layer |",
            "|--------|------|------|------|-------|",
          );
          for (let i = 0; i < group.symbols.length; i++) {
            const s = group.symbols[i];
            const layerCell =
              la && la.layers[i] !== undefined && la.layers[i] >= 0
                ? String(la.layers[i])
                : "—";
            lines.push(
              `| ${s.name} | ${s.filePath} | ${s.line} | ${s.kind} | ${layerCell} |`,
            );
          }
          if (la && la.suggestion) {
            lines.push("", `> ${la.suggestion}`);
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
    {
      layerAnalysis: z
        .boolean()
        .optional()
        .describe(
          "Annotate each clone group with inferred layer context, classifying groups as DRY violations (within-layer) or architectural violations (cross-layer reimplementations). Default: false.",
        ),
    },
    async (args) => {
      log("cari_structural_clones");
      try {
        const { structuralClones } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = structuralClones(dbPath, {
          layerAnalysis: args.layerAnalysis,
        });

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
          const la = group.layerAnalysis;
          const layerBadge = la
            ? la.kind === "architectural"
              ? ` 🔴 ARCHITECTURAL VIOLATION (layers ${la.uniqueLayers.join(", ")})`
              : la.kind === "dry"
                ? ` 🟡 DRY VIOLATION (layer ${la.uniqueLayers[0]})`
                : ""
            : "";
          lines.push(
            `### Clone group (${group.bodyLines} lines, ${group.symbols.length} copies)${layerBadge}`,
            "",
            "| Symbol | File | Line | Kind | Layer |",
            "|--------|------|------|------|-------|",
          );
          for (let i = 0; i < group.symbols.length; i++) {
            const s = group.symbols[i];
            const layerCell =
              la && la.layers[i] !== undefined && la.layers[i] >= 0
                ? String(la.layers[i])
                : "—";
            lines.push(
              `| ${s.name} | ${s.filePath} | ${s.line} | ${s.kind} | ${layerCell} |`,
            );
          }
          if (la && la.suggestion) {
            lines.push("", `> ${la.suggestion}`);
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
      preset: z
        .enum(["fixme-only", "hacks-only", "xxx-only", "blocking", "all-kinds"])
        .optional()
        .describe(
          "Named filter preset: fixme-only | hacks-only | xxx-only | blocking | all-kinds. Overrides kind.",
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum results to return"),
    },
    async (args) => {
      const TODO_PRESET_KINDS: Record<string, string | undefined> = {
        "fixme-only": "FIXME",
        "hacks-only": "HACK",
        "xxx-only": "XXX",
        blocking: "FIXME",
        "all-kinds": undefined,
      };
      const resolvedKind = args.preset
        ? TODO_PRESET_KINDS[args.preset]
        : args.kind;
      log(`cari_todos: kind=${resolvedKind ?? "all"} limit=${args.limit}`);
      try {
        const { todos } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = todos(dbPath);

        let items = result.todos;
        if (resolvedKind) {
          items = items.filter(
            (t) => t.kind.toLowerCase() === resolvedKind.toLowerCase(),
          );
        }
        const limited = items.slice(0, args.limit ?? 50);

        if (limited.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: resolvedKind
                  ? `No ${resolvedKind} comments found.`
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

  // ── Tool: cari_naming_violations ────────────────────────────────
  server.tool(
    "cari_naming_violations",
    `List code symbols that violate standard naming conventions (camelCase for functions/methods, PascalCase for classes/interfaces/types, UPPER_SNAKE for constants). Skips $-prefixed names (JSON Schema convention), snake_case properties (external data/DB convention), and quoted names.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      kind: z
        .string()
        .optional()
        .describe(
          "Filter by symbol kind: function, class, method, type, interface, etc.",
        ),
      exportedOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Only check exported symbols (reduces noise from internal helpers)",
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum results to return"),
    },
    async (args) => {
      log(
        `cari_naming_violations: kind=${args.kind ?? "all"} exportedOnly=${args.exportedOnly} limit=${args.limit}`,
      );
      try {
        const { namingViolations } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = namingViolations(dbPath, {
          exportedOnly: args.exportedOnly,
        });

        let items = result.violations;
        if (args.kind) {
          items = items.filter(
            (v) => v.kind.toLowerCase() === args.kind!.toLowerCase(),
          );
        }
        const limited = items.slice(0, args.limit ?? 50);

        if (limited.length === 0) {
          return {
            content: [
              { type: "text", text: "No naming convention violations found." },
            ],
          };
        }

        const kindSummary = Object.entries(result.byKind)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");

        const lines = [
          `## Naming Violations — ${result.totalViolations} total (${kindSummary})`,
          "",
          "| Kind | Name | Expected | File | Line |",
          "|------|------|----------|------|------|",
          ...limited.map(
            (v) =>
              `| ${v.kind} | \`${v.name}\` | ${v.expected} | ${v.filePath} | ${v.line} |`,
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

  // ── Tool: cari_comment_code_ratio ───────────────────────────────
  server.tool(
    "cari_comment_code_ratio",
    `Show comment-to-code ratio anomalies for indexed source files. Flags under-commented files (ratio far below workspace average) and over-commented files.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      showAll: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, return all files instead of just anomalies"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum results to return"),
    },
    async (args) => {
      log(
        `cari_comment_code_ratio: showAll=${args.showAll} limit=${args.limit}`,
      );
      try {
        const { commentCodeRatio } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = commentCodeRatio(dbPath);

        const items = (args.showAll ? result.files : result.anomalies).slice(
          0,
          args.limit ?? 50,
        );

        if (items.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: args.showAll
                  ? "No files with comment data found."
                  : "No comment-to-code ratio anomalies found.",
              },
            ],
          };
        }

        const lines = [
          `## Comment-to-Code Ratio — ${args.showAll ? `${result.totalFiles} files` : `${result.anomalies.length} anomalies`} (avg: ${result.averageRatio.toFixed(3)})`,
          "",
          "| File | Comments | Code | Ratio | Status |",
          "|------|----------|------|-------|--------|",
          ...items.map(
            (f) =>
              `| ${f.filePath} | ${f.commentLines} | ${f.codeLines} | ${f.ratio.toFixed(3)} | ${f.anomaly ?? "ok"} |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_skipped_files ────────────────────────────────────
  server.tool(
    "cari_skipped_files",
    `List source files that were skipped during AX extraction, typically because they exceeded the --max-file-size threshold. These files have no extracted symbols in the index.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {},
    async () => {
      log("cari_skipped_files");
      try {
        const { skippedFiles } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = skippedFiles(dbPath);

        if (result.totalSkipped === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No files were skipped during AX extraction.",
              },
            ],
          };
        }

        const lines = [
          `## Skipped Files — ${result.totalSkipped} file(s) skipped`,
          "",
          "_These files were not indexed. Use `iw index build --max-file-size` to adjust the threshold._",
          "",
          "| File | Reason |",
          "|------|--------|",
          ...result.skipped.map((f) => `| ${f.filePath} | ${f.reason} |`),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_rules_check ───────────────────────────────────────
  server.tool(
    "cari_rules_check",
    `Check the codebase against semantic architectural rules from .iw/rules.yaml (13.2/13.3).

Detects violations of custom architectural constraints — property access patterns (e.g. entity.source.path), forbidden function calls, symbol naming patterns, and import patterns.

Rules are defined in a .iw/rules.yaml file committed to the workspace. Each rule references an ADR and specifies which patterns are forbidden in which files.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      severity: z
        .enum(["high", "medium", "low"])
        .optional()
        .default("low")
        .describe("Minimum severity to report (default: low = all violations)"),
      ruleId: z
        .string()
        .optional()
        .describe("Check only this specific rule ID"),
      changed: z
        .array(z.string())
        .optional()
        .describe(
          "Only check violations in these changed files (incremental CI mode)",
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum violations to return"),
      domain: z
        .enum(["structural", "behavioral", "documentary", "all"])
        .optional()
        .describe(
          "Intent domain to check: structural (rules.yaml), behavioral, documentary (built-in CARI checks), or all",
        ),
    },
    async (args) => {
      log(
        `cari_rules_check: severity=${args.severity} ruleId=${args.ruleId ?? "all"} changed=${args.changed?.length ?? 0} files`,
      );
      try {
        const { rulesCheck } = await loadIndex();
        const { load: yamlLoadMcp } = await import("js-yaml");
        const { readFile } = await import("node:fs/promises");
        const dbPath = resolveIndexDb();

        const configPath = path.join(process.cwd(), ".iw", "rules.yaml");
        let rawYaml: string;
        try {
          rawYaml = await readFile(configPath, "utf-8");
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `No .iw/rules.yaml found at ${configPath}.\n\nCreate this file to define architectural rules. See IntentWeave SEMANTIC-RULES-SPEC.md for the format.`,
              },
            ],
          };
        }

        const config = yamlLoadMcp(
          rawYaml,
        ) as import("@intentweave/index").RulesConfig;
        if (!config || !Array.isArray(config.rules)) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid rules.yaml format — must have a top-level `rules` array.",
              },
            ],
            isError: true,
          };
        }

        const result = rulesCheck(dbPath, config, {
          severity: args.severity as "high" | "medium" | "low",
          ruleId: args.ruleId,
          changed: args.changed,
          limit: args.limit ?? 50,
          domain: args.domain as
            | "structural"
            | "behavioral"
            | "documentary"
            | "all"
            | undefined,
          workspaceRoot: process.cwd(),
        });

        if (result.violations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No semantic rule violations found. (${result.rulesChecked} rule(s) checked)`,
              },
            ],
          };
        }

        const severityCounts = Object.entries(result.bySeverity)
          .filter(([, n]) => n > 0)
          .map(([sev, n]) => `${sev}: ${n}`)
          .join(", ");

        const lines = [
          `## Semantic Rule Violations — ${result.totalViolations} total (${severityCounts})`,
          "",
          "| Rule | Severity | File | Line | Detail |",
          "|------|----------|------|------|--------|",
          ...result.violations.map(
            (v) =>
              `| ${v.ruleId} | ${v.ruleSeverity} | ${v.filePath} | ${v.line ?? "—"} | ${v.detail} |`,
          ),
        ];

        if (result.totalViolations > result.violations.length) {
          lines.push(
            "",
            `_Showing ${result.violations.length} of ${result.totalViolations} violations._`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: intent_check ────────────────────────────────────────────
  // Alias for cari_rules_check with domain as first-class parameter.
  // Preferred tool for Phase 1+ Intent Engine workflows.
  server.tool(
    "intent_check",
    `Check codebase intent conformance across structural, behavioral, and documentary domains.

Run rules from .iw/rules.yaml AND built-in CARI documentary checks in a single call.

Domain options:
- structural (default): rules.yaml structural rules (forbidden imports, naming, call patterns)
- behavioral: Mermaid diagram rules (sequence must_call/must_not_call, state transitions, flowchart must_precede)
- documentary: built-in checks — coverage, terminology, orphaned sections, doc completeness
- all: all three domains combined

Behavioral rules require a \`domain: behavioral\` rule in rules.yaml with a \`mermaid:\` key
(inline diagram) or \`source.type: mermaid_file\` pointing to an ADR markdown file.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      domain: z
        .enum(["structural", "behavioral", "documentary", "all"])
        .optional()
        .default("all")
        .describe(
          "Intent domain: structural | behavioral | documentary | all (default: all)",
        ),
      preset: z
        .enum([
          "ci-gate",
          "doc-review",
          "full-audit",
          "structural-only",
          "behavioral-only",
        ])
        .optional()
        .describe(
          "Named check preset — sets domain+severity: ci-gate | doc-review | full-audit | structural-only | behavioral-only",
        ),
      severity: z
        .enum(["high", "medium", "low"])
        .optional()
        .default("low")
        .describe("Minimum severity to report (overrides preset)"),
      ruleId: z
        .string()
        .optional()
        .describe("Only check this specific rule ID"),
      changed: z
        .array(z.string())
        .optional()
        .describe("Only check violations in these changed files"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum violations to return"),
    },
    async (args) => {
      // Resolve preset → domain + severity
      const INTENT_PRESET_MAP: Record<
        string,
        { domain: string; severity: string }
      > = {
        "ci-gate": { domain: "all", severity: "high" },
        "doc-review": { domain: "documentary", severity: "low" },
        "full-audit": { domain: "all", severity: "low" },
        "structural-only": { domain: "structural", severity: "low" },
        "behavioral-only": { domain: "behavioral", severity: "low" },
      };
      const presetVals = args.preset
        ? INTENT_PRESET_MAP[args.preset]
        : undefined;
      const resolvedDomain =
        args.domain !== "all" ? args.domain : (presetVals?.domain ?? "all");
      const resolvedSeverity =
        args.severity !== "low"
          ? args.severity
          : (presetVals?.severity ?? "low");
      log(
        `intent_check: domain=${resolvedDomain} severity=${resolvedSeverity} preset=${args.preset ?? "none"} ruleId=${args.ruleId ?? "all"}`,
      );
      try {
        const { rulesCheck } = await loadIndex();
        const { load: yamlLoadMcp } = await import("js-yaml");
        const { readFile } = await import("node:fs/promises");
        const dbPath = resolveIndexDb();
        const iwDir = path.join(process.cwd(), ".iw");

        const configPath = path.join(iwDir, "rules.yaml");
        let config: import("@intentweave/index").RulesConfig = {
          version: 1,
          rules: [],
        };
        try {
          const rawYaml = await readFile(configPath, "utf-8");
          const parsed = yamlLoadMcp(
            rawYaml,
          ) as import("@intentweave/index").RulesConfig;
          if (parsed && Array.isArray(parsed.rules)) {
            config = parsed;
          }
        } catch {
          // No rules.yaml — documentary domain will still run if requested
        }

        // Load optional .iw/config.yaml thresholds
        let iwConfig: import("@intentweave/index").IwConfig | undefined;
        try {
          const rawIwConfig = await readFile(
            path.join(iwDir, "config.yaml"),
            "utf-8",
          );
          const parsed = yamlLoadMcp(
            rawIwConfig,
          ) as import("@intentweave/index").IwConfig;
          if (parsed && typeof parsed === "object") iwConfig = parsed;
        } catch {
          // Optional — no config.yaml is fine
        }

        const result = rulesCheck(dbPath, config, {
          severity: resolvedSeverity as "high" | "medium" | "low",
          ruleId: args.ruleId,
          changed: args.changed,
          limit: args.limit ?? 50,
          domain: resolvedDomain as
            | "structural"
            | "behavioral"
            | "documentary"
            | "all",
          iwConfig,
          workspaceRoot: process.cwd(),
        });

        if (result.violations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No intent violations found. (${result.rulesChecked} rule(s) checked, domain: ${resolvedDomain}${args.preset ? ", preset: " + args.preset : ""})`,
              },
            ],
          };
        }

        const severityCounts = Object.entries(result.bySeverity)
          .filter(([, n]) => n > 0)
          .map(([sev, n]) => `${sev}: ${n}`)
          .join(", ");

        const domainLabel =
          resolvedDomain + (args.preset ? ` (preset: ${args.preset})` : "");
        const hasErrors = result.violations.some((v) => v.ruleMode === "error");
        const lines = [
          `## Intent Check Violations [domain: ${domainLabel}] — ${result.totalViolations} total (${severityCounts})`,
          hasErrors
            ? "_CI gate: **FAIL** (error-mode violations present)_"
            : "_CI gate: **PASS** (all violations are warn-only)_",
          "",
          "| Rule | Domain | Severity | Mode | Confidence | File | Line | Detail |",
          "|------|--------|----------|------|------------|------|------|--------|",
          ...result.violations.map(
            (v) =>
              `| ${v.ruleId} | ${v.ruleDomain} | ${v.ruleSeverity} | ${v.ruleMode} | ${v.confidence != null ? Math.round(v.confidence * 100) + "%" : "100%"} | ${v.filePath} | ${v.line ?? "—"} | ${v.detail} |`,
          ),
        ];

        if (result.totalViolations > result.violations.length) {
          lines.push(
            "",
            `_Showing ${result.violations.length} of ${result.totalViolations} violations._`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_deprecated_callers ────────────────────────────────
  server.tool(
    "cari_deprecated_callers",
    `Find active callers of @deprecated symbols (14.1).

Cross-references symbols marked @deprecated (in JSDoc) against all function call records to surface files that still use symbols that should be migrated. Use for CI enforcement or migration planning.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      changed: z
        .array(z.string())
        .optional()
        .describe(
          "Only check callers in these changed files (incremental CI mode)",
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum caller entries to return"),
    },
    async (args) => {
      log(
        `cari_deprecated_callers: changed=${args.changed?.length ?? 0} files`,
      );
      try {
        const { deprecatedCallers } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = deprecatedCallers(dbPath, {
          changed: args.changed,
          limit: args.limit ?? 50,
        });

        if (result.callers.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No active callers of @deprecated symbols. (${result.deprecatedSymbols} deprecated symbol(s) indexed)`,
              },
            ],
          };
        }

        const lines = [
          `## @deprecated Callers — ${result.totalCallers} caller(s) of ${result.symbolsWithCallers} deprecated symbol(s)`,
          "",
        ];

        for (const sym of result.callers) {
          const note = sym.deprecatedNote ? ` — _${sym.deprecatedNote}_` : "";
          lines.push(`### \`${sym.symbolName}\` [deprecated]${note}`);
          lines.push(`_Defined in: ${sym.symbolFile}:${sym.symbolLine}_`);
          lines.push("");
          lines.push("| Caller File | Line | Caller Function |");
          lines.push("|-------------|------|-----------------|");
          for (const c of sym.callers) {
            lines.push(
              `| ${c.callerFile} | ${c.callerLine ?? "—"} | ${c.callerName ?? "—"} |`,
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

  // ── Tool: cari_internal_violations ───────────────────────────────
  server.tool(
    "cari_internal_violations",
    `Detect @internal / _prefix symbols imported across package boundaries (14.2).

Enforces visibility conventions at scale: symbols tagged @internal in JSDoc or named with a leading underscore are flagged when imported by files in different packages.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      checkJsDoc: z
        .boolean()
        .optional()
        .default(true)
        .describe("Enforce @internal JSDoc tag violations"),
      checkUnderscore: z
        .boolean()
        .optional()
        .default(true)
        .describe("Enforce _prefix convention violations"),
      changed: z
        .array(z.string())
        .optional()
        .describe(
          "Only check violations in these changed files (incremental CI mode)",
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum violations to return"),
    },
    async (args) => {
      log(
        `cari_internal_violations: changed=${args.changed?.length ?? 0} files`,
      );
      try {
        const { internalViolations } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = internalViolations(dbPath, {
          checkJsDoc: args.checkJsDoc ?? true,
          checkUnderscore: args.checkUnderscore ?? true,
          changed: args.changed,
          limit: args.limit ?? 50,
        });

        if (result.violations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No @internal / _prefix boundary violations found.",
              },
            ],
          };
        }

        const jsdocCount = result.byMarker.jsdoc;
        const underscoreCount = result.byMarker.underscore;
        const summary = [
          jsdocCount > 0 ? `${jsdocCount} @internal` : null,
          underscoreCount > 0 ? `${underscoreCount} _prefix` : null,
        ]
          .filter(Boolean)
          .join(", ");

        const lines = [
          `## Internal Violations — ${result.totalViolations} violation(s) [${summary}]`,
          "",
          "| Symbol | Marker | Symbol File | Importer File | Packages |",
          "|--------|--------|-------------|---------------|----------|",
          ...result.violations.map(
            (v) =>
              `| \`${v.symbolName}\` | ${v.marker} | ${v.symbolFile}:${v.symbolLine} | ${v.importerFile} | ${v.symbolPackage} → ${v.importerPackage} |`,
          ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_type_assertions ──────────────────────────────────
  server.tool(
    "cari_type_assertions",
    `Inventory type assertion patterns: \`as any\`, double casts, and angle-bracket casts in the codebase.

Use this to find type-safety escape hatches and rank them by risk (files with high fan-in are higher risk).

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      kind: z
        .enum(["as_any", "double_cast", "angle_cast", "as_cast"])
        .optional()
        .describe("Filter by assertion kind"),
      riskSort: z
        .boolean()
        .optional()
        .describe("Sort by file fan-in (highest risk first)"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max results (default 100)"),
    },
    async (args) => {
      log(`cari_type_assertions: kind=${args.kind ?? "all"}`);
      try {
        const { typeAssertions } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = typeAssertions(dbPath, {
          kind: args.kind,
          riskSort: args.riskSort ?? false,
          limit: args.limit ?? 100,
        });

        if (result.total === 0) {
          return {
            content: [{ type: "text", text: "No type assertions found." }],
          };
        }

        const kindSummary = Object.entries(result.byKind)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}: ${n}`)
          .join("  ");

        const lines = [
          `## Type Assertions — ${result.total} total  [${kindSummary}]`,
          result.highRisk.length > 0
            ? `\n⚠️ High-risk (high fan-in): ${result.highRisk.length}`
            : "",
          "",
          "| File | Line | Kind | Target Type | Context | Fan-in |",
          "|------|------|------|-------------|---------|--------|",
          ...result.assertions
            .slice(0, args.limit ?? 100)
            .map(
              (a) =>
                `| ${a.file} | ${a.line} | \`${a.kind}\` | ${a.targetType ?? ""} | ${a.context ?? ""} | ${a.fanIn ?? 0} |`,
            ),
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_test_intent ──────────────────────────────────────
  server.tool(
    "cari_test_intent",
    `Find stale test descriptions and orphaned test files by checking if test description mentions correspond to code symbols.

Scans all test descriptions (from describe/it/test blocks) and identifies:
- **Stale tests**: descriptions mention symbols that no longer exist in the codebase
- **Orphaned files**: test files with zero matches to any code symbol

Useful for finding outdated tests that may need cleanup or updating.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max results (default 50)"),
    },
    async (args) => {
      log(`cari_test_intent: limit=${args.limit ?? 50}`);
      try {
        const { testIntent } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = testIntent(dbPath, {
          limit: args.limit ?? 50,
        });

        if (result.staleCount === 0 && result.orphanedFiles.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "✓ No stale test descriptions or orphaned test files found.",
              },
            ],
          };
        }

        const lines = [
          `## Test Intent Analysis — ${result.total} test description(s) analyzed`,
        ];

        if (result.staleCount > 0) {
          lines.push(`\n### Stale Test Descriptions (${result.staleCount})\n`);
          lines.push("| File | Line | Kind | Description | Missing Symbol |");
          lines.push("|------|------|------|-------------|-----------------|");
          for (const test of result.staleTests.slice(0, args.limit ?? 50)) {
            lines.push(
              `| ${test.file} | ${test.line} | \`${test.kind}\` | "${test.description}" | \`${test.missingSymbol}\` |`,
            );
          }
        }

        if (result.orphanedFiles.length > 0) {
          lines.push(
            `\n### Orphaned Test Files (${result.orphanedFiles.length})\n`,
          );
          lines.push("| File |");
          lines.push("|------|");
          for (const file of result.orphanedFiles) {
            lines.push(`| ${file} |`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_rules_trend ──────────────────────────────────────
  server.tool(
    "cari_rules_trend",
    `Show ADR conformance trend over time from historical snapshots.

Snapshots are recorded automatically after each \`iw index build\` when .iw/rules.yaml is present.
Trend is computed as improving / worsening / stable from first to last snapshot in the time window.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      days: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Time window in days (default 30)"),
      ruleId: z.string().optional().describe("Filter to a specific rule id"),
    },
    async (args) => {
      log(`cari_rules_trend: days=${args.days ?? 30}`);
      try {
        const { rulesTrend } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = rulesTrend(dbPath, {
          days: args.days ?? 30,
          ruleId: args.ruleId,
        });

        if (result.rules.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No conformance snapshots in the last ${result.days} days.\nSnapshots are recorded after each \`iw index build\`.`,
              },
            ],
          };
        }

        const lines = [
          `## ADR Conformance Trend (last ${result.days} days)`,
          "",
          "| Rule | ADR | Snapshots | Trend | Latest % | Violations |",
          "|------|-----|-----------|-------|----------|------------|",
        ];

        for (const rule of result.rules) {
          const trendIcon =
            rule.trend === "improving"
              ? "↑ improving"
              : rule.trend === "worsening"
                ? "↓ worsening"
                : rule.trend === "stable"
                  ? "→ stable"
                  : "? n/a";
          const last = rule.snapshots[rule.snapshots.length - 1];
          const pct = last ? last.conformancePct.toFixed(1) + "%" : "-";
          const viol = last ? String(last.violationCount) : "-";
          lines.push(
            `| ${rule.ruleId} | ${rule.adr ?? ""} | ${rule.snapshots.length} | ${trendIcon} | ${pct} | ${viol} |`,
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_layers_from_decorators ──────────────────────────
  server.tool(
    "cari_layers_from_decorators",
    `Derive architectural layer assignments from decorator metadata (14.4).

Uses built-in presets (nestjs, angular, spring) to map decorator names like \`@Controller\`, \`@Injectable\`, \`@Entity\` to architectural layers.

No LLM or Neo4j needed — queries a local SQLite index.`,
    {
      preset: z
        .enum(["nestjs", "angular", "spring"])
        .optional()
        .describe("Decorator preset (default: nestjs)"),
    },
    async (args) => {
      log(`cari_layers_from_decorators: preset=${args.preset ?? "nestjs"}`);
      try {
        const { layersFromDecorators } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = layersFromDecorators(dbPath, {
          preset: args.preset ?? "nestjs",
        });

        if (result.assignments.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No decorated symbols found for preset "${result.preset}". Ensure the index was built with decorator extraction enabled.`,
              },
            ],
          };
        }

        const lines = [
          `## Decorator-Derived Layers (preset: ${result.preset})  —  ${result.totalSymbols} symbol(s)`,
          "",
        ];

        for (const [layerNum, layerDef] of Object.entries(result.layers)) {
          lines.push(
            `### Layer ${layerNum}: ${layerDef.name}  (${layerDef.files.length} file(s))`,
          );
          lines.push(
            `Decorators: ${layerDef.decorators.map((d) => `\`@${d}\``).join(", ")}`,
          );
          for (const f of layerDef.files.slice(0, 10)) {
            lines.push(`- ${f}`);
          }
          if (layerDef.files.length > 10) {
            lines.push(`- … and ${layerDef.files.length - 10} more`);
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
          await import("@intentweave/plugin-llm");
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

        if (result.slices.length === 0 && result.horizontal.length === 0) {
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
            lines.push(`| ... | +${result.horizontal.length - 15} more | |`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_focus ────────────────────────────────────────────────
  server.tool(
    "cari_focus",
    `Generate a focused architecture view centred on a specific file, symbol, or topic. Returns a scoped subgraph with N-hop neighbours, annotated with architectural layers, community membership, and transitive dependents.

Three edge types: import (structural), co_change (temporal), doc_cooc (semantic).
Ideal for understanding the local architecture around any code entity.

No LLM or Neo4j needed — pure SQLite analysis on the CARI index.`,
    {
      target: z
        .string()
        .describe(
          "File path, symbol name, or topic keyword to centre the view on",
        ),
      hops: z
        .number()
        .optional()
        .default(2)
        .describe(
          "Number of import-graph hops to expand from the target (default: 2)",
        ),
      maxNodes: z
        .number()
        .optional()
        .default(25)
        .describe(
          "Maximum nodes in the subgraph — truncated by relevance (default: 25)",
        ),
    },
    async (args) => {
      log(
        `cari_focus: target=${args.target}, hops=${args.hops}, maxNodes=${args.maxNodes}`,
      );
      try {
        const { focus } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = focus(dbPath, {
          target: args.target,
          hops: args.hops,
          maxNodes: args.maxNodes,
        });

        if (result.nodes.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No results found for target "${args.target}". Try a file path, symbol name, or keyword.`,
              },
            ],
          };
        }

        const lines: string[] = [
          `## Focused Architecture: ${result.target}`,
          "",
          `**${result.nodes.length} nodes** (of ${result.totalNeighborhood} in ${result.hops}-hop neighbourhood), **${result.edges.length} edges**`,
          "",
        ];

        // Nodes table
        lines.push(
          "### Nodes",
          "",
          "| File | Layer | Community | Dependents | Hops |",
          "|------|-------|-----------|------------|------|",
        );
        for (const n of result.nodes) {
          const marker = n.isTarget ? "⭐ " : "";
          const name = n.name || n.filePath.split("/").pop() || n.filePath;
          lines.push(
            `| ${marker}${name} | ${n.layerLabel ?? `L${n.layerIndex}`} | ${n.communityLabel ?? `C${n.communityId}`} | ${n.dependents} | ${n.hopDistance} |`,
          );
        }
        lines.push("");

        // Edges by type
        const importEdges = result.edges.filter((e) => e.type === "import");
        const coChangeEdges = result.edges.filter(
          (e) => e.type === "co_change",
        );
        const docEdges = result.edges.filter((e) => e.type === "doc_cooc");

        if (importEdges.length > 0) {
          lines.push(
            `### Import Edges (${importEdges.length})`,
            "",
            "| Source | Target |",
            "|--------|--------|",
          );
          for (const e of importEdges) {
            lines.push(
              `| ${e.source.split("/").pop()} | ${e.target.split("/").pop()} |`,
            );
          }
          lines.push("");
        }

        if (coChangeEdges.length > 0) {
          lines.push(
            `### Co-Change Edges (${coChangeEdges.length})`,
            "",
            "| Source | Target | Jaccard |",
            "|--------|--------|---------|",
          );
          for (const e of coChangeEdges) {
            lines.push(
              `| ${e.source.split("/").pop()} | ${e.target.split("/").pop()} | ${e.weight.toFixed(2)} |`,
            );
          }
          lines.push("");
        }

        if (docEdges.length > 0) {
          lines.push(
            `### Doc Co-occurrence Edges (${docEdges.length})`,
            "",
            "| Source | Target | Weight |",
            "|--------|--------|--------|",
          );
          for (const e of docEdges) {
            lines.push(
              `| ${e.source.split("/").pop()} | ${e.target.split("/").pop()} | ${e.weight.toFixed(2)} |`,
            );
          }
          lines.push("");
        }

        // Mermaid diagram
        lines.push("### Dependency Graph", "", "```mermaid", "graph LR");
        const nodeIds = new Map<string, string>();
        result.nodes.forEach((n, i) => {
          const id = `n${i}`;
          const label = n.name || n.filePath.split("/").pop() || n.filePath;
          const prefix = n.isTarget ? "⭐ " : "";
          nodeIds.set(n.filePath, id);
          lines.push(`  ${id}["${prefix}${label}"]`);
        });
        for (const e of result.edges) {
          const src = nodeIds.get(e.source);
          const tgt = nodeIds.get(e.target);
          if (!src || !tgt) continue;
          if (e.type === "import") {
            lines.push(`  ${src} --> ${tgt}`);
          } else {
            lines.push(`  ${src} -.-> ${tgt}`);
          }
        }
        lines.push("```", "");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_enrich ───────────────────────────────────────────────

  server.tool(
    "cari_enrich",
    "Selective semantic enrichment — score files for LLM enrichment candidacy, or trigger enrichment. " +
      "Uses CARI signals (hotspots, orphans, hubs, coverage, drift) to rank files by impact. " +
      "With dryRun=true (default), returns scored candidates. With dryRun=false, runs FX+KX extraction.",
    {
      budget: z
        .number()
        .optional()
        .describe("Maximum files to enrich (default: 20)"),
      threshold: z
        .number()
        .optional()
        .describe("Minimum impact score to qualify (default: 0.1)"),
      focus: z
        .string()
        .optional()
        .describe("Restrict to files under this directory prefix"),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "If true (default), only score and return candidates. If false, run LLM enrichment.",
        ),
      incremental: z
        .boolean()
        .optional()
        .describe("Skip files unchanged since last enrichment"),
    },
    async (args) => {
      try {
        log(
          `cari_enrich: budget=${args.budget}, threshold=${args.threshold}, focus=${args.focus}, dryRun=${args.dryRun}`,
        );

        const { enrichmentScore } = await import("@intentweave/index");
        const scoreResult = enrichmentScore(resolveIndexDb(), {
          focus: args.focus,
          incremental: args.incremental,
        });

        const threshold = args.threshold ?? 0.1;
        const budget = args.budget ?? 20;
        const eligible = scoreResult.candidates.filter((c) => {
          if (c.impactScore < threshold) return false;
          if (args.incremental && c.alreadyEnriched) return false;
          return true;
        });
        const selected = eligible.slice(0, budget);

        const dryRun = args.dryRun !== false; // default true

        if (dryRun) {
          const lines: string[] = [
            `## Enrichment Candidates (${selected.length} of ${scoreResult.totalEvaluated} files)`,
            "",
          ];

          if (selected.length === 0) {
            lines.push(
              "No files qualify for enrichment. Try lowering the threshold.",
            );
          } else {
            lines.push(
              "| File | Impact Score | Hotspot | Orphan | Hub | Coverage Gap | Drift |",
              "|------|-------------|---------|--------|-----|-------------|-------|",
            );
            for (const c of selected) {
              lines.push(
                `| ${c.filePath} | ${c.impactScore.toFixed(3)} | ${c.signals.hotspotRank.toFixed(2)} | ${c.signals.orphanRatio.toFixed(2)} | ${c.signals.hubDegree.toFixed(2)} | ${c.signals.coverageGap.toFixed(2)} | ${c.signals.driftSeverity.toFixed(2)} |`,
              );
            }
          }

          lines.push(
            "",
            `> Set \`dryRun: false\` to run LLM enrichment on these files.`,
          );

          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // KG enrichment (dryRun=false) is not available in this build.
        return {
          content: [
            {
              type: "text",
              text: "LLM enrichment (dryRun=false) is not available in this build. Use dryRun=true (default) to see enrichment candidates ranked by CARI signals.",
            },
          ],
          isError: true,
        };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );
  // ── Tool: cari_verify ───────────────────────────────────────────────
  server.tool(
    "cari_verify",
    "Spec-to-code verification: check whether KG entities (from enrichment) are grounded in code symbols. " +
      "Returns grounded/ungrounded/partial/untested status for each entity. " +
      "Requires prior enrichment (iw index enrich). " +
      "Use to validate that documented decisions, requirements, and components have corresponding code.",
    {
      files: z
        .array(z.string())
        .optional()
        .describe("Restrict to entities from these source files"),
      types: z
        .array(z.string())
        .optional()
        .describe(
          "Only verify entities of these types (e.g., decision, requirement, component)",
        ),
      minConfidence: z
        .number()
        .optional()
        .describe(
          "Minimum annotation confidence to count as grounded (default: 0.5)",
        ),
      checkTests: z
        .boolean()
        .optional()
        .describe("Check test coverage for grounded entities (default: true)"),
    },
    async (args) => {
      try {
        log(
          `cari_verify: files=${args.files}, types=${args.types}, checkTests=${args.checkTests}`,
        );

        const { verify } = await import("@intentweave/index");
        const dbPath = resolveIndexDb();

        const result = verify(dbPath, {
          files: args.files,
          types: args.types,
          minConfidence: args.minConfidence,
          checkTests: args.checkTests,
        });

        await logMcpSessionEvent({
          tool: "cari_verify",
          confidence: result.summary.coveragePercent,
          resultCount: result.entities.length,
        });

        if (result.entities.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No KG entities found. Run `iw index enrich` first to extract semantic entities.",
              },
            ],
          };
        }

        const { summary } = result;
        const lines: string[] = [
          `## Spec-to-Code Verification`,
          "",
          `**${summary.total}** entities checked — **${summary.coveragePercent}%** spec coverage`,
          "",
          "| Status | Entity | Type | Source | Grounded In |",
          "|--------|--------|------|--------|-------------|",
        ];

        const STATUS_ICONS: Record<string, string> = {
          grounded: "✓",
          untested: "⚠",
          partial: "~",
          ungrounded: "✗",
        };

        for (const e of result.entities) {
          const icon = STATUS_ICONS[e.status] ?? "?";
          const groundedStr =
            e.groundedIn.length > 0
              ? e.groundedIn
                  .map((g) => `${g.symbolName} (${g.filePath})`)
                  .join(", ")
              : "—";
          lines.push(
            `| ${icon} ${e.status} | ${e.name} | ${e.entityType} | ${e.sourceFile} | ${groundedStr} |`,
          );
        }

        lines.push(
          "",
          "### Summary",
          "",
          `- ✓ **${summary.grounded}** grounded`,
          `- ⚠ **${summary.untested}** untested (code found but no tests)`,
          `- ~ **${summary.partial}** partial (mentioned in docs, no code symbol)`,
          `- ✗ **${summary.ungrounded}** ungrounded (no code references)`,
        );

        if (result.byFile.length > 1) {
          lines.push("", "### By File", "");
          for (const f of result.byFile) {
            lines.push(
              `- **${f.file}**: ${f.coveragePercent}% (${f.grounded}/${f.total})`,
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

  // ── Tool: cari_consistency ──────────────────────────────────────────
  server.tool(
    "cari_consistency",
    "Constraint consistency check: detect contradictions between KG relationships across different " +
      "source documents. Finds opposing predicates (e.g., REQUIRES vs DECIDED_AGAINST the same entity) " +
      "and exclusive-predicate conflicts (e.g., DECIDED_FOR two different targets). " +
      "Requires prior enrichment (iw index enrich).",
    {
      files: z
        .array(z.string())
        .optional()
        .describe("Restrict to relationships from these source files"),
      types: z
        .array(z.string())
        .optional()
        .describe("Only check relationships involving entities of these types"),
      minConfidence: z
        .number()
        .optional()
        .describe("Minimum relationship confidence to include (default: 0.5)"),
    },
    async (args) => {
      try {
        log(`cari_consistency: files=${args.files}, types=${args.types}`);

        const { consistency } = await import("@intentweave/index");
        const dbPath = resolveIndexDb();

        const result = consistency(dbPath, {
          files: args.files,
          types: args.types,
          minConfidence: args.minConfidence,
        });

        const { summary } = result;

        await logMcpSessionEvent({
          tool: "cari_consistency",
          confidence: summary.consistencyPercent,
          resultCount: result.conflicts.length,
        });

        if (result.conflicts.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `## Constraint Consistency\n\n` +
                  `✓ All **${summary.totalRelationships}** relationships are internally consistent.`,
              },
            ],
          };
        }

        const lines: string[] = [
          `## Constraint Consistency`,
          "",
          `**${summary.totalRelationships}** relationships checked — **${summary.consistencyPercent}%** consistent`,
          "",
          "| Sev | Entity A | Predicate A | Entity B | Predicate B | Source A | Source B |",
          "|-----|----------|-------------|----------|-------------|---------|---------|",
        ];

        for (const c of result.conflicts) {
          const icon = c.severity === "error" ? "✗" : "⚠";
          lines.push(
            `| ${icon} | ${c.entityA.name} | ${c.predicateA} | ${c.entityB.name} | ${c.predicateB} | ${c.sourceFileA} | ${c.sourceFileB} |`,
          );
        }

        lines.push(
          "",
          "### Summary",
          "",
          `- ✗ **${summary.errors}** errors (hard contradictions)`,
          `- ⚠ **${summary.warnings}** warnings (potential conflicts)`,
          `- ✓ **${summary.consistencyPercent}%** consistent`,
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_arch_check ─────────────────────────────────────────
  server.tool(
    "cari_arch_check",
    `Validate code imports against the architecture diagram (.iw/architecture.yaml).
Confirms declared component flows, detects undocumented flows, and checks dependency constraints.

Returns:
- Confirmed vs. missing declared flows
- Undocumented cross-component imports not in the diagram
- Constraint violations (forbidden dependencies)
- Conformance percentage`,
    {
      config: z
        .string()
        .optional()
        .describe("Path to architecture.yaml (default: .iw/architecture.yaml)"),
      strict: z
        .boolean()
        .optional()
        .describe("Treat undocumented flows as errors"),
      fromDiagrams: z
        .boolean()
        .optional()
        .describe(
          "Infer architecture config from enriched diagram triples (no YAML required)",
        ),
    },
    async (args) => {
      try {
        const { archCheck, parseArchitectureYaml, inferArchConfigFromKg } =
          await loadIndex();
        const { readFile } = await import("node:fs/promises");
        const dbPath = resolveIndexDb();
        let config: ReturnType<typeof parseArchitectureYaml> | null = null;
        let usedDiagramFallback = false;

        if (args.fromDiagrams) {
          config = inferArchConfigFromKg(dbPath, {
            requireDiagramHints: true,
            workspaceRoot: process.cwd(),
          });

          if (!config.components || config.components.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "✗ No architecture triples found from diagrams. Run `iw index enrich --provider openai` first, or provide `config`.",
                },
              ],
              isError: true,
            };
          }
        } else {
          const configPath =
            args.config ?? path.join(process.cwd(), ".iw", "architecture.yaml");

          let configContent: string;
          try {
            configContent = await readFile(configPath, "utf-8");
          } catch {
            config = inferArchConfigFromKg(dbPath, {
              requireDiagramHints: true,
              workspaceRoot: process.cwd(),
            });

            if (!config.components || config.components.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `✗ Architecture config not found at ${configPath}, and no diagram triples were inferred. Use fromDiagrams=true after enrichment or create .iw/architecture.yaml.`,
                  },
                ],
                isError: true,
              };
            }
            usedDiagramFallback = true;
            configContent = "";
          }

          if (configContent) {
            config = parseArchitectureYaml(configContent);
          }
        }

        if (!config) {
          return {
            content: [
              {
                type: "text",
                text: "✗ Failed to load architecture config.",
              },
            ],
            isError: true,
          };
        }

        const result = archCheck(dbPath, config);
        const { summary } = result;

        if (
          summary.missingFlows === 0 &&
          summary.undocumentedFlows === 0 &&
          summary.constraintViolations === 0
        ) {
          return {
            content: [
              {
                type: "text",
                text:
                  `✓ Architecture fully conformant. **${summary.confirmedFlows}** flows confirmed, no undocumented imports or constraint violations. ` +
                  `Conformance: **${summary.conformancePercent}%**`,
              },
            ],
          };
        }

        const lines: string[] = [
          `## Architecture Validation`,
          "",
          `**${summary.conformancePercent}%** conformance`,
          "",
        ];

        if (usedDiagramFallback) {
          lines.push(
            "⚠ Config missing; used inferred architecture from enriched diagram triples.",
            "",
          );
        }

        // Component summary
        lines.push("### Components", "");
        for (const c of result.componentSummary) {
          lines.push(`- **${c.name}**: ${c.fileCount} files`);
        }
        lines.push("");

        // Flows
        if (result.flows.length > 0) {
          lines.push(
            "### Declared Flows",
            "",
            "| Status | From | To | Evidence |",
            "|--------|------|----|----------|",
          );
          for (const f of result.flows) {
            const icon = f.status === "confirmed" ? "✓" : "⚠";
            const evidence =
              f.status === "confirmed"
                ? `${f.evidence.length} import(s)`
                : "no imports found";
            lines.push(`| ${icon} | ${f.from} | ${f.to} | ${evidence} |`);
          }
          lines.push("");
        }

        // Undocumented
        if (result.undocumented.length > 0) {
          lines.push(
            "### Undocumented Flows",
            "",
            "| From | To | Imports |",
            "|------|----|---------|",
          );
          for (const u of result.undocumented) {
            lines.push(`| ${u.from} | ${u.to} | ${u.edges.length} |`);
          }
          lines.push("");
        }

        // Violations
        if (result.constraintViolations.length > 0) {
          lines.push(
            "### Constraint Violations",
            "",
            "| From | To | Reason | Imports |",
            "|------|----|--------|---------|",
          );
          for (const v of result.constraintViolations) {
            lines.push(
              `| ${v.from} | ${v.to} | ${v.reason} | ${v.edges.length} |`,
            );
          }
          lines.push("");
        }

        lines.push(
          "### Summary",
          "",
          `- ✓ **${summary.confirmedFlows}** confirmed flows`,
          `- ⚠ **${summary.missingFlows}** missing flows`,
          `- ✗ **${summary.undocumentedFlows}** undocumented flows`,
          `- ! **${summary.constraintViolations}** constraint violations`,
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_resolve ──────────────────────────────────────────────
  server.tool(
    "cari_resolve",
    `Ground a diagram component name against the CARI index — map it to concrete code symbols, doc files, and co-occurrence evidence.

Returns:
- Resolved terms (normalised aliases usable as lookup keys)
- Matched code symbols (name, kind, file path)
- Documentation files that mention the component
- Confidence score (0–1) and evidence summary

Use this before \`cari_arch_diff\` when a component name is ambiguous, or to understand what concrete artifacts a high-level label refers to.

No LLM or Neo4j needed — pure SQLite.`,
    {
      name: z
        .string()
        .describe(
          "Diagram component name to resolve (e.g. 'Authentication', 'PaymentService')",
        ),
      limitSymbols: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum code symbols to return (default: 10)"),
      limitDocs: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum doc files to return (default: 5)"),
    },
    async (args) => {
      log(`cari_resolve: name="${args.name}"`);
      try {
        const { resolveComponent } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = resolveComponent(dbPath, {
          name: args.name,
          limitSymbols: args.limitSymbols,
          limitDocs: args.limitDocs,
        });
        const r = result.resolved;

        const lines: string[] = [
          `## Resolve: "${r.name}"`,
          "",
          `**Confidence**: ${r.confidence.toFixed(2)}`,
          "",
        ];

        if (r.evidence.length > 0) {
          lines.push("**Evidence**:", ...r.evidence.map((e) => `- ${e}`), "");
        }

        if (r.terms.length > 0) {
          lines.push(`**Resolved Terms**: ${r.terms.join(", ")}`, "");
        }

        if (r.symbols.length > 0) {
          lines.push(
            "### Matched Symbols",
            "",
            "| Name | Kind | File |",
            "|------|------|------|",
            ...r.symbols.map(
              (s) => `| ${s.name} | ${s.kind} | ${s.filePath} |`,
            ),
            "",
          );
        } else {
          lines.push("*No code symbols found.*", "");
        }

        if (r.docFiles.length > 0) {
          lines.push(
            "### Documentation Files",
            "",
            ...r.docFiles.map((f) => `- ${f}`),
            "",
          );
        } else {
          lines.push("*No documentation files found.*", "");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_arch_diff ─────────────────────────────────────────────
  server.tool(
    "cari_arch_diff",
    `Validate architecture diagram flows against CARI entity evidence (annotations + co-occurrences).

Scans markdown diagrams via LLM to extract components and declared flows (result is cached by content hash),
then checks each declared flow against co-occurrence and annotation signals in the CARI index.

Returns:
- Per-component grounding status (co_occurrence / annotation / none)
- Missing flows (declared in diagram but no entity evidence)
- Ungrounded flows (both ends lack index evidence)
- Conformance percentage

Use for drift analysis between documented and actual architecture — without needing import-level code analysis.

No Neo4j needed — LLM is used only for the initial diagram scan (cached after first run).`,
    {
      paths: z
        .array(z.string())
        .optional()
        .default(["docs"])
        .describe(
          "Directories or files to scan for diagrams (default: ['docs'])",
        ),
      provider: z
        .enum(["openai", "smart-mock"])
        .optional()
        .default("smart-mock")
        .describe(
          "LLM provider for diagram interpretation (default: smart-mock)",
        ),
      refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe("Ignore cache and re-scan diagrams (default: false)"),
    },
    async (args) => {
      log(
        `cari_arch_diff: paths=${JSON.stringify(args.paths)}, provider=${args.provider}, refresh=${args.refresh}`,
      );
      try {
        const { buildArchConfigFromDiagrams } =
          await import("../commands/indexScanDiagrams.js");
        const { diagramEntityCheck } = await loadIndex();
        const dbPath = resolveIndexDb();

        const resolvedPaths = (args.paths ?? ["docs"]).map((p) =>
          path.isAbsolute(p) ? p : path.resolve(process.cwd(), p),
        );

        const archConfig = await buildArchConfigFromDiagrams({
          provider: args.provider,
          paths: resolvedPaths,
          silent: true,
          refresh: args.refresh ?? false,
        });

        if (archConfig.components.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No architecture components found in diagrams. Make sure your docs contain Mermaid or PlantUML diagrams.",
              },
            ],
          };
        }

        const result = diagramEntityCheck(dbPath, archConfig);
        const { summary } = result;

        await logMcpSessionEvent({
          tool: "cari_arch_diff",
          confidence: summary.conformancePercent,
          resultCount: result.flows.length,
        });

        const lines: string[] = [
          "## Architecture Diff (Entity Evidence)",
          "",
          `**${summary.conformancePercent}%** conformance — ${summary.confirmedFlows} confirmed, ${summary.missingFlows} missing`,
          "",
        ];

        // Component grounding
        lines.push("### Component Grounding", "");
        if (result.entityGrounding && result.entityGrounding.length > 0) {
          lines.push(
            "| Component | Grounded In | Mentions | Docs |",
            "|-----------|-------------|----------|------|",
          );
          for (const g of result.entityGrounding) {
            const icon =
              g.groundedIn === "none"
                ? "✗"
                : g.groundedIn === "annotation"
                  ? "✓"
                  : "~";
            lines.push(
              `| ${icon} ${g.name} | ${g.groundedIn} | ${g.mentionCount} | ${g.docCount} |`,
            );
          }
          lines.push("");
        }

        // Flows
        if (result.flows.length > 0) {
          lines.push(
            "### Declared Flows",
            "",
            "| Status | From | To | Evidence |",
            "|--------|------|----|----------|",
          );
          for (const f of result.flows) {
            const icon = f.status === "confirmed" ? "✓" : "⚠";
            const ev =
              f.status === "confirmed"
                ? `${f.evidence.length} signal(s)`
                : "no evidence";
            lines.push(`| ${icon} | ${f.from} | ${f.to} | ${ev} |`);
          }
          lines.push("");
        }

        // Summary
        lines.push(
          "### Summary",
          "",
          `- ✓ **${summary.confirmedFlows}** confirmed flows`,
          `- ⚠ **${summary.missingFlows}** missing flows`,
          `- ✗ **${summary.undocumentedFlows}** undocumented flows`,
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_component_evidence ───────────────────────────────────
  server.tool(
    "cari_component_evidence",
    `Get all CARI evidence for a single architecture component: resolved code symbols, documentation mentions, and cross-layer connections.

Combines three signals:
1. Symbol resolution (exact + FTS match against the code index)
2. Documentation annotations (which doc files mention this component)
3. CARI connections (co-occurrence, co-change, and import-graph neighbours)

Use after \`cari_arch_diff\` to drill into a specific ungrounded or missing component.

No LLM or Neo4j needed — pure SQLite.`,
    {
      name: z
        .string()
        .describe(
          "Component name to investigate (e.g. 'AuthService', 'Pipeline')",
        ),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum items per evidence section (default: 10)"),
    },
    async (args) => {
      log(`cari_component_evidence: name="${args.name}" limit=${args.limit}`);
      try {
        const { resolveComponent, connections } = await loadIndex();
        const dbPath = resolveIndexDb();
        const lim = args.limit ?? 10;

        // Layer 1: symbol resolution
        const resolved = resolveComponent(dbPath, {
          name: args.name,
          limitSymbols: lim,
          limitDocs: lim,
        }).resolved;

        // Layer 2: CARI connections (co-occ, co-change, imports)
        const conns = connections(dbPath, { entity: args.name, limit: lim });

        const lines: string[] = [
          `## Component Evidence: "${args.name}"`,
          "",
          `**Confidence**: ${resolved.confidence.toFixed(2)}`,
        ];

        if (resolved.evidence.length > 0) {
          lines.push(
            "",
            "**Evidence**:",
            ...resolved.evidence.map((e) => `- ${e}`),
          );
        }

        // Symbols
        if (resolved.symbols.length > 0) {
          lines.push(
            "",
            "### Code Symbols",
            "",
            "| Name | Kind | File |",
            "|------|------|------|",
            ...resolved.symbols.map(
              (s) => `| ${s.name} | ${s.kind} | ${s.filePath} |`,
            ),
          );
        }

        // Doc files
        if (resolved.docFiles.length > 0) {
          lines.push(
            "",
            "### Documentation Files",
            "",
            ...resolved.docFiles.map((f) => `- ${f}`),
          );
        }

        // Connections
        const allConns = (conns.connections ?? []).slice(0, lim);

        if (allConns.length > 0) {
          lines.push(
            "",
            "### Connections",
            "",
            "| Entity | Source Types | Score |",
            "|--------|-------------|-------|",
            ...allConns.map((c) => {
              const types = c.sources.map((s) => s.type).join(", ");
              const maxScore = Math.max(...c.sources.map((s) => s.score));
              return `| ${c.name} | ${types} | ${maxScore.toFixed(2)} |`;
            }),
          );
        }

        // Gaps
        if (conns.gaps && conns.gaps.length > 0) {
          lines.push(
            "",
            "### Gaps (evidence-layer disagreements)",
            "",
            ...conns.gaps.map((g) => `- **${g.severity}**: ${g.description}`),
          );
        }

        if (
          resolved.symbols.length === 0 &&
          resolved.docFiles.length === 0 &&
          allConns.length === 0
        ) {
          lines.push(
            "",
            "⚠ No evidence found. Try running `iw index build` or check the component name spelling.",
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_living_score ─────────────────────────────────────────
  server.tool(
    "cari_living_score",
    `Compute the Living Documentation Score (12.3) — a composite 0–100 score with letter grade (A–F) across four dimensions:
- Spec Coverage: % of KG entities grounded in code (requires prior \`iw run\` enrichment)
- Constraint Consistency: % of constraints without contradictions (requires prior enrichment)
- Doc Freshness: % of documentation files not stale
- Architecture Conformance: % of import edges respecting inferred layer boundaries

Unavailable dimensions (e.g., no enrichment run) are excluded from the composite average.
Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 45, F < 45.
Use to get an at-a-glance health score for a project's living documentation.`,
    {
      minConfidence: z
        .number()
        .optional()
        .default(0.5)
        .describe("Minimum annotation confidence (0–1) for spec grounding"),
      allowSkipLayer: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Allow imports that skip layers without counting as violations",
        ),
    },
    async (args) => {
      log(
        `cari_living_score: minConfidence=${args.minConfidence}, allowSkipLayer=${args.allowSkipLayer}`,
      );
      try {
        const { livingScore } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = livingScore(dbPath, {
          minConfidence: args.minConfidence,
          allowSkipLayer: args.allowSkipLayer,
        });

        await logMcpSessionEvent({
          tool: "cari_living_score",
          confidence: result.score,
        });

        const GRADE_EMOJI: Record<string, string> = {
          A: "🟢",
          B: "🟡",
          C: "🟠",
          D: "🔴",
          F: "⛔",
        };
        const dims = [
          result.specCoverage,
          result.constraintConsistency,
          result.docFreshness,
          result.archConformance,
        ];
        const gradeEmoji = GRADE_EMOJI[result.grade] ?? "";
        const lines = [
          `## Living Documentation Score: ${result.score}/100  (${gradeEmoji} Grade ${result.grade})`,
          "",
          "| Dimension | Score | Detail | Available |",
          "|-----------|-------|--------|-----------|",
          ...dims.map(
            (d) =>
              `| ${d.label} | ${d.available ? `${d.score}%` : "N/A"} | ${d.detail} | ${d.available ? "✓" : "✗"} |`,
          ),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: unknown) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_calls (Phase 4) ───────────────────────────────────────
  server.tool(
    "cari_calls",
    `Query the symbol_calls call graph extracted from AST analysis (Phase 4).
Returns call edges between functions/methods across files in the indexed codebase.

Use to:
- Find what functions a given file or caller calls
- Find all callers of a specific function name
- Understand method call patterns
- Cross-check with behavioral Mermaid rules

Returns: edges[], total count, topCallees[] sorted by call frequency.
Note: Only available for languages with AX call extraction support. Check callsTableActive field.`,
    {
      callerFile: z
        .string()
        .optional()
        .describe("Filter by caller file path (substring match)"),
      calleeName: z
        .string()
        .optional()
        .describe("Filter by callee function name (substring match)"),
      callerName: z
        .string()
        .optional()
        .describe("Filter by caller function name (substring match)"),
      methodOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only show method calls (is_method = 1)"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum results to return"),
    },
    async (args) => {
      log(
        `cari_calls: callerFile=${args.callerFile}, calleeName=${args.calleeName}, limit=${args.limit}`,
      );
      try {
        const { calls } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = calls(dbPath, {
          callerFile: args.callerFile,
          calleeName: args.calleeName,
          callerName: args.callerName,
          methodOnly: args.methodOnly,
          limit: args.limit,
        });

        if (result.total === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No call edges found. Check filter options or rebuild the index with AX call extraction.",
              },
            ],
          };
        }

        const lines = [
          `## Call Graph Query — ${result.total} edge(s)`,
          "",
          result.topCallees.length > 0
            ? `**Top callees:** ${result.topCallees
                .slice(0, 8)
                .map(
                  (c: { calleeName: string; count: number }) =>
                    `${c.calleeName}(×${c.count})`,
                )
                .join(", ")}`
            : "",
          "",
          "| Caller File | Caller | Line | Callee | Method |",
          "|-------------|--------|------|--------|--------|",
          ...result.edges.map(
            (e: {
              callerFile: string;
              callerName: string | null;
              callerLine: number | null;
              calleeName: string;
              isMethod: boolean;
            }) =>
              `| ${e.callerFile} | ${e.callerName ?? ""} | ${e.callerLine ?? ""} | ${e.calleeName} | ${e.isMethod ? "✓" : ""} |`,
          ),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: unknown) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_trace (Phase 4) ───────────────────────────────────────
  server.tool(
    "cari_trace",
    `Trace call paths from an entry-point file using BFS through the symbol_calls table (Phase 4).

Use to:
- Understand what a module calls transitively (forward direction)
- Find all callers of a module transitively (backward direction)
- Validate Mermaid sequence diagrams against actual call paths
- Identify unexpected call chains

Returns: entryFile, nodes[] (each with file + symbols + depth), edges[] (fromFile → toFile with callee name), truncated flag, callsTableActive flag.`,
    {
      entry: z
        .string()
        .describe("Entry-point file path (substring match, e.g. 'auth.ts')"),
      hops: z
        .number()
        .optional()
        .default(6)
        .describe("Maximum BFS traversal depth"),
      maxNodes: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of nodes to include in result"),
      direction: z
        .enum(["forward", "backward"])
        .optional()
        .default("forward")
        .describe(
          "forward: what does entry call? backward: who calls into entry?",
        ),
    },
    async (args) => {
      log(
        `cari_trace: entry=${args.entry}, hops=${args.hops}, direction=${args.direction}`,
      );
      try {
        const { trace } = await loadIndex();
        const dbPath = resolveIndexDb();
        const result = trace(dbPath, {
          entry: args.entry,
          hops: args.hops,
          maxNodes: args.maxNodes,
          direction: args.direction,
        });

        if (result.nodes.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No entry files found matching "${args.entry}". Try a shorter substring.`,
              },
            ],
          };
        }

        const callsStatus = result.callsTableActive
          ? "✓ Call graph active (~0.95 confidence)"
          : "⚠ No call graph data — rebuild index with AX call extraction";

        const lines = [
          `## Call Trace — ${args.direction} from "${result.entryFile}"`,
          `${callsStatus}`,
          `Nodes: ${result.nodes.length}  Edges: ${result.edges.length}${result.truncated ? "  *(truncated)*" : ""}`,
          "",
          "### Nodes by Depth",
          "| Depth | File | Symbols |",
          "|-------|------|---------|",
          ...result.nodes
            .sort(
              (a: { depth: number }, b: { depth: number }) => a.depth - b.depth,
            )
            .map(
              (n: { depth: number; file: string; symbols: string[] }) =>
                `| ${n.depth} | ${n.file} | ${n.symbols.slice(0, 5).join(", ")}${n.symbols.length > 5 ? ", ..." : ""} |`,
            ),
          "",
          "### Call Edges",
          "| From | Symbol | Line | To | Callee |",
          "|------|--------|------|----|--------|",
          ...result.edges.map(
            (e: {
              fromFile: string;
              fromSymbol: string | null;
              callerLine: number | null;
              toFile: string;
              toCalleeName: string;
            }) =>
              `| ${e.fromFile} | ${e.fromSymbol ?? ""} | ${e.callerLine ?? ""} | ${e.toFile} | ${e.toCalleeName} |`,
          ),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: unknown) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_cypher ────────────────────────────────────────────────
  server.tool(
    "cari_cypher",
    `Run a CypherLite query over the CARI graph projection, or use a built-in named template.

The CARI graph exposes these node labels:
  - FILE     (source + doc files)
  - SYMBOL   (exported functions, classes, interfaces, variables)
  - DOCSPAN  (documentation annotation spans)
  - TODO     (inline TODO/FIXME/HACK/XXX comments)

And these relationship types:
  - IMPORTS        FILE  → FILE
  - DEFINES        FILE  → SYMBOL
  - CALLS          FILE  → SYMBOL  (and SYMBOL → SYMBOL at function level)
                   Properties: r.callerLine (source line), r.isMethod (1=method)
  - ANNOTATED_BY   SYMBOL → DOCSPAN
  - HAS_TODO       FILE  → TODO
  - CO_OCCURS      FILE|SYMBOL ↔ FILE|SYMBOL
  - CO_CHANGES     FILE  → FILE  (git co-change)

Variable-length paths are supported: (a)-[:CALLS*1..5]->(b)

Each node has: id, name, file, line, layer, fan_in.

Use cari_graph_schema to get the full schema + all template parameters before writing queries.

Built-in templates (pass id to templateId):
  callers-of, callees-of, docs-for-callees, co-changed-with,
  undocumented-hubs, symbol-docs, import-chain, calls-with-cochange,
  files-per-layer, docs-per-layer, missing-docs, all-importers,
  cross-layer-connections, todos-in-hotspots, todos-by-kind,
  reachable-from, entrypoints-to`,
    {
      query: z
        .string()
        .optional()
        .describe("CypherLite query string. Omit when using templateId."),
      templateId: z
        .string()
        .optional()
        .describe(
          "Built-in template id (e.g. 'callers-of'). Use instead of or together with query.",
        ),
      params: z
        .record(z.union([z.string(), z.number()]))
        .optional()
        .default({})
        .describe(
          "Query parameters matching $param placeholders (e.g. { calleeName: 'validateToken' })",
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of rows to return"),
      showSql: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include the generated SQL in the response for debugging"),
    },
    async (args) => {
      try {
        const {
          runCypherQueryFromDb,
          CARI_QUERY_TEMPLATES,
          CARI_GRAPH_SCHEMA,
        } = await import("@intentweave/index");
        const dbPath = path.join(process.cwd(), ".iw", "index.db");

        // Resolve template
        let queryStr = args.query ?? "";
        if (args.templateId) {
          const tpl = CARI_QUERY_TEMPLATES.find(
            (t: { id: string }) => t.id === args.templateId,
          );
          if (!tpl) {
            const ids = CARI_QUERY_TEMPLATES.map(
              (t: { id: string }) => t.id,
            ).join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown template "${args.templateId}". Available: ${ids}`,
                },
              ],
              isError: true,
            };
          }
          queryStr = tpl.query;
        }

        if (!queryStr.trim()) {
          // List templates
          const lines = [
            "## CARI Built-in Query Templates",
            "",
            ...CARI_QUERY_TEMPLATES.map(
              (t: {
                id: string;
                name: string;
                description: string;
                params: string[];
              }) =>
                `**${t.id}** — ${t.name}\n${t.description}\nParams: ${t.params.map((p: string) => `$${p}`).join(", ") || "none"}`,
            ),
            "",
            "## Graph Schema",
            "```",
            JSON.stringify(CARI_GRAPH_SCHEMA, null, 2),
            "```",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        const result = runCypherQueryFromDb(
          dbPath,
          queryStr,
          args.params as Record<string, unknown>,
        );
        const rows = result.rows.slice(0, args.limit);
        const truncated = result.rows.length > args.limit;

        const lines: string[] = [];
        if (args.showSql) {
          lines.push("## Generated SQL", "```sql", result.sql, "```", "");
        }

        if (rows.length === 0) {
          lines.push("No results.");
        } else {
          const cols = result.columns;
          lines.push(
            `## Results (${result.rows.length} row${result.rows.length !== 1 ? "s" : ""})${truncated ? ` — showing first ${args.limit}` : ""}`,
            "",
            `| ${cols.join(" | ")} |`,
            `| ${cols.map(() => "---").join(" | ")} |`,
            ...rows.map(
              (row) =>
                `| ${cols
                  .map((c) => {
                    const v = String(row[c] ?? "");
                    return v.length > 80 ? v.slice(0, 78) + "…" : v;
                  })
                  .join(" | ")} |`,
            ),
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: unknown) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_graph_schema ──────────────────────────────────────────
  server.tool(
    "cari_graph_schema",
    `Return the complete CARI graph schema — node types, relationship types, property names,
and all built-in query templates with their parameters.

Use this before writing a cari_cypher query to understand what node labels, relationship
types, and property names are available. Also useful to discover built-in templates
so you can pass them directly to cari_cypher as templateId.`,
    {},
    async () => {
      try {
        const { CARI_GRAPH_SCHEMA, CARI_QUERY_TEMPLATES } =
          await import("@intentweave/index");
        const lines: string[] = [
          "## CARI Graph Schema",
          "",
          "### Node Labels",
          "",
        ];
        for (const [label, info] of Object.entries(
          CARI_GRAPH_SCHEMA.nodes as Record<string, Record<string, unknown>>,
        )) {
          lines.push(`**${label}** (table: \`${String(info.table)}\`)`);
          lines.push(`  ID format: \`${String(info.idFormat)}\``);
          lines.push("  Properties:");
          for (const [prop, desc] of Object.entries(
            info.properties as Record<string, string>,
          )) {
            lines.push(`    - \`${prop}\`: ${desc}`);
          }
          lines.push("");
        }
        lines.push("### Relationship Types", "");
        for (const [rel, desc] of Object.entries(
          CARI_GRAPH_SCHEMA.relationships as Record<string, unknown>,
        )) {
          const descStr = Array.isArray(desc) ? desc.join("; ") : String(desc);
          lines.push(`**${rel}** — ${descStr}`);
        }
        lines.push("", "### Notes", "");
        for (const note of CARI_GRAPH_SCHEMA.notes as unknown as string[]) {
          lines.push(`- ${note}`);
        }
        lines.push("", "---", "", "## Built-in Query Templates", "");
        for (const tpl of CARI_QUERY_TEMPLATES as Array<{
          id: string;
          name: string;
          description: string;
          params: string[];
          defaults?: Record<string, unknown>;
        }>) {
          lines.push(`### \`${tpl.id}\``);
          lines.push(`**${tpl.name}**`);
          lines.push(tpl.description);
          if (tpl.params.length > 0) {
            lines.push(
              `Parameters: ${tpl.params.map((p) => `\`$${p}\``).join(", ")}`,
            );
          }
          if (tpl.defaults && Object.keys(tpl.defaults).length > 0) {
            lines.push(`Defaults: ${JSON.stringify(tpl.defaults)}`);
          }
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: unknown) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Tool: cari_capsule ───────────────────────────────────────────────────
  server.tool(
    "cari_capsule",
    `Generate or retrieve an LLM-derived semantic capsule for a CARI entity.

Capsules are cached in \`semantic_capsules\` and re-used if the underlying
symbol has not changed (body_hash comparison). Pass \`refresh: true\` to
force regeneration.

**capsuleKind values:**
  - \`symbol_summary\`   — purpose, inputs, outputs, concepts for a single symbol
  - \`call_semantics\`   — why caller A calls callee B and what role the edge plays
  - \`path_summary\`     — narrative for a full CALLS*N path (ordered list of symbol IDs)

**provider:** Use \`openai\` (requires OPENAI_API_KEY) or \`mock\` for dry-run.

**Tip:** Run \`cari_calls\` or \`cari_trace\` first to get symbol IDs / call edges, then
pass them to \`cari_capsule\` for natural-language explanations.`,
    {
      symbolId: z
        .string()
        .optional()
        .describe(
          "Numeric symbol ID (from symbols table) for symbol_summary capsule",
        ),
      callEdge: z
        .object({
          callerSymbolId: z.string(),
          calleeSymbolId: z.string(),
        })
        .optional()
        .describe(
          "Caller + callee numeric symbol IDs for call_semantics capsule",
        ),
      pathSymbolIds: z
        .array(z.string())
        .optional()
        .describe(
          "Ordered list of numeric symbol IDs for path_summary capsule (min 2)",
        ),
      provider: z
        .enum(["openai", "mock"])
        .optional()
        .default("openai")
        .describe("LLM provider"),
      model: z
        .string()
        .optional()
        .default("gpt-4o-mini")
        .describe("LLM model name"),
      refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe("Force regeneration even if a fresh capsule is cached"),
    },
    async (args) => {
      try {
        const dbPath = path.join(process.cwd(), ".iw", "index.db");
        const Database = (await import("@intentweave/sqlite-compat")).default;
        const db = new Database(dbPath);
        db.pragma("journal_mode = WAL");
        try {
          const {
            generateSymbolSummary,
            generateCallSemantics,
            generatePathSummary,
          } = await import("@intentweave/index");

          const { OpenAILLMProvider, SmartMockLLMProvider } =
            await import("@intentweave/plugin-llm");
          const apiKey = process.env.OPENAI_API_KEY;
          const llm =
            args.provider === "mock" || !apiKey
              ? new SmartMockLLMProvider({ workspaceKey: "capsule" })
              : new OpenAILLMProvider({
                  apiKey,
                  model: args.model ?? "gpt-4o-mini",
                });
          const opts = {
            model: args.model ?? "gpt-4o-mini",
            force: args.refresh ?? false,
          };

          let result;
          if (args.symbolId) {
            result = await generateSymbolSummary(db, args.symbolId, llm, opts);
          } else if (args.callEdge) {
            result = await generateCallSemantics(
              db,
              args.callEdge.callerSymbolId,
              args.callEdge.calleeSymbolId,
              llm,
              opts,
            );
          } else if (args.pathSymbolIds && args.pathSymbolIds.length >= 2) {
            result = await generatePathSummary(
              db,
              args.pathSymbolIds,
              llm,
              opts,
            );
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Provide symbolId, callEdge, or pathSymbolIds (≥ 2 elements).",
                },
              ],
              isError: true,
            };
          }

          const c = result.capsule;
          const lines: string[] = [
            `## Semantic Capsule: ${c.targetId}`,
            `Kind: ${c.capsuleKind}  |  Status: ${c.status}  |  Model: ${c.model}${result.fromCache ? "  |  (from cache)" : ""}`,
            "",
          ];
          for (const [key, val] of Object.entries(c.content)) {
            if (!val || (Array.isArray(val) && val.length === 0)) continue;
            if (Array.isArray(val)) {
              lines.push(`**${key}:** ${(val as string[]).join(", ")}`);
            } else {
              lines.push(`**${key}:** ${String(val)}`);
            }
          }
          if (result.tokensUsed) {
            lines.push(
              "",
              `*Tokens used: ${result.tokensUsed.prompt} prompt, ${result.tokensUsed.completion} completion*`,
            );
          }
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        } finally {
          db.close();
        }
      } catch (err: unknown) {
        const msg = handleCariError(err);
        return {
          content: [{ type: "text" as const, text: msg }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: cari_context_pack ──────────────────────────────────────────
  server.tool(
    "cari_context_pack",
    `Build a composite CARI context bundle for LLM prompt injection.

Runs multiple CARI signals in one call and returns a token-budgeted markdown block:
- **Relevant files** — ranked by annotation score, co-occurrence, symbol match
- **Exported symbols** — from the top-ranked files
- **Architecture rules** — active violations first, then clean rules
- **Cross-layer connections** — linked entities + hidden coupling gaps
- **Design rationale** — WHY/NOTE/DESIGN comments from context files
- **Documentation drift** — docs that reference changed files (when \`files\` provided)

Empty sections are omitted. The \`summary\` field is ready to paste into any LLM prompt.

**Typical use:** give Copilot focused context before implementing a feature, reviewing a PR,
or debugging an architectural issue — without calling 5 separate tools.`,
    {
      query: z
        .string()
        .optional()
        .describe(
          'Natural-language topic or task (e.g. "authentication flow", "how does billing work")',
        ),
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Files being edited or changed in a PR — anchors drift detection and symbol lookup",
        ),
      entity: z
        .string()
        .optional()
        .describe(
          "Anchor on a specific symbol or component name for connection discovery",
        ),
      budget: z
        .number()
        .optional()
        .default(4000)
        .describe(
          "Approximate token budget for the output (default: 4000, max: 12000)",
        ),
      sections: z
        .array(
          z.enum([
            "files",
            "symbols",
            "rules",
            "connections",
            "rationale",
            "drift",
          ]),
        )
        .optional()
        .describe(
          "Which sections to include (default: all). Omit to get everything that has data.",
        ),
      adaptiveMode: z
        .enum(["off", "conservative", "aggressive"])
        .optional()
        .describe(
          "Adaptive ranking mode. Default: conservative, or .iw/config.yaml adaptive.mode if set.",
        ),
    },
    async (args) => {
      log(
        `cari_context_pack: query="${args.query ?? ""}" entity="${args.entity ?? ""}" files=${JSON.stringify(args.files ?? [])} budget=${args.budget}`,
      );
      try {
        const { contextPack: cpFn } = await loadIndex();
        const dbPath = resolveIndexDb();

        const { load: yamlLoadMcp } = await import("js-yaml");
        const { readFile } = await import("node:fs/promises");
        const configPath = path.join(process.cwd(), ".iw", "config.yaml");
        let iwConfig: import("@intentweave/index").IwConfig | undefined;
        try {
          const rawYaml = await readFile(configPath, "utf-8");
          iwConfig = yamlLoadMcp(rawYaml) as
            | import("@intentweave/index").IwConfig
            | undefined;
        } catch {
          iwConfig = undefined;
        }
        // Load .iw/rules.yaml (if present) so the rules section can report
        // each rule's real domain and rank by relevance to the query/anchor
        // files instead of assuming "structural" for everything.
        const rulesYamlPath = path.join(process.cwd(), ".iw", "rules.yaml");
        let rulesConfig: import("@intentweave/index").RulesConfig | undefined;
        try {
          const rawRules = await readFile(rulesYamlPath, "utf-8");
          rulesConfig = yamlLoadMcp(rawRules) as
            | import("@intentweave/index").RulesConfig
            | undefined;
        } catch {
          rulesConfig = undefined;
        }
        const adaptiveMode =
          args.adaptiveMode ?? iwConfig?.adaptive?.mode ?? "conservative";

        const result = cpFn(dbPath, {
          query: args.query,
          files: args.files,
          entity: args.entity,
          budget: Math.min(args.budget ?? 4000, 12000),
          sections: args.sections as
            | import("@intentweave/index").ContextPackSection[]
            | undefined,
          adaptiveMode,
          adaptiveConfig: iwConfig?.adaptive
            ? { pathExceptions: iwConfig.adaptive.path_exceptions }
            : undefined,
          rulesConfig,
        });
        return {
          content: [
            {
              type: "text",
              text: [
                result.summary,
                "",
                `---`,
                `*~${result.tokenEstimate} tokens · ${result.sections.files.length} files · ${result.sections.symbols.length} symbols*`,
              ].join("\n"),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = handleCariError(err);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },
  );

  // ── Plugin MCP tools ─────────────────────────────────────────────────
  if (options.neo4jUri) {
    process.env.NEO4J_URI = options.neo4jUri;
  }
  const registry = getPluginRegistry();
  await registry.discover((pkg) => import(pkg));
  await registry.resolveCapabilities({
    workspaceRoot: process.cwd(),
    indexDbPath: path.join(process.cwd(), ".iw", "index.db"),
    session: sessionId,
    verbose: !!verbose,
  });
  registry.registerAllMcpTools(server, {
    workspaceRoot: process.cwd(),
    indexDbPath: path.join(process.cwd(), ".iw", "index.db"),
    session: sessionId,
    verbose: !!verbose,
  });
  log(`Discovered ${registry.size} plugin(s)`);

  // ── Connect via stdio ───────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server running (stdio transport). Waiting for messages…");
}
