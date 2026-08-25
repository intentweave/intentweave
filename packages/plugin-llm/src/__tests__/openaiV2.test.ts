// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAILLMProvider } from "../openai.js";

function completionResponse(
  payload: Record<string, unknown>,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...init.headers },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAILLMProvider v2 contract", () => {
  it("preserves refusal, request, model revision, and detailed usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      completionResponse(
        {
          id: "chatcmpl_123",
          model: "effective-model",
          system_fingerprint: "fp_revision",
          choices: [
            {
              message: { content: null, refusal: "I cannot classify this" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 8 },
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        },
        { headers: { "x-request-id": "req_123" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAILLMProvider({
      apiKey: "test-key",
      model: "gpt-4o",
    });

    const result = await provider.complete({
      messages: [{ role: "user", content: "classify" }],
      responseSchemaName: "claim_candidate",
      responseSchema: {
        type: "object",
        properties: { candidate: { type: "string" } },
      },
    });

    expect(provider.contractVersion).toBe(2);
    expect(result).toMatchObject({
      finishReason: "refusal",
      refusal: "I cannot classify this",
      requestId: "req_123",
      model: "effective-model",
      modelRevision: "fp_revision",
      tokensUsed: {
        prompt: 20,
        completion: 4,
        reasoning: 3,
        cachedPrompt: 8,
      },
    });
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, any>;
    expect(body.response_format.json_schema.name).toBe("claim_candidate");
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it.each([
    ["content_filter", "content_filter"],
    ["future_provider_reason", "other"],
  ])(
    "preserves provider finish reason %s as %s",
    async (wireReason, expected) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          completionResponse({
            id: "chatcmpl_123",
            model: "gpt-4o",
            choices: [{ message: { content: "" }, finish_reason: wireReason }],
          }),
        ),
      );
      const result = await new OpenAILLMProvider({
        apiKey: "test-key",
        model: "gpt-4o",
      }).complete({ messages: [{ role: "user", content: "classify" }] });
      expect(result.finishReason).toBe(expected);
    },
  );

  it("classifies rate limits without flattening the HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("rate limited", {
          status: 429,
          headers: { "x-request-id": "req_rate" },
        }),
      ),
    );
    const result = await new OpenAILLMProvider({
      apiKey: "test-key",
    }).complete({ messages: [{ role: "user", content: "classify" }] });
    expect(result).toMatchObject({
      finishReason: "error",
      errorKind: "rate_limit",
      statusCode: 429,
      requestId: "req_rate",
    });
  });

  it("resolves structured-output support for the request model override", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      completionResponse({
        id: "chatcmpl_legacy",
        model: "gpt-4",
        choices: [
          { message: { content: '{"candidate":"x"}' }, finish_reason: "stop" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAILLMProvider({
      apiKey: "test-key",
      model: "gpt-4o",
    }).complete({
      model: "gpt-4",
      messages: [{ role: "user", content: "classify" }],
      responseSchema: { type: "object" },
    });
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("response_format");
  });

  it("keeps caller cancellation distinct from transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        ),
    );
    const controller = new AbortController();
    controller.abort();
    const result = await new OpenAILLMProvider({
      apiKey: "test-key",
    }).complete({
      messages: [{ role: "user", content: "classify" }],
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      finishReason: "error",
      errorKind: "cancelled",
    });
  });
});
