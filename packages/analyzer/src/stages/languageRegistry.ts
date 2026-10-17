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

  /** Optional observation capability (Phase O1). */
  readonly observation?: LanguageObservation;

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

// ============================================================================
// Observation Capability (Phase O1)
// ============================================================================

/**
 * Kinds of observed objects in the generic observation layer. Adapters declare the
 * kinds they produce. Claim families consume kinds and never add them.
 */
export const OBSERVATION_KINDS = [
  "file",
  "module",
  "symbol",
  "dependency",
  "call-site",
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * Per-kind capability an adapter declares. `not_observed` and `unsupported` are
 * never reported as absent by the core.
 */
export type ObservationCapability =
  | { status: "observed" }
  | { status: "not_observed"; reason: string }
  | { status: "unsupported" };

/** Where an observed object sits. */
export interface ObservedLocator {
  filePath: string;
  container?: string;
  line?: number;
  endLine?: number;
}

/**
 * One observation of an object in one file. `identityKey` is the creation key
 * (Amendment A): it is built from kind and defining locator, never from a CARI id.
 */
export interface ObservedRecord {
  kind: ObservationKind;
  identityKey: string;
  locator: ObservedLocator;
  payload: Record<string, unknown>;
}

/**
 * Observation capability of a language adapter. Optional, so adapters that only
 * extract AX symbols keep working unchanged.
 */
export interface LanguageObservation {
  /** Adapter contract version. A change here starts a new observation run. */
  readonly contractVersion: string;
  /** Capability for every kind in OBSERVATION_KINDS. */
  readonly capabilities: Readonly<
    Record<ObservationKind, ObservationCapability>
  >;
  /**
   * Observe one file. Throws when the file cannot be read or parsed, so the
   * runner can mark the kind partial instead of recording absence.
   */
  observeFile(workspaceRoot: string, relativePath: string): ObservedRecord[];
  /**
   * Observe a package manifest (for example package.json). Manifests have no
   * source extension, so they are observed by the adapter that owns the ecosystem.
   */
  observeManifest?(workspaceRoot: string): ObservedRecord[];
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
   * Every registered adapter that declares an observation capability. Manifests
   * have no source extension, so they are found here, not by extension.
   */
  observationAdapters(): LanguageAdapter[] {
    return this.adapters.filter((adapter) => adapter.observation !== undefined);
  }

  /**
   * The adapter that observes the given file, when it declares an observation
   * capability. Null when no registered adapter observes that extension.
   */
  observationAdapterFor(filePath: string): LanguageAdapter | null {
    const adapter = this.adapterFor(filePath);
    return adapter?.observation ? adapter : null;
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
