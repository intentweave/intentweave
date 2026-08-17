// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discardClaimsHistory,
  initSchema,
  migrateSchema14To15,
  migrateSchema15To16,
  restoreClaimsHistory,
  snapshotClaimsHistory,
} from "../schema.js";
import { buildIndex } from "../writer.js";

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
});
