// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI SQLite Schema
 *
 * Defines all CREATE TABLE / INDEX / FTS5 statements for the
 * code-aware retrieval index. Called once when creating a new index.db.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "@intentweave/sqlite-compat";
import { parameterSubjectIdentity } from "./claims/subjects.js";

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

export const CLAIMS_COMPANION_TABLES = [
  "subject_identities",
  "subject_aliases",
  "subject_continuity",
  "parameter_identities",
  "parameter_evidence_bindings",
  "evidence_identities",
  "evidence_versions",
  "evidence_continuity",
  "evidence_subjects",
  "rule_result_identities",
  "rule_result_versions",
  "rule_result_evidence",
  "claim_identities",
  "claim_subjects",
  "claim_versions",
  "claim_assessments",
  "claim_assessment_dependencies",
  "review_decisions",
  "review_decision_reopens",
  "claim_assessment_references",
] as const;

const SCHEMA_17_CLAIMS_COMPANION_TABLES = CLAIMS_COMPANION_TABLES.filter(
  (table) => table !== "subject_continuity",
);

const SCHEMA_16_CLAIMS_COMPANION_TABLES = [
  "parameter_identities",
  "parameter_evidence_bindings",
  "evidence_identities",
  "evidence_versions",
  "evidence_continuity",
  "rule_result_identities",
  "rule_result_versions",
  "rule_result_evidence",
  "claim_identities",
  "claim_versions",
  "claim_assessments",
  "claim_assessment_dependencies",
  "review_decisions",
  "review_decision_reopens",
  "claim_assessment_references",
] as const;

const LEGACY_CLAIMS_COMPANION_TABLES = SCHEMA_16_CLAIMS_COMPANION_TABLES.filter(
  (table) => table !== "claim_assessment_references",
);

export const CURRENT_SCHEMA_VERSION = "18";

function readSchemaVersion(db: Database.Database): string | undefined {
  try {
    const row = db
      .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    return row?.value;
  } catch (error) {
    if (error instanceof Error && error.message.includes("_meta")) {
      return undefined;
    }
    throw error;
  }
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function claimsCompanionTablesInSchema(
  db: Database.Database,
  schema = "main",
): readonly string[] | undefined {
  const tables = new Set(
    (
      db
        .prepare(
          `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (CLAIMS_COMPANION_TABLES.every((table) => tables.has(table))) {
    return CLAIMS_COMPANION_TABLES;
  }
  if (SCHEMA_17_CLAIMS_COMPANION_TABLES.every((table) => tables.has(table))) {
    return SCHEMA_17_CLAIMS_COMPANION_TABLES;
  }
  if (SCHEMA_16_CLAIMS_COMPANION_TABLES.every((table) => tables.has(table))) {
    return SCHEMA_16_CLAIMS_COMPANION_TABLES;
  }
  if (LEGACY_CLAIMS_COMPANION_TABLES.every((table) => tables.has(table))) {
    return LEGACY_CLAIMS_COMPANION_TABLES;
  }
  return undefined;
}

/**
 * Capture the Claims companion layer before a full CARI rebuild replaces the
 * index database. `VACUUM INTO` includes committed WAL content atomically.
 */
export function snapshotClaimsHistory(dbPath: string): string | undefined {
  if (!fs.existsSync(dbPath)) return undefined;
  const db = new Database(dbPath);
  try {
    if (!claimsCompanionTablesInSchema(db)) return undefined;
    const snapshotPath = path.join(
      path.dirname(dbPath),
      `.claims-history-${randomUUID()}.db`,
    );
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec(`VACUUM INTO ${sqliteStringLiteral(snapshotPath)}`);
    return snapshotPath;
  } finally {
    db.close();
  }
}

/** Return a unique temporary database path beside the final index. */
export function temporaryDatabasePath(dbPath: string): string {
  return path.join(
    path.dirname(dbPath),
    `.${path.basename(dbPath)}.${randomUUID()}.tmp`,
  );
}

/** Remove a SQLite database and its WAL sidecars. */
export function discardDatabaseFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Atomically replace a completed database build with its temporary output. */
export function replaceDatabaseAtomically(
  sourcePath: string,
  targetPath: string,
): void {
  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${targetPath}${suffix}`, { force: true });
  }
  fs.renameSync(sourcePath, targetPath);
  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${sourcePath}${suffix}`, { force: true });
  }
}

/** Restore a prior Claims companion snapshot into an otherwise fresh index. */
export function restoreClaimsHistory(
  db: Database.Database,
  snapshotPath: string | undefined,
): void {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) return;
  db.exec(
    `ATTACH DATABASE ${sqliteStringLiteral(snapshotPath)} AS claims_history`,
  );
  try {
    const sourceTables = claimsCompanionTablesInSchema(db, "claims_history");
    if (!sourceTables) return;
    const restore = db.transaction(() => {
      db.exec("PRAGMA defer_foreign_keys = ON");
      for (const table of [...CLAIMS_COMPANION_TABLES].reverse()) {
        db.exec(`DELETE FROM ${table}`);
      }
      for (const table of sourceTables) {
        const sourceColumns = new Set(
          (
            db
              .prepare(`PRAGMA claims_history.table_info(${table})`)
              .all() as Array<{
              name: string;
            }>
          ).map((column) => column.name),
        );
        const commonColumns = (
          db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{
            name: string;
          }>
        )
          .map((column) => column.name)
          .filter((column) => sourceColumns.has(column));
        const columns = commonColumns.join(", ");
        db.exec(
          `INSERT INTO ${table} (${columns})
           SELECT ${columns} FROM claims_history.${table}`,
        );
      }
      // Legacy snapshots (schema v15) do not have this table.
      db.exec(`
        INSERT OR IGNORE INTO claim_assessment_references (
          claim_identity_id, repository_revision, assessment_id, created_at
        )
        SELECT cv.claim_identity_id, ca.repository_revision, ca.id, ca.created_at
        FROM claim_assessments ca
        JOIN claim_versions cv ON cv.id = ca.claim_version_id
        WHERE ca.reference_key IS NOT NULL
      `);
      backfillParameterSubjects(db);
    });
    restore();
  } finally {
    db.exec("DETACH DATABASE claims_history");
  }
}

/** Delete a temporary Claims snapshot after a rebuild has completed. */
export function discardClaimsHistory(snapshotPath: string | undefined): void {
  if (snapshotPath) fs.rmSync(snapshotPath, { force: true });
}

export function schemaMigrationBackupPath(
  dbPath: string,
  schemaVersion: string,
): string {
  return `${dbPath}.schema-${schemaVersion}.backup`;
}

function createDurableMigrationBackup(
  db: Database.Database,
  dbPath: string,
  schemaVersion: string,
): string {
  const backupPath = schemaMigrationBackupPath(dbPath, schemaVersion);
  if (fs.existsSync(backupPath)) return backupPath;
  const temporaryPath = `${backupPath}.${randomUUID()}.tmp`;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  try {
    db.exec(`VACUUM INTO ${sqliteStringLiteral(temporaryPath)}`);
    fs.renameSync(temporaryPath, backupPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return backupPath;
}

function restoreMigrationBackup(backupPath: string, dbPath: string): void {
  const temporaryPath = `${dbPath}.${randomUUID()}.restore`;
  fs.copyFileSync(backupPath, temporaryPath);
  try {
    for (const suffix of ["-wal", "-shm"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    fs.renameSync(temporaryPath, dbPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Open and migrate an on-disk index while retaining a durable backup for each
 * in-place G1 schema step. The optional migration callbacks exist for
 * failure-path verification only.
 */
export function openMigratedDatabase(
  dbPath: string,
  migrateG1a: (db: Database.Database) => void = migrateSchema16To17,
  migrateG1b: (db: Database.Database) => void = migrateSchema17To18,
): Database.Database {
  let database = new Database(dbPath);
  let closed = false;
  const closeOnce = (): void => {
    if (!closed) {
      database.close();
      closed = true;
    }
  };
  try {
    const initialVersion = readSchemaVersion(database);
    if (!initialVersion || initialVersion === "14") {
      migrateSchema14To15(database);
      migrateSchema15To16(database);
    } else if (initialVersion === "15") {
      migrateSchema15To16(database);
    }
    const g1Steps: Array<{
      fromVersion: string;
      migrate: (db: Database.Database) => void;
    }> = [
      { fromVersion: "16", migrate: migrateG1a },
      { fromVersion: "17", migrate: migrateG1b },
    ];
    for (const step of g1Steps) {
      if (readSchemaVersion(database) !== step.fromVersion) continue;
      const backupPath = createDurableMigrationBackup(
        database,
        dbPath,
        step.fromVersion,
      );
      try {
        step.migrate(database);
      } catch (error) {
        closeOnce();
        restoreMigrationBackup(backupPath, dbPath);
        throw error;
      }
    }
    migrateSchemaToCurrent(database);
    return database;
  } catch (error) {
    closeOnce();
    throw error;
  }
}

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

CREATE TABLE IF NOT EXISTS claim_assessment_references (
  claim_identity_id TEXT NOT NULL REFERENCES claim_identities(id),
  repository_revision TEXT NOT NULL,
  assessment_id TEXT NOT NULL REFERENCES claim_assessments(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (claim_identity_id, repository_revision)
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

const SUBJECT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS subject_identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subject_aliases (
  subject_identity_id TEXT NOT NULL REFERENCES subject_identities(id),
  alias_kind TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subject_identity_id, alias_kind, alias_key),
  UNIQUE (alias_kind, alias_key)
);

CREATE TABLE IF NOT EXISTS claim_subjects (
  claim_identity_id TEXT NOT NULL REFERENCES claim_identities(id),
  subject_identity_id TEXT NOT NULL REFERENCES subject_identities(id),
  subject_role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (claim_identity_id, subject_identity_id, subject_role)
);

CREATE TABLE IF NOT EXISTS evidence_subjects (
  evidence_identity_id TEXT NOT NULL REFERENCES evidence_identities(id),
  subject_identity_id TEXT NOT NULL REFERENCES subject_identities(id),
  subject_role TEXT NOT NULL,
  basis TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (evidence_identity_id, subject_identity_id, subject_role)
);

CREATE INDEX IF NOT EXISTS idx_subject_aliases_subject
  ON subject_aliases(subject_identity_id);
CREATE INDEX IF NOT EXISTS idx_claim_subjects_subject
  ON claim_subjects(subject_identity_id, subject_role);
CREATE INDEX IF NOT EXISTS idx_evidence_subjects_subject
  ON evidence_subjects(subject_identity_id, subject_role);
`;

const G1B_SUBJECT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS subject_continuity (
  id TEXT PRIMARY KEY,
  continuity_identity_key TEXT NOT NULL,
  version_ordinal INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  from_subject_identity_id TEXT NOT NULL REFERENCES subject_identities(id),
  to_subject_identity_id TEXT NOT NULL REFERENCES subject_identities(id),
  basis TEXT NOT NULL,
  confidence TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (continuity_identity_key, version_ordinal),
  UNIQUE (continuity_identity_key, fingerprint),
  CHECK (from_subject_identity_id != to_subject_identity_id)
);

CREATE INDEX IF NOT EXISTS idx_subject_continuity_from
  ON subject_continuity(from_subject_identity_id, version_ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_subject_continuity_to
  ON subject_continuity(to_subject_identity_id, version_ordinal DESC);
`;

function backfillParameterSubjects(db: Database.Database): void {
  const parameters = db
    .prepare(`SELECT id, canonical_key, created_at FROM parameter_identities`)
    .all() as Array<{ id: string; canonical_key: string; created_at: number }>;
  for (const parameter of parameters) {
    const subject = parameterSubjectIdentity(parameter.canonical_key);
    db.prepare(
      `INSERT OR IGNORE INTO subject_identities (
         id, kind, identity_key, display_name, lifecycle_state,
         contract_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      subject.id,
      subject.kind,
      subject.identityKey,
      subject.displayName,
      subject.lifecycleState,
      subject.contractVersion,
      parameter.created_at,
    );
    db.prepare(
      `INSERT OR IGNORE INTO subject_aliases (
         subject_identity_id, alias_kind, alias_key, created_at
       ) VALUES (?, 'parameter-key', ?, ?)`,
    ).run(subject.id, parameter.canonical_key, parameter.created_at);
    db.prepare(
      `UPDATE parameter_identities
       SET subject_identity_id = ? WHERE id = ?`,
    ).run(subject.id, parameter.id);
    db.prepare(
      `INSERT OR IGNORE INTO claim_subjects (
         claim_identity_id, subject_identity_id, subject_role, created_at
       ) SELECT id, ?, 'subject', created_at
         FROM claim_identities WHERE parameter_identity_id = ?`,
    ).run(subject.id, parameter.id);
    db.prepare(
      `INSERT OR IGNORE INTO evidence_subjects (
         evidence_identity_id, subject_identity_id, subject_role,
         basis, confidence, created_at
       ) SELECT id, ?, 'subject', 'parameter-compatibility', 'certain', created_at
         FROM evidence_identities WHERE parameter_identity_id = ?`,
    ).run(subject.id, parameter.id);
  }
}

/** Upgrade a core schema-14 database with the additive claims companion schema. */
export function migrateSchema14To15(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const migrate = db.transaction(() => {
    db.exec(CLAIMS_SCHEMA_SQL);
    db.exec(`
      INSERT OR IGNORE INTO claim_assessment_references (
        claim_identity_id, repository_revision, assessment_id, created_at
      )
      SELECT cv.claim_identity_id, ca.repository_revision, ca.id, ca.created_at
      FROM claim_assessments ca
      JOIN claim_versions cv ON cv.id = ca.claim_version_id
      WHERE ca.reference_key IS NOT NULL
    `);
    db.prepare(
      `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '15')`,
    ).run();
  });
  migrate();
}

/** Upgrade schema-15 indexes with claim_assessment_references and version 16 metadata. */
export function migrateSchema15To16(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS claim_assessment_references (
        claim_identity_id TEXT NOT NULL REFERENCES claim_identities(id),
        repository_revision TEXT NOT NULL,
        assessment_id TEXT NOT NULL REFERENCES claim_assessments(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (claim_identity_id, repository_revision)
      )
    `);
    db.exec(`
      INSERT OR IGNORE INTO claim_assessment_references (
        claim_identity_id, repository_revision, assessment_id, created_at
      )
      SELECT cv.claim_identity_id, ca.repository_revision, ca.id, ca.created_at
      FROM claim_assessments ca
      JOIN claim_versions cv ON cv.id = ca.claim_version_id
      WHERE ca.reference_key IS NOT NULL
    `);
    db.prepare(
      `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)`,
    ).run("16");
  });
  migrate();
}

/** Add G1a Subject storage and backfill every legacy Parameter relationship. */
export function migrateSchema16To17(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  const migrate = db.transaction(() => {
    db.exec(SUBJECT_SCHEMA_SQL);
    const columns = db
      .prepare(`PRAGMA table_info(parameter_identities)`)
      .all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "subject_identity_id")) {
      db.exec(
        `ALTER TABLE parameter_identities
         ADD COLUMN subject_identity_id TEXT REFERENCES subject_identities(id)`,
      );
    }
    backfillParameterSubjects(db);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_parameter_subject_identity
       ON parameter_identities(subject_identity_id)`,
    );
    const missing = db
      .prepare(
        `SELECT COUNT(*) AS count FROM parameter_identities
         WHERE subject_identity_id IS NULL`,
      )
      .get() as { count: number };
    if (missing.count !== 0) {
      throw new Error("Subject backfill left Parameter identities unlinked");
    }
    db.prepare(
      `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '17')`,
    ).run();
  });
  migrate();
}

/**
 * G1b: rebuild Claim identity storage so `parameter_identity_id` becomes a
 * nullable legacy compatibility link and `claim_subjects` becomes the
 * authoritative Subject relationship for generic Claims. Existing Parameter
 * rows retain their foreign key and IDs; no synthetic Parameters are created.
 */
export function migrateSchema17To18(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info(claim_identities)`)
    .all() as Array<{ name: string; notnull: number }>;
  const parameterColumn = columns.find(
    (column) => column.name === "parameter_identity_id",
  );
  if (!parameterColumn) {
    throw new Error(
      "Schema 17 database is missing claim_identities.parameter_identity_id",
    );
  }
  // PRAGMA foreign_keys is a no-op inside a transaction, so toggle it outside.
  db.pragma("foreign_keys = OFF");
  try {
    const migrate = db.transaction(() => {
      db.exec(G1B_SUBJECT_SCHEMA_SQL);
      if (parameterColumn.notnull !== 0) {
        db.exec(`
          CREATE TABLE claim_identities_g1b (
            id TEXT PRIMARY KEY,
            parameter_identity_id TEXT REFERENCES parameter_identities(id),
            claim_type TEXT NOT NULL,
            scope TEXT,
            identity_key TEXT NOT NULL UNIQUE,
            identity_contract_id TEXT,
            identity_contract_version TEXT,
            created_at INTEGER NOT NULL
          );
          INSERT INTO claim_identities_g1b (
            id, parameter_identity_id, claim_type, scope, identity_key,
            identity_contract_id, identity_contract_version, created_at
          )
          SELECT id, parameter_identity_id, claim_type, scope, identity_key,
                 NULL, NULL, created_at
          FROM claim_identities;
          DROP TABLE claim_identities;
          ALTER TABLE claim_identities_g1b RENAME TO claim_identities;
        `);
      } else {
        const identityColumns = new Set(columns.map((column) => column.name));
        if (!identityColumns.has("identity_contract_id")) {
          db.exec(
            `ALTER TABLE claim_identities ADD COLUMN identity_contract_id TEXT`,
          );
        }
        if (!identityColumns.has("identity_contract_version")) {
          db.exec(
            `ALTER TABLE claim_identities ADD COLUMN identity_contract_version TEXT`,
          );
        }
      }
      const versionColumns = new Set(
        (
          db.prepare(`PRAGMA table_info(claim_versions)`).all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      if (!versionColumns.has("materiality_contract_id")) {
        db.exec(
          `ALTER TABLE claim_versions ADD COLUMN materiality_contract_id TEXT`,
        );
      }
      if (!versionColumns.has("materiality_contract_version")) {
        db.exec(
          `ALTER TABLE claim_versions ADD COLUMN materiality_contract_version TEXT`,
        );
      }
      db.prepare(
        `INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '18')`,
      ).run();
      const violations = db
        .prepare(`PRAGMA foreign_key_check`)
        .all() as unknown[];
      if (violations.length > 0) {
        throw new Error(
          "Schema 18 migration left foreign key violations in claim_identities",
        );
      }
    });
    migrate();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Bring any supported legacy schema to CURRENT_SCHEMA_VERSION.
 * Supported transitions: 14 -> 15 -> 16 -> 17 -> 18, 15 -> 16 -> 17 -> 18,
 * 16 -> 17 -> 18, and 17 -> 18.
 * Unknown newer/older versions are rejected to avoid silent downgrade/corruption.
 */
export function migrateSchemaToCurrent(db: Database.Database): void {
  const schemaVersion = readSchemaVersion(db);
  if (!schemaVersion || schemaVersion === "14") {
    migrateSchema14To15(db);
    migrateSchema15To16(db);
    migrateSchema16To17(db);
    migrateSchema17To18(db);
    return;
  }
  if (schemaVersion === "15") {
    migrateSchema15To16(db);
    migrateSchema16To17(db);
    migrateSchema17To18(db);
    return;
  }
  if (schemaVersion === "16") {
    migrateSchema16To17(db);
    migrateSchema17To18(db);
    return;
  }
  if (schemaVersion === "17") {
    migrateSchema17To18(db);
    return;
  }
  if (schemaVersion === CURRENT_SCHEMA_VERSION) {
    return;
  }
  throw new Error(
    `Index schema version ${schemaVersion} is incompatible with this version of ` +
      `@intentweave/index (expected ${CURRENT_SCHEMA_VERSION}). Run \`iw index build\` ` +
      `with a compatible CLI/runtime.`,
  );
}

function assertSupportedSchemaVersion(db: Database.Database): void {
  const schemaVersion = readSchemaVersion(db);
  if (
    schemaVersion &&
    schemaVersion !== "14" &&
    schemaVersion !== "15" &&
    schemaVersion !== "16" &&
    schemaVersion !== "17" &&
    schemaVersion !== CURRENT_SCHEMA_VERSION
  ) {
    throw new Error(
      `Index schema version ${schemaVersion} is incompatible with this version of ` +
        `@intentweave/index (expected ${CURRENT_SCHEMA_VERSION}). Run \`iw index build\` ` +
        `with a compatible CLI/runtime.`,
    );
  }
}

/**
 * Initialize the CARI schema on a fresh database.
 * Safe to call on an existing database (IF NOT EXISTS guards).
 */
export function initSchema(db: Database.Database): void {
  assertSupportedSchemaVersion(db);
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

  migrateSchemaToCurrent(db);
}
