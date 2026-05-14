// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Calls Query (Phase 4)
 *
 * Direct query over the `symbol_calls` table produced by the AX extractor.
 * Lets callers explore the call graph: who calls what, which symbols are
 * most-called, and what a specific file depends on at the call level.
 */

import Database from "better-sqlite3";
import { openIndex } from "./shared.js";

// =============================================================================
// Types
// =============================================================================

export interface CallsOptions {
  /** Filter by caller file path (substring match). */
  callerFile?: string;
  /** Filter by callee function/method name (substring match). */
  calleeName?: string;
  /** Filter by caller function/method name (substring match). */
  callerName?: string;
  /** Only return method calls (receiver.method()). */
  methodOnly?: boolean;
  /** Maximum edges to return (default: 100). */
  limit?: number;
}

export interface CallEdge {
  callerFile: string;
  callerName: string | null;
  callerLine: number | null;
  calleeName: string;
  calleeId: string | null;
  isMethod: boolean;
}

export interface CallsResult {
  edges: CallEdge[];
  total: number;
  /** Top callee names by call frequency (top 10). */
  topCallees: Array<{ calleeName: string; count: number }>;
}

// =============================================================================
// Implementation
// =============================================================================

export function callsFromDb(
  db: Database.Database,
  opts: CallsOptions = {},
): CallsResult {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.callerFile) {
    conditions.push("caller_file LIKE ?");
    params.push(`%${opts.callerFile}%`);
  }
  if (opts.calleeName) {
    conditions.push("callee_name LIKE ?");
    params.push(`%${opts.calleeName}%`);
  }
  if (opts.callerName) {
    conditions.push("caller_name LIKE ?");
    params.push(`%${opts.callerName}%`);
  }
  if (opts.methodOnly) {
    conditions.push("is_method = 1");
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 100;

  const rows = db
    .prepare<
      unknown[],
      {
        caller_file: string;
        caller_name: string | null;
        caller_line: number | null;
        callee_name: string;
        callee_id: string | null;
        is_method: number;
      }
    >(
      `SELECT caller_file, caller_name, caller_line, callee_name, callee_id, is_method
       FROM symbol_calls
       ${where}
       ORDER BY caller_file, caller_line
       LIMIT ?`,
    )
    .all([...params, limit]) as Array<{
    caller_file: string;
    caller_name: string | null;
    caller_line: number | null;
    callee_name: string;
    callee_id: string | null;
    is_method: number;
  }>;

  const countRow = db
    .prepare<
      unknown[],
      { cnt: number }
    >(`SELECT COUNT(*) as cnt FROM symbol_calls ${where}`)
    .get([...params]) as { cnt: number } | undefined;

  const topCallees = db
    .prepare<unknown[], { callee_name: string; cnt: number }>(
      `SELECT callee_name, COUNT(*) as cnt
       FROM symbol_calls
       ${where}
       GROUP BY callee_name
       ORDER BY cnt DESC
       LIMIT 10`,
    )
    .all([...params]) as Array<{ callee_name: string; cnt: number }>;

  return {
    edges: rows.map((r) => ({
      callerFile: r.caller_file,
      callerName: r.caller_name,
      callerLine: r.caller_line,
      calleeName: r.callee_name,
      calleeId: r.callee_id,
      isMethod: r.is_method === 1,
    })),
    total: countRow?.cnt ?? 0,
    topCallees: topCallees.map((r) => ({
      calleeName: r.callee_name,
      count: r.cnt,
    })),
  };
}

export function calls(dbPath: string, opts: CallsOptions = {}): CallsResult {
  const db = openIndex(dbPath);
  try {
    return callsFromDb(db, opts);
  } finally {
    db.close();
  }
}
