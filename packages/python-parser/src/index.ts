// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file Python Parser - Public API
 *
 * Tree-sitter based AST extractor for Python source files.
 * Extracts functions, classes, methods, decorators, imports,
 * module-level variables, and type hints from .py files.
 *
 * @example
 * ```typescript
 * import { createPythonExtractor } from '@intentweave/python-parser';
 *
 * const extractor = createPythonExtractor('/path/to/python-project');
 * const result = await extractor.extractFile('src/app.py');
 *
 * console.log(`Found ${result.symbols.length} symbols`);
 * for (const sym of result.symbols) {
 *   console.log(`  ${sym.kind} ${sym.name} (${sym.visibility ?? 'public'})`);
 * }
 * ```
 */

// Re-export types
export type {
  PythonSymbolKind,
  SourceRange,
  PythonSymbol,
  PythonImport,
  PythonFileResult,
  PythonExtractionOptions,
  PythonBatchResult,
} from "./types.js";

// Re-export extractor
export { PythonExtractor, createPythonExtractor } from "./extractor.js";
