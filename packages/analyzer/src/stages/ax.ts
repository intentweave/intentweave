// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * AX Stage - AST Extraction
 *
 * Extracts code symbols from source files using tree-sitter via a
 * language-agnostic adapter registry. TypeScript/JavaScript is built‑in;
 * additional languages (Swift, Python, etc.) are contributed by
 * language plugins discovered at runtime via the PluginRegistry.
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
import {
  createExtractor,
  type FileExtractionResult,
  type ExtractedSymbol,
  type ExtractionOptions,
} from "@intentweave/ast-extractor";

import {
  LanguageRegistry,
  type LanguageAdapter,
  type LanguageAdapterOptions,
  type LanguageAdapterFactory,
} from "./languageRegistry.js";

import {
  generateSymbolId,
  hashFileContent,
  computeBodyHash,
  extractTodos,
  extractRationale,
} from "./ax-helpers.js";

import { getPluginRegistry, type LanguageCapability } from "@intentweave/core";

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

  /** Interfaces this class implements (class symbols only) */
  implements?: string[];
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

export interface AxRationale {
  /** Line number (1-based) */
  line: number;

  /** Marker kind */
  kind: "why" | "note" | "important" | "design";

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

  /** WHY / NOTE / IMPORTANT / DESIGN rationale comments found in this file */
  rationale: AxRationale[];

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

  /**
   * Additional language adapters to register (e.g. from language plugins).
   * These are registered alongside the built-in TypeScript/JavaScript adapter.
   */
  extraAdapters?: LanguageAdapter[];
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
    implements: symbol.implements,
  };
}

// ============================================================================
// Import / Resolve Helpers
// ============================================================================

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

// ============================================================================
// File Discovery
// ============================================================================

/**
 * Find source files in workspace.
 *
 * Default patterns cover TypeScript/JavaScript only. Additional file
 * extensions are contributed by language plugins via the LanguageRegistry.
 */
async function discoverFiles(
  workspaceRoot: string,
  include: string[] = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
  exclude: string[] = [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.d.ts",
    "**/*.test.ts",
    "**/*.spec.ts",
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

  // Extract TODOs and rationale
  const todos = extractTodos(lines);
  const rationale = extractRationale(lines);

  return {
    filePath: relativePath,
    contentHash,
    language: result.language,
    symbols,
    imports,
    todos,
    rationale,
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
 * Create a LanguageRegistry with built-in TypeScript/JavaScript adapter
 * plus any language plugins discovered by the PluginRegistry.
 */
export function createLanguageRegistry(
  options: LanguageAdapterOptions,
): LanguageRegistry {
  const registry = new LanguageRegistry();
  registry.register(createTypeScriptAdapter(options));

  // Auto-discover language plugins from the global PluginRegistry
  try {
    const pluginRegistry = getPluginRegistry();
    const caps =
      pluginRegistry.getAllCapabilities<LanguageCapability>("language");
    for (const cap of caps) {
      const adapter = cap.createAdapter({
        workspaceRoot: options.workspaceRoot,
        includePrivate: options.includePrivate,
        includeMembers: options.includeMembers,
        maxDepth: options.maxDepth,
      }) as LanguageAdapter;
      registry.register(adapter);
    }
  } catch {
    // PluginRegistry not initialized — skip plugin adapters
  }

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
    extraAdapters,
  } = options;

  // Create language registry with built-in TS/JS adapter
  const registry = createLanguageRegistry({
    workspaceRoot,
    includePrivate,
    includeMembers,
    maxDepth,
  });

  // Register plugin-provided language adapters
  if (extraAdapters) {
    for (const adapter of extraAdapters) {
      registry.register(adapter);
    }
  }

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
    extraAdapters,
  } = options;

  // Build lookup for previous file hashes
  const previousHashes = new Map<string, string>();
  for (const file of previousOutput.files) {
    previousHashes.set(file.filePath, file.contentHash);
  }

  // Create language registry with built-in TS/JS adapter
  const registry = createLanguageRegistry({
    workspaceRoot,
    includePrivate,
    includeMembers,
    maxDepth,
  });

  // Register plugin-provided language adapters
  if (extraAdapters) {
    for (const adapter of extraAdapters) {
      registry.register(adapter);
    }
  }

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
