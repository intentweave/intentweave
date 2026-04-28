// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file AST Extractor - Public API
 *
 * Lightweight tree-sitter based AST extractor for TypeScript/JavaScript.
 * Designed for fast structural extraction to enable spec↔code traceability.
 *
 * @example
 * ```typescript
 * import { createExtractor } from '@intentweave/ast-extractor';
 *
 * const extractor = createExtractor('/path/to/workspace');
 * const result = await extractor.extractFile('src/index.ts');
 *
 * console.log(`Found ${result.symbols.length} symbols`);
 * ```
 */

// Re-export types
export type {
  SymbolKind,
  ExportKind,
  SourceRange,
  ExtractedSymbol,
  ExtractedImport,
  ExtractedExport,
  ExtractedCall,
  ExtractedPropertyAccess,
  ExtractedTypeAssertion,
  ExtractedTestDescription,
  FileExtractionResult,
  ExtractionOptions,
  BatchExtractionResult,
} from "./types.js";

// Re-export extractor
export { AstExtractor, createExtractor } from "./extractor.js";

// Convenience utilities
import { AstExtractor } from "./extractor.js";
import type {
  ExtractedSymbol,
  FileExtractionResult,
  BatchExtractionResult,
} from "./types.js";

/**
 * Extract all exported functions from a file
 */
export function getExportedFunctions(
  result: FileExtractionResult,
): ExtractedSymbol[] {
  return result.symbols.filter(
    (s) => s.kind === "function" && s.isExported && !s.parent,
  );
}

/**
 * Extract all classes from a file
 */
export function getClasses(result: FileExtractionResult): ExtractedSymbol[] {
  return result.symbols.filter((s) => s.kind === "class");
}

/**
 * Extract all interfaces from a file
 */
export function getInterfaces(result: FileExtractionResult): ExtractedSymbol[] {
  return result.symbols.filter((s) => s.kind === "interface");
}

/**
 * Extract all types (type aliases + interfaces) from a file
 */
export function getTypes(result: FileExtractionResult): ExtractedSymbol[] {
  return result.symbols.filter(
    (s) => s.kind === "type" || s.kind === "interface",
  );
}

/**
 * Get all public API symbols (exported, top-level)
 */
export function getPublicApi(result: FileExtractionResult): ExtractedSymbol[] {
  return result.symbols.filter((s) => s.isExported && !s.parent);
}

/**
 * Get methods of a specific class
 */
export function getClassMethods(
  result: FileExtractionResult,
  className: string,
): ExtractedSymbol[] {
  return result.symbols.filter(
    (s) =>
      s.parent === className &&
      (s.kind === "method" || s.kind === "constructor"),
  );
}

/**
 * Build a symbol lookup map by name
 */
export function buildSymbolMap(
  results: BatchExtractionResult | FileExtractionResult,
): Map<string, ExtractedSymbol[]> {
  const map = new Map<string, ExtractedSymbol[]>();

  const addSymbols = (symbols: ExtractedSymbol[]) => {
    for (const symbol of symbols) {
      const key = symbol.parent
        ? `${symbol.parent}.${symbol.name}`
        : symbol.name;

      const existing = map.get(key) || [];
      existing.push(symbol);
      map.set(key, existing);
    }
  };

  if ("files" in results) {
    // BatchExtractionResult
    for (const fileResult of results.files.values()) {
      addSymbols(fileResult.symbols);
    }
  } else {
    // FileExtractionResult
    addSymbols(results.symbols);
  }

  return map;
}

/**
 * Find symbols by name pattern (simple glob: * = any)
 */
export function findSymbols(
  results: BatchExtractionResult | FileExtractionResult,
  pattern: string,
): ExtractedSymbol[] {
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "i",
  );

  const matches: ExtractedSymbol[] = [];

  const searchSymbols = (symbols: ExtractedSymbol[]) => {
    for (const symbol of symbols) {
      const fullName = symbol.parent
        ? `${symbol.parent}.${symbol.name}`
        : symbol.name;

      if (regex.test(symbol.name) || regex.test(fullName)) {
        matches.push(symbol);
      }
    }
  };

  if ("files" in results) {
    for (const fileResult of results.files.values()) {
      searchSymbols(fileResult.symbols);
    }
  } else {
    searchSymbols(results.symbols);
  }

  return matches;
}

/**
 * Get import graph for files (which file imports what)
 */
export function getImportGraph(
  results: BatchExtractionResult,
): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const [filePath, fileResult] of results.files) {
    const dependencies: string[] = [];

    for (const imp of fileResult.imports) {
      if (imp.isRelative) {
        // Resolve relative import to file path
        // Note: This is a simplified resolution
        dependencies.push(imp.moduleSpecifier);
      }
    }

    graph.set(filePath, dependencies);
  }

  return graph;
}
