// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { initSchema, migrateSchema14To15 } from "../schema.js";

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
    const symbols = db.prepare(`SELECT COUNT(*) AS count FROM symbols`).get() as {
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
    expect(
      db.prepare(`SELECT legacy_version FROM _meta`).get(),
    ).toEqual({ legacy_version: "14" });
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
      .prepare(`SELECT text, symbol_id FROM annotations WHERE doc_path = 'docs/auth.md'`)
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

  it("creates all 14 companion tables with correct constraints", () => {
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
  });
});
