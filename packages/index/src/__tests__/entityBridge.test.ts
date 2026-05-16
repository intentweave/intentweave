// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Entity Bridge feature (8.0a).
 *
 * Covers: external_entities table, registerExternalEntities(),
 * mentionsOfFromDb(), annotationsForFileFromDb(), and CariIndex facade methods.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { registerExternalEntities } from "../writer.js";
import {
  mentionsOfFromDb,
  annotationsForFileFromDb,
} from "../queries/entityBridge.js";
import type { ExternalEntity } from "../types.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let db: Database.Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `cari-entity-bridge-test-${Date.now()}.db`);
  db = new Database(dbPath);
  initSchema(db);
  seedFixtures(db);
});

afterAll(() => {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

function seedFixtures(db: Database.Database) {
  // ── Symbols ────────────────────────────────────────────────
  const insertSym = db.prepare(`
    INSERT INTO symbols (id, name, kind, container, signature, file_path, line, end_line, export, doc_summary, body_hash, body_lines, structure_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const symbols = [
    [
      "impl:src/auth/service.ts#class:AuthService",
      "AuthService",
      "class",
      null,
      "class AuthService",
      "src/auth/service.ts",
      10,
      100,
      "exported",
      "Handles authentication",
      null,
      null,
      null,
    ],
    [
      "impl:src/db/pool.ts#class:DatabasePool",
      "DatabasePool",
      "class",
      null,
      "class DatabasePool",
      "src/db/pool.ts",
      1,
      80,
      "exported",
      "Database connection pool",
      null,
      null,
      null,
    ],
  ];

  const symTx = db.transaction(() => {
    for (const sym of symbols) insertSym.run(...sym);
  });
  symTx();

  // ── Annotations ────────────────────────────────────────────
  const insertAnn = db.prepare(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const annotations = [
    // Grounded to AuthService symbol
    [
      "docs/AUTH.md",
      10,
      "AuthService",
      "impl:src/auth/service.ts#class:AuthService",
      1.0,
      "code-span",
      null,
      null,
    ],
    // Grounded to DatabasePool symbol
    [
      "docs/AUTH.md",
      25,
      "DatabasePool",
      "impl:src/db/pool.ts#class:DatabasePool",
      0.9,
      "bold",
      null,
      null,
    ],
    // Ungrounded — matches future external entity "auth service"
    ["docs/AUTH.md", 52, "auth service", null, 0.3, "heading", null, null],
    // Ungrounded — matches future external entity "authentication module"
    [
      "docs/ARCHITECTURE.md",
      172,
      "authentication module",
      null,
      0.1,
      "dictionary",
      "decision",
      0.5,
    ],
    // Ungrounded — matches future external entity "ADR-005"
    ["docs/DECISIONS.md", 30, "ADR-005", null, 0.1, "code-span", null, null],
    // Ungrounded — no match to anything
    [
      "docs/AUTH.md",
      80,
      "some unrelated concept",
      null,
      0.1,
      "dictionary",
      null,
      null,
    ],
    // Grounded to AuthService symbol in a different doc
    [
      "docs/API.md",
      5,
      "AuthService",
      "impl:src/auth/service.ts#class:AuthService",
      1.0,
      "code-span",
      null,
      null,
    ],
  ];

  const annTx = db.transaction(() => {
    for (const ann of annotations) insertAnn.run(...ann);
  });
  annTx();

  // Rebuild FTS
  db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`);
}

// =============================================================================
// Schema Tests
// =============================================================================

describe("Entity Bridge — schema", () => {
  it("creates external_entities table with correct columns", () => {
    const info = db
      .prepare(
        `SELECT name FROM pragma_table_info('external_entities') ORDER BY cid`,
      )
      .all() as Array<{ name: string }>;
    const columns = info.map((r) => r.name);
    expect(columns).toEqual(["id", "name", "type", "aliases", "metadata"]);
  });

  it("schema version is current", () => {
    const row = db
      .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(row.value).toBe("14");
  });
});

// =============================================================================
// registerExternalEntities Tests
// =============================================================================

describe("Entity Bridge — registerExternalEntities", () => {
  let rwDbPath: string;

  beforeAll(() => {
    // Create a separate writable copy for registration tests
    rwDbPath = path.join(os.tmpdir(), `cari-entity-bridge-rw-${Date.now()}.db`);
    const rwDb = new Database(rwDbPath);
    initSchema(rwDb);

    // Seed with the same ungrounded annotations
    const insertAnn = rwDb.prepare(`
      INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = rwDb.transaction(() => {
      insertAnn.run(
        "docs/AUTH.md",
        52,
        "auth service",
        null,
        0.3,
        "heading",
        null,
        null,
      );
      insertAnn.run(
        "docs/ARCH.md",
        172,
        "authentication module",
        null,
        0.1,
        "dictionary",
        "decision",
        0.5,
      );
      insertAnn.run(
        "docs/DECISIONS.md",
        30,
        "ADR-005",
        null,
        0.1,
        "code-span",
        null,
        null,
      );
      insertAnn.run(
        "docs/UNRELATED.md",
        1,
        "some other text",
        null,
        0.1,
        "dictionary",
        null,
        null,
      );
    });
    tx();

    rwDb.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
    rwDb.exec(`INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`);
    rwDb.close();
  });

  afterAll(() => {
    if (fs.existsSync(rwDbPath)) fs.unlinkSync(rwDbPath);
  });

  it("writes entities and creates annotations for matching mentions", () => {
    const entities: ExternalEntity[] = [
      {
        id: "entity:auth-service",
        name: "AuthService",
        type: "component",
        aliases: ["auth service", "authentication module"],
      },
      {
        id: "entity:adr-005",
        name: "ADR-005",
        type: "decision",
        aliases: ["token rotation decision"],
      },
    ];

    const result = registerExternalEntities(rwDbPath, entities);

    expect(result.entitiesWritten).toBe(2);
    // "auth service" and "authentication module" match entity:auth-service
    // "ADR-005" matches entity:adr-005
    expect(result.annotationsCreated).toBe(3);
  });

  it("stores entities correctly in the database", () => {
    const rwDb = new Database(rwDbPath, { readonly: true });
    try {
      const rows = rwDb
        .prepare(
          `SELECT id, name, type, aliases FROM external_entities ORDER BY id`,
        )
        .all() as Array<{
        id: string;
        name: string;
        type: string;
        aliases: string | null;
      }>;

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: "entity:adr-005",
        name: "ADR-005",
        type: "decision",
      });
      expect(rows[1]).toMatchObject({
        id: "entity:auth-service",
        name: "AuthService",
        type: "component",
      });

      // Check aliases are stored as JSON
      const aliases = JSON.parse(rows[1].aliases!);
      expect(aliases).toContain("auth service");
      expect(aliases).toContain("authentication module");
    } finally {
      rwDb.close();
    }
  });

  it("created annotations have source=external and correct entity IDs", () => {
    const rwDb = new Database(rwDbPath, { readonly: true });
    try {
      const rows = rwDb
        .prepare(
          `SELECT doc_path, text, symbol_id, confidence, source
           FROM annotations
           WHERE source = 'external'
           ORDER BY doc_path, line`,
        )
        .all() as Array<{
        doc_path: string;
        text: string;
        symbol_id: string;
        confidence: number;
        source: string;
      }>;

      expect(rows).toHaveLength(3);

      // "authentication module" → entity:auth-service
      expect(rows[0]).toMatchObject({
        doc_path: "docs/ARCH.md",
        text: "authentication module",
        symbol_id: "entity:auth-service",
        source: "external",
      });

      // "auth service" → entity:auth-service
      expect(rows[1]).toMatchObject({
        doc_path: "docs/AUTH.md",
        text: "auth service",
        symbol_id: "entity:auth-service",
        source: "external",
      });

      // "ADR-005" → entity:adr-005
      expect(rows[2]).toMatchObject({
        doc_path: "docs/DECISIONS.md",
        text: "ADR-005",
        symbol_id: "entity:adr-005",
        source: "external",
      });

      // Confidence should be at least 0.8
      for (const row of rows) {
        expect(row.confidence).toBeGreaterThanOrEqual(0.8);
      }
    } finally {
      rwDb.close();
    }
  });

  it("returns zero counts for empty entity array", () => {
    const result = registerExternalEntities(rwDbPath, []);
    expect(result).toEqual({ entitiesWritten: 0, annotationsCreated: 0 });
  });

  it("handles entities with metadata", () => {
    const emptyDbPath = path.join(
      os.tmpdir(),
      `cari-entity-bridge-meta-${Date.now()}.db`,
    );
    const emptyDb = new Database(emptyDbPath);
    initSchema(emptyDb);
    emptyDb.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
    emptyDb.exec(
      `INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`,
    );
    emptyDb.close();

    try {
      const entities: ExternalEntity[] = [
        {
          id: "entity:my-component",
          name: "MyComponent",
          type: "component",
          metadata: { version: "1.0", team: "platform" },
        },
      ];

      registerExternalEntities(emptyDbPath, entities);

      const checkDb = new Database(emptyDbPath, { readonly: true });
      try {
        const row = checkDb
          .prepare(
            `SELECT metadata FROM external_entities WHERE id = 'entity:my-component'`,
          )
          .get() as { metadata: string };
        const meta = JSON.parse(row.metadata);
        expect(meta).toEqual({ version: "1.0", team: "platform" });
      } finally {
        checkDb.close();
      }
    } finally {
      if (fs.existsSync(emptyDbPath)) fs.unlinkSync(emptyDbPath);
    }
  });
});

// =============================================================================
// mentionsOfFromDb Tests
// =============================================================================

describe("Entity Bridge — mentionsOfFromDb", () => {
  it("finds direct mentions by symbol ID", () => {
    const result = mentionsOfFromDb(db, {
      entityId: "impl:src/auth/service.ts#class:AuthService",
    });

    expect(result.entityId).toBe("impl:src/auth/service.ts#class:AuthService");
    expect(result.totalCount).toBeGreaterThanOrEqual(2);

    // Should include both docs/AUTH.md and docs/API.md mentions
    const docPaths = result.mentions.map((m) => m.docPath);
    expect(docPaths).toContain("docs/AUTH.md");
    expect(docPaths).toContain("docs/API.md");
  });

  it("returns empty for unknown entity ID", () => {
    const result = mentionsOfFromDb(db, {
      entityId: "entity:nonexistent",
    });

    expect(result.totalCount).toBe(0);
    expect(result.mentions).toEqual([]);
  });

  it("respects minConfidence filter", () => {
    const result = mentionsOfFromDb(db, {
      entityId: "impl:src/auth/service.ts#class:AuthService",
      minConfidence: 0.95,
    });

    for (const m of result.mentions) {
      expect(m.confidence).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("respects limit", () => {
    const result = mentionsOfFromDb(db, {
      entityId: "impl:src/auth/service.ts#class:AuthService",
      limit: 1,
    });

    expect(result.mentions).toHaveLength(1);
  });

  it("sorts by confidence descending", () => {
    const result = mentionsOfFromDb(db, {
      entityId: "impl:src/auth/service.ts#class:AuthService",
    });

    for (let i = 1; i < result.mentions.length; i++) {
      expect(result.mentions[i].confidence).toBeLessThanOrEqual(
        result.mentions[i - 1].confidence,
      );
    }
  });
});

// =============================================================================
// annotationsForFileFromDb Tests
// =============================================================================

describe("Entity Bridge — annotationsForFileFromDb", () => {
  it("lists all annotations for a document", () => {
    const result = annotationsForFileFromDb(db, {
      filePath: "docs/AUTH.md",
    });

    expect(result.filePath).toBe("docs/AUTH.md");
    expect(result.totalCount).toBeGreaterThanOrEqual(3);

    // Should have AuthService (symbol), DatabasePool (symbol), and ungrounded
    const texts = result.annotations.map((a) => a.text);
    expect(texts).toContain("AuthService");
    expect(texts).toContain("DatabasePool");
  });

  it("resolves entity names from symbols table", () => {
    const result = annotationsForFileFromDb(db, {
      filePath: "docs/AUTH.md",
    });

    const authAnnotation = result.annotations.find(
      (a) => a.text === "AuthService",
    );
    expect(authAnnotation).toBeDefined();
    expect(authAnnotation!.entityName).toBe("AuthService");
    expect(authAnnotation!.entitySource).toBe("symbol");
  });

  it("returns empty for unknown file", () => {
    const result = annotationsForFileFromDb(db, {
      filePath: "docs/NONEXISTENT.md",
    });

    expect(result.totalCount).toBe(0);
    expect(result.annotations).toEqual([]);
  });

  it("respects minConfidence filter", () => {
    const result = annotationsForFileFromDb(db, {
      filePath: "docs/AUTH.md",
      minConfidence: 0.5,
    });

    for (const a of result.annotations) {
      expect(a.confidence).toBeGreaterThanOrEqual(0.5);
    }
    // Should exclude the 0.3 heading and 0.1 ungrounded entries
    expect(result.totalCount).toBeLessThan(4);
  });

  it("respects limit", () => {
    const result = annotationsForFileFromDb(db, {
      filePath: "docs/AUTH.md",
      limit: 2,
    });

    expect(result.annotations).toHaveLength(2);
  });

  it("marks ungrounded annotations correctly", () => {
    const result = annotationsForFileFromDb(db, {
      filePath: "docs/AUTH.md",
    });

    const ungrounded = result.annotations.filter((a) => !a.entityId);
    expect(ungrounded.length).toBeGreaterThan(0);
    for (const a of ungrounded) {
      expect(a.entitySource).toBeUndefined();
      expect(a.entityName).toBeUndefined();
    }
  });
});

// =============================================================================
// Integration: registerExternalEntities + mentionsOfFromDb
// =============================================================================

describe("Entity Bridge — integration", () => {
  let integDbPath: string;
  let integDb: Database.Database;

  beforeAll(() => {
    integDbPath = path.join(
      os.tmpdir(),
      `cari-entity-bridge-integ-${Date.now()}.db`,
    );
    integDb = new Database(integDbPath);
    initSchema(integDb);

    // Seed ungrounded annotations
    const insertAnn = integDb.prepare(`
      INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = integDb.transaction(() => {
      insertAnn.run(
        "docs/AUTH.md",
        52,
        "auth service",
        null,
        0.3,
        "heading",
        null,
        null,
      );
      insertAnn.run(
        "docs/ARCH.md",
        172,
        "authentication module",
        null,
        0.1,
        "dictionary",
        "decision",
        0.5,
      );
    });
    tx();

    integDb.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
    integDb.exec(
      `INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`,
    );
    integDb.close();

    // Register external entities
    registerExternalEntities(integDbPath, [
      {
        id: "entity:auth-service",
        name: "AuthService",
        type: "component",
        aliases: ["auth service", "authentication module"],
      },
    ]);

    integDb = new Database(integDbPath, { readonly: true });
  });

  afterAll(() => {
    integDb.close();
    if (fs.existsSync(integDbPath)) fs.unlinkSync(integDbPath);
  });

  it("mentionsOf finds external entity annotations", () => {
    const result = mentionsOfFromDb(integDb, {
      entityId: "entity:auth-service",
    });

    expect(result.totalCount).toBe(2);
    const docPaths = result.mentions.map((m) => m.docPath);
    expect(docPaths).toContain("docs/AUTH.md");
    expect(docPaths).toContain("docs/ARCH.md");
  });

  it("annotationsForFile resolves external entity names", () => {
    const result = annotationsForFileFromDb(integDb, {
      filePath: "docs/AUTH.md",
    });

    // Should have both the original ungrounded + the new external annotation
    const external = result.annotations.filter(
      (a) => a.entitySource === "external",
    );
    expect(external.length).toBeGreaterThanOrEqual(1);
    expect(external[0].entityName).toBe("AuthService");
    expect(external[0].entityId).toBe("entity:auth-service");
  });

  it("mentionsOf also finds ungrounded alias matches", () => {
    const result = mentionsOfFromDb(integDb, {
      entityId: "entity:auth-service",
    });

    const texts = result.mentions.map((m) => m.text);
    expect(texts).toContain("auth service");
    expect(texts).toContain("authentication module");
  });
});
