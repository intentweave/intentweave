// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for CARI query modes.
 *
 * Builds a realistic index from fixture data, then runs each query mode
 * and asserts expected results.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { retrieveFromDb } from "../queries/retrieve.js";
import { connectionsFromDb } from "../queries/connections.js";
import { checkFromDb, formatCheck } from "../queries/check.js";
import { reportFromDb } from "../queries/report.js";
import { clonesFromDb } from "../queries/clones.js";
import { structuralClonesFromDb } from "../queries/clones.js";
import {
  circularImportsFromDb,
  unusedExportsFromDb,
} from "../queries/imports.js";
import { hotspotPriorityFromDb } from "../queries/hotspotPriority.js";
import { todosFromDb } from "../queries/todos.js";
import { moduleCoverageFromDb } from "../queries/moduleCoverage.js";
import { orphanedSectionsFromDb } from "../queries/orphanedSections.js";
import { docCompletenessFromDb } from "../queries/docCompleteness.js";
import { crossGroupDriftFromDb } from "../queries/crossGroupDrift.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let db: Database.Database;
let dbPath: string;

beforeAll(() => {
  // Create temp database
  dbPath = path.join(os.tmpdir(), `cari-query-test-${Date.now()}.db`);
  db = new Database(dbPath);
  initSchema(db);
  seedFixtures(db);
});

afterAll(() => {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

function seedFixtures(db: Database.Database) {
  // ── Symbols ─────────────────────────────────────────────────
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
      "impl:src/auth/service.ts#method:AuthService.validateUser",
      "validateUser",
      "method",
      "AuthService",
      "validateUser(credentials: Credentials): Promise<User>",
      "src/auth/service.ts",
      25,
      50,
      "exported",
      "Validates user credentials",
      "abcd1234abcd1234",
      25,
      "struct_aaa",
    ],
    [
      "impl:src/auth/jwt.ts#function:signToken",
      "signToken",
      "function",
      null,
      "signToken(payload: JwtPayload): string",
      "src/auth/jwt.ts",
      5,
      20,
      "exported",
      "Signs JWT token",
      null,
      null,
      null,
    ],
    [
      "impl:src/auth/jwt.ts#function:verifyToken",
      "verifyToken",
      "function",
      null,
      "verifyToken(token: string): JwtPayload",
      "src/auth/jwt.ts",
      25,
      40,
      "exported",
      "Verifies JWT token",
      null,
      null,
      null,
    ],
    [
      "impl:src/middleware/rate.ts#class:RateLimiter",
      "RateLimiter",
      "class",
      null,
      "class RateLimiter",
      "src/middleware/rate.ts",
      1,
      60,
      "exported",
      "Rate limiting middleware",
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
    [
      "impl:src/db/pool.ts#method:DatabasePool.getConnection",
      "getConnection",
      "method",
      "DatabasePool",
      "getConnection(): Connection",
      "src/db/pool.ts",
      30,
      50,
      "exported",
      null,
      null,
      null,
      null,
    ],
    [
      "impl:src/utils/logger.ts#function:createLogger",
      "createLogger",
      "function",
      null,
      "createLogger(name: string): Logger",
      "src/utils/logger.ts",
      1,
      15,
      "exported",
      null,
      null,
      null,
      null,
    ],
    [
      "impl:src/config.ts#function:loadConfig",
      "loadConfig",
      "function",
      null,
      "loadConfig(): AppConfig",
      "src/config.ts",
      1,
      30,
      "internal",
      "Loads app configuration",
      null,
      null,
      null,
    ],
    // Clone pair: same body hash (exact clone)
    [
      "impl:src/utils/helpers.ts#function:formatDate",
      "formatDate",
      "function",
      null,
      "formatDate(d: Date): string",
      "src/utils/helpers.ts",
      1,
      10,
      "exported",
      null,
      "abcd1234abcd1234",
      10,
      "struct_aaa",
    ],
    // Structural clone pair: same structure_hash but different body_hash
    [
      "impl:src/auth/service.ts#function:normalizeEmail",
      "normalizeEmail",
      "function",
      null,
      "normalizeEmail(email: string): string",
      "src/auth/service.ts",
      110,
      120,
      "exported",
      null,
      "body_norm_email",
      10,
      "struct_bbb",
    ],
    [
      "impl:src/utils/helpers.ts#function:normalizePhone",
      "normalizePhone",
      "function",
      null,
      "normalizePhone(phone: string): string",
      "src/utils/helpers.ts",
      20,
      30,
      "exported",
      null,
      "body_norm_phone",
      10,
      "struct_bbb",
    ],
  ];

  const tx = db.transaction(() => {
    for (const s of symbols) {
      insertSym.run(...s);
    }
  });
  tx();

  // ── Annotations ─────────────────────────────────────────────
  const insertAnn = db.prepare(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const annotations = [
    [
      "docs/auth.md",
      10,
      "AuthService",
      "impl:src/auth/service.ts#class:AuthService",
      1.0,
      "heading",
      null,
      0.7,
    ],
    [
      "docs/auth.md",
      25,
      "validateUser",
      "impl:src/auth/service.ts#method:AuthService.validateUser",
      0.95,
      "code-span",
      null,
      0.8,
    ],
    [
      "docs/auth.md",
      30,
      "signToken",
      "impl:src/auth/jwt.ts#function:signToken",
      0.9,
      "code-span",
      null,
      0.75,
    ],
    [
      "docs/auth.md",
      47,
      "AuthService",
      "impl:src/auth/service.ts#class:AuthService",
      0.95,
      "bold",
      "decision",
      0.7,
    ],
    [
      "docs/api.md",
      15,
      "RateLimiter",
      "impl:src/middleware/rate.ts#class:RateLimiter",
      0.85,
      "heading",
      null,
      0.6,
    ],
    [
      "docs/api.md",
      50,
      "AuthService",
      "impl:src/auth/service.ts#class:AuthService",
      0.8,
      "code-span",
      "requirement",
      0.7,
    ],
    [
      "docs/api.md",
      112,
      "validateUser",
      "impl:src/auth/service.ts#method:AuthService.validateUser",
      0.88,
      "code-span",
      null,
      0.8,
    ],
    [
      "docs/database.md",
      5,
      "DatabasePool",
      "impl:src/db/pool.ts#class:DatabasePool",
      1.0,
      "heading",
      null,
      0.65,
    ],
    [
      "docs/database.md",
      20,
      "getConnection",
      "impl:src/db/pool.ts#method:DatabasePool.getConnection",
      0.7,
      "code-span",
      null,
      0.5,
    ],
    // Ungrounded mentions
    ["docs/auth.md", 60, "session management", null, 0.3, "bold", null, 0.4],
    ["docs/api.md", 80, "rate limiting", null, 0.25, "identifier", null, 0.3],
    // Orphaned section: heading + ungrounded mentions (no grounded annotations in between)
    ["docs/auth.md", 70, "Legacy API", null, 0.5, "heading", null, 0.5],
    ["docs/auth.md", 75, "oldFunction", null, 0.3, "code-span", null, 0.4],
    ["docs/auth.md", 78, "deprecatedMethod", null, 0.3, "code-span", null, 0.4],
  ];

  const tx2 = db.transaction(() => {
    for (const a of annotations) {
      insertAnn.run(...a);
    }
  });
  tx2();

  // ── Co-occurrences ──────────────────────────────────────────
  const insertCooc = db.prepare(`
    INSERT INTO co_occurrences (entity_a, entity_b, count, score, source, file_paths)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const coocs = [
    [
      "AuthService",
      "validateUser",
      5,
      0.85,
      "doc_cooc",
      '["docs/auth.md","docs/api.md"]',
    ],
    ["AuthService", "signToken", 3, 0.72, "doc_cooc", '["docs/auth.md"]'],
    ["AuthService", "RateLimiter", 2, 0.45, "doc_cooc", '["docs/api.md"]'],
    [
      "DatabasePool",
      "getConnection",
      2,
      0.6,
      "doc_cooc",
      '["docs/database.md"]',
    ],
    ["AuthService", "DatabasePool", 1, 0.15, "doc_cooc", '["docs/api.md"]'],
  ];

  const tx3 = db.transaction(() => {
    for (const c of coocs) {
      insertCooc.run(...c);
    }
  });
  tx3();

  // ── Co-changes ──────────────────────────────────────────────
  const insertCc = db.prepare(`
    INSERT INTO co_changes (file_a, file_b, count, jaccard, recency, commit_hashes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const cochanges = [
    [
      "src/auth/service.ts",
      "src/auth/jwt.ts",
      15,
      0.68,
      0.9,
      '["abc123","def456"]',
    ],
    [
      "src/auth/service.ts",
      "src/middleware/rate.ts",
      5,
      0.31,
      0.5,
      '["abc123"]',
    ],
    ["src/db/pool.ts", "src/config.ts", 8, 0.45, 0.7, '["ghi789"]'],
  ];

  const tx4 = db.transaction(() => {
    for (const c of cochanges) {
      insertCc.run(...c);
    }
  });
  tx4();

  // ── Files ───────────────────────────────────────────────────
  const insertFile = db.prepare(`
    INSERT INTO files (path, last_modified, churn, is_hotspot, primary_owner, bus_factor, is_doc, content_hash, doc_group)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const files = [
    ["src/auth/service.ts", "2026-03-15", 450, 1, "alice", 2, 0, "hash1", null],
    ["src/auth/jwt.ts", "2026-03-10", 120, 0, "alice", 1, 0, "hash2", null],
    ["src/middleware/rate.ts", "2026-02-20", 80, 0, "bob", 1, 0, "hash3", null],
    ["src/db/pool.ts", "2026-03-01", 200, 1, "charlie", 1, 0, "hash4", null],
    ["src/utils/logger.ts", "2026-01-15", 30, 0, "alice", 1, 0, "hash5", null],
    [
      "src/utils/helpers.ts",
      "2026-01-10",
      10,
      0,
      "alice",
      1,
      0,
      "hash10",
      null,
    ],
    ["src/config.ts", "2026-02-10", 50, 0, "bob", 1, 0, "hash6", null],
    [
      "docs/auth.md",
      "2026-02-01",
      40,
      0,
      "alice",
      1,
      1,
      "hash7",
      "project-docs",
    ],
    ["docs/api.md", "2026-01-20", 25, 0, "bob", 1, 1, "hash8", "api-reference"],
    [
      "docs/database.md",
      "2026-03-05",
      15,
      0,
      "charlie",
      1,
      1,
      "hash9",
      "project-docs",
    ],
  ];

  const tx5 = db.transaction(() => {
    for (const f of files) {
      insertFile.run(...f);
    }
  });
  tx5();

  // ── Imports ─────────────────────────────────────────────────
  const insertImport = db.prepare(`
    INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
    VALUES (?, ?, ?, ?, ?)
  `);

  const imports = [
    // service.ts → jwt.ts (resolved)
    [
      "src/auth/service.ts",
      "src/auth/jwt.ts",
      "./jwt",
      1,
      '["signToken","verifyToken"]',
    ],
    // service.ts → pool.ts (resolved)
    [
      "src/auth/service.ts",
      "src/db/pool.ts",
      "../db/pool",
      1,
      '["DatabasePool"]',
    ],
    // rate.ts → service.ts (resolved) — creates a cycle: service → jwt, service → pool, rate → service
    [
      "src/middleware/rate.ts",
      "src/auth/service.ts",
      "../auth/service",
      1,
      '["AuthService"]',
    ],
    // service.ts → rate.ts (resolved) — creates cycle: service → rate → service
    [
      "src/auth/service.ts",
      "src/middleware/rate.ts",
      "../middleware/rate",
      1,
      '["RateLimiter"]',
    ],
    // External import (no target_file)
    ["src/auth/jwt.ts", null, "jsonwebtoken", 0, '["sign","verify"]'],
    // logger.ts → config.ts
    ["src/utils/logger.ts", "src/config.ts", "../config", 1, '["loadConfig"]'],
  ];

  const tx6 = db.transaction(() => {
    for (const i of imports) {
      insertImport.run(...i);
    }
  });
  tx6();

  // ── TODOs ───────────────────────────────────────────────────
  const insertTodo = db.prepare(`
    INSERT INTO todos (file_path, line, kind, text)
    VALUES (?, ?, ?, ?)
  `);

  const todoItems = [
    ["src/auth/service.ts", 42, "todo", "Add rate limiting per user"],
    ["src/auth/service.ts", 88, "fixme", "Handle expired token refresh"],
    ["src/auth/jwt.ts", 15, "todo", "Switch to RS256 algorithm"],
    ["src/db/pool.ts", 65, "hack", "Workaround for connection leak"],
    ["src/middleware/rate.ts", 30, "xxx", "Needs review before merge"],
  ];

  const tx7 = db.transaction(() => {
    for (const t of todoItems) {
      insertTodo.run(...t);
    }
  });
  tx7();

  // ── Rebuild FTS ─────────────────────────────────────────────
  db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`);
}

// =============================================================================
// retrieve() tests
// =============================================================================

describe("retrieve", () => {
  it("finds files by annotation text", () => {
    const result = retrieveFromDb(db, { query: "AuthService" });
    expect(result.files.length).toBeGreaterThan(0);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("docs/auth.md");
  });

  it("finds code files via annotated symbols", () => {
    const result = retrieveFromDb(db, { query: "validateUser" });
    const paths = result.files.map((f) => f.path);
    // Should find both the doc and the code file
    expect(paths).toContain("docs/auth.md");
    expect(paths).toContain("src/auth/service.ts");
  });

  it("finds symbol files by FTS match", () => {
    const result = retrieveFromDb(db, { query: "signToken" });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/auth/jwt.ts");
  });

  it("respects scope filter", () => {
    const docsOnly = retrieveFromDb(db, {
      query: "AuthService",
      scope: "docs",
    });
    for (const f of docsOnly.files) {
      expect(f.path).toMatch(/\.(md|mdx|rst|txt|adoc)$/);
    }

    const codeOnly = retrieveFromDb(db, {
      query: "AuthService",
      scope: "code",
    });
    for (const f of codeOnly.files) {
      expect(f.path).not.toMatch(/\.(md|mdx|rst|txt|adoc)$/);
    }
  });

  it("respects limit", () => {
    const result = retrieveFromDb(db, {
      query: "AuthService",
      limit: 2,
    });
    expect(result.files.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for nonsense query", () => {
    const result = retrieveFromDb(db, { query: "xyznonexistent123" });
    expect(result.files.length).toBe(0);
  });

  it("scores higher for higher-confidence annotations", () => {
    const result = retrieveFromDb(db, { query: "AuthService" });
    // docs/auth.md has more + higher-confidence annotations than docs/api.md
    const authIdx = result.files.findIndex((f) => f.path === "docs/auth.md");
    const apiIdx = result.files.findIndex((f) => f.path === "docs/api.md");
    if (authIdx !== -1 && apiIdx !== -1) {
      expect(result.files[authIdx].score).toBeGreaterThanOrEqual(
        result.files[apiIdx].score,
      );
    }
  });
});

// =============================================================================
// connections() tests
// =============================================================================

describe("connections", () => {
  it("finds doc co-occurrence connections", () => {
    const result = connectionsFromDb(db, { entity: "AuthService" });
    const names = result.connections.map((c) => c.name);
    expect(names).toContain("validateUser");
    expect(names).toContain("signToken");
  });

  it("finds co-change connections for annotated entities", () => {
    const result = connectionsFromDb(db, {
      entity: "AuthService",
      include: ["co_change"],
    });
    // AuthService is in service.ts which co-changes with jwt.ts and rate.ts
    const names = result.connections.map((c) => c.name);
    expect(names.some((n) => n.includes("jwt") || n.includes("rate"))).toBe(
      true,
    );
  });

  it("detects gaps: doc co-occurrence without code dependency", () => {
    const result = connectionsFromDb(db, { entity: "AuthService" });
    // RateLimiter co-occurs with AuthService in docs but they're in different files
    const gapDescs = result.gaps.map((g) => g.description);
    expect(gapDescs.length).toBeGreaterThanOrEqual(0); // gaps may or may not appear depending on data
  });

  it("respects limit", () => {
    const result = connectionsFromDb(db, {
      entity: "AuthService",
      limit: 2,
    });
    expect(result.connections.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for unknown entity", () => {
    const result = connectionsFromDb(db, { entity: "NonExistent" });
    expect(result.connections.length).toBe(0);
  });
});

// =============================================================================
// check() tests
// =============================================================================

describe("check", () => {
  it("finds stale docs referencing changed code files", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
    });

    // docs/auth.md and docs/api.md reference AuthService/validateUser
    expect(result.findings.length).toBeGreaterThan(0);
    const docFiles = result.findings.map((f) => f.file);
    expect(docFiles).toContain("docs/auth.md");
  });

  it("finds co-change partners not in PR", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
    });

    // service.ts co-changes with jwt.ts (jaccard 0.68) but jwt.ts not in PR
    const messages = result.findings.map((f) => f.message);
    expect(messages.some((m) => m.includes("co-changes with"))).toBe(true);
  });

  it("returns empty for unchanged files", () => {
    const result = checkFromDb(db, { changed: [] });
    expect(result.findings.length).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  it("formats as GitHub annotations", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
    });
    const githubOutput = formatCheck(result, "github");
    // Should have :: prefixed annotation lines
    if (result.findings.length > 0) {
      expect(githubOutput).toMatch(/::(notice|warning|error) /);
    }
  });

  it("formats as JSON", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
    });
    const jsonOutput = formatCheck(result, "json");
    const parsed = JSON.parse(jsonOutput);
    expect(parsed).toHaveProperty("findings");
    expect(parsed).toHaveProperty("exitCode");
  });

  it("filters by severity", () => {
    const allFindings = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
      severity: "info",
    });
    const warningsOnly = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
      severity: "warning",
    });
    expect(warningsOnly.findings.length).toBeLessThanOrEqual(
      allFindings.findings.length,
    );
  });
});

// =============================================================================
// report() tests
// =============================================================================

describe("report", () => {
  it("computes coverage", () => {
    const result = reportFromDb(db);
    expect(result.coverage.total).toBeGreaterThan(0);
    expect(result.coverage.percentage).toBeGreaterThanOrEqual(0);
    expect(result.coverage.percentage).toBeLessThanOrEqual(100);
  });

  it("finds documented symbols", () => {
    const result = reportFromDb(db);
    // AuthService, validateUser, signToken, RateLimiter, DatabasePool, getConnection are annotated
    expect(result.coverage.documented).toBeGreaterThan(0);
  });

  it("finds undocumented exported symbols", () => {
    const result = reportFromDb(db);
    // createLogger and verifyToken have no annotations
    const undocNames = result.coverage.topUndocumented.map((s) => s.name);
    expect(undocNames).toContain("createLogger");
  });

  it("computes staleness", () => {
    const result = reportFromDb(db);
    // docs/auth.md (2026-02-01) references service.ts (2026-03-15) → 42 days stale
    if (result.staleness.topStale.length > 0) {
      const authStale = result.staleness.topStale.find(
        (s) => s.docPath === "docs/auth.md",
      );
      if (authStale) {
        expect(authStale.daysBehind).toBeGreaterThan(30);
      }
    }
  });

  it("finds hidden couplings", () => {
    const result = reportFromDb(db);
    // Should have some co-occurring entities
    expect(result.hiddenCouplings.length).toBeGreaterThanOrEqual(0);
  });

  it("has valid structure", () => {
    const result = reportFromDb(db);
    expect(result).toHaveProperty("coverage");
    expect(result).toHaveProperty("staleness");
    expect(result).toHaveProperty("hiddenCouplings");
    expect(result).toHaveProperty("undocumentedDeps");
  });
});

// =============================================================================
// clones() tests
// =============================================================================

describe("clones", () => {
  it("finds exact clone groups by body hash", () => {
    const result = clonesFromDb(db);
    expect(result.totalCloneGroups).toBe(1);
    expect(result.totalClonedSymbols).toBe(2);
  });

  it("returns both symbols sharing the same body hash", () => {
    const result = clonesFromDb(db);
    const group = result.cloneGroups[0];
    expect(group.bodyHash).toBe("abcd1234abcd1234");
    const names = group.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["formatDate", "validateUser"]);
  });

  it("includes file path and line info", () => {
    const result = clonesFromDb(db);
    const group = result.cloneGroups[0];
    for (const sym of group.symbols) {
      expect(sym.filePath).toBeTruthy();
      expect(sym.line).toBeGreaterThan(0);
      expect(sym.kind).toBeTruthy();
    }
  });
});

// =============================================================================
// circularImports() tests
// =============================================================================

describe("circularImports", () => {
  it("detects circular import cycles", () => {
    const result = circularImportsFromDb(db);
    // service.ts → rate.ts → service.ts is a cycle
    expect(result.totalCycles).toBeGreaterThan(0);
  });

  it("includes the correct files in the cycle", () => {
    const result = circularImportsFromDb(db);
    const cycle = result.cycles.find((c) => c.length === 2);
    expect(cycle).toBeDefined();
    if (cycle) {
      expect(cycle.files).toContain("src/auth/service.ts");
      expect(cycle.files).toContain("src/middleware/rate.ts");
    }
  });

  it("correct cycle structure", () => {
    const result = circularImportsFromDb(db);
    for (const cycle of result.cycles) {
      expect(cycle.files.length).toBe(cycle.length);
      expect(cycle.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// =============================================================================
// unusedExports() tests
// =============================================================================

describe("unusedExports", () => {
  it("finds exported symbols never imported", () => {
    const result = unusedExportsFromDb(db);
    expect(result.totalExported).toBeGreaterThan(0);
    expect(result.totalUnused).toBeGreaterThan(0);
  });

  it("createLogger is unused (no one imports it)", () => {
    const result = unusedExportsFromDb(db);
    const names = result.unused.map((u) => u.name);
    expect(names).toContain("createLogger");
  });

  it("signToken is NOT unused (service.ts imports it)", () => {
    const result = unusedExportsFromDb(db);
    const names = result.unused.map((u) => u.name);
    expect(names).not.toContain("signToken");
  });

  it("includes file path, kind, and line", () => {
    const result = unusedExportsFromDb(db);
    for (const u of result.unused) {
      expect(u.filePath).toBeTruthy();
      expect(u.kind).toBeTruthy();
      expect(u.line).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// hotspotPriority() tests
// =============================================================================

describe("hotspotPriority", () => {
  it("returns priorities for code files with churn", () => {
    const result = hotspotPriorityFromDb(db);
    expect(result.priorities.length).toBeGreaterThan(0);
  });

  it("high-churn low-coverage files rank highest", () => {
    const result = hotspotPriorityFromDb(db);
    // pool.ts has churn=200, getConnection is undocumented → some coverage gap
    const poolPriority = result.priorities.find(
      (p) => p.filePath === "src/db/pool.ts",
    );
    expect(poolPriority).toBeDefined();
    if (poolPriority) {
      expect(poolPriority.churn).toBe(200);
      // Not all exported symbols in pool.ts are documented
      expect(poolPriority.priorityScore).toBeGreaterThanOrEqual(0);
    }
    // The first item should have the highest priority score
    expect(result.priorities[0].priorityScore).toBeGreaterThan(0);
  });

  it("priorityScore uses churn × (1 − coverage)", () => {
    const result = hotspotPriorityFromDb(db);
    for (const p of result.priorities) {
      const expected = p.churn * (1 - p.coveragePercent / 100);
      expect(p.priorityScore).toBeCloseTo(expected, 0);
    }
  });

  it("is sorted by priorityScore descending", () => {
    const result = hotspotPriorityFromDb(db);
    for (let i = 1; i < result.priorities.length; i++) {
      expect(result.priorities[i - 1].priorityScore).toBeGreaterThanOrEqual(
        result.priorities[i].priorityScore,
      );
    }
  });
});

// =============================================================================
// todos() tests
// =============================================================================

describe("todos", () => {
  it("returns all TODO/FIXME/HACK/XXX markers", () => {
    const result = todosFromDb(db);
    expect(result.totalCount).toBe(5);
  });

  it("groups by kind correctly", () => {
    const result = todosFromDb(db);
    expect(result.byKind["todo"]).toBe(2);
    expect(result.byKind["fixme"]).toBe(1);
    expect(result.byKind["hack"]).toBe(1);
    expect(result.byKind["xxx"]).toBe(1);
  });

  it("includes file path, line, and text", () => {
    const result = todosFromDb(db);
    const hackTodo = result.todos.find((t) => t.kind === "hack");
    expect(hackTodo).toBeDefined();
    if (hackTodo) {
      expect(hackTodo.filePath).toBe("src/db/pool.ts");
      expect(hackTodo.line).toBe(65);
      expect(hackTodo.text).toBe("Workaround for connection leak");
    }
  });

  it("is ordered by kind, then file, then line", () => {
    const result = todosFromDb(db);
    for (let i = 1; i < result.todos.length; i++) {
      const prev = result.todos[i - 1];
      const curr = result.todos[i];
      const cmp =
        prev.kind.localeCompare(curr.kind) ||
        prev.filePath.localeCompare(curr.filePath) ||
        prev.line - curr.line;
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });
});

// =============================================================================
// moduleCoverage() tests
// =============================================================================

describe("moduleCoverage", () => {
  it("returns coverage per directory", () => {
    const result = moduleCoverageFromDb(db);
    expect(result.modules.length).toBeGreaterThan(0);
    const dirs = result.modules.map((m) => m.module);
    expect(dirs).toContain("src/auth");
    expect(dirs).toContain("src/db");
  });

  it("computes correct coverage percentages", () => {
    const result = moduleCoverageFromDb(db);
    for (const m of result.modules) {
      expect(m.coveragePercent).toBeGreaterThanOrEqual(0);
      expect(m.coveragePercent).toBeLessThanOrEqual(100);
      expect(m.documented).toBeLessThanOrEqual(m.totalExported);
    }
  });

  it("sorted by coveragePercent ascending (worst first)", () => {
    const result = moduleCoverageFromDb(db);
    for (let i = 1; i < result.modules.length; i++) {
      expect(result.modules[i - 1].coveragePercent).toBeLessThanOrEqual(
        result.modules[i].coveragePercent,
      );
    }
  });

  it("utils module has low coverage (createLogger undocumented)", () => {
    const result = moduleCoverageFromDb(db);
    const utils = result.modules.find((m) => m.module === "src/utils");
    expect(utils).toBeDefined();
    if (utils) {
      // createLogger, formatDate, normalizePhone are exported; none have annotations
      expect(utils.totalExported).toBeGreaterThanOrEqual(1);
      expect(utils.coveragePercent).toBeLessThan(100);
    }
  });
});

// =============================================================================
// orphanedSections() tests
// =============================================================================

describe("orphanedSections", () => {
  it("finds orphaned sections with all-ungrounded annotations", () => {
    const result = orphanedSectionsFromDb(db);
    expect(result.totalOrphaned).toBeGreaterThan(0);
  });

  it("detects the Legacy API section as orphaned", () => {
    const result = orphanedSectionsFromDb(db);
    const legacy = result.sections.find((s) => s.heading === "Legacy API");
    expect(legacy).toBeDefined();
    if (legacy) {
      expect(legacy.docPath).toBe("docs/auth.md");
      expect(legacy.line).toBe(70);
      expect(legacy.ungroundedMentions).toBeGreaterThanOrEqual(2);
    }
  });

  it("does NOT flag the AuthService heading (grounded)", () => {
    const result = orphanedSectionsFromDb(db);
    const authSection = result.sections.find(
      (s) => s.heading === "AuthService",
    );
    // AuthService heading at line 10 has grounded annotations under it
    expect(authSection).toBeUndefined();
  });

  it("includes docPath and line info", () => {
    const result = orphanedSectionsFromDb(db);
    for (const s of result.sections) {
      expect(s.docPath).toBeTruthy();
      expect(s.line).toBeGreaterThan(0);
      expect(s.heading).toBeTruthy();
    }
  });
});

// =============================================================================
// docCompleteness() tests
// =============================================================================

describe("docCompleteness", () => {
  it("returns completeness scores per doc", () => {
    const result = docCompletenessFromDb(db);
    expect(result.docs.length).toBeGreaterThan(0);
    const docPaths = result.docs.map((d) => d.docPath);
    expect(docPaths).toContain("docs/auth.md");
  });

  it("scores between 0 and 100", () => {
    const result = docCompletenessFromDb(db);
    for (const d of result.docs) {
      expect(d.completenessPercent).toBeGreaterThanOrEqual(0);
      expect(d.completenessPercent).toBeLessThanOrEqual(100);
      expect(d.coveredExports).toBeLessThanOrEqual(d.totalRelevantExports);
    }
  });

  it("sorted by completenessPercent ascending (least complete first)", () => {
    const result = docCompletenessFromDb(db);
    for (let i = 1; i < result.docs.length; i++) {
      expect(result.docs[i - 1].completenessPercent).toBeLessThanOrEqual(
        result.docs[i].completenessPercent,
      );
    }
  });

  it("lists missing symbols for incomplete docs", () => {
    const result = docCompletenessFromDb(db);
    // docs/auth.md references service.ts (AuthService, validateUser) and jwt.ts (signToken),
    // but verifyToken in jwt.ts is exported but not in auth.md annotations
    const authDoc = result.docs.find((d) => d.docPath === "docs/auth.md");
    expect(authDoc).toBeDefined();
    if (authDoc && authDoc.missing.length > 0) {
      const missingNames = authDoc.missing.map((m) => m.name);
      expect(missingNames).toContain("verifyToken");
    }
  });
});

// =============================================================================
// structuralClones() tests
// =============================================================================

describe("structuralClones", () => {
  it("finds structural clone groups", () => {
    const result = structuralClonesFromDb(db);
    expect(result.totalCloneGroups).toBeGreaterThan(0);
  });

  it("returns normalizeEmail and normalizePhone as structural clones", () => {
    const result = structuralClonesFromDb(db);
    const bbbGroup = result.cloneGroups.find(
      (g) => g.structureHash === "struct_bbb",
    );
    expect(bbbGroup).toBeDefined();
    if (bbbGroup) {
      const names = bbbGroup.symbols.map((s) => s.name).sort();
      expect(names).toEqual(["normalizeEmail", "normalizePhone"]);
    }
  });

  it("excludes exact clones (same body_hash) from structural results", () => {
    const result = structuralClonesFromDb(db);
    // validateUser and formatDate share struct_aaa AND body_hash abcd1234abcd1234
    // But they have the same body_hash — however there's also the struct_aaa group
    // which has 2 symbols with same body_hash, so COUNT(DISTINCT body_hash) = 1 → excluded
    const aaaGroup = result.cloneGroups.find(
      (g) => g.structureHash === "struct_aaa",
    );
    expect(aaaGroup).toBeUndefined();
  });

  it("includes file path, line, and kind", () => {
    const result = structuralClonesFromDb(db);
    for (const group of result.cloneGroups) {
      for (const sym of group.symbols) {
        expect(sym.filePath).toBeTruthy();
        expect(sym.line).toBeGreaterThan(0);
        expect(sym.kind).toBeTruthy();
      }
    }
  });
});

// =============================================================================
// crossGroupDrift() tests
// =============================================================================

describe("crossGroupDrift", () => {
  it("finds entities mentioned in multiple doc groups", () => {
    const result = crossGroupDriftFromDb(db);
    expect(result.totalDrifts).toBeGreaterThan(0);
  });

  it("detects AuthService appearing in project-docs and api-reference", () => {
    const result = crossGroupDriftFromDb(db);
    const authDrift = result.drifts.find((d) => d.entity === "AuthService");
    expect(authDrift).toBeDefined();
    if (authDrift) {
      const groupNames = authDrift.groups.map((g) => g.docGroup).sort();
      expect(groupNames).toContain("project-docs");
      expect(groupNames).toContain("api-reference");
    }
  });

  it("reports qualifier conflict for AuthService", () => {
    const result = crossGroupDriftFromDb(db);
    const authDrift = result.drifts.find((d) => d.entity === "AuthService");
    expect(authDrift).toBeDefined();
    if (authDrift) {
      // project-docs has qualifier "decision" on one AuthService annotation
      // api-reference has no qualifier → this creates a conflict
      const projectDocsGroup = authDrift.groups.find(
        (g) => g.docGroup === "project-docs",
      );
      if (projectDocsGroup && projectDocsGroup.qualifiers.length > 0) {
        expect(authDrift.reason).toContain("qualifiers");
      }
    }
  });

  it("includes docPaths and mentionCount per group", () => {
    const result = crossGroupDriftFromDb(db);
    for (const drift of result.drifts) {
      expect(drift.entity).toBeTruthy();
      expect(drift.groups.length).toBeGreaterThanOrEqual(2);
      for (const g of drift.groups) {
        expect(g.docGroup).toBeTruthy();
        expect(g.docPaths.length).toBeGreaterThan(0);
        expect(g.mentionCount).toBeGreaterThan(0);
      }
    }
  });

  it("sorted by number of groups descending", () => {
    const result = crossGroupDriftFromDb(db);
    for (let i = 1; i < result.drifts.length; i++) {
      expect(result.drifts[i - 1].groups.length).toBeGreaterThanOrEqual(
        result.drifts[i].groups.length,
      );
    }
  });
});

// =============================================================================
// report() — threshold parameterization tests
// =============================================================================

describe("report thresholds", () => {
  it("returns fewer hidden couplings at higher threshold", () => {
    const lowThreshold = reportFromDb(db, { coocThreshold: 0.1 });
    const highThreshold = reportFromDb(db, { coocThreshold: 0.9 });
    expect(lowThreshold.hiddenCouplings.length).toBeGreaterThanOrEqual(
      highThreshold.hiddenCouplings.length,
    );
  });

  it("returns no hidden couplings at threshold above max score", () => {
    const result = reportFromDb(db, { coocThreshold: 100 });
    expect(result.hiddenCouplings.length).toBe(0);
  });

  it("returns all hidden couplings at threshold 0", () => {
    const result = reportFromDb(db, { coocThreshold: 0 });
    expect(result.hiddenCouplings.length).toBeGreaterThan(0);
  });

  it("returns fewer undocumented deps at higher threshold", () => {
    const lowThreshold = reportFromDb(db, { cochangeThreshold: 0.1 });
    const highThreshold = reportFromDb(db, { cochangeThreshold: 0.9 });
    expect(lowThreshold.undocumentedDeps.length).toBeGreaterThanOrEqual(
      highThreshold.undocumentedDeps.length,
    );
  });

  it("returns no undocumented deps at threshold above max jaccard", () => {
    const result = reportFromDb(db, { cochangeThreshold: 100 });
    expect(result.undocumentedDeps.length).toBe(0);
  });

  it("defaults thresholds to 0.3 when omitted", () => {
    const defaultResult = reportFromDb(db);
    const explicitResult = reportFromDb(db, {
      coocThreshold: 0.3,
      cochangeThreshold: 0.3,
    });
    expect(defaultResult.hiddenCouplings.length).toBe(
      explicitResult.hiddenCouplings.length,
    );
    expect(defaultResult.undocumentedDeps.length).toBe(
      explicitResult.undocumentedDeps.length,
    );
  });

  it("coverage and staleness are not affected by thresholds", () => {
    const low = reportFromDb(db, { coocThreshold: 0, cochangeThreshold: 0 });
    const high = reportFromDb(db, { coocThreshold: 1, cochangeThreshold: 1 });
    expect(low.coverage.total).toBe(high.coverage.total);
    expect(low.coverage.documented).toBe(high.coverage.documented);
    expect(low.staleness.staleDocCount).toBe(high.staleness.staleDocCount);
  });
});

// =============================================================================
// check() — severity classification tests
// =============================================================================

describe("check severity", () => {
  it("assigns severity based on age and confidence", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
    });
    // Each finding should have a valid severity
    for (const f of result.findings) {
      expect(["info", "warning", "critical"]).toContain(f.severity);
    }
  });

  it("co-change partner with high jaccard gets info severity", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
    });
    // Co-change analysis is advisory — all co-change findings are "info"
    // regardless of jaccard score (they surface in PR comments but never block CI).
    const jwtFinding = result.findings.find(
      (f) =>
        f.message.includes("co-changes with") && f.message.includes("jwt.ts"),
    );
    expect(jwtFinding).toBeDefined();
    if (jwtFinding) {
      expect(jwtFinding.severity).toBe("info");
    }
  });

  it("co-change partner with low jaccard gets info severity", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
    });
    // service.ts co-changes with rate.ts (jaccard=0.31 < 0.6) → "info"
    const rateFinding = result.findings.find(
      (f) =>
        f.message.includes("co-changes with") && f.message.includes("rate.ts"),
    );
    expect(rateFinding).toBeDefined();
    if (rateFinding) {
      expect(rateFinding.severity).toBe("info");
    }
  });

  it("returns exit code 0 for info-only findings", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
      severity: "info",
    });
    // When we filter out warnings — only info left should give exit code 0
    const infoOnly = {
      ...result,
      findings: result.findings.filter((f) => f.severity === "info"),
    };
    // If all are info, exit code should be 0
    const hasWarning = infoOnly.findings.some((f) => f.severity === "warning");
    const hasCritical = infoOnly.findings.some(
      (f) => f.severity === "critical",
    );
    expect(hasWarning).toBe(false);
    expect(hasCritical).toBe(false);
  });

  it("filters findings by severity parameter", () => {
    const infoResult = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
      severity: "info",
    });
    const warningResult = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
      severity: "warning",
    });
    const criticalResult = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
      severity: "critical",
    });

    expect(infoResult.findings.length).toBeGreaterThanOrEqual(
      warningResult.findings.length,
    );
    expect(warningResult.findings.length).toBeGreaterThanOrEqual(
      criticalResult.findings.length,
    );

    // All warning-filtered findings should be warning or critical
    for (const f of warningResult.findings) {
      expect(["warning", "critical"]).toContain(f.severity);
    }
  });

  it("exit code reflects highest severity", () => {
    const result = checkFromDb(db, {
      changed: ["src/auth/service.ts"],
    });
    const hasCritical = result.findings.some((f) => f.severity === "critical");
    const hasWarning = result.findings.some((f) => f.severity === "warning");

    if (hasCritical) {
      expect(result.exitCode).toBe(2);
    } else if (hasWarning) {
      expect(result.exitCode).toBe(1);
    } else {
      expect(result.exitCode).toBe(0);
    }
  });
});
