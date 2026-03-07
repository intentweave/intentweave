// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  getPricing,
  computeCost,
  buildTokenUsage,
  zeroTokenUsage,
  sumTokenUsage,
  formatCost,
  formatTokens,
  estimateTokenCost,
  formatEstimate,
  ESTIMATION_CONSTANTS,
  MODEL_PRICING,
  type TokenUsage,
} from '@intentweave/core';

// =============================================================================
// getPricing
// =============================================================================
describe('getPricing', () => {
  it('returns exact match for known models', () => {
    const p = getPricing('gpt-4o-mini');
    expect(p.promptPer1M).toBe(0.15);
    expect(p.completionPer1M).toBe(0.60);
  });

  it('falls back to prefix match', () => {
    // "gpt-4o-2024-08-06" should match "gpt-4o" prefix (NOT gpt-4o-mini)
    const p = getPricing('gpt-4o-2024-08-06');
    expect(p.promptPer1M).toBe(MODEL_PRICING['gpt-4o'].promptPer1M);
  });

  it('prefers longest prefix match', () => {
    // "gpt-4o-mini-2024" should match "gpt-4o-mini" (longer) over "gpt-4o"
    const p = getPricing('gpt-4o-mini-2024');
    expect(p.promptPer1M).toBe(MODEL_PRICING['gpt-4o-mini'].promptPer1M);
  });

  it('returns default pricing for unknown models', () => {
    const p = getPricing('unknown-model-xyz');
    expect(p.promptPer1M).toBe(0);
    expect(p.completionPer1M).toBe(0);
  });

  it('returns zero pricing for smart-mock', () => {
    const p = getPricing('smart-mock');
    expect(p.promptPer1M).toBe(0);
    expect(p.completionPer1M).toBe(0);
  });
});

// =============================================================================
// computeCost
// =============================================================================
describe('computeCost', () => {
  it('computes cost for 1M prompt tokens', () => {
    const cost = computeCost(1_000_000, 0, { promptPer1M: 2.50, completionPer1M: 10.0 });
    expect(cost).toBe(2.50);
  });

  it('computes cost for 1M completion tokens', () => {
    const cost = computeCost(0, 1_000_000, { promptPer1M: 2.50, completionPer1M: 10.0 });
    expect(cost).toBe(10.0);
  });

  it('computes combined cost', () => {
    const cost = computeCost(500_000, 200_000, { promptPer1M: 2.50, completionPer1M: 10.0 });
    // 0.5M * 2.50 + 0.2M * 10.0 = 1.25 + 2.0 = 3.25
    expect(cost).toBeCloseTo(3.25, 6);
  });

  it('returns 0 for zero tokens', () => {
    expect(computeCost(0, 0, { promptPer1M: 2.50, completionPer1M: 10.0 })).toBe(0);
  });
});

// =============================================================================
// buildTokenUsage
// =============================================================================
describe('buildTokenUsage', () => {
  it('builds usage with computed cost', () => {
    const u = buildTokenUsage(1000, 500, 'gpt-4o');
    expect(u.promptTokens).toBe(1000);
    expect(u.completionTokens).toBe(500);
    expect(u.totalTokens).toBe(1500);
    expect(u.model).toBe('gpt-4o');
    // 1000/1M * 2.50 + 500/1M * 10.0 = 0.0025 + 0.005 = 0.0075
    expect(u.costUsd).toBeCloseTo(0.0075, 6);
  });

  it('returns 0 cost for smart-mock', () => {
    const u = buildTokenUsage(10000, 5000, 'smart-mock');
    expect(u.costUsd).toBe(0);
  });
});

// =============================================================================
// zeroTokenUsage
// =============================================================================
describe('zeroTokenUsage', () => {
  it('returns all zeros', () => {
    const u = zeroTokenUsage();
    expect(u.promptTokens).toBe(0);
    expect(u.completionTokens).toBe(0);
    expect(u.totalTokens).toBe(0);
    expect(u.costUsd).toBe(0);
    expect(u.model).toBeUndefined();
  });

  it('accepts optional model', () => {
    const u = zeroTokenUsage('gpt-4o');
    expect(u.model).toBe('gpt-4o');
  });
});

// =============================================================================
// sumTokenUsage
// =============================================================================
describe('sumTokenUsage', () => {
  it('sums multiple usages', () => {
    const a: TokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.01, model: 'gpt-4o' };
    const b: TokenUsage = { promptTokens: 200, completionTokens: 100, totalTokens: 300, costUsd: 0.02, model: 'gpt-4o' };
    const sum = sumTokenUsage(a, b);
    expect(sum.promptTokens).toBe(300);
    expect(sum.completionTokens).toBe(150);
    expect(sum.totalTokens).toBe(450);
    expect(sum.costUsd).toBeCloseTo(0.03);
  });

  it('returns zero for empty input', () => {
    const sum = sumTokenUsage();
    expect(sum.totalTokens).toBe(0);
    expect(sum.costUsd).toBe(0);
  });

  it('keeps the last model seen', () => {
    const a: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0, model: 'gpt-4o' };
    const b: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0, model: 'gpt-4o-mini' };
    const sum = sumTokenUsage(a, b);
    expect(sum.model).toBe('gpt-4o-mini');
  });
});

// =============================================================================
// formatCost
// =============================================================================
describe('formatCost', () => {
  it('returns "free" for 0', () => {
    expect(formatCost(0)).toBe('free');
  });

  it('returns "< $0.01" for very small costs', () => {
    expect(formatCost(0.001)).toBe('< $0.01');
    expect(formatCost(0.009)).toBe('< $0.01');
  });

  it('formats normal costs with 2 decimal places', () => {
    expect(formatCost(1.234)).toBe('$1.23');
    expect(formatCost(0.50)).toBe('$0.50');
    expect(formatCost(12.99)).toBe('$12.99');
  });
});

// =============================================================================
// formatTokens
// =============================================================================
describe('formatTokens', () => {
  it('formats small numbers without commas', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with commas', () => {
    expect(formatTokens(1234)).toBe('1,234');
    expect(formatTokens(1234567)).toBe('1,234,567');
  });
});

// =============================================================================
// estimateTokenCost
// =============================================================================
describe('estimateTokenCost', () => {
  it('estimates zero cost for smart-mock', () => {
    const est = estimateTokenCost([5000, 8000, 3000], 'smart-mock');
    expect(est.totalFiles).toBe(3);
    expect(est.cachedFiles).toBe(0);
    expect(est.uncachedFiles).toBe(3);
    expect(est.estimatedChunks).toBeGreaterThanOrEqual(3);
    expect(est.estimatedFxCalls).toBe(est.estimatedChunks);
    expect(est.estimatedCostUsd).toBe(0);
    expect(est.model).toBe('smart-mock');
  });

  it('estimates non-zero cost for gpt-4o', () => {
    // 3 files of 10KB each → 1 chunk each → 3 FX calls
    const est = estimateTokenCost([10_000, 10_000, 10_000], 'gpt-4o');
    expect(est.totalFiles).toBe(3);
    expect(est.uncachedFiles).toBe(3);
    expect(est.estimatedChunks).toBe(3);
    expect(est.estimatedFxCalls).toBe(3);
    expect(est.estimatedKxCalls).toBeGreaterThan(0);
    expect(est.estimatedPromptTokens).toBeGreaterThan(0);
    expect(est.estimatedCompletionTokens).toBeGreaterThan(0);
    expect(est.estimatedTotalTokens).toBe(
      est.estimatedPromptTokens + est.estimatedCompletionTokens,
    );
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('accounts for cached files', () => {
    const fullEst = estimateTokenCost([10_000, 10_000, 10_000], 'gpt-4o', 0);
    const partialEst = estimateTokenCost([10_000, 10_000, 10_000], 'gpt-4o', 2);
    expect(partialEst.cachedFiles).toBe(2);
    expect(partialEst.uncachedFiles).toBe(1);
    expect(partialEst.estimatedCostUsd).toBeLessThan(fullEst.estimatedCostUsd);
    expect(partialEst.estimatedChunks).toBeLessThan(fullEst.estimatedChunks);
  });

  it('handles large files that span multiple chunks', () => {
    // 50KB file → ceil(50000 / 16000) = 4 chunks
    const est = estimateTokenCost([50_000], 'gpt-4o');
    expect(est.estimatedChunks).toBe(4);
    expect(est.estimatedFxCalls).toBe(4);
  });

  it('handles empty file list', () => {
    const est = estimateTokenCost([], 'gpt-4o');
    expect(est.totalFiles).toBe(0);
    expect(est.estimatedChunks).toBe(0);
    expect(est.estimatedCostUsd).toBe(0);
  });

  it('handles all files cached', () => {
    const est = estimateTokenCost([5000, 5000], 'gpt-4o', 2);
    expect(est.uncachedFiles).toBe(0);
    expect(est.estimatedChunks).toBe(0);
    expect(est.estimatedCostUsd).toBe(0);
  });

  it('KX calls scale with estimated triples', () => {
    // 10 chunks → 10 * 15 = 150 triples → ceil(150/40) = 4 KX batches
    const est = estimateTokenCost([160_000], 'gpt-4o');
    expect(est.estimatedChunks).toBe(10);
    expect(est.estimatedKxCalls).toBe(
      Math.ceil((10 * ESTIMATION_CONSTANTS.TRIPLES_PER_CHUNK) / ESTIMATION_CONSTANTS.KX_BATCH_SIZE),
    );
  });
});

// =============================================================================
// formatEstimate
// =============================================================================
describe('formatEstimate', () => {
  it('formats a complete estimate', () => {
    const est = estimateTokenCost([10_000, 20_000], 'gpt-4o', 0);
    const output = formatEstimate(est);
    expect(output).toContain('Files: 2 total');
    expect(output).toContain('2 to process');
    expect(output).toContain('0 cached');
    expect(output).toContain('Estimated chunks');
    expect(output).toContain('Estimated LLM calls');
    expect(output).toContain('Estimated tokens');
    expect(output).toContain('Estimated cost');
    expect(output).toContain('gpt-4o');
  });

  it('shows cached file count', () => {
    const est = estimateTokenCost([10_000, 10_000, 10_000], 'gpt-4o', 2);
    const output = formatEstimate(est);
    expect(output).toContain('2 cached');
    expect(output).toContain('1 to process');
  });
});
