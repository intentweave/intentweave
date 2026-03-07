// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM Provider Factory
 * 
 * Canonical factory for creating LLM providers. All code (CLI, server, etc.)
 * should use this instead of implementing their own factory logic.
 */

import { SmartMockLLMProvider } from './smart-mock.js';
import { OpenAILLMProvider } from './openai.js';
import type { LLMProvider } from './types.js';

/**
 * Configuration for creating an LLM provider
 */
export interface LlmProviderConfig {
  /** Provider type: 'openai' or 'smart-mock' */
  provider: 'openai' | 'smart-mock';
  
  /** API key for OpenAI (uses OPENAI_API_KEY env var if not provided) */
  apiKey?: string;
  
  /** Model name for OpenAI (default: 'gpt-5.1-mini') */
  model?: string;
  
  /** Workspace key for smart-mock provider */
  workspaceKey?: string;
}

/**
 * Create an LLM provider from configuration.
 * 
 * This is the canonical factory - all code (CLI, server, etc.) should
 * use this instead of implementing their own provider creation logic.
 * 
 * @param config - Provider configuration
 * @returns LLM provider instance
 * @throws Error if OpenAI provider is requested without API key
 */
export function createLlmProvider(config: LlmProviderConfig): LLMProvider {
  if (config.provider === 'openai') {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key required');
    }
    return new OpenAILLMProvider({ 
      apiKey, 
      model: config.model ?? 'gpt-5-mini',
    });
  } else {
    return new SmartMockLLMProvider({ 
      workspaceKey: config.workspaceKey ?? 'default',
    });
  }
}
