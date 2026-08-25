// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  StructuredInferenceService,
  type LLMProvider,
  type LLMProviderCapabilities,
  type LLMProviderV2,
  type LLMRequest,
  type LLMResponse,
} from "../index.js";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidate"],
  properties: {
    candidate: { type: "string" },
  },
};

const CAPABILITIES: LLMProviderCapabilities = {
  maxInputTokens: 128_000,
  supportsJsonSchema: true,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsEmbeddings: false,
  structuredOutputModes: ["strict", "text"],
};

function response(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: JSON.stringify({ candidate: "document public endpoints" }),
    tokensUsed: { prompt: 12, completion: 7 },
    latencyMs: 24,
    model: "effective-model",
    finishReason: "stop",
    ...overrides,
  };
}

class StubV2Provider implements LLMProviderV2 {
  readonly name = "stub-v2";
  readonly contractVersion = 2 as const;
  readonly capabilities = CAPABILITIES;
  readonly complete = vi.fn<(request: LLMRequest) => Promise<LLMResponse>>();
  readonly capabilitiesFor = vi.fn(() => CAPABILITIES);

  constructor(
    result: LLMResponse | ((request: LLMRequest) => Promise<LLMResponse>),
  ) {
    this.complete.mockImplementation(
      typeof result === "function" ? result : async () => result,
    );
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getModelName(): string {
    return "configured-model";
  }
}

function request(signal?: AbortSignal) {
  return {
    schemaName: "claim_candidate",
    responseSchema: RESPONSE_SCHEMA,
    messages: [{ role: "user" as const, content: "Find a candidate" }],
    model: "requested-model",
    ...(signal ? { signal } : {}),
  };
}

describe("StructuredInferenceService", () => {
  it("validates locally and preserves effective-model provenance", async () => {
    const provider = new StubV2Provider(
      response({
        parsed: { candidate: "document public endpoints" },
        requestId: "req_123",
        modelRevision: "revision-a",
        tokensUsed: {
          prompt: 12,
          completion: 7,
          reasoning: 3,
          cachedPrompt: 5,
        },
      }),
    );

    const result = await new StructuredInferenceService(provider).infer<{
      candidate: string;
    }>(request());

    expect(result).toMatchObject({
      ok: true,
      value: { candidate: "document public endpoints" },
      meta: {
        providerId: "stub-v2",
        requestedModelId: "requested-model",
        effectiveModelId: "effective-model",
        modelRevision: "revision-a",
        requestId: "req_123",
        structuredOutput: "strict",
        finishReason: "stop",
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          reasoningTokens: 3,
          cachedInputTokens: 5,
        },
      },
    });
    expect(provider.capabilitiesFor).toHaveBeenCalledWith("requested-model");
    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        responseSchemaName: "claim_candidate",
        responseSchema: RESPONSE_SCHEMA,
      }),
    );
    expect(result.meta.rawOutputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes invalid JSON from a local schema mismatch", async () => {
    const invalidJson = await new StructuredInferenceService(
      new StubV2Provider(response({ content: "not-json" })),
    ).infer(request());
    expect(invalidJson).toMatchObject({
      ok: false,
      failure: { kind: "invalid_json", retryable: false },
    });

    const wrongShape = await new StructuredInferenceService(
      new StubV2Provider(
        response({ content: JSON.stringify({ other: true }) }),
      ),
    ).infer(request());
    expect(wrongShape).toMatchObject({
      ok: false,
      failure: {
        kind: "schema_mismatch",
        retryable: false,
        validationErrors: expect.any(Array),
      },
    });
  });

  it.each([
    ["refusal", "refusal"],
    ["content_filter", "content_filter"],
    ["length", "truncated"],
    ["other", "provider"],
  ] as const)("maps %s to the typed %s failure", async (finishReason, kind) => {
    const result = await new StructuredInferenceService(
      new StubV2Provider(
        response({
          content: "",
          finishReason,
          ...(finishReason === "refusal" ? { refusal: "cannot comply" } : {}),
        }),
      ),
    ).infer(request());
    expect(result).toMatchObject({ ok: false, failure: { kind } });
  });

  it("preserves rate-limit transport metadata", async () => {
    const result = await new StructuredInferenceService(
      new StubV2Provider(
        response({
          content: "",
          finishReason: "error",
          error: "too many requests",
          errorKind: "rate_limit",
          statusCode: 429,
        }),
      ),
    ).infer(request());
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "rate_limit",
        retryable: true,
        statusCode: 429,
      },
    });

    const serverError = await new StructuredInferenceService(
      new StubV2Provider(
        response({
          content: "",
          finishReason: "error",
          error: "provider unavailable",
          errorKind: "provider",
          statusCode: 503,
        }),
      ),
    ).infer(request());
    expect(serverError).toMatchObject({
      ok: false,
      failure: { kind: "provider", retryable: true, statusCode: 503 },
    });
  });

  it("rejects legacy providers without making a model call", async () => {
    const complete = vi.fn(async () => response());
    const legacy: LLMProvider = {
      name: "legacy",
      capabilities: CAPABILITIES,
      isAvailable: async () => true,
      complete,
    };
    const result = await new StructuredInferenceService(legacy).infer(
      request(),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "provider" },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps caller cancellation distinct from timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new StubV2Provider(response());
    const cancelled = await new StructuredInferenceService(provider).infer(
      request(controller.signal),
    );
    expect(cancelled).toMatchObject({
      ok: false,
      failure: { kind: "cancelled", retryable: false },
    });
    expect(provider.complete).not.toHaveBeenCalled();

    const timeoutProvider = new StubV2Provider(async () => {
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      throw error;
    });
    const timedOut = await new StructuredInferenceService(
      timeoutProvider,
    ).infer(request());
    expect(timedOut).toMatchObject({
      ok: false,
      failure: { kind: "timeout", retryable: true },
    });
  });
});
