// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  IWPlugin,
  LlmCapability,
  PluginContext,
} from "@intentweave/core";
import llmPlugin, { OpenAILLMProvider } from "../index.js";

// =============================================================================
// Helpers
// =============================================================================

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    workspaceRoot: "/tmp/test",
    indexDbPath: "/tmp/test/.iw/index.db",
    session: "test",
    verbose: false,
    ...overrides,
  };
}

// =============================================================================
// Plugin metadata
// =============================================================================

describe("plugin-llm", () => {
  describe("metadata", () => {
    it("has correct name", () => {
      expect(llmPlugin.name).toBe("llm");
    });

    it("has version", () => {
      expect(llmPlugin.version).toBe("0.8.0");
    });

    it("has description", () => {
      expect(llmPlugin.description).toBeDefined();
      expect(llmPlugin.description.length).toBeGreaterThan(0);
    });

    it("declares llm capability", () => {
      expect(llmPlugin.capabilities).toEqual(["llm"]);
    });

    it("has no dependencies", () => {
      expect(llmPlugin.dependencies).toBeUndefined();
    });

    it("is a valid IWPlugin", () => {
      const plugin: IWPlugin = llmPlugin;
      expect(plugin.name).toBe("llm");
      expect(typeof plugin.getCapabilities).toBe("function");
    });
  });

  // ===========================================================================
  // getCapabilities
  // ===========================================================================

  describe("getCapabilities", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      // Reset env vars
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_ORGANIZATION;
      delete process.env.IW_LLM_MODEL;
    });

    // Restore after all tests
    afterAll(() => {
      Object.assign(process.env, originalEnv);
    });

    it("returns one LlmCapability", () => {
      const caps = llmPlugin.getCapabilities!(makeContext());
      expect(caps).toHaveLength(1);
      expect(caps[0].name).toBe("llm");
    });

    it("provider has name 'openai'", () => {
      const caps = llmPlugin.getCapabilities!(makeContext());
      const llm = caps[0] as LlmCapability;
      expect(llm.provider.name).toBe("openai");
    });

    it("provider is not available without API key", async () => {
      const caps = llmPlugin.getCapabilities!(makeContext());
      const llm = caps[0] as LlmCapability;
      expect(await llm.provider.isAvailable()).toBe(false);
    });

    it("provider is available with API key", async () => {
      process.env.OPENAI_API_KEY = "sk-test-key-123";
      const caps = llmPlugin.getCapabilities!(makeContext());
      const llm = caps[0] as LlmCapability;
      expect(await llm.provider.isAvailable()).toBe(true);
    });

    it("uses IW_LLM_MODEL env var when set", () => {
      process.env.IW_LLM_MODEL = "gpt-4o";
      const caps = llmPlugin.getCapabilities!(makeContext());
      const llm = caps[0] as LlmCapability;
      expect(llm.provider.getModelName!()).toBe("gpt-4o");
    });

    it("defaults to gpt-5-mini", () => {
      const caps = llmPlugin.getCapabilities!(makeContext());
      const llm = caps[0] as LlmCapability;
      expect(llm.provider.getModelName!()).toBe("gpt-5-mini");
    });

    it("provider reports capabilities", () => {
      const caps = llmPlugin.getCapabilities!(makeContext());
      const llm = caps[0] as LlmCapability;
      expect(llm.provider.capabilities).toBeDefined();
      expect(llm.provider.capabilities.supportsJsonSchema).toBe(true);
      expect(llm.provider.capabilities.maxInputTokens).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // OpenAILLMProvider (direct)
  // ===========================================================================

  describe("OpenAILLMProvider", () => {
    it("constructor accepts empty config", () => {
      const provider = new OpenAILLMProvider();
      expect(provider.name).toBe("openai");
    });

    it("constructor accepts full config", () => {
      const provider = new OpenAILLMProvider({
        apiKey: "sk-test",
        model: "gpt-4o",
        baseURL: "https://custom.api.com/v1",
        organization: "org-test",
        defaultTemperature: 0.5,
        defaultMaxTokens: 4096,
        timeoutMs: 30000,
      });
      expect(provider.getModelName()).toBe("gpt-4o");
    });

    it("reports correct capabilities for GPT-5 model", () => {
      const provider = new OpenAILLMProvider({ model: "gpt-5-mini" });
      expect(provider.capabilities.maxInputTokens).toBe(256000);
      expect(provider.capabilities.supportsJsonSchema).toBe(true);
    });

    it("reports correct capabilities for GPT-4o model", () => {
      const provider = new OpenAILLMProvider({ model: "gpt-4o" });
      expect(provider.capabilities.maxInputTokens).toBe(128000);
      expect(provider.capabilities.supportsJsonSchema).toBe(true);
    });

    it("returns error response when no API key", async () => {
      const provider = new OpenAILLMProvider({ apiKey: "" });
      const response = await provider.complete({
        messages: [{ role: "user", content: "test" }],
      });
      expect(response.finishReason).toBe("error");
      expect(response.error).toContain("API key not configured");
    });

    it("throws on embed without API key", async () => {
      const provider = new OpenAILLMProvider({ apiKey: "" });
      await expect(provider.embed("test")).rejects.toThrow(
        "API key not configured",
      );
    });
  });

  // ===========================================================================
  // Default export (for plugin discovery)
  // ===========================================================================

  describe("default export", () => {
    it("is the same as llmPlugin", () => {
      expect(llmPlugin).toBeDefined();
      expect(llmPlugin.name).toBe("llm");
    });

    it("can be imported as default", async () => {
      const mod = await import("../index.js");
      expect(mod.default).toBe(llmPlugin);
      expect(mod.default.name).toBe("llm");
    });
  });

  // ===========================================================================
  // Integration with PluginRegistry
  // ===========================================================================

  describe("registry integration", () => {
    it("can be registered in a PluginRegistry", async () => {
      const { PluginRegistry } = await import("@intentweave/core");
      const registry = new PluginRegistry();
      registry.register(llmPlugin);

      const list = registry.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("llm");
    });

    it("resolves LlmCapability after registration", async () => {
      const { PluginRegistry } = await import("@intentweave/core");
      const registry = new PluginRegistry();
      registry.register(llmPlugin);
      registry.resolveCapabilities(makeContext());

      const cap = registry.getCapability<LlmCapability>("llm");
      expect(cap).toBeDefined();
      expect(cap!.name).toBe("llm");
      expect(cap!.provider.name).toBe("openai");
    });

    it("requireCapability succeeds after registration", async () => {
      const { PluginRegistry } = await import("@intentweave/core");
      const registry = new PluginRegistry();
      registry.register(llmPlugin);
      registry.resolveCapabilities(makeContext());

      const cap = registry.requireCapability<LlmCapability>("llm");
      expect(cap.provider.name).toBe("openai");
    });
  });
});
