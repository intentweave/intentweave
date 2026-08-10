// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI SQLite Schema
 *
 * Defines all CREATE TABLE / INDEX / FTS5 statements for the
 * code-aware retrieval index. Called once when creating a new index.db.
 */

import type Database from "@intentweave/sqlite-compat";

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

-- Semantic Capsule Layer (14.0)
-- Stores LLM-derived, evidence-grounded interpretations of symbols, call edges,
-- call paths, and component subgraphs.  Conceptually separate from raw CARI
-- evidence: these are *derived* artifacts, not facts.
--
-- capsule_kind:
--   symbol_summary   — purpose/inputs/outputs/concepts for one symbol
--   call_semantics   — why does A call B (role of the call edge)
--   path_summary     — narrative for a complete call path
--   subgraph_summary — component-level summary for a 2–N hop neighborhood
--
-- status: fresh | possibly_stale | stale
--   stale is set automatically when the target symbol's body_hash changes.
--
-- evidence_ids: JSON array of CARI entity IDs that were fed to the LLM.
-- content: JSON object with at minimum { "summary": string }.
--   For symbol_summary it may additionally carry:
--     purpose, inputs[], outputs[], sideEffects[], keyConcepts[], failureModes[]
--   For call_semantics: role
--   For path/subgraph summaries: path[], domains[]

CREATE TABLE IF NOT EXISTS semantic_capsules (
  id              TEXT PRIMARY KEY,  -- 'capsule:<kind>:<target_id>@<rev>'
  target_id       TEXT NOT NULL,     -- CARI entity ID this describes
  capsule_kind    TEXT NOT NULL,     -- symbol_summary | call_semantics | path_summary | subgraph_summary
  content         TEXT NOT NULL,     -- JSON: at minimum { summary: string }
  evidence_ids    TEXT NOT NULL,     -- JSON array of CARI entity IDs used as evidence
  model           TEXT NOT NULL,     -- e.g. 'gpt-4o', 'claude-sonnet-4-5'
  prompt_version  TEXT NOT NULL,     -- versioned prompt identifier for cache busting
  source_revision TEXT NOT NULL,     -- body_hash or git-sha of primary target at generation time
  confidence      REAL NOT NULL DEFAULT 1.0,
  status          TEXT NOT NULL DEFAULT 'fresh',  -- fresh | possibly_stale | stale
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capsules_target ON semantic_capsules(target_id);
CREATE INDEX IF NOT EXISTS idx_capsules_kind   ON semantic_capsules(capsule_kind);
CREATE INDEX IF NOT EXISTS idx_capsules_status ON semantic_capsules(status);

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
 * Claims companion schema added in version 15.
 *
 * This is deliberately kept separate from `SCHEMA_SQL`: released native
 * builders can still produce a version-14 core index, which the CLI upgrades
 * with `migrateSchema14To15()` before opening it through query helpers.
 */
const CLAIMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS parameter_identities (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_identities (
  id TEXT PRIMARY KEY,
  parameter_identity_id TEXT REFERENCES parameter_identities(id),
  source_kind TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_versions (
  id TEXT PRIMARY KEY,
  evidence_identity_id TEXT NOT NULL REFERENCES evidence_identities(id),
  version_ordinal INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  material_fingerprint TEXT NOT NULL,
  normalized_value TEXT,
  semantic_location TEXT NOT NULL,
  file_path TEXT,
  symbol_id TEXT,
  span_start_line INTEGER,
  span_end_line INTEGER,
  repository_revision TEXT,
  provenance_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE (evidence_identity_id, version_ordinal),
  UNIQUE (evidence_identity_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS parameter_evidence_bindings (
  id TEXT PRIMARY KEY,
  parameter_identity_id TEXT NOT NULL REFERENCES parameter_identities(id),
  evidence_version_id TEXT NOT NULL REFERENCES evidence_versions(id),
  basis TEXT NOT NULL,
  confidence TEXT NOT NULL,
  predecessor_binding_id TEXT REFERENCES parameter_evidence_bindings(id),
  created_at INTEGER NOT NULL,
  UNIQUE (parameter_identity_id, evidence_version_id)
);

CREATE TABLE IF NOT EXISTS evidence_continuity (
  id TEXT PRIMARY KEY,
  from_evidence_version_id TEXT NOT NULL REFERENCES evidence_versions(id),
  to_evidence_version_id TEXT NOT NULL REFERENCES evidence_versions(id),
  basis TEXT NOT NULL,
  confidence TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (from_evidence_version_id, to_evidence_version_id)
);

CREATE TABLE IF NOT EXISTS rule_result_identities (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  scope TEXT,
  identity_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_result_versions (
  id TEXT PRIMARY KEY,
  rule_result_identity_id TEXT NOT NULL REFERENCES rule_result_identities(id),
  version_ordinal INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  applicability TEXT NOT NULL,
  normalized_status TEXT NOT NULL,
  normalized_output_json TEXT NOT NULL,
  normalized_reasons_json TEXT NOT NULL,
  rule_contract_version TEXT NOT NULL,
  implementation_fingerprint TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE (rule_result_identity_id, version_ordinal),
  UNIQUE (rule_result_identity_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS rule_result_evidence (
  rule_result_version_id TEXT NOT NULL REFERENCES rule_result_versions(id),
  evidence_version_id TEXT NOT NULL REFERENCES evidence_versions(id),
  PRIMARY KEY (rule_result_version_id, evidence_version_id)
);

CREATE TABLE IF NOT EXISTS claim_identities (
  id TEXT PRIMARY KEY,
  parameter_identity_id TEXT NOT NULL REFERENCES parameter_identities(id),
  claim_type TEXT NOT NULL,
  scope TEXT,
  identity_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_versions (
  id TEXT PRIMARY KEY,
  claim_identity_id TEXT NOT NULL REFERENCES claim_identities(id),
  version_ordinal INTEGER NOT NULL,
  normalized_statement_json TEXT NOT NULL,
  assessment_policy_id TEXT NOT NULL,
  assessment_policy_version TEXT NOT NULL,
  repository_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (claim_identity_id, version_ordinal)
);

CREATE TABLE IF NOT EXISTS claim_assessments (
  id TEXT PRIMARY KEY,
  claim_version_id TEXT NOT NULL REFERENCES claim_versions(id),
  assessment_key TEXT NOT NULL UNIQUE,
  epistemic_status TEXT NOT NULL,
  repository_revision TEXT NOT NULL,
  reference_key TEXT UNIQUE,
  is_current INTEGER NOT NULL DEFAULT 1,
  superseded_by_assessment_id TEXT REFERENCES claim_assessments(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_assessment_dependencies (
  claim_assessment_id TEXT NOT NULL REFERENCES claim_assessments(id),
  dependency_kind TEXT NOT NULL,
  dependency_version_id TEXT NOT NULL,
  epistemic_role TEXT NOT NULL,
  warrant_polarity TEXT,
  assessment_effect TEXT NOT NULL,
  PRIMARY KEY (
    claim_assessment_id,
    dependency_kind,
    dependency_version_id,
    epistemic_role,
    warrant_polarity,
    assessment_effect
  )
);

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  claim_identity_id TEXT NOT NULL REFERENCES claim_identities(id),
  basis_assessment_id TEXT NOT NULL REFERENCES claim_assessments(id),
  decision TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision_origin TEXT NOT NULL,
  carried_forward_from_decision_id TEXT REFERENCES review_decisions(id),
  superseded_by_decision_id TEXT REFERENCES review_decisions(id),
  invalidated_by_reopen_id TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_decision_reopens (
  id TEXT PRIMARY KEY,
  claim_identity_id TEXT NOT NULL REFERENCES claim_identities(id),
  previous_review_decision_id TEXT REFERENCES review_decisions(id),
  basis_assessment_id TEXT NOT NULL REFERENCES claim_assessments(id),
  dependency_kind TEXT NOT NULL,
  dependency_version_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  secondary_provenance_json TEXT,
  status TEXT NOT NULL,
  resolved_by_decision_id TEXT REFERENCES review_decisions(id),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_evidence_versions_identity_ordinal
  ON evidence_versions(evidence_identity_id, version_ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_rule_result_versions_identity_ordinal
  ON rule_result_versions(rule_result_identity_id, version_ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_rule_result_evidence_evidence
  ON rule_result_evidence(evidence_version_id);
CREATE INDEX IF NOT EXISTS idx_claim_versions_identity_ordinal
  ON claim_versions(claim_identity_id, version_ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_assessments_claim_current
  ON claim_assessments(claim_version_id, is_current);
CREATE INDEX IF NOT EXISTS idx_assessment_dependencies_dependency
  ON claim_assessment_dependencies(dependency_kind, dependency_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_decisions_current_claim
  ON review_decisions(claim_identity_id) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_review_reopens_claim_status
  ON review_decision_reopens(claim_identity_id, status);
`;

/** Upgrade a core schema-14 database with the additive claims companion schema. */
export function migrateSchema14To15(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const migrate = db.transaction(() => {
    db.exec(CLAIMS_SCHEMA_SQL);
    db.prepare(
      `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '15')`,
    ).run();
  });
  migrate();
}

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

  // Migration 14.0: add semantic_capsules table to existing indexes
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as Array<{ name: string }>;
  const tableNames = new Set(tables.map((t) => t.name));
  if (!tableNames.has("semantic_capsules")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_capsules (
        id              TEXT PRIMARY KEY,
        target_id       TEXT NOT NULL,
        capsule_kind    TEXT NOT NULL,
        content         TEXT NOT NULL,
        evidence_ids    TEXT NOT NULL,
        model           TEXT NOT NULL,
        prompt_version  TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        confidence      REAL NOT NULL DEFAULT 1.0,
        status          TEXT NOT NULL DEFAULT 'fresh',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_capsules_target ON semantic_capsules(target_id);
      CREATE INDEX IF NOT EXISTS idx_capsules_kind   ON semantic_capsules(capsule_kind);
      CREATE INDEX IF NOT EXISTS idx_capsules_status ON semantic_capsules(status);
    `);
  }

  migrateSchema14To15(db);
}
