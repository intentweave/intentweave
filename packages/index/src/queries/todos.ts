// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: todos
 *
 * Inventory of TODO / FIXME / HACK / XXX markers extracted during AX.
 */

import type Database from "better-sqlite3";
import type { TodosResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Retrieve the full TODO/FIXME inventory from the index.
 */
export function todos(dbPath: string): TodosResult {
  const db = openIndex(dbPath);
  try {
    return todosFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core TODO inventory logic against an open database.
 */
export function todosFromDb(db: Database.Database): TodosResult {
  const rows = db
    .prepare(
      `
      SELECT file_path, line, kind, text
      FROM todos
      ORDER BY kind, file_path, line
    `,
    )
    .all() as Array<{
    file_path: string;
    line: number;
    kind: string;
    text: string;
  }>;

  const byKind: Record<string, number> = {};
  const todoItems = rows.map((r) => {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    return {
      filePath: r.file_path,
      line: r.line,
      kind: r.kind,
      text: r.text,
    };
  });

  return {
    todos: todoItems,
    totalCount: todoItems.length,
    byKind,
  };
}
