// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: rulesCheck (13.2 + 13.3)
 *
 * Validate the index against a team-committed .iw/rules.yaml config.
 * Reports semantic architectural violations per rule, per file, with line numbers.
 *
 * Rule types:
 *  - property_access : matches property access chains (symbol_calls + property_accesses tables)
 *  - call            : callee name regex (symbol_calls table)
 *  - symbol_name     : symbol name pattern (symbols table)
 *  - import_pattern  : import module specifier glob (imports table)
 *
 * $0 / no LLM — pure SQLite queries after index build.
 */

import type Database from "better-sqlite3";
import { minimatch } from "minimatch";
import {
  parse as parseCypher,
  transpile as transpileCypher,
} from "../../../cypher-lite/dist/index.js";
import type {
  RulesConfig,
  RuleDefinition,
  RuleForbidden,
  RulesViolation,
  RulesCheckResult,
} from "../types.js";
import { openIndex } from "./shared.js";

// ── Options ──────────────────────────────────────────────────────────────────

export interface RulesCheckOptions {
  /** Only report violations in these files (for incremental CI; 13.3) */
  changed?: string[];
  /** Only report violations with this severity or higher */
  severity?: "high" | "medium" | "low";
  /** Only check the rule with this ID */
  ruleId?: string;
  /** Maximum violations to return (across all rules) */
  limit?: number;
}

// ── Severity ordering ─────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<"high" | "medium" | "low", number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function meetsThreshold(
  sev: "high" | "medium" | "low",
  threshold: "high" | "medium" | "low",
): boolean {
  return SEVERITY_ORDER[sev] >= SEVERITY_ORDER[threshold];
}

// ── Public API ───────────────────────────────────────────────────────────────

export function rulesCheck(
  dbPath: string,
  config: RulesConfig,
  opts: RulesCheckOptions = {},
): RulesCheckResult {
  const db = openIndex(dbPath);
  try {
    return rulesCheckFromDb(db, config, opts);
  } finally {
    db.close();
  }
}

export function rulesCheckFromDb(
  db: Database.Database,
  config: RulesConfig,
  opts: RulesCheckOptions = {},
): RulesCheckResult {
  const { changed, severity = "low", ruleId, limit } = opts;

  const activeRules = config.rules.filter((r) => {
    if (ruleId && r.id !== ruleId) return false;
    if (!meetsThreshold(r.severity, severity)) return false;
    return true;
  });

  const allViolations: RulesViolation[] = [];

  for (const rule of activeRules) {
    const violations = checkRule(db, rule, changed);
    allViolations.push(...violations);
  }

  // Apply limit
  const limited = limit ? allViolations.slice(0, limit) : allViolations;

  const bySeverity: Record<"high" | "medium" | "low", number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  const byRule: Record<string, number> = {};

  for (const v of limited) {
    bySeverity[v.ruleSeverity]++;
    byRule[v.ruleId] = (byRule[v.ruleId] ?? 0) + 1;
  }

  return {
    violations: limited,
    totalViolations: allViolations.length,
    bySeverity,
    byRule,
    rulesChecked: activeRules.length,
  };
}

// ── Rule evaluation ───────────────────────────────────────────────────────────

function checkRule(
  db: Database.Database,
  rule: RuleDefinition,
  changed?: string[],
): RulesViolation[] {
  const violations: RulesViolation[] = [];

  for (const forbidden of rule.forbidden) {
    const found = checkForbidden(db, rule, forbidden, changed);
    violations.push(...found);
  }

  return violations;
}

function checkForbidden(
  db: Database.Database,
  rule: RuleDefinition,
  forbidden: RuleForbidden,
  changed?: string[],
): RulesViolation[] {
  switch (forbidden.type) {
    case "property_access":
      return checkPropertyAccess(db, rule, forbidden, changed);
    case "call":
      return checkCall(db, rule, forbidden, changed);
    case "symbol_name":
      return checkSymbolName(db, rule, forbidden, changed);
    case "import_pattern":
      return checkImportPattern(db, rule, forbidden, changed);
    case "variable_assignment":
      return checkVariableAssignment(db, rule, forbidden, changed);
    case "cypher":
      return checkCypherRule(db, rule, forbidden, changed);
    default:
      return [];
  }
}

// ── property_access ───────────────────────────────────────────────────────────

function checkPropertyAccess(
  db: Database.Database,
  rule: RuleDefinition,
  forbidden: RuleForbidden,
  changed?: string[],
): RulesViolation[] {
  if (!forbidden.chain) return [];

  // Check if the table exists (guard for old indexes)
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='property_accesses'`,
    )
    .get();
  if (!tableExists) return [];

  const rows = db
    .prepare(
      `SELECT file, symbol_name, line, chain FROM property_accesses ORDER BY file, line`,
    )
    .all() as Array<{
    file: string;
    symbol_name: string | null;
    line: number;
    chain: string;
  }>;

  const violations: RulesViolation[] = [];

  for (const row of rows) {
    if (!matchesScope(row.file, forbidden, changed)) continue;
    if (!matchesChainGlob(row.chain, forbidden.chain)) continue;

    // context_access filter: only flag if same file+line also has a matching access
    if (forbidden.context_access) {
      const hasContext = rows.some(
        (r) =>
          r.file === row.file &&
          Math.abs(r.line - row.line) <= 5 &&
          matchesChainGlob(r.chain, forbidden.context_access!),
      );
      if (!hasContext) continue;
    }

    violations.push({
      ruleId: rule.id,
      ruleSeverity: rule.severity,
      ruleDescription: rule.description,
      adr: rule.adr,
      filePath: row.file,
      line: row.line,
      symbol: row.symbol_name,
      detail: `property access \`${row.chain}\` matches forbidden pattern \`${forbidden.chain}\`${row.symbol_name ? ` in ${row.symbol_name}()` : ""}`,
    });
  }

  return violations;
}

// ── call ──────────────────────────────────────────────────────────────────────

function checkCall(
  db: Database.Database,
  rule: RuleDefinition,
  forbidden: RuleForbidden,
  changed?: string[],
): RulesViolation[] {
  if (!forbidden.callee) return [];

  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_calls'`,
    )
    .get();
  if (!tableExists) return [];

  const calleeRegex = new RegExp(`^(${forbidden.callee})$`);

  const rows = db
    .prepare(
      `SELECT caller_file, caller_name, caller_line, callee_name, callee_id, is_method FROM symbol_calls ORDER BY caller_file, caller_line`,
    )
    .all() as Array<{
    caller_file: string;
    caller_name: string | null;
    caller_line: number;
    callee_name: string;
    callee_id: string | null;
    is_method: number;
  }>;

  const violations: RulesViolation[] = [];

  for (const row of rows) {
    if (!matchesScope(row.caller_file, forbidden, changed)) continue;
    if (!calleeRegex.test(row.callee_name)) continue;

    const qualifier = row.is_method ? "method" : "function";
    violations.push({
      ruleId: rule.id,
      ruleSeverity: rule.severity,
      ruleDescription: rule.description,
      adr: rule.adr,
      filePath: row.caller_file,
      line: row.caller_line,
      symbol: row.caller_name,
      detail: `${qualifier} \`${row.callee_name}()\` called — matches forbidden pattern \`${forbidden.callee}\`${row.caller_name ? ` in ${row.caller_name}()` : ""}`,
    });
  }

  return violations;
}

// ── symbol_name ───────────────────────────────────────────────────────────────

function checkSymbolName(
  db: Database.Database,
  rule: RuleDefinition,
  forbidden: RuleForbidden,
  changed?: string[],
): RulesViolation[] {
  if (!forbidden.pattern) return [];

  const nameRegex = new RegExp(`^(${forbidden.pattern})$`);
  // scope: "exported" (default) → only exported symbols
  //        "top-level" / "any" → exported + internal top-level (no container)
  // Phase 1: "any" behaves like "top-level" (local vars require Phase 2 AX extension)
  const scope = forbidden.scope ?? "exported";

  let sql = `SELECT name, kind, file_path, line, export, container FROM symbols`;
  if (scope === "exported") {
    sql += ` WHERE export = 'exported'`;
  } else {
    // top-level or any: include exported + internal but exclude nested symbols (those with a container)
    sql += ` WHERE (container IS NULL OR container = '')`;
  }
  sql += ` ORDER BY file_path, line`;

  const rows = db
    .prepare(sql)
    .all() as Array<{
    name: string;
    kind: string;
    file_path: string;
    line: number;
    export: string;
    container: string | null;
  }>;

  const violations: RulesViolation[] = [];

  for (const row of rows) {
    if (!matchesScope(row.file_path, forbidden, changed)) continue;
    if (!nameRegex.test(row.name)) continue;

    violations.push({
      ruleId: rule.id,
      ruleSeverity: rule.severity,
      ruleDescription: rule.description,
      adr: rule.adr,
      filePath: row.file_path,
      line: row.line,
      symbol: row.name,
      detail: `${row.kind} \`${row.name}\` declared — name matches forbidden pattern \`${forbidden.pattern}\``,
    });
  }

  return violations;
}

// ── import_pattern ────────────────────────────────────────────────────────────

function checkImportPattern(
  db: Database.Database,
  rule: RuleDefinition,
  forbidden: RuleForbidden,
  changed?: string[],
): RulesViolation[] {
  if (!forbidden.pattern) return [];

  const hasImportLine = hasTableColumn(db, "imports", "line");

  const rows = db
    .prepare(
      hasImportLine
        ? `SELECT source_file, module_specifier, target_file, line FROM imports ORDER BY source_file`
        : `SELECT source_file, module_specifier, target_file FROM imports ORDER BY source_file`,
    )
    .all() as Array<{
    source_file: string;
    module_specifier: string;
    target_file: string | null;
    line?: number | null;
  }>;

  const violations: RulesViolation[] = [];

  for (const row of rows) {
    if (!matchesScope(row.source_file, forbidden, changed)) continue;

    const specifierMatch = matchesImportPattern(
      row.module_specifier,
      forbidden.pattern,
      forbidden.regex,
    );
    const targetMatch = row.target_file
      ? minimatch(row.target_file, forbidden.pattern)
      : false;

    if (!specifierMatch && !targetMatch) continue;

    violations.push({
      ruleId: rule.id,
      ruleSeverity: rule.severity,
      ruleDescription: rule.description,
      adr: rule.adr,
      filePath: row.source_file,
      line: row.line ?? null,
      detail: `import of \`${row.module_specifier}\` matches forbidden pattern \`${forbidden.pattern}\``,
    });
  }

  return violations;
}

// ── variable_assignment ───────────────────────────────────────────────────────

function checkVariableAssignment(
  db: Database.Database,
  rule: RuleDefinition,
  forbidden: RuleForbidden,
  changed?: string[],
): RulesViolation[] {
  if (!forbidden.value_pattern) return [];

  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='variable_assignments'`,
    )
    .get();
  if (!tableExists) return [];

  let valueRegex: RegExp;
  try {
    valueRegex = new RegExp(forbidden.value_pattern);
  } catch {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT file, line, symbol_name, value_text, context FROM variable_assignments ORDER BY file, line`,
    )
    .all() as Array<{
    file: string;
    line: number;
    symbol_name: string;
    value_text: string;
    context: string | null;
  }>;

  const violations: RulesViolation[] = [];

  for (const row of rows) {
    if (!matchesScope(row.file, forbidden, changed)) continue;
    if (!valueRegex.test(row.value_text)) continue;

    violations.push({
      ruleId: rule.id,
      ruleSeverity: rule.severity,
      ruleDescription: rule.description,
      adr: rule.adr,
      filePath: row.file,
      line: row.line,
      detail: `variable \`${row.symbol_name}\` assigned value matching \`${forbidden.value_pattern}\`: ${row.value_text.slice(0, 80)}`,
    });
  }

  return violations;
}

// ── cypher (Phase 2: CypherLite + CARI graph projection) ─────────────────────

function checkCypherRule(
  db: Database.Database,
  rule: RuleDefinition,
  forbidden: RuleForbidden,
  changed?: string[],
): RulesViolation[] {
  if (!forbidden.query) return [];

  const query = forbidden.query.trim();
  if (!query) return [];

  const rows: Record<string, unknown>[] = [];

  try {
    if (looksLikeSql(query)) {
      rows.push(...(db.prepare(query).all() as Record<string, unknown>[]));
    } else {
      const transpiled = transpileCypher(parseCypher(query));
      for (const q of transpiled) {
        if (q.kind !== "read") continue;
        const sql = injectCariGraphCtes(q.sql);
        rows.push(...(db.prepare(sql).all(...q.params) as Record<string, unknown>[]));
      }
    }
  } catch {
    return [];
  }

  const violations: RulesViolation[] = [];

  for (const row of rows) {
    if (typeof row.file !== "string") continue;
    if (!matchesScope(row.file, forbidden, changed)) continue;
    violations.push({
      ruleId: rule.id,
      ruleSeverity: rule.severity,
      ruleDescription: rule.description,
      adr: rule.adr,
      filePath: row.file,
      line: typeof row.line === "number" ? row.line : null,
      detail: typeof row.detail === "string" ? row.detail : (rule.description ?? rule.id),
    });
  }

  return violations;
}

function looksLikeSql(query: string): boolean {
  return /^\s*(select|with|pragma|explain)\b/i.test(query);
}

function injectCariGraphCtes(sql: string): string {
  const entitiesCte = `
kg_entities AS (
  SELECT
    'file:' || path AS id,
    'FILE' AS type,
    path AS name,
    path,
    path AS file,
    NULL AS line,
    COALESCE(doc_group, '') AS layer,
    NULL AS fan_in
  FROM files
  UNION ALL
  SELECT
    'symbol:' || id AS id,
    'SYMBOL' AS type,
    name,
    file_path AS path,
    file_path AS file,
    line,
    NULL AS layer,
    (
      SELECT COUNT(*)
      FROM symbol_calls sc
      WHERE sc.callee_id = symbols.id
         OR (sc.callee_id IS NULL AND sc.callee_name = symbols.name)
    ) AS fan_in
  FROM symbols
  UNION ALL
  SELECT
    'doc:' || id AS id,
    'DOCSPAN' AS type,
    text AS name,
    doc_path AS path,
    doc_path AS file,
    line,
    NULL AS layer,
    NULL AS fan_in
  FROM annotations
)`.trim();

  const relsCte = `
kg_relationships AS (
  SELECT
    'imp:' || id AS id,
    'file:' || source_file AS from_id,
    'file:' || target_file AS to_id,
    'IMPORTS' AS predicate
  FROM imports
  WHERE target_file IS NOT NULL
  UNION ALL
  SELECT
    'ann:' || id AS id,
    'symbol:' || symbol_id AS from_id,
    'doc:' || id AS to_id,
    'ANNOTATED_BY' AS predicate
  FROM annotations
  WHERE symbol_id IS NOT NULL
  UNION ALL
  SELECT
    'cooc:' || entity_a || '|' || entity_b || '|' || source AS id,
    CASE
      WHEN EXISTS (SELECT 1 FROM files f WHERE f.path = co.entity_a) THEN 'file:' || co.entity_a
      WHEN EXISTS (SELECT 1 FROM symbols s WHERE s.id = co.entity_a) THEN 'symbol:' || co.entity_a
      ELSE 'term:' || co.entity_a
    END AS from_id,
    CASE
      WHEN EXISTS (SELECT 1 FROM files f WHERE f.path = co.entity_b) THEN 'file:' || co.entity_b
      WHEN EXISTS (SELECT 1 FROM symbols s WHERE s.id = co.entity_b) THEN 'symbol:' || co.entity_b
      ELSE 'term:' || co.entity_b
    END AS to_id,
    'CO_OCCURS' AS predicate
  FROM co_occurrences co
  UNION ALL
  SELECT
    'coc:' || file_a || '|' || file_b AS id,
    'file:' || file_a AS from_id,
    'file:' || file_b AS to_id,
    'CO_CHANGES' AS predicate
  FROM co_changes
)`.trim();

  if (/^\s*WITH\b/i.test(sql)) {
    return sql.replace(/^\s*WITH\s+/i, `WITH ${entitiesCte}, ${relsCte}, `);
  }

  return `WITH ${entitiesCte}, ${relsCte} ${sql}`;
}

function hasTableColumn(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function matchesImportPattern(
  value: string,
  pattern: string,
  isRegex = false,
): boolean {
  if (isRegex) {
    try {
      // Accept either plain regex source or /.../ form.
      const src =
        pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")
          ? pattern.slice(1, -1)
          : pattern;
      return new RegExp(src).test(value);
    } catch {
      return false;
    }
  }

  // 13.6: module specifier matching is prefix-aware when pattern ends with `**`.
  if (pattern.endsWith("**")) {
    const prefix = pattern.slice(0, -2);
    if (!/[?*\[\]]/.test(prefix) && value.startsWith(prefix)) {
      return true;
    }
  }

  // 13.6: for module specifiers, `**` should cross `/` separators.
  const crossSlashPattern = pattern.replaceAll("**", "{*,**/*}");

  return minimatch(value, crossSlashPattern, {
    matchBase: true,
    noglobstar: false,
  });
}

// ── Scope helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true if this file should be checked given the forbidden clause's
 * `in` / `except` scope and the incremental `changed` list.
 */
function matchesScope(
  filePath: string,
  forbidden: RuleForbidden,
  changed?: string[],
): boolean {
  // Incremental CI: only check changed files
  if (changed && changed.length > 0) {
    if (
      !changed.some(
        (c) => filePath === c || filePath.endsWith(c) || c.endsWith(filePath),
      )
    ) {
      return false;
    }
  }

  // `in` scope filter
  if (forbidden.in) {
    const includes = Array.isArray(forbidden.in) ? forbidden.in : [forbidden.in];
    if (!includes.some((pat) => minimatch(filePath, pat))) return false;
  }

  // `except` exclusions
  if (forbidden.except) {
    const exceptions = Array.isArray(forbidden.except)
      ? forbidden.except
      : [forbidden.except];
    if (exceptions.some((ex) => minimatch(filePath, ex))) return false;
  }

  return true;
}

/**
 * Match a property access chain against a glob pattern.
 *
 * The glob uses `**` as a wildcard for any number of segments.
 * E.g. `**.source.path` matches `entity.source.path`, `x.y.source.path`, etc.
 * E.g. `**.$ref` matches `r.ecu.$ref`, `a.$ref`, etc.
 *
 * Implementation: convert the glob to a regex.
 */
function matchesChainGlob(chain: string, glob: string): boolean {
  // Step 1: escape all regex special characters EXCEPT `*` (which we handle below).
  // This preserves `$`, `^`, `(`, `)`, `[`, etc. that may appear in property names.
  const safeGlob = glob.replace(/[.^$+?()\[\]{}|\\]/g, "\\$&");

  // Step 2: convert glob wildcards to regex equivalents.
  //   **  → .*     (match any number of segments including dots)
  //   *   → [^.]*  (match one segment, no dots)
  const pattern = safeGlob
    .replace(/\*\*/g, "\x00") // placeholder for ** (avoids double-processing)
    .replace(/\*/g, "[^.]*") // single * = one dot-free segment
    .replace(/\x00/g, ".*"); // ** = anything including dots

  try {
    const re = new RegExp(`^${pattern}$`);
    return re.test(chain);
  } catch {
    return false;
  }
}
