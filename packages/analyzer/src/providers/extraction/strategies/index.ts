// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Extraction Strategies
 *
 * Modular extraction strategies that encapsulate different LLM calling patterns.
 * Strategies implement the ExtractionStrategy interface from @intentweave/core.
 *
 * Available strategies:
 * - SinglePassStrategy: One LLM call per chunk (entities + statements together)
 * - TwoPassStrategy: Two LLM calls per chunk (entities first, then statements)
 *
 * Usage:
 * ```typescript
 * // Factory (preferred)
 * import { createStrategy } from '@intentweave/analyzer';
 * const strategy = createStrategy(llmProvider, 'two-pass', { temperature: 0.1 });
 *
 * // Direct instantiation
 * import { TwoPassStrategy } from '@intentweave/analyzer';
 * const strategy = new TwoPassStrategy(llmProvider, { temperature: 0.1 });
 * ```
 */

// Strategy classes
export { SinglePassStrategy } from "./singlePass.js";
export { TwoPassStrategy } from "./twoPass.js";

// Configuration
export { type StrategyConfig, createDefaultStrategyConfig } from "./shared.js";

// Factory (preferred entry point)
export {
  createStrategy,
  getStrategyDescription,
  listStrategyNames,
  type StrategyName,
  DEFAULT_STRATEGY_NAME,
} from "./factory.js";
