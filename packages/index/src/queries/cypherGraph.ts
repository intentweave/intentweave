// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CypherLite CARI graph projection.
 *
 * Builds virtual `kg_entities` and `kg_relationships` CTEs from the CARI
 * SQLite tables so that CypherLite queries can traverse the full CARI graph
 * without Neo4j.
 *
 * Node labels available in queries:
 *   - FILE      (from `files`)
 *   - SYMBOL    (from `symbols`)
 *   - DOCSPAN   (from `annotations`)
 *   - TODO      (from `todos`)
 *   - RATIONALE (from `rationale` — WHY/NOTE/IMPORTANT/DESIGN comments)
 *   - SEMANTIC  (from `semantic_capsules` — LLM-derived interpretations)
 *
 * Relationship types:
 *   - IMPORTS        FILE     → FILE
 *   - DEFINES        FILE     → SYMBOL
 *   - CALLS          FILE     → SYMBOL   (from symbol_calls, file-level)
 *   - CALLS          SYMBOL   → SYMBOL   (from symbol_calls, function-level join)
 *   - ANNOTATED_BY   SYMBOL   → DOCSPAN
 *   - HAS_TODO       FILE     → TODO
 *   - HAS_RATIONALE  FILE     → RATIONALE
 *   - HAS_RATIONALE  SYMBOL   → RATIONALE  (when rationale.symbol IS NOT NULL)
 *   - SUMMARIZED_BY  SYMBOL   → SEMANTIC
 *   - CO_OCCURS      FILE|SYMBOL ↔ FILE|SYMBOL
 *   - CO_CHANGES     FILE     → FILE
 */

import Database from "better-sqlite3";
import {
  parse as parseCypher,
  transpile as transpileCypher,
} from "../../../cypher-lite/dist/index.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface CypherQueryResult {
  /** Column names in emission order. */
  columns: string[];
  /** Result rows. */
  rows: Record<string, unknown>[];
  /** The generated SQL string (useful for debugging). */
  sql: string;
}

export interface QueryTemplate {
  /** Machine-readable identifier (e.g. "callers-of"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** One-line description. */
  description: string;
  /** CypherLite query with `$param` placeholders. */
  query: string;
  /** Required parameter names. */
  params: string[];
  /** Optional default values for parameters. */
  defaults?: Record<string, unknown>;
}

// ── Graph schema description ──────────────────────────────────────────────────

export const CARI_GRAPH_SCHEMA = {
  nodes: {
    FILE: {
      table: "files",
      idFormat: "file:<path>",
      properties: {
        id: "file:<path>",
        name: "file path",
        file: "file path",
        layer: "doc_group (architectural layer)",
        fan_in: "null (use SYMBOL.fan_in for call counts)",
      },
    },
    SYMBOL: {
      table: "symbols",
      idFormat: "symbol:<id>",
      properties: {
        id: "symbol:<id>",
        name: "symbol name",
        file: "file_path",
        line: "line number",
        fan_in: "call count (callee references in symbol_calls)",
      },
    },
    DOCSPAN: {
      table: "annotations",
      idFormat: "doc:<id>",
      properties: {
        id: "doc:<id>",
        name: "doc text excerpt",
        file: "doc_path",
        line: "line number in doc",
        layer: "null",
        fan_in: "null",
      },
    },
    TODO: {
      table: "todos",
      idFormat: "todo:<id>",
      properties: {
        id: "todo:<id>",
        name: "comment text",
        file: "file_path",
        line: "line number",
        kind: "TODO | FIXME | HACK | XXX  (stored as .layer in graph projection — use t.layer = $kind in WHERE)",
        layer: "null",
        fan_in: "null",
      },
    },
    RATIONALE: {
      table: "rationale",
      idFormat: "rat:<id>",
      properties: {
        id: "rat:<id>",
        name: "comment text",
        file: "file_path",
        line: "line number",
        layer: "kind (WHY | NOTE | IMPORTANT | DESIGN)",
        fan_in: "null",
      },
    },
    SEMANTIC: {
      table: "semantic_capsules",
      idFormat: "capsule:<kind>:<target_id>@<rev>",
      properties: {
        id: "capsule id",
        name: "capsule_kind (symbol_summary | call_semantics | path_summary | subgraph_summary)",
        file: "null (capsule is not file-specific)",
        line: "null",
        layer: "status (fresh | possibly_stale | stale)",
        fan_in: "null",
      },
    },
  },
  relationships: {
    IMPORTS: "FILE → FILE (from imports.source_file → imports.target_file)",
    DEFINES: "FILE → SYMBOL (from symbols.file_path)",
    CALLS: [
      "FILE → SYMBOL  (symbol_calls: caller_file → symbols.name = callee_name) — properties: callerLine (source line), isMethod (1=method, 0=function)",
      "SYMBOL → SYMBOL  (symbol_calls: caller symbol JOIN symbols ON callee_name) — properties: callerLine, isMethod",
    ],
    ANNOTATED_BY: "SYMBOL → DOCSPAN  (annotations: symbol_id → annotation id)",
    HAS_TODO: "FILE → TODO  (todos.file_path)",
    HAS_RATIONALE:
      "FILE → RATIONALE  (rationale.file_path, symbol IS NULL) | SYMBOL → RATIONALE  (rationale.symbol IS NOT NULL)",
    SUMMARIZED_BY:
      "SYMBOL → SEMANTIC  (semantic_capsules: target_id = 'symbol:<id>')",
    CO_OCCURS: "FILE|SYMBOL ↔ FILE|SYMBOL  (co_occurrences)",
    CO_CHANGES: "FILE → FILE  (co_changes: git co-commit pairs)",
  },
  notes: [
    "All IDs are prefixed strings: file:, symbol:, doc:, todo:, rat:, capsule:.",
    "CALLS edges are resolved by matching callee_name to symbols.name (name-based join, may match multiple definitions).",
    "CALLS relationship properties: r.callerLine (source line number), r.isMethod (1=method call, 0=function call).",
    "Variable-length CALLS paths are supported: (a)-[:CALLS*1..5]->(b).",
    "For SYMBOL→SYMBOL CALLS, both caller and callee must be present in the symbols table.",
    "TODO nodes expose .kind (TODO/FIXME/HACK/XXX) as .layer; use t.layer = $kind in WHERE.",
    "RATIONALE nodes expose .layer = kind (WHY/NOTE/IMPORTANT/DESIGN) and .name = comment text.",
    "SEMANTIC nodes are LLM-derived capsules; .layer = status (fresh/possibly_stale/stale). Query content via raw SQL on semantic_capsules.",
    "FILE.layer maps to doc_group (the architectural layer assigned during indexing).",
    "Use --format json for machine-readable output; --format table for human-readable.",
  ],
} as const;

// ── Query templates ────────────────────────────────────────────────────────────

export const CARI_QUERY_TEMPLATES: QueryTemplate[] = [
  {
    id: "callers-of",
    name: "Callers of a function",
    description:
      "Find all files (and calling symbols) that call a given function name.",
    query: `MATCH (caller)-[:CALLS]->(fn:SYMBOL)
WHERE fn.name = $calleeName
RETURN DISTINCT caller.file AS file, caller.name AS callerSymbol, fn.name AS callee
ORDER BY file`,
    params: ["calleeName"],
  },
  {
    id: "callees-of",
    name: "Callees of a file",
    description: "Find all symbols called from a given source file.",
    query: `MATCH (f:FILE)-[:CALLS]->(callee:SYMBOL)
WHERE f.file = $file
RETURN callee.name AS callee, callee.file AS definedIn
ORDER BY callee`,
    params: ["file"],
  },
  {
    id: "docs-for-callees",
    name: "Docs for callees of a file",
    description:
      "Find documentation annotations for all symbols called from a file.",
    query: `MATCH (f:FILE)-[:CALLS]->(callee:SYMBOL)-[:ANNOTATED_BY]->(doc:DOCSPAN)
WHERE f.file = $file
RETURN callee.name AS callee, doc.file AS docFile, doc.name AS excerpt
ORDER BY callee`,
    params: ["file"],
  },
  {
    id: "co-changed-with",
    name: "Files that co-change with a file",
    description:
      "Find files frequently committed together with a given file (git co-change).",
    query: `MATCH (f:FILE)-[:CO_CHANGES]->(other:FILE)
WHERE f.file = $file
RETURN other.file AS file, other.layer AS layer
ORDER BY file`,
    params: ["file"],
  },
  {
    id: "undocumented-hubs",
    name: "Undocumented high-fan-in symbols",
    description:
      "Find frequently-called symbols with no documentation annotation.",
    query: `MATCH (s:SYMBOL)
WHERE s.fan_in > $minFanIn
  AND NOT EXISTS { MATCH (s)-[:ANNOTATED_BY]->(:DOCSPAN) }
RETURN s.name AS symbol, s.file AS file, s.fan_in AS fanIn
ORDER BY fanIn DESC`,
    params: ["minFanIn"],
    defaults: { minFanIn: 3 },
  },
  {
    id: "symbol-docs",
    name: "Documentation for a symbol",
    description:
      "Find all documentation spans that annotate a given symbol name.",
    query: `MATCH (s:SYMBOL)-[:ANNOTATED_BY]->(doc:DOCSPAN)
WHERE s.name = $symbolName
RETURN s.name AS symbol, doc.file AS docFile, doc.line AS docLine, doc.name AS excerpt`,
    params: ["symbolName"],
  },
  {
    id: "import-chain",
    name: "Import chain from a file",
    description:
      "Find all files directly or transitively imported from a file (up to 4 hops).",
    query: `MATCH (f:FILE)-[:IMPORTS*1..4]->(dep:FILE)
WHERE f.file = $file
RETURN DISTINCT dep.file AS dependency, dep.layer AS layer
ORDER BY dependency`,
    params: ["file"],
  },
  {
    id: "calls-with-cochange",
    name: "Callees that also co-change with caller",
    description:
      "Find symbols called from a file whose defining files also co-change with it.",
    query: `MATCH (f:FILE)-[:CALLS]->(callee:SYMBOL),
      (f)-[:CO_CHANGES]->(coFile:FILE)
WHERE f.file = $file
  AND callee.file = coFile.file
RETURN callee.name AS callee, callee.file AS definedIn
ORDER BY callee`,
    params: ["file"],
  },
  // ── Retrieve / layer / coverage patterns ────────────────────────────────
  {
    id: "files-per-layer",
    name: "All files in an architectural layer",
    description:
      "List all source files belonging to a given architectural layer (doc_group).",
    query: `MATCH (f:FILE)
WHERE f.layer = $layer
RETURN f.file AS file, f.layer AS layer
ORDER BY file`,
    params: ["layer"],
  },
  {
    id: "docs-per-layer",
    name: "Documentation coverage per layer",
    description:
      "Count source files and documented symbols per architectural layer.",
    query: `SELECT
  f.doc_group                            AS layer,
  COUNT(DISTINCT f.path)                 AS totalFiles,
  COUNT(DISTINCT s.id)                   AS totalSymbols,
  COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN s.id END) AS documentedSymbols
FROM files f
LEFT JOIN symbols s ON s.file_path = f.path
LEFT JOIN annotations a ON a.symbol_id = s.id
GROUP BY f.doc_group
ORDER BY layer`,
    params: [],
  },
  {
    id: "missing-docs",
    name: "Exported symbols without documentation",
    description:
      "Find exported symbols that have no annotation in any doc file, sorted by call frequency.",
    query: `MATCH (f:FILE)-[:DEFINES]->(s:SYMBOL)
WHERE NOT EXISTS { MATCH (s)-[:ANNOTATED_BY]->(:DOCSPAN) }
RETURN s.name AS symbol, s.file AS file, s.fan_in AS callCount
ORDER BY callCount DESC`,
    params: [],
  },
  // ── Connection / import patterns ─────────────────────────────────────────
  {
    id: "all-importers",
    name: "All files that import a given file",
    description: "Find every file that directly imports a given source file.",
    query: `MATCH (importer:FILE)-[:IMPORTS]->(target:FILE)
WHERE target.file = $file
RETURN importer.file AS importer, importer.layer AS layer
ORDER BY importer`,
    params: ["file"],
  },
  {
    id: "cross-layer-connections",
    name: "Cross-layer import connections",
    description:
      "Find all import edges that cross architectural layer boundaries.",
    query: `SELECT
  i.source_file  AS fromFile,
  f_src.doc_group AS fromLayer,
  i.target_file  AS toFile,
  f_tgt.doc_group AS toLayer
FROM imports i
JOIN files f_src ON f_src.path = i.source_file
JOIN files f_tgt ON f_tgt.path = i.target_file
WHERE f_src.doc_group IS NOT NULL
  AND f_tgt.doc_group IS NOT NULL
  AND f_src.doc_group != f_tgt.doc_group
ORDER BY fromLayer, toLayer, fromFile`,
    params: [],
  },
  // ── TODO patterns ────────────────────────────────────────────────────────
  {
    id: "todos-in-hotspots",
    name: "TODOs in high-churn files",
    description:
      "Find TODO/FIXME/HACK/XXX comments located in files with high churn (frequently changed).",
    query: `SELECT
  t.kind        AS kind,
  t.file_path   AS file,
  t.line        AS line,
  t.text        AS comment,
  f.churn       AS churn
FROM todos t
JOIN files f ON f.path = t.file_path
WHERE f.churn >= $minChurn
ORDER BY f.churn DESC, t.kind`,
    params: ["minChurn"],
    defaults: { minChurn: 5 },
  },
  {
    id: "todos-by-kind",
    name: "TODOs filtered by kind",
    description:
      "List all TODO markers of a specific kind (FIXME, HACK, XXX, or TODO).",
    query: `MATCH (f:FILE)-[:HAS_TODO]->(t:TODO)
WHERE t.layer = $kind
RETURN t.layer AS kind, f.file AS file, t.line AS line, t.name AS comment
ORDER BY file, line`,
    params: ["kind"],
    defaults: { kind: "FIXME" },
  },
  // ── Transitive path patterns ─────────────────────────────────────────────
  {
    id: "reachable-from",
    name: "All symbols reachable from an entry file",
    description:
      "Find every symbol transitively called from a given file (up to 4 hops). " +
      "Shows the full transitive call surface.",
    query: `MATCH (f:FILE)-[:CALLS*1..4]->(s:SYMBOL)
WHERE f.file = $entryFile
RETURN DISTINCT s.name AS symbol, s.file AS definedIn, s.fan_in AS callCount
ORDER BY callCount DESC`,
    params: ["entryFile"],
  },
  {
    id: "entrypoints-to",
    name: "What reaches a symbol (reverse call path)",
    description:
      "Find all symbols that can transitively call a given function — " +
      "i.e., all callers-of-callers up to 4 hops. " +
      "Useful for impact analysis: who is affected if this function changes?",
    query: `MATCH (caller:SYMBOL)-[:CALLS*1..4]->(fn:SYMBOL)
WHERE fn.name = $symbolName
RETURN DISTINCT caller.name AS caller, caller.file AS file
ORDER BY file`,
    params: ["symbolName"],
  },
];

// ── CTE builder ───────────────────────────────────────────────────────────────

/**
 * Prefix a CypherLite-transpiled SQL query with CTEs that project the CARI
 * SQLite tables as a virtual property graph (`kg_entities`, `kg_relationships`).
 *
 * The injected CTEs are inlined so the query runs against the same open
 * Database connection with no schema changes.
 */
export function injectCariGraphCtes(sql: string): string {
  const entitiesCte = `
kg_entities AS (
  -- FILE nodes
  SELECT
    'file:' || path        AS id,
    'FILE'                  AS type,
    path                    AS name,
    path                    AS path,
    path                    AS file,
    NULL                    AS line,
    COALESCE(doc_group, '') AS layer,
    NULL                    AS fan_in
  FROM files
  UNION ALL
  -- SYMBOL nodes (fan_in = #call-sites referencing this symbol)
  SELECT
    'symbol:' || id         AS id,
    'SYMBOL'                AS type,
    name,
    file_path               AS path,
    file_path               AS file,
    line,
    NULL                    AS layer,
    (
      SELECT COUNT(*)
      FROM symbol_calls sc
      WHERE sc.callee_name = symbols.name
    )                       AS fan_in
  FROM symbols
  UNION ALL
  -- DOCSPAN nodes
  SELECT
    'doc:' || id            AS id,
    'DOCSPAN'               AS type,
    text                    AS name,
    doc_path                AS path,
    doc_path                AS file,
    line,
    NULL                    AS layer,
    NULL                    AS fan_in
  FROM annotations
  UNION ALL
  -- TODO nodes (layer = kind so t.layer and the kind filter both work)
  SELECT
    'todo:' || id           AS id,
    'TODO'                  AS type,
    text                    AS name,
    file_path               AS path,
    file_path               AS file,
    line,
    kind                    AS layer,
    NULL                    AS fan_in
  FROM todos
  UNION ALL
  -- RATIONALE nodes (WHY/NOTE/IMPORTANT/DESIGN inline comments)
  SELECT
    'rat:' || id            AS id,
    'RATIONALE'             AS type,
    text                    AS name,
    file_path               AS path,
    file_path               AS file,
    line,
    kind                    AS layer,
    NULL                    AS fan_in
  FROM rationale
  UNION ALL
  -- SEMANTIC nodes (LLM-derived semantic capsules; layer = staleness status)
  SELECT
    id                      AS id,
    'SEMANTIC'              AS type,
    capsule_kind            AS name,
    NULL                    AS path,
    NULL                    AS file,
    NULL                    AS line,
    status                  AS layer,
    NULL                    AS fan_in
  FROM semantic_capsules
)`.trim();

  const relsCte = `
kg_relationships AS (
  -- IMPORTS: FILE → FILE
  SELECT
    'imp:' || id            AS id,
    'file:' || source_file  AS from_id,
    'file:' || target_file  AS to_id,
    'IMPORTS'               AS predicate,
    NULL                    AS caller_line,
    NULL                    AS is_method
  FROM imports
  WHERE target_file IS NOT NULL
  UNION ALL
  -- DEFINES: FILE → SYMBOL
  SELECT
    'def:' || id            AS id,
    'file:' || file_path    AS from_id,
    'symbol:' || id         AS to_id,
    'DEFINES'               AS predicate,
    NULL                    AS caller_line,
    NULL                    AS is_method
  FROM symbols
  UNION ALL
  -- CALLS: FILE → SYMBOL (by callee_name match in symbols)
  -- Properties: caller_line (source line), is_method (1=method, 0=function)
  SELECT DISTINCT
    'call:' || sc.caller_file || ':' || sc.callee_name || ':' || s.id AS id,
    'file:' || sc.caller_file AS from_id,
    'symbol:' || s.id        AS to_id,
    'CALLS'                  AS predicate,
    sc.caller_line           AS caller_line,
    sc.is_method             AS is_method
  FROM symbol_calls sc
  JOIN symbols s ON s.name = sc.callee_name
  UNION ALL
  -- CALLS: SYMBOL → SYMBOL (function-level: caller symbol → callee symbol)
  SELECT DISTINCT
    'symc:' || cs.id || ':' || ce.id AS id,
    'symbol:' || cs.id              AS from_id,
    'symbol:' || ce.id              AS to_id,
    'CALLS'                          AS predicate,
    sc.caller_line                   AS caller_line,
    sc.is_method                     AS is_method
  FROM symbol_calls sc
  JOIN symbols cs ON cs.name = sc.caller_name AND cs.file_path = sc.caller_file
  JOIN symbols ce ON ce.name = sc.callee_name
  WHERE sc.caller_name IS NOT NULL
  UNION ALL
  -- ANNOTATED_BY: SYMBOL → DOCSPAN
  SELECT
    'ann:' || id            AS id,
    'symbol:' || symbol_id  AS from_id,
    'doc:' || id            AS to_id,
    'ANNOTATED_BY'          AS predicate,
    NULL                    AS caller_line,
    NULL                    AS is_method
  FROM annotations
  WHERE symbol_id IS NOT NULL
  UNION ALL
  -- CO_OCCURS: FILE|SYMBOL ↔ FILE|SYMBOL
  SELECT
    'cooc:' || co.entity_a || '|' || co.entity_b || '|' || co.source AS id,
    CASE
      WHEN EXISTS (SELECT 1 FROM files f WHERE f.path = co.entity_a)
        THEN 'file:' || co.entity_a
      WHEN EXISTS (SELECT 1 FROM symbols s WHERE s.id = co.entity_a)
        THEN 'symbol:' || co.entity_a
      ELSE 'term:' || co.entity_a
    END                     AS from_id,
    CASE
      WHEN EXISTS (SELECT 1 FROM files f WHERE f.path = co.entity_b)
        THEN 'file:' || co.entity_b
      WHEN EXISTS (SELECT 1 FROM symbols s WHERE s.id = co.entity_b)
        THEN 'symbol:' || co.entity_b
      ELSE 'term:' || co.entity_b
    END                     AS to_id,
    'CO_OCCURS'             AS predicate,
    NULL                    AS caller_line,
    NULL                    AS is_method
  FROM co_occurrences co
  UNION ALL
  -- CO_CHANGES: FILE → FILE
  SELECT
    'coc:' || file_a || '|' || file_b AS id,
    'file:' || file_a       AS from_id,
    'file:' || file_b       AS to_id,
    'CO_CHANGES'            AS predicate,
    NULL                    AS caller_line,
    NULL                    AS is_method
  FROM co_changes
  UNION ALL
  -- HAS_TODO: FILE → TODO
  SELECT
    'ht:' || id             AS id,
    'file:' || file_path    AS from_id,
    'todo:' || id           AS to_id,
    'HAS_TODO'              AS predicate,
    NULL                    AS caller_line,
    NULL                    AS is_method
  FROM todos
  UNION ALL
  -- HAS_RATIONALE: FILE → RATIONALE (when not linked to a specific symbol)
  SELECT
    'hr:' || id             AS id,
    'file:' || file_path    AS from_id,
    'rat:' || id            AS to_id,
    'HAS_RATIONALE'         AS predicate,
    NULL                    AS caller_line,
    NULL                    AS is_method
  FROM rationale
  WHERE symbol IS NULL
  UNION ALL
  -- HAS_RATIONALE: SYMBOL → RATIONALE (when rationale.symbol is set)
  SELECT
    'hrs:' || r.id                        AS id,
    'symbol:' || s.id                     AS from_id,
    'rat:' || r.id                        AS to_id,
    'HAS_RATIONALE'                       AS predicate,
    NULL                                  AS caller_line,
    NULL                                  AS is_method
  FROM rationale r
  JOIN symbols s ON s.name = r.symbol AND s.file_path = r.file_path
  WHERE r.symbol IS NOT NULL
  UNION ALL
  -- SUMMARIZED_BY: SYMBOL → SEMANTIC (semantic_capsules targeting symbol:<id>)
  SELECT
    'sb:' || sc.id                        AS id,
    sc.target_id                          AS from_id,
    sc.id                                 AS to_id,
    'SUMMARIZED_BY'                       AS predicate,
    NULL                                  AS caller_line,
    NULL                                  AS is_method
  FROM semantic_capsules sc
  WHERE sc.target_id LIKE 'symbol:%'
)`.trim();

  if (/^\s*WITH\b/i.test(sql)) {
    return sql.replace(/^\s*WITH\s+/i, `WITH ${entitiesCte}, ${relsCte}, `);
  }
  return `WITH ${entitiesCte}, ${relsCte} ${sql}`;
}

// ── Query runner ──────────────────────────────────────────────────────────────

export function looksLikeSql(query: string): boolean {
  return /^\s*(select|with|pragma|explain)\b/i.test(query);
}

/**
 * Run a CypherLite (or raw SQL) query against an open CARI database.
 *
 * CypherLite queries are transpiled to SQL and the CARI graph CTEs are
 * injected automatically. Raw SQL queries bypass CTE injection.
 */
export function runCypherQuery(
  db: Database.Database,
  query: string,
  params: Record<string, unknown> = {},
): CypherQueryResult {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Empty query");

  let sql: string;
  let boundParams: unknown[];

  if (looksLikeSql(trimmed)) {
    sql = trimmed;
    // Pass named params directly — better-sqlite3 binds $name placeholders
    const stmt = db.prepare(sql);
    const rows = stmt.all(params) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, sql };
  }

  const transpiled = transpileCypher(parseCypher(trimmed), params);
  const readQueries = transpiled.filter((q) => q.kind === "read");
  if (readQueries.length === 0) throw new Error("No read clause in query");
  const last = readQueries[readQueries.length - 1];
  sql = injectCariGraphCtes(last.sql);
  boundParams = last.params;

  const stmt = db.prepare(sql);
  const rows = stmt.all(...boundParams) as Record<string, unknown>[];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return { columns, rows, sql };
}

/**
 * Open the CARI index.db at `dbPath`, run the query, and close.
 */
export function runCypherQueryFromDb(
  dbPath: string,
  query: string,
  params: Record<string, unknown> = {},
): CypherQueryResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    return runCypherQuery(db, query, params);
  } finally {
    db.close();
  }
}
