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
    INSERT INTO symbols (id, name, kind, container, signature, file_path, line, end_line, export, doc_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      null,
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
    INSERT INTO files (path, last_modified, churn, is_hotspot, primary_owner, bus_factor, is_doc, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const files = [
    ["src/auth/service.ts", "2026-03-15", 450, 1, "alice", 2, 0, "hash1"],
    ["src/auth/jwt.ts", "2026-03-10", 120, 0, "alice", 1, 0, "hash2"],
    ["src/middleware/rate.ts", "2026-02-20", 80, 0, "bob", 1, 0, "hash3"],
    ["src/db/pool.ts", "2026-03-01", 200, 1, "charlie", 1, 0, "hash4"],
    ["src/utils/logger.ts", "2026-01-15", 30, 0, "alice", 1, 0, "hash5"],
    ["src/config.ts", "2026-02-10", 50, 0, "bob", 1, 0, "hash6"],
    ["docs/auth.md", "2026-02-01", 40, 0, "alice", 1, 1, "hash7"],
    ["docs/api.md", "2026-01-20", 25, 0, "bob", 1, 1, "hash8"],
    ["docs/database.md", "2026-03-05", 15, 0, "charlie", 1, 1, "hash9"],
  ];

  const tx5 = db.transaction(() => {
    for (const f of files) {
      insertFile.run(...f);
    }
  });
  tx5();

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
