// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI-compatible LLM Provider
 *
 * Self-contained provider for OpenAI, Azure OpenAI, and compatible APIs.
 * Uses raw fetch — no SDK dependency.
 */

import type {
  LLMProviderV2,
  LLMRequest,
  LLMResponse,
  LLMProviderCapabilities,
} from "@intentweave/core";

// =============================================================================
// Configuration
// =============================================================================

export interface OpenAIConfig {
  /** API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;

  /** Model to use (defaults to gpt-5-mini) */
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

// =============================================================================
// Model capabilities
// =============================================================================

interface ModelCapabilities {
  maxTokens: number;
  supportsJsonSchema: boolean;
  /** GPT-5+ uses max_completion_tokens instead of max_tokens */
  useCompletionTokensParam?: boolean;
  /** Some models only support temperature=1 */
  fixedTemperature?: number;
}

const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // GPT-5 series (2025-2026) - use max_completion_tokens, fixed temperature
  "gpt-5.1-codex-mini": {
    maxTokens: 256000,
    supportsJsonSchema: true,
    useCompletionTokensParam: true,
    fixedTemperature: 1,
  },
  "gpt-5.1": {
    maxTokens: 256000,
    supportsJsonSchema: true,
    useCompletionTokensParam: true,
    fixedTemperature: 1,
  },
  "gpt-5-mini": {
    maxTokens: 256000,
    supportsJsonSchema: true,
    useCompletionTokensParam: true,
    fixedTemperature: 1,
  },
  "gpt-5": {
    maxTokens: 256000,
    supportsJsonSchema: true,
    useCompletionTokensParam: true,
    fixedTemperature: 1,
  },
  // GPT-4o series (2024-2025) - use max_tokens
  "gpt-4o": { maxTokens: 128000, supportsJsonSchema: true },
  "gpt-4o-mini": { maxTokens: 128000, supportsJsonSchema: true },
  "gpt-4o-mini-2024-07-18": { maxTokens: 128000, supportsJsonSchema: true },
  "gpt-4-turbo": { maxTokens: 128000, supportsJsonSchema: false },
  "gpt-4": { maxTokens: 8192, supportsJsonSchema: false },
  "gpt-3.5-turbo": { maxTokens: 16385, supportsJsonSchema: false },
};

const DEFAULT_MODEL = "gpt-5-mini";

function resolveModelCapabilities(model: string): ModelCapabilities {
  const exact = MODEL_CAPABILITIES[model];
  if (exact) return exact;
  if (model.startsWith("gpt-5")) return MODEL_CAPABILITIES["gpt-5"]!;
  if (model.startsWith("gpt-4o-mini")) {
    return MODEL_CAPABILITIES["gpt-4o-mini"]!;
  }
  if (model.startsWith("gpt-4o")) return MODEL_CAPABILITIES["gpt-4o"]!;
  return { maxTokens: 16_384, supportsJsonSchema: false };
}

function usesCompletionTokensParam(model: string): boolean {
  const caps = MODEL_CAPABILITIES[model];
  if (caps?.useCompletionTokensParam !== undefined) {
    return caps.useCompletionTokensParam;
  }
  return (
    model.startsWith("gpt-5") ||
    model.startsWith("o1") ||
    model.startsWith("o3")
  );
}

function getModelTemperature(model: string, requestedTemp?: number): number {
  const caps = MODEL_CAPABILITIES[model];
  if (caps?.fixedTemperature !== undefined) {
    return caps.fixedTemperature;
  }
  if (
    model.startsWith("gpt-5") ||
    model.startsWith("o1") ||
    model.startsWith("o3")
  ) {
    return 1;
  }
  return requestedTemp ?? 0.1;
}

// =============================================================================
// Provider implementation
// =============================================================================

export class OpenAILLMProvider implements LLMProviderV2 {
  readonly name = "openai";
  readonly contractVersion = 2 as const;

  private readonly config: Required<
    Pick<
      OpenAIConfig,
      "model" | "defaultTemperature" | "defaultMaxTokens" | "timeoutMs"
    >
  > &
    OpenAIConfig;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenAIConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseURL = config.baseURL ?? "https://api.openai.com/v1";

    const model = config.model ?? DEFAULT_MODEL;
    const isReasoningModel = usesCompletionTokensParam(model);

    this.config = {
      ...config,
      model,
      defaultTemperature: config.defaultTemperature ?? 0.1,
      defaultMaxTokens: config.defaultMaxTokens ?? 16384,
      timeoutMs: config.timeoutMs ?? (isReasoningModel ? 300_000 : 60_000),
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  get capabilities(): LLMProviderCapabilities {
    return this.capabilitiesFor(this.config.model);
  }

  capabilitiesFor(model = this.config.model): LLMProviderCapabilities {
    const modelCaps = resolveModelCapabilities(model);

    return {
      maxInputTokens: modelCaps.maxTokens,
      supportsJsonSchema: modelCaps.supportsJsonSchema,
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsEmbeddings: true,
      structuredOutputModes: modelCaps.supportsJsonSchema
        ? ["strict", "text"]
        : ["text"],
    };
  }

  getModelName(): string {
    return this.config.model;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    const model = request.model ?? this.config.model;

    if (!this.apiKey) {
      return {
        content: "",
        tokensUsed: { prompt: 0, completion: 0 },
        latencyMs: Date.now() - startTime,
        model,
        finishReason: "error",
        error:
          "OpenAI API key not configured. Set OPENAI_API_KEY environment variable.",
        errorKind: "provider",
      };
    }

    try {
      const messages: Array<{ role: string; content: string }> = [];

      if (request.system) {
        messages.push({ role: "system", content: request.system });
      }

      for (const msg of request.messages) {
        messages.push({ role: msg.role, content: msg.content });
      }

      const maxTokensValue = request.maxTokens ?? this.config.defaultMaxTokens;
      const temperatureValue = getModelTemperature(
        model,
        request.temperature ?? this.config.defaultTemperature,
      );
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: temperatureValue,
      };

      if (usesCompletionTokensParam(model)) {
        body.max_completion_tokens = maxTokensValue;
      } else {
        body.max_tokens = maxTokensValue;
      }

      if (
        request.responseSchema &&
        this.capabilitiesFor(model).supportsJsonSchema
      ) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: request.responseSchemaName ?? "extraction_response",
            strict: true,
            schema: request.responseSchema,
          },
        };
      }

      const timeoutSignal = AbortSignal.timeout(
        request.timeoutMs ?? this.config.timeoutMs,
      );
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.config.organization && {
            "OpenAI-Organization": this.config.organization,
          }),
        },
        body: JSON.stringify(body),
        signal,
      });

      const requestId = response.headers.get("x-request-id") ?? undefined;

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: "",
          tokensUsed: { prompt: 0, completion: 0 },
          latencyMs: Date.now() - startTime,
          model,
          finishReason: "error",
          error: `OpenAI API error (${response.status}): ${errorText}`,
          errorKind: response.status === 429 ? "rate_limit" : "provider",
          statusCode: response.status,
          ...(requestId ? { requestId } : {}),
        };
      }

      const data = (await response.json()) as OpenAICompletionResponse;
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? "";
      const refusal = choice?.message?.refusal ?? undefined;

      let parsed: unknown;
      if (request.responseSchema && content) {
        try {
          parsed = JSON.parse(content);
        } catch {
          // Content is not valid JSON — leave parsed undefined
        }
      }

      return {
        content,
        parsed,
        tokensUsed: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
          ...(data.usage?.completion_tokens_details?.reasoning_tokens ===
          undefined
            ? {}
            : {
                reasoning:
                  data.usage.completion_tokens_details.reasoning_tokens,
              }),
          ...(data.usage?.prompt_tokens_details?.cached_tokens === undefined
            ? {}
            : { cachedPrompt: data.usage.prompt_tokens_details.cached_tokens }),
        },
        latencyMs: Date.now() - startTime,
        model: data.model ?? model,
        finishReason: mapFinishReason(choice?.finish_reason, refusal),
        ...(refusal ? { refusal } : {}),
        ...(requestId ? { requestId } : {}),
        ...(data.system_fingerprint
          ? { modelRevision: data.system_fingerprint }
          : {}),
      };
    } catch (error) {
      const cancelled = request.signal?.aborted === true;
      const timeout =
        !cancelled &&
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name);
      return {
        content: "",
        tokensUsed: { prompt: 0, completion: 0 },
        latencyMs: Date.now() - startTime,
        model,
        finishReason: "error",
        error: error instanceof Error ? error.message : String(error),
        errorKind: cancelled ? "cancelled" : timeout ? "timeout" : "transport",
      };
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("OpenAI API key not configured");
    }

    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embeddings error: ${response.status}`);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;
    return data.data?.[0]?.embedding ?? [];
  }
}

// =============================================================================
// Helpers
// =============================================================================

function mapFinishReason(
  reason?: string,
  refusal?: string,
): LLMResponse["finishReason"] {
  if (refusal) return "refusal";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

interface OpenAICompletionResponse {
  id: string;
  model: string;
  system_fingerprint?: string;
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
}
