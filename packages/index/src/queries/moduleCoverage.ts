// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: moduleCoverage
 *
 * Roll up documentation coverage per directory/package.
 * Shows which modules are well-documented vs. under-documented.
 */

import type Database from "better-sqlite3";
import type { ModuleCoverageResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Compute documentation coverage per module (directory).
 */
export function moduleCoverage(dbPath: string): ModuleCoverageResult {
  const db = openIndex(dbPath);
  try {
    return moduleCoverageFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core module coverage logic against an open database.
 */
export function moduleCoverageFromDb(
  db: Database.Database,
): ModuleCoverageResult {
  // Get all exported symbols grouped by their directory
  const rows = db
    .prepare(
      `
      SELECT s.id, s.name, s.file_path
      FROM symbols s
      WHERE s.export = 'exported'
    `,
    )
    .all() as Array<{ id: string; name: string; file_path: string }>;

  // Build set of documented symbol IDs
  const documentedIds = new Set<string>();
  const docRows = db
    .prepare(
      `
      SELECT DISTINCT symbol_id
      FROM annotations
      WHERE symbol_id IS NOT NULL AND confidence >= 0.5
    `,
    )
    .all() as Array<{ symbol_id: string }>;
  for (const r of docRows) {
    documentedIds.add(r.symbol_id);
  }

  // Group by directory
  const moduleMap = new Map<string, { total: number; documented: number }>();

  for (const sym of rows) {
    const dir = sym.file_path.includes("/")
      ? sym.file_path.substring(0, sym.file_path.lastIndexOf("/"))
      : ".";

    if (!moduleMap.has(dir)) {
      moduleMap.set(dir, { total: 0, documented: 0 });
    }
    const entry = moduleMap.get(dir)!;
    entry.total++;
    if (documentedIds.has(sym.id)) {
      entry.documented++;
    }
  }

  const modules = [...moduleMap.entries()]
    .map(([module, data]) => ({
      module,
      totalExported: data.total,
      documented: data.documented,
      coveragePercent:
        data.total > 0
          ? Math.round((data.documented / data.total) * 1000) / 10
          : 0,
    }))
    .sort((a, b) => a.coveragePercent - b.coveragePercent); // worst first

  return { modules };
}
