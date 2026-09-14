// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import {
  isLLMProviderV2,
  type LLMFinishReason,
  type LLMMessage,
  type LLMProvider,
  type LLMResponse,
  type LLMStructuredOutputMode,
  type LLMTransportErrorKind,
} from "../interfaces.js";

export interface StructuredInferenceRequest {
  schemaName: string;
  responseSchema: Record<string, unknown>;
  system?: string;
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StructuredInferenceMeta {
  providerId: string;
  requestedModelId?: string;
  effectiveModelId: string;
  modelRevision?: string;
  requestId?: string;
  structuredOutput: LLMStructuredOutputMode;
  finishReason:
    | "stop"
    | "length"
    | "refusal"
    | "content_filter"
    | "error"
    | "other";
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  latencyMs: number;
  rawOutputFingerprint?: string;
}

export type StructuredInferenceFailureKind =
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "refusal"
  | "content_filter"
  | "truncated"
  | "invalid_json"
  | "schema_mismatch"
  | "transport"
  | "provider";

export interface StructuredInferenceFailure {
  kind: StructuredInferenceFailureKind;
  retryable: boolean;
  statusCode?: number;
  message: string;
  validationErrors?: Array<{
    instancePath: string;
    schemaPath: string;
    message: string;
  }>;
}

export type StructuredInferenceResult<T = unknown> =
  | { ok: true; value: T; meta: StructuredInferenceMeta }
  | {
      ok: false;
      failure: StructuredInferenceFailure;
      meta: StructuredInferenceMeta;
    };

function normalizedFinishReason(
  reason: LLMFinishReason,
): StructuredInferenceMeta["finishReason"] {
  return reason === "tool_calls" ? "other" : reason;
}

function outputFingerprint(response: LLMResponse): string | undefined {
  const raw =
    response.content ||
    (response.parsed === undefined ? "" : JSON.stringify(response.parsed));
  if (!raw) return undefined;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function responseMeta(
  provider: LLMProvider,
  request: StructuredInferenceRequest,
  mode: LLMStructuredOutputMode,
  response?: LLMResponse,
  fallback?: {
    finishReason?: StructuredInferenceMeta["finishReason"];
    latencyMs?: number;
  },
): StructuredInferenceMeta {
  const requestedModelId = request.model;
  const effectiveModelId =
    response?.model ?? request.model ?? provider.getModelName?.() ?? "unknown";
  const rawOutputFingerprint = response
    ? outputFingerprint(response)
    : undefined;
  return {
    providerId: provider.name,
    ...(requestedModelId ? { requestedModelId } : {}),
    effectiveModelId,
    ...(response?.modelRevision
      ? { modelRevision: response.modelRevision }
      : {}),
    ...(response?.requestId ? { requestId: response.requestId } : {}),
    structuredOutput: mode,
    finishReason:
      fallback?.finishReason ??
      (response ? normalizedFinishReason(response.finishReason) : "error"),
    usage: {
      inputTokens: response?.tokensUsed.prompt ?? 0,
      outputTokens: response?.tokensUsed.completion ?? 0,
      ...(response?.tokensUsed.reasoning === undefined
        ? {}
        : { reasoningTokens: response.tokensUsed.reasoning }),
      ...(response?.tokensUsed.cachedPrompt === undefined
        ? {}
        : { cachedInputTokens: response.tokensUsed.cachedPrompt }),
    },
    latencyMs: response?.latencyMs ?? fallback?.latencyMs ?? 0,
    ...(rawOutputFingerprint ? { rawOutputFingerprint } : {}),
  };
}

function failure(
  meta: StructuredInferenceMeta,
  kind: StructuredInferenceFailureKind,
  message: string,
  options: {
    retryable?: boolean;
    statusCode?: number;
    validationErrors?: StructuredInferenceFailure["validationErrors"];
  } = {},
): StructuredInferenceResult<never> {
  return {
    ok: false,
    failure: {
      kind,
      retryable: options.retryable ?? false,
      ...(options.statusCode === undefined
        ? {}
        : { statusCode: options.statusCode }),
      message,
      ...(options.validationErrors
        ? { validationErrors: options.validationErrors }
        : {}),
    },
    meta,
  };
}

function transportFailureKind(
  kind: LLMTransportErrorKind | undefined,
): StructuredInferenceFailureKind {
  return kind ?? "provider";
}

function schemaErrors(
  errors: ErrorObject[] | null | undefined,
): StructuredInferenceFailure["validationErrors"] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    message: error.message ?? "schema validation failed",
  }));
}

/**
 * Provider-neutral boundary for Claims-grade model inference.
 * It never treats provider-side structured-output claims as local validation.
 */
export class StructuredInferenceService {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(private readonly provider: LLMProvider) {}

  async infer<T = unknown>(
    request: StructuredInferenceRequest,
  ): Promise<StructuredInferenceResult<T>> {
    if (!isLLMProviderV2(this.provider)) {
      return failure(
        responseMeta(this.provider, request, "text"),
        "provider",
        `LLM provider ${this.provider.name} does not implement transport contract v2`,
      );
    }

    let validate: ValidateFunction;
    try {
      validate = this.ajv.compile(request.responseSchema);
    } catch (error) {
      return failure(
        responseMeta(this.provider, request, "text"),
        "schema_mismatch",
        `Invalid response schema ${request.schemaName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (request.signal?.aborted) {
      return failure(
        responseMeta(this.provider, request, "text"),
        "cancelled",
        "Structured inference was cancelled before the provider request",
      );
    }

    const capabilities = this.provider.capabilitiesFor(
      request.model ?? this.provider.getModelName?.(),
    );
    const modes =
      capabilities.structuredOutputModes ??
      (capabilities.supportsJsonSchema ? ["strict"] : ["text"]);
    const mode = modes[0] ?? "text";
    const startedAt = Date.now();
    let response: LLMResponse;
    try {
      response = await this.provider.complete({
        system: request.system,
        messages: request.messages,
        responseSchema: request.responseSchema,
        responseSchemaName: request.schemaName,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        model: request.model,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
    } catch (error) {
      const cancelled = request.signal?.aborted === true;
      const timeout =
        !cancelled &&
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name);
      const kind = cancelled ? "cancelled" : timeout ? "timeout" : "transport";
      return failure(
        responseMeta(this.provider, request, mode, undefined, {
          latencyMs: Date.now() - startedAt,
        }),
        kind,
        error instanceof Error ? error.message : String(error),
        { retryable: kind === "timeout" || kind === "transport" },
      );
    }

    const meta = responseMeta(this.provider, request, mode, response);
    if (response.finishReason === "refusal") {
      return failure(
        meta,
        "refusal",
        response.refusal ??
          response.error ??
          "The provider refused the request",
      );
    }
    if (response.finishReason === "content_filter") {
      return failure(
        meta,
        "content_filter",
        response.error ?? "The provider filtered the response",
      );
    }
    if (response.finishReason === "length") {
      return failure(meta, "truncated", "The provider response was truncated", {
        retryable: true,
      });
    }
    if (response.finishReason === "error") {
      const kind = transportFailureKind(response.errorKind);
      return failure(meta, kind, response.error ?? "Provider request failed", {
        retryable:
          ["rate_limit", "timeout", "transport"].includes(kind) ||
          (response.statusCode !== undefined && response.statusCode >= 500),
        statusCode: response.statusCode,
      });
    }
    if (response.finishReason !== "stop") {
      return failure(
        meta,
        "provider",
        `Provider completed with unsupported finish reason ${response.finishReason}`,
      );
    }

    let value = response.parsed;
    if (value === undefined) {
      try {
        value = JSON.parse(response.content);
      } catch {
        return failure(
          meta,
          "invalid_json",
          "Provider output is not valid JSON",
        );
      }
    }
    if (!validate(value)) {
      return failure(
        meta,
        "schema_mismatch",
        `Provider output does not match schema ${request.schemaName}`,
        { validationErrors: schemaErrors(validate.errors) },
      );
    }
    return { ok: true, value: value as T, meta };
  }
}
