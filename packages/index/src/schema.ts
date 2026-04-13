// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI SQLite Schema
 *
 * Defines all CREATE TABLE / INDEX / FTS5 statements for the
 * code-aware retrieval index. Called once when creating a new index.db.
 */

import type Database from "better-sqlite3";

/**
 * SQL statements executed in order to create the CARI schema.
 */
const SCHEMA_SQL = `
-- Core tables

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  container TEXT,
  signature TEXT,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER,
  export TEXT NOT NULL,
  doc_summary TEXT,
  body_hash TEXT,
  body_lines INTEGER,
  structure_hash TEXT,
  implements TEXT
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  text TEXT NOT NULL,
  symbol_id TEXT,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  qualifier TEXT,
  idf_score REAL,
  FOREIGN KEY (symbol_id) REFERENCES symbols(id)
);

CREATE TABLE IF NOT EXISTS co_occurrences (
  entity_a TEXT NOT NULL,
  entity_b TEXT NOT NULL,
  count INTEGER NOT NULL,
  score REAL NOT NULL,
  source TEXT NOT NULL,
  file_paths TEXT,
  PRIMARY KEY (entity_a, entity_b, source)
);

CREATE TABLE IF NOT EXISTS co_changes (
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  count INTEGER NOT NULL,
  jaccard REAL NOT NULL,
  recency REAL NOT NULL,
  commit_hashes TEXT,
  PRIMARY KEY (file_a, file_b)
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  last_modified TEXT,
  churn INTEGER,
  is_hotspot BOOLEAN,
  primary_owner TEXT,
  bus_factor INTEGER,
  is_doc BOOLEAN,
  content_hash TEXT,
  doc_group TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  target_file TEXT,
  module_specifier TEXT NOT NULL,
  is_relative BOOLEAN NOT NULL,
  imported_names TEXT
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rationale (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  symbol TEXT
);

-- Indexes for retrieval

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_body_hash ON symbols(body_hash);
CREATE INDEX IF NOT EXISTS idx_symbols_structure_hash ON symbols(structure_hash);
CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(doc_path);
CREATE INDEX IF NOT EXISTS idx_annotations_symbol ON annotations(symbol_id);
CREATE INDEX IF NOT EXISTS idx_annotations_confidence ON annotations(confidence);
CREATE INDEX IF NOT EXISTS idx_co_occurrences_score ON co_occurrences(score);
CREATE INDEX IF NOT EXISTS idx_co_changes_jaccard ON co_changes(jaccard);
CREATE INDEX IF NOT EXISTS idx_files_doc ON files(is_doc);
CREATE INDEX IF NOT EXISTS idx_files_doc_group ON files(doc_group);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_file);
CREATE INDEX IF NOT EXISTS idx_imports_target ON imports(target_file);
CREATE INDEX IF NOT EXISTS idx_todos_file ON todos(file_path);
CREATE INDEX IF NOT EXISTS idx_todos_kind ON todos(kind);
CREATE INDEX IF NOT EXISTS idx_rationale_file ON rationale(file_path);
CREATE INDEX IF NOT EXISTS idx_rationale_kind ON rationale(kind);

-- Full-text search

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, doc_summary,
  content=symbols
);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(
  text,
  content=annotations
);

-- External entities (Entity Bridge)

CREATE TABLE IF NOT EXISTS external_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  aliases TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_external_entities_name ON external_entities(name);
CREATE INDEX IF NOT EXISTS idx_external_entities_type ON external_entities(type);

-- Metadata table for schema version tracking

CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Initialize the CARI schema on a fresh database.
 * Safe to call on an existing database (IF NOT EXISTS guards).
 */
export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  // Store schema version
  db.prepare(
    `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '4')`,
  ).run();
}
