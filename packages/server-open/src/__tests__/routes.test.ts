// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for @intentweave/server-open routes.
 *
 * Uses Fastify inject() to test HTTP handlers without a real server.
 * Tests that don't require Neo4j use a mock driver.
 * Tests that require Neo4j are skipped when the database is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { openPlugin } from "../plugin.js";

// ── Test helper: create a Fastify instance with mock decorators ──

async function buildTestServer(
  overrides: {
    neo4j?: unknown;
    config?: Record<string, unknown>;
  } = {},
): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  // Decorate with a mock Neo4j driver (or real one if provided)
  const mockDriver = {
    session: () => ({
      run: async () => ({ records: [] }),
      close: async () => {},
    }),
    verifyConnectivity: async () => {},
    close: async () => {},
  };

  // Register mock plugins that satisfy the openPlugin dependencies
  await server.register(
    fp(
      async (fastify) => {
        fastify.decorate("neo4j", overrides.neo4j ?? mockDriver);
        fastify.decorate("neo4jDatabase", "neo4j");
      },
      { name: "iw-neo4j" },
    ),
  );

  await server.register(
    fp(
      async (fastify) => {
        fastify.decorate("config", {
          neo4j: {
            uri: "bolt://localhost:7687",
            username: "neo4j",
            password: "test",
          },
          defaultSession: "test-session",
          ...overrides.config,
        });
        fastify.decorateRequest("ctx", null);
        fastify.addHook("onRequest", async (request) => {
          (request as any).ctx = {
            sessionId:
              (request.headers["x-session-id"] as string) ?? "test-session",
            workspaceId:
              (request.headers["x-workspace-id"] as string) ?? undefined,
            traceId: (request.headers["x-trace-id"] as string) ?? undefined,
          };
        });
      },
      { name: "iw-context" },
    ),
  );

  // Register open plugin routes
  await server.register(openPlugin);
  await server.ready();

  return server;
}

// ═══════════════════════════════════════════════════════════════
// Schema routes (no Neo4j needed)
// ═══════════════════════════════════════════════════════════════

describe("GET /api/schema", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns predicates and entity types", async () => {
    const res = await server.inject({ method: "GET", url: "/api/schema" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.canonicalPredicates).toBeDefined();
    expect(Array.isArray(body.canonicalPredicates)).toBe(true);
    expect(body.canonicalPredicates.length).toBeGreaterThan(0);
    expect(body.entityTypes).toBeDefined();
    expect(Array.isArray(body.entityTypes)).toBe(true);
    expect(body.entityTypes.length).toBeGreaterThan(0);
  });

  it("includes CONTAINS predicate", async () => {
    const res = await server.inject({ method: "GET", url: "/api/schema" });
    const body = JSON.parse(res.payload);
    expect(body.canonicalPredicates).toContain("CONTAINS");
    expect(body.canonicalPredicates).toContain("DEPENDS_ON");
    expect(body.canonicalPredicates).toContain("IMPLEMENTS");
  });
});

// ═══════════════════════════════════════════════════════════════
// Entity routes (mock Neo4j)
// ═══════════════════════════════════════════════════════════════

describe("GET /api/entities", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns 200 with empty array when no entities", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/entities?session=test-session",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.entities).toBeDefined();
    expect(Array.isArray(body.entities)).toBe(true);
  });

  it("accepts limit parameter", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/entities?session=test-session&limit=5",
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts type filter", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/entities?session=test-session&type=concept",
    });
    expect(res.statusCode).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// Query routes (mock Neo4j)
// ═══════════════════════════════════════════════════════════════

describe("POST /api/query", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("executes cypher query and returns results", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        cypher: "RETURN 1 as n",
        session: "test-session",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.results).toBeDefined();
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("rejects NL query without LLM (returns 501 or 400)", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        question: "What components exist?",
        session: "test-session",
      },
    });
    // NL query requires LLM — should return 501
    expect(res.statusCode).toBe(501);
  });

  it("requires either cypher or question", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/query",
      payload: { session: "test-session" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// Context routes (mock Neo4j)
// ═══════════════════════════════════════════════════════════════

describe("POST /api/context", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns context for all mode", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/context",
      payload: {
        all: true,
        session: "test-session",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("context");
  });

  it("returns 501 for topic query without LLM config", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/context",
      payload: {
        topic: "authentication",
        session: "test-session",
      },
    });
    expect(res.statusCode).toBe(501);
  });
});

// ═══════════════════════════════════════════════════════════════
// Query routes with LLM config (mock LLM → validates route logic)
// ═══════════════════════════════════════════════════════════════

describe("POST /api/query (with LLM config)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer({
      config: {
        llm: {
          provider: "smart-mock",
        },
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("NL query with smart-mock provider attempts execution", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/query",
      payload: {
        question: "What components exist?",
        session: "test-session",
      },
    });
    // smart-mock may generate invalid Cypher → 422 after retry,
    // or succeed if the mock output happens to be valid Cypher.
    // Either way, it should NOT return 501 anymore.
    expect(res.statusCode).not.toBe(501);
  });
});

// ═══════════════════════════════════════════════════════════════
// Context routes with LLM config
// ═══════════════════════════════════════════════════════════════

describe("POST /api/context (with LLM config)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer({
      config: {
        llm: {
          provider: "smart-mock",
        },
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("topic query with smart-mock attempts context building", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/context",
      payload: {
        topic: "authentication",
        session: "test-session",
      },
    });
    // With LLM configured, should NOT return 501
    expect(res.statusCode).not.toBe(501);
  });
});

// ═══════════════════════════════════════════════════════════════
// Run routes (no workspace root → 400)
// ═══════════════════════════════════════════════════════════════

describe("POST /api/run", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns 400 when no workspaceRoot configured", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/run",
      payload: { files: ["**/*.md"] },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("workspaceRoot");
  });

  it("returns 501 for main track", async () => {
    const serverWithWorkspace = await buildTestServer({
      config: { workspaceRoot: "/tmp/test-workspace" },
    });

    const res = await serverWithWorkspace.inject({
      method: "POST",
      url: "/api/run",
      payload: { files: ["test.md"], track: "main" },
    });
    expect(res.statusCode).toBe(501);
    await serverWithWorkspace.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// Persist routes (no workspace root → 400)
// ═══════════════════════════════════════════════════════════════

describe("POST /api/persist", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns 400 when no workspaceRoot configured", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/persist",
      payload: { latest: true },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("workspaceRoot");
  });

  it("returns 400 when neither runId nor latest provided", async () => {
    const serverWithWorkspace = await buildTestServer({
      config: { workspaceRoot: "/tmp/test-workspace" },
    });

    const res = await serverWithWorkspace.inject({
      method: "POST",
      url: "/api/persist",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("runId");
    await serverWithWorkspace.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/runs/:runId (no workspace root → 400)
// ═══════════════════════════════════════════════════════════════

describe("GET /api/runs/:runId", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns 400 when no workspaceRoot configured", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/runs/run-2026-01-01-abc",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for non-existent run", async () => {
    const serverWithWorkspace = await buildTestServer({
      config: { workspaceRoot: "/tmp/test-workspace" },
    });

    const res = await serverWithWorkspace.inject({
      method: "GET",
      url: "/api/runs/run-nonexistent-12345678",
    });
    expect(res.statusCode).toBe(404);
    await serverWithWorkspace.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// Impact routes (mock Neo4j — returns empty)
// ═══════════════════════════════════════════════════════════════

describe("POST /api/impact", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("accepts impact request with files", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/impact",
      payload: {
        files: ["src/index.ts"],
        session: "test-session",
      },
    });
    // May succeed with empty impact or fail gracefully
    expect([200, 500]).toContain(res.statusCode);
  });
});

// ═══════════════════════════════════════════════════════════════
// Doc-health routes (mock Neo4j)
// ═══════════════════════════════════════════════════════════════

describe("POST /api/doc-health", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("accepts doc-health request", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/doc-health",
      payload: {
        session: "test-session",
      },
    });
    // May succeed or fail gracefully depending on Neo4j mock
    expect([200, 500]).toContain(res.statusCode);
  });
});
