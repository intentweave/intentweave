// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: deprecatedCallers (14.1)
 *
 * Cross-references symbols marked @deprecated (in the `symbols` table) against
 * `symbol_calls` (13.1) to find all active callers of deprecated symbols.
 *
 * $0 / no LLM — pure SQLite queries after index build.
 */

import type Database from "better-sqlite3";
import type { DeprecatedCallersResult } from "../types.js";
import { openIndex } from "./shared.js";

// ── Options ───────────────────────────────────────────────────────────────────

export interface DeprecatedCallersOptions {
  /** Only report callers in these files (incremental CI) */
  changed?: string[];
  /** Maximum caller entries to return */
  limit?: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function deprecatedCallers(
  dbPath: string,
  opts: DeprecatedCallersOptions = {},
): DeprecatedCallersResult {
  const db = openIndex(dbPath);
  try {
    return deprecatedCallersFromDb(db, opts);
  } finally {
    db.close();
  }
}

export function deprecatedCallersFromDb(
  db: Database.Database,
  opts: DeprecatedCallersOptions = {},
): DeprecatedCallersResult {
  // Guard: if symbol_calls table doesn't exist (old index), return empty
  const tableExists =
    (db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbol_calls'`,
      )
      .get() as { 1: number } | undefined) !== undefined;

  if (!tableExists) {
    return {
      callers: [],
      totalCallers: 0,
      deprecatedSymbols: 0,
      symbolsWithCallers: 0,
    };
  }

  // Fetch all @deprecated symbols
  const deprecatedRows = db
    .prepare(
      `SELECT id, name, file_path, line, deprecated_note
       FROM symbols
       WHERE deprecated = 1
       ORDER BY name`,
    )
    .all() as Array<{
    id: string;
    name: string;
    file_path: string;
    line: number;
    deprecated_note: string | null;
  }>;

  if (deprecatedRows.length === 0) {
    return {
      callers: [],
      totalCallers: 0,
      deprecatedSymbols: 0,
      symbolsWithCallers: 0,
    };
  }

  const limit = opts.limit ?? 200;
  const changedSet = opts.changed ? new Set(opts.changed) : null;

  const results: DeprecatedCallersResult["callers"] = [];
  let totalCallers = 0;
  let symbolsWithCallers = 0;

  for (const sym of deprecatedRows) {
    // Find callers of this deprecated symbol by callee_name match
    const callerRows = db
      .prepare(
        `SELECT caller_file, caller_name, caller_line
         FROM symbol_calls
         WHERE callee_name = ? OR callee_id = ?
         ORDER BY caller_file, caller_line`,
      )
      .all(sym.name, sym.id) as Array<{
      caller_file: string;
      caller_name: string | null;
      caller_line: number | null;
    }>;

    let filtered = callerRows;
    if (changedSet) {
      filtered = callerRows.filter((r) => changedSet.has(r.caller_file));
    }

    if (filtered.length === 0) continue;

    symbolsWithCallers++;
    totalCallers += filtered.length;

    results.push({
      symbolId: sym.id,
      symbolName: sym.name,
      symbolFile: sym.file_path,
      symbolLine: sym.line,
      deprecatedNote: sym.deprecated_note ?? undefined,
      callers: filtered.slice(0, limit).map((r) => ({
        callerFile: r.caller_file,
        callerName: r.caller_name ?? undefined,
        callerLine: r.caller_line ?? undefined,
      })),
    });
  }

  return {
    callers: results,
    totalCallers,
    deprecatedSymbols: deprecatedRows.length,
    symbolsWithCallers,
  };
}
