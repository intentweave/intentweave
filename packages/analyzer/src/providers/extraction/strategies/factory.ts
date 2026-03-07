// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Strategy Factory
 * 
 * Creates ExtractionStrategy instances from configuration.
 * This is the main entry point for strategy selection.
 * 
 * Usage:
 * ```typescript
 * import { createStrategy, StrategyName } from '@intentweave/analyzer';
 * 
 * const strategy = createStrategy(llmProvider, 'two-pass', { temperature: 0.1 });
 * const result = await strategy.extract(chunks, schema, profile, context);
 * ```
 */

import type { LLMProvider, ExtractionStrategy } from '@intentweave/core';
import type { StrategyConfig } from './shared.js';
import { createDefaultStrategyConfig } from './shared.js';
import { SinglePassStrategy } from './singlePass.js';
import { TwoPassStrategy } from './twoPass.js';

// =============================================================================
// Strategy Types
// =============================================================================

/**
 * Available strategy names
 */
export type StrategyName = 
  | 'single-pass'    // One LLM call per chunk (entities + statements together)
  | 'two-pass';      // Two LLM calls per chunk (entities first, then statements)

/**
 * Default strategy to use when none specified
 */
export const DEFAULT_STRATEGY_NAME: StrategyName = 'two-pass';

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an ExtractionStrategy from configuration
 * 
 * @param llmProvider - LLM provider for making extraction calls
 * @param strategyName - Name of strategy to create (default: 'two-pass')
 * @param configOverrides - Optional config overrides (temperature, etc.)
 * @returns Configured ExtractionStrategy instance
 * 
 * @example
 * ```typescript
 * // Use default two-pass strategy
 * const strategy = createStrategy(llmProvider);
 * 
 * // Use single-pass with custom temperature
 * const strategy = createStrategy(llmProvider, 'single-pass', { temperature: 0.2 });
 * ```
 */
export function createStrategy(
  llmProvider: LLMProvider,
  strategyName: StrategyName = DEFAULT_STRATEGY_NAME,
  configOverrides?: Partial<StrategyConfig>
): ExtractionStrategy {
  const config = createDefaultStrategyConfig(configOverrides);
  
  switch (strategyName) {
    case 'single-pass':
      return new SinglePassStrategy(llmProvider, config);
    
    case 'two-pass':
      return new TwoPassStrategy(llmProvider, config);
    
    default:
      // Exhaustive check
      const _exhaustive: never = strategyName;
      throw new Error(`Unknown strategy: ${_exhaustive}`);
  }
}

/**
 * Get human-readable description of a strategy
 */
export function getStrategyDescription(name: StrategyName): string {
  switch (name) {
    case 'single-pass':
      return 'Single-pass extraction: entities and statements in one LLM call';
    case 'two-pass':
      return 'Two-pass extraction: entities first, then statements';
    default:
      return 'Unknown strategy';
  }
}

/**
 * List all available strategy names
 */
export function listStrategyNames(): readonly StrategyName[] {
  return ['single-pass', 'two-pass'] as const;
}
