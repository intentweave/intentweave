// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * IntentWeave Error Hierarchy
 *
 * Structured error classes that replace raw `new Error(string)` throughout
 * the pipeline. Each class carries a `code` property for programmatic
 * handling and an optional `cause` for chaining.
 *
 * Usage:
 *   throw new LLMError('Rate limit exceeded', { code: 'rate_limit', retryable: true, cause: err });
 *   if (err instanceof LLMError && err.retryable) { ... retry ... }
 */

// =============================================================================
// Base Class
// =============================================================================

export interface IWErrorOptions {
  /** Machine-readable error code */
  code?: string;
  /** Original error that caused this one */
  cause?: unknown;
  /** Additional context for debugging */
  context?: Record<string, unknown>;
}

/**
 * Base error for all IntentWeave errors.
 */
export class IWError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(message: string, options: IWErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'IWError';
    this.code = options.code ?? 'unknown';
    this.context = options.context ?? {};
  }
}

// =============================================================================
// LLM Errors
// =============================================================================

export interface LLMErrorOptions extends IWErrorOptions {
  /** Whether this error is transient and the call can be retried */
  retryable?: boolean;
  /** HTTP status code (if applicable) */
  statusCode?: number;
  /** Model that was being called */
  model?: string;
}

/**
 * Error from an LLM provider (OpenAI, etc.)
 */
export class LLMError extends IWError {
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly model?: string;

  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, options);
    this.name = 'LLMError';
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    this.model = options.model;
  }
}

/**
 * Classify an HTTP status code into an LLMError.
 */
export function classifyHttpError(
  status: number,
  body: string,
  model?: string,
): LLMError {
  if (status === 429) {
    return new LLMError(`Rate limit exceeded (429): ${body}`, {
      code: 'rate_limit',
      retryable: true,
      statusCode: status,
      model,
    });
  }
  if (status === 401 || status === 403) {
    return new LLMError(`Authentication failed (${status}): ${body}`, {
      code: 'auth_error',
      retryable: false,
      statusCode: status,
      model,
    });
  }
  if (status === 400) {
    return new LLMError(`Bad request (400): ${body}`, {
      code: 'bad_request',
      retryable: false,
      statusCode: status,
      model,
    });
  }
  if (status >= 500) {
    return new LLMError(`Server error (${status}): ${body}`, {
      code: 'server_error',
      retryable: true,
      statusCode: status,
      model,
    });
  }
  return new LLMError(`HTTP error (${status}): ${body}`, {
    code: 'http_error',
    retryable: false,
    statusCode: status,
    model,
  });
}

// =============================================================================
// Pipeline Errors
// =============================================================================

/**
 * Error during a pipeline stage (FX, KX, GX, etc.)
 */
export class PipelineError extends IWError {
  readonly stage: string;
  readonly artifactId?: string;

  constructor(message: string, stage: string, options: IWErrorOptions & { artifactId?: string } = {}) {
    super(message, { ...options, code: options.code ?? `pipeline_${stage.toLowerCase()}` });
    this.name = 'PipelineError';
    this.stage = stage;
    this.artifactId = options.artifactId;
  }
}

/**
 * Too many chunks/batches failed — stage result is unreliable.
 */
export class AbortThresholdError extends PipelineError {
  readonly failedCount: number;
  readonly totalCount: number;

  constructor(stage: string, failedCount: number, totalCount: number, options: IWErrorOptions & { artifactId?: string } = {}) {
    const pct = ((failedCount / totalCount) * 100).toFixed(0);
    super(
      `${stage}: ${failedCount}/${totalCount} (${pct}%) failed — exceeds abort threshold`,
      stage,
      { ...options, code: 'abort_threshold' },
    );
    this.name = 'AbortThresholdError';
    this.failedCount = failedCount;
    this.totalCount = totalCount;
  }
}

// =============================================================================
// Neo4j / Connection Errors
// =============================================================================

/**
 * Error connecting to or querying Neo4j.
 */
export class Neo4jError extends IWError {
  constructor(message: string, options: IWErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'neo4j_error' });
    this.name = 'Neo4jError';
  }
}

/**
 * Neo4j connection is unavailable (server down, timeout, etc.)
 */
export class Neo4jConnectionError extends Neo4jError {
  constructor(message: string, options: IWErrorOptions = {}) {
    super(message, { ...options, code: 'neo4j_connection' });
    this.name = 'Neo4jConnectionError';
  }
}

// =============================================================================
// Configuration Errors
// =============================================================================

/**
 * Invalid or missing configuration (workspace, env vars, etc.)
 */
export class ConfigError extends IWError {
  constructor(message: string, options: IWErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'config_error' });
    this.name = 'ConfigError';
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Wrap an unknown thrown value into a proper Error.
 */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

/**
 * Extract a user-friendly message from an error (strips stack traces, etc.)
 */
export function friendlyMessage(err: unknown): string {
  if (err instanceof IWError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
