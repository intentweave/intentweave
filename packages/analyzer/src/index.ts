/**
 * @intentweave/analyzer
 * 
 * Analysis engine for IntentWeave knowledge extraction.
 * 
 * Two-Layer Provider Design:
 * - LLM Providers: Low-level model transport (OpenAI, Mock, Ollama)
 * - Extraction Providers: RX-stage service (uses LLMProvider)
 * 
 * Pipeline Stages:
 * - Per-artifact: IN → RX → CX → MX → PX
 * - Per-run (AGG): LX, Coverage, Validation
 */

// Providers (two-layer design)
export * from './providers/index.js';

// Pipeline stages (per-artifact)
export * from './stages/index.js';

// Aggregate stages (per-run)
export * from './agg/index.js';

// MX (Materialization) utilities
export * from './mx/index.js';

// Transition extraction
export * from './transitions/index.js';

// Entity extractors (legacy)
export * from './extractors/index.js';

// Storage abstractions
export * from './stores/index.js';

// Pipeline orchestration
export * from './pipeline/index.js';

// Incremental cache
export * from './cache/index.js';

// Analysis orchestration
export * from './analyzer.js';
