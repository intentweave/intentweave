// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMProviderCapabilities,
} from "@intentweave/core";

export interface SmartMockOptions {
  /** Key used to namespace fixture files under `.iw/captures/<workspaceKey>/`. */
  workspaceKey?: string;
}

/**
 * SmartMockLLMProvider
 *
 * Fallback provider used when no real LLM is configured (no API key / `--provider mock`).
 * Always reports itself as unavailable and throws a descriptive error on `complete()`.
 *
 * A future version may read pre-recorded fixture files from
 * `.iw/captures/<workspaceKey>/` to enable offline replay.
 */
export class SmartMockLLMProvider implements LLMProvider {
  readonly name = "smart-mock";

  readonly capabilities: LLMProviderCapabilities = {
    maxInputTokens: 16_000,
    supportsJsonSchema: false,
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsEmbeddings: false,
  };

  constructor(private readonly _opts?: SmartMockOptions) {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async complete(_request: LLMRequest): Promise<LLMResponse> {
    const key = this._opts?.workspaceKey ?? "default";
    throw new Error(
      `SmartMockLLMProvider (workspaceKey="${key}"): no real LLM configured. ` +
        "Set OPENAI_API_KEY and pass --provider openai, " +
        `or place fixture responses in .iw/captures/${key}/.`,
    );
  }

  getModelName(): string {
    return "smart-mock";
  }
}
