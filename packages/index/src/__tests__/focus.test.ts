// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for focused architecture view (cari_focus)
 */

import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { focusFromDb } from "../queries/focus.js";

// =============================================================================
// Test setup — build a small graph with imports, co-changes, co-occurrences
// =============================================================================

describe("focus", () => {
  let db: Database.Database;
  let dbPath: string;

  afterAll(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  /**
   * Architecture:
   *
   *   core/types.ts
   *   core/utils.ts
   *   analyzer/extract.ts  → core/types.ts, core/utils.ts
   *   analyzer/parse.ts    → core/types.ts
   *   server/api.ts        → analyzer/extract.ts
   *   server/routes.ts     → server/api.ts
   *   cli/main.ts          → server/routes.ts, core/types.ts
   */

  function setup(): void {
    dbPath = path.join(
      os.tmpdir(),
      `iw-focus-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new Database(dbPath);
    initSchema(db);

    const files = [
      "core/types.ts",
      "core/utils.ts",
      "analyzer/extract.ts",
      "analyzer/parse.ts",
      "server/api.ts",
      "server/routes.ts",
      "cli/main.ts",
    ];

    const insertFile = db.prepare(
      "INSERT INTO files (path, last_modified) VALUES (?, ?)",
    );
    for (const f of files) {
      insertFile.run(f, new Date().toISOString());
    }

    const insertImport = db.prepare(
      "INSERT INTO imports (source_file, target_file, module_specifier, is_relative) VALUES (?, ?, ?, ?)",
    );
    insertImport.run("analyzer/extract.ts", "core/types.ts", "./core/types", 1);
    insertImport.run("analyzer/extract.ts", "core/utils.ts", "./core/utils", 1);
    insertImport.run("analyzer/parse.ts", "core/types.ts", "./core/types", 1);
    insertImport.run(
      "server/api.ts",
      "analyzer/extract.ts",
      "../analyzer/extract",
      1,
    );
    insertImport.run("server/routes.ts", "server/api.ts", "./api", 1);
    insertImport.run("cli/main.ts", "server/routes.ts", "../server/routes", 1);
    insertImport.run("cli/main.ts", "core/types.ts", "../core/types", 1);

    // Add some symbols
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (id, name, kind, file_path, line, export)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertSymbol.run(
      "sym-typedef",
      "TypeDef",
      "type",
      "core/types.ts",
      1,
      "named",
    );
    insertSymbol.run(
      "sym-formatdate",
      "formatDate",
      "function",
      "core/utils.ts",
      5,
      "named",
    );
    insertSymbol.run(
      "sym-extract",
      "extract",
      "function",
      "analyzer/extract.ts",
      10,
      "named",
    );
    insertSymbol.run(
      "sym-parse",
      "parse",
      "function",
      "analyzer/parse.ts",
      1,
      "named",
    );
    insertSymbol.run(
      "sym-handlerequest",
      "handleRequest",
      "function",
      "server/api.ts",
      1,
      "named",
    );
    insertSymbol.run(
      "sym-setuproutes",
      "setupRoutes",
      "function",
      "server/routes.ts",
      1,
      "named",
    );
    insertSymbol.run("sym-main", "main", "function", "cli/main.ts", 1, "named");

    // Add a co-change edge
    const insertCoChange = db.prepare(
      `INSERT INTO co_changes (file_a, file_b, jaccard, count, recency)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertCoChange.run("core/types.ts", "core/utils.ts", 0.8, 10, 0.9);

    // Add some annotations for keyword resolution
    const insAnn = db.prepare(
      `INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insAnn.run("docs/arch.md", 1, "TypeDef", "sym-typedef", 0.9, "code_span");
  }

  setup();

  // ── Target resolution ───────────────────────────────────────────

  it("resolves exact file path", () => {
    const result = focusFromDb(db, { target: "core/types.ts" });
    expect(result.target).toBe("core/types.ts");
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(
      result.nodes.some((n) => n.isTarget && n.filePath === "core/types.ts"),
    ).toBe(true);
  });

  it("resolves partial file name", () => {
    const result = focusFromDb(db, { target: "types" });
    expect(result.nodes.length).toBeGreaterThan(0);
    // Should find core/types.ts
    expect(result.nodes.some((n) => n.filePath === "core/types.ts")).toBe(true);
  });

  it("resolves symbol name", () => {
    const result = focusFromDb(db, { target: "handleRequest" });
    expect(result.nodes.length).toBeGreaterThan(0);
    // handleRequest is in server/api.ts
    expect(result.nodes.some((n) => n.filePath === "server/api.ts")).toBe(true);
  });

  it("returns empty for unknown target", () => {
    const result = focusFromDb(db, { target: "nonexistent_xyz_12345" });
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.totalNeighborhood).toBe(0);
  });

  // ── Hop expansion ──────────────────────────────────────────────

  it("expands 1-hop neighborhood", () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 1 });
    // api.ts → import: analyzer/extract.ts, reverse: server/routes.ts
    expect(result.nodes.some((n) => n.filePath === "server/api.ts")).toBe(true);
    expect(result.nodes.some((n) => n.filePath === "analyzer/extract.ts")).toBe(
      true,
    );
    expect(result.nodes.some((n) => n.filePath === "server/routes.ts")).toBe(
      true,
    );
    // cli/main.ts is 2 hops away (via routes), so should NOT be present
    expect(result.nodes.some((n) => n.filePath === "cli/main.ts")).toBe(false);
  });

  it("expands 2-hop neighborhood", () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 2 });
    // 2 hops: should include cli/main.ts (via routes) and core/types.ts (via extract)
    expect(result.nodes.some((n) => n.filePath === "cli/main.ts")).toBe(true);
    expect(result.nodes.some((n) => n.filePath === "core/types.ts")).toBe(true);
  });

  // ── Truncation ─────────────────────────────────────────────────

  it("respects maxNodes parameter", () => {
    const result = focusFromDb(db, {
      target: "core/types.ts",
      hops: 3,
      maxNodes: 3,
    });
    expect(result.nodes.length).toBeLessThanOrEqual(3);
    // Target should always be present
    expect(result.nodes.some((n) => n.isTarget)).toBe(true);
    // totalNeighborhood should be >= nodes shown
    expect(result.totalNeighborhood).toBeGreaterThanOrEqual(
      result.nodes.length,
    );
  });

  // ── Node annotations ──────────────────────────────────────────

  it("annotates nodes with layer and community info", () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 2 });
    const apiNode = result.nodes.find((n) => n.filePath === "server/api.ts");
    expect(apiNode).toBeDefined();
    // layerIndex should be a number (could be -1 if layers don't apply)
    expect(typeof apiNode!.layerIndex).toBe("number");
    expect(typeof apiNode!.communityId).toBe("number");
    expect(typeof apiNode!.dependents).toBe("number");
    expect(apiNode!.hopDistance).toBe(0);
  });

  it("marks target nodes correctly", () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 1 });
    const targets = result.nodes.filter((n) => n.isTarget);
    expect(targets).toHaveLength(1);
    expect(targets[0].filePath).toBe("server/api.ts");
  });

  it("computes hopDistance correctly", () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 2 });
    const apiNode = result.nodes.find((n) => n.filePath === "server/api.ts");
    const extractNode = result.nodes.find(
      (n) => n.filePath === "analyzer/extract.ts",
    );
    const typesNode = result.nodes.find((n) => n.filePath === "core/types.ts");

    expect(apiNode!.hopDistance).toBe(0);
    expect(extractNode!.hopDistance).toBe(1);
    // core/types.ts is reachable directly from extract (1 hop from api) = 2 hops
    expect(typesNode!.hopDistance).toBe(2);
  });

  // ── Edge types ─────────────────────────────────────────────────

  it("includes import edges", () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 1 });
    const importEdges = result.edges.filter((e) => e.type === "import");
    expect(importEdges.length).toBeGreaterThan(0);
    // api.ts → extract.ts should be an import edge
    expect(
      importEdges.some(
        (e) =>
          e.source === "server/api.ts" && e.target === "analyzer/extract.ts",
      ),
    ).toBe(true);
  });

  it("includes co-change edges when not already linked by import", () => {
    // core/types.ts and core/utils.ts have a co-change edge (jaccard 0.8)
    // and no direct import between them
    const result = focusFromDb(db, { target: "core/types.ts", hops: 2 });
    const coChangeEdges = result.edges.filter((e) => e.type === "co_change");
    if (result.nodes.some((n) => n.filePath === "core/utils.ts")) {
      expect(
        coChangeEdges.some(
          (e) =>
            (e.source === "core/types.ts" && e.target === "core/utils.ts") ||
            (e.source === "core/utils.ts" && e.target === "core/types.ts"),
        ),
      ).toBe(true);
    }
  });

  it("deduplicates co-change edges when import exists", () => {
    // extract.ts → types.ts has an import, so even if co-change exists,
    // only the import edge should appear
    const result = focusFromDb(db, { target: "analyzer/extract.ts", hops: 1 });
    const importToTypes = result.edges.filter(
      (e) =>
        e.type === "import" &&
        e.source === "analyzer/extract.ts" &&
        e.target === "core/types.ts",
    );
    const coChangeToTypes = result.edges.filter(
      (e) =>
        e.type === "co_change" &&
        ((e.source === "analyzer/extract.ts" && e.target === "core/types.ts") ||
          (e.source === "core/types.ts" && e.target === "analyzer/extract.ts")),
    );
    expect(importToTypes.length).toBe(1);
    // co-change should not duplicate the import edge
    expect(coChangeToTypes.length).toBe(0);
  });

  // ── Result structure ───────────────────────────────────────────

  it("returns correct result structure", () => {
    const result = focusFromDb(db, { target: "server/api.ts" });
    expect(result).toHaveProperty("target", "server/api.ts");
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("edges");
    expect(result).toHaveProperty("totalNeighborhood");
    expect(result).toHaveProperty("hops");
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it("computes transitive dependents", () => {
    const result = focusFromDb(db, { target: "core/types.ts", hops: 3 });
    const typesNode = result.nodes.find((n) => n.filePath === "core/types.ts");
    // core/types.ts is imported by: extract, parse, main (directly)
    // reverse graph: types ← extract ← api ← routes ← main, types ← parse, types ← main
    expect(typesNode!.dependents).toBeGreaterThanOrEqual(3);
  });
});
