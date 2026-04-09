// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for 5.1a: Layer Inference
 * Tests for 5.1b: Layer Check
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { layersInferFromDb } from "../queries/layersInfer.js";
import { layersCheckFromDb } from "../queries/layersCheck.js";
import type { LayerConfig } from "../types.js";

// =============================================================================
// 5.1a Layer Inference
// =============================================================================

describe("layersInfer", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `cari-layers-infer-${Date.now()}.db`);
    db = new Database(dbPath);
    initSchema(db);
    seedLayerFixtures(db);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  /**
   * Graph structure (layered architecture):
   *
   *   packages/core/types.ts        (foundation, imported by everything)
   *   packages/core/utils.ts        (foundation, imported by server + analyzer)
   *   packages/analyzer/extract.ts  → core/types.ts, core/utils.ts (middle)
   *   packages/analyzer/parse.ts    → core/types.ts (middle)
   *   packages/server/api.ts        → analyzer/extract.ts, core/types.ts (upper)
   *   packages/server/routes.ts     → server/api.ts (top)
   *   packages/cli/main.ts          → server/routes.ts, core/types.ts (top)
   *
   * Expected layers (bottom to top):
   *   Layer 0: core/types.ts, core/utils.ts (no outgoing imports)
   *   Layer 1: analyzer/extract.ts, analyzer/parse.ts
   *   Layer 2: server/api.ts, server/routes.ts, cli/main.ts
   */
  function seedLayerFixtures(d: Database.Database) {
    // Insert files
    const insFile = d.prepare(
      `INSERT INTO files (path, is_doc, is_hotspot) VALUES (?, 0, 0)`,
    );
    const files = [
      "packages/core/src/types.ts",
      "packages/core/src/utils.ts",
      "packages/analyzer/src/extract.ts",
      "packages/analyzer/src/parse.ts",
      "packages/server/src/api.ts",
      "packages/server/src/routes.ts",
      "packages/cli/src/main.ts",
      "docs/README.md", // isolated file (not in import graph)
    ];
    for (const f of files) {
      insFile.run(f);
    }

    // Insert imports (with target_file set for test determinism)
    const insImp = d.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
       VALUES (?, ?, ?, 1, '[]')`,
    );
    insImp.run(
      "packages/analyzer/src/extract.ts",
      "packages/core/src/types.ts",
      "../../core/src/types",
    );
    insImp.run(
      "packages/analyzer/src/extract.ts",
      "packages/core/src/utils.ts",
      "../../core/src/utils",
    );
    insImp.run(
      "packages/analyzer/src/parse.ts",
      "packages/core/src/types.ts",
      "../../core/src/types",
    );
    insImp.run(
      "packages/server/src/api.ts",
      "packages/analyzer/src/extract.ts",
      "../../analyzer/src/extract",
    );
    insImp.run(
      "packages/server/src/api.ts",
      "packages/core/src/types.ts",
      "../../core/src/types",
    );
    insImp.run(
      "packages/server/src/routes.ts",
      "packages/server/src/api.ts",
      "./api",
    );
    insImp.run(
      "packages/cli/src/main.ts",
      "packages/server/src/routes.ts",
      "../../server/src/routes",
    );
    insImp.run(
      "packages/cli/src/main.ts",
      "packages/core/src/types.ts",
      "../../core/src/types",
    );
  }

  it("returns layers sorted bottom to top", () => {
    const result = layersInferFromDb(db);
    expect(result.layers.length).toBeGreaterThanOrEqual(2);

    // Layer indices should be increasing
    for (let i = 1; i < result.layers.length; i++) {
      expect(result.layers[i].index).toBeGreaterThan(
        result.layers[i - 1].index,
      );
    }
  });

  it("places foundation files (core) in the lowest layer", () => {
    const result = layersInferFromDb(db);
    const bottomLayer = result.layers[0];
    expect(bottomLayer.files).toContain("packages/core/src/types.ts");
    expect(bottomLayer.files).toContain("packages/core/src/utils.ts");
  });

  it("places entrypoint files in the highest layer", () => {
    const result = layersInferFromDb(db);
    const topLayer = result.layers[result.layers.length - 1];
    // cli/main.ts or server/routes.ts should be in the top layer
    const topFiles = topLayer.files;
    expect(
      topFiles.includes("packages/cli/src/main.ts") ||
        topFiles.includes("packages/server/src/routes.ts"),
    ).toBe(true);
  });

  it("does not place foundation files in higher layers", () => {
    const result = layersInferFromDb(db);
    if (result.layers.length >= 2) {
      const upperLayers = result.layers.slice(1);
      for (const layer of upperLayers) {
        expect(layer.files).not.toContain("packages/core/src/types.ts");
        expect(layer.files).not.toContain("packages/core/src/utils.ts");
      }
    }
  });

  it("reports totalFiles", () => {
    const result = layersInferFromDb(db);
    // 7 files in the import graph
    expect(result.totalFiles).toBe(7);
  });

  it("identifies isolated files", () => {
    const result = layersInferFromDb(db);
    expect(result.isolatedFiles).toContain("docs/README.md");
  });

  it("generates YAML output", () => {
    const result = layersInferFromDb(db);
    expect(result.yaml).toContain("layers:");
    expect(result.yaml).toContain("name:");
    expect(result.yaml).toContain("patterns:");
  });

  it("each layer has a depthRange", () => {
    const result = layersInferFromDb(db);
    for (const layer of result.layers) {
      expect(layer.depthRange).toHaveLength(2);
      expect(layer.depthRange[0]).toBeLessThanOrEqual(layer.depthRange[1]);
    }
  });

  it("every file appears in exactly one layer", () => {
    const result = layersInferFromDb(db);
    const allLayerFiles = result.layers.flatMap((l) => l.files);
    const unique = new Set(allLayerFiles);
    expect(unique.size).toBe(allLayerFiles.length);
    expect(unique.size).toBe(result.totalFiles);
  });

  it("returns empty result for empty database", () => {
    const emptyPath = path.join(
      os.tmpdir(),
      `cari-layers-empty-${Date.now()}.db`,
    );
    const emptyDb = new Database(emptyPath);
    initSchema(emptyDb);

    const result = layersInferFromDb(emptyDb);
    expect(result.layers).toHaveLength(0);
    expect(result.totalFiles).toBe(0);

    emptyDb.close();
    fs.unlinkSync(emptyPath);
  });
});

// =============================================================================
// 5.1b Layer Check
// =============================================================================

describe("layersCheck", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `cari-layers-check-${Date.now()}.db`);
    db = new Database(dbPath);
    initSchema(db);
    seedCheckFixtures(db);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  /**
   * Architecture:
   *   Layer 0 (core):     packages/core/**
   *   Layer 1 (analyzer): packages/analyzer/**
   *   Layer 2 (server):   packages/server/**
   *   Layer 3 (cli):      packages/cli/**
   *
   * Imports:
   *   analyzer/a.ts → core/b.ts  (OK: higher→lower)
   *   server/c.ts → analyzer/a.ts (OK)
   *   core/b.ts → server/c.ts  (REVERSE: lower→higher)
   *   cli/d.ts → core/b.ts     (SKIP-LAYER: layer 3→0, skips 2 layers)
   *   cli/d.ts → server/c.ts   (OK: layer 3→2)
   */
  function seedCheckFixtures(d: Database.Database) {
    const insFile = d.prepare(
      `INSERT INTO files (path, is_doc, is_hotspot) VALUES (?, 0, 0)`,
    );
    insFile.run("packages/core/src/b.ts");
    insFile.run("packages/analyzer/src/a.ts");
    insFile.run("packages/server/src/c.ts");
    insFile.run("packages/cli/src/d.ts");

    const insImp = d.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
       VALUES (?, ?, ?, 1, '[]')`,
    );
    // OK: analyzer → core
    insImp.run(
      "packages/analyzer/src/a.ts",
      "packages/core/src/b.ts",
      "../../core/src/b",
    );
    // OK: server → analyzer
    insImp.run(
      "packages/server/src/c.ts",
      "packages/analyzer/src/a.ts",
      "../../analyzer/src/a",
    );
    // REVERSE: core → server
    insImp.run(
      "packages/core/src/b.ts",
      "packages/server/src/c.ts",
      "../../server/src/c",
    );
    // SKIP-LAYER: cli → core (skips analyzer and server)
    insImp.run(
      "packages/cli/src/d.ts",
      "packages/core/src/b.ts",
      "../../core/src/b",
    );
    // OK: cli → server (adjacent)
    insImp.run(
      "packages/cli/src/d.ts",
      "packages/server/src/c.ts",
      "../../server/src/c",
    );
  }

  const config: LayerConfig = {
    layers: [
      { name: "core", patterns: ["packages/core/**"] },
      { name: "analyzer", patterns: ["packages/analyzer/**"] },
      { name: "server", patterns: ["packages/server/**"] },
      { name: "cli", patterns: ["packages/cli/**"] },
    ],
  };

  it("detects reverse imports", () => {
    const result = layersCheckFromDb(db, config);
    const reverseViolations = result.violations.filter(
      (v) => v.type === "reverse",
    );
    expect(reverseViolations.length).toBe(1);
    expect(reverseViolations[0].sourceFile).toBe("packages/core/src/b.ts");
    expect(reverseViolations[0].targetFile).toBe("packages/server/src/c.ts");
    expect(reverseViolations[0].sourceLayer).toBe("core");
    expect(reverseViolations[0].targetLayer).toBe("server");
  });

  it("detects skip-layer imports", () => {
    const result = layersCheckFromDb(db, config);
    const skipViolations = result.violations.filter(
      (v) => v.type === "skip-layer",
    );
    expect(skipViolations.length).toBe(1);
    expect(skipViolations[0].sourceFile).toBe("packages/cli/src/d.ts");
    expect(skipViolations[0].targetFile).toBe("packages/core/src/b.ts");
  });

  it("counts violations by type", () => {
    const result = layersCheckFromDb(db, config);
    expect(result.byType.reverse).toBe(1);
    expect(result.byType.skipLayer).toBe(1);
    expect(result.totalViolations).toBe(2);
  });

  it("allows valid higher→lower imports", () => {
    const result = layersCheckFromDb(db, config);
    // analyzer→core and server→analyzer should NOT be violations
    const validImports = result.violations.filter(
      (v) =>
        (v.sourceFile === "packages/analyzer/src/a.ts" &&
          v.targetFile === "packages/core/src/b.ts") ||
        (v.sourceFile === "packages/server/src/c.ts" &&
          v.targetFile === "packages/analyzer/src/a.ts"),
    );
    expect(validImports).toHaveLength(0);
  });

  it("allows adjacent higher→lower imports (no skip-layer for cli→server)", () => {
    const result = layersCheckFromDb(db, config);
    const cliToServer = result.violations.filter(
      (v) =>
        v.sourceFile === "packages/cli/src/d.ts" &&
        v.targetFile === "packages/server/src/c.ts",
    );
    expect(cliToServer).toHaveLength(0);
  });

  it("reports layer summary with file counts", () => {
    const result = layersCheckFromDb(db, config);
    expect(result.layerSummary).toHaveLength(4);
    expect(result.layerSummary[0].name).toBe("core");
    expect(result.layerSummary[0].fileCount).toBe(1);
    expect(result.layerSummary[3].name).toBe("cli");
    expect(result.layerSummary[3].fileCount).toBe(1);
  });

  it("respects allowSkipLayer config", () => {
    const relaxedConfig: LayerConfig = {
      ...config,
      allowSkipLayer: true,
    };
    const result = layersCheckFromDb(db, relaxedConfig);
    // Only reverse violations remain, skip-layer should be gone
    expect(result.byType.reverse).toBe(1);
    expect(result.byType.skipLayer).toBe(0);
    expect(result.totalViolations).toBe(1);
  });

  it("returns empty result for empty config", () => {
    const emptyConfig: LayerConfig = { layers: [] };
    const result = layersCheckFromDb(db, emptyConfig);
    expect(result.violations).toHaveLength(0);
    expect(result.totalViolations).toBe(0);
  });

  it("handles files not matching any layer pattern", () => {
    // Add a file not matching any pattern
    const orphanDb = new Database(":memory:");
    initSchema(orphanDb);
    orphanDb
      .prepare(
        `INSERT INTO files (path, is_doc, is_hotspot) VALUES (?, 0, 0)`,
      )
      .run("random/file.ts");
    orphanDb
      .prepare(
        `INSERT INTO files (path, is_doc, is_hotspot) VALUES (?, 0, 0)`,
      )
      .run("packages/core/src/x.ts");
    orphanDb
      .prepare(
        `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
         VALUES (?, ?, ?, 1, '[]')`,
      )
      .run("random/file.ts", "packages/core/src/x.ts", "../../packages/core/src/x");
    const result = layersCheckFromDb(orphanDb, config);
    // random/file.ts has no layer, so no violation
    expect(result.totalViolations).toBe(0);
    orphanDb.close();
  });

  it("includes layer index in violations", () => {
    const result = layersCheckFromDb(db, config);
    for (const v of result.violations) {
      expect(typeof v.sourceLayerIndex).toBe("number");
      expect(typeof v.targetLayerIndex).toBe("number");
    }
  });
});
