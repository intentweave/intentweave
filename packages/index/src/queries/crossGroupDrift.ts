// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: crossGroupDrift
 *
 * Compare entity coverage across doc groups.
 * Flag when two groups describe the same entity with conflicting
 * qualifiers or divergent detail level.
 */

import type Database from "better-sqlite3";
import type { CrossGroupDriftResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Detect cross-group documentation drift.
 */
export function crossGroupDrift(dbPath: string): CrossGroupDriftResult {
  const db = openIndex(dbPath);
  try {
    return crossGroupDriftFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core cross-group drift logic against an open database.
 */
export function crossGroupDriftFromDb(
  db: Database.Database,
): CrossGroupDriftResult {
  // Find entities mentioned in multiple doc groups
  const rows = db
    .prepare(
      `
      SELECT
        a.text AS entity,
        f.doc_group,
        a.doc_path,
        a.qualifier,
        COUNT(*) AS mention_count
      FROM annotations a
      JOIN files f ON a.doc_path = f.path
      WHERE f.doc_group IS NOT NULL
        AND a.symbol_id IS NOT NULL
        AND a.confidence >= 0.5
      GROUP BY a.text, f.doc_group, a.doc_path, a.qualifier
      ORDER BY a.text, f.doc_group
    `,
    )
    .all() as Array<{
    entity: string;
    doc_group: string;
    doc_path: string;
    qualifier: string | null;
    mention_count: number;
  }>;

  // Group by entity
  const entityMap = new Map<
    string,
    Map<
      string,
      { docPaths: Set<string>; mentionCount: number; qualifiers: Set<string> }
    >
  >();

  for (const row of rows) {
    if (!entityMap.has(row.entity)) {
      entityMap.set(row.entity, new Map());
    }
    const groupMap = entityMap.get(row.entity)!;
    if (!groupMap.has(row.doc_group)) {
      groupMap.set(row.doc_group, {
        docPaths: new Set(),
        mentionCount: 0,
        qualifiers: new Set(),
      });
    }
    const entry = groupMap.get(row.doc_group)!;
    entry.docPaths.add(row.doc_path);
    entry.mentionCount += row.mention_count;
    if (row.qualifier) entry.qualifiers.add(row.qualifier);
  }

  const drifts: CrossGroupDriftResult["drifts"] = [];

  for (const [entity, groupMap] of entityMap) {
    // Only interested in entities mentioned in 2+ groups
    if (groupMap.size < 2) continue;

    const groups = [...groupMap.entries()].map(([docGroup, data]) => ({
      docGroup,
      docPaths: [...data.docPaths],
      mentionCount: data.mentionCount,
      qualifiers: [...data.qualifiers],
    }));

    // Detect qualifier conflicts
    const allQualifiers = new Set<string>();
    for (const g of groups) {
      for (const q of g.qualifiers) allQualifiers.add(q);
    }

    // Detect mention count imbalance (one group mentions entity much more than another)
    const counts = groups.map((g) => g.mentionCount);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);
    const imbalance = maxCount > 0 ? (maxCount - minCount) / maxCount : 0;

    // Build reason
    const reasons: string[] = [];
    if (allQualifiers.size > 1) {
      reasons.push(`conflicting qualifiers: ${[...allQualifiers].join(", ")}`);
    }
    if (imbalance > 0.5) {
      reasons.push(`coverage imbalance: ${minCount} vs ${maxCount} mentions`);
    }
    if (reasons.length === 0) {
      reasons.push(
        `mentioned in ${groups.length} doc groups: ${groups.map((g) => g.docGroup).join(", ")}`,
      );
    }

    drifts.push({
      entity,
      groups,
      reason: reasons.join("; "),
    });
  }

  // Sort by number of groups (most cross-referenced first)
  drifts.sort((a, b) => b.groups.length - a.groups.length);

  return { drifts, totalDrifts: drifts.length };
}
