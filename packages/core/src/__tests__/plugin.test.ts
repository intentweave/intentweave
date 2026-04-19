// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin System Tests — IWPlugin, PluginRegistry, Capabilities
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PluginRegistry,
  getPluginRegistry,
  setPluginRegistry,
  type IWPlugin,
  type LlmCapability,
  type PersistenceCapability,
  type LanguageCapability,
  type PluginContext,
} from "../index.js";

// =============================================================================
// Test Fixtures
// =============================================================================

function makeContext(overrides?: Partial<PluginContext>): PluginContext {
  return {
    workspaceRoot: "/tmp/test",
    indexDbPath: "/tmp/test/.iw/index.db",
    session: "test-session",
    verbose: false,
    ...overrides,
  };
}

function makePlugin(overrides?: Partial<IWPlugin>): IWPlugin {
  return {
    name: "test",
    version: "1.0.0",
    description: "Test plugin",
    ...overrides,
  };
}

const mockLlmCapability: LlmCapability = {
  name: "llm",
  provider: {
    name: "mock",
    capabilities: { json: false, streaming: false, maxTokens: 4096 },
    isAvailable: async () => true,
    complete: async () => ({
      text: "mock response",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
  },
};

// =============================================================================
// PluginRegistry — Registration
// =============================================================================

describe("PluginRegistry", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe("register()", () => {
    it("registers a plugin", () => {
      const plugin = makePlugin({ name: "alpha" });
      registry.register(plugin);

      expect(registry.get("alpha")).toBe(plugin);
      expect(registry.size).toBe(1);
    });

    it("rejects duplicate plugin names", () => {
      registry.register(makePlugin({ name: "alpha" }));

      expect(() => registry.register(makePlugin({ name: "alpha" }))).toThrow(
        /already registered/,
      );
    });

    it("rejects plugins with unsatisfied dependencies", () => {
      const plugin = makePlugin({
        name: "beta",
        dependencies: ["alpha"],
      });

      expect(() => registry.register(plugin)).toThrow(
        /requires plugin "alpha"/,
      );
    });

    it("accepts plugins whose dependencies are already registered", () => {
      registry.register(makePlugin({ name: "alpha" }));
      registry.register(
        makePlugin({ name: "beta", dependencies: ["alpha"] }),
      );

      expect(registry.size).toBe(2);
    });
  });

  // ===========================================================================
  // list / summary
  // ===========================================================================

  describe("list()", () => {
    it("returns all registered plugins in insertion order", () => {
      registry.register(makePlugin({ name: "a" }));
      registry.register(makePlugin({ name: "b" }));
      registry.register(makePlugin({ name: "c" }));

      const names = registry.list().map((p) => p.name);
      expect(names).toEqual(["a", "b", "c"]);
    });
  });

  describe("summary()", () => {
    it("returns structured summaries", () => {
      registry.register(
        makePlugin({
          name: "kg",
          version: "0.8.0",
          description: "Knowledge graph",
          capabilities: ["llm", "persistence"],
          dependencies: [],
        }),
      );

      const [s] = registry.summary();
      expect(s).toEqual({
        name: "kg",
        version: "0.8.0",
        description: "Knowledge graph",
        capabilities: ["llm", "persistence"],
        dependencies: [],
      });
    });
  });

  // ===========================================================================
  // Capabilities (11.2)
  // ===========================================================================

  describe("resolveCapabilities()", () => {
    it("collects capabilities from plugins", () => {
      registry.register(
        makePlugin({
          name: "llm-provider",
          capabilities: ["llm"],
          getCapabilities: () => [mockLlmCapability],
        }),
      );

      registry.resolveCapabilities(makeContext());
      expect(registry.hasCapability("llm")).toBe(true);
    });

    it("returns undefined for missing capabilities", () => {
      registry.resolveCapabilities(makeContext());
      expect(registry.getCapability("llm")).toBeUndefined();
      expect(registry.hasCapability("llm")).toBe(false);
    });
  });

  describe("getCapability()", () => {
    it("returns the first matching capability", () => {
      registry.register(
        makePlugin({
          name: "llm-provider",
          capabilities: ["llm"],
          getCapabilities: () => [mockLlmCapability],
        }),
      );
      registry.resolveCapabilities(makeContext());

      const cap = registry.getCapability<LlmCapability>("llm");
      expect(cap).toBeDefined();
      expect(cap!.name).toBe("llm");
      expect(cap!.provider.name).toBe("mock");
    });
  });

  describe("getAllCapabilities()", () => {
    it("returns all language capabilities from multiple plugins", () => {
      const pyCapability: LanguageCapability = {
        name: "language",
        extensions: [".py"],
        languageName: "Python",
        createAdapter: () => ({}),
      };
      const swiftCapability: LanguageCapability = {
        name: "language",
        extensions: [".swift"],
        languageName: "Swift",
        createAdapter: () => ({}),
      };

      registry.register(
        makePlugin({
          name: "python",
          capabilities: ["language"],
          getCapabilities: () => [pyCapability],
        }),
      );
      registry.register(
        makePlugin({
          name: "swift",
          capabilities: ["language"],
          getCapabilities: () => [swiftCapability],
        }),
      );

      registry.resolveCapabilities(makeContext());

      const langs = registry.getAllCapabilities<LanguageCapability>("language");
      expect(langs).toHaveLength(2);
      expect(langs.map((l) => l.languageName)).toEqual(["Python", "Swift"]);
    });
  });

  describe("requireCapability()", () => {
    it("returns capability when available", () => {
      registry.register(
        makePlugin({
          name: "llm-provider",
          capabilities: ["llm"],
          getCapabilities: () => [mockLlmCapability],
        }),
      );
      registry.resolveCapabilities(makeContext());

      const cap = registry.requireCapability<LlmCapability>("llm");
      expect(cap.provider.name).toBe("mock");
    });

    it("throws with user-friendly message when missing", () => {
      registry.resolveCapabilities(makeContext());

      expect(() => registry.requireCapability("llm")).toThrow(
        /No "llm" capability available/,
      );
      expect(() => registry.requireCapability("llm")).toThrow(
        /iw plugin add llm/,
      );
    });

    it("uses custom hint in error message", () => {
      registry.resolveCapabilities(makeContext());

      expect(() =>
        registry.requireCapability("persistence", "iw plugin add kg"),
      ).toThrow(/iw plugin add kg/);
    });
  });

  describe("listCapabilities()", () => {
    it("lists all available capability names", () => {
      registry.register(
        makePlugin({
          name: "full",
          capabilities: ["llm", "persistence"],
          getCapabilities: () => [
            mockLlmCapability,
            {
              name: "persistence" as const,
              persist: async () => ({ entityCount: 0, relationshipCount: 0 }),
              query: async () => [],
              close: async () => {},
            } satisfies PersistenceCapability,
          ],
        }),
      );
      registry.resolveCapabilities(makeContext());

      const names = registry.listCapabilities();
      expect(names).toContain("llm");
      expect(names).toContain("persistence");
    });
  });

  // ===========================================================================
  // Command & MCP registration
  // ===========================================================================

  describe("registerAllCommands()", () => {
    it("calls registerCommands on all plugins", () => {
      const added: string[] = [];
      const host = {
        addCommand(cmd: unknown) {
          added.push((cmd as { name: string }).name);
        },
      };

      registry.register(
        makePlugin({
          name: "alpha",
          registerCommands(h) {
            h.addCommand({ name: "alpha-cmd" });
          },
        }),
      );
      registry.register(
        makePlugin({
          name: "beta",
          registerCommands(h) {
            h.addCommand({ name: "beta-cmd" });
          },
        }),
      );

      registry.registerAllCommands(host, makeContext());
      expect(added).toEqual(["alpha-cmd", "beta-cmd"]);
    });

    it("skips plugins without registerCommands", () => {
      registry.register(makePlugin({ name: "no-cmds" }));

      const host = { addCommand: () => {} };
      expect(() =>
        registry.registerAllCommands(host, makeContext()),
      ).not.toThrow();
    });
  });

  describe("registerAllMcpTools()", () => {
    it("calls registerMcpTools on all plugins", () => {
      const tools: string[] = [];
      const host = {
        tool(name: string) {
          tools.push(name);
        },
      };

      registry.register(
        makePlugin({
          name: "kg",
          registerMcpTools(h) {
            h.tool("kg_query", {}, () => {});
            h.tool("kg_context", {}, () => {});
          },
        }),
      );

      registry.registerAllMcpTools(host, makeContext());
      expect(tools).toEqual(["kg_query", "kg_context"]);
    });
  });

  // ===========================================================================
  // Singleton
  // ===========================================================================

  describe("getPluginRegistry() / setPluginRegistry()", () => {
    it("returns a shared singleton", () => {
      const a = getPluginRegistry();
      const b = getPluginRegistry();
      expect(a).toBe(b);
    });

    it("can be replaced for testing", () => {
      const custom = new PluginRegistry();
      setPluginRegistry(custom);
      expect(getPluginRegistry()).toBe(custom);

      // Reset
      setPluginRegistry(new PluginRegistry());
    });
  });
});
