// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Language Registry — generic dispatch for AX stage extractors.
 *
 * Each language provides a `LanguageAdapter` that knows how to extract
 * symbols from its file type and convert them to the unified `AxFileResult`.
 * The `LanguageRegistry` routes files to the correct adapter by extension.
 *
 * Adding a new language requires:
 * 1. A parser package (e.g., `@intentweave/go-parser`)
 * 2. One adapter factory function
 * 3. One `registry.register(adapter)` call
 */

import * as path from "path";
import type { AxFileResult } from "./ax.js";

// ============================================================================
// Adapter Interface
// ============================================================================

/**
 * Common options passed to all language adapters on creation.
 */
export interface LanguageAdapterOptions {
  /** Workspace root directory */
  workspaceRoot: string;

  /** Include private/internal symbols (default: true) */
  includePrivate: boolean;

  /** Include class/interface members (default: true) */
  includeMembers: boolean;

  /** Max depth for nested symbols (default: 2) */
  maxDepth: number;
}

/**
 * A language adapter handles extraction + conversion for one language family.
 *
 * Each adapter encapsulates:
 * - The tree-sitter extractor for its language
 * - Symbol mapping (language-specific kind → AxSymbol kind)
 * - Import conversion (language-specific imports → AxImport[])
 * - Language detection from file extension
 *
 * The adapter lazily creates its extractor on first use.
 */
export interface LanguageAdapter {
  /** File extensions this adapter handles (with leading dot, e.g., ".ts") */
  readonly extensions: readonly string[];

  /**
   * Process a single source file and produce a unified AxFileResult.
   *
   * The adapter reads the file, extracts symbols via its language-specific
   * parser, converts them to AX types, computes body hashes, extracts
   * TODOs, and returns a complete AxFileResult.
   */
  processFile(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<AxFileResult>;
}

/**
 * Factory function type for creating a language adapter.
 */
export type LanguageAdapterFactory = (
  options: LanguageAdapterOptions,
) => LanguageAdapter;

// ============================================================================
// Language Registry
// ============================================================================

/**
 * Routes source files to the correct language adapter by file extension.
 *
 * Usage:
 * ```typescript
 * const registry = new LanguageRegistry();
 * registry.register(createTypeScriptAdapter(opts));
 * registry.register(createSwiftAdapter(opts));
 * registry.register(createPythonAdapter(opts));
 *
 * const adapter = registry.adapterFor("src/auth.py");
 * const result = await adapter.processFile(root, "src/auth.py");
 * ```
 */
export class LanguageRegistry {
  private adapters: LanguageAdapter[] = [];
  private extensionMap = new Map<string, LanguageAdapter>();

  /**
   * Register a language adapter. Extensions are indexed for O(1) lookup.
   * Later registrations for the same extension override earlier ones.
   */
  register(adapter: LanguageAdapter): this {
    this.adapters.push(adapter);
    for (const ext of adapter.extensions) {
      this.extensionMap.set(ext, adapter);
    }
    return this;
  }

  /**
   * Find the adapter that handles the given file path (by extension).
   * Returns null if no adapter is registered for that extension.
   */
  adapterFor(filePath: string): LanguageAdapter | null {
    const ext = path.extname(filePath);
    return this.extensionMap.get(ext) ?? null;
  }

  /**
   * Generate glob patterns for all registered file extensions.
   * Used as defaults for `discoverFiles` include patterns.
   */
  includePatterns(): string[] {
    return this.adapters.flatMap((a) =>
      a.extensions.map((ext) => `**/*${ext}`),
    );
  }

  /**
   * Check whether any adapter handles the given file extension.
   */
  supports(filePath: string): boolean {
    return this.extensionMap.has(path.extname(filePath));
  }

  /**
   * Number of registered adapters.
   */
  get size(): number {
    return this.adapters.length;
  }
}
