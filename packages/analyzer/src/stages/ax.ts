// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * AX Stage - AST Extraction
 * 
 * Extracts code symbols from TypeScript/JavaScript files using tree-sitter.
 * Produces deterministic, per-file symbol tables for spec↔code linking.
 * 
 * Design principles:
 * - Per-file processing (stable provenance, incremental updates)
 * - Deterministic output (heuristic source, no LLM)
 * - Stable IDs (impl:<path>#<kind>:<name>)
 * - Debug-friendly (jump-to-source support)
 * 
 * Input: Workspace with TypeScript/JavaScript files
 * Output: ax.json (workspace summary + per-file symbols)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { 
  createExtractor, 
  type FileExtractionResult, 
  type ExtractedSymbol,
  type ExtractionOptions
} from '@intentweave/ast-extractor';

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
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'method' | 'property';
  
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
  export: 'exported' | 'internal';
  
  /** Parameter names (for functions/methods) */
  parameters?: string[];
  
  /** JSDoc summary (first line) */
  docSummary?: string;
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
  language: 'typescript' | 'javascript' | 'tsx' | 'jsx';
  
  /** Symbols in this file */
  symbols: AxSymbol[];
  
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
  version: '1.0';
  
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
  signature?: string
): string {
  const base = container ? `${container}.${name}` : name;
  const sigHash = signature 
    ? crypto.createHash('sha256').update(signature).digest('hex').slice(0, 8)
    : '';
  
  // Normalize path for cross-platform stability
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  return sigHash
    ? `impl:${normalizedPath}#${kind}:${base}(${sigHash})`
    : `impl:${normalizedPath}#${kind}:${base}`;
}

/**
 * Generate file content hash for change detection
 */
function hashFileContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ============================================================================
// Symbol Mapping
// ============================================================================

/**
 * Map ast-extractor SymbolKind to AX SymbolKind
 */
function mapSymbolKind(kind: ExtractedSymbol['kind']): AxSymbol['kind'] | null {
  switch (kind) {
    case 'function':
      return 'function';
    case 'class':
      return 'class';
    case 'interface':
      return 'interface';
    case 'type':
      return 'type';
    case 'enum':
      return 'enum';
    case 'method':
    case 'constructor':
    case 'getter':
    case 'setter':
      return 'method';
    case 'property':
      return 'property';
    // Skip these for now
    case 'variable':
    case 'namespace':
    case 'module':
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
  filePath: string
): AxSymbol | null {
  const kind = mapSymbolKind(symbol.kind);
  if (!kind) return null;
  
  return {
    id: generateSymbolId(
      filePath,
      kind,
      symbol.name,
      symbol.parent,
      symbol.signature
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
    export: symbol.isExported ? 'exported' : 'internal',
    parameters: symbol.parameters,
    docSummary: symbol.docSummary,
  };
}

// ============================================================================
// File Discovery
// ============================================================================

/**
 * Find TypeScript/JavaScript files in workspace
 */
async function discoverFiles(
  workspaceRoot: string,
  include: string[] = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  exclude: string[] = ['**/node_modules/**', '**/dist/**', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts']
): Promise<string[]> {
  const { glob } = await import('glob');
  
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
  relativePath: string
): Promise<AxFileResult> {
  const absolutePath = path.join(workspaceRoot, relativePath);
  
  // Read file content for hash
  const content = await fs.promises.readFile(absolutePath, 'utf-8');
  const contentHash = hashFileContent(content);
  
  // Extract symbols
  const result = await extractor.extractFile(absolutePath);
  
  // Convert symbols
  const symbols: AxSymbol[] = [];
  for (const symbol of result.symbols) {
    const axSymbol = convertSymbol(symbol, relativePath);
    if (axSymbol) {
      symbols.push(axSymbol);
    }
  }
  
  return {
    filePath: relativePath,
    contentHash,
    language: result.language,
    symbols,
    extractedAt: Date.now(),
    errors: result.errors,
  };
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
  
  // Create extractor
  const extractor = createExtractor(workspaceRoot, {
    includePrivate,
    includeMembers,
    maxDepth,
    includeDocSummary: true,
    includeParameters: true,
  });
  
  // Discover files
  const files = await discoverFiles(workspaceRoot, include, exclude);
  
  // Process files
  const fileResults: AxFileResult[] = [];
  let totalSymbols = 0;
  const byKind: Record<string, number> = {};
  let exported = 0;
  let internal = 0;
  
  for (const file of files) {
    const result = await processFile(extractor, workspaceRoot, file);
    fileResults.push(result);
    
    for (const symbol of result.symbols) {
      totalSymbols++;
      byKind[symbol.kind] = (byKind[symbol.kind] || 0) + 1;
      if (symbol.export === 'exported') {
        exported++;
      } else {
        internal++;
      }
    }
  }
  
  return {
    version: '1.0',
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
export async function loadAxOutput(outputPath: string): Promise<AxOutput | null> {
  try {
    const content = await fs.promises.readFile(outputPath, 'utf-8');
    return JSON.parse(content) as AxOutput;
  } catch {
    return null;
  }
}

/**
 * Save AX output
 */
export async function saveAxOutput(output: AxOutput, outputPath: string): Promise<void> {
  await fs.promises.writeFile(outputPath, JSON.stringify(output, null, 2));
}

/**
 * Run incremental AX stage (only process changed files)
 */
export async function runAxStageIncremental(
  options: AxStageOptions,
  previousOutput: AxOutput | null
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
  
  // Create extractor
  const extractor = createExtractor(workspaceRoot, {
    includePrivate,
    includeMembers,
    maxDepth,
    includeDocSummary: true,
    includeParameters: true,
  });
  
  // Discover current files
  const currentFiles = await discoverFiles(workspaceRoot, include, exclude);
  const currentFilesSet = new Set(currentFiles);
  
  // Determine what to process
  const fileResults: AxFileResult[] = [];
  let totalSymbols = 0;
  const byKind: Record<string, number> = {};
  let exported = 0;
  let internal = 0;
  
  for (const file of currentFiles) {
    const absolutePath = path.join(workspaceRoot, file);
    const content = await fs.promises.readFile(absolutePath, 'utf-8');
    const contentHash = hashFileContent(content);
    
    // Check if file changed
    const previousHash = previousHashes.get(file);
    
    let result: AxFileResult;
    
    if (previousHash === contentHash) {
      // File unchanged - reuse previous result
      const previousFile = previousOutput.files.find(f => f.filePath === file);
      if (previousFile) {
        result = previousFile;
      } else {
        result = await processFile(extractor, workspaceRoot, file);
      }
    } else {
      // File changed - re-extract
      result = await processFile(extractor, workspaceRoot, file);
    }
    
    fileResults.push(result);
    
    for (const symbol of result.symbols) {
      totalSymbols++;
      byKind[symbol.kind] = (byKind[symbol.kind] || 0) + 1;
      if (symbol.export === 'exported') {
        exported++;
      } else {
        internal++;
      }
    }
  }
  
  return {
    version: '1.0',
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
