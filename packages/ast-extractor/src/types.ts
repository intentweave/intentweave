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

  /** Interfaces this class implements (class symbols only) */
  implements?: string[];

  /** True when the JSDoc block contains @deprecated */
  deprecated?: boolean;

  /** The text argument of @deprecated (if any), e.g. "use serialize() instead" */
  deprecatedNote?: string;

  /** True when the JSDoc block contains @internal, or the name starts with _ */
  isInternal?: boolean;

  /** Decorator names applied to this symbol (e.g. ["Controller", "Injectable"]) */
  decorators?: string[];
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
/**
 * A function or method call extracted from a file body.
 */
export interface ExtractedCall {
  /** File containing the caller */
  callerFile: string;
  /** Enclosing function / class name; null for module-level code */
  callerName: string | null;
  /** Line of the call expression (1-based) */
  callerLine: number;
  /** Unqualified name of the called function/method */
  calleeName: string;
  /** Qualified callee if resolvable, e.g. "obj.method" */
  calleeId: string | null;
  /** true when this is a method call (receiver.method()) */
  isMethod: boolean;
}

/**
 * A property access chain extracted from a file body (depth ≥ 3).
 */
export interface ExtractedPropertyAccess {
  /** File containing the access */
  file: string;
  /** Enclosing function / class name; null for module-level code */
  symbolName: string | null;
  /** Line of the member expression (1-based) */
  line: number;
  /** Full dotted chain, e.g. "entity.source.path" */
  chain: string;
  /** First identifier in the chain, e.g. "entity" */
  root: string;
  /** Number of dot-separated segments */
  depth: number;
}

/**
 * A type assertion (`as any`, `as unknown as X`, `<Type>expr`) extracted from a file.
 */
export interface ExtractedTypeAssertion {
  /** File containing the assertion */
  file: string;
  /** Line of the assertion (1-based) */
  line: number;
  /** Kind of assertion */
  kind: "as_any" | "double_cast" | "angle_cast" | "as_cast";
  /** Enclosing function/class name; null for module-level code */
  context: string | null;
  /** The type being cast to (e.g. "MyType"), if extractable */
  targetType: string | null;
}

/**
 * Test description extracted from describe(), it(), test() calls.
 * Used for stale test detection (14.6).
 */
export interface ExtractedTestDescription {
  /** File containing the test call */
  file: string;
  /** Line of the describe/it/test call (1-based) */
  line: number;
  /** Function name: "describe", "it", or "test" */
  kind: "describe" | "it" | "test";
  /** String argument to the function (the test description/title) */
  description: string;
}

/**
 * A variable assignment extracted from a file body (13.10).
 * Captures the RHS text of variable declarations for pattern-based rule checking.
 */
export interface ExtractedVariableAssignment {
  /** File containing the assignment */
  file: string;
  /** Line of the variable declaration (1-based) */
  line: number;
  /** Variable name (LHS) */
  symbolName: string;
  /** First 120 characters of the RHS expression text (normalised whitespace) */
  valueText: string;
  /** Enclosing function / class name; null for module-level code */
  context: string | null;
}

/**
 * One intra-function def-use edge for a local variable (16.1).
 */
export interface ExtractedDefUseChain {
  /** File containing the definition and use */
  file: string;
  /** Enclosing function / class name; null for anonymous contexts */
  functionName: string | null;
  /** Line where the variable is defined */
  defLine: number;
  /** Local variable name */
  varName: string;
  /** Line where the variable is read */
  useLine: number;
  /** Read context (call_arg, property_access, return, assignment_rhs, read) */
  useContext: string;
}

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

  /** Function/method calls found in file bodies */
  calls?: ExtractedCall[];

  /** Property access chains of depth ≥ 3 found in file bodies */
  propertyAccesses?: ExtractedPropertyAccess[];

  /** Type assertion patterns (`as any`, double cast, angle cast) */
  typeAssertions?: ExtractedTypeAssertion[];

  /** Test descriptions from describe/it/test calls (14.6) */
  testDescriptions?: ExtractedTestDescription[];

  /** Variable assignments with RHS text (13.10) */
  variableAssignments?: ExtractedVariableAssignment[];

  /** Intra-function def-use chains for local variables (16.1) */
  defUseChains?: ExtractedDefUseChain[];

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
