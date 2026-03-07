// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry with Exponential Backoff
 *
 * Generic retry utility for transient failures (rate limits, network blips).
 * Used by LLM providers and Neo4j connections.
 */

import { LLMError } from './errors.js';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Optional logger for retry events */
  onRetry?: (attempt: number, delay: number, error: Error) => void;
  /** Custom function to decide if an error is retryable (default: checks LLMError.retryable) */
  isRetryable?: (error: Error) => boolean;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry' | 'isRetryable'>> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30_000,
};

/**
 * Default retryable check: LLMError with retryable=true, or network errors.
 */
function defaultIsRetryable(error: Error): boolean {
  if (error instanceof LLMError) return error.retryable;

  // Common network error patterns
  const msg = error.message.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

/**
 * Execute an async function with exponential backoff retries.
 *
 * Only retries on errors that are considered transient (rate limits,
 * server errors, network failures). Permanent errors (auth, bad request)
 * are thrown immediately.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The function's return value on success
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_OPTIONS.maxRetries;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_OPTIONS.initialDelayMs;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_OPTIONS.backoffMultiplier;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry if it's not a transient error
      if (!isRetryable(lastError)) {
        throw lastError;
      }

      // Don't retry if we've used all attempts
      if (attempt >= maxRetries) {
        break;
      }

      // Compute delay with jitter (±25%)
      const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
      const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1); // ±25%
      const delay = Math.min(baseDelay + jitter, maxDelayMs);

      options.onRetry?.(attempt + 1, delay, lastError);

      await sleep(delay);
    }
  }

  throw lastError!;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
