// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for test coverage mapping (6.2).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "@intentweave/sqlite-compat";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { testCoverageFromDb } from "../queries/testCoverage.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let db: Database.Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `cari-test-coverage-${Date.now()}.db`);
  db = new Database(dbPath);
  initSchema(db);
  seedFixtures(db);
});

afterAll(() => {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

function seedFixtures(db: Database.Database) {
  const insertSym = db.prepare(`
    INSERT INTO symbols (id, name, kind, container, signature, file_path, line, end_line, export, doc_summary, body_hash, body_lines, structure_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertImport = db.prepare(`
    INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
    VALUES (?, ?, ?, ?, ?)
  `);

  // ── Source file: src/auth/service.ts (3 exported symbols) ─────
  insertSym.run(
    "impl:src/auth/service.ts#class:AuthService",
    "AuthService",
    "class",
    null,
    "class AuthService",
    "src/auth/service.ts",
    10,
    100,
    "exported",
    null,
    null,
    null,
    null,
  );
  insertSym.run(
    "impl:src/auth/service.ts#function:validateUser",
    "validateUser",
    "function",
    null,
    "function validateUser()",
    "src/auth/service.ts",
    110,
    130,
    "exported",
    null,
    null,
    null,
    null,
  );
  insertSym.run(
    "impl:src/auth/service.ts#function:hashPassword",
    "hashPassword",
    "function",
    null,
    "function hashPassword()",
    "src/auth/service.ts",
    140,
    160,
    "exported",
    null,
    null,
    null,
    null,
  );

  // ── Source file: src/db/pool.ts (2 exported symbols) ──────────
  insertSym.run(
    "impl:src/db/pool.ts#class:DatabasePool",
    "DatabasePool",
    "class",
    null,
    "class DatabasePool",
    "src/db/pool.ts",
    5,
    80,
    "exported",
    null,
    null,
    null,
    null,
  );
  insertSym.run(
    "impl:src/db/pool.ts#function:createPool",
    "createPool",
    "function",
    null,
    "function createPool()",
    "src/db/pool.ts",
    85,
    100,
    "exported",
    null,
    null,
    null,
    null,
  );

  // ── Source file: src/utils/format.ts (1 exported, 1 internal) ─
  insertSym.run(
    "impl:src/utils/format.ts#function:formatDate",
    "formatDate",
    "function",
    null,
    "function formatDate()",
    "src/utils/format.ts",
    5,
    20,
    "exported",
    null,
    null,
    null,
    null,
  );
  insertSym.run(
    "impl:src/utils/format.ts#function:internalHelper",
    "internalHelper",
    "function",
    null,
    "function internalHelper()",
    "src/utils/format.ts",
    25,
    35,
    "internal",
    null,
    null,
    null,
    null,
  );

  // ── Source file: src/orphan.ts (1 exported, never tested) ─────
  insertSym.run(
    "impl:src/orphan.ts#function:orphanedFunction",
    "orphanedFunction",
    "function",
    null,
    "function orphanedFunction()",
    "src/orphan.ts",
    1,
    10,
    "exported",
    null,
    null,
    null,
    null,
  );

  // ── Test file: src/auth/service.test.ts (naming convention) ───
  insertSym.run(
    "impl:src/auth/service.test.ts#function:testAuth",
    "testAuth",
    "function",
    null,
    "function testAuth()",
    "src/auth/service.test.ts",
    1,
    50,
    "internal",
    null,
    null,
    null,
    null,
  );

  // Test imports the source via relative import
  insertImport.run(
    "src/auth/service.test.ts",
    "src/auth/service.ts",
    "./service",
    1,
    JSON.stringify(["AuthService", "validateUser"]),
  );

  // ── Test file: src/__tests__/pool.test.ts (import only) ───────
  insertSym.run(
    "impl:src/__tests__/pool.test.ts#function:testPool",
    "testPool",
    "function",
    null,
    "function testPool()",
    "src/__tests__/pool.test.ts",
    1,
    30,
    "internal",
    null,
    null,
    null,
    null,
  );

  // This test imports from db/pool but naming doesn't match
  insertImport.run(
    "src/__tests__/pool.test.ts",
    "src/db/pool.ts",
    "../../db/pool",
    1,
    JSON.stringify(["DatabasePool"]),
  );

  // ── Test file: src/utils/format.test.ts (naming only, no imports) ─
  insertSym.run(
    "impl:src/utils/format.test.ts#function:testFormat",
    "testFormat",
    "function",
    null,
    "function testFormat()",
    "src/utils/format.test.ts",
    1,
    20,
    "internal",
    null,
    null,
    null,
    null,
  );
  // Naming convention maps format.test.ts → format.ts, but no import data
}

// =============================================================================
// Tests
// =============================================================================

describe("Test Coverage Mapping — testCoverageFromDb", () => {
  it("finds correct total exported count (non-test files only)", () => {
    const result = testCoverageFromDb(db);
    // 3 (auth/service) + 2 (db/pool) + 1 (utils/format) + 1 (orphan) = 7 exported
    expect(result.totalExported).toBe(7);
  });

  it("discovers naming-convention mappings", () => {
    const result = testCoverageFromDb(db);
    const namingMappings = result.mappings.filter(
      (m) => m.strategy === "naming" || m.strategy === "both",
    );
    expect(namingMappings.length).toBeGreaterThanOrEqual(1);

    // auth/service.test.ts → auth/service.ts (has both naming + import)
    const authMapping = result.mappings.find(
      (m) => m.testFile === "src/auth/service.test.ts",
    );
    expect(authMapping).toBeDefined();
    expect(authMapping!.sourceFile).toBe("src/auth/service.ts");
    expect(authMapping!.strategy).toBe("both");
  });

  it("discovers import-based mappings", () => {
    const result = testCoverageFromDb(db);
    // __tests__/pool.test.ts imports from db/pool.ts → import mapping
    const poolMapping = result.mappings.find(
      (m) =>
        m.testFile === "src/__tests__/pool.test.ts" &&
        m.sourceFile === "src/db/pool.ts",
    );
    expect(poolMapping).toBeDefined();
    expect(poolMapping!.strategy).toBe("import");
    expect(poolMapping!.importedNames).toContain("DatabasePool");
  });

  it("discovers naming-only mappings", () => {
    const result = testCoverageFromDb(db);
    const formatMapping = result.mappings.find(
      (m) => m.testFile === "src/utils/format.test.ts",
    );
    expect(formatMapping).toBeDefined();
    expect(formatMapping!.sourceFile).toBe("src/utils/format.ts");
    expect(formatMapping!.strategy).toBe("naming");
    expect(formatMapping!.importedNames).toEqual([]);
  });

  it("identifies untested symbols", () => {
    const result = testCoverageFromDb(db);
    // orphanedFunction has no test file at all → untested
    const orphaned = result.untested.find((u) => u.name === "orphanedFunction");
    expect(orphaned).toBeDefined();
    expect(orphaned!.filePath).toBe("src/orphan.ts");
  });

  it("marks import-only tested symbols correctly", () => {
    const result = testCoverageFromDb(db);
    // DatabasePool is imported by a test → tested
    const dbPoolUntested = result.untested.find(
      (u) => u.name === "DatabasePool",
    );
    expect(dbPoolUntested).toBeUndefined();

    // createPool is NOT imported by any test, and pool.ts only has import mapping
    // → it should be untested
    const createPoolUntested = result.untested.find(
      (u) => u.name === "createPool",
    );
    expect(createPoolUntested).toBeDefined();
  });

  it("naming-convention mapping covers all exports in the file", () => {
    const result = testCoverageFromDb(db);
    // auth/service.ts has naming mapping (from service.test.ts) → all 3 symbols covered
    const authUntested = result.untested.filter(
      (u) => u.filePath === "src/auth/service.ts",
    );
    expect(authUntested).toHaveLength(0);
  });

  it("naming-convention mapping covers format.ts exports", () => {
    const result = testCoverageFromDb(db);
    // utils/format.ts has naming mapping → formatDate is covered
    const formatUntested = result.untested.filter(
      (u) => u.filePath === "src/utils/format.ts",
    );
    expect(formatUntested).toHaveLength(0);
  });

  it("excludes internal symbols from untested list", () => {
    const result = testCoverageFromDb(db);
    // internalHelper is not exported → should NOT appear in untested
    const internalInUntested = result.untested.find(
      (u) => u.name === "internalHelper",
    );
    expect(internalInUntested).toBeUndefined();
  });

  it("computes coverage percentage correctly", () => {
    const result = testCoverageFromDb(db);
    // 7 exported, 2 untested (orphanedFunction + createPool) → 5/7 = 71.4%
    expect(result.covered).toBe(5);
    expect(result.coveragePercent).toBeCloseTo(71.4, 0);
  });

  it("builds per-directory summary", () => {
    const result = testCoverageFromDb(db);
    expect(result.byDirectory.length).toBeGreaterThan(0);

    // src/orphan.ts dir ("src") should have low coverage
    const srcDir = result.byDirectory.find((d) => d.directory === "src");
    expect(srcDir).toBeDefined();
    expect(srcDir!.coveragePercent).toBe(0);
  });

  it("respects limit parameter", () => {
    const result = testCoverageFromDb(db, { limit: 1 });
    expect(result.untested.length).toBeLessThanOrEqual(1);
    // But totals should still reflect the full count
    expect(result.totalExported).toBe(7);
  });

  it("returns empty untested when all symbols have coverage", () => {
    // Create a minimal DB with full coverage
    const tmpPath = path.join(os.tmpdir(), `cari-tc-full-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);

    const ins = tmpDb.prepare(`
      INSERT INTO symbols (id, name, kind, file_path, line, export)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    ins.run("s1", "greet", "function", "src/greet.ts", 1, "exported");
    ins.run("t1", "testGreet", "function", "src/greet.test.ts", 1, "internal");

    const result = testCoverageFromDb(tmpDb);
    expect(result.totalExported).toBe(1);
    expect(result.covered).toBe(1);
    expect(result.coveragePercent).toBe(100);
    expect(result.untested).toHaveLength(0);

    tmpDb.close();
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it("handles .spec.ts naming pattern", () => {
    const tmpPath = path.join(os.tmpdir(), `cari-tc-spec-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);

    const ins = tmpDb.prepare(`
      INSERT INTO symbols (id, name, kind, file_path, line, export)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    ins.run("s1", "Widget", "class", "src/widget.ts", 1, "exported");
    ins.run(
      "t1",
      "testWidget",
      "function",
      "src/widget.spec.ts",
      1,
      "internal",
    );

    const result = testCoverageFromDb(tmpDb);
    expect(result.covered).toBe(1);
    expect(result.mappings[0].testFile).toBe("src/widget.spec.ts");
    expect(result.mappings[0].sourceFile).toBe("src/widget.ts");

    tmpDb.close();
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it("handles __tests__ directory pattern", () => {
    const tmpPath = path.join(os.tmpdir(), `cari-tc-testdir-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);

    const ins = tmpDb.prepare(`
      INSERT INTO symbols (id, name, kind, file_path, line, export)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    ins.run("s1", "Util", "class", "src/util.ts", 1, "exported");
    ins.run(
      "t1",
      "testUtil",
      "function",
      "src/__tests__/util.ts",
      1,
      "internal",
    );

    // import from test to source
    tmpDb
      .prepare(
        `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "src/__tests__/util.ts",
        "src/util.ts",
        "../util",
        1,
        JSON.stringify(["Util"]),
      );

    const result = testCoverageFromDb(tmpDb);
    expect(result.covered).toBe(1);
    // __tests__/util.ts → ../util.ts via naming match
    const mapping = result.mappings.find(
      (m) => m.testFile === "src/__tests__/util.ts",
    );
    expect(mapping).toBeDefined();

    tmpDb.close();
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it("handles empty database gracefully", () => {
    const tmpPath = path.join(os.tmpdir(), `cari-tc-empty-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);

    const result = testCoverageFromDb(tmpDb);
    expect(result.totalExported).toBe(0);
    expect(result.covered).toBe(0);
    expect(result.coveragePercent).toBe(100);
    expect(result.untested).toHaveLength(0);
    expect(result.mappings).toHaveLength(0);
    expect(result.byDirectory).toHaveLength(0);

    tmpDb.close();
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it("does not count test file symbols as exported", () => {
    const result = testCoverageFromDb(db);
    // Test files may have internal symbols — none should be in totalExported
    const testFileExports = result.untested.filter((u) =>
      u.filePath.includes(".test."),
    );
    expect(testFileExports).toHaveLength(0);
  });

  it("sorts byDirectory by coverage ascending", () => {
    const result = testCoverageFromDb(db);
    for (let i = 1; i < result.byDirectory.length; i++) {
      expect(result.byDirectory[i].coveragePercent).toBeGreaterThanOrEqual(
        result.byDirectory[i - 1].coveragePercent,
      );
    }
  });
});
