// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for 10.1: Architecture Report
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { archReportFromDb } from "../queries/archReport.js";
import { renderArchReportHtml } from "../export/htmlReport.js";

// =============================================================================
// Architecture Report — Data Collector
// =============================================================================

describe("archReport", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `cari-arch-report-${Date.now()}.db`);
    db = new Database(dbPath);
    initSchema(db);
    seedFixtures(db);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  /**
   * Graph:
   *   core/types.ts         (foundation)
   *   core/utils.ts         (foundation, imports types)
   *   lib/analyzer.ts       → core/types.ts, core/utils.ts
   *   lib/parser.ts         → core/types.ts
   *   app/server.ts         → lib/analyzer.ts, core/types.ts
   *   app/cli.ts            → app/server.ts
   *
   * This forms a 3-layer architecture:
   *   Layer 0: core/types.ts (no outgoing)
   *   Layer 1: core/utils.ts, lib/parser.ts (import only from layer 0)
   *   Layer 2: lib/analyzer.ts (imports from layer 0 + 1)
   *   Layer 3: app/server.ts (imports from layer 0 + 2)
   *   Layer 4: app/cli.ts (imports from layer 3)
   */
  function seedFixtures(d: Database.Database) {
    const insFile = d.prepare(
      `INSERT INTO files (path, is_doc, is_hotspot) VALUES (?, 0, 0)`,
    );
    const files = [
      "core/types.ts",
      "core/utils.ts",
      "lib/analyzer.ts",
      "lib/parser.ts",
      "app/server.ts",
      "app/cli.ts",
    ];
    for (const f of files) insFile.run(f);

    const insImp = d.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
       VALUES (?, ?, ?, 1, '[]')`,
    );
    // core/utils.ts → core/types.ts
    insImp.run("core/utils.ts", "core/types.ts", "./types");
    // lib/analyzer.ts → core/types.ts, core/utils.ts
    insImp.run("lib/analyzer.ts", "core/types.ts", "../core/types");
    insImp.run("lib/analyzer.ts", "core/utils.ts", "../core/utils");
    // lib/parser.ts → core/types.ts
    insImp.run("lib/parser.ts", "core/types.ts", "../core/types");
    // app/server.ts → lib/analyzer.ts, core/types.ts
    insImp.run("app/server.ts", "lib/analyzer.ts", "../lib/analyzer");
    insImp.run("app/server.ts", "core/types.ts", "../core/types");
    // app/cli.ts → app/server.ts
    insImp.run("app/cli.ts", "app/server.ts", "./server");

    // Insert symbols for hub analysis
    const insSym = d.prepare(
      `INSERT INTO symbols (name, kind, file_path, line, export)
       VALUES (?, ?, ?, 1, 1)`,
    );
    insSym.run("types", "module", "core/types.ts");
    insSym.run("utils", "module", "core/utils.ts");
    insSym.run("analyze", "function", "lib/analyzer.ts");
    insSym.run("parse", "function", "lib/parser.ts");
    insSym.run("startServer", "function", "app/server.ts");
    insSym.run("main", "function", "app/cli.ts");
  }

  it("returns all files as nodes", () => {
    const result = archReportFromDb(db);
    expect(result.nodes.length).toBe(6);
    const paths = result.nodes.map((n) => n.filePath).sort();
    expect(paths).toEqual([
      "app/cli.ts",
      "app/server.ts",
      "core/types.ts",
      "core/utils.ts",
      "lib/analyzer.ts",
      "lib/parser.ts",
    ]);
  });

  it("assigns layer indices to nodes", () => {
    const result = archReportFromDb(db);
    const typesNode = result.nodes.find((n) => n.filePath === "core/types.ts")!;
    const cliNode = result.nodes.find((n) => n.filePath === "app/cli.ts")!;
    // Foundation should have lower index than entrypoint
    expect(typesNode.layerIndex).toBeLessThan(cliNode.layerIndex);
  });

  it("has import edges", () => {
    const result = archReportFromDb(db);
    const importEdges = result.edges.filter((e) => e.type === "import");
    // 7 import relationships in the fixture
    expect(importEdges.length).toBe(7);
  });

  it("populates layer summary", () => {
    const result = archReportFromDb(db);
    expect(result.layers.length).toBeGreaterThanOrEqual(2);
    const totalFilesInLayers = result.layers.reduce(
      (s, l) => s + l.fileCount,
      0,
    );
    expect(totalFilesInLayers).toBe(6);
  });

  it("populates summary counts", () => {
    const result = archReportFromDb(db);
    expect(result.summary.totalLayers).toBeGreaterThanOrEqual(2);
    expect(result.summary.layerViolations).toBe(0); // no violations in clean hierarchy
    expect(result.summary.boundaryViolations).toBe(0);
  });

  it("includes meta with generated timestamp", () => {
    const result = archReportFromDb(db);
    expect(result.meta.generated).toBeTruthy();
    expect(result.meta.totalFiles).toBe(6);
  });

  it("fills fileName from filePath", () => {
    const result = archReportFromDb(db);
    const typesNode = result.nodes.find((n) => n.filePath === "core/types.ts")!;
    expect(typesNode.fileName).toBe("types.ts");
  });

  it("assigns transitiveDependents from depth analysis", () => {
    const result = archReportFromDb(db);
    const typesNode = result.nodes.find((n) => n.filePath === "core/types.ts")!;
    // types.ts is imported by nearly everything
    expect(typesNode.transitiveDependents).toBeGreaterThan(0);
  });
});

// =============================================================================
// Architecture Report — HTML Renderer
// =============================================================================

describe("renderArchReportHtml", () => {
  const sampleData = {
    meta: { generated: "2026-04-08T00:00:00Z", totalFiles: 3 },
    nodes: [
      {
        filePath: "a.ts",
        fileName: "a.ts",
        layerIndex: 0,
        layerLabel: "core",
        communityId: 0,
        communityLabel: "core",
        transitiveDependents: 2,
        maxDepth: 0,
        risk: "low" as const,
        hubDegree: 4,
      },
      {
        filePath: "b.ts",
        fileName: "b.ts",
        layerIndex: 1,
        layerLabel: "app",
        communityId: 0,
        communityLabel: "core",
        transitiveDependents: 0,
        maxDepth: 1,
        risk: "low" as const,
        hubDegree: 1,
      },
      {
        filePath: "c.ts",
        fileName: "c.ts",
        layerIndex: 1,
        layerLabel: "app",
        communityId: 1,
        communityLabel: "app",
        transitiveDependents: 0,
        maxDepth: 1,
        risk: "high" as const,
        hubDegree: 0,
      },
    ],
    edges: [
      { source: "b.ts", target: "a.ts", type: "import" as const },
      { source: "c.ts", target: "a.ts", type: "import" as const },
    ],
    layers: [
      { index: 0, label: "core", fileCount: 1 },
      { index: 1, label: "app", fileCount: 2 },
    ],
    communities: [
      { id: 0, label: "core", size: 2 },
      { id: 1, label: "app", size: 1 },
    ],
    summary: {
      totalLayers: 2,
      totalCommunities: 2,
      layerViolations: 0,
      boundaryViolations: 0,
      highRiskFiles: 1,
    },
  };

  it("returns valid HTML document", () => {
    const html = renderArchReportHtml(sampleData);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("embeds D3 CDN script tag", () => {
    const html = renderArchReportHtml(sampleData);
    expect(html).toContain("cdn.jsdelivr.net/npm/d3@7");
  });

  it("embeds data as JSON", () => {
    const html = renderArchReportHtml(sampleData);
    expect(html).toContain('"totalFiles":3');
    expect(html).toContain('"a.ts"');
  });

  it("includes layer and violation view buttons", () => {
    const html = renderArchReportHtml(sampleData);
    expect(html).toContain('data-view="layers"');
    expect(html).toContain('data-view="violations"');
  });

  it("includes search input", () => {
    const html = renderArchReportHtml(sampleData);
    expect(html).toContain('id="search"');
  });

  it("includes legend section", () => {
    const html = renderArchReportHtml(sampleData);
    expect(html).toContain('id="legend"');
  });

  it("includes tooltip element", () => {
    const html = renderArchReportHtml(sampleData);
    expect(html).toContain('id="tooltip"');
  });
});
