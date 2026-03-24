// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { initSchema } from "../schema.js";
import { detectChanges, applyChanges, hashFile } from "../incremental.js";
import type { FileChange } from "../incremental.js";
import type { AxOutput, AxSymbol } from "@intentweave/analyzer";
import type { Annotation } from "../types.js";

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

function setupTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cari-incr-"));
  return dir;
}

function makeDbWithFiles(
  dir: string,
  fileEntries: Array<{ path: string; content: string; isDoc: boolean }>,
): string {
  const dbPath = path.join(dir, "test.db");
  const db = new Database(dbPath);
  initSchema(db);

  const stmt = db.prepare(`
    INSERT INTO files (path, is_doc, content_hash) VALUES (?, ?, ?)
  `);

  for (const entry of fileEntries) {
    // Write actual file to disk
    const absPath = path.join(dir, entry.path);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, entry.content, "utf-8");

    // Record in DB with matching hash
    const hash = hashFile(absPath);
    stmt.run(entry.path, entry.isDoc ? 1 : 0, hash);
  }

  db.close();
  return dbPath;
}

function makeSymbol(overrides: Partial<AxSymbol> = {}): AxSymbol {
  return {
    id: "impl:src/foo.ts#function:doSomething",
    kind: "function",
    name: "doSomething",
    filePath: "src/foo.ts",
    span: { startLine: 10, startCol: 0, endLine: 20, endCol: 1 },
    export: "exported",
    ...overrides,
  };
}

function makeAxOutput(
  symbols: AxSymbol[],
  filePath = "src/foo.ts",
): AxOutput {
  return {
    version: "1.0",
    workspaceRoot: tmpDir,
    extractedAt: Date.now(),
    totalFiles: 1,
    totalSymbols: symbols.length,
    files: [
      {
        filePath,
        contentHash: "abc12345",
        language: "typescript",
        symbols,
        extractedAt: Date.now(),
      },
    ],
    stats: { byKind: {}, exported: symbols.length, internal: 0 },
  };
}

// =============================================================================
// Tests: hashFile
// =============================================================================

describe("hashFile", () => {
  beforeEach(() => {
    tmpDir = setupTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 16 hex chars", () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello world", "utf-8");
    const hash = hashFile(file);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is deterministic", () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello world", "utf-8");
    expect(hashFile(file)).toBe(hashFile(file));
  });

  it("differs for different content", () => {
    const file1 = path.join(tmpDir, "a.txt");
    const file2 = path.join(tmpDir, "b.txt");
    fs.writeFileSync(file1, "hello", "utf-8");
    fs.writeFileSync(file2, "world", "utf-8");
    expect(hashFile(file1)).not.toBe(hashFile(file2));
  });
});

// =============================================================================
// Tests: detectChanges
// =============================================================================

describe("detectChanges", () => {
  beforeEach(() => {
    tmpDir = setupTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when nothing changed", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/README.md", content: "# Hello", isDoc: true },
      { path: "src/foo.ts", content: "export const x = 1;", isDoc: false },
    ]);

    const currentFiles = [
      path.join(tmpDir, "docs/README.md"),
      path.join(tmpDir, "src/foo.ts"),
    ];

    const changes = detectChanges(dbPath, tmpDir, currentFiles);
    expect(changes).toHaveLength(0);
  });

  it("detects modified files", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/README.md", content: "# Hello", isDoc: true },
    ]);

    // Modify the file content
    fs.writeFileSync(
      path.join(tmpDir, "docs/README.md"),
      "# Updated",
      "utf-8",
    );

    const changes = detectChanges(dbPath, tmpDir, [
      path.join(tmpDir, "docs/README.md"),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      path: "docs/README.md",
      status: "modified",
      isDoc: true,
    });
  });

  it("detects added files", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/README.md", content: "# Hello", isDoc: true },
    ]);

    // Create a new file on disk
    const newFile = path.join(tmpDir, "docs/GUIDE.md");
    fs.writeFileSync(newFile, "# Guide", "utf-8");

    const changes = detectChanges(dbPath, tmpDir, [
      path.join(tmpDir, "docs/README.md"),
      newFile,
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      path: "docs/GUIDE.md",
      status: "added",
      isDoc: true,
    });
  });

  it("detects deleted files", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/README.md", content: "# Hello", isDoc: true },
      { path: "docs/OLD.md", content: "# Old", isDoc: true },
    ]);

    // Only pass the README as "current" — OLD.md is implicitly deleted
    const changes = detectChanges(dbPath, tmpDir, [
      path.join(tmpDir, "docs/README.md"),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      path: "docs/OLD.md",
      status: "deleted",
      isDoc: true,
    });
  });

  it("classifies code files correctly", () => {
    const dbPath = makeDbWithFiles(tmpDir, []);

    const newFile = path.join(tmpDir, "src/app.ts");
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(newFile, "const x = 1;", "utf-8");

    const changes = detectChanges(dbPath, tmpDir, [newFile]);
    expect(changes).toHaveLength(1);
    expect(changes[0].isDoc).toBe(false);
  });

  it("handles mixed changes", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/A.md", content: "# A", isDoc: true },
      { path: "docs/B.md", content: "# B", isDoc: true },
      { path: "src/old.ts", content: "export {};", isDoc: false },
    ]);

    // Modify A, delete old.ts (by not including it), add C.md
    fs.writeFileSync(path.join(tmpDir, "docs/A.md"), "# Modified A", "utf-8");
    const newFile = path.join(tmpDir, "docs/C.md");
    fs.writeFileSync(newFile, "# C", "utf-8");

    const changes = detectChanges(dbPath, tmpDir, [
      path.join(tmpDir, "docs/A.md"),
      path.join(tmpDir, "docs/B.md"),
      newFile,
    ]);

    const byStatus = new Map<string, FileChange[]>();
    for (const c of changes) {
      const list = byStatus.get(c.status) ?? [];
      list.push(c);
      byStatus.set(c.status, list);
    }

    expect(byStatus.get("modified")).toHaveLength(1);
    expect(byStatus.get("added")).toHaveLength(1);
    expect(byStatus.get("deleted")).toHaveLength(1);
  });
});

// =============================================================================
// Tests: applyChanges
// =============================================================================

describe("applyChanges", () => {
  beforeEach(() => {
    tmpDir = setupTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes symbols for removed code files", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "src/foo.ts", content: "export const x = 1;", isDoc: false },
    ]);

    // Seed a symbol in the DB
    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO symbols (id, name, kind, file_path, line, export)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("sym1", "doSomething", "function", "src/foo.ts", 10, "exported");
    db.close();

    const changes: FileChange[] = [
      { path: "src/foo.ts", status: "deleted", isDoc: false },
    ];

    const result = applyChanges(dbPath, changes, {}, {
      dbPath,
      workspaceRoot: tmpDir,
    });

    expect(result.updated.files).toBe(1);

    // Verify symbol was deleted
    const db2 = new Database(dbPath, { readonly: true });
    const rows = db2
      .prepare("SELECT * FROM symbols WHERE file_path = ?")
      .all("src/foo.ts");
    db2.close();
    expect(rows).toHaveLength(0);
  });

  it("deletes annotations for removed doc files", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/README.md", content: "# Hello", isDoc: true },
    ]);

    // Seed an annotation
    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO annotations (doc_path, line, text, confidence, source)
      VALUES (?, ?, ?, ?, ?)
    `).run("docs/README.md", 1, "doSomething", 0.9, "code-span");
    db.close();

    const changes: FileChange[] = [
      { path: "docs/README.md", status: "deleted", isDoc: true },
    ];

    const result = applyChanges(dbPath, changes, {}, {
      dbPath,
      workspaceRoot: tmpDir,
    });

    expect(result.updated.files).toBe(1);

    const db2 = new Database(dbPath, { readonly: true });
    const rows = db2
      .prepare("SELECT * FROM annotations WHERE doc_path = ?")
      .all("docs/README.md");
    db2.close();
    expect(rows).toHaveLength(0);
  });

  it("inserts new symbols for added code files", () => {
    const dbPath = makeDbWithFiles(tmpDir, []);

    // Create file on disk
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src/foo.ts"),
      "export function doSomething() {}",
      "utf-8",
    );

    const sym = makeSymbol();
    const ax = makeAxOutput([sym]);

    const changes: FileChange[] = [
      { path: "src/foo.ts", status: "added", isDoc: false },
    ];

    const result = applyChanges(dbPath, changes, { ax }, {
      dbPath,
      workspaceRoot: tmpDir,
    });

    expect(result.updated.symbols).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM symbols").all();
    db.close();
    expect(rows).toHaveLength(1);
  });

  it("inserts new annotations for changed doc files", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/README.md", content: "# Hello", isDoc: true },
    ]);

    // Modify file
    fs.writeFileSync(
      path.join(tmpDir, "docs/README.md"),
      "# Updated\n\nMentions doSomething",
      "utf-8",
    );

    const annotations: Annotation[] = [
      {
        docPath: "docs/README.md",
        line: 3,
        text: "doSomething",
        symbolId: null,
        confidence: 0.95,
        source: "code-span",
      },
    ];

    const changes: FileChange[] = [
      { path: "docs/README.md", status: "modified", isDoc: true },
    ];

    const result = applyChanges(
      dbPath,
      changes,
      { annotations },
      { dbPath, workspaceRoot: tmpDir },
    );

    expect(result.updated.annotations).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM annotations").all();
    db.close();
    expect(rows).toHaveLength(1);
  });

  it("clears old annotations before inserting new ones for modified docs", () => {
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/README.md", content: "# Hello", isDoc: true },
    ]);

    // Seed old annotation
    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO annotations (doc_path, line, text, confidence, source)
      VALUES (?, ?, ?, ?, ?)
    `).run("docs/README.md", 1, "oldMention", 0.8, "bold");
    db.close();

    // Modify file
    fs.writeFileSync(
      path.join(tmpDir, "docs/README.md"),
      "# Updated",
      "utf-8",
    );

    const annotations: Annotation[] = [
      {
        docPath: "docs/README.md",
        line: 1,
        text: "newMention",
        symbolId: null,
        confidence: 0.7,
        source: "heading",
      },
    ];

    const changes: FileChange[] = [
      { path: "docs/README.md", status: "modified", isDoc: true },
    ];

    applyChanges(
      dbPath,
      changes,
      { annotations },
      { dbPath, workspaceRoot: tmpDir },
    );

    const db2 = new Database(dbPath, { readonly: true });
    const rows = db2.prepare("SELECT * FROM annotations").all() as any[];
    db2.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("newMention");
  });

  it("updates _meta.last_updated timestamp", () => {
    const dbPath = makeDbWithFiles(tmpDir, []);

    applyChanges(dbPath, [], {}, { dbPath, workspaceRoot: tmpDir });

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT value FROM _meta WHERE key = 'last_updated'")
      .get() as any;
    db.close();

    expect(row).toBeTruthy();
    expect(row.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns duration and change summary", () => {
    const dbPath = makeDbWithFiles(tmpDir, []);

    const result = applyChanges(dbPath, [], {}, {
      dbPath,
      workspaceRoot: tmpDir,
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.changes).toEqual([]);
    expect(result.updated).toEqual({
      symbols: 0,
      annotations: 0,
      coOccurrences: 0,
      files: 0,
    });
  });
});
