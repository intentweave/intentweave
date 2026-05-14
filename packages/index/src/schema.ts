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
  implements TEXT,
  deprecated INTEGER NOT NULL DEFAULT 0,
  deprecated_note TEXT,
  is_internal INTEGER NOT NULL DEFAULT 0,
  decorators TEXT
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
  char_start INTEGER,
  char_end INTEGER,
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
  doc_group TEXT,
  indexed INTEGER NOT NULL DEFAULT 1,
  skip_reason TEXT,
  comment_lines INTEGER NOT NULL DEFAULT 0,
  code_lines INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  target_file TEXT,
  module_specifier TEXT NOT NULL,
  line INTEGER,
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

-- Semantic usage tables (13.1)

CREATE TABLE IF NOT EXISTS symbol_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_file  TEXT NOT NULL,
  caller_name  TEXT,
  caller_line  INTEGER,
  callee_name  TEXT NOT NULL,
  callee_id    TEXT,
  is_method    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS property_accesses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file        TEXT NOT NULL,
  symbol_name TEXT,
  line        INTEGER,
  chain       TEXT NOT NULL,
  root        TEXT NOT NULL,
  depth       INTEGER NOT NULL
);

-- Type assertion inventory (14.3)

CREATE TABLE IF NOT EXISTS type_assertions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file        TEXT NOT NULL,
  line        INTEGER,
  kind        TEXT NOT NULL,
  context     TEXT,
  target_type TEXT
);

-- ADR conformance snapshots (14.5)

CREATE TABLE IF NOT EXISTS conformance_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id     TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,
  rule_id         TEXT NOT NULL,
  adr             TEXT,
  files_in_scope  INTEGER,
  files_clean     INTEGER,
  violation_count INTEGER NOT NULL DEFAULT 0,
  conformance_pct REAL
);

-- Test descriptions (14.6)

CREATE TABLE IF NOT EXISTS test_descriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  description TEXT NOT NULL
);

-- Variable assignments with RHS text (13.10)

CREATE TABLE IF NOT EXISTS variable_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  symbol_name TEXT NOT NULL,
  value_text  TEXT NOT NULL,
  context     TEXT
);

-- Intra-function def-use chains (16.1)

CREATE TABLE IF NOT EXISTS def_use_chains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file        TEXT NOT NULL,
  function    TEXT,
  def_line    INTEGER NOT NULL,
  var_name    TEXT NOT NULL,
  use_line    INTEGER NOT NULL,
  use_context TEXT NOT NULL
);

-- Indexes for retrieval

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_body_hash ON symbols(body_hash);
CREATE INDEX IF NOT EXISTS idx_symbols_structure_hash ON symbols(structure_hash);
CREATE INDEX IF NOT EXISTS idx_symbols_deprecated ON symbols(deprecated);
CREATE INDEX IF NOT EXISTS idx_symbols_is_internal ON symbols(is_internal);
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
CREATE INDEX IF NOT EXISTS idx_calls_caller_file ON symbol_calls(caller_file);
CREATE INDEX IF NOT EXISTS idx_calls_callee_name ON symbol_calls(callee_name);
CREATE INDEX IF NOT EXISTS idx_calls_callee_id ON symbol_calls(callee_id);
CREATE INDEX IF NOT EXISTS idx_prop_access_file ON property_accesses(file);
CREATE INDEX IF NOT EXISTS idx_prop_access_chain ON property_accesses(chain);
CREATE INDEX IF NOT EXISTS idx_prop_access_root ON property_accesses(root);
CREATE INDEX IF NOT EXISTS idx_type_assertions_file ON type_assertions(file);
CREATE INDEX IF NOT EXISTS idx_type_assertions_kind ON type_assertions(kind);
CREATE INDEX IF NOT EXISTS idx_conformance_snapshots_rule ON conformance_snapshots(rule_id);
CREATE INDEX IF NOT EXISTS idx_conformance_snapshots_snapshot ON conformance_snapshots(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_test_descriptions_file ON test_descriptions(file);
CREATE INDEX IF NOT EXISTS idx_test_descriptions_kind ON test_descriptions(kind);
CREATE INDEX IF NOT EXISTS idx_var_assign_file ON variable_assignments(file);
CREATE INDEX IF NOT EXISTS idx_var_assign_symbol ON variable_assignments(symbol_name);
CREATE INDEX IF NOT EXISTS idx_def_use_file ON def_use_chains(file);
CREATE INDEX IF NOT EXISTS idx_def_use_var ON def_use_chains(var_name);
CREATE INDEX IF NOT EXISTS idx_def_use_def_line ON def_use_chains(def_line);

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

-- KG tables (Selective Semantic Enrichment — 11.8)

CREATE TABLE IF NOT EXISTS kg_entities (
  id          INTEGER PRIMARY KEY,
  canon_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  aliases     TEXT,
  confidence  REAL DEFAULT 1.0,
  artifact_id TEXT,
  source_file TEXT,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS kg_relationships (
  id          INTEGER PRIMARY KEY,
  from_id     INTEGER NOT NULL REFERENCES kg_entities(id),
  to_id       INTEGER NOT NULL REFERENCES kg_entities(id),
  predicate   TEXT NOT NULL,
  confidence  REAL DEFAULT 1.0,
  raw_predicate TEXT,
  artifact_id TEXT,
  source_file TEXT
);

CREATE TABLE IF NOT EXISTS kg_raw_triples (
  id               INTEGER PRIMARY KEY,
  subject          TEXT,
  predicate        TEXT,
  object           TEXT,
  subject_kind     TEXT,
  object_kind      TEXT,
  confidence       REAL,
  source_file      TEXT,
  artifact_id      TEXT,
  subject_canon_id TEXT,
  object_canon_id  TEXT
);

CREATE TABLE IF NOT EXISTS enrichment_meta (
  file_path    TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  enriched_at  TEXT NOT NULL,
  entity_count INTEGER NOT NULL DEFAULT 0,
  triple_count INTEGER NOT NULL DEFAULT 0,
  impact_score REAL
);

CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(name);
CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(type);
CREATE INDEX IF NOT EXISTS idx_kg_entities_canon_id ON kg_entities(canon_id);
CREATE INDEX IF NOT EXISTS idx_kg_entities_source ON kg_entities(source_file);
CREATE INDEX IF NOT EXISTS idx_kg_rels_from ON kg_relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_kg_rels_to ON kg_relationships(to_id);
CREATE INDEX IF NOT EXISTS idx_kg_rels_predicate ON kg_relationships(predicate);
CREATE INDEX IF NOT EXISTS idx_kg_raw_source ON kg_raw_triples(source_file);

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

  // Backward-compatible migration: older indexes may not have imports.line.
  const importsCols = db.prepare(`PRAGMA table_info(imports)`).all() as Array<{
    name: string;
  }>;
  const hasImportLine = importsCols.some((c) => c.name === "line");
  if (!hasImportLine) {
    db.exec(`ALTER TABLE imports ADD COLUMN line INTEGER`);
  }

  // Store schema version
  db.prepare(
    `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '13')`,
  ).run();
}
