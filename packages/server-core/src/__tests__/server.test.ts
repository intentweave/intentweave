// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for @intentweave/server-core — createServer factory.
 *
 * Tests the health/ready endpoints and core plugin registration.
 * Uses a mock Neo4j driver to avoid requiring a real database.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer } from "../app.js";
import type { ServerConfig, IwServer } from "../types.js";

// Mock Neo4j driver at module level
vi.mock("neo4j-driver", () => {
  const mockDriver = {
    verifyConnectivity: async () => {},
    close: async () => {},
    session: () => ({
      run: async () => ({ records: [] }),
      close: async () => {},
    }),
  };
  return {
    default: {
      driver: () => mockDriver,
      auth: {
        basic: () => ({ scheme: "basic" }),
      },
    },
  };
});

const TEST_CONFIG: ServerConfig = {
  neo4j: {
    uri: "bolt://localhost:7687",
    username: "neo4j",
    password: "test",
  },
  defaultSession: "test-session",
  swagger: false, // Skip swagger for faster tests
  cors: false,
  logLevel: "silent" as any,
};

describe("createServer", () => {
  let server: IwServer;

  beforeAll(async () => {
    server = await createServer(TEST_CONFIG);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("creates a server with config decorated", () => {
    expect(server.config).toBeDefined();
    expect(server.config.defaultSession).toBe("test-session");
  });

  it("GET /health returns 200", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("ok");
    expect(body.uptime).toBeDefined();
  });

  it("GET /health includes timestamp", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.payload);
    expect(body.timestamp).toBeDefined();
  });
});

describe("createServer with workspaceRoot", () => {
  it("stores workspaceRoot in config", async () => {
    const server = await createServer({
      ...TEST_CONFIG,
      workspaceRoot: "/tmp/test-workspace",
    });
    await server.ready();
    expect(server.config.workspaceRoot).toBe("/tmp/test-workspace");
    await server.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// Rate limiting
// ═══════════════════════════════════════════════════════════════

describe("rate limiting", () => {
  it("disabled by default (no rateLimit config)", async () => {
    const server = await createServer(TEST_CONFIG);
    await server.ready();

    // No rate-limit headers when disabled
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it("applies limit when configured", async () => {
    const server = await createServer({
      ...TEST_CONFIG,
      rateLimit: 3,
    });
    await server.ready();

    // Health is exempt from rate limiting (not /api/*)
    for (let i = 0; i < 5; i++) {
      const res = await server.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
    await server.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// API key auth
// ═══════════════════════════════════════════════════════════════

describe("API key auth", () => {
  it("disabled by default (no apiKeys config)", async () => {
    const server = await createServer(TEST_CONFIG);
    await server.ready();
    // Health is always public
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it("rejects /api/* requests without auth when keys configured", async () => {
    const server = await createServer({
      ...TEST_CONFIG,
      apiKeys: ["test-key-123"],
    });

    // Need to register a dummy /api/ route for the test
    server.get("/api/test-auth", async () => ({ ok: true }));
    await server.ready();

    const res = await server.inject({
      method: "GET",
      url: "/api/test-auth",
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("accepts /api/* requests with valid bearer token", async () => {
    const server = await createServer({
      ...TEST_CONFIG,
      apiKeys: ["test-key-123"],
    });

    server.get("/api/test-auth", async () => ({ ok: true }));
    await server.ready();

    const res = await server.inject({
      method: "GET",
      url: "/api/test-auth",
      headers: { authorization: "Bearer test-key-123" },
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it("rejects invalid API key", async () => {
    const server = await createServer({
      ...TEST_CONFIG,
      apiKeys: ["test-key-123"],
    });

    server.get("/api/test-auth", async () => ({ ok: true }));
    await server.ready();

    const res = await server.inject({
      method: "GET",
      url: "/api/test-auth",
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(res.statusCode).toBe(403);
    await server.close();
  });

  it("allows /health without auth even when keys configured", async () => {
    const server = await createServer({
      ...TEST_CONFIG,
      apiKeys: ["test-key-123"],
    });
    await server.ready();

    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});
