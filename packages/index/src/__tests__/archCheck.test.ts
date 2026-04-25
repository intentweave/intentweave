// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Architecture Diagram Validation (5.8)
 *
 * Seeds files + imports tables to simulate a codebase with known component
 * structure, then validates archCheck against various ArchConfig inputs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { archCheckFromDb } from "../queries/archCheck.js";
import { parseArchitectureYaml } from "../queries/archCheck.js";
import { inferArchConfigFromKgDb } from "../queries/archCheck.js";
import type { ArchConfig } from "../types.js";

// =============================================================================
// Fixture Setup
// =============================================================================

let db: Database.Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `cari-arch-check-${Date.now()}.db`);
  db = new Database(dbPath);
  initSchema(db);
  db.pragma("foreign_keys = OFF");
  seedFixtures(db);
});

afterAll(() => {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

function seedFixtures(d: Database.Database) {
  // ── Files ──
  d.exec(`
    INSERT INTO files (path, is_doc) VALUES
      ('src/server/index.ts', 0),
      ('src/server/routes.ts', 0),
      ('src/server/middleware.ts', 0),
      ('src/core/types.ts', 0),
      ('src/core/utils.ts', 0),
      ('src/db/client.ts', 0),
      ('src/db/queries.ts', 0),
      ('src/ui/App.tsx', 0),
      ('src/ui/components/Header.tsx', 0),
      ('src/ui/api.ts', 0)
  `);

  // ── Imports (cross-component flows) ──
  d.exec(`
    INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
    VALUES
      -- server → core (expected flow)
      ('src/server/index.ts', 'src/core/types.ts', '../core/types', 1, 'ServerConfig'),
      ('src/server/routes.ts', 'src/core/utils.ts', '../core/utils', 1, 'formatResponse'),
      -- server → db (expected flow)
      ('src/server/routes.ts', 'src/db/queries.ts', '../db/queries', 1, 'getUsers'),
      ('src/server/middleware.ts', 'src/db/client.ts', '../db/client', 1, 'dbClient'),
      -- ui → core (expected flow)
      ('src/ui/App.tsx', 'src/core/types.ts', '../../core/types', 1, 'AppConfig'),
      -- ui → server (undocumented — UI should not import server)
      ('src/ui/api.ts', 'src/server/routes.ts', '../../server/routes', 1, 'apiRouter'),
      -- db → core (expected flow)
      ('src/db/queries.ts', 'src/core/types.ts', '../core/types', 1, 'DbRecord'),
      -- internal (server → server — should not appear as cross-component)
      ('src/server/routes.ts', 'src/server/middleware.ts', './middleware', 1, 'authMiddleware')
  `);

  // ── Symbols + annotations (for component -> file mapping) ──
  d.exec(`
    INSERT INTO symbols (id, name, kind, file_path, line, export)
    VALUES
      ('sym.server.router', 'Router', 'class', 'src/server/routes.ts', 1, 'named'),
      ('sym.annotator', 'Annotator', 'class', 'src/index/annotator.ts', 1, 'named'),
      ('sym.writer', 'Writer', 'class', 'src/index/writer.ts', 1, 'named')
  `);

  d.exec(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source)
    VALUES
      ('docs/ARCH.md', 10, 'AX Stage', 'sym.server.router', 0.9, 'exact'),
      ('docs/ARCH.md', 11, 'Annotator', 'sym.annotator', 0.9, 'exact'),
      ('docs/ARCH.md', 12, 'Writer', 'sym.writer', 0.9, 'exact')
  `);

  // ── Enriched KG triples from docs/ARCH.md ──
  d.exec(`
    INSERT INTO kg_entities (id, canon_id, name, type, aliases, confidence, artifact_id, source_file, created_at)
    VALUES
      (101, 'ax_stage', 'AX Stage', 'component', '[]', 0.9, 'docs.ARCH', 'docs/ARCH.md', datetime('now')),
      (102, 'annotator', 'Annotator', 'component', '[]', 0.9, 'docs.ARCH', 'docs/ARCH.md', datetime('now')),
      (103, 'writer', 'Writer', 'component', '[]', 0.9, 'docs.ARCH', 'docs/ARCH.md', datetime('now')),
      (104, 'misc', 'Misc', 'component', '[]', 0.2, 'docs.ARCH', 'docs/ARCH.md', datetime('now'))
  `);

  d.exec(`
    INSERT INTO kg_relationships (from_id, to_id, predicate, confidence, raw_predicate, artifact_id, source_file)
    VALUES
      (101, 102, 'PRECEDES', 0.9, 'flows to', 'docs.ARCH', 'docs/ARCH.md'),
      (102, 103, 'CALLS', 0.9, 'calls', 'docs.ARCH', 'docs/ARCH.md'),
      (103, 101, 'FOLLOWS', 0.9, 'follows', 'docs.ARCH', 'docs/ARCH.md'),
      (101, 104, 'RELATED_TO', 0.9, 'related', 'docs.ARCH', 'docs/ARCH.md'),
      (104, 103, 'CALLS', 0.2, 'calls', 'docs.ARCH', 'docs/ARCH.md')
  `);
}

// =============================================================================
// Helper — standard config
// =============================================================================

function standardConfig(): ArchConfig {
  return {
    components: [
      { name: "server", files: ["src/server/**"] },
      { name: "core", files: ["src/core/**"] },
      { name: "db", files: ["src/db/**"] },
      { name: "ui", files: ["src/ui/**"] },
    ],
    flows: [
      { from: "server", to: "core" },
      { from: "server", to: "db" },
      { from: "ui", to: "core" },
      { from: "db", to: "core" },
    ],
    constraints: [],
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("archCheck — Architecture Diagram Validation", () => {
  it("confirms all declared flows that have matching imports", () => {
    const result = archCheckFromDb(db, standardConfig());

    const confirmed = result.flows.filter((f) => f.status === "confirmed");
    expect(confirmed).toHaveLength(4);

    // server → core
    const sc = confirmed.find((f) => f.from === "server" && f.to === "core")!;
    expect(sc).toBeDefined();
    expect(sc.evidence.length).toBeGreaterThanOrEqual(2);

    // server → db
    const sd = confirmed.find((f) => f.from === "server" && f.to === "db")!;
    expect(sd).toBeDefined();
    expect(sd.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("marks flows as missing when no matching imports exist", () => {
    const config = standardConfig();
    config.flows!.push({ from: "ui", to: "db" }); // no such import exists

    const result = archCheckFromDb(db, config);
    const missing = result.flows.filter((f) => f.status === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].from).toBe("ui");
    expect(missing[0].to).toBe("db");
    expect(missing[0].evidence).toHaveLength(0);
  });

  it("detects undocumented flows not in the diagram", () => {
    const result = archCheckFromDb(db, standardConfig());

    // ui → server is an import that exists but is not declared
    expect(result.undocumented.length).toBeGreaterThanOrEqual(1);
    const uiServer = result.undocumented.find(
      (u) => u.from === "ui" && u.to === "server",
    );
    expect(uiServer).toBeDefined();
    expect(uiServer!.edges.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag internal imports as undocumented", () => {
    const result = archCheckFromDb(db, standardConfig());

    // server → server internal import should NOT appear
    const internalFlow = result.undocumented.find(
      (u) => u.from === "server" && u.to === "server",
    );
    expect(internalFlow).toBeUndefined();
  });

  it("detects constraint violations", () => {
    const config = standardConfig();
    config.constraints = [
      {
        type: "no-direct-dependency",
        from: "ui",
        to: "server",
        reason: "UI must use API layer, not import server directly",
      },
    ];

    const result = archCheckFromDb(db, config);
    expect(result.constraintViolations).toHaveLength(1);
    expect(result.constraintViolations[0].from).toBe("ui");
    expect(result.constraintViolations[0].to).toBe("server");
    expect(result.constraintViolations[0].reason).toBe(
      "UI must use API layer, not import server directly",
    );
    expect(result.constraintViolations[0].edges.length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("does not flag constraints where no violation exists", () => {
    const config = standardConfig();
    config.constraints = [
      {
        type: "no-direct-dependency",
        from: "core",
        to: "server",
        reason: "Core must not import server",
      },
    ];

    const result = archCheckFromDb(db, config);
    expect(result.constraintViolations).toHaveLength(0);
  });

  it("assigns files to correct components", () => {
    const result = archCheckFromDb(db, standardConfig());

    const server = result.componentSummary.find((c) => c.name === "server")!;
    expect(server.fileCount).toBe(3);

    const core = result.componentSummary.find((c) => c.name === "core")!;
    expect(core.fileCount).toBe(2);

    const dbComp = result.componentSummary.find((c) => c.name === "db")!;
    expect(dbComp.fileCount).toBe(2);

    const ui = result.componentSummary.find((c) => c.name === "ui")!;
    expect(ui.fileCount).toBe(3);
  });

  it("computes conformance percentage correctly", () => {
    const result = archCheckFromDb(db, standardConfig());

    // 4 declared flows (all confirmed) + 1 undocumented = 5 total checks
    // conformance = 4 / 5 = 80%
    expect(result.summary.confirmedFlows).toBe(4);
    expect(result.summary.missingFlows).toBe(0);
    expect(result.summary.undocumentedFlows).toBeGreaterThanOrEqual(1);
    expect(result.summary.conformancePercent).toBeLessThan(100);
    expect(result.summary.conformancePercent).toBeGreaterThan(0);
  });

  it("returns 100% conformance when all flows match and no undocumented", () => {
    // Add ui → server as a declared flow so nothing is undocumented
    const config = standardConfig();
    config.flows!.push({ from: "ui", to: "server" });

    const result = archCheckFromDb(db, config);
    expect(result.summary.missingFlows).toBe(0);
    expect(result.summary.undocumentedFlows).toBe(0);
    expect(result.summary.constraintViolations).toBe(0);
    expect(result.summary.conformancePercent).toBe(100);
  });

  it("returns empty result for config with no components", () => {
    const result = archCheckFromDb(db, { components: [] });
    expect(result.flows).toHaveLength(0);
    expect(result.undocumented).toHaveLength(0);
    expect(result.constraintViolations).toHaveLength(0);
    expect(result.summary.conformancePercent).toBe(100);
  });

  it("handles config with components but no flows/constraints", () => {
    const config: ArchConfig = {
      components: [
        { name: "server", files: ["src/server/**"] },
        { name: "core", files: ["src/core/**"] },
      ],
    };

    const result = archCheckFromDb(db, config);
    expect(result.flows).toHaveLength(0);
    // Should still detect undocumented flows
    expect(result.undocumented.length).toBeGreaterThanOrEqual(1);
  });

  it("handles multi-target flows (to: array)", () => {
    const config: ArchConfig = {
      components: [
        { name: "server", files: ["src/server/**"] },
        { name: "core", files: ["src/core/**"] },
        { name: "db", files: ["src/db/**"] },
      ],
      flows: [{ from: "server", to: ["core", "db"] }],
    };

    const result = archCheckFromDb(db, config);
    const confirmed = result.flows.filter((f) => f.status === "confirmed");
    expect(confirmed).toHaveLength(2);
    expect(confirmed.map((f) => f.to).sort()).toEqual(["core", "db"]);
  });
});

describe("inferArchConfigFromKgDb", () => {
  it("builds components and flows from KG relationship triples", () => {
    const cfg = inferArchConfigFromKgDb(db, {
      minConfidence: 0.5,
      requireDiagramHints: false,
    });

    expect(cfg.components.length).toBeGreaterThanOrEqual(3);
    expect(cfg.flows).toBeDefined();
    expect(cfg.flows!.length).toBeGreaterThanOrEqual(2);

    const hasAxToAnnotator = cfg.flows!.some(
      (f) => f.from === "AX Stage" && f.to === "Annotator",
    );
    const hasAnnotatorToWriter = cfg.flows!.some(
      (f) => f.from === "Annotator" && f.to === "Writer",
    );
    expect(hasAxToAnnotator).toBe(true);
    expect(hasAnnotatorToWriter).toBe(true);
  });

  it("ignores non-flow predicates and low-confidence triples", () => {
    const cfg = inferArchConfigFromKgDb(db, {
      minConfidence: 0.5,
      requireDiagramHints: false,
    });

    const hasMiscFlow = cfg.flows!.some(
      (f) => f.from === "AX Stage" && f.to === "Misc",
    );
    expect(hasMiscFlow).toBe(false);
  });

  it("maps components to files via annotation-symbol links", () => {
    const cfg = inferArchConfigFromKgDb(db, {
      minConfidence: 0.5,
      requireDiagramHints: false,
    });

    const annotator = cfg.components.find((c) => c.name === "Annotator");
    expect(annotator).toBeDefined();
    expect(annotator!.files.some((f) => f.includes("annotator.ts"))).toBe(true);
  });
});

// =============================================================================
// YAML Parser Tests
// =============================================================================

describe("parseArchitectureYaml", () => {
  it("parses a complete architecture config", () => {
    const yaml = `
components:
  - name: server
    files:
      - "src/server/**"
  - name: core
    files:
      - "src/core/**"

flows:
  - from: server
    to: core

constraints:
  - type: no-direct-dependency
    from: ui
    to: server
    reason: UI must use API layer
`;

    const config = parseArchitectureYaml(yaml);
    expect(config.components).toHaveLength(2);
    expect(config.components[0].name).toBe("server");
    expect(config.components[0].files).toEqual(["src/server/**"]);
    expect(config.flows).toHaveLength(1);
    expect(config.flows![0]).toEqual({ from: "server", to: "core" });
    expect(config.constraints).toHaveLength(1);
    expect(config.constraints![0].type).toBe("no-direct-dependency");
    expect(config.constraints![0].reason).toBe("UI must use API layer");
  });

  it("parses inline files array", () => {
    const yaml = `
components:
  - name: server
    files: ["src/server/**", "src/api/**"]
`;

    const config = parseArchitectureYaml(yaml);
    expect(config.components[0].files).toEqual(["src/server/**", "src/api/**"]);
  });

  it("parses multi-target flows (inline array)", () => {
    const yaml = `
components:
  - name: server
    files:
      - "src/server/**"
  - name: core
    files:
      - "src/core/**"
  - name: db
    files:
      - "src/db/**"

flows:
  - from: server
    to: ["core", "db"]
`;

    const config = parseArchitectureYaml(yaml);
    expect(config.flows).toHaveLength(1);
    expect(config.flows![0].to).toEqual(["core", "db"]);
  });

  it("parses multi-target flows (list array)", () => {
    const yaml = `
components:
  - name: server
    files:
      - "src/server/**"
  - name: core
    files:
      - "src/core/**"
  - name: db
    files:
      - "src/db/**"

flows:
  - from: server
    to:
      - core
      - db
`;

    const config = parseArchitectureYaml(yaml);
    expect(config.flows).toHaveLength(1);
    expect(config.flows![0].to).toEqual(["core", "db"]);
  });

  it("throws on empty components", () => {
    expect(() =>
      parseArchitectureYaml("flows:\n  - from: a\n    to: b"),
    ).toThrow(/No components found/);
  });

  it("handles config with only components", () => {
    const yaml = `
components:
  - name: server
    files:
      - "src/server/**"
`;

    const config = parseArchitectureYaml(yaml);
    expect(config.components).toHaveLength(1);
    expect(config.flows).toHaveLength(0);
    expect(config.constraints).toHaveLength(0);
  });
});
