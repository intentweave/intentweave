// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for focused architecture SVG report renderer
 */

import { describe, it, expect, afterAll } from "vitest";
import Database from "@intentweave/sqlite-compat";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { focusFromDb } from "../queries/focus.js";
import {
  renderFocusReportHtml,
  renderFocusDot,
} from "../export/focusReport.js";

describe("focusReport", () => {
  let db: Database.Database;
  let dbPath: string;

  afterAll(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  function setup(): void {
    dbPath = path.join(
      os.tmpdir(),
      `iw-focus-report-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new Database(dbPath);
    initSchema(db);

    const files = [
      "core/types.ts",
      "core/utils.ts",
      "analyzer/extract.ts",
      "server/api.ts",
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
    insertImport.run(
      "server/api.ts",
      "analyzer/extract.ts",
      "../analyzer/extract",
      1,
    );

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
      "sym-extract",
      "extract",
      "function",
      "analyzer/extract.ts",
      10,
      "named",
    );
    insertSymbol.run(
      "sym-api",
      "handleRequest",
      "function",
      "server/api.ts",
      1,
      "named",
    );

    // Co-change edge
    const insertCoChange = db.prepare(
      `INSERT INTO co_changes (file_a, file_b, jaccard, count, recency)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertCoChange.run("core/types.ts", "core/utils.ts", 0.8, 10, 0.9);
  }

  setup();

  // ── DOT generation ─────────────────────────────────────────────

  it("generates valid DOT source", () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 2 });
    const dot = renderFocusDot(result);

    expect(dot).toContain("digraph focus");
    expect(dot).toContain("subgraph cluster_layer_");
    expect(dot).toContain("⭐");
    // Should contain nodes
    expect(dot).toContain("n_server_api_ts");
    // Should contain edge
    expect(dot).toMatch(/n_server_api_ts\s*->\s*n_analyzer_extract_ts/);
  });

  it("includes co-change edges as dashed", () => {
    const result = focusFromDb(db, { target: "core/types.ts", hops: 2 });
    const dot = renderFocusDot(result);

    // co-change between types and utils should be dashed
    if (result.edges.some((e) => e.type === "co_change")) {
      expect(dot).toContain("style=dashed");
    }
  });

  // ── HTML rendering ─────────────────────────────────────────────

  it("renders a self-contained HTML page", async () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 2 });
    const html = await renderFocusReportHtml(result);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<svg");
    expect(html).toContain("</svg>");
    expect(html).toContain("__FOCUS_DATA__");
    expect(html).toContain("server/api.ts");
  });

  it("includes the title with target name", async () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 1 });
    const html = await renderFocusReportHtml(result);

    expect(html).toContain("Focus: server/api.ts");
  });

  it("includes zoom controls", async () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 1 });
    const html = await renderFocusReportHtml(result);

    expect(html).toContain("zoom-in");
    expect(html).toContain("zoom-out");
    expect(html).toContain("zoom-fit");
  });

  it("includes the legend", async () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 2 });
    const html = await renderFocusReportHtml(result);

    expect(html).toContain("Import");
    // Our test data has co-change edges
    if (result.edges.some((e) => e.type === "co_change")) {
      expect(html).toContain("Co-change");
    }
  });

  it("embeds FocusResult as JSON data", async () => {
    const result = focusFromDb(db, { target: "server/api.ts", hops: 1 });
    const html = await renderFocusReportHtml(result);

    // Extract the JSON from the HTML
    const match = html.match(/window\.__FOCUS_DATA__\s*=\s*({.*?});/s);
    expect(match).not.toBeNull();
    const data = JSON.parse(match![1]);
    expect(data.target).toBe("server/api.ts");
    expect(data.nodes.length).toBeGreaterThan(0);
  });

  it("handles empty result gracefully", async () => {
    const emptyResult = {
      target: "nonexistent",
      nodes: [],
      edges: [],
      totalNeighborhood: 0,
      hops: 2,
    };
    const html = await renderFocusReportHtml(emptyResult);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<svg");
  });
});
