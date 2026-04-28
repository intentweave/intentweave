// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: commentCodeRatio (6.4)
 *
 * Analyses the comment-to-code ratio for each indexed source file and
 * flags anomalies (under-commented or over-commented files).
 *
 * Files with fewer than 5 code lines are excluded (too small to be meaningful).
 * Anomaly thresholds:
 *   - under-commented: ratio < average * 0.3
 *   - over-commented:  ratio > average * 3.0  (and > 0.5 absolute)
 *
 * No LLM or Neo4j needed — reads comment_lines / code_lines columns
 * written to the files table during AX extraction.
 */

import type Database from "better-sqlite3";
import type {
  CommentCodeRatioResult,
  CommentCodeRatioEntry,
} from "../types.js";
import { openIndex } from "./shared.js";

const MIN_CODE_LINES = 5;
const UNDER_COMMENTED_FACTOR = 0.3;
const OVER_COMMENTED_FACTOR = 3.0;
const OVER_COMMENTED_MIN_RATIO = 0.5;

export function commentCodeRatio(dbPath: string): CommentCodeRatioResult {
  const db = openIndex(dbPath);
  try {
    return commentCodeRatioFromDb(db);
  } finally {
    db.close();
  }
}

export function commentCodeRatioFromDb(
  db: Database.Database,
): CommentCodeRatioResult {
  // Check column exists (may be absent on older indexes)
  const columnExists =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM pragma_table_info('files') WHERE name='comment_lines'`,
        )
        .get() as { cnt: number }
    ).cnt > 0;

  if (!columnExists) {
    return { files: [], anomalies: [], averageRatio: 0, totalFiles: 0 };
  }

  const rows = db
    .prepare(
      `
      SELECT path, comment_lines, code_lines
      FROM files
      WHERE is_doc = 0
        AND indexed = 1
        AND code_lines >= ${MIN_CODE_LINES}
      ORDER BY path
    `,
    )
    .all() as Array<{
    path: string;
    comment_lines: number;
    code_lines: number;
  }>;

  if (rows.length === 0) {
    return { files: [], anomalies: [], averageRatio: 0, totalFiles: 0 };
  }

  // Compute per-file ratios
  const entries: CommentCodeRatioEntry[] = rows.map((r) => ({
    filePath: r.path,
    commentLines: r.comment_lines,
    codeLines: r.code_lines,
    ratio: r.comment_lines / r.code_lines,
    anomaly: null,
  }));

  // Workspace average
  const totalRatio = entries.reduce((s, e) => s + e.ratio, 0);
  const averageRatio = totalRatio / entries.length;

  // Flag anomalies
  for (const e of entries) {
    if (e.ratio < averageRatio * UNDER_COMMENTED_FACTOR) {
      e.anomaly = "under-commented";
    } else if (
      e.ratio > averageRatio * OVER_COMMENTED_FACTOR &&
      e.ratio > OVER_COMMENTED_MIN_RATIO
    ) {
      e.anomaly = "over-commented";
    }
  }

  const anomalies = entries.filter((e) => e.anomaly !== null);

  return {
    files: entries,
    anomalies,
    averageRatio,
    totalFiles: entries.length,
  };
}
