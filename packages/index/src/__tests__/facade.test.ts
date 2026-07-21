// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the CariIndex facade (packages/index/src/facade.ts).
 *
 * Covers:
 * - File discovery utilities (DEFAULT_EXCLUDES, loadIwIgnore, buildExcludeList, isExcluded, discoverFiles)
 * - CariIndex.load() factory
 * - All 14 typed query methods via CariIndex instance
 * - CariIndex.close() lifecycle
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import Database from "@intentweave/sqlite-compat";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { minimatch } from "minimatch";
import { initSchema } from "../schema.js";
import {
  CariIndex,
  DEFAULT_EXCLUDES,
  loadIwIgnore,
  buildExcludeList,
  isExcluded,
  discoverFiles,
} from "../facade.js";

// =============================================================================
// File Discovery Utilities
// =============================================================================

describe("File discovery utilities", () => {
  describe("DEFAULT_EXCLUDES", () => {
    it("excludes common directories", () => {
      expect(DEFAULT_EXCLUDES).toContain("**/node_modules/**");
      expect(DEFAULT_EXCLUDES).toContain("**/dist/**");
      expect(DEFAULT_EXCLUDES).toContain("**/.git/**");
      expect(DEFAULT_EXCLUDES).toContain("**/.iw/**");
    });

    it("is an array of glob patterns", () => {
      expect(Array.isArray(DEFAULT_EXCLUDES)).toBe(true);
      expect(DEFAULT_EXCLUDES.length).toBeGreaterThan(0);
      for (const p of DEFAULT_EXCLUDES) {
        expect(typeof p).toBe("string");
        expect(p).toContain("**");
      }
    });
  });

  describe("loadIwIgnore", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "facade-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns empty array when .iwignore does not exist", async () => {
      const result = await loadIwIgnore(tmpDir);
      expect(result).toEqual([]);
    });

    it("parses .iwignore file with comments and blanks", async () => {
      const content = [
        "# Comment line",
        "docs/internal/**",
        "",
        "*.draft.md",
        "  # Indented comment  ",
        "  build/output/**  ",
        "",
      ].join("\n");

      fs.writeFileSync(path.join(tmpDir, ".iwignore"), content);

      const result = await loadIwIgnore(tmpDir);
      expect(result).toEqual([
        "docs/internal/**",
        "*.draft.md",
        "build/output/**",
      ]);
    });

    it("handles single-line .iwignore", async () => {
      fs.writeFileSync(path.join(tmpDir, ".iwignore"), "secret/**\n");
      const result = await loadIwIgnore(tmpDir);
      expect(result).toEqual(["secret/**"]);
    });
  });

  describe("buildExcludeList", () => {
    it("combines defaults, .iwignore, and cli excludes", () => {
      const result = buildExcludeList(
        ["custom/**"],
        ["from-iwignore/**"],
        true,
      );
      expect(result).toContain("**/node_modules/**"); // defaults
      expect(result).toContain("from-iwignore/**"); // iwignore
      expect(result).toContain("custom/**"); // cli
    });

    it("skips defaults when useDefaults=false", () => {
      const result = buildExcludeList(["custom/**"], [], false);
      expect(result).toEqual(["custom/**"]);
      expect(result).not.toContain("**/node_modules/**");
    });

    it("handles empty inputs", () => {
      const result = buildExcludeList([], [], true);
      expect(result).toEqual(DEFAULT_EXCLUDES);
    });
  });

  describe("isExcluded", () => {
    it("returns false when patterns are empty", () => {
      expect(isExcluded("src/file.ts", [], minimatch)).toBe(false);
    });

    it("returns false when minimatchFn is null", () => {
      expect(isExcluded("src/file.ts", ["**/*.ts"], null)).toBe(false);
    });

    it("matches a simple glob pattern", () => {
      expect(
        isExcluded(
          "node_modules/foo/bar.js",
          ["**/node_modules/**"],
          minimatch,
        ),
      ).toBe(true);
    });

    it("does not match unrelated paths", () => {
      expect(
        isExcluded("src/utils/helpers.ts", ["**/node_modules/**"], minimatch),
      ).toBe(false);
    });

    it("matches dot files with dot option", () => {
      expect(isExcluded(".iw/index.db", ["**/.iw/**"], minimatch)).toBe(true);
    });
  });

  describe("discoverFiles", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "facade-discover-"));
      // Create directory structure
      fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "node_modules", "pkg"), {
        recursive: true,
      });

      // Create files
      fs.writeFileSync(path.join(tmpDir, "docs", "readme.md"), "# Docs");
      fs.writeFileSync(path.join(tmpDir, "docs", "api.md"), "# API");
      fs.writeFileSync(path.join(tmpDir, "docs", "notes.txt"), "Notes");
      fs.writeFileSync(path.join(tmpDir, "src", "main.ts"), "// ts");
      fs.writeFileSync(
        path.join(tmpDir, "node_modules", "pkg", "README.md"),
        "# Pkg",
      );
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("discovers .md and .txt files from a directory", async () => {
      const files = await discoverFiles([path.join(tmpDir, "docs")], tmpDir);
      const names = files.map((f) => path.basename(f));
      expect(names).toContain("readme.md");
      expect(names).toContain("api.md");
      expect(names).toContain("notes.txt");
    });

    it("ignores non-document files", async () => {
      const files = await discoverFiles([path.join(tmpDir, "src")], tmpDir);
      expect(files).toHaveLength(0); // .ts is not a supported extension
    });

    it("skips node_modules by directory name", async () => {
      const files = await discoverFiles([tmpDir], tmpDir);
      const paths = files.map((f) => path.relative(tmpDir, f));
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    });

    it("applies exclude patterns", async () => {
      const files = await discoverFiles([path.join(tmpDir, "docs")], tmpDir, {
        exclude: ["docs/api.md"],
      });
      const names = files.map((f) => path.basename(f));
      expect(names).not.toContain("api.md");
      expect(names).toContain("readme.md");
    });

    it("applies include patterns", async () => {
      const files = await discoverFiles([path.join(tmpDir, "docs")], tmpDir, {
        include: ["**/*.txt"],
      });
      const names = files.map((f) => path.basename(f));
      expect(names).toEqual(["notes.txt"]);
    });

    it("returns sorted, deduplicated results", async () => {
      const files = await discoverFiles(
        [path.join(tmpDir, "docs"), path.join(tmpDir, "docs")],
        tmpDir,
      );
      // Should deduplicate
      const names = files.map((f) => path.basename(f));
      const uniqueNames = [...new Set(names)];
      expect(names.length).toBe(uniqueNames.length);
      // Should be sorted
      const sorted = [...files].sort();
      expect(files).toEqual(sorted);
    });

    it("handles non-existent paths gracefully", async () => {
      const files = await discoverFiles(
        [path.join(tmpDir, "nonexistent")],
        tmpDir,
      );
      expect(files).toEqual([]);
    });
  });

  describe("discoverFiles with includeAllFiles", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "facade-discover-all-"));
      fs.mkdirSync(path.join(tmpDir, "config"), { recursive: true });

      fs.writeFileSync(path.join(tmpDir, "config", "readme.md"), "# Docs");
      fs.writeFileSync(
        path.join(tmpDir, "config", "settings.json"),
        '{"key": "value"}',
      );
      fs.writeFileSync(
        path.join(tmpDir, "config", "settings.yaml"),
        "key: value",
      );
      fs.writeFileSync(path.join(tmpDir, "config", "logo.png"), "\x89PNG\r\n");
      // Unrecognized extension whose content sniffs as binary (NUL byte)
      fs.writeFileSync(
        path.join(tmpDir, "config", "data.bin2"),
        Buffer.from([0x00, 0x01, 0x02]),
      );
      // Unrecognized extension whose content sniffs as text
      fs.writeFileSync(path.join(tmpDir, "config", "notes.cfg"), "a=1\nb=2\n");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("does not discover non-doc files by default", async () => {
      const files = await discoverFiles([path.join(tmpDir, "config")], tmpDir);
      const names = files.map((f) => path.basename(f)).sort();
      expect(names).toEqual(["readme.md"]);
    });

    it("discovers non-binary files when includeAllFiles is true", async () => {
      const files = await discoverFiles([path.join(tmpDir, "config")], tmpDir, {
        includeAllFiles: true,
      });
      const names = files.map((f) => path.basename(f)).sort();
      expect(names).toEqual([
        "notes.cfg",
        "readme.md",
        "settings.json",
        "settings.yaml",
      ]);
    });

    it("excludes files with known-binary extensions even with includeAllFiles", async () => {
      const files = await discoverFiles([path.join(tmpDir, "config")], tmpDir, {
        includeAllFiles: true,
      });
      const names = files.map((f) => path.basename(f));
      expect(names).not.toContain("logo.png");
    });

    it("excludes unrecognized extensions that sniff as binary content", async () => {
      const files = await discoverFiles([path.join(tmpDir, "config")], tmpDir, {
        includeAllFiles: true,
      });
      const names = files.map((f) => path.basename(f));
      expect(names).not.toContain("data.bin2");
    });

    it("excludes newly-included files larger than maxFileSize", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "config", "huge.cfg"),
        "x".repeat(1000),
      );
      const files = await discoverFiles([path.join(tmpDir, "config")], tmpDir, {
        includeAllFiles: true,
        maxFileSize: 100,
      });
      const names = files.map((f) => path.basename(f));
      expect(names).not.toContain("huge.cfg");
      // .md files are unaffected by the maxFileSize cap for generic files
      expect(names).toContain("readme.md");
    });
  });
});

// =============================================================================
// CariIndex class
// =============================================================================

describe("CariIndex", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `cari-facade-test-${Date.now()}.db`);
    db = new Database(dbPath);
    initSchema(db);
    seedFixtures(db);
    db.close();
  });

  afterAll(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  describe("load()", () => {
    it("opens an existing database", () => {
      const idx = CariIndex.load(dbPath);
      expect(idx).toBeInstanceOf(CariIndex);
      expect(idx.dbPath).toBe(dbPath);
      idx.close();
    });

    it("throws for non-existent database", () => {
      expect(() => CariIndex.load("/tmp/nonexistent-db-12345.db")).toThrow();
    });
  });

  describe("query methods", () => {
    let idx: CariIndex;

    beforeAll(() => {
      idx = CariIndex.load(dbPath);
    });

    afterAll(() => {
      idx.close();
    });

    // ── retrieve ──────────────────────────────────────────────

    it("retrieve() returns ranked results", () => {
      const result = idx.retrieve({ query: "AuthService" });
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files[0].path).toBeDefined();
    });

    it("retrieve() respects limit", () => {
      const result = idx.retrieve({ query: "AuthService", limit: 1 });
      expect(result.files.length).toBeLessThanOrEqual(1);
    });

    // ── connections ───────────────────────────────────────────

    it("connections() finds cross-layer connections", () => {
      const result = idx.connections({ entity: "AuthService" });
      expect(result.connections.length).toBeGreaterThan(0);
    });

    it("connections() returns gaps", () => {
      const result = idx.connections({ entity: "AuthService" });
      // Gaps may or may not exist depending on fixture data
      expect(Array.isArray(result.gaps)).toBe(true);
    });

    // ── check ─────────────────────────────────────────────────

    it("check() detects drift for changed files", () => {
      const result = idx.check({ changed: ["src/auth/service.ts"] });
      expect(result.findings).toBeDefined();
      expect(Array.isArray(result.findings)).toBe(true);
    });

    // ── report ────────────────────────────────────────────────

    it("report() returns corpus-wide statistics", () => {
      const result = idx.report();
      expect(result).toBeDefined();
      expect(typeof result.coverage.total).toBe("number");
      expect(typeof result.coverage.documented).toBe("number");
    });

    // ── clones ────────────────────────────────────────────────

    it("clones() detects exact clones", () => {
      const result = idx.clones();
      expect(result.cloneGroups.length).toBeGreaterThan(0);
      // Our fixtures have validateUser and formatDate sharing body_hash "abcd1234abcd1234"
      const hashes = result.cloneGroups.map((g) => g.bodyHash);
      expect(hashes).toContain("abcd1234abcd1234");
    });

    // ── structuralClones ──────────────────────────────────────

    it("structuralClones() detects type-2 clones", () => {
      const result = idx.structuralClones();
      expect(result.cloneGroups.length).toBeGreaterThan(0);
      // normalizeEmail and normalizePhone share structure_hash "struct_bbb"
      const structHashes = result.cloneGroups.map((g) => g.structureHash);
      expect(structHashes).toContain("struct_bbb");
    });

    // ── circularImports ───────────────────────────────────────

    it("circularImports() finds import cycles", () => {
      const result = idx.circularImports();
      expect(result.cycles.length).toBeGreaterThan(0);
      // service.ts ↔ rate.ts
      const files = result.cycles[0].files;
      expect(
        files.includes("src/auth/service.ts") ||
          files.includes("src/middleware/rate.ts"),
      ).toBe(true);
    });

    // ── unusedExports ─────────────────────────────────────────

    it("unusedExports() finds symbols never imported", () => {
      const result = idx.unusedExports();
      expect(result.unused.length).toBeGreaterThan(0);
    });

    // ── hotspotPriority ────────────────────────────────────────

    it("hotspotPriority() ranks high-churn files", () => {
      const result = idx.hotspotPriority();
      expect(result.priorities.length).toBeGreaterThan(0);
      // service.ts has churn=450 and is_hotspot=1
    });

    // ── todos ──────────────────────────────────────────────────

    it("todos() returns TODO/FIXME/HACK/XXX inventory", () => {
      const result = idx.todos();
      expect(result.todos.length).toBe(5);
      expect(result.totalCount).toBe(5);
    });

    it("todos() includes byKind breakdown", () => {
      const result = idx.todos();
      expect(result.byKind["todo"]).toBe(2);
      expect(result.byKind["fixme"]).toBe(1);
      expect(result.byKind["hack"]).toBe(1);
      expect(result.byKind["xxx"]).toBe(1);
    });

    // ── moduleCoverage ─────────────────────────────────────────

    it("moduleCoverage() returns coverage per directory", () => {
      const result = idx.moduleCoverage();
      expect(result.modules.length).toBeGreaterThan(0);
    });

    // ── orphanedSections ───────────────────────────────────────

    it("orphanedSections() finds ungrounded doc sections", () => {
      const result = idx.orphanedSections();
      // We seeded "Legacy API" heading with only ungrounded mentions
      expect(result.sections.length).toBeGreaterThan(0);
    });

    // ── docCompleteness ────────────────────────────────────────

    it("docCompleteness() returns per-doc completeness", () => {
      const result = idx.docCompleteness();
      expect(result.docs.length).toBeGreaterThan(0);
    });

    // ── crossGroupDrift ────────────────────────────────────────

    it("crossGroupDrift() detects entity coverage conflicts across groups", () => {
      const result = idx.crossGroupDrift();
      // May or may not find conflicts depending on seeded data
      expect(Array.isArray(result.drifts)).toBe(true);
    });
  });

  describe("close()", () => {
    it("releases the database connection", () => {
      const idx = CariIndex.load(dbPath);
      idx.close();
      // After close, query methods should throw
      expect(() => idx.retrieve({ query: "test" })).toThrow();
    });
  });

  describe("dbPath getter", () => {
    it("returns the path to the database", () => {
      const idx = CariIndex.load(dbPath);
      expect(idx.dbPath).toBe(dbPath);
      idx.close();
    });
  });
});

// =============================================================================
// Fixture Seeding (mirrors queries.test.ts)
// =============================================================================

function seedFixtures(db: Database.Database): void {
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

  db.transaction(() => {
    for (const s of symbols) insertSym.run(...s);
  })();

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
    // Ungrounded
    ["docs/auth.md", 60, "session management", null, 0.3, "bold", null, 0.4],
    ["docs/api.md", 80, "rate limiting", null, 0.25, "identifier", null, 0.3],
    // Orphaned section
    ["docs/auth.md", 70, "Legacy API", null, 0.5, "heading", null, 0.5],
    ["docs/auth.md", 75, "oldFunction", null, 0.3, "code-span", null, 0.4],
    ["docs/auth.md", 78, "deprecatedMethod", null, 0.3, "code-span", null, 0.4],
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

  db.transaction(() => {
    for (const c of coocs) insertCooc.run(...c);
  })();

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

  db.transaction(() => {
    for (const c of cochanges) insertCc.run(...c);
  })();

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

  db.transaction(() => {
    for (const f of files) insertFile.run(...f);
  })();

  // ── Imports ─────────────────────────────────────────────────
  const insertImport = db.prepare(`
    INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
    VALUES (?, ?, ?, ?, ?)
  `);

  const imports = [
    [
      "src/auth/service.ts",
      "src/auth/jwt.ts",
      "./jwt",
      1,
      '["signToken","verifyToken"]',
    ],
    [
      "src/auth/service.ts",
      "src/db/pool.ts",
      "../db/pool",
      1,
      '["DatabasePool"]',
    ],
    [
      "src/middleware/rate.ts",
      "src/auth/service.ts",
      "../auth/service",
      1,
      '["AuthService"]',
    ],
    [
      "src/auth/service.ts",
      "src/middleware/rate.ts",
      "../middleware/rate",
      1,
      '["RateLimiter"]',
    ],
    ["src/auth/jwt.ts", null, "jsonwebtoken", 0, '["sign","verify"]'],
    ["src/utils/logger.ts", "src/config.ts", "../config", 1, '["loadConfig"]'],
  ];

  db.transaction(() => {
    for (const i of imports) insertImport.run(...i);
  })();

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

  db.transaction(() => {
    for (const t of todoItems) insertTodo.run(...t);
  })();

  // ── Rebuild FTS ─────────────────────────────────────────────
  db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`);
}
