// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for rulesCheck (13.2 + 13.3):
 *  - matchesChainGlob: property_access chain glob matching (including $-chars and deep prefixes)
 *  - checkPropertyAccess: end-to-end property_access rule evaluation
 *  - checkCall: call rule evaluation
 *  - checkImportPattern: import rule evaluation
 *  - matchesScope: in/except/changed scope filtering
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "@intentweave/sqlite-compat";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initSchema } from "../schema.js";
import { rulesCheckFromDb } from "../queries/rulesCheck.js";
import type { RulesConfig } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpDb(): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `cari-rules-${Date.now()}.db`);
  const db = new Database(dbPath);
  initSchema(db);
  return { db, dbPath };
}

function cleanup(db: Database.Database, dbPath: string) {
  db.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

function insertPropertyAccess(
  db: Database.Database,
  file: string,
  chain: string,
  symbolName: string | null = null,
  line = 10,
) {
  db.prepare(
    `INSERT INTO property_accesses (file, symbol_name, line, chain, root, depth)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    file,
    symbolName,
    line,
    chain,
    chain.split(".")[0],
    chain.split(".").length,
  );
}

function insertCall(
  db: Database.Database,
  callerFile: string,
  calleeName: string,
  callerName: string | null = null,
  callerLine = 5,
  isMethod = 0,
) {
  db.prepare(
    `INSERT INTO symbol_calls (caller_file, caller_name, caller_line, callee_name, callee_id, is_method)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(callerFile, callerName, callerLine, calleeName, isMethod);
}

function insertImport(
  db: Database.Database,
  sourceFile: string,
  moduleSpecifier: string,
  targetFile: string | null = null,
  line: number | null = null,
) {
  db.prepare(
    `INSERT INTO imports (source_file, module_specifier, target_file, line, is_relative)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(sourceFile, moduleSpecifier, targetFile, line);
}

function insertVariableAssignment(
  db: Database.Database,
  file: string,
  line: number,
  symbolName: string,
  valueText: string,
  context: string | null = null,
) {
  db.prepare(
    `INSERT INTO variable_assignments (file, line, symbol_name, value_text, context)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(file, line, symbolName, valueText, context);
}

function insertDefUse(
  db: Database.Database,
  file: string,
  fn: string | null,
  defLine: number,
  varName: string,
  useLine: number,
  useContext: string,
) {
  db.prepare(
    `INSERT INTO def_use_chains (file, function, def_line, var_name, use_line, use_context)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(file, fn, defLine, varName, useLine, useContext);
}

// ── matchesChainGlob unit tests (via rulesCheckFromDb) ────────────────────────

describe("matchesChainGlob — property_access rule", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    // Seed realistic property access chains from the ARC-372 evaluation
    insertPropertyAccess(
      db,
      "src/views/EcuView.tsx",
      "entity.source.path",
      "renderConfig",
      42,
    );
    insertPropertyAccess(
      db,
      "src/views/FrameView.tsx",
      "x.entity.source.path",
      "buildTree",
      18,
    );
    insertPropertyAccess(
      db,
      "src/views/EventView.tsx",
      "param.$ref",
      "handleRef",
      77,
    );
    insertPropertyAccess(
      db,
      "src/views/EventView.tsx",
      "r.ecu.$ref",
      "handleRef",
      80,
    );
    insertPropertyAccess(
      db,
      "src/views/SignalView.tsx",
      "signal.unit.value",
      "format",
      33,
    );
    // Chains that should NOT match **.source.path
    insertPropertyAccess(
      db,
      "src/utils/helper.ts",
      "entity.source",
      "getSource",
      5,
    );
    insertPropertyAccess(
      db,
      "src/utils/helper.ts",
      "source.path.split",
      "split",
      9,
    );
  });

  afterAll(() => cleanup(db, dbPath));

  it("**.source.path matches entity.source.path (ARC-372 adr003 core case)", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-source-path",
          description: "test",
          severity: "high",
          forbidden: [{ type: "property_access", chain: "**.source.path" }],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const files = result.violations.map((v) => v.filePath);
    expect(files).toContain("src/views/EcuView.tsx");
    expect(files).toContain("src/views/FrameView.tsx");
    // entity.source (only 2 segments) should not match **.source.path
    expect(files).not.toContain("src/utils/helper.ts");
  });

  it("**.$ref matches param.$ref and r.ecu.$ref (dollar-sign in property name)", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-ref-prop",
          description: "test",
          severity: "high",
          forbidden: [
            {
              type: "property_access",
              chain: "**.$ref",
              in: "src/views/**",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const lines = result.violations.map((v) => v.line);
    expect(lines).toContain(77); // param.$ref
    expect(lines).toContain(80); // r.ecu.$ref
    expect(result.violations.length).toBe(2);
  });

  it("exact three-segment pattern matches only full chain", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "exact",
          description: "test",
          severity: "low",
          forbidden: [{ type: "property_access", chain: "signal.unit.value" }],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].filePath).toBe("src/views/SignalView.tsx");
  });

  it("** alone matches any chain of any depth", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "all",
          description: "test",
          severity: "low",
          forbidden: [
            {
              type: "property_access",
              chain: "**",
              in: "src/views/SignalView.tsx",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("single-segment wildcard *.source.path does NOT match entity.source.path prefix with dots", () => {
    // *.source.path should match only `anyOneSegment.source.path` (entity = one segment = matches)
    const config: RulesConfig = {
      rules: [
        {
          id: "single-seg",
          description: "test",
          severity: "low",
          forbidden: [{ type: "property_access", chain: "*.source.path" }],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    // entity.source.path → root=entity → matches *.source.path (one segment before .source.path)
    const files = result.violations.map((v) => v.filePath);
    expect(files).toContain("src/views/EcuView.tsx");
    // x.entity.source.path has TWO segments before .source.path → should NOT match *.source.path
    expect(files).not.toContain("src/views/FrameView.tsx");
  });
});

// ── call rule ────────────────────────────────────────────────────────────────

describe("rulesCheck — call type", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    insertCall(db, "src/views/DetailView.tsx", "refToId", "loadEntity", 55, 0);
    insertCall(db, "src/utils/resolver.ts", "refToId", "resolve", 10, 0);
    insertCall(db, "src/views/PduView.tsx", "console.log", "render", 3, 1);
  });

  afterAll(() => cleanup(db, dbPath));

  it("callee regex matches by name", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-ref-to-id",
          description: "test",
          severity: "high",
          forbidden: [{ type: "call", callee: "refToId", in: "src/views/**" }],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].filePath).toBe("src/views/DetailView.tsx");
  });

  it("call rule respects `in` scope — excludes utils", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-ref-to-id-global",
          description: "test",
          severity: "medium",
          forbidden: [{ type: "call", callee: "refToId" }],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const files = result.violations.map((v) => v.filePath);
    expect(files).toContain("src/views/DetailView.tsx");
    expect(files).toContain("src/utils/resolver.ts");
    expect(result.violations.length).toBe(2);
  });
});

describe("rulesCheck — taint_propagation (16.1)", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());

    // Base forbidden property access on assignment line
    insertPropertyAccess(
      db,
      "src/views/EntityView.tsx",
      "entity.source.path",
      "renderEntity",
      10,
    );
    insertVariableAssignment(
      db,
      "src/views/EntityView.tsx",
      10,
      "sourcePath",
      "entity.source.path",
      "renderEntity",
    );
    insertDefUse(
      db,
      "src/views/EntityView.tsx",
      "renderEntity",
      10,
      "sourcePath",
      12,
      "call_arg",
    );
    insertDefUse(
      db,
      "src/views/EntityView.tsx",
      "renderEntity",
      10,
      "sourcePath",
      14,
      "return",
    );

    // Base forbidden call on assignment line
    insertCall(
      db,
      "src/views/EntityView.tsx",
      "refToId",
      "renderEntity",
      30,
      0,
    );
    insertVariableAssignment(
      db,
      "src/views/EntityView.tsx",
      30,
      "resolved",
      "refToId(entityId)",
      "renderEntity",
    );
    insertDefUse(
      db,
      "src/views/EntityView.tsx",
      "renderEntity",
      30,
      "resolved",
      33,
      "property_access",
    );
  });

  afterAll(() => cleanup(db, dbPath));

  it("adds downstream propagated violations for property_access", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-source-path",
          description: "forbid source.path",
          severity: "high",
          forbidden: [
            {
              type: "property_access",
              chain: "**.source.path",
              taint_propagation: true,
              in: "src/views/**",
            },
          ],
        },
      ],
    };

    const result = rulesCheckFromDb(db, config);
    const lines = result.violations.map((v) => v.line);

    // Base violation + propagated def-use violations.
    expect(lines).toContain(10);
    expect(lines).toContain(12);
    expect(lines).toContain(14);
  });

  it("adds downstream propagated violations for call", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-ref-to-id",
          description: "forbid refToId",
          severity: "high",
          forbidden: [
            {
              type: "call",
              callee: "refToId",
              taint_propagation: true,
              in: "src/views/**",
            },
          ],
        },
      ],
    };

    const result = rulesCheckFromDb(db, config);
    const lines = result.violations.map((v) => v.line);

    expect(lines).toContain(30);
    expect(lines).toContain(33);
  });
});

// ── import_pattern rule ───────────────────────────────────────────────────────

describe("rulesCheck — import_pattern type", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    insertImport(db, "src/views/PduView.tsx", "lodash", null, 3);
    insertImport(db, "src/utils/helper.ts", "lodash", null);
    insertImport(
      db,
      "src/views/SignalView.tsx",
      "@company/api-client",
      null,
      11,
    );
    insertImport(db, "src/views/IoView.tsx", "node:fs/promises", null, 22);
    insertImport(db, "src/views/PathView.tsx", "node:path", null, 7);
  });

  afterAll(() => cleanup(db, dbPath));

  it("import glob matches module specifier", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-lodash-in-views",
          description: "test",
          severity: "low",
          forbidden: [
            { type: "import_pattern", pattern: "lodash", in: "src/views/**" },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].filePath).toBe("src/views/PduView.tsx");
    expect(result.violations[0].line).toBe(3);
  });

  it("`**` in import_pattern matches across `/` in module specifiers", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-node-fs-family",
          description: "test",
          severity: "high",
          forbidden: [
            {
              type: "import_pattern",
              pattern: "node:fs**",
              in: "src/views/**",
            },
          ],
        },
      ],
    };

    const result = rulesCheckFromDb(db, config);
    expect(result.violations.map((v) => v.filePath)).toEqual([
      "src/views/IoView.tsx",
    ]);
    expect(result.violations[0].line).toBe(22);
  });

  it("regex mode for import_pattern works when regex=true", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "regex-node-fs",
          description: "test",
          severity: "high",
          forbidden: [
            {
              type: "import_pattern",
              pattern: "^node:fs/",
              regex: true,
              in: "src/views/**",
            },
          ],
        },
      ],
    };

    const result = rulesCheckFromDb(db, config);
    expect(result.violations.map((v) => v.filePath)).toEqual([
      "src/views/IoView.tsx",
    ]);
  });
});

// ── severity threshold ────────────────────────────────────────────────────────

describe("rulesCheck — severity threshold filtering", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    insertPropertyAccess(db, "src/a.ts", "a.b.c");
  });

  afterAll(() => cleanup(db, dbPath));

  it("severity=high filters out medium and low rules", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "r-high",
          description: "h",
          severity: "high",
          forbidden: [{ type: "property_access", chain: "a.b.c" }],
        },
        {
          id: "r-medium",
          description: "m",
          severity: "medium",
          forbidden: [{ type: "property_access", chain: "a.b.c" }],
        },
        {
          id: "r-low",
          description: "l",
          severity: "low",
          forbidden: [{ type: "property_access", chain: "a.b.c" }],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config, { severity: "high" });
    expect(result.rulesChecked).toBe(1);
    expect(result.violations[0].ruleId).toBe("r-high");
  });
});

// ── incremental (changed) filtering ──────────────────────────────────────────

describe("rulesCheck — incremental --changed filtering", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    insertPropertyAccess(db, "src/views/EcuView.tsx", "entity.source.path");
    insertPropertyAccess(db, "src/views/FrameView.tsx", "entity.source.path");
  });

  afterAll(() => cleanup(db, dbPath));

  it("changed list limits violations to listed files only", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "r",
          description: "test",
          severity: "high",
          forbidden: [{ type: "property_access", chain: "**.source.path" }],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config, {
      changed: ["src/views/EcuView.tsx"],
    });
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].filePath).toBe("src/views/EcuView.tsx");
  });
});

// ── symbol_name scope modifier (13.9) ─────────────────────────────────────────

describe("rulesCheck — symbol_name scope modifier (13.9)", () => {
  let db: Database.Database;
  let dbPath: string;

  function insertSymbol(
    d: Database.Database,
    name: string,
    filePath: string,
    exportVal: "exported" | "internal",
    container: string | null = null,
    line = 10,
  ) {
    const id = `${filePath}::${name}`;
    d.prepare(
      `INSERT OR IGNORE INTO symbols (id, name, kind, file_path, line, export, container)
       VALUES (?, ?, 'function', ?, ?, ?, ?)`,
    ).run(id, name, filePath, line, exportVal, container);
  }

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    // exported top-level
    insertSymbol(db, "badName", "src/views/A.tsx", "exported", null, 5);
    // internal top-level (not exported)
    insertSymbol(db, "badName", "src/views/B.tsx", "internal", null, 10);
    // internal nested (has container) — should only show up for scope:any phase-2
    insertSymbol(db, "badName", "src/views/C.tsx", "internal", "outerFn", 15);
    // a symbol with a different name — should never appear
    insertSymbol(db, "goodName", "src/views/D.tsx", "exported", null, 20);
  });

  afterAll(() => cleanup(db, dbPath));

  it("scope:exported (default) only matches exported symbols", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "r-exported",
          severity: "high",
          forbidden: [
            { type: "symbol_name", pattern: "badName", scope: "exported" },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const files = result.violations.map((v) => v.filePath);
    expect(files).toContain("src/views/A.tsx");
    expect(files).not.toContain("src/views/B.tsx"); // internal
    expect(files).not.toContain("src/views/C.tsx"); // nested
  });

  it("default scope (no scope field) behaves like scope:exported", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "r-default",
          severity: "high",
          forbidden: [{ type: "symbol_name", pattern: "badName" }],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const files = result.violations.map((v) => v.filePath);
    expect(files).toContain("src/views/A.tsx");
    expect(files).not.toContain("src/views/B.tsx");
  });

  it("scope:top-level matches exported + internal top-level but not nested", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "r-toplevel",
          severity: "high",
          forbidden: [
            { type: "symbol_name", pattern: "badName", scope: "top-level" },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const files = result.violations.map((v) => v.filePath);
    expect(files).toContain("src/views/A.tsx"); // exported top-level
    expect(files).toContain("src/views/B.tsx"); // internal top-level
    expect(files).not.toContain("src/views/C.tsx"); // nested — Phase 2 only
  });

  it("scope:any (Phase 1) behaves like top-level — nested locals not yet indexed", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "r-any",
          severity: "high",
          forbidden: [
            { type: "symbol_name", pattern: "badName", scope: "any" },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const files = result.violations.map((v) => v.filePath);
    expect(files).toContain("src/views/A.tsx");
    expect(files).toContain("src/views/B.tsx");
    // C.tsx has container='outerFn' so it's excluded in Phase 1
    expect(files).not.toContain("src/views/C.tsx");
  });
});

// ── 13.10: variable_assignment ───────────────────────────────────────────────

describe("checkVariableAssignment (13.10)", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    const ins = db.prepare(
      `INSERT INTO variable_assignments (file, line, symbol_name, value_text, context) VALUES (?, ?, ?, ?, ?)`,
    );
    ins.run("src/config.ts", 10, "cache", "new Map()", null);
    ins.run("src/config.ts", 20, "items", '["a","b"]', null);
    ins.run("src/other.ts", 5, "cache", "new Map()", null);
  });

  afterAll(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("flags variables whose RHS matches value_pattern", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-new-map",
          severity: "high",
          forbidden: [
            { type: "variable_assignment", value_pattern: "^new Map" },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.every((v) => v.detail.includes("new Map"))).toBe(
      true,
    );
  });

  it("returns no violations when pattern does not match", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-set",
          severity: "low",
          forbidden: [
            { type: "variable_assignment", value_pattern: "^new Set" },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations).toHaveLength(0);
  });

  it("respects in: scope filter", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-new-map-config",
          severity: "high",
          forbidden: [
            {
              type: "variable_assignment",
              value_pattern: "new Map",
              in: ["src/config.ts"],
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const files = result.violations.map((v) => v.filePath);
    expect(files).toContain("src/config.ts");
    expect(files).not.toContain("src/other.ts");
  });

  it("returns no violations when value_pattern is absent", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-pattern",
          severity: "low",
          forbidden: [{ type: "variable_assignment" } as never],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations).toHaveLength(0);
  });
});

// ── 13.11: cypher (Phase 2 CypherLite over CARI) ────────────────────────────

describe("checkCypherRule (13.11)", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    db.prepare(
      `INSERT INTO files (path, doc_group, is_doc, indexed) VALUES (?, ?, 0, 1)`,
    ).run("src/ui/view.tsx", "ui");
    db.prepare(
      `INSERT INTO files (path, doc_group, is_doc, indexed) VALUES (?, ?, 0, 1)`,
    ).run("src/data/store.ts", "data");

    db.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, line, is_relative)
       VALUES (?, ?, ?, ?, 1)`,
    ).run("src/ui/view.tsx", "src/data/store.ts", "../data/store", 12);

    db.prepare(
      `INSERT INTO symbols (id, name, kind, file_path, line, export)
       VALUES (?, ?, 'function', ?, ?, 'exported')`,
    ).run("sym:AuthService", "AuthService", "src/domain/auth.ts", 40);

    db.prepare(
      `INSERT INTO symbol_calls (caller_file, caller_name, caller_line, callee_name, callee_id, is_method)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run("src/app/main.ts", "boot", 9, "AuthService", "sym:AuthService");

    db.prepare(
      `INSERT INTO symbols (id, name, kind, file_path, line, export)
       VALUES (?, ?, 'function', ?, ?, 'exported')`,
    ).run(
      "sym:DocumentedService",
      "DocumentedService",
      "src/domain/documented.ts",
      55,
    );

    db.prepare(
      `INSERT INTO symbol_calls (caller_file, caller_name, caller_line, callee_name, callee_id, is_method)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(
      "src/app/main.ts",
      "boot",
      10,
      "DocumentedService",
      "sym:DocumentedService",
    );

    db.prepare(
      `INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "docs/architecture.md",
      20,
      "Documented service coverage",
      "sym:DocumentedService",
      0.95,
      "identifier",
    );
  });

  afterAll(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  it("returns violations for MATCH traversal over CARI import graph", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-ui-to-data",
          severity: "high",
          forbidden: [
            {
              type: "cypher",
              query: `
                MATCH (a:File {layer: 'ui'})-[:IMPORTS]->(b:File {layer: 'data'})
                RETURN a.path AS file, null AS line,
                       'Direct ui→data import: ' + a.path + ' -> ' + b.path AS detail
              `,
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].filePath).toBe("src/ui/view.tsx");
    expect(result.violations[0].detail).toContain("Direct ui→data import");
  });

  it("supports fan_in + NOT EXISTS relationship checks", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-undocumented-hub",
          severity: "medium",
          forbidden: [
            {
              type: "cypher",
              query: `
                MATCH (s:Symbol)
                WHERE s.fan_in > 0
                  AND NOT EXISTS { MATCH (s)-[:ANNOTATED_BY]->(:DocSpan) }
                RETURN s.file AS file, s.line AS line,
                       s.name + ' has fan_in>0 but no doc annotation' AS detail
              `,
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].filePath).toBe("src/domain/auth.ts");
    expect(result.violations[0].line).toBe(40);
    expect(result.violations[0].detail).toContain("AuthService");
    expect(
      result.violations.some((v) => v.detail.includes("DocumentedService")),
    ).toBe(false);
  });

  it("returns no violations when query field is absent", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "no-query",
          severity: "low",
          forbidden: [{ type: "cypher" } as never],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations).toHaveLength(0);
  });

  it("keeps raw SQL compatibility as fallback", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "sql-fallback",
          severity: "low",
          forbidden: [
            {
              type: "cypher",
              query:
                "SELECT path AS file, NULL AS line, 'sql-ok' AS detail FROM files WHERE path = 'src/ui/view.tsx'",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].detail).toBe("sql-ok");
  });

  it("returns no violations on invalid cypher", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "bad-cypher",
          severity: "low",
          forbidden: [
            { type: "cypher", query: "MATCH (a:File RETURN a.path AS file" },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations).toHaveLength(0);
  });
});

// ── 15.x Sprint: context_import, except_symbol, property_chain_length, count_mode, autofix ──

describe("15.x sprint features", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());

    // seed a couple of source files
    db.prepare(
      `INSERT INTO files (path, last_modified, churn) VALUES (?, 0, 0), (?, 0, 0)`,
    ).run("src/alpha.ts", "src/beta.ts");

    // symbols
    db.prepare(
      `INSERT INTO symbols (id, name, kind, file_path, line, export)
       VALUES ('s1', 'alphaFn', 'function', 'src/alpha.ts', 10, 1),
              ('s2', 'betaFn', 'function', 'src/beta.ts', 5, 1)`,
    ).run();

    // property_accesses
    db.prepare(
      `CREATE TABLE IF NOT EXISTS property_accesses (
         id INTEGER PRIMARY KEY,
         file TEXT NOT NULL,
         symbol_name TEXT,
         line INTEGER,
         chain TEXT NOT NULL,
         root TEXT NOT NULL,
         depth INTEGER NOT NULL
       )`,
    ).run();

    db.prepare(
      `INSERT INTO property_accesses (file, symbol_name, line, chain, root, depth)
       VALUES
         ('src/alpha.ts', 'alphaFn', 10, 'entity.a.b.c', 'entity', 4),
         ('src/alpha.ts', 'excludedFn', 20, 'entity.x.y.z', 'entity', 4),
         ('src/beta.ts',  'betaFn',  5,  'obj.p.q',       'obj',    3)`,
    ).run();

    // imports — alpha imports from @heavy/lib, beta does not
    db.prepare(
      `INSERT INTO imports (source_file, target_file, module_specifier, line, is_relative, imported_names)
       VALUES ('src/alpha.ts', NULL, '@heavy/lib/index', 1, 0, NULL)`,
    ).run();

    // symbol_calls — for except_symbol via call rule
    db.prepare(
      `INSERT OR IGNORE INTO symbol_calls (caller_file, caller_name, caller_line, callee_name, is_method)
       VALUES
         ('src/alpha.ts', 'alphaFn',    15, 'legacyHelper', 0),
         ('src/alpha.ts', 'safeWrapper', 30, 'legacyHelper', 0),
         ('src/beta.ts',  'betaFn',     8,  'legacyHelper', 0)`,
    ).run();
  });

  afterAll(() => {
    db.close();
    fs.unlinkSync(dbPath);
  });

  // 15.1 context_import
  it("15.1 context_import: only flags files that import matching module", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "call-context-import",
          severity: "high",
          forbidden: [
            {
              type: "call",
              callee: "legacyHelper",
              context_import: "@heavy/lib/**",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    // only alpha.ts imports @heavy/lib — beta.ts should be excluded
    expect(result.violations.every((v) => v.filePath === "src/alpha.ts")).toBe(
      true,
    );
    expect(result.violations.some((v) => v.filePath === "src/beta.ts")).toBe(
      false,
    );
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
  });

  // 15.2 except_symbol
  it("15.2 except_symbol: suppresses violations in excluded functions", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "call-except-symbol",
          severity: "medium",
          forbidden: [
            {
              type: "call",
              callee: "legacyHelper",
              except_symbol: "safeWrapper",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const callers = result.violations.map((v) => v.symbol);
    expect(callers).not.toContain("safeWrapper");
    expect(callers).toContain("alphaFn"); // still flagged
  });

  // 15.3 property_chain_length
  it("15.3 property_chain_length: flags chains at or above min_depth", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "chain-depth",
          severity: "low",
          forbidden: [
            {
              type: "property_chain_length",
              min_depth: 4,
              root: "entity",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    // depth=4 chains on entity root in alpha.ts — both alphaFn row AND excludedFn row
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations.every((v) => v.filePath === "src/alpha.ts")).toBe(
      true,
    );
    expect(result.violations[0].detail).toMatch(/property chain/);
  });

  it("15.3 property_chain_length: except_symbol excludes matching function", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "chain-depth-exc",
          severity: "low",
          forbidden: [
            {
              type: "property_chain_length",
              min_depth: 4,
              root: "entity",
              except_symbol: "excludedFn",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const symbols = result.violations.map((v) => v.symbol);
    expect(symbols).not.toContain("excludedFn");
    expect(symbols).toContain("alphaFn");
  });

  // 15.4 count_mode: per_file
  it("15.4 count_mode per_file: deduplicates violations to one per file", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "per-file-rule",
          severity: "low",
          count_mode: "per_file",
          forbidden: [
            {
              type: "property_chain_length",
              min_depth: 4,
              root: "entity",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    const files = result.violations.map((v) => v.filePath);
    const uniqueFiles = [...new Set(files)];
    expect(files.length).toBe(uniqueFiles.length);
  });

  // 15.5 autofix
  it("15.5 autofix: violation carries hint from rule definition", () => {
    const config: RulesConfig = {
      rules: [
        {
          id: "autofix-rule",
          severity: "low",
          autofix: {
            hint: "Replace with safeWrapper()",
            reference: "docs/MIGRATION.md",
          },
          forbidden: [
            {
              type: "call",
              callee: "legacyHelper",
            },
          ],
        },
      ],
    };
    const result = rulesCheckFromDb(db, config);
    expect(result.violations.length).toBeGreaterThan(0);
    for (const v of result.violations) {
      expect(v.autofix).toBeDefined();
      expect(v.autofix!.hint).toBe("Replace with safeWrapper()");
      expect(v.autofix!.reference).toBe("docs/MIGRATION.md");
    }
  });
});
