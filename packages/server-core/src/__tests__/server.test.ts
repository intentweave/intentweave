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
