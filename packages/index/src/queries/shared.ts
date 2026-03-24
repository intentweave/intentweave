// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helper for opening the CARI SQLite index read-only.
 */

import Database from "better-sqlite3";
import * as fs from "fs";

/**
 * Open the index database in read-only mode.
 * Throws if the file doesn't exist.
 */
export function openIndex(dbPath: string): Database.Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Index not found at ${dbPath}. Run \`iw index build\` first.`,
    );
  }
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  return db;
}
