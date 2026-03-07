/**
 * Providers - Pluggable service implementations
 * 
 * Two-Layer Design:
 * - LLM Providers: Low-level model transport (prompt → completion)
 * - Extraction Providers: RX-stage service (uses LLMProvider)
 */

// LLM Providers (low-level)
export * from './llm/index.js';

// Extraction Providers (RX-stage)
export * from './extraction/index.js';
