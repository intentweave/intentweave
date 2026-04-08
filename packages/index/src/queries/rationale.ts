// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 9.4 Rationale Extraction Query
 *
 * Read WHY/NOTE/IMPORTANT/DESIGN comments from the rationale table.
 * These are first-class knowledge nodes extracted during AX alongside
 * the existing TODO/FIXME/HACK markers.
 */

import type Database from "better-sqlite3";
import type { RationaleResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Query rationale comments from a database file path.
 */
export function rationale(dbPath: string): RationaleResult {
  const db = openIndex(dbPath);
  try {
    return rationaleFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Query rationale comments from an open database handle.
 */
export function rationaleFromDb(db: Database.Database): RationaleResult {
  // Check if rationale table exists (graceful handling for older indexes)
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='rationale'`,
    )
    .get();

  if (!tableExists) {
    return { rationale: [], totalCount: 0, byKind: {} };
  }

  const rows = db
    .prepare(
      `SELECT file_path, line, kind, text, symbol FROM rationale ORDER BY file_path, line`,
    )
    .all() as Array<{
    file_path: string;
    line: number;
    kind: string;
    text: string;
    symbol: string | null;
  }>;

  const byKind: Record<string, number> = {};
  const items = rows.map((row) => {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    return {
      filePath: row.file_path,
      line: row.line,
      kind: row.kind,
      text: row.text,
      symbol: row.symbol ?? undefined,
    };
  });

  return {
    rationale: items,
    totalCount: items.length,
    byKind,
  };
}
