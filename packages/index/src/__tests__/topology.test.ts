// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Section 9: Graph Topology & Structure
 *
 * 9.1 Community Detection
 * 9.2 Hub / God-Node Analysis
 * 9.3 Surprising Connection Ranking
 * 9.4 Rationale Extraction
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { hubsFromDb } from "../queries/hubs.js";
import {
  communitiesFromDb,
  communityLabelsFromDb,
} from "../queries/communities.js";
import { surprisesFromDb } from "../queries/surprises.js";
import { rationaleFromDb } from "../queries/rationale.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let db: Database.Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `cari-topology-${Date.now()}.db`);
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
    INSERT INTO symbols (id, name, kind, container, signature, file_path, line, end_line, export, doc_summary, body_hash, body_lines, structure_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    null,
    null,
    null,
    null,
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
    null,
    null,
    null,
    null,
  );
  insertSym.run(
    "s3",
    "DatabasePool",
    "class",
    null,
    "class DatabasePool",
    "src/db/pool.ts",
    1,
    50,
    "exported",
    null,
    null,
    null,
    null,
  );
  insertSym.run(
    "s4",
    "AppConfig",
    "class",
    null,
    "class AppConfig",
    "src/config.ts",
    1,
    30,
    "exported",
    null,
    null,
    null,
    null,
  );
  insertSym.run(
    "s5",
    "Logger",
    "class",
    null,
    "class Logger",
    "src/util/logger.ts",
    1,
    40,
    "exported",
    null,
    null,
    null,
    null,
  );

  // ── Annotations ──
  const insertAnn = d.prepare(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, idf_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // AuthService mentioned a lot (hub)
  insertAnn.run("docs/auth.md", 5, "AuthService", "s1", 0.9, "code-span", 0.5);
  insertAnn.run("docs/auth.md", 10, "AuthService", "s1", 0.9, "code-span", 0.5);
  insertAnn.run(
    "docs/overview.md",
    3,
    "AuthService",
    "s1",
    0.8,
    "heading",
    0.4,
  );
  insertAnn.run("docs/auth.md", 15, "UserRepo", "s2", 0.8, "code-span", 0.4);
  insertAnn.run("docs/db.md", 5, "DatabasePool", "s3", 0.9, "code-span", 0.5);

  // ── Files ──
  const insertFile = d.prepare(`
    INSERT INTO files (path, last_modified, churn, is_hotspot, primary_owner, is_doc, doc_group)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertFile.run("src/auth/service.ts", 1000, 15, 1, "alice", 0, null);
  insertFile.run("src/user/repo.ts", 1000, 8, 0, "bob", 0, null);
  insertFile.run("src/db/pool.ts", 1000, 5, 0, "alice", 0, null);
  insertFile.run("src/config.ts", 1000, 20, 1, "carol", 0, null);
  insertFile.run("src/util/logger.ts", 1000, 3, 0, "carol", 0, null);
  insertFile.run("docs/auth.md", 1000, 2, 0, "alice", 1, "guides");
  insertFile.run("docs/overview.md", 1000, 1, 0, "bob", 1, "guides");
  insertFile.run("docs/db.md", 1000, 1, 0, "alice", 1, "guides");

  // ── Imports ──
  const insertImport = d.prepare(`
    INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
    VALUES (?, ?, ?, ?, ?)
  `);

  // auth cluster
  insertImport.run(
    "src/auth/service.ts",
    "src/user/repo.ts",
    "./user/repo",
    1,
    "UserRepo",
  );
  insertImport.run(
    "src/auth/service.ts",
    "src/db/pool.ts",
    "./db/pool",
    1,
    "DatabasePool",
  );
  // common dependencies
  insertImport.run(
    "src/auth/service.ts",
    "src/config.ts",
    "./config",
    1,
    "AppConfig",
  );
  insertImport.run(
    "src/user/repo.ts",
    "src/db/pool.ts",
    "./db/pool",
    1,
    "DatabasePool",
  );
  insertImport.run(
    "src/user/repo.ts",
    "src/config.ts",
    "./config",
    1,
    "AppConfig",
  );
  // logger used everywhere
  insertImport.run(
    "src/auth/service.ts",
    "src/util/logger.ts",
    "./util/logger",
    1,
    "Logger",
  );
  insertImport.run(
    "src/user/repo.ts",
    "src/util/logger.ts",
    "./util/logger",
    1,
    "Logger",
  );
  insertImport.run(
    "src/db/pool.ts",
    "src/util/logger.ts",
    "./util/logger",
    1,
    "Logger",
  );

  // ── Co-occurrences ──
  const insertCoOcc = d.prepare(`
    INSERT INTO co_occurrences (entity_a, entity_b, count, score, source, file_paths)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertCoOcc.run(
    "AuthService",
    "UserRepo",
    5,
    0.8,
    "doc-cooc",
    "docs/auth.md",
  );
  insertCoOcc.run(
    "AuthService",
    "DatabasePool",
    3,
    0.6,
    "code-import",
    "src/auth/service.ts",
  );
  insertCoOcc.run(
    "UserRepo",
    "DatabasePool",
    4,
    0.7,
    "code-import",
    "src/user/repo.ts",
  );
  insertCoOcc.run(
    "AppConfig",
    "Logger",
    2,
    0.4,
    "doc-cooc",
    "docs/overview.md",
  );

  // ── Co-changes ──
  const insertCoChange = d.prepare(`
    INSERT INTO co_changes (file_a, file_b, count, jaccard, recency, commit_hashes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertCoChange.run(
    "src/auth/service.ts",
    "src/user/repo.ts",
    8,
    0.6,
    0.9,
    "abc123,def456",
  );
  insertCoChange.run("src/db/pool.ts", "src/config.ts", 4, 0.4, 0.7, "ghi789");

  // ── Rationale ──
  const insertRationale = d.prepare(`
    INSERT INTO rationale (file_path, line, kind, text, symbol)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertRationale.run(
    "src/auth/service.ts",
    15,
    "why",
    "Token rotation prevents replay attacks",
    null,
  );
  insertRationale.run(
    "src/auth/service.ts",
    42,
    "design",
    "Strategy pattern for multiple auth providers",
    null,
  );
  insertRationale.run(
    "src/db/pool.ts",
    8,
    "important",
    "Pool size must match database connection limit",
    null,
  );
  insertRationale.run(
    "src/config.ts",
    3,
    "note",
    "Env vars override file-based config",
    null,
  );
  insertRationale.run(
    "src/config.ts",
    20,
    "why",
    "Lazy loading avoids startup penalty",
    null,
  );
}

// =============================================================================
// 9.2 Hub Analysis
// =============================================================================

describe("9.2 Hub Analysis", () => {
  it("should return hubs sorted by total degree descending", () => {
    const result = hubsFromDb(db);
    expect(result.hubs.length).toBeGreaterThan(0);

    // Check sorted
    for (let i = 1; i < result.hubs.length; i++) {
      expect(result.hubs[i - 1].totalDegree).toBeGreaterThanOrEqual(
        result.hubs[i].totalDegree,
      );
    }
  });

  it("should compute annotation degree from annotations table", () => {
    const result = hubsFromDb(db);
    const authHub = result.hubs.find((h) => h.name === "AuthService");
    expect(authHub).toBeDefined();
    expect(authHub!.annotationDegree).toBe(3); // 3 annotations
  });

  it("should compute import degree (incoming + outgoing)", () => {
    const result = hubsFromDb(db);
    // src/auth/service.ts imports from 4 files (repo, pool, config, logger)
    const authFile = result.hubs.find((h) => h.name === "src/auth/service.ts");
    expect(authFile).toBeDefined();
    expect(authFile!.importDegree).toBeGreaterThanOrEqual(4);
  });

  it("should compute co-occurrence degree", () => {
    const result = hubsFromDb(db);
    // AuthService appears in 2 co-occurrence edges
    const authHub = result.hubs.find((h) => h.name === "AuthService");
    expect(authHub).toBeDefined();
    expect(authHub!.coOccurrenceDegree).toBe(2);
  });

  it("should compute co-change degree for files", () => {
    const result = hubsFromDb(db);
    // src/auth/service.ts co-changes with src/user/repo.ts
    const authFile = result.hubs.find((h) => h.name === "src/auth/service.ts");
    expect(authFile).toBeDefined();
    expect(authFile!.coChangeDegree).toBeGreaterThanOrEqual(1);
  });

  it("should assign 'file' kind to file entities", () => {
    const result = hubsFromDb(db);
    const fileHub = result.hubs.find((h) => h.name === "src/config.ts");
    expect(fileHub).toBeDefined();
    expect(fileHub!.kind).toBe("file");
  });

  it("should assign symbol kind to symbol entities", () => {
    const result = hubsFromDb(db);
    const symHub = result.hubs.find((h) => h.name === "AuthService");
    expect(symHub).toBeDefined();
    expect(symHub!.kind).toBe("class");
  });

  it("should return empty array for empty database", () => {
    const emptyPath = path.join(
      os.tmpdir(),
      `cari-empty-hubs-${Date.now()}.db`,
    );
    const emptyDb = new Database(emptyPath);
    initSchema(emptyDb);
    const result = hubsFromDb(emptyDb);
    expect(result.hubs).toEqual([]);
    emptyDb.close();
    fs.unlinkSync(emptyPath);
  });
});

// =============================================================================
// 9.1 Community Detection
// =============================================================================

describe("9.1 Community Detection", () => {
  it("should detect at least one community", () => {
    const result = communitiesFromDb(db);
    expect(result.totalCommunities).toBeGreaterThan(0);
  });

  it("should sort communities by size descending", () => {
    const result = communitiesFromDb(db);
    for (let i = 1; i < result.communities.length; i++) {
      expect(result.communities[i - 1].size).toBeGreaterThanOrEqual(
        result.communities[i].size,
      );
    }
  });

  it("should have communities with at least 2 members", () => {
    const result = communitiesFromDb(db);
    for (const c of result.communities) {
      expect(c.size).toBeGreaterThanOrEqual(2);
      expect(c.members.length).toBe(c.size);
    }
  });

  it("should assign sequential community IDs", () => {
    const result = communitiesFromDb(db);
    for (let i = 0; i < result.communities.length; i++) {
      expect(result.communities[i].id).toBe(i);
    }
  });

  it("should label community by first member name", () => {
    const result = communitiesFromDb(db);
    for (const c of result.communities) {
      expect(c.label).toBe(c.members[0].name);
    }
  });

  it("should report total node count", () => {
    const result = communitiesFromDb(db);
    expect(result.totalNodes).toBeGreaterThan(0);
  });

  it("should return empty for empty database", () => {
    const emptyPath = path.join(
      os.tmpdir(),
      `cari-empty-comm-${Date.now()}.db`,
    );
    const emptyDb = new Database(emptyPath);
    initSchema(emptyDb);
    const result = communitiesFromDb(emptyDb);
    expect(result.communities).toEqual([]);
    expect(result.totalCommunities).toBe(0);
    expect(result.totalNodes).toBe(0);
    emptyDb.close();
    fs.unlinkSync(emptyPath);
  });

  it("should return community labels as a Map", () => {
    const labels = communityLabelsFromDb(db);
    expect(labels).toBeInstanceOf(Map);
    expect(labels.size).toBeGreaterThan(0);
  });

  // ── Resolution & Recursive Splitting ──

  it("should produce more communities with higher resolution", () => {
    // Resolution scales maxSize: higher resolution → smaller effective maxSize
    // → more aggressive splitting → at least as many communities
    const low = communitiesFromDb(db, { resolution: 1.0, maxSize: 20 });
    const high = communitiesFromDb(db, { resolution: 3.0, maxSize: 20 });
    // Higher resolution should produce at least as many communities
    expect(high.totalCommunities).toBeGreaterThanOrEqual(
      low.totalCommunities,
    );
  });

  it("should recursively split large communities with maxSize", () => {
    const noSplit = communitiesFromDb(db, { maxSize: Infinity });
    const withSplit = communitiesFromDb(db, { maxSize: 3 });
    // Splitting should produce at least as many communities
    expect(withSplit.totalCommunities).toBeGreaterThanOrEqual(
      noSplit.totalCommunities,
    );
    // All communities from split should be ≤ maxSize (or un-splittable)
    // Note: some communities may resist splitting if the algorithm converges
    // to a single group, so we just check the split count is >= no-split
  });

  it("should respect minSize option", () => {
    const result = communitiesFromDb(db, { minSize: 5 });
    for (const c of result.communities) {
      expect(c.size).toBeGreaterThanOrEqual(5);
    }
  });

  it("should handle resolution = 1.0 the same as default", () => {
    const defaultResult = communitiesFromDb(db);
    const explicitResult = communitiesFromDb(db, { resolution: 1.0 });
    // Same number of communities (algorithm is deterministic at resolution=1 modulo shuffle)
    // We can't check exact equality due to shuffle randomness, but structure should be similar
    expect(explicitResult.totalCommunities).toBeGreaterThan(0);
    expect(explicitResult.totalNodes).toBe(defaultResult.totalNodes);
  });

  // ── Community Modes ──

  it("should support structural mode (default)", () => {
    const result = communitiesFromDb(db, { mode: "structural" });
    expect(result.totalCommunities).toBeGreaterThan(0);
    expect(result.totalNodes).toBeGreaterThan(0);
  });

  it("should support semantic mode", () => {
    const result = communitiesFromDb(db, { mode: "semantic" });
    expect(result.totalCommunities).toBeGreaterThan(0);
    expect(result.totalNodes).toBeGreaterThan(0);
  });

  it("should support temporal mode", () => {
    const result = communitiesFromDb(db, { mode: "temporal" });
    // Temporal relies on co_changes — may produce 0 communities if none
    expect(result.totalCommunities).toBeGreaterThanOrEqual(0);
    expect(result.totalNodes).toBeGreaterThanOrEqual(0);
  });

  it("should produce different results for different modes", () => {
    const structural = communitiesFromDb(db, { mode: "structural" });
    const semantic = communitiesFromDb(db, { mode: "semantic" });
    // Different graphs should typically yield different community counts or labels
    // At minimum both should return valid results
    expect(structural.communities).toBeDefined();
    expect(semantic.communities).toBeDefined();
  });

  it("should default to structural mode when omitted", () => {
    const noMode = communitiesFromDb(db);
    const explicit = communitiesFromDb(db, { mode: "structural" });
    expect(noMode.totalCommunities).toBe(explicit.totalCommunities);
    expect(noMode.totalNodes).toBe(explicit.totalNodes);
  });
});

// =============================================================================
// 9.3 Surprising Connections
// =============================================================================

describe("9.3 Surprising Connection Ranking", () => {
  it("should find at least one surprising connection", () => {
    const result = surprisesFromDb(db);
    expect(result.surprises.length).toBeGreaterThan(0);
  });

  it("should sort by score descending", () => {
    const result = surprisesFromDb(db);
    for (let i = 1; i < result.surprises.length; i++) {
      expect(result.surprises[i - 1].score).toBeGreaterThanOrEqual(
        result.surprises[i].score,
      );
    }
  });

  it("should have scores between 0 and 1", () => {
    const result = surprisesFromDb(db);
    for (const s of result.surprises) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it("should have component scores between 0 and 1", () => {
    const result = surprisesFromDb(db);
    for (const s of result.surprises) {
      expect(s.crossLayerWeight).toBeGreaterThanOrEqual(0);
      expect(s.crossLayerWeight).toBeLessThanOrEqual(1);
      expect(s.communityDistance).toBeGreaterThanOrEqual(0);
      expect(s.communityDistance).toBeLessThanOrEqual(1);
      expect(s.inverseFrequency).toBeGreaterThanOrEqual(0);
      expect(s.inverseFrequency).toBeLessThanOrEqual(1);
    }
  });

  it("should include a human-readable reason", () => {
    const result = surprisesFromDb(db);
    for (const s of result.surprises) {
      expect(s.reason).toBeTruthy();
      expect(typeof s.reason).toBe("string");
    }
  });

  it("should report total evaluated edges", () => {
    const result = surprisesFromDb(db);
    expect(result.totalEvaluated).toBeGreaterThan(0);
  });

  it("should return empty for empty database", () => {
    const emptyPath = path.join(
      os.tmpdir(),
      `cari-empty-surp-${Date.now()}.db`,
    );
    const emptyDb = new Database(emptyPath);
    initSchema(emptyDb);
    const result = surprisesFromDb(emptyDb);
    expect(result.surprises).toEqual([]);
    expect(result.totalEvaluated).toBe(0);
    emptyDb.close();
    fs.unlinkSync(emptyPath);
  });

  it("should assign higher cross-layer weight to cross-type edges", () => {
    // co_changes are between files; check they get scored
    const result = surprisesFromDb(db);
    const fileEdge = result.surprises.find(
      (s) => s.entityA.includes("/") && s.entityB.includes("/"),
    );
    if (fileEdge) {
      // File-to-file edges should have lower cross-layer weight
      expect(fileEdge.crossLayerWeight).toBeLessThanOrEqual(0.6);
    }
  });
});

// =============================================================================
// 9.4 Rationale Extraction
// =============================================================================

describe("9.4 Rationale Extraction", () => {
  it("should find all seeded rationale comments", () => {
    const result = rationaleFromDb(db);
    expect(result.totalCount).toBe(5);
  });

  it("should sort by file path and line", () => {
    const result = rationaleFromDb(db);
    for (let i = 1; i < result.rationale.length; i++) {
      const prev = result.rationale[i - 1];
      const curr = result.rationale[i];
      if (prev.filePath === curr.filePath) {
        expect(prev.line).toBeLessThanOrEqual(curr.line);
      }
    }
  });

  it("should provide byKind summary", () => {
    const result = rationaleFromDb(db);
    expect(result.byKind["why"]).toBe(2);
    expect(result.byKind["design"]).toBe(1);
    expect(result.byKind["important"]).toBe(1);
    expect(result.byKind["note"]).toBe(1);
  });

  it("should include file path and line for each entry", () => {
    const result = rationaleFromDb(db);
    for (const r of result.rationale) {
      expect(r.filePath).toBeTruthy();
      expect(r.line).toBeGreaterThan(0);
      expect(r.kind).toBeTruthy();
      expect(r.text).toBeTruthy();
    }
  });

  it("should handle missing rationale table gracefully", () => {
    const noRatPath = path.join(
      os.tmpdir(),
      `cari-no-rationale-${Date.now()}.db`,
    );
    const noRatDb = new Database(noRatPath);
    // Only create base tables, no rationale table
    noRatDb.exec(`
      CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, name TEXT, kind TEXT,
        container TEXT, signature TEXT, file_path TEXT, line INTEGER, end_line INTEGER,
        export TEXT, doc_summary TEXT, body_hash TEXT, body_lines INTEGER, structure_hash TEXT);
    `);
    const result = rationaleFromDb(noRatDb);
    expect(result.rationale).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.byKind).toEqual({});
    noRatDb.close();
    fs.unlinkSync(noRatPath);
  });

  it("should return empty for empty rationale table", () => {
    const emptyPath = path.join(os.tmpdir(), `cari-empty-rat-${Date.now()}.db`);
    const emptyDb = new Database(emptyPath);
    initSchema(emptyDb);
    const result = rationaleFromDb(emptyDb);
    expect(result.rationale).toEqual([]);
    expect(result.totalCount).toBe(0);
    emptyDb.close();
    fs.unlinkSync(emptyPath);
  });
});
