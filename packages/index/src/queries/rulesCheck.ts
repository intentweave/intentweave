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

  const rows = db
    .prepare(
      `SELECT name, kind, file_path, line, export FROM symbols ORDER BY file_path, line`,
    )
    .all() as Array<{
    name: string;
    kind: string;
    file_path: string;
    line: number;
    export: string;
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

  const rows = db
    .prepare(
      `SELECT source_file, module_specifier, target_file FROM imports ORDER BY source_file`,
    )
    .all() as Array<{
    source_file: string;
    module_specifier: string;
    target_file: string | null;
  }>;

  const violations: RulesViolation[] = [];

  for (const row of rows) {
    if (!matchesScope(row.source_file, forbidden, changed)) continue;

    const specifierMatch = minimatch(row.module_specifier, forbidden.pattern, {
      matchBase: true,
    });
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
      line: null,
      detail: `import of \`${row.module_specifier}\` matches forbidden pattern \`${forbidden.pattern}\``,
    });
  }

  return violations;
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
    if (!minimatch(filePath, forbidden.in)) return false;
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
 *
 * Implementation: convert the glob to a regex.
 */
function matchesChainGlob(chain: string, glob: string): boolean {
  // Convert chain glob to regex:
  //   **  → .*   (match any prefix, including dots)
  //   *   → [^.]*  (match one segment, no dots)
  //   .   → \.   (literal dot)
  const escaped = glob
    .replace(/\*\*/g, "\x00") // placeholder for **
    .replace(/\*/g, "[^.]*") // * = one segment
    .replace(/\x00/g, ".*") // ** = anything
    .replace(/\./g, "\\."); // literal dots (after ** handling)

  // Re-escape the dots in the segment-level replacement
  // (they were already escaped above before replacing ** markers)
  try {
    const re = new RegExp(`^${escaped}$`);
    return re.test(chain);
  } catch {
    return false;
  }
}
