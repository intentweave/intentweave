// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Extraction Providers
 * 
 * RX-stage services that use LLMProvider for entity extraction.
 * 
 * Two approaches:
 * 1. Use DefaultExtractionProvider (original, has internal modes)
 * 2. Use ExtractionStrategy classes with RX hooks (new, modular)
 */

// Types
export * from './types.js';

// Providers
export { DefaultExtractionProvider, createDefaultExtractionProvider } from './default.js';

// Strategies (modular approach)
export * from './strategies/index.js';
