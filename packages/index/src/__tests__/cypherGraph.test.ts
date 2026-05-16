// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the CARI Cypher graph projection (cypherGraph.ts).
 *
 * Uses a real in-memory CARI schema (via initSchema) seeded with symbols,
 * imports, and symbol_calls data to test:
 *
 *   - SYMBOL / FILE node queries
 *   - CALLS relationship traversal (single-hop)
 *   - Variable-length CALLS*1..N transitive path queries (regression for
 *     the recursive CTE outer-alias bug fixed in transpiler.ts)
 *   - DEFINES relationship
 *   - callerLine / isMethod property access on CALLS edges
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../schema.js";
import { runCypherQuery } from "../queries/cypherGraph.js";

// ── DB setup ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

/**
 * Seed a minimal call graph:
 *
 *   handleRequest → parseBody → validateInput → persistRecord
 *                                             ↘
 *                                             logEvent
 *
 * Files:
 *   src/handler.ts  — handleRequest
 *   src/parser.ts   — parseBody
 *   src/validator.ts — validateInput, logEvent
 *   src/db.ts       — persistRecord
 */
function seedCallGraph(db: Database.Database): void {
  // Symbols
  const syms = [
    {
      id: "s1",
      name: "handleRequest",
      kind: "function",
      file: "src/handler.ts",
      line: 10,
      endLine: 30,
    },
    {
      id: "s2",
      name: "parseBody",
      kind: "function",
      file: "src/parser.ts",
      line: 5,
      endLine: 20,
    },
    {
      id: "s3",
      name: "validateInput",
      kind: "function",
      file: "src/validator.ts",
      line: 8,
      endLine: 25,
    },
    {
      id: "s4",
      name: "persistRecord",
      kind: "function",
      file: "src/db.ts",
      line: 3,
      endLine: 15,
    },
    {
      id: "s5",
      name: "logEvent",
      kind: "function",
      file: "src/validator.ts",
      line: 30,
      endLine: 40,
    },
  ];
  const symStmt = db.prepare(`
    INSERT OR REPLACE INTO symbols
      (id, name, kind, container, signature, file_path, line, end_line, export,
       doc_summary, body_hash, body_lines, structure_hash, implements,
       deprecated, deprecated_note, is_internal, decorators)
    VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 1, NULL, 'hash', NULL, NULL, NULL, 0, NULL, 0, NULL)
  `);
  for (const s of syms) {
    symStmt.run(s.id, s.name, s.kind, s.file, s.line, s.endLine);
  }

  // Files
  const fileStmt = db.prepare(`
    INSERT OR REPLACE INTO files (path, last_modified, churn, is_hotspot, primary_owner, bus_factor, is_doc, content_hash)
    VALUES (?, NULL, 0, 0, NULL, NULL, 0, 'fhash')
  `);
  for (const f of [
    "src/handler.ts",
    "src/parser.ts",
    "src/validator.ts",
    "src/db.ts",
  ]) {
    fileStmt.run(f);
  }

  // Imports (handler → parser → validator, validator → db)
  const impStmt = db.prepare(
    `INSERT INTO imports (source_file, target_file, module_specifier, line, is_relative) VALUES (?, ?, ?, NULL, 1)`,
  );
  impStmt.run("src/handler.ts", "src/parser.ts", "./parser");
  impStmt.run("src/parser.ts", "src/validator.ts", "./validator");
  impStmt.run("src/validator.ts", "src/db.ts", "./db");

  // Call graph edges
  const callStmt = db.prepare(`
    INSERT INTO symbol_calls (caller_file, caller_name, caller_line, callee_name, callee_id, is_method)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  callStmt.run("src/handler.ts", "handleRequest", 15, "parseBody", "s2", 0);
  callStmt.run("src/parser.ts", "parseBody", 10, "validateInput", "s3", 0);
  callStmt.run(
    "src/validator.ts",
    "validateInput",
    9,
    "persistRecord",
    "s4",
    0,
  );
  callStmt.run("src/validator.ts", "validateInput", 20, "logEvent", "s5", 1); // isMethod=1
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CARI Cypher graph — basic node queries", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedCallGraph(db);
  });
  afterEach(() => {
    db.close();
  });

  it("queries SYMBOL nodes by name", () => {
    const r = runCypherQuery(
      db,
      "MATCH (n:Symbol) WHERE n.name = 'handleRequest' RETURN n.name, n.type",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]["n.name"]).toBe("handleRequest");
    expect(r.rows[0]["n.type"]).toBe("SYMBOL");
  });

  it("queries all FILE nodes", () => {
    const r = runCypherQuery(db, "MATCH (f:File) RETURN f.name");
    expect(r.rows.length).toBeGreaterThanOrEqual(4);
  });

  it("returns symbol file property", () => {
    const r = runCypherQuery(
      db,
      "MATCH (n:Symbol) WHERE n.name = 'parseBody' RETURN n.file",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]["n.file"]).toBe("src/parser.ts");
  });
});

describe("CARI Cypher graph — CALLS relationship (single hop)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedCallGraph(db);
  });
  afterEach(() => {
    db.close();
  });

  it("finds direct callee of a symbol", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[r:CALLS]->(b:Symbol) WHERE a.name = $caller RETURN b.name",
      { caller: "handleRequest" },
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]["b.name"]).toBe("parseBody");
  });

  it("finds direct callers of a symbol (reverse)", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[r:CALLS]->(b:Symbol) WHERE b.name = 'validateInput' RETURN a.name",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]["a.name"]).toBe("parseBody");
  });

  it("exposes callerLine on CALLS relationship", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[r:CALLS]->(b:Symbol) WHERE a.name = 'handleRequest' RETURN r.callerLine",
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0]["r.callerLine"])).toBe(15);
  });

  it("exposes isMethod on CALLS relationship (1 = true)", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[r:CALLS]->(b:Symbol) WHERE b.name = 'logEvent' RETURN r.isMethod",
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0]["r.isMethod"])).toBe(1);
  });

  it("isMethod is 0 for non-method calls", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[r:CALLS]->(b:Symbol) WHERE a.name = 'handleRequest' RETURN r.isMethod",
    );
    expect(Number(r.rows[0]["r.isMethod"])).toBe(0);
  });

  it("validateInput calls two functions", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[:CALLS]->(b:Symbol) WHERE a.name = 'validateInput' RETURN b.name ORDER BY b.name",
    );
    expect(r.rows).toHaveLength(2);
    const names = r.rows.map((row) => row["b.name"]);
    expect(names).toContain("persistRecord");
    expect(names).toContain("logEvent");
  });
});

describe("CARI Cypher graph — CALLS*N transitive paths (recursive CTE regression)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedCallGraph(db);
  });
  afterEach(() => {
    db.close();
  });

  it("finds 2-hop reachable nodes from handleRequest", () => {
    // handleRequest → parseBody → validateInput
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[:CALLS*1..4]->(b:Symbol) WHERE a.name = $start RETURN b.name",
      { start: "handleRequest" },
    );
    const names = r.rows.map((row) => row["b.name"]);
    // Immediate callee
    expect(names).toContain("parseBody");
    // 2-hop
    expect(names).toContain("validateInput");
  });

  it("finds 3-hop reachable nodes from handleRequest", () => {
    // handleRequest → parseBody → validateInput → persistRecord / logEvent
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[:CALLS*1..4]->(b:Symbol) WHERE a.name = $start RETURN DISTINCT b.name",
      { start: "handleRequest" },
    );
    const names = r.rows.map((row) => row["b.name"]);
    expect(names).toContain("persistRecord");
    expect(names).toContain("logEvent");
  });

  it("does not include the start node itself in transitive results", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[:CALLS*1..4]->(b:Symbol) WHERE a.name = 'handleRequest' RETURN b.name",
    );
    const names = r.rows.map((row) => row["b.name"]);
    expect(names).not.toContain("handleRequest");
  });

  it("minHop=2 excludes direct callee (1-hop)", () => {
    // Only 2-hop+ results: validateInput, persistRecord, logEvent
    // (parseBody is 1-hop and should be excluded)
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[:CALLS*2..4]->(b:Symbol) WHERE a.name = $start RETURN DISTINCT b.name",
      { start: "handleRequest" },
    );
    const names = r.rows.map((row) => row["b.name"]);
    expect(names).not.toContain("parseBody"); // excluded by minHop=2
    expect(names).toContain("validateInput"); // 2-hop
    expect(names).toContain("persistRecord"); // 3-hop
  });

  it("maxHop=1 returns only direct callees", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[:CALLS*1..1]->(b:Symbol) WHERE a.name = $start RETURN b.name",
      { start: "handleRequest" },
    );
    const names = r.rows.map((row) => row["b.name"]);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe("parseBody");
  });

  it("returns empty for a symbol with no callees", () => {
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[:CALLS*1..4]->(b:Symbol) WHERE a.name = 'persistRecord' RETURN b.name",
    );
    expect(r.rows).toHaveLength(0);
  });

  it("reverse path: finds all callers up to 3 hops", () => {
    // persistRecord ← validateInput ← parseBody ← handleRequest
    const r = runCypherQuery(
      db,
      "MATCH (a:Symbol)-[:CALLS*1..4]->(b:Symbol) WHERE b.name = 'persistRecord' RETURN a.name",
    );
    const names = r.rows.map((row) => row["a.name"]);
    expect(names).toContain("validateInput");
    expect(names).toContain("parseBody");
    expect(names).toContain("handleRequest");
  });
});

describe("CARI Cypher graph — DEFINES relationship", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedCallGraph(db);
  });
  afterEach(() => {
    db.close();
  });

  it("finds symbols defined in a file via DEFINES edge", () => {
    const r = runCypherQuery(
      db,
      "MATCH (f:File)-[:DEFINES]->(s:Symbol) WHERE f.name = 'src/validator.ts' RETURN s.name ORDER BY s.name",
    );
    const names = r.rows.map((row) => row["s.name"]);
    expect(names).toContain("validateInput");
    expect(names).toContain("logEvent");
  });

  it("finds the file that defines a symbol (reverse DEFINES)", () => {
    const r = runCypherQuery(
      db,
      "MATCH (f:File)-[:DEFINES]->(s:Symbol) WHERE s.name = 'parseBody' RETURN f.name",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]["f.name"]).toBe("src/parser.ts");
  });
});
