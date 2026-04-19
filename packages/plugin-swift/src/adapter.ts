// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Swift language adapter for the AX stage.
 *
 * Maps Swift AST symbols (from @intentweave/swift-parser) to the
 * AX output format (AxSymbol, AxFileResult) and exposes a
 * LanguageAdapter-compatible object.
 */

import * as fs from "fs";
import * as path from "path";
import {
  createSwiftExtractor,
  type SwiftSymbol,
} from "@intentweave/swift-parser";
import type { AxSymbol, AxFileResult } from "@intentweave/analyzer";
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
// Swift Symbol Mapping
// =============================================================================

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
    case "variable":
    case "operator":
    case "macro":
    case "subscript":
      return null;
    default:
      return null;
  }
}

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

// =============================================================================
// Process File
// =============================================================================

async function processSwiftFile(
  swiftExtractor: ReturnType<typeof createSwiftExtractor>,
  workspaceRoot: string,
  relativePath: string,
): Promise<AxFileResult> {
  const absolutePath = path.join(workspaceRoot, relativePath);

  const content = await fs.promises.readFile(absolutePath, "utf-8");
  const contentHash = hashFileContent(content);
  const lines = content.split("\n");

  const result = await swiftExtractor.extractFile(absolutePath);

  const symbols: AxSymbol[] = [];
  for (const symbol of result.symbols) {
    const axSymbol = convertSwiftSymbol(symbol, relativePath);
    if (axSymbol) {
      computeBodyHash(axSymbol, lines);
      symbols.push(axSymbol);
    }
  }

  const todos = extractTodos(lines);
  const rationale = extractRationale(lines);

  return {
    filePath: relativePath,
    contentHash,
    language: "swift",
    symbols,
    imports: [],
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
 * Create a Swift language adapter for the AX stage.
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
