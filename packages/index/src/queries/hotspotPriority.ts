// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: hotspotPriority
 *
 * Ranks code files by documentation urgency:
 *   priorityScore = churn × (1 − coveragePercent / 100)
 *
 * High-churn files with low documentation coverage appear first.
 */

import type Database from "better-sqlite3";
import type { HotspotPriorityResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Rank files by documentation priority.
 */
export function hotspotPriority(dbPath: string): HotspotPriorityResult {
  const db = openIndex(dbPath);
  try {
    return hotspotPriorityFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core hotspot priority logic against an open database.
 */
export function hotspotPriorityFromDb(
  db: Database.Database,
): HotspotPriorityResult {
  // Get code files with churn data
  const files = db
    .prepare(
      `
      SELECT path, churn
      FROM files
      WHERE is_doc = 0 AND churn IS NOT NULL AND churn > 0
    `,
    )
    .all() as Array<{ path: string; churn: number }>;

  const priorities: HotspotPriorityResult["priorities"] = [];

  const totalExportedStmt = db.prepare(
    `SELECT COUNT(*) AS cnt FROM symbols WHERE file_path = ? AND export = 'exported'`,
  );
  const documentedStmt = db.prepare(
    `
    SELECT COUNT(DISTINCT s.id) AS cnt
    FROM symbols s
    JOIN annotations a ON a.symbol_id = s.id
    WHERE s.file_path = ? AND s.export = 'exported' AND a.confidence >= 0.5
  `,
  );

  for (const file of files) {
    const totalExported = (totalExportedStmt.get(file.path) as { cnt: number })
      .cnt;
    if (totalExported === 0) continue;

    const documented = (documentedStmt.get(file.path) as { cnt: number }).cnt;
    const coveragePercent = (documented / totalExported) * 100;
    const priorityScore = file.churn * (1 - coveragePercent / 100);

    priorities.push({
      filePath: file.path,
      churn: file.churn,
      documentedSymbols: documented,
      totalExportedSymbols: totalExported,
      coveragePercent: Math.round(coveragePercent * 10) / 10,
      priorityScore: Math.round(priorityScore * 100) / 100,
    });
  }

  // Sort by priority score descending
  priorities.sort((a, b) => b.priorityScore - a.priorityScore);

  return { priorities };
}
