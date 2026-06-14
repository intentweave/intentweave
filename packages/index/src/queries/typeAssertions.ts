// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Type Assertion Inventory (14.3)
 *
 * Queries the `type_assertions` table for `as any`, double casts, and
 * angle-bracket assertions. Cross-references the `imports` table to compute
 * a fan-in count per file as a risk signal.
 */

import Database from "@intentweave/sqlite-compat";
import type { TypeAssertionEntry, TypeAssertionsResult } from "../types.js";

export interface TypeAssertionsOptions {
  /** Filter by assertion kind */
  kind?: "as_any" | "double_cast" | "angle_cast" | "as_cast";
  /** Sort by fan-in descending (high-risk files first) */
  riskSort?: boolean;
  /** Maximum number of results */
  limit?: number;
  /** Fan-in threshold for "high risk" classification (default: 5) */
  riskThreshold?: number;
}

export function typeAssertions(
  dbPath: string,
  opts: TypeAssertionsOptions = {},
): TypeAssertionsResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    return typeAssertionsFromDb(db, opts);
  } finally {
    db.close();
  }
}

export function typeAssertionsFromDb(
  db: Database.Database,
  opts: TypeAssertionsOptions = {},
): TypeAssertionsResult {
  const { kind, riskSort = false, limit, riskThreshold = 5 } = opts;

  // Build fan-in map: file → number of times it's imported
  const fanInRows = db
    .prepare(
      `SELECT target_file AS file, COUNT(*) AS fan_in
       FROM imports
       WHERE target_file IS NOT NULL
       GROUP BY target_file`,
    )
    .all() as Array<{ file: string; fan_in: number }>;

  const fanInMap = new Map<string, number>();
  for (const row of fanInRows) {
    fanInMap.set(row.file, row.fan_in);
  }

  // Query type_assertions
  const whereClause = kind ? `WHERE kind = ?` : ``;
  const params: unknown[] = kind ? [kind] : [];

  const rows = db
    .prepare(
      `SELECT file, line, kind, context, target_type
       FROM type_assertions
       ${whereClause}
       ORDER BY file, line`,
    )
    .all(...params) as Array<{
    file: string;
    line: number;
    kind: string;
    context: string | null;
    target_type: string | null;
  }>;

  let entries: TypeAssertionEntry[] = rows.map((r) => ({
    file: r.file,
    line: r.line,
    kind: r.kind as TypeAssertionEntry["kind"],
    context: r.context,
    targetType: r.target_type,
    fanIn: fanInMap.get(r.file) ?? 0,
  }));

  if (riskSort) {
    entries.sort(
      (a, b) => (b.fanIn ?? 0) - (a.fanIn ?? 0) || a.file.localeCompare(b.file),
    );
  }

  if (limit !== undefined) {
    entries = entries.slice(0, limit);
  }

  const byKind: TypeAssertionsResult["byKind"] = {
    as_any: 0,
    double_cast: 0,
    angle_cast: 0,
    as_cast: 0,
  };
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }

  const highRisk = entries.filter((e) => (e.fanIn ?? 0) >= riskThreshold);

  return {
    assertions: entries,
    total: entries.length,
    byKind,
    highRisk,
  };
}
