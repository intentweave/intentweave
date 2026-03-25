// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for CARI-backed doc-health analysis.
 *
 * Creates an in-memory index with known fixtures, calls analyzeFromCari(),
 * and asserts expected DriftSignal categories and severities.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "@intentweave/index";
import { analyzeFromCari } from "../../doc-health/cariDocHealth.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `cari-health-test-${Date.now()}.db`);
  const db = new Database(dbPath);
  initSchema(db);
  seedFixtures(db);
  db.close();
});

afterAll(() => {
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
      "s1",
      "AuthService",
      "class",
      null,
      "class AuthService",
      "src/auth/service.ts",
      10,
      100,
      "exported",
      "Auth",
    ],
    [
      "s2",
      "validateUser",
      "method",
      "AuthService",
      "validateUser(): Promise<User>",
      "src/auth/service.ts",
      25,
      50,
      "exported",
      null,
    ],
    [
      "s3",
      "signToken",
      "function",
      null,
      "signToken(payload): string",
      "src/auth/jwt.ts",
      5,
      20,
      "exported",
      null,
    ],
    // Undocumented exported symbol — should appear as undocumented signal
    [
      "s4",
      "DatabasePool",
      "class",
      null,
      "class DatabasePool",
      "src/db/pool.ts",
      1,
      80,
      "exported",
      null,
    ],
    // Internal — should NOT appear as undocumented
    [
      "s5",
      "loadConfig",
      "function",
      null,
      "loadConfig(): Config",
      "src/config.ts",
      1,
      30,
      "internal",
      null,
    ],
  ];

  db.transaction(() => {
    for (const s of symbols) insertSym.run(...s);
  })();

  // ── Annotations ─────────────────────────────────────────────
  const insertAnn = db.prepare(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const annotations = [
    // Grounded mentions
    ["docs/auth.md", 10, "AuthService", "s1", 1.0, "heading", null, 0.7],
    ["docs/auth.md", 25, "validateUser", "s2", 0.95, "code-span", null, 0.8],
    ["docs/auth.md", 30, "signToken", "s3", 0.9, "code-span", null, 0.75],
  ];

  db.transaction(() => {
    for (const a of annotations) insertAnn.run(...a);
  })();

  // ── Co-occurrences ──────────────────────────────────────────
  const insertCooc = db.prepare(`
    INSERT INTO co_occurrences (entity_a, entity_b, count, score, source, file_paths)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const coocs = [
    // Doc co-mention with no code dependency → hidden coupling signal
    ["AuthService", "DatabasePool", 3, 0.65, "doc_cooc", '["docs/arch.md"]'],
    // Doc co-mention WITH code dependency → should NOT be a signal
    [
      "AuthService",
      "signToken",
      5,
      0.85,
      "code_import",
      '["src/auth/service.ts"]',
    ],
  ];

  db.transaction(() => {
    for (const c of coocs) insertCooc.run(...c);
  })();

  // ── Files (with staleness) ──────────────────────────────────
  const insertFile = db.prepare(`
    INSERT INTO files (path, last_modified, churn, is_hotspot, primary_owner, bus_factor, is_doc, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const files = [
    // Code file modified recently
    ["src/auth/service.ts", "2026-03-20", 450, 1, "alice", 2, 0, "h1"],
    ["src/auth/jwt.ts", "2026-03-10", 120, 0, "alice", 1, 0, "h2"],
    ["src/db/pool.ts", "2026-03-01", 200, 0, "bob", 1, 0, "h3"],
    ["src/config.ts", "2026-02-10", 50, 0, "bob", 1, 0, "h4"],
    // Doc file older than its referenced code → staleness
    ["docs/auth.md", "2026-01-15", 40, 0, "alice", 1, 1, "h5"],
  ];

  db.transaction(() => {
    for (const f of files) insertFile.run(...f);
  })();

  // Rebuild FTS
  db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`);
}

// =============================================================================
// Tests
// =============================================================================

describe("analyzeFromCari", () => {
  it("produces a valid UnifiedDriftReport", () => {
    const { report } = analyzeFromCari({ dbPath });

    expect(report.$schema).toBe("intentweave://schemas/drift-report/v1");
    expect(report.session).toBe("cari");
    expect(report.stats.totalSignals).toBeGreaterThan(0);
  });

  it("detects undocumented exported symbols", () => {
    const { report } = analyzeFromCari({ dbPath });
    const undoc = report.signals.filter((s) => s.category === "undocumented");

    // DatabasePool is exported but has no annotation → undocumented
    const names = undoc.map((s) => s.name);
    expect(names).toContain("DatabasePool");

    // loadConfig is internal → should NOT appear
    expect(names).not.toContain("loadConfig");
  });

  it("detects stale documentation", () => {
    const { report } = analyzeFromCari({ dbPath });
    const stale = report.signals.filter((s) => s.category === "temporal-stale");

    // docs/auth.md (2026-01-15) references code in service.ts (2026-03-20)
    // → ~64 days behind → should be a warning
    expect(stale.length).toBeGreaterThan(0);
    const authStale = stale.find((s) => s.name === "auth.md");
    expect(authStale).toBeDefined();
    expect(authStale!.severity).toBe("warning");
    expect(authStale!.files).toContain("docs/auth.md");
  });

  it("detects hidden couplings (doc-doc diverged)", () => {
    const { report } = analyzeFromCari({ dbPath });
    const hidden = report.signals.filter(
      (s) => s.category === "doc-doc-diverged",
    );

    // AuthService ↔ DatabasePool co-mentioned in docs but no code dep
    const names = hidden.map((s) => s.name);
    expect(
      names.some(
        (n) => n.includes("AuthService") && n.includes("DatabasePool"),
      ),
    ).toBe(true);
  });

  it("has correct detector stats", () => {
    const { report } = analyzeFromCari({ dbPath });

    expect(report.detectorStats.docCode.enabled).toBe(true);
    expect(report.detectorStats.temporal.enabled).toBe(true);
    expect(report.detectorStats.docDoc.enabled).toBe(true);
    expect(report.detectorStats.deps.enabled).toBe(false); // disabled
  });

  it("throws when index does not exist", () => {
    expect(() => analyzeFromCari({ dbPath: "/nonexistent/index.db" })).toThrow(
      "CARI index not found",
    );
  });
});
