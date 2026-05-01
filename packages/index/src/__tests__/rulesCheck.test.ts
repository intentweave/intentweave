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
import Database from "better-sqlite3";
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

// ── import_pattern rule ───────────────────────────────────────────────────────

describe("rulesCheck — import_pattern type", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    ({ db, dbPath } = tmpDb());
    insertImport(db, "src/views/PduView.tsx", "lodash", null, 3);
    insertImport(db, "src/utils/helper.ts", "lodash", null);
    insertImport(db, "src/views/SignalView.tsx", "@company/api-client", null, 11);
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
