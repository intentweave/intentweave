// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "@intentweave/sqlite-compat";
import {
  initSchema,
  migrateSchema14To15,
  migrateSchema15To16,
  migrateSchemaToCurrent,
} from "../schema.js";

describe("initSchema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all core tables", () => {
    initSchema(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain("symbols");
    expect(tables).toContain("annotations");
    expect(tables).toContain("co_occurrences");
    expect(tables).toContain("co_changes");
    expect(tables).toContain("files");
    expect(tables).toContain("imports");
    expect(tables).toContain("todos");
    expect(tables).toContain("def_use_chains");
    expect(tables).toContain("external_entities");
    expect(tables).toContain("_meta");
  });

  it("creates FTS5 virtual tables", () => {
    initSchema(db);

    const vtables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%' ORDER BY name`,
      )
      .all()
      .map((r: any) => r.name);

    expect(vtables).toContain("symbols_fts");
    expect(vtables).toContain("annotations_fts");
  });

  it("creates expected indexes", () => {
    initSchema(db);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`,
      )
      .all()
      .map((r: any) => r.name);

    expect(indexes).toContain("idx_symbols_name");
    expect(indexes).toContain("idx_symbols_file");
    expect(indexes).toContain("idx_annotations_doc");
    expect(indexes).toContain("idx_annotations_symbol");
    expect(indexes).toContain("idx_annotations_confidence");
    expect(indexes).toContain("idx_co_occurrences_score");
    expect(indexes).toContain("idx_co_changes_jaccard");
    expect(indexes).toContain("idx_files_doc");
    expect(indexes).toContain("idx_symbols_body_hash");
    expect(indexes).toContain("idx_files_doc_group");
    expect(indexes).toContain("idx_imports_source");
    expect(indexes).toContain("idx_imports_target");
    expect(indexes).toContain("idx_todos_file");
    expect(indexes).toContain("idx_todos_kind");
    expect(indexes).toContain("idx_def_use_file");
  });

  it("stores schema version in _meta", () => {
    initSchema(db);

    const row = db
      .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .get() as any;

    expect(row?.value).toBe("19");
  });

  it("migrates a schema-14 index with the claims companion tables", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);

    migrateSchema14To15(db);
    migrateSchema14To15(db);

    const version = db
      .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    const claimsTables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
          'parameter_identities', 'parameter_evidence_bindings',
          'evidence_identities', 'evidence_versions', 'evidence_continuity',
          'rule_result_identities', 'rule_result_versions', 'rule_result_evidence',
          'claim_identities', 'claim_versions', 'claim_assessments',
          'claim_assessment_references', 'claim_assessment_dependencies', 'review_decisions',
          'review_decision_reopens'
        )`,
      )
      .all() as Array<{ name: string }>;

    expect(version.value).toBe("15");
    expect(claimsTables).toHaveLength(15);
  });

  it("migrates schema-15 indexes to schema-16", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '15');
      CREATE TABLE claim_identities (id TEXT PRIMARY KEY);
      CREATE TABLE claim_versions (
        id TEXT PRIMARY KEY,
        claim_identity_id TEXT NOT NULL,
        repository_revision TEXT NOT NULL
      );
      CREATE TABLE claim_assessments (
        id TEXT PRIMARY KEY,
        claim_version_id TEXT NOT NULL,
        repository_revision TEXT NOT NULL,
        reference_key TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO claim_identities (id) VALUES ('claim:1');
      INSERT INTO claim_versions (id, claim_identity_id, repository_revision)
        VALUES ('claim-version:1', 'claim:1', 'rev:1');
      INSERT INTO claim_assessments (
        id, claim_version_id, repository_revision, reference_key, created_at
      ) VALUES ('assessment:1', 'claim-version:1', 'rev:1', 'ref:1', 1);
    `);

    migrateSchema15To16(db);

    const version = db
      .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(version.value).toBe("16");
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'claim_assessment_references'`,
        )
        .get(),
    ).toEqual({ name: "claim_assessment_references" });
    expect(
      db
        .prepare(
          `SELECT claim_identity_id, repository_revision, assessment_id
           FROM claim_assessment_references`,
        )
        .get(),
    ).toEqual({
      claim_identity_id: "claim:1",
      repository_revision: "rev:1",
      assessment_id: "assessment:1",
    });
  });

  it("runs chained 14->15->16->17->18->19 migration through migrateSchemaToCurrent", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);

    migrateSchemaToCurrent(db);

    expect(
      db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get(),
    ).toEqual({ value: "19" });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'claim_assessment_references'`,
        )
        .get(),
    ).toEqual({ name: "claim_assessment_references" });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'subject_continuity'`,
        )
        .get(),
    ).toEqual({ name: "subject_continuity" });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'claim_candidates'`,
        )
        .get(),
    ).toEqual({ name: "claim_candidates" });
    expect(
      (
        db.prepare(`PRAGMA table_info(claim_identities)`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    ).toEqual(
      expect.arrayContaining([
        "identity_contract_id",
        "identity_contract_version",
      ]),
    );
    expect(
      (
        db.prepare(`PRAGMA table_info(claim_versions)`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    ).toEqual(
      expect.arrayContaining([
        "materiality_contract_id",
        "materiality_contract_version",
      ]),
    );
  });

  it("rejects unknown newer schema versions instead of downgrading", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '20');
      CREATE TABLE future_only (id TEXT PRIMARY KEY);
    `);
    const schemaBefore = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all();

    expect(() => initSchema(db)).toThrow(/schema version 20 is incompatible/i);
    expect(
      db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get(),
    ).toEqual({ value: "20" });
    expect(
      db
        .prepare(
          `SELECT type, name, sql FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%'
           ORDER BY type, name`,
        )
        .all(),
    ).toEqual(schemaBefore);
  });

  it("sets WAL journal mode", () => {
    initSchema(db);

    const rows = db.pragma("journal_mode") as any;
    // pragma() returns an array of objects like [{journal_mode:'wal'}]
    const mode = Array.isArray(rows)
      ? rows[0]?.journal_mode
      : rows?.journal_mode;
    // In-memory databases may report "memory" instead of "wal"
    expect(["wal", "memory"]).toContain(mode);
  });

  it("is idempotent (safe to call twice)", () => {
    initSchema(db);
    initSchema(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all();

    // Should not throw, and tables should still exist
    expect(tables.length).toBeGreaterThanOrEqual(6);
  });

  it("allows inserting into symbols table", () => {
    initSchema(db);

    db.prepare(
      `INSERT INTO symbols (id, name, kind, file_path, line, export)
       VALUES ('impl:foo.ts#function:bar', 'bar', 'function', 'foo.ts', 10, 'exported')`,
    ).run();

    const count = db.prepare(`SELECT count(*) as c FROM symbols`).get() as any;
    expect(count.c).toBe(1);
  });

  it("enforces foreign key on annotations.symbol_id", () => {
    initSchema(db);

    // Valid: null symbol_id
    db.prepare(
      `INSERT INTO annotations (doc_path, line, text, confidence, source)
       VALUES ('doc.md', 1, 'test', 0.5, 'code-span')`,
    ).run();

    // Invalid: non-existent symbol_id
    expect(() =>
      db
        .prepare(
          `INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source)
         VALUES ('doc.md', 2, 'test', 'nonexistent', 0.5, 'code-span')`,
        )
        .run(),
    ).toThrow();
  });
});
