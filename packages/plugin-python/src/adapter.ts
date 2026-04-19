// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Python language adapter for the AX stage.
 *
 * Maps Python AST symbols (from @intentweave/python-parser) to the
 * AX output format (AxSymbol, AxFileResult) and exposes a
 * LanguageAdapter-compatible object.
 */

import * as fs from "fs";
import * as path from "path";
import {
  createPythonExtractor,
  type PythonSymbol,
} from "@intentweave/python-parser";
import type {
  AxSymbol,
  AxFileResult,
  AxImport,
} from "@intentweave/analyzer";
import {
  generateSymbolId,
  hashFileContent,
  computeBodyHash,
  extractTodos,
  extractRationale,
} from "@intentweave/analyzer";
import type {
  LanguageAdapter,
  LanguageAdapterOptions,
} from "@intentweave/analyzer";

// =============================================================================
// Python Symbol Mapping
// =============================================================================

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
    case "variable":
    case "module":
      return null;
    default:
      return null;
  }
}

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

// =============================================================================
// Process File
// =============================================================================

async function processPythonFile(
  pythonExtractor: ReturnType<typeof createPythonExtractor>,
  workspaceRoot: string,
  relativePath: string,
): Promise<AxFileResult> {
  const absolutePath = path.join(workspaceRoot, relativePath);

  const content = await fs.promises.readFile(absolutePath, "utf-8");
  const contentHash = hashFileContent(content);
  const lines = content.split("\n");

  const result = await pythonExtractor.extractFile(absolutePath);

  const symbols: AxSymbol[] = [];
  for (const symbol of result.symbols) {
    const axSymbol = convertPythonSymbol(symbol, relativePath);
    if (axSymbol) {
      computeBodyHash(axSymbol, lines);
      symbols.push(axSymbol);
    }
  }

  const imports: AxImport[] = result.imports.map((imp) => ({
    moduleSpecifier: imp.moduleName,
    isRelative: imp.isRelative,
    importedNames: imp.isWholeModule
      ? [imp.alias || imp.moduleName]
      : imp.importedNames.map((n) => n.alias || n.name),
  }));

  const todos = extractTodos(lines);
  const rationale = extractRationale(lines);

  return {
    filePath: relativePath,
    contentHash,
    language: "python",
    symbols,
    imports,
    todos,
    rationale,
    extractedAt: Date.now(),
    errors: result.errors,
  };
}

// =============================================================================
// Adapter Factory
// =============================================================================

/**
 * Create a Python language adapter for the AX stage.
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
