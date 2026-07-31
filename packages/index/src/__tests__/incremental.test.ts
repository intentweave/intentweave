// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "@intentweave/sqlite-compat";
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

function makeAxOutput(symbols: AxSymbol[], filePath = "src/foo.ts"): AxOutput {
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
    fs.writeFileSync(path.join(tmpDir, "docs/README.md"), "# Updated", "utf-8");

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
    db.prepare(
      `
      INSERT INTO symbols (id, name, kind, file_path, line, export)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run("sym1", "doSomething", "function", "src/foo.ts", 10, "exported");
    db.close();

    const changes: FileChange[] = [
      { path: "src/foo.ts", status: "deleted", isDoc: false },
    ];

    const result = applyChanges(
      dbPath,
      changes,
      {},
      {
        dbPath,
        workspaceRoot: tmpDir,
      },
    );

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
    db.prepare(
      `
      INSERT INTO annotations (doc_path, line, text, confidence, source)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run("docs/README.md", 1, "doSomething", 0.9, "code-span");
    db.close();

    const changes: FileChange[] = [
      { path: "docs/README.md", status: "deleted", isDoc: true },
    ];

    const result = applyChanges(
      dbPath,
      changes,
      {},
      {
        dbPath,
        workspaceRoot: tmpDir,
      },
    );

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

    const result = applyChanges(
      dbPath,
      changes,
      { ax },
      {
        dbPath,
        workspaceRoot: tmpDir,
      },
    );

    expect(result.updated.symbols).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM symbols").all();
    db.close();
    expect(rows).toHaveLength(1);
  });

  it("does not duplicate symbol_calls for unchanged files across repeated updates (regression)", () => {
    // Simulate the real CLI flow: `iw index update` re-runs AX on the WHOLE
    // workspace (not just the delta) to detect changes, then passes that
    // full-workspace AxOutput into applyChanges — even though only one file
    // actually changed. applyChanges must scope symbol/call inserts to the
    // changed files only, or unchanged files' calls get re-appended (doubled)
    // on every single update.
    const dbPath = makeDbWithFiles(tmpDir, [
      {
        path: "src/foo.ts",
        content: "export function doSomething() {}",
        isDoc: false,
      },
      {
        path: "src/bar.ts",
        content: "export function doOther() {}",
        isDoc: false,
      },
    ]);

    const fullAx: AxOutput = {
      version: "1.0",
      workspaceRoot: tmpDir,
      extractedAt: Date.now(),
      totalFiles: 2,
      totalSymbols: 2,
      files: [
        {
          filePath: "src/foo.ts",
          contentHash: "hash-foo-v2",
          language: "typescript",
          symbols: [makeSymbol({ id: "impl:src/foo.ts#function:doSomething" })],
          calls: [
            {
              callerName: "doSomething",
              callerLine: 1,
              calleeName: "helper",
              calleeId: null,
              isMethod: false,
            },
          ],
          extractedAt: Date.now(),
        },
        {
          filePath: "src/bar.ts",
          contentHash: "hash-bar-unchanged",
          language: "typescript",
          symbols: [
            makeSymbol({
              id: "impl:src/bar.ts#function:doOther",
              name: "doOther",
              filePath: "src/bar.ts",
            }),
          ],
          calls: [
            {
              callerName: "doOther",
              callerLine: 1,
              calleeName: "otherHelper",
              calleeId: null,
              isMethod: false,
            },
          ],
          extractedAt: Date.now(),
        },
      ],
      stats: { byKind: {}, exported: 2, internal: 0 },
    } as AxOutput;

    // Only foo.ts actually changed; bar.ts is unchanged (not in `changes`).
    const changes: FileChange[] = [
      { path: "src/foo.ts", status: "modified", isDoc: false },
    ];

    // Run the update twice in a row, exactly as `iw index update` would if
    // invoked back-to-back with no further edits (foo.ts keeps "changing"
    // each time in this test only to keep triggering the code path; the key
    // assertion is that bar.ts — never in `changes` — does not accumulate).
    applyChanges(
      dbPath,
      changes,
      { ax: fullAx },
      { dbPath, workspaceRoot: tmpDir },
    );
    applyChanges(
      dbPath,
      changes,
      { ax: fullAx },
      { dbPath, workspaceRoot: tmpDir },
    );

    const db = new Database(dbPath, { readonly: true });
    const fooCalls = db
      .prepare("SELECT * FROM symbol_calls WHERE caller_file = ?")
      .all("src/foo.ts");
    const barCalls = db
      .prepare("SELECT * FROM symbol_calls WHERE caller_file = ?")
      .all("src/bar.ts");
    db.close();

    // foo.ts was deleted+reinserted each time -> exactly 1 row (not doubled)
    expect(fooCalls).toHaveLength(1);
    // bar.ts was never in `changes` -> must stay at 0, never touched/duplicated
    expect(barCalls).toHaveLength(0);
  });

  it("refreshes imports/todos/rationale/property_accesses/type_assertions/test_descriptions/variable_assignments/def_use_chains for changed files without duplicating unchanged files (regression)", () => {
    // Same full-workspace-AX-rescan scenario as the symbol_calls regression
    // above, but covering every other per-file AX-derived table that
    // `applyChanges` previously left completely untouched (silently going
    // stale for changed files, since nothing ever deleted+reinserted them).
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "src/foo.ts", content: "// old content", isDoc: false },
      { path: "src/bar.ts", content: "// unchanged content", isDoc: false },
    ]);

    // Seed pre-existing rows for BOTH files, simulating a prior full build.
    const seedDb = new Database(dbPath);
    for (const file of ["src/foo.ts", "src/bar.ts"]) {
      seedDb
        .prepare(
          `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names) VALUES (?, NULL, ?, 0, '[]')`,
        )
        .run(file, "old-module");
      seedDb
        .prepare(
          `INSERT INTO todos (file_path, line, kind, text) VALUES (?, 1, 'todo', 'old todo')`,
        )
        .run(file);
      seedDb
        .prepare(
          `INSERT INTO rationale (file_path, line, kind, text, symbol) VALUES (?, 1, 'why', 'old rationale', NULL)`,
        )
        .run(file);
      seedDb
        .prepare(
          `INSERT INTO property_accesses (file, symbol_name, line, chain, root, depth) VALUES (?, NULL, 1, 'old.chain.here', 'old', 3)`,
        )
        .run(file);
      seedDb
        .prepare(
          `INSERT INTO type_assertions (file, line, kind, context, target_type) VALUES (?, 1, 'as_any', NULL, NULL)`,
        )
        .run(file);
      seedDb
        .prepare(
          `INSERT INTO test_descriptions (file, line, kind, description) VALUES (?, 1, 'it', 'old test')`,
        )
        .run(file);
      seedDb
        .prepare(
          `INSERT INTO variable_assignments (file, line, symbol_name, value_text, context) VALUES (?, 1, 'x', 'old', NULL)`,
        )
        .run(file);
      seedDb
        .prepare(
          `INSERT INTO def_use_chains (file, function, def_line, var_name, use_line, use_context) VALUES (?, NULL, 1, 'x', 2, 'old')`,
        )
        .run(file);
    }
    seedDb.close();

    const fullAx: AxOutput = {
      version: "1.0",
      workspaceRoot: tmpDir,
      extractedAt: Date.now(),
      totalFiles: 2,
      totalSymbols: 0,
      files: [
        {
          filePath: "src/foo.ts",
          contentHash: "hash-foo-v2",
          language: "typescript",
          symbols: [],
          imports: [
            {
              moduleSpecifier: "./new-module",
              resolvedPath: "src/new-module.ts",
              isRelative: true,
              importedNames: ["x"],
            },
          ],
          todos: [{ line: 5, kind: "todo", text: "new todo" }],
          rationale: [{ line: 6, kind: "why", text: "new rationale" }],
          propertyAccesses: [
            {
              symbolName: null,
              line: 7,
              chain: "new.chain.here",
              root: "new",
              depth: 3,
            },
          ],
          typeAssertions: [
            { line: 8, kind: "as_any", context: null, targetType: null },
          ],
          testDescriptions: [{ line: 9, kind: "it", description: "new test" }],
          variableAssignments: [
            { line: 10, symbolName: "y", valueText: "new", context: null },
          ],
          defUseChains: [
            {
              functionName: null,
              defLine: 11,
              varName: "y",
              useLine: 12,
              useContext: "new",
            },
          ],
          extractedAt: Date.now(),
        },
        {
          filePath: "src/bar.ts",
          contentHash: "hash-bar-unchanged",
          language: "typescript",
          symbols: [],
          imports: [
            {
              moduleSpecifier: "./bar-module",
              resolvedPath: "src/bar-module.ts",
              isRelative: true,
              importedNames: ["z"],
            },
          ],
          todos: [{ line: 1, kind: "todo", text: "bar todo" }],
          rationale: [{ line: 1, kind: "why", text: "bar rationale" }],
          propertyAccesses: [
            {
              symbolName: null,
              line: 1,
              chain: "bar.chain.here",
              root: "bar",
              depth: 3,
            },
          ],
          typeAssertions: [
            { line: 1, kind: "as_any", context: null, targetType: null },
          ],
          testDescriptions: [{ line: 1, kind: "it", description: "bar test" }],
          variableAssignments: [
            { line: 1, symbolName: "b", valueText: "bar", context: null },
          ],
          defUseChains: [
            {
              functionName: null,
              defLine: 1,
              varName: "b",
              useLine: 2,
              useContext: "bar",
            },
          ],
          extractedAt: Date.now(),
        },
      ],
      stats: { byKind: {}, exported: 0, internal: 0 },
    } as unknown as AxOutput;

    // Only foo.ts actually changed; bar.ts is unchanged (not in `changes`).
    const changes: FileChange[] = [
      { path: "src/foo.ts", status: "modified", isDoc: false },
    ];

    applyChanges(
      dbPath,
      changes,
      { ax: fullAx },
      { dbPath, workspaceRoot: tmpDir },
    );

    const db = new Database(dbPath, { readonly: true });
    const tables = [
      ["imports", "source_file"],
      ["todos", "file_path"],
      ["rationale", "file_path"],
      ["property_accesses", "file"],
      ["type_assertions", "file"],
      ["test_descriptions", "file"],
      ["variable_assignments", "file"],
      ["def_use_chains", "file"],
    ] as const;

    for (const [table, col] of tables) {
      const fooRows = db
        .prepare(`SELECT * FROM ${table} WHERE ${col} = ?`)
        .all("src/foo.ts") as any[];
      const barRows = db
        .prepare(`SELECT * FROM ${table} WHERE ${col} = ?`)
        .all("src/bar.ts") as any[];

      // foo.ts: old row replaced by the new one (exactly 1, not appended)
      expect(fooRows, `${table} for changed file src/foo.ts`).toHaveLength(1);
      // bar.ts: untouched — still exactly the original seeded row, not
      // duplicated and not deleted
      expect(barRows, `${table} for unchanged file src/bar.ts`).toHaveLength(1);
    }
    db.close();
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
    db.prepare(
      `
      INSERT INTO annotations (doc_path, line, text, confidence, source)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run("docs/README.md", 1, "oldMention", 0.8, "bold");
    db.close();

    // Modify file
    fs.writeFileSync(path.join(tmpDir, "docs/README.md"), "# Updated", "utf-8");

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

    const result = applyChanges(
      dbPath,
      [],
      {},
      {
        dbPath,
        workspaceRoot: tmpDir,
      },
    );

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.changes).toEqual([]);
    expect(result.updated).toEqual({
      symbols: 0,
      annotations: 0,
      coOccurrences: 0,
      files: 0,
      imports: 0,
      todos: 0,
      rationale: 0,
      propertyAccesses: 0,
      typeAssertions: 0,
      testDescriptions: 0,
      variableAssignments: 0,
      defUseChains: 0,
    });
  });

  it("handles large co-occurrence deletion via batching", () => {
    // Regression test: >500 co-occurrences should be batched to avoid
    // exceeding SQLITE_MAX_VARIABLE_NUMBER (999).
    const dbPath = makeDbWithFiles(tmpDir, [
      { path: "docs/README.md", content: "# Hello", isDoc: true },
    ]);

    const db = new Database(dbPath);
    // Insert 600 co-occurrence rows referencing the doc file
    const insert = db.prepare(`
      INSERT INTO co_occurrences (entity_a, entity_b, count, score, source, file_paths)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const txn = db.transaction(() => {
      for (let i = 0; i < 600; i++) {
        insert.run(
          `entityA_${i}`,
          `entityB_${i}`,
          1,
          0.5,
          "doc_cooc",
          '["docs/README.md"]',
        );
      }
    });
    txn();
    db.close();

    // Modify the file
    fs.writeFileSync(path.join(tmpDir, "docs/README.md"), "# Updated", "utf-8");

    const changes: FileChange[] = [
      { path: "docs/README.md", status: "modified", isDoc: true },
    ];

    // Pass an empty cox result so the co-occurrence deletion path is triggered
    const cox = {
      $schema: "intentweave://schemas/cox/v1" as const,
      stage: "COX" as const,
      edges: [],
      meta: {
        edgeCount: 0,
        pairsConsidered: 0,
        windowType: "document",
        processingTimeMs: 0,
      },
    };

    // Should not throw (previously crashed with >999 SQL variables)
    const result = applyChanges(
      dbPath,
      changes,
      { cox },
      { dbPath, workspaceRoot: tmpDir },
    );

    expect(result.updated.files).toBe(1);

    // Verify co-occurrences for that file were deleted
    const db2 = new Database(dbPath, { readonly: true });
    const remaining = db2
      .prepare(
        "SELECT COUNT(*) AS cnt FROM co_occurrences WHERE source = 'doc_cooc'",
      )
      .get() as { cnt: number };
    db2.close();
    expect(remaining.cnt).toBe(0);
  });
});
