// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file Swift Parser - Public API
 *
 * Tree-sitter based AST extractor for Swift source files.
 * Extracts structs, classes, protocols, enums, extensions, functions,
 * properties, and imports from .swift files.
 *
 * @example
 * ```typescript
 * import { createSwiftExtractor } from '@intentweave/swift-parser';
 *
 * const extractor = createSwiftExtractor('/path/to/swift-project');
 * const result = await extractor.extractFile('Sources/App/Model.swift');
 *
 * console.log(`Found ${result.symbols.length} symbols`);
 * for (const sym of result.symbols) {
 *   console.log(`  ${sym.kind} ${sym.name} (${sym.accessControl ?? 'internal'})`);
 * }
 * ```
 */

// Re-export types
export type {
  SwiftSymbolKind,
  AccessControl,
  SourceRange,
  SwiftSymbol,
  SwiftImport,
  SwiftFileResult,
  SwiftExtractionOptions,
  SwiftBatchResult,
} from "./types.js";

// Re-export extractor
export { SwiftExtractor, createSwiftExtractor } from "./extractor.js";
