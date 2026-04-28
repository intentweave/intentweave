// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * ADR Conformance Trend (14.5)
 *
 * Reads conformance_snapshots rows and computes per-rule trend data.
 * Trend direction is determined by comparing the first vs. last snapshot
 * within the requested time window.
 */

import Database from "better-sqlite3";
import type {
  RulesTrendResult,
  RuleTrend,
  ConformanceSnapshot,
} from "../types.js";

export interface RulesTrendOptions {
  /** Time window in days (default: 30) */
  days?: number;
  /** Filter to a single rule id */
  ruleId?: string;
}

export function rulesTrend(
  dbPath: string,
  opts: RulesTrendOptions = {},
): RulesTrendResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    return rulesTrendFromDb(db, opts);
  } finally {
    db.close();
  }
}

export function rulesTrendFromDb(
  db: Database.Database,
  opts: RulesTrendOptions = {},
): RulesTrendResult {
  const { days = 30, ruleId } = opts;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const whereClause = ruleId
    ? `WHERE timestamp >= ? AND rule_id = ?`
    : `WHERE timestamp >= ?`;
  const params: unknown[] = ruleId ? [since, ruleId] : [since];

  const rows = db
    .prepare(
      `SELECT snapshot_id, timestamp, rule_id, adr,
              files_in_scope, files_clean, violation_count, conformance_pct
       FROM conformance_snapshots
       ${whereClause}
       ORDER BY rule_id, timestamp ASC`,
    )
    .all(...params) as Array<{
    snapshot_id: string;
    timestamp: number;
    rule_id: string;
    adr: string | null;
    files_in_scope: number;
    files_clean: number;
    violation_count: number;
    conformance_pct: number;
  }>;

  // Group by rule_id
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!grouped.has(row.rule_id)) grouped.set(row.rule_id, []);
    grouped.get(row.rule_id)!.push(row);
  }

  const rules: RuleTrend[] = [];
  for (const [rid, snapRows] of grouped) {
    const snapshots: ConformanceSnapshot[] = snapRows.map((r) => ({
      snapshotId: r.snapshot_id,
      timestamp: r.timestamp,
      ruleId: r.rule_id,
      adr: r.adr ?? undefined,
      filesInScope: r.files_in_scope,
      filesClean: r.files_clean,
      violationCount: r.violation_count,
      conformancePct: r.conformance_pct,
    }));

    const trend = computeTrend(snapshots);

    rules.push({
      ruleId: rid,
      adr: snapRows[0].adr ?? undefined,
      snapshots,
      trend,
    });
  }

  return { rules, days };
}

function computeTrend(snapshots: ConformanceSnapshot[]): RuleTrend["trend"] {
  if (snapshots.length < 2) return "insufficient_data";
  const first = snapshots[0].conformancePct;
  const last = snapshots[snapshots.length - 1].conformancePct;
  const delta = last - first;
  if (Math.abs(delta) < 1) return "stable";
  return delta > 0 ? "improving" : "worsening";
}
