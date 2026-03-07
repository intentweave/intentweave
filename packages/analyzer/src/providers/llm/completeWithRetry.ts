/**
 * LLM Call Wrapper with Retry
 *
 * Wraps LLMProvider.complete() with retry logic for transient failures.
 * Since the OpenAI provider returns `finishReason: 'error'` instead of
 * throwing, this wrapper inspects the response and retries when the error
 * appears transient (rate limit, server error, timeout).
 *
 * Two-phase retry strategy:
 *   Phase 1 (standard):  3 retries, 1s → 2s → 4s  — for rate limits, server blips
 *   Phase 2 (network):   3 retries, 15s → 30s → 60s — for network outages (macOS sleep, wifi drop)
 * Phase 2 only activates when Phase 1 exhausts all retries on a network error.
 */

import type { LLMProvider, LLMRequest, LLMResponse } from '@intentweave/core';
import { withRetry, type RetryOptions } from '@intentweave/core';

/**
 * Patterns in error messages that indicate a transient/retryable failure.
 */
const RETRYABLE_PATTERNS = [
  /\b429\b/,           // Rate limit
  /\b5\d{2}\b/,        // Server errors (500, 502, 503, etc.)
  /rate.?limit/i,
  /timeout/i,
  /timed?\s*out/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /fetch failed/i,
  /network/i,
  /aborted/i,
];

/**
 * Subset of patterns that indicate a network-level failure (as opposed to
 * a server-side error like 429 or 500). Used to decide whether to enter
 * the longer Phase 2 retry.
 */
const NETWORK_ERROR_PATTERNS = [
  /fetch failed/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /socket hang up/i,
  /network/i,
];

function isRetryableResponse(response: LLMResponse): boolean {
  if (response.finishReason !== 'error') return false;
  const msg = response.error ?? '';
  return RETRYABLE_PATTERNS.some(p => p.test(msg));
}

function isNetworkErrorMessage(msg: string): boolean {
  return NETWORK_ERROR_PATTERNS.some(p => p.test(msg));
}

/**
 * Call LLMProvider.complete() with automatic retry for transient errors.
 *
 * @param provider - The LLM provider
 * @param request  - The LLM request
 * @param options  - Retry options (default: 3 retries, 1s initial delay, 2x backoff)
 * @returns LLMResponse (either successful or a non-retryable error)
 */
export async function completeWithRetry(
  provider: LLMProvider,
  request: LLMRequest,
  options?: RetryOptions & {
    /** Optional logger for retry events */
    logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
  },
): Promise<LLMResponse> {
  const maxRetries = options?.maxRetries ?? 3;

  // Sentinel error to trigger retry
  class RetryableResponseError extends Error {
    constructor(public readonly response: LLMResponse) {
      super(response.error ?? 'retryable LLM error');
    }
  }

  // ─── Phase 1: Standard retry (fast backoff) ──────────────────────────
  let phase1Response: LLMResponse | undefined;

  try {
    return await withRetry(
      async () => {
        const response = await provider.complete(request);
        if (isRetryableResponse(response)) {
          throw new RetryableResponseError(response);
        }
        return response;
      },
      {
        maxRetries,
        initialDelayMs: options?.initialDelayMs ?? 1000,
        backoffMultiplier: options?.backoffMultiplier ?? 2,
        maxDelayMs: options?.maxDelayMs ?? 30_000,
        isRetryable: (err) => err instanceof RetryableResponseError,
        onRetry: (attempt, delay, err) => {
          options?.logger?.warn(
            `LLM call failed (attempt ${attempt}/${maxRetries}), retrying in ${(delay / 1000).toFixed(1)}s: ${err.message}`,
          );
          options?.onRetry?.(attempt, delay, err);
        },
      },
    );
  } catch (err) {
    if (err instanceof RetryableResponseError) {
      phase1Response = err.response;
    } else {
      throw err;
    }
  }

  // ─── Phase 2: Network recovery retry (slow backoff) ──────────────────
  // Only enter Phase 2 if the final Phase 1 error was a network-level failure.
  // Rate limits and server errors do NOT escalate — they're already handled.
  const errorMsg = phase1Response?.error ?? '';
  if (!isNetworkErrorMessage(errorMsg)) {
    return phase1Response!;
  }

  const NETWORK_RETRIES = 3;
  const NETWORK_INITIAL_DELAY_MS = 15_000;   // 15 seconds
  const NETWORK_BACKOFF = 2;
  const NETWORK_MAX_DELAY_MS = 120_000;       // 2 minutes

  options?.logger?.warn(
    `Network error persists after ${maxRetries} retries. Entering network recovery mode ` +
    `(${NETWORK_RETRIES} attempts, ${NETWORK_INITIAL_DELAY_MS / 1000}s–${NETWORK_MAX_DELAY_MS / 1000}s delays): ${errorMsg}`,
  );

  try {
    return await withRetry(
      async () => {
        const response = await provider.complete(request);
        if (isRetryableResponse(response)) {
          throw new RetryableResponseError(response);
        }
        return response;
      },
      {
        maxRetries: NETWORK_RETRIES,
        initialDelayMs: NETWORK_INITIAL_DELAY_MS,
        backoffMultiplier: NETWORK_BACKOFF,
        maxDelayMs: NETWORK_MAX_DELAY_MS,
        isRetryable: (err) => err instanceof RetryableResponseError,
        onRetry: (attempt, delay, err) => {
          options?.logger?.warn(
            `Network recovery (attempt ${attempt}/${NETWORK_RETRIES}), retrying in ${(delay / 1000).toFixed(1)}s: ${err.message}`,
          );
          options?.onRetry?.(attempt, delay, err);
        },
      },
    );
  } catch (err) {
    if (err instanceof RetryableResponseError) {
      return err.response;
    }
    throw err;
  }
}
