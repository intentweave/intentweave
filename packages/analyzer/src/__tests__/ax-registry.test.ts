// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LanguageRegistry,
  type LanguageAdapter,
  type LanguageAdapterOptions,
} from "../stages/languageRegistry.js";
import type { AxFileResult } from "../stages/ax.js";

// ============================================================================
// Helpers
// ============================================================================

function makeMockAdapter(
  extensions: string[],
  language: string,
): LanguageAdapter {
  return {
    extensions,
    processFile: vi.fn(
      async (
        _workspaceRoot: string,
        relativePath: string,
      ): Promise<AxFileResult> => ({
        filePath: relativePath,
        contentHash: "mock-hash",
        language,
        symbols: [],
        imports: [],
        todos: [],
        extractedAt: Date.now(),
      }),
    ),
  };
}

// ============================================================================
// LanguageRegistry — unit tests
// ============================================================================

describe("LanguageRegistry", () => {
  let registry: LanguageRegistry;

  beforeEach(() => {
    registry = new LanguageRegistry();
  });

  describe("register + adapterFor", () => {
    it("routes .ts files to the TypeScript adapter", () => {
      const tsAdapter = makeMockAdapter(
        [".ts", ".tsx", ".js", ".jsx"],
        "typescript",
      );
      registry.register(tsAdapter);

      expect(registry.adapterFor("src/index.ts")).toBe(tsAdapter);
      expect(registry.adapterFor("lib/utils.js")).toBe(tsAdapter);
      expect(registry.adapterFor("components/App.tsx")).toBe(tsAdapter);
      expect(registry.adapterFor("pages/Home.jsx")).toBe(tsAdapter);
    });

    it("routes .swift files to the Swift adapter", () => {
      const swiftAdapter = makeMockAdapter([".swift"], "swift");
      registry.register(swiftAdapter);

      expect(registry.adapterFor("Sources/main.swift")).toBe(swiftAdapter);
    });

    it("routes .py files to the Python adapter", () => {
      const pyAdapter = makeMockAdapter([".py"], "python");
      registry.register(pyAdapter);

      expect(registry.adapterFor("scripts/build.py")).toBe(pyAdapter);
    });

    it("returns null for unregistered extensions", () => {
      const tsAdapter = makeMockAdapter([".ts"], "typescript");
      registry.register(tsAdapter);

      expect(registry.adapterFor("readme.md")).toBeNull();
      expect(registry.adapterFor("Makefile")).toBeNull();
      expect(registry.adapterFor("styles.css")).toBeNull();
    });

    it("supports multiple adapters without conflicts", () => {
      const tsAdapter = makeMockAdapter(
        [".ts", ".tsx", ".js", ".jsx"],
        "typescript",
      );
      const swiftAdapter = makeMockAdapter([".swift"], "swift");
      const pyAdapter = makeMockAdapter([".py"], "python");

      registry.register(tsAdapter).register(swiftAdapter).register(pyAdapter);

      expect(registry.adapterFor("src/index.ts")).toBe(tsAdapter);
      expect(registry.adapterFor("Sources/main.swift")).toBe(swiftAdapter);
      expect(registry.adapterFor("scripts/build.py")).toBe(pyAdapter);
    });

    it("later registration for same extension overrides earlier", () => {
      const adapter1 = makeMockAdapter([".ts"], "ts-v1");
      const adapter2 = makeMockAdapter([".ts"], "ts-v2");

      registry.register(adapter1).register(adapter2);

      expect(registry.adapterFor("file.ts")).toBe(adapter2);
    });
  });

  describe("includePatterns", () => {
    it("generates glob patterns for all registered extensions", () => {
      registry.register(makeMockAdapter([".ts", ".tsx"], "typescript"));
      registry.register(makeMockAdapter([".py"], "python"));

      const patterns = registry.includePatterns();
      expect(patterns).toEqual(["**/*.ts", "**/*.tsx", "**/*.py"]);
    });

    it("returns empty array when no adapters registered", () => {
      expect(registry.includePatterns()).toEqual([]);
    });
  });

  describe("supports", () => {
    it("returns true for registered extensions", () => {
      registry.register(makeMockAdapter([".ts", ".py"], "mixed"));

      expect(registry.supports("file.ts")).toBe(true);
      expect(registry.supports("file.py")).toBe(true);
    });

    it("returns false for unregistered extensions", () => {
      registry.register(makeMockAdapter([".ts"], "ts"));

      expect(registry.supports("file.go")).toBe(false);
      expect(registry.supports("file.rs")).toBe(false);
    });
  });

  describe("size", () => {
    it("counts registered adapters", () => {
      expect(registry.size).toBe(0);

      registry.register(makeMockAdapter([".ts"], "ts"));
      expect(registry.size).toBe(1);

      registry.register(makeMockAdapter([".py"], "py"));
      expect(registry.size).toBe(2);
    });
  });

  describe("chaining", () => {
    it("register returns this for chaining", () => {
      const result = registry.register(makeMockAdapter([".ts"], "ts"));
      expect(result).toBe(registry);
    });
  });
});

// ============================================================================
// Adapter processFile — unit tests
// ============================================================================

describe("LanguageAdapter.processFile", () => {
  it("adapter processFile is called with correct arguments", async () => {
    const adapter = makeMockAdapter([".py"], "python");
    const registry = new LanguageRegistry();
    registry.register(adapter);

    const found = registry.adapterFor("src/auth.py")!;
    await found.processFile("/workspace", "src/auth.py");

    expect(adapter.processFile).toHaveBeenCalledWith(
      "/workspace",
      "src/auth.py",
    );
  });

  it("adapter returns AxFileResult with correct structure", async () => {
    const adapter = makeMockAdapter([".ts"], "typescript");
    const registry = new LanguageRegistry();
    registry.register(adapter);

    const found = registry.adapterFor("src/index.ts")!;
    const result = await found.processFile("/workspace", "src/index.ts");

    expect(result).toMatchObject({
      filePath: "src/index.ts",
      language: "typescript",
      symbols: [],
      imports: [],
      todos: [],
    });
    expect(result.contentHash).toBeDefined();
    expect(result.extractedAt).toBeGreaterThan(0);
  });
});

// ============================================================================
// createLanguageRegistry — integration test (requires real extractors)
// ============================================================================

describe("createLanguageRegistry", () => {
  // This test imports the real factory to verify it creates a working registry
  // with all 3 built-in adapters. Doesn't require actual files — just verifies
  // registration and dispatch.

  it("registers all built-in adapters", async () => {
    const { createLanguageRegistry } = await import("../stages/ax.js");

    const registry = createLanguageRegistry({
      workspaceRoot: "/tmp/test",
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    });

    // Only TS/JS is built-in; Swift/Python come from language plugins
    expect(registry.size).toBe(1);
  });

  it("routes TS/JS files to TypeScript adapter", async () => {
    const { createLanguageRegistry } = await import("../stages/ax.js");

    const registry = createLanguageRegistry({
      workspaceRoot: "/tmp/test",
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    });

    expect(registry.adapterFor("src/index.ts")).not.toBeNull();
    expect(registry.adapterFor("src/App.tsx")).not.toBeNull();
    expect(registry.adapterFor("lib/utils.js")).not.toBeNull();
    expect(registry.adapterFor("lib/App.jsx")).not.toBeNull();
  });

  it("does not route Swift files without plugin", async () => {
    const { createLanguageRegistry } = await import("../stages/ax.js");

    const registry = createLanguageRegistry({
      workspaceRoot: "/tmp/test",
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    });

    // Swift adapter is now a plugin — not built-in
    expect(registry.adapterFor("Sources/main.swift")).toBeNull();
  });

  it("does not route Python files without plugin", async () => {
    const { createLanguageRegistry } = await import("../stages/ax.js");

    const registry = createLanguageRegistry({
      workspaceRoot: "/tmp/test",
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    });

    // Python adapter is now a plugin — not built-in
    expect(registry.adapterFor("scripts/build.py")).toBeNull();
  });

  it("returns null for unsupported file types", async () => {
    const { createLanguageRegistry } = await import("../stages/ax.js");

    const registry = createLanguageRegistry({
      workspaceRoot: "/tmp/test",
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    });

    expect(registry.adapterFor("README.md")).toBeNull();
    expect(registry.adapterFor("styles.css")).toBeNull();
    expect(registry.adapterFor("main.go")).toBeNull();
  });

  it("generates correct include patterns", async () => {
    const { createLanguageRegistry } = await import("../stages/ax.js");

    const registry = createLanguageRegistry({
      workspaceRoot: "/tmp/test",
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    });

    const patterns = registry.includePatterns();
    expect(patterns).toContain("**/*.ts");
    expect(patterns).toContain("**/*.tsx");
    expect(patterns).toContain("**/*.js");
    expect(patterns).toContain("**/*.jsx");
    // Swift/Python patterns only present when language plugins are discovered
    expect(patterns).not.toContain("**/*.swift");
    expect(patterns).not.toContain("**/*.py");
  });
});

// ============================================================================
// Custom adapter registration — extensibility test
// ============================================================================

describe("Custom adapter registration", () => {
  it("supports registering a custom Go adapter", async () => {
    const { createLanguageRegistry } = await import("../stages/ax.js");

    const registry = createLanguageRegistry({
      workspaceRoot: "/tmp/test",
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    });

    // Simulate what adding a Go adapter would look like
    const goAdapter = makeMockAdapter([".go"], "go");
    registry.register(goAdapter);

    expect(registry.size).toBe(2);
    expect(registry.adapterFor("cmd/main.go")).toBe(goAdapter);
    expect(registry.includePatterns()).toContain("**/*.go");

    // Built-in TS/JS adapter still works
    expect(registry.adapterFor("src/index.ts")).not.toBeNull();
  });
});
