// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * AX Stage - AST Extraction
 *
 * Extracts code symbols from source files using tree-sitter via a
 * language-agnostic adapter registry. Built-in adapters support
 * TypeScript/JavaScript, Swift, and Python. Adding a new language
 * requires one adapter factory + one `registry.register()` call.
 *
 * Design principles:
 * - Per-file processing (stable provenance, incremental updates)
 * - Deterministic output (heuristic source, no LLM)
 * - Stable IDs (impl:<path>#<kind>:<name>)
 * - Debug-friendly (jump-to-source support)
 * - Language-agnostic dispatch via LanguageRegistry
 *
 * Input: Workspace with source files
 * Output: ax.json (workspace summary + per-file symbols)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  createExtractor,
  type FileExtractionResult,
  type ExtractedSymbol,
  type ExtractionOptions,
} from "@intentweave/ast-extractor";

import {
  createSwiftExtractor,
  type SwiftSymbol,
  type SwiftFileResult,
} from "@intentweave/swift-parser";

import {
  createPythonExtractor,
  type PythonSymbol,
  type PythonFileResult,
} from "@intentweave/python-parser";

import {
  LanguageRegistry,
  type LanguageAdapter,
  type LanguageAdapterOptions,
  type LanguageAdapterFactory,
} from "./languageRegistry.js";

// ============================================================================
// AX Output Types
// ============================================================================

/**
 * Span location in source file
 */
export interface SourceSpan {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/**
 * Extracted code symbol (AX output contract)
 */
export interface AxSymbol {
  /** Stable ID: impl:<path>#<kind>:<name>(<sigHash>) */
  id: string;

  /** Symbol kind */
  kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "method"
    | "property"
    | "struct"
    | "protocol"
    | "extension"
    | "initializer";

  /** Symbol name */
  name: string;

  /** Container name (e.g., "TaskService" for methods) */
  container?: string;

  /** Compact printable signature */
  signature?: string;

  /** Relative file path */
  filePath: string;

  /** Source location */
  span: SourceSpan;

  /** Export status */
  export: "exported" | "internal";

  /** Parameter names (for functions/methods) */
  parameters?: string[];

  /** JSDoc summary (first line) */
  docSummary?: string;

  /** SHA-256 hash of normalised body (whitespace-collapsed, comments stripped) */
  bodyHash?: string;

  /** Number of lines in the symbol body */
  bodyLines?: number;

  /** SHA-256 hash of structural body (identifiers/literals replaced with placeholders) */
  structureHash?: string;
}

/**
 * Import statement extracted from source
 */
export interface AxImport {
  /** Module specifier (e.g., './utils', 'lodash') */
  moduleSpecifier: string;

  /** Resolved target file path (relative to workspace; undefined for package imports) */
  resolvedPath?: string;

  /** Is this a relative import? */
  isRelative: boolean;

  /** Names imported (e.g., ['foo', 'bar']) */
  importedNames: string[];
}

/**
 * TODO / FIXME / HACK marker extracted from source
 */
export interface AxTodo {
  /** Line number (1-based) */
  line: number;

  /** Marker kind */
  kind: "todo" | "fixme" | "hack" | "xxx";

  /** The comment text after the marker */
  text: string;
}

/**
 * Per-file extraction result
 */
export interface AxFileResult {
  /** Relative file path */
  filePath: string;

  /** File content hash (for change detection) */
  contentHash: string;

  /** Detected language */
  language:
    | "typescript"
    | "javascript"
    | "tsx"
    | "jsx"
    | "swift"
    | "python"
    | (string & {});

  /** Symbols in this file */
  symbols: AxSymbol[];

  /** Import statements in this file */
  imports: AxImport[];

  /** TODO / FIXME / HACK markers found in this file */
  todos: AxTodo[];

  /** Extraction timestamp */
  extractedAt: number;

  /** Parse errors (if any) */
  errors?: string[];
}

/**
 * AX stage output
 */
export interface AxOutput {
  /** Output version for schema evolution */
  version: "1.0";

  /** Workspace root path */
  workspaceRoot: string;

  /** Extraction timestamp */
  extractedAt: number;

  /** Total files processed */
  totalFiles: number;

  /** Total symbols extracted */
  totalSymbols: number;

  /** Per-file results */
  files: AxFileResult[];

  /** Summary stats by kind */
  stats: {
    byKind: Record<string, number>;
    exported: number;
    internal: number;
  };
}

/**
 * AX stage options
 */
export interface AxStageOptions {
  /** Workspace root directory */
  workspaceRoot: string;

  /** File patterns to include (glob) */
  include?: string[];

  /** File patterns to exclude (glob) */
  exclude?: string[];

  /** Include private/internal symbols (default: true for AX) */
  includePrivate?: boolean;

  /** Include class/interface members (default: true) */
  includeMembers?: boolean;

  /** Max depth for nested symbols (default: 2) */
  maxDepth?: number;
}

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generate stable symbol ID
 * Format: impl:<path>#<kind>:<name>(<sigHash>)
 */
function generateSymbolId(
  filePath: string,
  kind: string,
  name: string,
  container?: string,
  signature?: string,
): string {
  const base = container ? `${container}.${name}` : name;
  const sigHash = signature
    ? crypto.createHash("sha256").update(signature).digest("hex").slice(0, 8)
    : "";

  // Normalize path for cross-platform stability
  const normalizedPath = filePath.replace(/\\/g, "/");

  return sigHash
    ? `impl:${normalizedPath}#${kind}:${base}(${sigHash})`
    : `impl:${normalizedPath}#${kind}:${base}`;
}

/**
 * Generate file content hash for change detection
 */
function hashFileContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ============================================================================
// Symbol Mapping
// ============================================================================

/**
 * Map ast-extractor SymbolKind to AX SymbolKind
 */
function mapSymbolKind(kind: ExtractedSymbol["kind"]): AxSymbol["kind"] | null {
  switch (kind) {
    case "function":
      return "function";
    case "class":
      return "class";
    case "interface":
      return "interface";
    case "type":
      return "type";
    case "enum":
      return "enum";
    case "method":
    case "constructor":
    case "getter":
    case "setter":
      return "method";
    case "property":
      return "property";
    // Skip these for now
    case "variable":
    case "namespace":
    case "module":
      return null;
    default:
      return null;
  }
}

/**
 * Convert ast-extractor symbol to AX symbol
 */
function convertSymbol(
  symbol: ExtractedSymbol,
  filePath: string,
): AxSymbol | null {
  const kind = mapSymbolKind(symbol.kind);
  if (!kind) return null;

  return {
    id: generateSymbolId(
      filePath,
      kind,
      symbol.name,
      symbol.parent,
      symbol.signature,
    ),
    kind,
    name: symbol.name,
    container: symbol.parent,
    signature: symbol.signature,
    filePath,
    span: {
      startLine: symbol.range.startLine,
      startCol: symbol.range.startColumn,
      endLine: symbol.range.endLine,
      endCol: symbol.range.endColumn,
    },
    export: symbol.isExported ? "exported" : "internal",
    parameters: symbol.parameters,
    docSummary: symbol.docSummary,
  };
}

// ============================================================================
// Swift Symbol Mapping
// ============================================================================

/**
 * Map Swift SymbolKind to AX SymbolKind
 */
function mapSwiftSymbolKind(
  kind: SwiftSymbol["kind"],
): AxSymbol["kind"] | null {
  switch (kind) {
    case "function":
      return "function";
    case "class":
      return "class";
    case "struct":
      return "struct";
    case "protocol":
      return "protocol";
    case "enum":
      return "enum";
    case "method":
      return "method";
    case "property":
      return "property";
    case "initializer":
      return "initializer";
    case "extension":
      return "extension";
    case "typealias":
    case "associatedtype":
      return "type";
    // Skip these for now
    case "variable":
    case "operator":
    case "macro":
    case "subscript":
      return null;
    default:
      return null;
  }
}

/**
 * Convert Swift symbol to AX symbol
 */
function convertSwiftSymbol(
  symbol: SwiftSymbol,
  filePath: string,
): AxSymbol | null {
  const kind = mapSwiftSymbolKind(symbol.kind);
  if (!kind) return null;

  return {
    id: generateSymbolId(
      filePath,
      kind,
      symbol.name,
      symbol.parent,
      symbol.signature,
    ),
    kind,
    name: symbol.name,
    container: symbol.parent,
    signature: symbol.signature,
    filePath,
    span: {
      startLine: symbol.range.startLine,
      startCol: symbol.range.startColumn,
      endLine: symbol.range.endLine,
      endCol: symbol.range.endColumn,
    },
    export: symbol.isExported ? "exported" : "internal",
    parameters: symbol.parameters,
    docSummary: symbol.docSummary,
  };
}

// ============================================================================
// Python Symbol Mapping
// ============================================================================

/**
 * Map Python SymbolKind to AX SymbolKind
 */
function mapPythonSymbolKind(
  kind: PythonSymbol["kind"],
): AxSymbol["kind"] | null {
  switch (kind) {
    case "function":
      return "function";
    case "class":
      return "class";
    case "method":
      return "method";
    case "property":
      return "property";
    // Skip module-level variables (like Swift)
    case "variable":
    case "module":
      return null;
    default:
      return null;
  }
}

/**
 * Convert Python symbol to AX symbol
 */
function convertPythonSymbol(
  symbol: PythonSymbol,
  filePath: string,
): AxSymbol | null {
  const kind = mapPythonSymbolKind(symbol.kind);
  if (!kind) return null;

  return {
    id: generateSymbolId(
      filePath,
      kind,
      symbol.name,
      symbol.parent,
      symbol.signature,
    ),
    kind,
    name: symbol.name,
    container: symbol.parent,
    signature: symbol.signature,
    filePath,
    span: {
      startLine: symbol.range.startLine,
      startCol: symbol.range.startColumn,
      endLine: symbol.range.endLine,
      endCol: symbol.range.endColumn,
    },
    export: symbol.isExported ? "exported" : "internal",
    parameters: symbol.parameters,
    docSummary: symbol.docSummary,
  };
}

// ============================================================================
// Body Hash / Import / TODO Helpers
// ============================================================================

/** Minimum body lines to qualify for clone detection */
const MIN_BODY_LINES = 4;

/** Regex matching TODO / FIXME / HACK / XXX markers in comments */
const TODO_PATTERN =
  /(?:\/\/|\/\*|^\s*\*)\s*(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/i;

/**
 * Compute a normalised body hash for clone detection.
 * Modifies the symbol in place (sets bodyHash / bodyLines).
 */
function computeBodyHash(sym: AxSymbol, lines: string[]): void {
  const bodyLineCount = sym.span.endLine - sym.span.startLine + 1;
  if (bodyLineCount < MIN_BODY_LINES) return;

  const body = lines
    .slice(sym.span.startLine - 1, sym.span.endLine)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .join("\n");

  if (body.length === 0) return;

  sym.bodyHash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 16);
  sym.bodyLines = bodyLineCount;

  // Also compute structural hash (Type 2 clone detection)
  computeStructureHash(sym, body);
}

/** Regex patterns for normalising identifiers and literals to placeholders */
const STRING_LITERAL = /(['"`])(?:(?!\1|\\).|\\.)*\1/g;
const NUMERIC_LITERAL = /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi;
const IDENTIFIER = /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g;

/** Reserved words that should NOT be replaced (they define structure) */
const RESERVED = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/**
 * Compute a structural hash by replacing identifiers and literals with
 * placeholders. Catches renamed-variable copies (Type 2 clones).
 */
function computeStructureHash(sym: AxSymbol, normalisedBody: string): void {
  const structural = normalisedBody
    .replace(STRING_LITERAL, '"S"')
    .replace(NUMERIC_LITERAL, "0")
    .replace(IDENTIFIER, (match) => (RESERVED.has(match) ? match : "_"));

  sym.structureHash = crypto
    .createHash("sha256")
    .update(structural)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Convert ast-extractor imports to AxImport[].
 */
function extractImports(
  result: FileExtractionResult,
  relativePath: string,
  workspaceRoot: string,
): AxImport[] {
  if (!result.imports || result.imports.length === 0) return [];

  return result.imports.map((imp) => ({
    moduleSpecifier: imp.moduleSpecifier,
    resolvedPath: imp.isRelative
      ? resolveImportPath(relativePath, imp.moduleSpecifier, workspaceRoot)
      : undefined,
    isRelative: imp.isRelative,
    importedNames: imp.imports.map((s) =>
      s.isNamespace ? "*" : s.isDefault ? "default" : s.name,
    ),
  }));
}

/**
 * Resolve a relative import specifier to a workspace-relative file path.
 */
function resolveImportPath(
  importingFile: string,
  specifier: string,
  workspaceRoot: string,
): string | undefined {
  const dir = path.dirname(path.join(workspaceRoot, importingFile));
  const base = path.join(dir, specifier);
  const extensions = [".ts", ".tsx", ".js", ".jsx"];

  // Try direct file with extension
  for (const ext of extensions) {
    if (fs.existsSync(base + ext)) {
      return path.relative(workspaceRoot, base + ext);
    }
  }

  // Try index file in directory
  for (const ext of extensions) {
    const idx = path.join(base, "index" + ext);
    if (fs.existsSync(idx)) {
      return path.relative(workspaceRoot, idx);
    }
  }

  return undefined;
}

/**
 * Extract TODO / FIXME / HACK / XXX markers from source lines.
 */
function extractTodos(lines: string[]): AxTodo[] {
  const todos: AxTodo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TODO_PATTERN.exec(lines[i]);
    if (m) {
      todos.push({
        line: i + 1,
        kind: m[1].toLowerCase() as AxTodo["kind"],
        text: m[2].trim(),
      });
    }
  }
  return todos;
}

// ============================================================================
// File Discovery
// ============================================================================

/**
 * Find source files in workspace (TypeScript, JavaScript, Swift, Python)
 */
async function discoverFiles(
  workspaceRoot: string,
  include: string[] = [
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.swift",
    "**/*.py",
  ],
  exclude: string[] = [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.d.ts",
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/.build/**",
    "**/Pods/**",
    "**/DerivedData/**",
  ],
): Promise<string[]> {
  const { glob } = await import("glob");

  const files: string[] = [];

  for (const pattern of include) {
    const matches = await glob(pattern, {
      cwd: workspaceRoot,
      ignore: exclude,
      nodir: true,
    });
    files.push(...matches);
  }

  // Remove duplicates and sort for deterministic output
  return [...new Set(files)].sort();
}

// ============================================================================
// AX Stage Execution
// ============================================================================

/**
 * Process a single file
 */
async function processFile(
  extractor: ReturnType<typeof createExtractor>,
  workspaceRoot: string,
  relativePath: string,
): Promise<AxFileResult> {
  const absolutePath = path.join(workspaceRoot, relativePath);

  // Read file content for hash
  const content = await fs.promises.readFile(absolutePath, "utf-8");
  const contentHash = hashFileContent(content);
  const lines = content.split("\n");

  // Extract symbols
  const result = await extractor.extractFile(absolutePath);

  // Convert symbols + compute body hashes
  const symbols: AxSymbol[] = [];
  for (const symbol of result.symbols) {
    const axSymbol = convertSymbol(symbol, relativePath);
    if (axSymbol) {
      computeBodyHash(axSymbol, lines);
      symbols.push(axSymbol);
    }
  }

  // Convert imports
  const imports = extractImports(result, relativePath, workspaceRoot);

  // Extract TODOs
  const todos = extractTodos(lines);

  return {
    filePath: relativePath,
    contentHash,
    language: result.language,
    symbols,
    imports,
    todos,
    extractedAt: Date.now(),
    errors: result.errors,
  };
}

/**
 * Check whether a file path looks like a Swift source file
 */
function isSwiftFile(filePath: string): boolean {
  return filePath.endsWith(".swift");
}

/**
 * Check whether a file path looks like a Python source file
 */
function isPythonFile(filePath: string): boolean {
  return filePath.endsWith(".py");
}

/**
 * Process a single Swift file
 */
async function processSwiftFile(
  swiftExtractor: ReturnType<typeof createSwiftExtractor>,
  workspaceRoot: string,
  relativePath: string,
): Promise<AxFileResult> {
  const absolutePath = path.join(workspaceRoot, relativePath);

  // Read file content for hash
  const content = await fs.promises.readFile(absolutePath, "utf-8");
  const contentHash = hashFileContent(content);
  const lines = content.split("\n");

  // Extract symbols
  const result = await swiftExtractor.extractFile(absolutePath);

  // Convert symbols + compute body hashes
  const symbols: AxSymbol[] = [];
  for (const symbol of result.symbols) {
    const axSymbol = convertSwiftSymbol(symbol, relativePath);
    if (axSymbol) {
      computeBodyHash(axSymbol, lines);
      symbols.push(axSymbol);
    }
  }

  // Extract TODOs (no imports for Swift yet)
  const todos = extractTodos(lines);

  return {
    filePath: relativePath,
    contentHash,
    language: "swift",
    symbols,
    imports: [],
    todos,
    extractedAt: Date.now(),
    errors: result.errors,
  };
}

/**
 * Process a single Python file
 */
async function processPythonFile(
  pythonExtractor: ReturnType<typeof createPythonExtractor>,
  workspaceRoot: string,
  relativePath: string,
): Promise<AxFileResult> {
  const absolutePath = path.join(workspaceRoot, relativePath);

  // Read file content for hash
  const content = await fs.promises.readFile(absolutePath, "utf-8");
  const contentHash = hashFileContent(content);
  const lines = content.split("\n");

  // Extract symbols
  const result = await pythonExtractor.extractFile(absolutePath);

  // Convert symbols + compute body hashes
  const symbols: AxSymbol[] = [];
  for (const symbol of result.symbols) {
    const axSymbol = convertPythonSymbol(symbol, relativePath);
    if (axSymbol) {
      computeBodyHash(axSymbol, lines);
      symbols.push(axSymbol);
    }
  }

  // Convert Python imports to AX imports
  const imports: AxImport[] = result.imports.map((imp) => ({
    moduleSpecifier: imp.moduleName,
    isRelative: imp.isRelative,
    importedNames: imp.isWholeModule
      ? [imp.alias || imp.moduleName]
      : imp.importedNames.map((n) => n.alias || n.name),
  }));

  // Extract TODOs
  const todos = extractTodos(lines);

  return {
    filePath: relativePath,
    contentHash,
    language: "python",
    symbols,
    imports,
    todos,
    extractedAt: Date.now(),
    errors: result.errors,
  };
}

// ============================================================================
// Language Adapter Factories
// ============================================================================

/**
 * Create a TypeScript/JavaScript language adapter.
 */
export function createTypeScriptAdapter(
  options: LanguageAdapterOptions,
): LanguageAdapter {
  let extractor: ReturnType<typeof createExtractor> | null = null;

  function getExtractor() {
    if (!extractor) {
      extractor = createExtractor(options.workspaceRoot, {
        includePrivate: options.includePrivate,
        includeMembers: options.includeMembers,
        maxDepth: options.maxDepth,
        includeDocSummary: true,
        includeParameters: true,
      });
    }
    return extractor;
  }

  return {
    extensions: [".ts", ".tsx", ".js", ".jsx"],

    async processFile(workspaceRoot, relativePath) {
      return processFile(getExtractor(), workspaceRoot, relativePath);
    },
  };
}

/**
 * Create a Swift language adapter.
 */
export function createSwiftAdapter(
  options: LanguageAdapterOptions,
): LanguageAdapter {
  let extractor: ReturnType<typeof createSwiftExtractor> | null = null;

  function getExtractor() {
    if (!extractor) {
      extractor = createSwiftExtractor(options.workspaceRoot, {
        includePrivate: options.includePrivate,
        includeMembers: options.includeMembers,
        maxDepth: options.maxDepth,
        includeDocSummary: true,
        includeParameters: true,
      });
    }
    return extractor;
  }

  return {
    extensions: [".swift"],

    async processFile(workspaceRoot, relativePath) {
      return processSwiftFile(getExtractor(), workspaceRoot, relativePath);
    },
  };
}

/**
 * Create a Python language adapter.
 */
export function createPythonAdapter(
  options: LanguageAdapterOptions,
): LanguageAdapter {
  let extractor: ReturnType<typeof createPythonExtractor> | null = null;

  function getExtractor() {
    if (!extractor) {
      extractor = createPythonExtractor(options.workspaceRoot, {
        includePrivate: options.includePrivate,
        includeMembers: options.includeMembers,
        maxDepth: options.maxDepth,
        includeDocSummary: true,
        includeParameters: true,
      });
    }
    return extractor;
  }

  return {
    extensions: [".py"],

    async processFile(workspaceRoot, relativePath) {
      return processPythonFile(getExtractor(), workspaceRoot, relativePath);
    },
  };
}

/**
 * Create a LanguageRegistry with all built-in language adapters.
 *
 * Built-in adapters: TypeScript/JavaScript, Swift, Python.
 * Use `registry.register()` to add custom adapters.
 */
export function createLanguageRegistry(
  options: LanguageAdapterOptions,
): LanguageRegistry {
  const registry = new LanguageRegistry();
  registry.register(createTypeScriptAdapter(options));
  registry.register(createSwiftAdapter(options));
  registry.register(createPythonAdapter(options));
  return registry;
}

/**
 * Run AX stage on workspace
 */
export async function runAxStage(options: AxStageOptions): Promise<AxOutput> {
  const {
    workspaceRoot,
    include,
    exclude,
    includePrivate = true,
    includeMembers = true,
    maxDepth = 2,
  } = options;

  // Create language registry with all built-in adapters
  const registry = createLanguageRegistry({
    workspaceRoot,
    includePrivate,
    includeMembers,
    maxDepth,
  });

  // Discover files (use registry patterns if no explicit include)
  const files = await discoverFiles(
    workspaceRoot,
    include ?? registry.includePatterns(),
    exclude,
  );

  // Process files through the registry
  const fileResults: AxFileResult[] = [];
  let totalSymbols = 0;
  const byKind: Record<string, number> = {};
  let exported = 0;
  let internal = 0;

  for (const file of files) {
    const adapter = registry.adapterFor(file);
    if (!adapter) continue;

    const result = await adapter.processFile(workspaceRoot, file);
    fileResults.push(result);

    for (const symbol of result.symbols) {
      totalSymbols++;
      byKind[symbol.kind] = (byKind[symbol.kind] || 0) + 1;
      if (symbol.export === "exported") {
        exported++;
      } else {
        internal++;
      }
    }
  }

  return {
    version: "1.0",
    workspaceRoot,
    extractedAt: Date.now(),
    totalFiles: files.length,
    totalSymbols,
    files: fileResults,
    stats: {
      byKind,
      exported,
      internal,
    },
  };
}

/**
 * Load existing AX output (for incremental updates)
 */
export async function loadAxOutput(
  outputPath: string,
): Promise<AxOutput | null> {
  try {
    const content = await fs.promises.readFile(outputPath, "utf-8");
    return JSON.parse(content) as AxOutput;
  } catch {
    return null;
  }
}

/**
 * Save AX output
 */
export async function saveAxOutput(
  output: AxOutput,
  outputPath: string,
): Promise<void> {
  await fs.promises.writeFile(outputPath, JSON.stringify(output, null, 2));
}

/**
 * Run incremental AX stage (only process changed files)
 */
export async function runAxStageIncremental(
  options: AxStageOptions,
  previousOutput: AxOutput | null,
): Promise<AxOutput> {
  if (!previousOutput) {
    return runAxStage(options);
  }

  const {
    workspaceRoot,
    include,
    exclude,
    includePrivate = true,
    includeMembers = true,
    maxDepth = 2,
  } = options;

  // Build lookup for previous file hashes
  const previousHashes = new Map<string, string>();
  for (const file of previousOutput.files) {
    previousHashes.set(file.filePath, file.contentHash);
  }

  // Create language registry with all built-in adapters (lazy initialization)
  const registry = createLanguageRegistry({
    workspaceRoot,
    includePrivate,
    includeMembers,
    maxDepth,
  });

  // Discover current files
  const currentFiles = await discoverFiles(
    workspaceRoot,
    include ?? registry.includePatterns(),
    exclude,
  );

  // Determine what to process
  const fileResults: AxFileResult[] = [];
  let totalSymbols = 0;
  const byKind: Record<string, number> = {};
  let exported = 0;
  let internal = 0;

  for (const file of currentFiles) {
    const absolutePath = path.join(workspaceRoot, file);
    const content = await fs.promises.readFile(absolutePath, "utf-8");
    const contentHash = hashFileContent(content);

    // Check if file changed
    const previousHash = previousHashes.get(file);

    let result: AxFileResult | undefined;

    if (previousHash === contentHash) {
      // File unchanged — reuse previous result if available
      const previousFile = previousOutput.files.find(
        (f) => f.filePath === file,
      );
      if (previousFile) {
        result = previousFile;
      }
    }

    // File changed or no previous result — re-extract via registry
    if (!result) {
      const adapter = registry.adapterFor(file);
      if (!adapter) continue;
      result = await adapter.processFile(workspaceRoot, file);
    }

    fileResults.push(result);

    for (const symbol of result.symbols) {
      totalSymbols++;
      byKind[symbol.kind] = (byKind[symbol.kind] || 0) + 1;
      if (symbol.export === "exported") {
        exported++;
      } else {
        internal++;
      }
    }
  }

  return {
    version: "1.0",
    workspaceRoot,
    extractedAt: Date.now(),
    totalFiles: currentFiles.length,
    totalSymbols,
    files: fileResults,
    stats: {
      byKind,
      exported,
      internal,
    },
  };
}

// Re-export language registry types for external consumers
export {
  LanguageRegistry,
  type LanguageAdapter,
  type LanguageAdapterOptions,
  type LanguageAdapterFactory,
} from "./languageRegistry.js";
