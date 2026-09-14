// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discardClaimsHistory,
  initSchema,
  migrateSchema14To15,
  migrateSchema15To16,
  migrateSchema16To17,
  migrateSchema17To18,
  migrateSchema18To19,
  openMigratedDatabase,
  restoreClaimsHistory,
  snapshotClaimsHistory,
  schemaMigrationBackupPath,
} from "../schema.js";
import { buildIndex } from "../writer.js";
import { CandidateStore } from "../claims/candidates.js";

describe("migrateSchema14To15 hardening", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("rolls back companion tables when the migration metadata write fails", () => {
    // `_meta` is deliberately malformed so the final metadata write fails only
    // after the companion DDL has been executed inside the migration transaction.
    db.exec(`
      CREATE TABLE _meta (legacy_version TEXT PRIMARY KEY);
      INSERT INTO _meta (legacy_version) VALUES ('14');
      CREATE TABLE symbols (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO symbols (id, name) VALUES ('test:1', 'testSymbol');
    `);

    expect(() => migrateSchema14To15(db)).toThrow(/no column named key/);

    // Core data survives, but no partial companion schema may escape the transaction.
    const symbols = db
      .prepare(`SELECT COUNT(*) AS count FROM symbols`)
      .get() as {
      count: number;
    };
    expect(symbols.count).toBe(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'parameter_identities'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(db.prepare(`SELECT legacy_version FROM _meta`).get()).toEqual({
      legacy_version: "14",
    });
  });

  it("preserves existing core data during migration", () => {
    // Create schema-14 with core data
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
      CREATE TABLE symbols (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        export TEXT NOT NULL
      );
      CREATE TABLE annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        text TEXT NOT NULL,
        symbol_id TEXT,
        confidence REAL NOT NULL,
        source TEXT NOT NULL
      );
      INSERT INTO symbols (id, name, kind, file_path, line, export)
        VALUES ('test:1', 'authService', 'function', 'src/auth.ts', 10, 'exported');
      INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source)
        VALUES ('docs/auth.md', 5, 'AuthService', 'test:1', 0.9, 'code-span');
    `);

    migrateSchema14To15(db);

    // Verify core data preserved
    const symbol = db
      .prepare(`SELECT name, kind FROM symbols WHERE id = 'test:1'`)
      .get() as { name: string; kind: string };
    expect(symbol).toEqual({ name: "authService", kind: "function" });

    const annotation = db
      .prepare(
        `SELECT text, symbol_id FROM annotations WHERE doc_path = 'docs/auth.md'`,
      )
      .get() as { text: string; symbol_id: string };
    expect(annotation).toEqual({ text: "AuthService", symbol_id: "test:1" });

    // Verify claims tables created
    const claimsTables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
          'parameter_identities', 'evidence_identities', 'claim_identities'
        )`,
      )
      .all() as Array<{ name: string }>;
    expect(claimsTables).toHaveLength(3);
  });

  it("is idempotent after partial data exists in companion tables", () => {
    // Create schema-14
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);

    // First migration
    migrateSchema14To15(db);

    // Insert data into companion tables
    db.prepare(
      `INSERT INTO parameter_identities (id, canonical_key, created_at)
       VALUES ('param:1', 'session.timeout', 1000)`,
    ).run();

    // Second migration should not fail or duplicate
    migrateSchema14To15(db);

    const params = db
      .prepare(`SELECT COUNT(*) AS count FROM parameter_identities`)
      .get() as { count: number };
    expect(params.count).toBe(1);

    const version = db
      .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(version.value).toBe("15");
  });

  it("upgrades legacy schema-15 indexes without references to schema-16", () => {
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
      INSERT INTO claim_identities (id) VALUES ('claim:legacy');
      INSERT INTO claim_versions (id, claim_identity_id, repository_revision)
        VALUES ('claim-version:legacy', 'claim:legacy', 'rev:legacy');
      INSERT INTO claim_assessments (
        id, claim_version_id, repository_revision, reference_key, created_at
      ) VALUES ('assessment:legacy', 'claim-version:legacy', 'rev:legacy', 'ref:legacy', 1);
    `);

    migrateSchema15To16(db);

    expect(
      db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get(),
    ).toEqual({ value: "16" });
    expect(
      db
        .prepare(
          `SELECT claim_identity_id, repository_revision, assessment_id
           FROM claim_assessment_references`,
        )
        .get(),
    ).toEqual({
      claim_identity_id: "claim:legacy",
      repository_revision: "rev:legacy",
      assessment_id: "assessment:legacy",
    });
  });

  it("backfills Parameter Subjects and role links in schema 17", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(db);
    migrateSchema15To16(db);
    db.exec(`
      INSERT INTO parameter_identities (id, canonical_key, created_at)
        VALUES ('parameter:legacy', 'session.timeout', 10);
      INSERT INTO evidence_identities (
        id, parameter_identity_id, source_kind, identity_key, created_at
      ) VALUES ('evidence:legacy', 'parameter:legacy', 'code-default', 'legacy', 11);
      INSERT INTO claim_identities (
        id, parameter_identity_id, claim_type, scope, identity_key, created_at
      ) VALUES (
        'claim:legacy', 'parameter:legacy', 'CLM-DEFAULT', NULL,
        'session.timeout:CLM-DEFAULT:', 12
      );
    `);

    migrateSchema16To17(db);

    const subjectId =
      "subject:7b57ba0a2670daa7bc027664d912ee37df1cd3a49351a929bbc73dc8599c91bc";
    expect(
      db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get(),
    ).toEqual({ value: "17" });
    expect(
      db
        .prepare(
          `SELECT id, kind, identity_key, contract_version
           FROM subject_identities`,
        )
        .get(),
    ).toEqual({
      id: subjectId,
      kind: "parameter",
      identity_key: "parameter:session.timeout",
      contract_version: "1",
    });
    expect(
      db.prepare(`SELECT subject_identity_id FROM parameter_identities`).get(),
    ).toEqual({ subject_identity_id: subjectId });
    expect(db.prepare(`SELECT subject_role FROM claim_subjects`).get()).toEqual(
      {
        subject_role: "subject",
      },
    );
    expect(
      db
        .prepare(
          `SELECT subject_role, basis, confidence FROM evidence_subjects`,
        )
        .get(),
    ).toEqual({
      subject_role: "subject",
      basis: "parameter-compatibility",
      confidence: "certain",
    });
  });

  it("rolls back schema 17 when Subject backfill conflicts", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(db);
    migrateSchema15To16(db);
    db.exec(`
      INSERT INTO parameter_identities (id, canonical_key, created_at)
        VALUES ('parameter:legacy', 'session.timeout', 10);
      CREATE TABLE subject_identities (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, identity_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, lifecycle_state TEXT NOT NULL,
        contract_version TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO subject_identities VALUES (
        'subject:conflict', 'parameter', 'parameter:session.timeout',
        'session.timeout', 'active', '1', 1
      );
    `);

    expect(() => migrateSchema16To17(db)).toThrow();
    expect(
      db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get(),
    ).toEqual({ value: "16" });
    expect(
      (
        db.prepare(`PRAGMA table_info(parameter_identities)`).all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === "subject_identity_id"),
    ).toBe(false);
  });

  it("restores Claims history from a WAL-safe snapshot after a fresh rebuild", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-claims-history-"),
    );
    const sourcePath = path.join(directory, "source.db");
    const source = new Database(sourcePath);
    initSchema(source);
    source
      .prepare(
        `INSERT INTO parameter_identities (id, canonical_key, created_at)
         VALUES ('parameter:timeout', 'session.timeout', 1)`,
      )
      .run();
    source
      .prepare(
        `INSERT INTO evidence_identities
           (id, parameter_identity_id, source_kind, identity_key, created_at)
         VALUES ('evidence:timeout', 'parameter:timeout', 'code-default', 'timeout', 1)`,
      )
      .run();
    new CandidateStore(source).persist({
      identityKey: "r1:code:variable:timeout:CLM-DEFAULT",
      candidateKind: "r1-code-value",
      proposedClaimType: "CLM-DEFAULT",
      discoveryMode: "deterministic",
      discoveryAdapterId: "r1-code-values",
      discoveryContractVersion: "1",
      confidence: "probable",
      normalizedStatement: { value: 1800 },
      provenance: { revision: "source" },
      evidence: [
        {
          evidenceKey: "r1:timeout",
          sourceKind: "code-default",
          provenance: { file: "src/session.ts" },
        },
      ],
      subjects: [
        {
          kind: "parameter",
          identityKey: "parameter:code:variable:timeout",
          role: "subject",
          basis: "r1-discovery",
          confidence: "probable",
        },
      ],
    });
    source.close();

    const snapshot = snapshotClaimsHistory(sourcePath);
    const rebuilt = new Database(path.join(directory, "rebuilt.db"));
    initSchema(rebuilt);
    restoreClaimsHistory(rebuilt, snapshot);

    expect(
      rebuilt.prepare(`SELECT canonical_key FROM parameter_identities`).get(),
    ).toEqual({ canonical_key: "session.timeout" });
    expect(
      rebuilt.prepare(`SELECT source_kind FROM evidence_identities`).get(),
    ).toEqual({ source_kind: "code-default" });
    expect(
      rebuilt
        .prepare(`SELECT state, candidate_kind FROM claim_candidates`)
        .get(),
    ).toEqual({ state: "correlated", candidate_kind: "r1-code-value" });
    rebuilt.close();
    discardClaimsHistory(snapshot);
    rmSync(directory, { recursive: true, force: true });
  });

  it("captures and restores legacy schema-15 snapshots without references table", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-claims-legacy-snapshot-"),
    );
    const sourcePath = path.join(directory, "legacy-v15.db");
    const source = new Database(sourcePath);
    initSchema(source);
    source.exec(`DROP TABLE claim_assessment_references`);
    source
      .prepare(`UPDATE _meta SET value = '15' WHERE key = 'schema_version'`)
      .run();
    source
      .prepare(
        `INSERT INTO parameter_identities (id, canonical_key, created_at)
         VALUES ('parameter:legacy-timeout', 'session.timeout', 1)`,
      )
      .run();
    source.close();

    const snapshot = snapshotClaimsHistory(sourcePath);
    expect(snapshot).toBeDefined();

    const rebuilt = new Database(path.join(directory, "rebuilt.db"));
    initSchema(rebuilt);
    restoreClaimsHistory(rebuilt, snapshot);
    expect(
      rebuilt.prepare(`SELECT canonical_key FROM parameter_identities`).get(),
    ).toEqual({ canonical_key: "session.timeout" });
    expect(
      rebuilt
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'claim_assessment_references'`,
        )
        .get(),
    ).toEqual({ name: "claim_assessment_references" });
    rebuilt.close();
    discardClaimsHistory(snapshot);
    rmSync(directory, { recursive: true, force: true });
  });

  it("restores a real schema-16 snapshot into schema 17 and backfills Subjects", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-claims-v16-snapshot-"),
    );
    const sourcePath = path.join(directory, "schema-16.db");
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(source);
    migrateSchema15To16(source);
    source
      .prepare(
        `INSERT INTO parameter_identities (id, canonical_key, created_at)
         VALUES ('parameter:legacy', 'session.timeout', 10)`,
      )
      .run();
    source.close();

    const snapshot = snapshotClaimsHistory(sourcePath);
    const rebuilt = new Database(path.join(directory, "rebuilt.db"));
    initSchema(rebuilt);
    restoreClaimsHistory(rebuilt, snapshot);

    expect(
      rebuilt
        .prepare(
          `SELECT parameter.id, parameter.canonical_key,
                  subject.identity_key, subject.contract_version
           FROM parameter_identities parameter
           JOIN subject_identities subject ON subject.id = parameter.subject_identity_id`,
        )
        .get(),
    ).toEqual({
      id: "parameter:legacy",
      canonical_key: "session.timeout",
      identity_key: "parameter:session.timeout",
      contract_version: "1",
    });
    rebuilt.close();
    discardClaimsHistory(snapshot);
    rmSync(directory, { recursive: true, force: true });
  });

  it("restores schema-17 Subject links into a schema-18 rebuild", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-claims-v17-snapshot-"),
    );
    const sourcePath = path.join(directory, "schema-17.db");
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(source);
    migrateSchema15To16(source);
    source.exec(`
      INSERT INTO parameter_identities (id, canonical_key, created_at)
        VALUES ('parameter:legacy', 'session.timeout', 10);
      INSERT INTO claim_identities (
        id, parameter_identity_id, claim_type, scope, identity_key, created_at
      ) VALUES (
        'claim:legacy', 'parameter:legacy', 'CLM-DEFAULT', NULL,
        'session.timeout:CLM-DEFAULT:', 12
      );
    `);
    migrateSchema16To17(source);
    source.close();

    const snapshot = snapshotClaimsHistory(sourcePath);
    const rebuilt = new Database(path.join(directory, "rebuilt.db"));
    initSchema(rebuilt);
    restoreClaimsHistory(rebuilt, snapshot);

    expect(
      rebuilt
        .prepare(
          `SELECT subject.identity_key, link.subject_role
           FROM claim_subjects link
           JOIN subject_identities subject
             ON subject.id = link.subject_identity_id
           WHERE link.claim_identity_id = 'claim:legacy'`,
        )
        .get(),
    ).toEqual({
      identity_key: "parameter:session.timeout",
      subject_role: "subject",
    });
    expect(rebuilt.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    rebuilt.close();
    discardClaimsHistory(snapshot);
    rmSync(directory, { recursive: true, force: true });
  });

  it("retains a durable schema-16 backup after an in-place G1a migration", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-g1a-success-"),
    );
    const dbPath = path.join(directory, "index.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(legacy);
    migrateSchema15To16(legacy);
    legacy
      .prepare(
        `INSERT INTO parameter_identities (id, canonical_key, created_at)
         VALUES ('parameter:legacy', 'session.timeout', 10)`,
      )
      .run();
    legacy.close();

    const migrated = openMigratedDatabase(dbPath);
    expect(
      migrated
        .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "19" });
    migrated.close();

    const backupPath = schemaMigrationBackupPath(dbPath, "16");
    expect(existsSync(backupPath)).toBe(true);
    const backup = new Database(backupPath, { readonly: true });
    expect(
      backup
        .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "16" });
    expect(
      backup.prepare(`SELECT canonical_key FROM parameter_identities`).get(),
    ).toEqual({ canonical_key: "session.timeout" });
    backup.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("atomically restores the durable backup after a failed in-place migration", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-g1a-failure-"),
    );
    const dbPath = path.join(directory, "index.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(legacy);
    migrateSchema15To16(legacy);
    legacy.close();

    expect(() =>
      openMigratedDatabase(dbPath, (database) => {
        database.exec(`CREATE TABLE g1a_partial_write (id TEXT PRIMARY KEY)`);
        throw new Error("injected G1a failure");
      }),
    ).toThrow("injected G1a failure");

    const restored = new Database(dbPath, { readonly: true });
    expect(
      restored
        .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "16" });
    expect(
      restored
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'g1a_partial_write'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    restored.close();
    expect(existsSync(schemaMigrationBackupPath(dbPath, "16"))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  });

  it("preserves the existing database when a rebuild fails before atomic replacement", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-atomic-build-"),
    );
    const targetPath = path.join(directory, "index.db");
    const existing = new Database(targetPath);
    initSchema(existing);
    existing
      .prepare(
        `INSERT INTO parameter_identities (id, canonical_key, created_at)
         VALUES ('parameter:timeout', 'session.timeout', 1)`,
      )
      .run();
    existing.close();

    expect(() =>
      buildIndex(
        { files: undefined } as never,
        [],
        { coOccurrences: [] } as never,
        { files: [] } as never,
        [],
        {
          session: "atomic-failure",
          workspaceRoot: directory,
          depth: "structured",
          outputPath: targetPath,
        },
      ),
    ).toThrow();

    const preserved = new Database(targetPath);
    expect(
      preserved.prepare(`SELECT canonical_key FROM parameter_identities`).get(),
    ).toEqual({ canonical_key: "session.timeout" });
    preserved.close();
    expect(
      readdirSync(directory).filter((file) => file.includes(".tmp")),
    ).toEqual([]);
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates all 15 companion tables with correct constraints", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);

    migrateSchema14To15(db);

    const expectedTables = [
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
      "claim_assessment_references",
      "claim_assessment_dependencies",
      "review_decisions",
      "review_decision_reopens",
    ];

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${expectedTables
          .map(() => "?")
          .join(",")})`,
      )
      .all(...expectedTables) as Array<{ name: string }>;

    expect(tables.map((t) => t.name).sort()).toEqual(expectedTables.sort());

    // Verify unique constraints exist
    const evidenceVersionsConstraints = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evidence_versions'`,
      )
      .get() as { sql: string };
    expect(evidenceVersionsConstraints.sql).toContain(
      "UNIQUE (evidence_identity_id, version_ordinal)",
    );
    expect(evidenceVersionsConstraints.sql).toContain(
      "UNIQUE (evidence_identity_id, fingerprint)",
    );

    const referenceConstraints = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claim_assessment_references'`,
      )
      .get() as { sql: string };
    expect(referenceConstraints.sql).toContain(
      "PRIMARY KEY (claim_identity_id, repository_revision)",
    );
  });

  it("rebuilds claim_identities with a nullable legacy Parameter link in schema 18", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(db);
    migrateSchema15To16(db);
    db.exec(`
      INSERT INTO parameter_identities (id, canonical_key, created_at)
        VALUES ('parameter:legacy', 'session.timeout', 10);
      INSERT INTO claim_identities (
        id, parameter_identity_id, claim_type, scope, identity_key, created_at
      ) VALUES (
        'claim:legacy', 'parameter:legacy', 'CLM-DEFAULT', NULL,
        'session.timeout:CLM-DEFAULT:', 12
      );
    `);
    migrateSchema16To17(db);
    db.exec(`
      INSERT INTO claim_versions (
        id, claim_identity_id, version_ordinal, normalized_statement_json,
        assessment_policy_id, assessment_policy_version,
        repository_revision, created_at
      ) VALUES (
        'claim:legacy@1', 'claim:legacy', 1, '{"value":1800}',
        'default-contract', '1', 'rev:legacy', 13
      );
      INSERT INTO claim_assessments (
        id, claim_version_id, assessment_key, epistemic_status,
        repository_revision, is_current, created_at
      ) VALUES (
        'assessment:legacy', 'claim:legacy@1', 'assessment-key:legacy',
        'supported', 'rev:legacy', 1, 14
      );
      INSERT INTO claim_assessment_references (
        claim_identity_id, repository_revision, assessment_id, created_at
      ) VALUES ('claim:legacy', 'rev:legacy', 'assessment:legacy', 15);
      INSERT INTO review_decisions (
        id, claim_identity_id, basis_assessment_id, decision, actor,
        decision_origin, is_current, created_at
      ) VALUES (
        'review:legacy', 'claim:legacy', 'assessment:legacy', 'accepted',
        'reviewer', 'manual', 1, 16
      );
    `);

    migrateSchema17To18(db);

    expect(
      db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get(),
    ).toEqual({ value: "18" });
    const parameterColumn = (
      db.prepare(`PRAGMA table_info(claim_identities)`).all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((column) => column.name === "parameter_identity_id");
    expect(parameterColumn?.notnull).toBe(0);
    // Existing Parameter rows retain their original foreign key and IDs.
    expect(
      db
        .prepare(
          `SELECT ci.id, ci.parameter_identity_id, ci.identity_key,
                  ci.identity_contract_id, ci.identity_contract_version
           FROM claim_identities ci`,
        )
        .get(),
    ).toEqual({
      id: "claim:legacy",
      parameter_identity_id: "parameter:legacy",
      identity_key: "session.timeout:CLM-DEFAULT:",
      identity_contract_id: null,
      identity_contract_version: null,
    });
    expect(
      db
        .prepare(
          `SELECT cv.id AS claim_version_id, ca.id AS assessment_id,
                  reference.assessment_id AS reference_assessment_id,
                  review.id AS review_id,
                  cv.materiality_contract_id,
                  cv.materiality_contract_version
           FROM claim_versions cv
           JOIN claim_assessments ca ON ca.claim_version_id = cv.id
           JOIN claim_assessment_references reference
             ON reference.claim_identity_id = cv.claim_identity_id
           JOIN review_decisions review
             ON review.claim_identity_id = cv.claim_identity_id`,
        )
        .get(),
    ).toEqual({
      claim_version_id: "claim:legacy@1",
      assessment_id: "assessment:legacy",
      reference_assessment_id: "assessment:legacy",
      review_id: "review:legacy",
      materiality_contract_id: null,
      materiality_contract_version: null,
    });
    expect(db.prepare(`SELECT subject_role FROM claim_subjects`).get()).toEqual(
      {
        subject_role: "subject",
      },
    );
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    // Generic Claims without a Parameter identity are now persistable.
    db.prepare(
      `INSERT INTO claim_identities (
         id, parameter_identity_id, claim_type, scope, identity_key, created_at
       ) VALUES ('claim:generic', NULL, 'CLM-DEPENDENCY-CONFORMANCE', NULL,
                 'generic:dependency', 13)`,
    ).run();
    expect(
      db
        .prepare(
          `SELECT parameter_identity_id FROM claim_identities
           WHERE id = 'claim:generic'`,
        )
        .get(),
    ).toEqual({ parameter_identity_id: null });
  });

  it("retains a durable schema-17 backup after an in-place G1b migration", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-g1b-success-"),
    );
    const dbPath = path.join(directory, "index.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(legacy);
    migrateSchema15To16(legacy);
    legacy
      .prepare(
        `INSERT INTO parameter_identities (id, canonical_key, created_at)
         VALUES ('parameter:legacy', 'session.timeout', 10)`,
      )
      .run();
    migrateSchema16To17(legacy);
    legacy.close();

    const migrated = openMigratedDatabase(dbPath);
    expect(
      migrated
        .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "19" });
    migrated.close();

    const backupPath = schemaMigrationBackupPath(dbPath, "17");
    expect(existsSync(backupPath)).toBe(true);
    const backup = new Database(backupPath, { readonly: true });
    expect(
      backup
        .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "17" });
    expect(
      backup.prepare(`SELECT canonical_key FROM parameter_identities`).get(),
    ).toEqual({ canonical_key: "session.timeout" });
    backup.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("migrates schema 18 to 19 without changing existing Claim history", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(db);
    migrateSchema15To16(db);
    migrateSchema16To17(db);
    migrateSchema17To18(db);
    db.exec(`
      INSERT INTO subject_identities (
        id, kind, identity_key, display_name, lifecycle_state,
        contract_version, created_at
      ) VALUES (
        'subject:existing', 'module', 'module:existing', 'existing',
        'active', '1', 1
      );
      INSERT INTO claim_identities (
        id, parameter_identity_id, claim_type, scope, identity_key,
        identity_contract_id, identity_contract_version, created_at
      ) VALUES (
        'claim:existing', NULL, 'CLM-MODULE-CONTRACT', NULL,
        'module:existing:contract', 'module-identity', '1', 2
      );
      INSERT INTO claim_subjects (
        claim_identity_id, subject_identity_id, subject_role, created_at
      ) VALUES ('claim:existing', 'subject:existing', 'subject', 2);
    `);

    migrateSchema18To19(db);

    expect(
      db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get(),
    ).toEqual({ value: "19" });
    expect(
      db
        .prepare(
          `SELECT ci.id, subject.subject_role
           FROM claim_identities ci
           JOIN claim_subjects subject ON subject.claim_identity_id = ci.id`,
        )
        .get(),
    ).toEqual({ id: "claim:existing", subject_role: "subject" });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'candidate_%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "candidate_evidence" },
      { name: "candidate_inferences" },
      { name: "candidate_policy_decisions" },
      { name: "candidate_reviews" },
      { name: "candidate_subjects" },
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'claim_candidates'`,
        )
        .get(),
    ).toEqual({ name: "claim_candidates" });
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });

  it("rolls back every Candidate table when schema 19 migration fails", () => {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(db);
    migrateSchema15To16(db);
    migrateSchema16To17(db);
    migrateSchema17To18(db);
    db.exec(`CREATE TABLE candidate_reviews (wrong_column TEXT)`);

    expect(() => migrateSchema18To19(db)).toThrow();

    expect(
      db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get(),
    ).toEqual({ value: "18" });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'claim_candidates'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("atomically restores the schema-17 backup after a failed G1b migration", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-g1b-failure-"),
    );
    const dbPath = path.join(directory, "index.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO _meta (key, value) VALUES ('schema_version', '14');
    `);
    migrateSchema14To15(legacy);
    migrateSchema15To16(legacy);
    migrateSchema16To17(legacy);
    legacy.close();

    expect(() =>
      openMigratedDatabase(dbPath, undefined, (database) => {
        database.exec(`CREATE TABLE g1b_partial_write (id TEXT PRIMARY KEY)`);
        throw new Error("injected G1b failure");
      }),
    ).toThrow("injected G1b failure");

    const restored = new Database(dbPath, { readonly: true });
    expect(
      restored
        .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "17" });
    expect(
      restored
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'g1b_partial_write'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    restored.close();
    expect(existsSync(schemaMigrationBackupPath(dbPath, "17"))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects reopening a database written by a newer schema after G1b", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "intentweave-g1b-downgrade-"),
    );
    const dbPath = path.join(directory, "index.db");
    const database = new Database(dbPath);
    initSchema(database);
    database
      .prepare(
        `INSERT OR REPLACE INTO _meta (key, value)
         VALUES ('schema_version', '20')`,
      )
      .run();
    database.close();

    expect(() => openMigratedDatabase(dbPath)).toThrow(
      /schema version 20 is incompatible/i,
    );
    const untouched = new Database(dbPath, { readonly: true });
    expect(
      untouched
        .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: "20" });
    untouched.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
