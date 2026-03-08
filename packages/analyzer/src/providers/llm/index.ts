// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM Providers
 *
 * Low-level LLM provider implementations for prompt→completion transport.
 */

// Types
export * from "./types.js";

// Factory
export { createLlmProvider, type LlmProviderConfig } from "./factory.js";

// Providers
export { SmartMockLLMProvider, type SmartMockConfig } from "./smart-mock.js";
export { OpenAILLMProvider, createOpenAILLMProvider } from "./openai.js";
export {
  MockLLMProvider,
  createMockLLMProvider,
  createMockLLMProviderWithEntities,
} from "./mock.js";

// Retry wrapper
export { completeWithRetry } from "./completeWithRetry.js";
