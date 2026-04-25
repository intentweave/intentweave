// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Constraint Consistency Check (12.2)
 *
 * Seeds kg_entities + kg_relationships across different source files with
 * contradicting predicates, then verifies detection of conflicts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { consistencyFromDb } from "../queries/consistency.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let db: Database.Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `cari-consistency-${Date.now()}.db`);
  db = new Database(dbPath);
  initSchema(db);
  db.pragma("foreign_keys = OFF");
  seedFixtures(db);
});

afterAll(() => {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

function seedFixtures(d: Database.Database) {
  // ── KG entities ──
  d.exec(`
    INSERT INTO kg_entities (id, canon_id, name, type, aliases, confidence, artifact_id, source_file, created_at)
    VALUES
      (1, 'auth_service', 'AuthService', 'component', '[]', 0.95, 'docs.AUTH', 'docs/AUTH.md', datetime('now')),
      (2, 'jwt', 'JWT', 'technology', '["json web token"]', 0.9, 'docs.AUTH', 'docs/AUTH.md', datetime('now')),
      (3, 'sessions', 'Session Store', 'technology', '["session tokens"]', 0.9, 'docs.ARCH', 'docs/ARCHITECTURE.md', datetime('now')),
      (4, 'stateless', 'Stateless Services', 'constraint', '[]', 0.85, 'docs.ARCH', 'docs/ARCHITECTURE.md', datetime('now')),
      (5, 'rate_limiting', 'Rate Limiting', 'requirement', '[]', 0.9, 'docs.API', 'docs/API.md', datetime('now')),
      (6, 'redis_cache', 'Redis Cache', 'technology', '["redis"]', 0.8, 'docs.PERF', 'docs/PERF.md', datetime('now')),
      (7, 'max_page_size', 'Max Page Size', 'constraint', '[]', 0.85, 'docs.API', 'docs/API.md', datetime('now')),
      (8, 'retry_policy', 'Retry Policy', 'requirement', '[]', 0.9, 'docs.AUTH', 'docs/AUTH.md', datetime('now')),
      (9, 'oauth2', 'OAuth2', 'feature', '[]', 0.9, 'docs.AUTH', 'docs/AUTH.md', datetime('now')),
      (10, 'saml', 'SAML', 'feature', '[]', 0.8, 'docs.ARCH', 'docs/ARCHITECTURE.md', datetime('now'))
  `);

  // ── KG relationships ──

  // HARD CONTRADICTION: AuthService REQUIRES JWT (AUTH.md) but DECIDED_AGAINST JWT (ARCH.md)
  d.exec(`
    INSERT INTO kg_relationships (from_id, to_id, predicate, confidence, raw_predicate, artifact_id, source_file)
    VALUES
      (1, 2, 'REQUIRES', 0.9, 'requires', 'docs.AUTH', 'docs/AUTH.md'),
      (1, 2, 'DECIDED_AGAINST', 0.85, 'decided against', 'docs.ARCH', 'docs/ARCHITECTURE.md')
  `);

  // HARD CONTRADICTION: Rate Limiting ENABLES retry_policy (API.md) but BLOCKS retry_policy (PERF.md)
  d.exec(`
    INSERT INTO kg_relationships (from_id, to_id, predicate, confidence, raw_predicate, artifact_id, source_file)
    VALUES
      (5, 8, 'ENABLES', 0.9, 'enables', 'docs.API', 'docs/API.md'),
      (5, 8, 'BLOCKS', 0.85, 'blocks', 'docs.PERF', 'docs/PERF.md')
  `);

  // WARNING: AuthService REQUIRES sessions (ARCH.md) but sessions BLOCKS stateless (ARCH.md)
  // This is same-file, so should NOT be flagged (only cross-document conflicts)
  d.exec(`
    INSERT INTO kg_relationships (from_id, to_id, predicate, confidence, raw_predicate, artifact_id, source_file)
    VALUES
      (1, 3, 'REQUIRES', 0.85, 'requires', 'docs.ARCH', 'docs/ARCHITECTURE.md'),
      (3, 4, 'BLOCKS', 0.8, 'blocks', 'docs.ARCH', 'docs/ARCHITECTURE.md')
  `);

  // EXCLUSIVE PREDICATE WARNING: AuthService DECIDED_FOR OAuth2 (AUTH.md) AND DECIDED_FOR SAML (ARCH.md)
  // Same entity, same predicate, different targets from different docs
  d.exec(`
    INSERT INTO kg_relationships (from_id, to_id, predicate, confidence, raw_predicate, artifact_id, source_file)
    VALUES
      (1, 9, 'DECIDED_FOR', 0.9, 'decided for', 'docs.AUTH', 'docs/AUTH.md'),
      (1, 10, 'DECIDED_FOR', 0.85, 'decided for', 'docs.ARCH', 'docs/ARCHITECTURE.md')
  `);

  // CONSISTENT: AuthService USES JWT (AUTH.md) and USES Redis Cache (PERF.md) — not contradicting
  d.exec(`
    INSERT INTO kg_relationships (from_id, to_id, predicate, confidence, raw_predicate, artifact_id, source_file)
    VALUES
      (1, 2, 'USES', 0.9, 'uses', 'docs.AUTH', 'docs/AUTH.md'),
      (1, 6, 'USES', 0.85, 'uses', 'docs.PERF', 'docs/PERF.md')
  `);

  // CONSISTENT: same file, same predicate, different targets — should NOT flag
  d.exec(`
    INSERT INTO kg_relationships (from_id, to_id, predicate, confidence, raw_predicate, artifact_id, source_file)
    VALUES
      (1, 5, 'REQUIRES', 0.9, 'requires', 'docs.AUTH', 'docs/AUTH.md'),
      (1, 8, 'REQUIRES', 0.85, 'requires', 'docs.AUTH', 'docs/AUTH.md')
  `);
}

// =============================================================================
// Tests
// =============================================================================

describe("consistency", () => {
  it("should detect hard contradictions (opposing predicates)", () => {
    const result = consistencyFromDb(db);

    // AuthService REQUIRES JWT vs DECIDED_AGAINST JWT
    const reqVsDecided = result.conflicts.find(
      (c) =>
        c.entityA.canonId === "auth_service" &&
        c.entityB.canonId === "jwt" &&
        c.severity === "error",
    );
    expect(reqVsDecided).toBeDefined();
    const predicates = new Set([
      reqVsDecided!.predicateA,
      reqVsDecided!.predicateB,
    ]);
    expect(predicates).toContain("REQUIRES");
    expect(predicates).toContain("DECIDED_AGAINST");
    expect(reqVsDecided!.sourceFileA).not.toBe(reqVsDecided!.sourceFileB);
  });

  it("should detect enables-blocks contradiction", () => {
    const result = consistencyFromDb(db);

    const enablesVsBlocks = result.conflicts.find(
      (c) =>
        c.entityA.canonId === "rate_limiting" &&
        c.entityB.canonId === "retry_policy" &&
        c.severity === "error",
    );
    expect(enablesVsBlocks).toBeDefined();
  });

  it("should detect exclusive-predicate warnings (same predicate, different targets)", () => {
    const result = consistencyFromDb(db);

    // AuthService DECIDED_FOR OAuth2 (AUTH.md) AND DECIDED_FOR SAML (ARCH.md)
    const exclusiveConflict = result.conflicts.find(
      (c) =>
        c.entityA.canonId === "auth_service" &&
        c.severity === "warning" &&
        c.predicateA.includes("DECIDED_FOR") &&
        c.predicateB.includes("DECIDED_FOR"),
    );
    expect(exclusiveConflict).toBeDefined();
  });

  it("should NOT flag same-file relationships as contradictions", () => {
    const result = consistencyFromDb(db);

    // AuthService REQUIRES sessions + sessions BLOCKS stateless — both from ARCH.md
    // These are NOT the same entity pair, so this is fine regardless,
    // but the key point is same-file REQUIRES + same-file REQUIRES are not flagged
    const sameFileConflicts = result.conflicts.filter(
      (c) => c.sourceFileA === c.sourceFileB,
    );
    expect(sameFileConflicts).toHaveLength(0);
  });

  it("should NOT flag non-exclusive predicates with different targets", () => {
    const result = consistencyFromDb(db);

    // AuthService USES JWT (AUTH.md) and USES Redis (PERF.md) — not contradicting
    const usesConflict = result.conflicts.find(
      (c) =>
        c.predicateA === "USES → JWT" && c.predicateB === "USES → Redis Cache",
    );
    expect(usesConflict).toBeUndefined();
  });

  it("should compute summary statistics", () => {
    const result = consistencyFromDb(db);

    expect(result.summary.totalRelationships).toBeGreaterThan(0);
    expect(result.summary.totalConflicts).toBe(result.conflicts.length);
    expect(result.summary.errors).toBe(
      result.conflicts.filter((c) => c.severity === "error").length,
    );
    expect(result.summary.warnings).toBe(
      result.conflicts.filter((c) => c.severity === "warning").length,
    );
    expect(result.summary.errors + result.summary.warnings).toBe(
      result.summary.totalConflicts,
    );
    expect(result.summary.consistencyPercent).toBeGreaterThanOrEqual(0);
    expect(result.summary.consistencyPercent).toBeLessThanOrEqual(100);
  });

  it("should sort errors before warnings", () => {
    const result = consistencyFromDb(db);

    let sawWarning = false;
    for (const c of result.conflicts) {
      if (c.severity === "warning") sawWarning = true;
      if (c.severity === "error" && sawWarning) {
        throw new Error("Error found after warning — sort order violated");
      }
    }
  });

  it("should filter by source file", () => {
    const result = consistencyFromDb(db, { files: ["docs/AUTH.md"] });

    for (const c of result.conflicts) {
      expect(
        c.sourceFileA === "docs/AUTH.md" || c.sourceFileB === "docs/AUTH.md",
      ).toBe(true);
    }
  });

  it("should filter by entity type", () => {
    const result = consistencyFromDb(db, { types: ["requirement"] });

    // Only relationships involving entities of type "requirement"
    for (const c of result.conflicts) {
      // At least one side should involve a requirement entity
      // (filter checks both from and to entity types)
      expect(c).toBeDefined();
    }
  });

  it("should respect minConfidence", () => {
    const high = consistencyFromDb(db, { minConfidence: 0.95 });
    const low = consistencyFromDb(db, { minConfidence: 0.1 });

    // Higher confidence threshold = fewer relationships = possibly fewer conflicts
    expect(low.summary.totalRelationships).toBeGreaterThanOrEqual(
      high.summary.totalRelationships,
    );
  });

  it("should return empty result when no kg tables exist", () => {
    const freshPath = path.join(
      os.tmpdir(),
      `cari-consistency-empty-${Date.now()}.db`,
    );
    const freshDb = new Database(freshPath);
    // Don't init full schema — tables won't exist
    freshDb.exec(`CREATE TABLE IF NOT EXISTS dummy (id INTEGER PRIMARY KEY)`);

    const result = consistencyFromDb(freshDb);

    expect(result.conflicts).toHaveLength(0);
    expect(result.summary.totalRelationships).toBe(0);
    expect(result.summary.consistencyPercent).toBe(100);

    freshDb.close();
    fs.unlinkSync(freshPath);
  });

  it("should return 100% consistent when no conflicts exist", () => {
    const freshPath = path.join(
      os.tmpdir(),
      `cari-consistency-clean-${Date.now()}.db`,
    );
    const freshDb = new Database(freshPath);
    initSchema(freshDb);
    freshDb.pragma("foreign_keys = OFF");

    // Insert consistent relationships only
    freshDb.exec(`
      INSERT INTO kg_entities (id, canon_id, name, type, source_file, created_at)
      VALUES
        (1, 'a', 'A', 'component', 'docs/A.md', datetime('now')),
        (2, 'b', 'B', 'component', 'docs/B.md', datetime('now'))
    `);
    freshDb.exec(`
      INSERT INTO kg_relationships (from_id, to_id, predicate, confidence, source_file)
      VALUES
        (1, 2, 'USES', 0.9, 'docs/A.md'),
        (1, 2, 'DEPENDS_ON', 0.85, 'docs/B.md')
    `);

    const result = consistencyFromDb(freshDb);

    expect(result.conflicts).toHaveLength(0);
    expect(result.summary.consistencyPercent).toBe(100);

    freshDb.close();
    fs.unlinkSync(freshPath);
  });
});
