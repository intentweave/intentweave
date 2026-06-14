// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: skippedFiles (6.5)
 *
 * Returns the list of source files that were skipped during AX extraction
 * (e.g. because they exceeded the --max-file-size threshold).
 *
 * These files are recorded in the files table with indexed=0.
 *
 * No LLM or Neo4j needed — queries the local SQLite index.
 */

import type Database from "@intentweave/sqlite-compat";
import type { SkippedFilesResult, SkippedFileEntry } from "../types.js";
import { openIndex } from "./shared.js";

export function skippedFiles(dbPath: string): SkippedFilesResult {
  const db = openIndex(dbPath);
  try {
    return skippedFilesFromDb(db);
  } finally {
    db.close();
  }
}

export function skippedFilesFromDb(db: Database.Database): SkippedFilesResult {
  // Check column exists (absent on indexes built before schema v6)
  const columnExists =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM pragma_table_info('files') WHERE name='indexed'`,
        )
        .get() as { cnt: number }
    ).cnt > 0;

  if (!columnExists) {
    return { skipped: [], totalSkipped: 0 };
  }

  const rows = db
    .prepare(
      `
      SELECT path, skip_reason
      FROM files
      WHERE indexed = 0
      ORDER BY path
    `,
    )
    .all() as Array<{ path: string; skip_reason: string | null }>;

  const skipped: SkippedFileEntry[] = rows.map((r) => ({
    filePath: r.path,
    reason: r.skip_reason ?? "unknown",
  }));

  return { skipped, totalSkipped: skipped.length };
}
