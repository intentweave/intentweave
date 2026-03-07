// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  IWError,
  LLMError,
  PipelineError,
  AbortThresholdError,
  Neo4jError,
  Neo4jConnectionError,
  ConfigError,
  classifyHttpError,
  toError,
  friendlyMessage,
} from '@intentweave/core';
import { withRetry } from '@intentweave/core';

// =============================================================================
// Error Hierarchy
// =============================================================================
describe('IWError', () => {
  it('has code and context', () => {
    const err = new IWError('test', { code: 'my_code', context: { key: 'val' } });
    expect(err.message).toBe('test');
    expect(err.code).toBe('my_code');
    expect(err.context).toEqual({ key: 'val' });
    expect(err.name).toBe('IWError');
  });

  it('defaults code to unknown', () => {
    const err = new IWError('test');
    expect(err.code).toBe('unknown');
  });

  it('chains cause', () => {
    const cause = new Error('root');
    const err = new IWError('wrapper', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('LLMError', () => {
  it('carries retryable and statusCode', () => {
    const err = new LLMError('rate limit', { retryable: true, statusCode: 429, model: 'gpt-4o' });
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
    expect(err.model).toBe('gpt-4o');
    expect(err.name).toBe('LLMError');
    expect(err).toBeInstanceOf(IWError);
    expect(err).toBeInstanceOf(LLMError);
  });

  it('defaults retryable to false', () => {
    const err = new LLMError('bad request');
    expect(err.retryable).toBe(false);
  });
});

describe('classifyHttpError', () => {
  it('classifies 429 as retryable rate_limit', () => {
    const err = classifyHttpError(429, 'Too many requests', 'gpt-4o');
    expect(err.code).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
  });

  it('classifies 401 as non-retryable auth_error', () => {
    const err = classifyHttpError(401, 'Unauthorized');
    expect(err.code).toBe('auth_error');
    expect(err.retryable).toBe(false);
  });

  it('classifies 500 as retryable server_error', () => {
    const err = classifyHttpError(500, 'Internal Server Error');
    expect(err.code).toBe('server_error');
    expect(err.retryable).toBe(true);
  });

  it('classifies 400 as non-retryable bad_request', () => {
    const err = classifyHttpError(400, 'Bad request');
    expect(err.code).toBe('bad_request');
    expect(err.retryable).toBe(false);
  });
});

describe('PipelineError', () => {
  it('has stage and artifactId', () => {
    const err = new PipelineError('failed', 'FX', { artifactId: 'doc.md' });
    expect(err.stage).toBe('FX');
    expect(err.artifactId).toBe('doc.md');
    expect(err.code).toBe('pipeline_fx');
  });
});

describe('AbortThresholdError', () => {
  it('reports failed/total counts', () => {
    const err = new AbortThresholdError('FX', 8, 10);
    expect(err.failedCount).toBe(8);
    expect(err.totalCount).toBe(10);
    expect(err.message).toContain('80%');
    expect(err.code).toBe('abort_threshold');
    expect(err).toBeInstanceOf(PipelineError);
  });
});

describe('Neo4jError', () => {
  it('has correct hierarchy', () => {
    const conn = new Neo4jConnectionError('connection refused');
    expect(conn).toBeInstanceOf(Neo4jError);
    expect(conn).toBeInstanceOf(IWError);
    expect(conn.code).toBe('neo4j_connection');
  });
});

describe('ConfigError', () => {
  it('carries config code', () => {
    const err = new ConfigError('missing key');
    expect(err.code).toBe('config_error');
    expect(err).toBeInstanceOf(IWError);
  });
});

// =============================================================================
// Helpers
// =============================================================================
describe('toError', () => {
  it('returns Error as-is', () => {
    const e = new Error('foo');
    expect(toError(e)).toBe(e);
  });

  it('wraps string into Error', () => {
    const e = toError('oops');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('oops');
  });
});

describe('friendlyMessage', () => {
  it('extracts message from IWError', () => {
    expect(friendlyMessage(new LLMError('rate limit'))).toBe('rate limit');
  });

  it('extracts message from plain Error', () => {
    expect(friendlyMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-errors', () => {
    expect(friendlyMessage(42)).toBe('42');
  });
});

// =============================================================================
// withRetry
// =============================================================================
describe('withRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable LLMError', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new LLMError('rate limit', { retryable: true }))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, {
      maxRetries: 2,
      initialDelayMs: 10, // fast for tests
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn()
      .mockRejectedValue(new LLMError('auth failed', { retryable: false }));

    await expect(withRetry(fn, { maxRetries: 3, initialDelayMs: 10 }))
      .rejects.toThrow('auth failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const fn = vi.fn()
      .mockRejectedValue(new LLMError('server error', { retryable: true }));

    await expect(withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }))
      .rejects.toThrow('server error');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('calls onRetry callback', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new LLMError('timeout', { retryable: true }))
      .mockResolvedValue('ok');

    await withRetry(fn, {
      maxRetries: 2,
      initialDelayMs: 10,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), expect.any(Error));
  });

  it('retries network errors by default', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxRetries: 1, initialDelayMs: 10 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('supports custom isRetryable', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('custom retryable'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxRetries: 1,
      initialDelayMs: 10,
      isRetryable: (err) => err.message.includes('custom retryable'),
    });
    expect(result).toBe('ok');
  });
});
