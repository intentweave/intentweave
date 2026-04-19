// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/plugin-llm
 *
 * LLM provider plugin for IntentWeave. Wraps OpenAI-compatible APIs behind
 * the IWPlugin interface so the platform can discover and use LLM capabilities
 * without hard-coding provider imports.
 *
 * Discovery: the default export is an IWPlugin instance that the PluginRegistry
 * picks up via `import("@intentweave/plugin-llm")`.
 */

import type {
  IWPlugin,
  LlmCapability,
  Capability,
  PluginContext,
} from "@intentweave/core";
import { OpenAILLMProvider, type OpenAIConfig } from "./openai.js";

// Re-export for consumers that want direct access
export { OpenAILLMProvider, type OpenAIConfig } from "./openai.js";

// =============================================================================
// Plugin definition
// =============================================================================

const llmPlugin: IWPlugin = {
  name: "llm",
  version: "0.8.0",
  description: "LLM provider for OpenAI-compatible APIs (--explain, --provider)",
  capabilities: ["llm"],

  getCapabilities(_context: PluginContext): Capability[] {
    const config: OpenAIConfig = {
      // Let the provider pick up OPENAI_API_KEY from env
      model: process.env.IW_LLM_MODEL ?? "gpt-5-mini",
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      organization: process.env.OPENAI_ORGANIZATION,
    };

    const provider = new OpenAILLMProvider(config);

    const capability: LlmCapability = {
      name: "llm",
      provider,
    };

    return [capability];
  },
};

export default llmPlugin;
