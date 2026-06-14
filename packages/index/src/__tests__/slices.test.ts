// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for 5.7: Vertical Slice Detection
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "@intentweave/sqlite-compat";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { slicesFromDb } from "../queries/slices.js";

// =============================================================================
// 5.7 Vertical Slice Detection
// =============================================================================

describe("slices", () => {
  let db: Database.Database;
  let dbPath: string;

  afterAll(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  /**
   * Architecture:
   *
   *   Layer 0 (foundation): core/types.ts, core/utils.ts, core/config.ts
   *   Layer 1 (middle):     analyzer/extract.ts → core/types, core/utils
   *                         analyzer/parse.ts   → core/types
   *                         analyzer/validate.ts→ core/config
   *   Layer 2 (upper):      server/api.ts       → analyzer/extract
   *                         server/routes.ts    → server/api
   *   Layer 3 (top):        cli/main.ts         → server/routes, core/types
   *                         cli/commands.ts     → server/api
   *
   * We create strong co-occurrence links between files that should cluster:
   *
   *   Community A (auth slice): core/types.ts, analyzer/extract.ts,
   *                             server/api.ts, cli/main.ts
   *     → Spans layers 0, 1, 2, 3 → vertical slice (4 layers)
   *
   *   Community B (config): core/config.ts, analyzer/validate.ts
   *     → Spans layers 0, 1 only → horizontal module (2 layers)
   *
   *   Community C (routing): server/routes.ts, cli/commands.ts, core/utils.ts
   *     → Spans layers 0, 2, 3 → vertical slice (3 layers)
   */
  function seedFixtures(d: Database.Database) {
    const insFile = d.prepare(
      `INSERT INTO files (path, is_doc, is_hotspot) VALUES (?, 0, 0)`,
    );
    const allFiles = [
      "core/types.ts",
      "core/utils.ts",
      "core/config.ts",
      "analyzer/extract.ts",
      "analyzer/parse.ts",
      "analyzer/validate.ts",
      "server/api.ts",
      "server/routes.ts",
      "cli/main.ts",
      "cli/commands.ts",
    ];
    for (const f of allFiles) insFile.run(f);

    // Import edges create the layer structure
    const insImp = d.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
       VALUES (?, ?, ?, 1, '[]')`,
    );
    // Layer 1 → Layer 0
    insImp.run("analyzer/extract.ts", "core/types.ts", "../core/types");
    insImp.run("analyzer/extract.ts", "core/utils.ts", "../core/utils");
    insImp.run("analyzer/parse.ts", "core/types.ts", "../core/types");
    insImp.run("analyzer/validate.ts", "core/config.ts", "../core/config");
    // Layer 2 → Layer 1
    insImp.run("server/api.ts", "analyzer/extract.ts", "../analyzer/extract");
    insImp.run("server/routes.ts", "server/api.ts", "./api");
    // Layer 3 → Layer 2
    insImp.run("cli/main.ts", "server/routes.ts", "../server/routes");
    insImp.run("cli/main.ts", "core/types.ts", "../core/types");
    insImp.run("cli/commands.ts", "server/api.ts", "../server/api");

    // Co-occurrence edges create community structure (high scores force clustering)
    const insCoOcc = d.prepare(
      `INSERT INTO co_occurrences (entity_a, entity_b, count, score, source) VALUES (?, ?, 1, ?, 'test')`,
    );
    // Community A: auth slice (spans all 4 layers)
    insCoOcc.run("core/types.ts", "analyzer/extract.ts", 10);
    insCoOcc.run("analyzer/extract.ts", "server/api.ts", 10);
    insCoOcc.run("server/api.ts", "cli/main.ts", 10);
    insCoOcc.run("core/types.ts", "server/api.ts", 10);
    insCoOcc.run("core/types.ts", "cli/main.ts", 10);
    insCoOcc.run("analyzer/extract.ts", "cli/main.ts", 10);

    // Community B: config (spans 2 layers)
    insCoOcc.run("core/config.ts", "analyzer/validate.ts", 10);

    // Community C: routing (spans 3 layers)
    insCoOcc.run("core/utils.ts", "server/routes.ts", 10);
    insCoOcc.run("server/routes.ts", "cli/commands.ts", 10);
    insCoOcc.run("core/utils.ts", "cli/commands.ts", 10);
  }

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `cari-slices-${Date.now()}.db`);
    db = new Database(dbPath);
    initSchema(db);
    seedFixtures(db);
  });

  it("detects vertical slices spanning ≥3 layers", () => {
    const result = slicesFromDb(db);
    expect(result.slices.length).toBeGreaterThanOrEqual(1);
    for (const s of result.slices) {
      expect(s.orientation).toBe("vertical");
      expect(s.layerSpan).toBeGreaterThanOrEqual(3);
    }
  });

  it("classifies low-span communities as horizontal", () => {
    const result = slicesFromDb(db);
    for (const h of result.horizontal) {
      expect(h.orientation).toBe("horizontal");
      expect(h.layerSpan).toBeLessThan(3);
    }
  });

  it("slices are sorted by layerSpan desc then totalFiles desc", () => {
    const result = slicesFromDb(db);
    for (let i = 1; i < result.slices.length; i++) {
      const prev = result.slices[i - 1];
      const curr = result.slices[i];
      expect(prev.layerSpan).toBeGreaterThanOrEqual(curr.layerSpan);
      if (prev.layerSpan === curr.layerSpan) {
        expect(prev.totalFiles).toBeGreaterThanOrEqual(curr.totalFiles);
      }
    }
  });

  it("each slice has filesByLayer populated", () => {
    const result = slicesFromDb(db);
    for (const s of result.slices) {
      const layerKeys = Object.keys(s.filesByLayer).map(Number);
      expect(layerKeys).toEqual(s.layers);
      let sum = 0;
      for (const files of Object.values(s.filesByLayer)) {
        expect(files.length).toBeGreaterThan(0);
        sum += files.length;
      }
      expect(sum).toBe(s.totalFiles);
    }
  });

  it("reports totalLayers and totalCommunities", () => {
    const result = slicesFromDb(db);
    expect(result.totalLayers).toBeGreaterThanOrEqual(3);
    expect(result.totalCommunities).toBeGreaterThanOrEqual(2);
  });

  it("respects minLayers option", () => {
    // With minLayers=4, fewer slices qualify
    const strict = slicesFromDb(db, { minLayers: 4 });
    const loose = slicesFromDb(db, { minLayers: 2 });
    expect(loose.slices.length).toBeGreaterThanOrEqual(strict.slices.length);
    for (const s of strict.slices) {
      expect(s.layerSpan).toBeGreaterThanOrEqual(4);
    }
    // Horizontal count should increase with stricter threshold
    expect(strict.horizontal.length).toBeGreaterThanOrEqual(
      loose.horizontal.length,
    );
  });

  it("respects limit option", () => {
    const result = slicesFromDb(db, { limit: 1 });
    expect(result.slices.length).toBeLessThanOrEqual(1);
  });

  describe("empty database", () => {
    let emptyDb: Database.Database;
    let emptyPath: string;

    beforeAll(() => {
      emptyPath = path.join(os.tmpdir(), `cari-slices-empty-${Date.now()}.db`);
      emptyDb = new Database(emptyPath);
      initSchema(emptyDb);
    });

    afterAll(() => {
      emptyDb.close();
      if (fs.existsSync(emptyPath)) fs.unlinkSync(emptyPath);
    });

    it("returns empty results on empty database", () => {
      const result = slicesFromDb(emptyDb);
      expect(result.slices).toEqual([]);
      expect(result.horizontal).toEqual([]);
      expect(result.totalLayers).toBe(0);
      expect(result.totalCommunities).toBe(0);
    });
  });
});
