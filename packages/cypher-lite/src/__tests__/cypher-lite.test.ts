// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CypherLite comprehensive test suite.
 *
 * Tests tokenizer, parser, transpiler, and full engine round-trips
 * against a real SQLite database (better-sqlite3 in-memory).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  CypherLiteEngine,
  tokenize,
  parse,
  transpile,
  TokenType,
} from "../index.js";
import type { CypherLiteDatabase } from "../executor.js";

// ═══════════════════════════════════════════════════════════════════
// Tokenizer
// ═══════════════════════════════════════════════════════════════════

describe("CypherLiteTokenizer", () => {
  it("tokenizes a simple MATCH query", () => {
    const tokens = tokenize("MATCH (n) RETURN n");
    const types = tokens.map((t) => t.type);
    expect(types).toEqual([
      TokenType.MATCH,
      TokenType.LPAREN,
      TokenType.IDENTIFIER,
      TokenType.RPAREN,
      TokenType.RETURN,
      TokenType.IDENTIFIER,
      TokenType.EOF,
    ]);
  });

  it("tokenizes labels and properties", () => {
    const tokens = tokenize('MATCH (n:Entity {name: "foo"})');
    expect(tokens.find((t) => t.type === TokenType.COLON)).toBeDefined();
    expect(tokens.find((t) => t.type === TokenType.STRING)?.value).toBe("foo");
  });

  it("tokenizes parameters", () => {
    const tokens = tokenize("WHERE n.name = $name");
    const param = tokens.find((t) => t.type === TokenType.PARAMETER);
    expect(param?.value).toBe("name");
  });

  it("tokenizes relationship arrow -[r:TYPE]->", () => {
    const tokens = tokenize("-[r:TYPE]->");
    const types = tokens.map((t) => t.type);
    expect(types).toContain(TokenType.MINUS);
    expect(types).toContain(TokenType.LBRACKET);
    expect(types).toContain(TokenType.COLON);
    expect(types).toContain(TokenType.RBRACKET);
    expect(types).toContain(TokenType.ARROW_RIGHT);
  });

  it("tokenizes numbers", () => {
    const tokens = tokenize("LIMIT 10");
    expect(tokens[1].type).toBe(TokenType.NUMBER);
    expect(tokens[1].value).toBe("10");
  });

  it("tokenizes keywords case-insensitively", () => {
    const tokens = tokenize("match Return where");
    expect(tokens[0].type).toBe(TokenType.MATCH);
    expect(tokens[1].type).toBe(TokenType.RETURN);
    expect(tokens[2].type).toBe(TokenType.WHERE);
  });

  it("tokenizes variable-length path syntax", () => {
    const tokens = tokenize("[*1..3]");
    const types = tokens.map((t) => t.type);
    expect(types).toContain(TokenType.STAR);
    expect(types).toContain(TokenType.NUMBER);
    expect(types).toContain(TokenType.DOT);
  });

  it("tokenizes string with escape characters", () => {
    const tokens = tokenize(`'hello\\nworld'`);
    expect(tokens[0].value).toBe("hello\nworld");
  });

  it("rejects unterminated strings", () => {
    expect(() => tokenize(`'unterminated`)).toThrow("Unterminated string");
  });

  it("tokenizes comparison operators", () => {
    const tokens = tokenize("<> <= >=");
    expect(tokens[0].type).toBe(TokenType.NEQ);
    expect(tokens[1].type).toBe(TokenType.LTE);
    expect(tokens[2].type).toBe(TokenType.GTE);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════

describe("CypherLiteParser", () => {
  it("parses a simple MATCH RETURN", () => {
    const ast = parse("MATCH (n) RETURN n");
    expect(ast.type).toBe("CypherStatement");
    expect(ast.clauses).toHaveLength(2);
    expect(ast.clauses[0].type).toBe("MatchClause");
    expect(ast.clauses[1].type).toBe("ReturnClause");
  });

  it("parses node with label", () => {
    const ast = parse("MATCH (n:Entity) RETURN n");
    const match = ast.clauses[0];
    expect(match.type).toBe("MatchClause");
    if (match.type === "MatchClause") {
      const node = match.pattern.elements[0];
      expect(node.type).toBe("NodePattern");
      if (node.type === "NodePattern") {
        expect(node.labels).toEqual(["Entity"]);
        expect(node.variable).toBe("n");
      }
    }
  });

  it("parses multiple labels", () => {
    const ast = parse("MATCH (n:Canon:Entity) RETURN n");
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      const node = match.pattern.elements[0];
      if (node.type === "NodePattern") {
        expect(node.labels).toEqual(["Canon", "Entity"]);
      }
    }
  });

  it("parses WHERE with property comparison", () => {
    const ast = parse("MATCH (n:Entity) WHERE n.name = $name RETURN n");
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      expect(match.where).toBeDefined();
      expect(match.where?.type).toBe("ComparisonExpr");
    }
  });

  it("parses relationship pattern", () => {
    const ast = parse("MATCH (a)-[r:CALLS]->(b) RETURN a, b");
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      expect(match.pattern.elements).toHaveLength(3);
      const rel = match.pattern.elements[1];
      if (rel.type === "RelationshipPattern") {
        expect(rel.relTypes).toEqual(["CALLS"]);
        expect(rel.direction).toBe("outgoing");
        expect(rel.variable).toBe("r");
      }
    }
  });

  it("parses incoming relationship", () => {
    const ast = parse("MATCH (a)<-[r:IMPORTS]-(b) RETURN a");
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      const rel = match.pattern.elements[1];
      if (rel.type === "RelationshipPattern") {
        expect(rel.direction).toBe("incoming");
      }
    }
  });

  it("parses variable-length path", () => {
    const ast = parse("MATCH (a)-[r*1..3]->(b) RETURN b");
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      const rel = match.pattern.elements[1];
      if (rel.type === "RelationshipPattern") {
        expect(rel.variableLength).toEqual({ min: 1, max: 3 });
      }
    }
  });

  it("parses OPTIONAL MATCH", () => {
    const ast = parse("OPTIONAL MATCH (n) RETURN n");
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      expect(match.optional).toBe(true);
    }
  });

  it("parses RETURN DISTINCT", () => {
    const ast = parse("MATCH (n) RETURN DISTINCT n.name");
    const ret = ast.clauses[1];
    if (ret.type === "ReturnClause") {
      expect(ret.distinct).toBe(true);
    }
  });

  it("parses RETURN with alias", () => {
    const ast = parse("MATCH (n) RETURN n.name AS entityName");
    const ret = ast.clauses[1];
    if (ret.type === "ReturnClause") {
      expect(ret.items[0].alias).toBe("entityName");
    }
  });

  it("parses ORDER BY and LIMIT", () => {
    const ast = parse("MATCH (n) RETURN n ORDER BY n.name DESC LIMIT 10");
    const clauses = ast.clauses.map((c) => c.type);
    expect(clauses).toContain("OrderByClause");
    expect(clauses).toContain("LimitClause");
  });

  it("parses function calls", () => {
    const ast = parse("MATCH (n) RETURN count(n) AS cnt");
    const ret = ast.clauses[1];
    if (ret.type === "ReturnClause") {
      const expr = ret.items[0].expression;
      expect(expr.type).toBe("FunctionCallExpr");
      if (expr.type === "FunctionCallExpr") {
        expect(expr.name).toBe("count");
      }
    }
  });

  it("parses CONTAINS predicate", () => {
    const ast = parse("MATCH (n) WHERE n.name CONTAINS 'auth' RETURN n");
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      expect(match.where?.type).toBe("ContainsExpr");
    }
  });

  it("parses IS NOT NULL", () => {
    const ast = parse("MATCH (n) WHERE n.name IS NOT NULL RETURN n");
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      expect(match.where?.type).toBe("IsNullExpr");
      if (match.where?.type === "IsNullExpr") {
        expect(match.where.negated).toBe(true);
      }
    }
  });

  it("parses MERGE with ON CREATE SET", () => {
    const ast = parse(
      "MERGE (n:Entity {canonId: $id}) ON CREATE SET n.name = $name",
    );
    expect(ast.clauses[0].type).toBe("MergeClause");
    if (ast.clauses[0].type === "MergeClause") {
      expect(ast.clauses[0].onCreateSet).toHaveLength(1);
    }
  });

  it("parses UNWIND", () => {
    const ast = parse("UNWIND $items AS item RETURN item");
    expect(ast.clauses[0].type).toBe("UnwindClause");
    if (ast.clauses[0].type === "UnwindClause") {
      expect(ast.clauses[0].alias).toBe("item");
    }
  });

  it("parses WITH clause", () => {
    const ast = parse(
      "MATCH (n) WITH n.name AS name WHERE name = $x RETURN name",
    );
    const withClause = ast.clauses.find((c) => c.type === "WithClause");
    expect(withClause).toBeDefined();
  });

  it("parses DETACH DELETE", () => {
    const ast = parse("MATCH (n) DETACH DELETE n");
    const del = ast.clauses.find((c) => c.type === "DeleteClause");
    expect(del).toBeDefined();
    if (del?.type === "DeleteClause") {
      expect(del.detach).toBe(true);
    }
  });

  it("parses EXISTS subquery", () => {
    const ast = parse(
      "MATCH (n) WHERE NOT EXISTS { MATCH (n)-[:CALLS]->() } RETURN n",
    );
    const match = ast.clauses[0];
    if (match.type === "MatchClause") {
      expect(match.where?.type).toBe("NotExpr");
    }
  });

  it("parses AND/OR expressions", () => {
    const ast = parse(
      "MATCH (n) WHERE n.type = 'A' AND n.name = 'B' OR n.id = 1 RETURN n",
    );
    const match = ast.clauses[0];
    expect(match.type).toBe("MatchClause");
    // Should parse as (A AND B) OR C
  });

  it("rejects empty queries", () => {
    expect(() => parse("")).toThrow("Empty query");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Transpiler
// ═══════════════════════════════════════════════════════════════════

describe("CypherLiteTranspiler", () => {
  it("transpiles simple MATCH RETURN to SELECT", () => {
    const ast = parse("MATCH (n:Entity) RETURN n.name");
    const [result] = transpile(ast);
    expect(result.kind).toBe("read");
    expect(result.sql).toContain("SELECT");
    expect(result.sql).toContain("kg_entities");
  });

  it("transpiles WHERE to SQL WHERE", () => {
    const ast = parse("MATCH (n:Entity) WHERE n.name = $name RETURN n.name");
    const [result] = transpile(ast, { name: "AuthService" });
    expect(result.sql).toContain("WHERE");
    expect(result.params).toContain("AuthService");
  });

  it("transpiles CONTAINS to LIKE", () => {
    const ast = parse("MATCH (n) WHERE n.name CONTAINS 'auth' RETURN n");
    const [result] = transpile(ast);
    expect(result.sql).toContain("LIKE");
  });

  it("transpiles STARTS WITH to LIKE prefix", () => {
    const ast = parse("MATCH (n) WHERE n.name STARTS WITH 'Auth' RETURN n");
    const [result] = transpile(ast);
    expect(result.sql).toContain("LIKE ? || '%'");
  });

  it("transpiles count() to COUNT()", () => {
    const ast = parse("MATCH (n) RETURN count(n) AS cnt");
    const [result] = transpile(ast);
    expect(result.sql).toContain("COUNT(");
  });

  it("transpiles collect() to json_group_array()", () => {
    const ast = parse("MATCH (n) RETURN collect(n.name) AS names");
    const [result] = transpile(ast);
    expect(result.sql).toContain("json_group_array(");
  });

  it("transpiles toLower() to LOWER()", () => {
    const ast = parse("MATCH (n) WHERE toLower(n.name) = $val RETURN n");
    const [result] = transpile(ast, { val: "auth" });
    expect(result.sql).toContain("LOWER(");
  });

  it("transpiles ORDER BY and LIMIT", () => {
    const ast = parse("MATCH (n) RETURN n.name ORDER BY n.name DESC LIMIT 5");
    const [result] = transpile(ast);
    expect(result.sql).toContain("ORDER BY");
    expect(result.sql).toContain("DESC");
    expect(result.sql).toContain("LIMIT");
  });

  it("transpiles relationship pattern to JOIN", () => {
    const ast = parse("MATCH (a)-[r:CALLS]->(b) RETURN a.name, b.name");
    const [result] = transpile(ast);
    expect(result.sql).toContain("JOIN kg_relationships");
    expect(result.sql).toContain("JOIN kg_entities");
    expect(result.params).toContain("CALLS");
  });

  it("transpiles OPTIONAL MATCH to LEFT JOIN", () => {
    const ast = parse(
      "OPTIONAL MATCH (a)-[r:CALLS]->(b) RETURN a.name, b.name",
    );
    const [result] = transpile(ast);
    expect(result.sql).toContain("LEFT JOIN");
  });

  it("transpiles CREATE to INSERT", () => {
    const ast = parse("CREATE (n:Entity {name: 'Test'})");
    const [result] = transpile(ast);
    expect(result.kind).toBe("write");
    expect(result.sql).toContain("INSERT INTO");
  });

  it("transpiles MERGE to INSERT OR IGNORE", () => {
    const ast = parse(
      "MERGE (n:Entity {canonId: $id}) ON CREATE SET n.name = $name",
    );
    const results = transpile(ast, { id: "test-id", name: "Test" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].sql).toContain("INSERT OR IGNORE");
  });

  it("transpiles RETURN DISTINCT to SELECT DISTINCT", () => {
    const ast = parse("MATCH (n) RETURN DISTINCT n.type");
    const [result] = transpile(ast);
    expect(result.sql).toContain("SELECT DISTINCT");
  });

  it("expands array parameters inline", () => {
    const ast = parse("MATCH (n) WHERE n.type IN $types RETURN n");
    const [result] = transpile(ast, { types: ["A", "B", "C"] });
    expect(result.params).toEqual(expect.arrayContaining(["A", "B", "C"]));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Full Engine (round-trip with real SQLite)
// ═══════════════════════════════════════════════════════════════════

describe("CypherLiteEngine", () => {
  let db: Database.Database;
  let engine: CypherLiteEngine;

  beforeEach(() => {
    db = new Database(":memory:");
    engine = new CypherLiteEngine(db as unknown as CypherLiteDatabase);
    engine.initSchema();

    // Seed test data
    db.exec(`
      INSERT INTO kg_entities (canon_id, name, type, session_id, confidence)
      VALUES
        ('auth-service', 'AuthService', 'COMPONENT', 'test-session', 1.0),
        ('user-model', 'UserModel', 'COMPONENT', 'test-session', 0.9),
        ('login-func', 'login', 'FUNCTION', 'test-session', 0.85),
        ('validate-func', 'validate', 'FUNCTION', 'test-session', 0.8),
        ('neo4j-tech', 'Neo4j', 'TECHNOLOGY', 'test-session', 1.0);

      INSERT INTO kg_relationships (from_id, to_id, predicate, confidence)
      VALUES
        (1, 2, 'DEPENDS_ON', 1.0),
        (1, 3, 'CONTAINS', 0.9),
        (3, 4, 'CALLS', 0.85),
        (1, 5, 'USES', 1.0);
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("queries all entities", () => {
    const results = engine.query("MATCH (n:Entity) RETURN n.name, n.type");
    expect(results).toHaveLength(5);
    expect(results[0]).toHaveProperty("n.name");
    expect(results[0]).toHaveProperty("n.type");
  });

  it("filters by label (type)", () => {
    const results = engine.query(
      "MATCH (n:Entity) WHERE n.type = $type RETURN n.name",
      { type: "COMPONENT" },
    );
    expect(results).toHaveLength(2);
  });

  it("filters with CONTAINS", () => {
    const results = engine.query(
      "MATCH (n:Entity) WHERE n.name CONTAINS 'Service' RETURN n.name",
    );
    expect(results).toHaveLength(1);
    expect(results[0]["n.name"]).toBe("AuthService");
  });

  it("filters with toLower()", () => {
    const results = engine.query(
      "MATCH (n:Entity) WHERE toLower(n.name) = 'authservice' RETURN n.name",
    );
    expect(results).toHaveLength(1);
  });

  it("returns count", () => {
    const results = engine.query("MATCH (n:Entity) RETURN count(n) AS cnt");
    expect(results).toHaveLength(1);
    expect(results[0].cnt).toBe(5);
  });

  it("returns DISTINCT types", () => {
    const results = engine.query("MATCH (n:Entity) RETURN DISTINCT n.type");
    const types = results.map((r) => r["n.type"]);
    expect(new Set(types).size).toBe(types.length);
  });

  it("applies ORDER BY and LIMIT", () => {
    const results = engine.query(
      "MATCH (n:Entity) RETURN n.name ORDER BY n.name ASC LIMIT 2",
    );
    expect(results).toHaveLength(2);
    // Should be alphabetically first
    expect(results[0]["n.name"]).toBe("AuthService");
  });

  it("follows relationships (outgoing)", () => {
    const results = engine.query(
      "MATCH (a:Entity)-[r:DEPENDS_ON]->(b:Entity) WHERE a.name = 'AuthService' RETURN b.name",
    );
    expect(results).toHaveLength(1);
    expect(results[0]["b.name"]).toBe("UserModel");
  });

  it("follows relationships (CALLS)", () => {
    const results = engine.query(
      "MATCH (a:Entity)-[r:CALLS]->(b:Entity) WHERE a.name = 'login' RETURN b.name",
    );
    expect(results).toHaveLength(1);
    expect(results[0]["b.name"]).toBe("validate");
  });

  it("returns relationship predicate", () => {
    const results = engine.query(
      "MATCH (a:Entity)-[r]->(b:Entity) WHERE a.name = 'AuthService' RETURN r.predicate, b.name",
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    const predicates = results.map((r) => r["r.predicate"]);
    expect(predicates).toContain("DEPENDS_ON");
  });

  it("handles OPTIONAL MATCH", () => {
    // Neo4j is not connected to any called entity → should still return
    const results = engine.query(
      "MATCH (n:Entity) WHERE n.name = 'Neo4j' " +
        "OPTIONAL MATCH (n)-[r:CALLS]->(target:Entity) " +
        "RETURN n.name, target.name",
    );
    expect(results).toHaveLength(1);
    expect(results[0]["n.name"]).toBe("Neo4j");
    // target.name should be null since no CALLS relationship exists
  });

  it("creates entities", () => {
    engine.execute(
      "CREATE (n:Entity {canon_id: 'new-entity', name: 'NewEntity', type: 'COMPONENT', session_id: 'test-session'})",
    );
    const results = engine.query(
      "MATCH (n:Entity) WHERE n.name = 'NewEntity' RETURN n.name",
    );
    expect(results).toHaveLength(1);
  });

  it("uses MERGE (insert if not exists)", () => {
    // First MERGE creates
    engine.execute(
      "MERGE (n:Entity {canonId: $id, sessionId: $session}) ON CREATE SET n.name = $name",
      { id: "merge-test", session: "test-session", name: "MergeTest" },
    );
    const r1 = engine.query(
      "MATCH (n:Entity) WHERE n.canon_id = 'merge-test' RETURN n.name",
    );
    expect(r1).toHaveLength(1);
    expect(r1[0]["n.name"]).toBe("MergeTest");

    // Second MERGE should not duplicate
    engine.execute(
      "MERGE (n:Entity {canonId: $id, sessionId: $session}) ON CREATE SET n.name = $name",
      { id: "merge-test", session: "test-session", name: "MergeTest2" },
    );
    const r2 = engine.query(
      "MATCH (n:Entity) WHERE n.canon_id = 'merge-test' RETURN n.name",
    );
    expect(r2).toHaveLength(1);
  });

  it("filters with IN operator", () => {
    const results = engine.query(
      "MATCH (n:Entity) WHERE n.type IN $types RETURN n.name",
      { types: ["FUNCTION", "TECHNOLOGY"] },
    );
    expect(results).toHaveLength(3); // login, validate, Neo4j
  });

  it("handles coalesce()", () => {
    const results = engine.query(
      "MATCH (n:Entity) RETURN n.name, coalesce(n.aliases, '[]') AS aliases",
    );
    expect(results.length).toBe(5);
    // All aliases are null, so coalesce should return '[]'
    expect(results[0].aliases).toBe("[]");
  });

  it("handles IS NOT NULL / IS NULL", () => {
    const notNull = engine.query(
      "MATCH (n:Entity) WHERE n.name IS NOT NULL RETURN n.name",
    );
    expect(notNull).toHaveLength(5);

    const isNull = engine.query(
      "MATCH (n:Entity) WHERE n.aliases IS NULL RETURN n.name",
    );
    expect(isNull).toHaveLength(5);
  });

  it("handles multiple return items", () => {
    const results = engine.query(
      "MATCH (n:Entity) RETURN n.name, n.type, n.confidence ORDER BY n.name LIMIT 1",
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty("n.name");
    expect(results[0]).toHaveProperty("n.type");
    expect(results[0]).toHaveProperty("n.confidence");
  });

  it("maps camelCase properties to snake_case columns", () => {
    const results = engine.query(
      "MATCH (n:Entity) WHERE n.sessionId = 'test-session' RETURN n.canonId",
    );
    expect(results.length).toBe(5);
    expect(results[0]).toHaveProperty("n.canonId");
  });
});
