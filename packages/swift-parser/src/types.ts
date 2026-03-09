// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file Swift Parser Types
 *
 * Types for extracted Swift code symbols.
 * Compatible with the @intentweave/ast-extractor type shapes so AX stage
 * can consume both TypeScript and Swift extraction results uniformly.
 */

/**
 * Kind of extracted Swift symbol.
 * Superset of the base SymbolKind — adds Swift-specific constructs.
 */
export type SwiftSymbolKind =
  | "function"
  | "class"
  | "struct"
  | "protocol"
  | "enum"
  | "extension"
  | "method"
  | "property"
  | "initializer"
  | "subscript"
  | "typealias"
  | "associatedtype"
  | "variable"
  | "operator"
  | "macro";

/**
 * Swift access control levels.
 */
export type AccessControl =
  | "open"
  | "public"
  | "package"
  | "internal"
  | "fileprivate"
  | "private";

/**
 * Source location range.
 */
export interface SourceRange {
  startLine: number; // 1-based
  startColumn: number; // 0-based
  endLine: number;
  endColumn: number;
}

/**
 * Extracted Swift symbol.
 */
export interface SwiftSymbol {
  /** Symbol name */
  name: string;

  /** Kind of symbol */
  kind: SwiftSymbolKind;

  /** File path (relative to workspace) */
  filePath: string;

  /** Source location */
  range: SourceRange;

  /** Parent symbol name (for nested symbols like methods in a class) */
  parent?: string;

  /** Is this symbol exported (public/open)? */
  isExported: boolean;

  /** Swift access control level */
  accessControl?: AccessControl;

  /** For functions/methods: is async? */
  isAsync?: boolean;

  /** For functions/methods: is throwing? */
  isThrowing?: boolean;

  /** For class members: is static / class? */
  isStatic?: boolean;

  /** For classes: is final? */
  isFinal?: boolean;

  /** For protocol members: is optional? */
  isOptional?: boolean;

  /** Doc comment summary (first line of triple-slash or block doc comments). */
  docSummary?: string;

  /** Function/method parameter labels (external names) */
  parameters?: string[];

  /** Raw signature for display */
  signature?: string;

  /** Protocol conformances (for class/struct/enum) */
  conformances?: string[];

  /** Superclass (for class declarations) */
  superclass?: string;

  /** Adopted protocols within an extension */
  extendedType?: string;

  /** Generic type parameters */
  genericParameters?: string[];
}

/**
 * Swift import statement.
 */
export interface SwiftImport {
  /** Module name (e.g., "Foundation", "SwiftUI") */
  moduleName: string;

  /** Specific symbol import (e.g., import struct Foundation.URL). */
  kind?: "struct" | "class" | "protocol" | "enum" | "func" | "var" | "typealias";

  /** Specific imported name within the module */
  symbolName?: string;

  /** Source range */
  range: SourceRange;
}

/**
 * Result of extracting a single Swift file.
 * Shape-compatible with @intentweave/ast-extractor FileExtractionResult.
 */
export interface SwiftFileResult {
  /** File path (relative to workspace) */
  filePath: string;

  /** Always "swift" */
  language: "swift";

  /** Extracted symbols */
  symbols: SwiftSymbol[];

  /** Import statements */
  imports: SwiftImport[];

  /** Extraction timestamp */
  extractedAt: number;

  /** Parse errors (if any) */
  errors?: string[];
}

/**
 * Options for Swift extraction.
 */
export interface SwiftExtractionOptions {
  /** Include private/fileprivate symbols (default: false) */
  includePrivate?: boolean;

  /** Include doc comment summary (default: true) */
  includeDocSummary?: boolean;

  /** Include parameter labels (default: true) */
  includeParameters?: boolean;

  /** Include method/property details in types (default: true) */
  includeMembers?: boolean;

  /** Max depth for nested symbols (default: 2) */
  maxDepth?: number;
}

/**
 * Batch extraction result for Swift files.
 */
export interface SwiftBatchResult {
  /** Results by file path */
  files: Map<string, SwiftFileResult>;

  /** Total symbols extracted */
  totalSymbols: number;

  /** Total files processed */
  totalFiles: number;

  /** Failed files */
  failures: Array<{ filePath: string; error: string }>;

  /** Extraction duration (ms) */
  durationMs: number;
}
