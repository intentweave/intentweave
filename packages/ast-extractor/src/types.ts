// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file AST Extractor Types
 *
 * Lightweight types for extracted code symbols.
 * Focused on structural information for spec↔code traceability.
 */

/**
 * Kind of extracted symbol
 */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "method"
  | "property"
  | "constructor"
  | "getter"
  | "setter"
  | "namespace"
  | "module";

/**
 * Export visibility
 */
export type ExportKind =
  | "named" // export { foo }
  | "default" // export default foo
  | "declaration" // export function foo()
  | "re-export"; // export { foo } from 'bar'

/**
 * Source location range
 */
export interface SourceRange {
  startLine: number; // 1-based
  startColumn: number; // 0-based
  endLine: number;
  endColumn: number;
}

/**
 * Extracted symbol from source code
 */
export interface ExtractedSymbol {
  /** Symbol name */
  name: string;

  /** Kind of symbol */
  kind: SymbolKind;

  /** File path (relative to workspace) */
  filePath: string;

  /** Source location */
  range: SourceRange;

  /** Parent symbol name (for nested symbols like methods) */
  parent?: string;

  /** Is this symbol exported? */
  isExported: boolean;

  /** Export kind if exported */
  exportKind?: ExportKind;

  /** For functions/methods: is async? */
  isAsync?: boolean;

  /** For class members: visibility */
  visibility?: "public" | "private" | "protected";

  /** For class members: is static? */
  isStatic?: boolean;

  /** JSDoc/comment summary (first line only) */
  docSummary?: string;

  /** Function/method parameters (name only) */
  parameters?: string[];

  /** Raw signature for display */
  signature?: string;
}

/**
 * Import statement information
 */
export interface ExtractedImport {
  /** Module specifier (e.g., './utils', 'lodash') */
  moduleSpecifier: string;

  /** Is relative import? */
  isRelative: boolean;

  /** Imported names */
  imports: Array<{
    name: string;
    alias?: string;
    isDefault?: boolean;
    isNamespace?: boolean;
  }>;

  /** Source range */
  range: SourceRange;
}

/**
 * Export statement information (for re-exports)
 */
export interface ExtractedExport {
  /** Exported name */
  name: string;

  /** Local name if aliased */
  localName?: string;

  /** Export kind */
  kind: ExportKind;

  /** Source module for re-exports */
  sourceModule?: string;

  /** Source range */
  range: SourceRange;
}

/**
 * Result of extracting a single file
 */
export interface FileExtractionResult {
  /** File path (relative to workspace) */
  filePath: string;

  /** Detected language */
  language: "typescript" | "javascript" | "tsx" | "jsx";

  /** Extracted symbols */
  symbols: ExtractedSymbol[];

  /** Import statements */
  imports: ExtractedImport[];

  /** Export statements (standalone, not declaration exports) */
  exports: ExtractedExport[];

  /** Extraction timestamp */
  extractedAt: number;

  /** Parse errors (if any) */
  errors?: string[];
}

/**
 * Options for extraction
 */
export interface ExtractionOptions {
  /** Include private/internal symbols (default: false) */
  includePrivate?: boolean;

  /** Include JSDoc summary (default: true) */
  includeDocSummary?: boolean;

  /** Include parameter names (default: true) */
  includeParameters?: boolean;

  /** Include method/property details in classes (default: true) */
  includeMembers?: boolean;

  /** Max depth for nested symbols (default: 2) */
  maxDepth?: number;
}

/**
 * Batch extraction result
 */
export interface BatchExtractionResult {
  /** Results by file path */
  files: Map<string, FileExtractionResult>;

  /** Total symbols extracted */
  totalSymbols: number;

  /** Total files processed */
  totalFiles: number;

  /** Failed files */
  failures: Array<{ filePath: string; error: string }>;

  /** Extraction duration (ms) */
  durationMs: number;
}
