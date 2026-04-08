// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for 1.5: Terminology Inconsistency Detection
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { terminologyInconsistencyFromDb } from "../queries/terminologyInconsistency.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let db: Database.Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `cari-terminology-${Date.now()}.db`);
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
    INSERT INTO symbols (id, name, kind, file_path, line, export)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertSym.run("s1", "AuthService", "class", "src/auth/service.ts", 10, "exported");
  insertSym.run("s2", "UserRepo", "class", "src/user/repo.ts", 5, "exported");
  insertSym.run("s3", "DatabasePool", "class", "src/db/pool.ts", 1, "exported");
  insertSym.run("s4", "formatDate", "function", "src/utils/date.ts", 20, "exported");

  // ── Annotations ──
  const insertAnn = d.prepare(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // AuthService: inconsistent — 4 variants (critical)
  insertAnn.run("docs/auth.md", 5, "AuthService", "s1", 0.95, "code-span");
  insertAnn.run("docs/auth.md", 10, "AuthService", "s1", 0.90, "code-span");
  insertAnn.run("docs/overview.md", 3, "auth service", "s1", 0.80, "identifier");
  insertAnn.run("docs/overview.md", 15, "authentication module", "s1", 0.70, "dictionary");
  insertAnn.run("docs/tutorial.md", 8, "Auth Service", "s1", 0.75, "identifier");

  // UserRepo: inconsistent — 2 variants (info)
  insertAnn.run("docs/user.md", 5, "UserRepo", "s2", 0.90, "code-span");
  insertAnn.run("docs/user.md", 10, "UserRepo", "s2", 0.85, "code-span");
  insertAnn.run("docs/overview.md", 20, "user repository", "s2", 0.70, "dictionary");

  // DatabasePool: consistent — only 1 variant (should NOT appear)
  insertAnn.run("docs/db.md", 5, "DatabasePool", "s3", 0.90, "code-span");
  insertAnn.run("docs/db.md", 10, "DatabasePool", "s3", 0.85, "code-span");

  // formatDate: inconsistent — 3 variants (warning)
  insertAnn.run("docs/utils.md", 5, "formatDate", "s4", 0.90, "code-span");
  insertAnn.run("docs/utils.md", 12, "format date", "s4", 0.70, "identifier");
  insertAnn.run("docs/overview.md", 30, "date formatter", "s4", 0.60, "dictionary");
}

// =============================================================================
// Tests
// =============================================================================

describe("terminologyInconsistency", () => {
  it("detects entities with multiple mention variants", () => {
    const result = terminologyInconsistencyFromDb(db);
    expect(result.totalInconsistencies).toBeGreaterThanOrEqual(3);
    // AuthService, UserRepo, formatDate should all be flagged
    const names = result.inconsistencies.map((i) => i.symbolName);
    expect(names).toContain("AuthService");
    expect(names).toContain("UserRepo");
    expect(names).toContain("formatDate");
  });

  it("does NOT flag consistent entities", () => {
    const result = terminologyInconsistencyFromDb(db);
    const names = result.inconsistencies.map((i) => i.symbolName);
    expect(names).not.toContain("DatabasePool");
  });

  it("returns correct totalAnalyzed count", () => {
    const result = terminologyInconsistencyFromDb(db);
    // All 4 symbols have annotations
    expect(result.totalAnalyzed).toBe(4);
  });

  it("groups case-insensitive variants correctly", () => {
    const result = terminologyInconsistencyFromDb(db);
    const auth = result.inconsistencies.find(
      (i) => i.symbolName === "AuthService",
    )!;
    // "AuthService" and "Auth Service" normalise differently but
    // "auth service" and "Auth Service" should merge
    expect(auth).toBeDefined();
    // At least 3 distinct normalised variants: authservice, auth service, authentication module
    expect(auth.variants.length).toBeGreaterThanOrEqual(3);
  });

  it("computes consistency score based on canonical name usage", () => {
    const result = terminologyInconsistencyFromDb(db);
    const auth = result.inconsistencies.find(
      (i) => i.symbolName === "AuthService",
    )!;
    // "AuthService" appears 2/5 times → consistency = 0.4
    expect(auth.consistency).toBe(0.4);
  });

  it("assigns severity levels correctly", () => {
    const result = terminologyInconsistencyFromDb(db);
    const auth = result.inconsistencies.find(
      (i) => i.symbolName === "AuthService",
    )!;
    // 4+ variants OR consistency < 0.3 → critical
    // AuthService has consistency 0.4, but variants >= 3 → at least warning
    // Actually 3 normalised variants + consistency 0.4 → warning
    expect(["warning", "critical"]).toContain(auth.severity);

    const user = result.inconsistencies.find(
      (i) => i.symbolName === "UserRepo",
    )!;
    // 2 variants, consistency = 2/3 = 0.67 → info
    expect(user.severity).toBe("info");
  });

  it("sorts by severity (critical first, then warning, then info)", () => {
    const result = terminologyInconsistencyFromDb(db);
    const severities = result.inconsistencies.map((i) => i.severity);
    const order = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(order[severities[i]]).toBeGreaterThanOrEqual(
        order[severities[i - 1]],
      );
    }
  });

  it("includes variant details with counts and doc paths", () => {
    const result = terminologyInconsistencyFromDb(db);
    const auth = result.inconsistencies.find(
      (i) => i.symbolName === "AuthService",
    )!;
    // The canonical variant "AuthService" should have count=2
    const canonical = auth.variants.find((v) => v.text === "AuthService");
    expect(canonical).toBeDefined();
    expect(canonical!.count).toBe(2);
    expect(canonical!.docPaths).toContain("docs/auth.md");
    expect(canonical!.avgConfidence).toBeGreaterThan(0);
  });

  it("includes symbol metadata in results", () => {
    const result = terminologyInconsistencyFromDb(db);
    const auth = result.inconsistencies.find(
      (i) => i.symbolName === "AuthService",
    )!;
    expect(auth.symbolId).toBe("s1");
    expect(auth.kind).toBe("class");
    expect(auth.filePath).toBe("src/auth/service.ts");
  });

  it("handles entity with exactly 2 variants", () => {
    const result = terminologyInconsistencyFromDb(db);
    const user = result.inconsistencies.find(
      (i) => i.symbolName === "UserRepo",
    )!;
    expect(user.variants.length).toBe(2);
    expect(user.consistency).toBeCloseTo(0.67, 1);
  });

  it("returns empty result on empty database", () => {
    const emptyPath = path.join(os.tmpdir(), `cari-terminology-empty-${Date.now()}.db`);
    const emptyDb = new Database(emptyPath);
    initSchema(emptyDb);
    try {
      const result = terminologyInconsistencyFromDb(emptyDb);
      expect(result.totalInconsistencies).toBe(0);
      expect(result.totalAnalyzed).toBe(0);
      expect(result.inconsistencies).toEqual([]);
    } finally {
      emptyDb.close();
      if (fs.existsSync(emptyPath)) fs.unlinkSync(emptyPath);
    }
  });

  it("ignores low-confidence annotations", () => {
    // Add a very low confidence annotation
    const tmpPath = path.join(os.tmpdir(), `cari-terminology-conf-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);

    tmpDb.prepare(`INSERT INTO symbols (id, name, kind, file_path, line, export) VALUES (?, ?, ?, ?, ?, ?)`).run("x1", "Config", "class", "src/config.ts", 1, "exported");
    // All mentions use the same text but one is very low confidence with different text
    tmpDb.prepare(`INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source) VALUES (?, ?, ?, ?, ?, ?)`).run("docs/a.md", 1, "Config", "x1", 0.9, "code-span");
    tmpDb.prepare(`INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source) VALUES (?, ?, ?, ?, ?, ?)`).run("docs/b.md", 2, "config thingy", "x1", 0.2, "dictionary");

    try {
      const result = terminologyInconsistencyFromDb(tmpDb);
      // The low-confidence annotation should be filtered out, leaving only 1 variant
      expect(result.totalInconsistencies).toBe(0);
    } finally {
      tmpDb.close();
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  it("variants sorted by count descending", () => {
    const result = terminologyInconsistencyFromDb(db);
    for (const inc of result.inconsistencies) {
      for (let i = 1; i < inc.variants.length; i++) {
        expect(inc.variants[i].count).toBeLessThanOrEqual(
          inc.variants[i - 1].count,
        );
      }
    }
  });
});
