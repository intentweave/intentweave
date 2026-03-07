// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Token Usage & Cost Tracking
 *
 * Shared types and cost-estimation logic for LLM pipeline stages.
 * Consumed by FX, KX, the open-track orchestrator, and the CLI summary.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Detailed token usage breakdown from a single LLM call or an aggregated stage.
 */
export interface TokenUsage {
  /** Prompt / input tokens */
  promptTokens: number;
  /** Completion / output tokens */
  completionTokens: number;
  /** Total tokens (prompt + completion) */
  totalTokens: number;
  /** Estimated cost in USD (computed from model pricing table) */
  costUsd: number;
  /** Model used (needed for pricing lookup) */
  model?: string;
}

/**
 * Per-model pricing in USD per 1 M tokens.
 */
export interface ModelPricing {
  /** Price per 1 M prompt (input) tokens */
  promptPer1M: number;
  /** Price per 1 M completion (output) tokens */
  completionPer1M: number;
}

// =============================================================================
// Pricing Table  (last updated 2026-03)
// =============================================================================

/**
 * Known model pricing. Keys are model-name prefixes — lookup tries longest
 * prefix match first, then falls back to `'default'`.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // GPT-4o family
  'gpt-4o': { promptPer1M: 2.50, completionPer1M: 10.00 },
  'gpt-4o-mini': { promptPer1M: 0.15, completionPer1M: 0.60 },

  // GPT-5 family
  'gpt-5-mini': { promptPer1M: 0.15, completionPer1M: 0.60 },

  // o-series reasoning
  'o3-mini': { promptPer1M: 1.10, completionPer1M: 4.40 },
  'o3': { promptPer1M: 2.00, completionPer1M: 8.00 },
  'o4-mini': { promptPer1M: 1.10, completionPer1M: 4.40 },

  // Claude (if users proxy through OpenAI-compat)
  'claude-3.5-sonnet': { promptPer1M: 3.00, completionPer1M: 15.00 },
  'claude-sonnet-4': { promptPer1M: 3.00, completionPer1M: 15.00 },

  // Fallback / mock
  'smart-mock': { promptPer1M: 0, completionPer1M: 0 },
  'mock': { promptPer1M: 0, completionPer1M: 0 },
  default: { promptPer1M: 0, completionPer1M: 0 },
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Look up pricing for a model name. Tries an exact match first, then
 * falls back to prefix matching (longest prefix wins).
 */
export function getPricing(model: string): ModelPricing {
  // Exact match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Prefix match — sort by descending key length so longest wins
  const keys = Object.keys(MODEL_PRICING)
    .filter(k => k !== 'default')
    .sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return MODEL_PRICING[key];
  }

  return MODEL_PRICING['default'];
}

/**
 * Compute cost in USD from token counts and a model pricing entry.
 */
export function computeCost(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (promptTokens / 1_000_000) * pricing.promptPer1M +
    (completionTokens / 1_000_000) * pricing.completionPer1M
  );
}

/**
 * Build a `TokenUsage` from raw prompt/completion counts and a model name.
 */
export function buildTokenUsage(
  promptTokens: number,
  completionTokens: number,
  model: string,
): TokenUsage {
  const pricing = getPricing(model);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: computeCost(promptTokens, completionTokens, pricing),
    model,
  };
}

/**
 * Create a zero-value TokenUsage (for cache hits, mocks, etc.)
 */
export function zeroTokenUsage(model?: string): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    model,
  };
}

/**
 * Sum multiple TokenUsage objects into one aggregate.
 */
export function sumTokenUsage(...usages: TokenUsage[]): TokenUsage {
  const result: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  for (const u of usages) {
    result.promptTokens += u.promptTokens;
    result.completionTokens += u.completionTokens;
    result.totalTokens += u.totalTokens;
    result.costUsd += u.costUsd;
    if (u.model) result.model = u.model; // keep the last seen model
  }
  return result;
}

/**
 * Format a cost value for human display.
 *
 *   0        → "free"
 *   < 0.01   → "< $0.01"
 *   >= 0.01  → "$1.23"
 */
export function formatCost(usd: number): string {
  if (usd === 0) return 'free';
  if (usd < 0.01) return '< $0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * Format token counts for human display.
 *
 *   1234     → "1,234"
 *   1234567  → "1,234,567"
 */
export function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}

// =============================================================================
// Pre-run Token & Cost Estimation
// =============================================================================

/**
 * Heuristic constants for estimating LLM token usage before a run.
 *
 * These are deliberately conservative (overestimates) so that the user gets
 * an upper-bound cost preview in `--dry-run` mode.
 */
export const ESTIMATION_CONSTANTS = {
  /** Characters per token (GPT-family average for English/code) */
  CHARS_PER_TOKEN: 4,
  /** Default max chunk size from IN stage (chars) */
  MAX_CHUNK_SIZE: 16_000,
  /** FX system prompt size in tokens (measured from actual prompt) */
  FX_SYSTEM_TOKENS: 500,
  /** Average FX completion tokens per chunk (varies; conservative estimate) */
  FX_COMPLETION_TOKENS_PER_CHUNK: 800,
  /** KX system prompt size in tokens (measured from actual prompt) */
  KX_SYSTEM_TOKENS: 700,
  /** KX batch size — triples per LLM call (matches kx.ts default) */
  KX_BATCH_SIZE: 40,
  /** Estimated raw triples extracted per chunk by FX */
  TRIPLES_PER_CHUNK: 15,
  /** Average tokens per triple in a KX input batch */
  TOKENS_PER_TRIPLE: 30,
  /** Average KX completion tokens per batch */
  KX_COMPLETION_TOKENS_PER_BATCH: 1200,
};

/**
 * Result of a pre-run token/cost estimation.
 */
export interface TokenCostEstimate {
  /** Total files considered */
  totalFiles: number;
  /** Files that would be skipped (incremental cache hits) */
  cachedFiles: number;
  /** Files that need LLM processing */
  uncachedFiles: number;
  /** Estimated total chunks across all uncached files */
  estimatedChunks: number;
  /** Estimated FX LLM calls */
  estimatedFxCalls: number;
  /** Estimated KX LLM calls */
  estimatedKxCalls: number;
  /** Estimated prompt (input) tokens */
  estimatedPromptTokens: number;
  /** Estimated completion (output) tokens */
  estimatedCompletionTokens: number;
  /** Estimated total tokens */
  estimatedTotalTokens: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Model used for pricing */
  model: string;
}

/**
 * Estimate token usage and cost for a set of files BEFORE running the pipeline.
 *
 * @param fileSizes      Array of file sizes in bytes (one per file to process)
 * @param model          Model name for pricing lookup
 * @param cachedCount    Number of files that will be skipped by incremental cache
 */
export function estimateTokenCost(
  fileSizes: number[],
  model: string,
  cachedCount = 0,
): TokenCostEstimate {
  const C = ESTIMATION_CONSTANTS;
  const pricing = getPricing(model);
  const totalFiles = fileSizes.length;
  const uncachedFiles = totalFiles - cachedCount;

  // Only uncached files consume tokens
  const uncachedSizes = fileSizes
    .sort((a, b) => b - a)            // sort descending so we skip the "cached" largest? No — 
    .slice(cachedCount);              // Actually cache hits are not by size. Let's just take last N
  // Better: caller should pass only uncached file sizes. For simplicity, assume
  // cache hits are evenly distributed — we just use the first `uncachedFiles` entries.
  // Re-sort to original order is not needed; we only need aggregate sizes.
  const totalUncachedChars = fileSizes.slice(0, uncachedFiles).reduce((s, sz) => s + sz, 0);

  // Chunks = sum of ceil(fileSize / maxChunkSize) across uncached files
  let estimatedChunks = 0;
  for (let i = 0; i < uncachedFiles && i < fileSizes.length; i++) {
    estimatedChunks += Math.max(1, Math.ceil(fileSizes[i] / C.MAX_CHUNK_SIZE));
  }

  // FX: one LLM call per chunk
  const fxCalls = estimatedChunks;
  const fxPromptTokens = fxCalls * (C.FX_SYSTEM_TOKENS + Math.ceil(C.MAX_CHUNK_SIZE / C.CHARS_PER_TOKEN));
  // Adjust: use actual average chunk size rather than max for prompt tokens
  const avgChunkChars = uncachedFiles > 0 ? totalUncachedChars / estimatedChunks : 0;
  const fxPromptTokensAdjusted = fxCalls * (C.FX_SYSTEM_TOKENS + Math.ceil(avgChunkChars / C.CHARS_PER_TOKEN));
  const fxCompletionTokens = fxCalls * C.FX_COMPLETION_TOKENS_PER_CHUNK;

  // KX: batch triples from FX output
  const totalTriples = estimatedChunks * C.TRIPLES_PER_CHUNK;
  const kxCalls = Math.max(0, Math.ceil(totalTriples / C.KX_BATCH_SIZE));
  const kxPromptTokens = kxCalls * (C.KX_SYSTEM_TOKENS + C.KX_BATCH_SIZE * C.TOKENS_PER_TRIPLE);
  const kxCompletionTokens = kxCalls * C.KX_COMPLETION_TOKENS_PER_BATCH;

  const estimatedPromptTokens = fxPromptTokensAdjusted + kxPromptTokens;
  const estimatedCompletionTokens = fxCompletionTokens + kxCompletionTokens;
  const estimatedTotalTokens = estimatedPromptTokens + estimatedCompletionTokens;
  const estimatedCostUsd = computeCost(estimatedPromptTokens, estimatedCompletionTokens, pricing);

  return {
    totalFiles,
    cachedFiles: cachedCount,
    uncachedFiles,
    estimatedChunks,
    estimatedFxCalls: fxCalls,
    estimatedKxCalls: kxCalls,
    estimatedPromptTokens,
    estimatedCompletionTokens,
    estimatedTotalTokens,
    estimatedCostUsd,
    model,
  };
}

/**
 * Format a TokenCostEstimate for human display.
 */
export function formatEstimate(est: TokenCostEstimate): string {
  const lines: string[] = [];
  lines.push(`Files: ${est.totalFiles} total, ${est.uncachedFiles} to process, ${est.cachedFiles} cached`);
  lines.push(`Estimated chunks: ${est.estimatedChunks}`);
  lines.push(`Estimated LLM calls: ${est.estimatedFxCalls} FX + ${est.estimatedKxCalls} KX = ${est.estimatedFxCalls + est.estimatedKxCalls} total`);
  lines.push(`Estimated tokens: ~${formatTokens(est.estimatedPromptTokens)} prompt + ~${formatTokens(est.estimatedCompletionTokens)} completion = ~${formatTokens(est.estimatedTotalTokens)} total`);
  lines.push(`Estimated cost: ${formatCost(est.estimatedCostUsd)} (${est.model})`);
  return lines.join('\n');
}
