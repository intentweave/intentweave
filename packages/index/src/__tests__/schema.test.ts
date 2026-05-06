// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../schema.js";

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

    expect(row?.value).toBe("13");
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
