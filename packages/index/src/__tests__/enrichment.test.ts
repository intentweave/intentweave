// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Selective Semantic Enrichment (11.8)
 *
 * - enrichmentScore: composite impact scoring
 * - kgWriter: write KX results to kg_* tables
 * - bridgeKgEntities: inject KG entities into CARI
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { enrichmentScoreFromDb } from "../queries/enrichmentScore.js";
import { writeKgResults, bridgeKgEntities } from "../kgWriter.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let db: Database.Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `cari-enrichment-${Date.now()}.db`);
  db = new Database(dbPath);
  initSchema(db);
  seedFixtures(db);
});

afterAll(() => {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

function seedFixtures(d: Database.Database) {
  // ── Symbols ──
  const insertSym = d.prepare(`
    INSERT INTO symbols (id, name, kind, container, signature, file_path, line, end_line, export)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSym.run(
    "s1",
    "AuthService",
    "class",
    null,
    "class AuthService",
    "src/auth/service.ts",
    10,
    100,
    "exported",
  );
  insertSym.run(
    "s2",
    "UserRepo",
    "class",
    null,
    "class UserRepo",
    "src/user/repo.ts",
    5,
    80,
    "exported",
  );
  insertSym.run(
    "s3",
    "validate",
    "function",
    null,
    "function validate()",
    "src/auth/validate.ts",
    1,
    20,
    "exported",
  );
  insertSym.run(
    "s4",
    "helper",
    "function",
    null,
    "function helper()",
    "src/utils/helper.ts",
    1,
    10,
    "internal",
  );

  // ── Files ──
  const insertFile = d.prepare(`
    INSERT INTO files (path, churn, is_hotspot, is_doc, content_hash, doc_group)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // High-churn code file
  insertFile.run("src/auth/service.ts", 25, 1, 0, "hash-auth-1", null);
  // Medium churn code file
  insertFile.run("src/user/repo.ts", 10, 0, 0, "hash-user-1", null);
  // Low churn code file
  insertFile.run("src/auth/validate.ts", 2, 0, 0, "hash-validate-1", null);
  insertFile.run("src/utils/helper.ts", 1, 0, 0, "hash-helper-1", null);
  // Doc files
  insertFile.run("docs/AUTH.md", 5, 0, 1, "hash-auth-doc-1", "auth");
  insertFile.run("docs/API.md", 3, 0, 1, "hash-api-doc-1", "api");

  // ── Annotations (some grounded, some orphaned) ──
  const insertAnno = d.prepare(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // Grounded annotations in AUTH.md
  insertAnno.run("docs/AUTH.md", 5, "AuthService", "s1", 0.9, "exact", null);
  insertAnno.run("docs/AUTH.md", 10, "validate", "s3", 0.8, "slug", null);
  // Orphaned annotation in AUTH.md
  insertAnno.run(
    "docs/AUTH.md",
    15,
    "OAuthProvider",
    null,
    0.0,
    "ungrounded",
    null,
  );
  // Grounded annotation in API.md
  insertAnno.run("docs/API.md", 3, "UserRepo", "s2", 0.7, "exact", null);

  // ── Imports ──
  const insertImport = d.prepare(`
    INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertImport.run(
    "src/auth/service.ts",
    "src/user/repo.ts",
    "../user/repo",
    1,
    "UserRepo",
  );
  insertImport.run(
    "src/auth/validate.ts",
    "src/auth/service.ts",
    "./service",
    1,
    "AuthService",
  );

  // ── Co-occurrences ──
  const insertCoOcc = d.prepare(`
    INSERT INTO co_occurrences (entity_a, entity_b, count, score, source, file_paths)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertCoOcc.run(
    "AuthService",
    "UserRepo",
    3,
    0.8,
    "doc_cooc",
    "docs/AUTH.md",
  );
}

// =============================================================================
// Tests: enrichmentScore
// =============================================================================

describe("enrichmentScore", () => {
  it("should score all files and sort by impact", () => {
    const result = enrichmentScoreFromDb(db);

    expect(result.totalEvaluated).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);

    // Should be sorted by impact score descending
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].impactScore).toBeGreaterThanOrEqual(
        result.candidates[i].impactScore,
      );
    }
  });

  it("should assign higher score to high-churn files", () => {
    const result = enrichmentScoreFromDb(db);
    const authService = result.candidates.find(
      (c) => c.filePath === "src/auth/service.ts",
    );
    const helper = result.candidates.find(
      (c) => c.filePath === "src/utils/helper.ts",
    );

    // AuthService has churn=25 vs helper churn=1 — should score higher
    if (authService && helper) {
      expect(authService.impactScore).toBeGreaterThan(helper.impactScore);
    }
  });

  it("should respect focus filter", () => {
    const result = enrichmentScoreFromDb(db, { focus: "docs/" });

    for (const c of result.candidates) {
      expect(c.filePath).toMatch(/^docs\//);
    }
  });

  it("should track already-enriched files when incremental", () => {
    // First, mark a file as enriched
    db.prepare(
      `
      INSERT OR REPLACE INTO enrichment_meta
        (file_path, content_hash, enriched_at, entity_count, triple_count)
      VALUES ('src/auth/service.ts', 'hash-auth-1', datetime('now'), 5, 10)
    `,
    ).run();

    const result = enrichmentScoreFromDb(db, { incremental: true });
    const authService = result.candidates.find(
      (c) => c.filePath === "src/auth/service.ts",
    );

    expect(authService).toBeDefined();
    expect(authService!.alreadyEnriched).toBe(true);

    // Clean up
    db.prepare(
      `DELETE FROM enrichment_meta WHERE file_path = 'src/auth/service.ts'`,
    ).run();
  });

  it("should include signal breakdown", () => {
    const result = enrichmentScoreFromDb(db);
    const first = result.candidates[0];

    expect(first.signals).toBeDefined();
    expect(typeof first.signals.hotspotRank).toBe("number");
    expect(typeof first.signals.orphanRatio).toBe("number");
    expect(typeof first.signals.hubDegree).toBe("number");
    expect(typeof first.signals.coverageGap).toBe("number");
    expect(typeof first.signals.driftSeverity).toBe("number");
  });
});

// =============================================================================
// Tests: KG Writer
// =============================================================================

describe("writeKgResults", () => {
  it("should write entities and relationships to kg_* tables", () => {
    const result = writeKgResults(dbPath, [
      {
        sourceFile: "docs/AUTH.md",
        artifactId: "docs.AUTH",
        canonEntities: [
          {
            canonId: "auth-service",
            name: "AuthService",
            type: "component",
            aliases: ["auth service", "authentication service"],
            confidence: 0.95,
          },
          {
            canonId: "jwt",
            name: "JWT",
            type: "technology",
            aliases: ["json web token"],
            confidence: 0.9,
          },
        ],
        canonTriples: [
          {
            subjectCanonId: "auth-service",
            predicate: "USES",
            objectCanonId: "jwt",
            confidence: 0.9,
            rawPredicate: "uses",
            rawTripleIndex: 0,
          },
        ],
        rawTriples: [
          {
            subject: "AuthService",
            predicate: "uses",
            object: "JWT",
            subjectKind: "component",
            objectKind: "technology",
            confidence: 0.9,
          },
        ],
      },
    ]);

    expect(result.entityCount).toBe(2);
    expect(result.relationshipCount).toBe(1);
    expect(result.rawTripleCount).toBe(1);

    // Verify entities were written
    const readDb = new Database(dbPath, { readonly: true });
    const entities = readDb
      .prepare(`SELECT * FROM kg_entities ORDER BY canon_id`)
      .all() as Array<Record<string, unknown>>;
    expect(entities.length).toBe(2);
    expect(entities[0].canon_id).toBe("auth-service");
    expect(entities[1].canon_id).toBe("jwt");

    // Verify relationships
    const rels = readDb
      .prepare(`SELECT * FROM kg_relationships`)
      .all() as Array<Record<string, unknown>>;
    expect(rels.length).toBe(1);
    expect(rels[0].predicate).toBe("USES");

    // Verify raw triples
    const raws = readDb.prepare(`SELECT * FROM kg_raw_triples`).all() as Array<
      Record<string, unknown>
    >;
    expect(raws.length).toBe(1);

    // Verify enrichment_meta
    const meta = readDb
      .prepare(`SELECT * FROM enrichment_meta WHERE file_path = 'docs/AUTH.md'`)
      .get() as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta!.entity_count).toBe(2);
    expect(meta!.triple_count).toBe(1);

    readDb.close();
  });

  it("should replace data on re-enrichment (idempotent)", () => {
    // Write again with different data
    const result = writeKgResults(dbPath, [
      {
        sourceFile: "docs/AUTH.md",
        artifactId: "docs.AUTH",
        canonEntities: [
          {
            canonId: "auth-service",
            name: "AuthService",
            type: "component",
            aliases: [],
            confidence: 1.0,
          },
        ],
        canonTriples: [],
        rawTriples: [],
      },
    ]);

    expect(result.entityCount).toBe(1);

    // Verify old data was replaced
    const readDb = new Database(dbPath, { readonly: true });
    const entities = readDb
      .prepare(`SELECT * FROM kg_entities WHERE source_file = 'docs/AUTH.md'`)
      .all();
    expect(entities.length).toBe(1);

    const rels = readDb
      .prepare(
        `SELECT * FROM kg_relationships WHERE source_file = 'docs/AUTH.md'`,
      )
      .all();
    expect(rels.length).toBe(0);

    readDb.close();
  });
});

// =============================================================================
// Tests: Bridge KG Entities
// =============================================================================

describe("bridgeKgEntities", () => {
  it("should inject KG entities as external entities", () => {
    // First write some KG entities
    writeKgResults(dbPath, [
      {
        sourceFile: "docs/API.md",
        artifactId: "docs.API",
        canonEntities: [
          {
            canonId: "rest-api",
            name: "REST API",
            type: "component",
            aliases: ["api", "http api"],
            confidence: 0.85,
          },
        ],
        canonTriples: [],
        rawTriples: [],
      },
    ]);

    const result = bridgeKgEntities(dbPath);

    expect(result.entitiesWritten).toBeGreaterThan(0);

    // Verify external entities were created with kg: prefix
    const readDb = new Database(dbPath, { readonly: true });
    const extEntities = readDb
      .prepare(`SELECT * FROM external_entities WHERE id LIKE 'kg:%'`)
      .all() as Array<Record<string, unknown>>;
    expect(extEntities.length).toBeGreaterThan(0);

    readDb.close();
  });
});

// =============================================================================
// Tests: Schema
// =============================================================================

describe("schema v5", () => {
  it("should have kg_entities table", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kg_%'`,
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("kg_entities");
    expect(tableNames).toContain("kg_relationships");
    expect(tableNames).toContain("kg_raw_triples");
  });

  it("should have enrichment_meta table", () => {
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'enrichment_meta'`,
      )
      .get() as { name: string } | undefined;

    expect(table).toBeDefined();
  });
});
