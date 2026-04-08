// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for 3.3: Dependency Depth Analysis
 * Tests for 3.4: Package Boundary Violations
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { dependencyDepthFromDb } from "../queries/dependencyDepth.js";
import { boundaryViolationsFromDb } from "../queries/boundaryViolations.js";

// =============================================================================
// 3.3 Dependency Depth Analysis
// =============================================================================

describe("dependencyDepth", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `cari-dep-depth-${Date.now()}.db`);
    db = new Database(dbPath);
    initSchema(db);
    seedDepthFixtures(db);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  /**
   * Graph structure:
   *
   *   a.ts → b.ts → c.ts → d.ts
   *            ↘ e.ts
   *   f.ts → b.ts (f also depends on b)
   *   g.ts → h.ts (isolated pair)
   *
   * Fan-in of b.ts: direct=2 (a, f), transitive=2 (a, f)
   * Fan-out of a.ts: direct=1 (b), transitive=4 (b, c, d, e)
   * Max depth from a.ts: 3 (a→b→c→d)
   */
  function seedDepthFixtures(d: Database.Database) {
    const ins = d.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
       VALUES (?, ?, ?, 1, '[]')`,
    );
    ins.run("a.ts", "b.ts", "./b");
    ins.run("b.ts", "c.ts", "./c");
    ins.run("c.ts", "d.ts", "./d");
    ins.run("b.ts", "e.ts", "./e");
    ins.run("f.ts", "b.ts", "./b");
    ins.run("g.ts", "h.ts", "./h");
  }

  it("computes direct dependencies (fan-out)", () => {
    const result = dependencyDepthFromDb(db);
    const a = result.files.find((f) => f.filePath === "a.ts")!;
    expect(a.directDependencies).toBe(1); // only b.ts
    const b = result.files.find((f) => f.filePath === "b.ts")!;
    expect(b.directDependencies).toBe(2); // c.ts, e.ts
  });

  it("computes transitive dependencies (fan-out)", () => {
    const result = dependencyDepthFromDb(db);
    const a = result.files.find((f) => f.filePath === "a.ts")!;
    expect(a.transitiveDependencies).toBe(4); // b, c, d, e
  });

  it("computes direct dependents (fan-in)", () => {
    const result = dependencyDepthFromDb(db);
    const b = result.files.find((f) => f.filePath === "b.ts")!;
    expect(b.directDependents).toBe(2); // a.ts, f.ts
  });

  it("computes transitive dependents (fan-in)", () => {
    const result = dependencyDepthFromDb(db);
    const b = result.files.find((f) => f.filePath === "b.ts")!;
    expect(b.transitiveDependents).toBe(2); // a.ts, f.ts
  });

  it("computes max depth correctly", () => {
    const result = dependencyDepthFromDb(db);
    const a = result.files.find((f) => f.filePath === "a.ts")!;
    expect(a.maxDepth).toBe(3); // a→b→c→d
    const b = result.files.find((f) => f.filePath === "b.ts")!;
    expect(b.maxDepth).toBe(2); // b→c→d
  });

  it("leaf nodes have zero fan-out", () => {
    const result = dependencyDepthFromDb(db);
    const d = result.files.find((f) => f.filePath === "d.ts")!;
    expect(d.directDependencies).toBe(0);
    expect(d.transitiveDependencies).toBe(0);
    expect(d.maxDepth).toBe(0);
  });

  it("root nodes have zero fan-in", () => {
    const result = dependencyDepthFromDb(db);
    const a = result.files.find((f) => f.filePath === "a.ts")!;
    expect(a.directDependents).toBe(0);
    expect(a.transitiveDependents).toBe(0);
  });

  it("includes all files in the graph", () => {
    const result = dependencyDepthFromDb(db);
    expect(result.totalFiles).toBe(8); // a, b, c, d, e, f, g, h
  });

  it("handles isolated pairs", () => {
    const result = dependencyDepthFromDb(db);
    const g = result.files.find((f) => f.filePath === "g.ts")!;
    expect(g.directDependencies).toBe(1);
    expect(g.transitiveDependencies).toBe(1);
    expect(g.maxDepth).toBe(1);
    const h = result.files.find((f) => f.filePath === "h.ts")!;
    expect(h.directDependents).toBe(1);
    expect(h.directDependencies).toBe(0);
  });

  it("assigns risk levels based on fan-in/fan-out thresholds", () => {
    const result = dependencyDepthFromDb(db);
    // With our small fixture, all should be "low"
    for (const f of result.files) {
      expect(["low", "medium", "high", "critical"]).toContain(f.risk);
    }
  });

  it("sorts by risk (critical first) then transitiveDependents", () => {
    const result = dependencyDepthFromDb(db);
    const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < result.files.length; i++) {
      const prevRisk = riskOrder[result.files[i - 1].risk];
      const currRisk = riskOrder[result.files[i].risk];
      if (prevRisk === currRisk) {
        expect(result.files[i].transitiveDependents).toBeLessThanOrEqual(
          result.files[i - 1].transitiveDependents,
        );
      } else {
        expect(currRisk).toBeGreaterThanOrEqual(prevRisk);
      }
    }
  });

  it("flags high risk for large fan-in", () => {
    // Create a hub with many dependents
    const tmpPath = path.join(os.tmpdir(), `cari-dep-hub-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);

    const ins = tmpDb.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
       VALUES (?, ?, ?, 1, '[]')`,
    );
    // 12 files all importing hub.ts → transitiveDependents = 12 ≥ 10 → high
    for (let i = 0; i < 12; i++) {
      ins.run(`dep${i}.ts`, "hub.ts", "./hub");
    }

    try {
      const result = dependencyDepthFromDb(tmpDb);
      const hub = result.files.find((f) => f.filePath === "hub.ts")!;
      expect(hub.transitiveDependents).toBe(12);
      expect(["high", "critical"]).toContain(hub.risk);
      expect(result.highRiskCount).toBeGreaterThanOrEqual(1);
    } finally {
      tmpDb.close();
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  it("returns empty result on empty database", () => {
    const tmpPath = path.join(os.tmpdir(), `cari-dep-empty-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);
    try {
      const result = dependencyDepthFromDb(tmpDb);
      expect(result.totalFiles).toBe(0);
      expect(result.files).toEqual([]);
      expect(result.highRiskCount).toBe(0);
    } finally {
      tmpDb.close();
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  it("handles circular dependency without infinite loop", () => {
    const tmpPath = path.join(os.tmpdir(), `cari-dep-cycle-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);

    const ins = tmpDb.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
       VALUES (?, ?, ?, 1, '[]')`,
    );
    ins.run("x.ts", "y.ts", "./y");
    ins.run("y.ts", "z.ts", "./z");
    ins.run("z.ts", "x.ts", "./x");

    try {
      const result = dependencyDepthFromDb(tmpDb);
      // Should complete without hanging
      expect(result.totalFiles).toBe(3);
      // Each node can reach the other 2 via the cycle
      for (const f of result.files) {
        expect(f.transitiveDependencies).toBe(2);
        expect(f.transitiveDependents).toBe(2);
      }
    } finally {
      tmpDb.close();
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });
});

// =============================================================================
// 3.4 Package Boundary Violations
// =============================================================================

describe("boundaryViolations", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `cari-boundary-${Date.now()}.db`);
    db = new Database(dbPath);
    initSchema(db);
    seedBoundaryFixtures(db);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  function seedBoundaryFixtures(d: Database.Database) {
    const ins = d.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
       VALUES (?, ?, ?, 1, '[]')`,
    );

    // Valid: same-package internal import (no violation)
    ins.run(
      "packages/analyzer/src/stages/ax.ts",
      "packages/analyzer/src/utils.ts",
      "../utils",
    );

    // Violation: analyzer imports cli's internal module
    ins.run(
      "packages/analyzer/src/stages/fx.ts",
      "packages/cli/src/drift/docDrift.ts",
      "../../cli/src/drift/docDrift",
    );

    // Violation: cli imports core's internal module
    ins.run(
      "packages/cli/src/commands/run.ts",
      "packages/core/src/internal/helpers.ts",
      "../../core/src/internal/helpers",
    );

    // Valid: cross-package import to index.ts (public API, no violation)
    ins.run(
      "packages/analyzer/src/pipeline.ts",
      "packages/core/src/index.ts",
      "@intentweave/core",
    );

    // Violation: apps/server imports packages/cli internal
    ins.run(
      "apps/server/src/routes.ts",
      "packages/cli/src/mcp/server.ts",
      "../../packages/cli/src/mcp/server",
    );

    // Valid: intra-app import (no violation — same app)
    ins.run(
      "apps/server/src/routes.ts",
      "apps/server/src/middleware.ts",
      "./middleware",
    );

    // Not in a package (top-level file → no violation)
    ins.run("scripts/build.ts", "packages/core/src/types.ts", "../packages/core/src/types");
  }

  it("detects cross-package internal imports", () => {
    const result = boundaryViolationsFromDb(db);
    expect(result.totalViolations).toBeGreaterThanOrEqual(2);
    const sources = result.violations.map((v) => v.sourceFile);
    expect(sources).toContain("packages/analyzer/src/stages/fx.ts");
    expect(sources).toContain("packages/cli/src/commands/run.ts");
  });

  it("does not flag same-package imports", () => {
    const result = boundaryViolationsFromDb(db);
    const sources = result.violations.map((v) => v.sourceFile);
    // analyzer importing from analyzer is fine
    expect(
      result.violations.some(
        (v) =>
          v.sourceFile === "packages/analyzer/src/stages/ax.ts" &&
          v.targetFile === "packages/analyzer/src/utils.ts",
      ),
    ).toBe(false);
  });

  it("does not flag imports to package index (public API)", () => {
    const result = boundaryViolationsFromDb(db);
    expect(
      result.violations.some(
        (v) => v.targetFile === "packages/core/src/index.ts",
      ),
    ).toBe(false);
  });

  it("detects apps→packages boundary violations", () => {
    const result = boundaryViolationsFromDb(db);
    const appViolation = result.violations.find(
      (v) => v.sourceFile === "apps/server/src/routes.ts" &&
        v.targetPackage === "packages/cli",
    );
    expect(appViolation).toBeDefined();
  });

  it("includes module specifier in violation details", () => {
    const result = boundaryViolationsFromDb(db);
    for (const v of result.violations) {
      expect(v.moduleSpecifier).toBeTruthy();
    }
  });

  it("groups violations by package pair", () => {
    const result = boundaryViolationsFromDb(db);
    expect(result.byPackagePair.length).toBeGreaterThanOrEqual(1);
    for (const pair of result.byPackagePair) {
      expect(pair.sourcePackage).toBeTruthy();
      expect(pair.targetPackage).toBeTruthy();
      expect(pair.count).toBeGreaterThanOrEqual(1);
    }
  });

  it("provides human-readable reason", () => {
    const result = boundaryViolationsFromDb(db);
    for (const v of result.violations) {
      expect(v.reason).toContain("imports internal module");
      expect(v.reason).toContain("public exports");
    }
  });

  it("sorts violations by package pair then source file", () => {
    const result = boundaryViolationsFromDb(db);
    for (let i = 1; i < result.violations.length; i++) {
      const prev = result.violations[i - 1];
      const curr = result.violations[i];
      const cmp =
        prev.sourcePackage.localeCompare(curr.sourcePackage) ||
        prev.targetPackage.localeCompare(curr.targetPackage) ||
        prev.sourceFile.localeCompare(curr.sourceFile);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("returns empty result when no violations exist", () => {
    const tmpPath = path.join(os.tmpdir(), `cari-boundary-empty-${Date.now()}.db`);
    const tmpDb = new Database(tmpPath);
    initSchema(tmpDb);

    // Only same-package imports
    tmpDb
      .prepare(
        `INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
         VALUES (?, ?, ?, 1, '[]')`,
      )
      .run(
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "./b",
      );

    try {
      const result = boundaryViolationsFromDb(tmpDb);
      expect(result.totalViolations).toBe(0);
      expect(result.violations).toEqual([]);
      expect(result.byPackagePair).toEqual([]);
    } finally {
      tmpDb.close();
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  it("handles files not inside a package directory", () => {
    const result = boundaryViolationsFromDb(db);
    // scripts/build.ts is not inside packages/ or apps/, so it should not generate a violation
    // even though it imports from packages/core/src/types.ts
    expect(
      result.violations.some((v) => v.sourceFile === "scripts/build.ts"),
    ).toBe(false);
  });
});
