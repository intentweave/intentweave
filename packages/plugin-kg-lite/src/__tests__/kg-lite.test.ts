// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KgLiteBackend } from "../backend.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("KgLiteBackend", () => {
  let backend: KgLiteBackend;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = join(tmpdir(), `iw-kg-lite-test-${Date.now()}`);
    dbPath = join(dbDir, "kg.db");
    backend = new KgLiteBackend(dbPath);
  });

  afterEach(() => {
    backend.close();
    if (existsSync(dbDir)) {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("creates the database file and schema", () => {
    expect(existsSync(dbPath)).toBe(true);
    // Should be able to query without errors
    const results = backend.query("MATCH (n:Entity) RETURN n.name");
    expect(results).toEqual([]);
  });

  it("persists entities", () => {
    const result = backend.persist({
      entities: [
        {
          canonId: "auth-service",
          name: "AuthService",
          type: "component",
          aliases: ["auth", "authentication service"],
          confidence: 0.95,
        },
        {
          canonId: "user-model",
          name: "UserModel",
          type: "component",
          confidence: 0.9,
        },
      ],
      relationships: [],
      session: "test-session",
    });

    expect(result.entityCount).toBe(2);
    expect(result.relationshipCount).toBe(0);

    const entities = backend.query(
      "MATCH (n:Entity) RETURN n.name ORDER BY n.name",
    );
    expect(entities).toHaveLength(2);
    expect(entities[0]["n.name"]).toBe("AuthService");
    expect(entities[1]["n.name"]).toBe("UserModel");
  });

  it("persists entities and relationships", () => {
    const result = backend.persist({
      entities: [
        { canonId: "a", name: "ServiceA", type: "component" },
        { canonId: "b", name: "ServiceB", type: "component" },
      ],
      relationships: [
        {
          subjectCanonId: "a",
          predicate: "DEPENDS_ON",
          objectCanonId: "b",
          confidence: 0.85,
        },
      ],
      session: "test-session",
    });

    expect(result.entityCount).toBe(2);
    expect(result.relationshipCount).toBe(1);

    const rels = backend.query(
      "MATCH (a:Entity)-[r:DEPENDS_ON]->(b:Entity) RETURN a.name, b.name",
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]["a.name"]).toBe("ServiceA");
    expect(rels[0]["b.name"]).toBe("ServiceB");
  });

  it("upserts entities on duplicate canon_id + session", () => {
    backend.persist({
      entities: [
        { canonId: "a", name: "Original", type: "concept", confidence: 0.5 },
      ],
      relationships: [],
      session: "s1",
    });

    backend.persist({
      entities: [
        { canonId: "a", name: "Updated", type: "concept", confidence: 0.9 },
      ],
      relationships: [],
      session: "s1",
    });

    const results = backend.query(
      "MATCH (n:Entity) WHERE n.name = 'Updated' RETURN n.name",
    );
    expect(results).toHaveLength(1);

    // Should not duplicate
    const all = backend.query("MATCH (n:Entity) RETURN n.name");
    expect(all).toHaveLength(1);
  });

  it("isolates sessions", () => {
    backend.persist({
      entities: [{ canonId: "a", name: "InSession1", type: "concept" }],
      relationships: [],
      session: "session-1",
    });
    backend.persist({
      entities: [{ canonId: "a", name: "InSession2", type: "concept" }],
      relationships: [],
      session: "session-2",
    });

    const all = backend.query("MATCH (n:Entity) RETURN n.name");
    expect(all).toHaveLength(2);
  });

  it("skips relationships with unresolved entities", () => {
    const result = backend.persist({
      entities: [{ canonId: "a", name: "A", type: "concept" }],
      relationships: [
        {
          subjectCanonId: "a",
          predicate: "DEPENDS_ON",
          objectCanonId: "missing",
        },
      ],
      session: "test",
    });

    expect(result.entityCount).toBe(1);
    expect(result.relationshipCount).toBe(0);
  });

  it("supports Cypher query with parameters", () => {
    backend.persist({
      entities: [
        { canonId: "react", name: "React", type: "technology" },
        { canonId: "vue", name: "Vue", type: "technology" },
        { canonId: "auth", name: "AuthService", type: "component" },
      ],
      relationships: [],
      session: "s1",
    });

    const techs = backend.query(
      "MATCH (n:Entity) WHERE n.type = $type RETURN n.name",
      { type: "TECHNOLOGY" },
    );
    expect(techs).toHaveLength(2);
  });

  it("supports relationship traversal queries", () => {
    backend.persist({
      entities: [
        { canonId: "a", name: "A", type: "component" },
        { canonId: "b", name: "B", type: "component" },
        { canonId: "c", name: "C", type: "component" },
      ],
      relationships: [
        { subjectCanonId: "a", predicate: "CALLS", objectCanonId: "b" },
        { subjectCanonId: "b", predicate: "CALLS", objectCanonId: "c" },
      ],
      session: "s1",
    });

    const called = backend.query(
      "MATCH (a:Entity)-[r:CALLS]->(b:Entity) WHERE a.name = 'A' RETURN b.name",
    );
    expect(called).toHaveLength(1);
    expect(called[0]["b.name"]).toBe("B");
  });

  it("handles close idempotently", () => {
    backend.close();
    backend.close(); // should not throw
  });
});
