// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM Provider Types
 *
 * Re-exports from core + internal types for LLM provider implementations.
 */

// Re-export core types
export type {
  LLMProvider,
  LLMRequest,
  LLMMessage,
  LLMResponse,
  LLMProviderCapabilities,
} from "@intentweave/core";

/**
 * OpenAI-specific configuration
 */
export interface OpenAIConfig {
  /** API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;

  /** Model to use (defaults to gpt-4o-mini) */
  model?: string;

  /** Base URL for API (for Azure OpenAI or proxies) */
  baseURL?: string;

  /** Organization ID */
  organization?: string;

  /** Default temperature */
  defaultTemperature?: number;

  /** Default max tokens */
  defaultMaxTokens?: number;

  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Mock LLM configuration for testing
 */
export interface MockLLMConfig {
  /** Fixed response to return */
  defaultResponse?: string;

  /** Parsed JSON to return when responseSchema is provided */
  defaultParsed?: unknown;

  /** Simulated latency in milliseconds */
  latencyMs?: number;

  /** Capture requests for assertions */
  captureRequests?: boolean;

  /** Response fixtures by prompt content */
  fixtures?: Map<string, MockLLMFixture>;
}

/**
 * Mock fixture for specific prompts
 */
export interface MockLLMFixture {
  /** Response content */
  content: string;

  /** Parsed JSON response */
  parsed?: unknown;

  /** Simulated error */
  error?: string;
}
