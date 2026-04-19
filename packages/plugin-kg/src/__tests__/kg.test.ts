// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, afterEach } from "vitest";
import kgPlugin from "../index.js";
import { KgBackend } from "../backend.js";

describe("plugin-kg", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports a valid IWPlugin", () => {
    expect(kgPlugin.name).toBe("kg");
    expect(kgPlugin.version).toBe("0.8.0");
    expect(kgPlugin.capabilities).toContain("persistence");
    expect(kgPlugin.getCapabilities).toBeTypeOf("function");
  });

  it("provides a persistence capability", () => {
    // Set up env so backend creation doesn't throw
    vi.stubEnv("NEO4J_PASSWORD", "test-password");

    const caps = kgPlugin.getCapabilities!({
      workspaceRoot: "/tmp/test",
      indexDbPath: "/tmp/test/.iw/index.db",
      session: "test",
      verbose: false,
    });

    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe("persistence");
  });

  it("throws without NEO4J_PASSWORD", async () => {
    // Remove password env var
    vi.stubEnv("NEO4J_PASSWORD", "");
    delete process.env.NEO4J_PASSWORD;

    const caps = kgPlugin.getCapabilities!({
      workspaceRoot: "/tmp/test",
      indexDbPath: "/tmp/test/.iw/index.db",
      session: "test",
      verbose: false,
    });

    // Capability is created lazily, so query should throw
    const persistence = caps[0] as {
      query: (c: string, p?: Record<string, unknown>) => Promise<unknown[]>;
    };
    await expect(persistence.query("MATCH (n) RETURN n")).rejects.toThrow(      /Neo4j password required/,
    );
  });

  it("KgBackend constructor validates password", () => {
    expect(() => new KgBackend({ password: "" })).toThrow(
      /Neo4j password required/,
    );
  });
});
