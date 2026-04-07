// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file Python Parser Types
 *
 * Types for extracted Python code symbols.
 * Compatible with the @intentweave/ast-extractor type shapes so AX stage
 * can consume TypeScript, Swift, and Python extraction results uniformly.
 */

export type PythonSymbolKind =
  | "function"
  | "class"
  | "method"
  | "property"
  | "variable"
  | "module";

export interface SourceRange {
  startLine: number; // 1-based
  startColumn: number; // 0-based
  endLine: number;
  endColumn: number;
}

export interface PythonSymbol {
  name: string;
  kind: PythonSymbolKind;
  filePath: string;
  range: SourceRange;

  /** Parent class name for methods/properties */
  parent?: string;

  /**
   * In Python there's no `export` keyword. We treat module-level symbols
   * (not prefixed with `_`) as "exported" and `_`-prefixed as "internal".
   * Symbols listed in `__all__` are always exported.
   */
  isExported: boolean;

  /** async def? */
  isAsync?: boolean;

  /** @staticmethod or @classmethod? */
  isStatic?: boolean;

  /** Name starts with `_` (convention-private) or `__` (name-mangled) */
  visibility?: "public" | "private" | "protected";

  /** First line of docstring (triple-quoted string after def/class) */
  docSummary?: string;

  /** Parameter names for functions/methods */
  parameters?: string[];

  /** Raw signature: `def foo(x: int, y: str) -> bool` */
  signature?: string;

  /** Decorator names (e.g., ["staticmethod", "property"]) */
  decorators?: string[];

  /** Base classes for class declarations */
  bases?: string[];
}

export interface PythonImport {
  /** Module path, e.g. "os.path" or ".utils" */
  moduleName: string;

  /** Is relative import? (starts with `.`) */
  isRelative: boolean;

  /** Individual names imported (`from X import a, b`) — empty for `import X` */
  importedNames: Array<{
    name: string;
    alias?: string;
  }>;

  /** The whole module is imported (import X / import X as Y) */
  isWholeModule: boolean;

  /** Alias for module-level import (`import X as Y`) */
  alias?: string;

  range: SourceRange;
}

export interface PythonFileResult {
  filePath: string;
  language: "python";
  symbols: PythonSymbol[];
  imports: PythonImport[];
  extractedAt: number;
  errors?: string[];
}

export interface PythonExtractionOptions {
  includePrivate?: boolean;
  includeDocSummary?: boolean;
  includeParameters?: boolean;
  includeMembers?: boolean;
  maxDepth?: number;
}

export interface PythonBatchResult {
  files: Map<string, PythonFileResult>;
  totalSymbols: number;
  totalFiles: number;
  failures: Array<{ filePath: string; error: string }>;
  durationMs: number;
}
