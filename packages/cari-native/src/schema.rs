// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! SQLite DDL — mirrors `packages/index/src/schema.ts` exactly.
//!
//! The schema must remain byte-for-byte compatible with the TypeScript
//! schema so that:
//!   a) Indexes built by `cari-build` can be opened by `CariIndex.load()`
//!   b) Indexes built by the TS pipeline can be read by future Rust tooling
//!
//! SCHEMA VERSION: 15
//!   Written to `_meta` table as key='schema_version', value='15'.
//!   The TS `initSchema()` also writes this value. Increment both in sync.

use anyhow::Result;
use rusqlite::Connection;

pub const SCHEMA_VERSION: &str = "15";

/// Full DDL matching `SCHEMA_SQL` in schema.ts.
pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS symbols (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  container       TEXT,
  signature       TEXT,
  file_path       TEXT NOT NULL,
  line            INTEGER,
  end_line        INTEGER,
  export          INTEGER NOT NULL DEFAULT 0,
  doc_summary     TEXT,
  body_hash       TEXT,
  body_lines      INTEGER,
  structure_hash  TEXT,
  implements      TEXT,
  deprecated      INTEGER NOT NULL DEFAULT 0,
  deprecated_note TEXT,
  is_internal     INTEGER NOT NULL DEFAULT 0,
  decorators      TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind      ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file      ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_container ON symbols(container);
CREATE INDEX IF NOT EXISTS idx_symbols_export    ON symbols(export);

CREATE TABLE IF NOT EXISTS annotations (
  id         TEXT PRIMARY KEY,
  doc_path   TEXT NOT NULL,
  line       INTEGER NOT NULL,
  text       TEXT NOT NULL,
  symbol_id  TEXT REFERENCES symbols(id),
  confidence REAL NOT NULL DEFAULT 1.0,
  source     TEXT NOT NULL,
  qualifier  TEXT,
  idf_score  REAL NOT NULL DEFAULT 1.0,
  char_start INTEGER,
  char_end   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_annotations_doc    ON annotations(doc_path);
CREATE INDEX IF NOT EXISTS idx_annotations_symbol ON annotations(symbol_id);
CREATE INDEX IF NOT EXISTS idx_annotations_source ON annotations(source);

CREATE TABLE IF NOT EXISTS co_occurrences (
  entity_a   TEXT NOT NULL,
  entity_b   TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  score      REAL NOT NULL DEFAULT 1.0,
  source     TEXT NOT NULL,
  file_paths TEXT,
  PRIMARY KEY (entity_a, entity_b, source)
);

CREATE INDEX IF NOT EXISTS idx_co_occ_a ON co_occurrences(entity_a);
CREATE INDEX IF NOT EXISTS idx_co_occ_b ON co_occurrences(entity_b);

CREATE TABLE IF NOT EXISTS co_changes (
  file_a         TEXT NOT NULL,
  file_b         TEXT NOT NULL,
  count          INTEGER NOT NULL DEFAULT 1,
  jaccard        REAL NOT NULL DEFAULT 0.0,
  recency        REAL NOT NULL DEFAULT 0.0,
  commit_hashes  TEXT,
  PRIMARY KEY (file_a, file_b)
);

CREATE TABLE IF NOT EXISTS files (
  path           TEXT PRIMARY KEY,
  last_modified  TEXT,
  churn          INTEGER NOT NULL DEFAULT 0,
  is_hotspot     INTEGER NOT NULL DEFAULT 0,
  primary_owner  TEXT,
  bus_factor     INTEGER,
  is_doc         INTEGER NOT NULL DEFAULT 0,
  content_hash   TEXT,
  doc_group      TEXT,
  indexed        INTEGER NOT NULL DEFAULT 1,
  skip_reason    TEXT,
  comment_lines  INTEGER,
  code_lines     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_files_doc_group ON files(doc_group);
CREATE INDEX IF NOT EXISTS idx_files_is_doc    ON files(is_doc);
CREATE INDEX IF NOT EXISTS idx_files_hotspot   ON files(is_hotspot);

CREATE TABLE IF NOT EXISTS imports (
  id               TEXT PRIMARY KEY,
  source_file      TEXT NOT NULL,
  target_file      TEXT NOT NULL,
  module_specifier TEXT NOT NULL,
  line             INTEGER,
  is_relative      INTEGER NOT NULL DEFAULT 0,
  imported_names   TEXT
);

CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_file);
CREATE INDEX IF NOT EXISTS idx_imports_target ON imports(target_file);

CREATE TABLE IF NOT EXISTS todos (
  id        TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  line      INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  text      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_todos_file ON todos(file_path);
CREATE INDEX IF NOT EXISTS idx_todos_kind ON todos(kind);

CREATE TABLE IF NOT EXISTS rationale (
  id        TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  line      INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  text      TEXT NOT NULL,
  symbol    TEXT
);

CREATE INDEX IF NOT EXISTS idx_rationale_file ON rationale(file_path);
CREATE INDEX IF NOT EXISTS idx_rationale_kind ON rationale(kind);

CREATE TABLE IF NOT EXISTS symbol_calls (
  id          TEXT PRIMARY KEY,
  caller_file TEXT NOT NULL,
  caller_name TEXT NOT NULL,
  caller_line INTEGER NOT NULL,
  callee_name TEXT NOT NULL,
  callee_id   TEXT,
  is_method   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_calls_caller_file ON symbol_calls(caller_file);
CREATE INDEX IF NOT EXISTS idx_calls_callee_name ON symbol_calls(callee_name);
CREATE INDEX IF NOT EXISTS idx_calls_caller_name ON symbol_calls(caller_name);

CREATE TABLE IF NOT EXISTS property_accesses (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  line        INTEGER NOT NULL,
  chain       TEXT NOT NULL,
  root        TEXT NOT NULL,
  depth       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_prop_access_file   ON property_accesses(file);
CREATE INDEX IF NOT EXISTS idx_prop_access_symbol ON property_accesses(symbol_name);
CREATE INDEX IF NOT EXISTS idx_prop_access_root   ON property_accesses(root);

CREATE TABLE IF NOT EXISTS type_assertions (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  context     TEXT,
  target_type TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_type_assert_file ON type_assertions(file);
CREATE INDEX IF NOT EXISTS idx_type_assert_type ON type_assertions(target_type);

CREATE TABLE IF NOT EXISTS conformance_snapshots (
  id               TEXT PRIMARY KEY,
  snapshot_id      TEXT NOT NULL,
  timestamp        TEXT NOT NULL,
  rule_id          TEXT NOT NULL,
  adr              TEXT,
  files_in_scope   INTEGER NOT NULL DEFAULT 0,
  files_clean      INTEGER NOT NULL DEFAULT 0,
  violation_count  INTEGER NOT NULL DEFAULT 0,
  conformance_pct  REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_snapshots_rule ON conformance_snapshots(rule_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON conformance_snapshots(timestamp);

CREATE TABLE IF NOT EXISTS test_descriptions (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_test_desc_file ON test_descriptions(file);

CREATE TABLE IF NOT EXISTS variable_assignments (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  symbol_name TEXT NOT NULL,
  value_text  TEXT,
  context     TEXT
);

CREATE INDEX IF NOT EXISTS idx_var_assign_file   ON variable_assignments(file);
CREATE INDEX IF NOT EXISTS idx_var_assign_symbol ON variable_assignments(symbol_name);

CREATE TABLE IF NOT EXISTS def_use_chains (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  function    TEXT,
  def_line    INTEGER NOT NULL,
  var_name    TEXT NOT NULL,
  use_line    INTEGER NOT NULL,
  use_context TEXT
);

CREATE INDEX IF NOT EXISTS idx_def_use_file ON def_use_chains(file);
CREATE INDEX IF NOT EXISTS idx_def_use_var  ON def_use_chains(var_name);

CREATE TABLE IF NOT EXISTS external_entities (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  type     TEXT NOT NULL,
  aliases  TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_ext_entities_name ON external_entities(name);

CREATE TABLE IF NOT EXISTS kg_entities (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL,
  source_file TEXT,
  canon_id  TEXT,
  metadata  TEXT
);

CREATE TABLE IF NOT EXISTS kg_relationships (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL REFERENCES kg_entities(id),
  to_id      TEXT NOT NULL REFERENCES kg_entities(id),
  predicate  TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_file TEXT,
  metadata   TEXT
);

CREATE TABLE IF NOT EXISTS kg_raw_triples (
  id          TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  metadata    TEXT
);

CREATE TABLE IF NOT EXISTS enrichment_meta (
  id              TEXT PRIMARY KEY,
  target_id       TEXT NOT NULL,
  enrichment_kind TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'fresh'
);

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

CREATE INDEX IF NOT EXISTS idx_kg_entities_name     ON kg_entities(name);
CREATE INDEX IF NOT EXISTS idx_kg_entities_type     ON kg_entities(type);
CREATE INDEX IF NOT EXISTS idx_kg_entities_canon_id ON kg_entities(canon_id);
CREATE INDEX IF NOT EXISTS idx_kg_entities_source   ON kg_entities(source_file);
CREATE INDEX IF NOT EXISTS idx_kg_rels_from         ON kg_relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_kg_rels_to           ON kg_relationships(to_id);
CREATE INDEX IF NOT EXISTS idx_kg_rels_predicate    ON kg_relationships(predicate);
CREATE INDEX IF NOT EXISTS idx_kg_raw_source        ON kg_raw_triples(source_file);

CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// FTS5 virtual tables — created separately because they cannot use IF NOT EXISTS
/// inside the main DDL batch on some SQLite versions.
pub const FTS_SQL: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts
  USING fts5(name, kind, container, content=symbols, content_rowid=rowid);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts
  USING fts5(text, doc_path, content=annotations, content_rowid=rowid);
"#;

/// Additive Claims companion schema, matching `packages/index/src/schema.ts`.
pub const CLAIMS_SCHEMA_SQL: &str = r#"
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
  PRIMARY KEY (claim_assessment_id, dependency_kind, dependency_version_id, epistemic_role, warrant_polarity, assessment_effect)
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
CREATE INDEX IF NOT EXISTS idx_evidence_versions_identity_ordinal ON evidence_versions(evidence_identity_id, version_ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_rule_result_versions_identity_ordinal ON rule_result_versions(rule_result_identity_id, version_ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_rule_result_evidence_evidence ON rule_result_evidence(evidence_version_id);
CREATE INDEX IF NOT EXISTS idx_claim_versions_identity_ordinal ON claim_versions(claim_identity_id, version_ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_assessments_claim_current ON claim_assessments(claim_version_id, is_current);
CREATE INDEX IF NOT EXISTS idx_assessment_dependencies_dependency ON claim_assessment_dependencies(dependency_kind, dependency_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_decisions_current_claim ON review_decisions(claim_identity_id) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_review_reopens_claim_status ON review_decision_reopens(claim_identity_id, status);
"#;

/// Initialize the schema on a fresh or existing database.
///
/// Safe to call repeatedly — all DDL uses `IF NOT EXISTS` guards.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(SCHEMA_SQL)?;
    conn.execute_batch(CLAIMS_SCHEMA_SQL)?;

    // FTS tables: ignore "already exists" errors (virtual tables)
    let _ = conn.execute_batch(FTS_SQL);

    // Write schema version to _meta table
    conn.execute(
        "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?1)",
        [SCHEMA_VERSION],
    )?;

    Ok(())
}

/// Write build metadata to `_meta` after the pipeline completes.
pub fn write_meta(
    conn: &Connection,
    session: &str,
    depth: &str,
    workspace_root: &str,
) -> Result<()> {
    let built_at = chrono::Utc::now().to_rfc3339();
    let builder = format!("cari-native/{}", env!("CARGO_PKG_VERSION"));

    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO _meta (key, value) VALUES (?1, ?2)",
    )?;
    stmt.execute(["schema_version", SCHEMA_VERSION])?;
    stmt.execute(["builder", &builder])?;
    stmt.execute(["built_at", &built_at])?;
    stmt.execute(["session", session])?;
    stmt.execute(["depth", depth])?;
    stmt.execute(["workspace_root", workspace_root])?;

    Ok(())
}
