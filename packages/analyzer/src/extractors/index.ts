// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Entity Extractors - Pluggable extraction strategies
 * 
 * Extractors implement different strategies for identifying entities
 * from various document types (markdown, code, config files, etc.)
 * 
 * Note: ExtractorResult is distinct from ExtractionResult in @intentweave/core.
 * The core ExtractionResult is for the RX stage provider output.
 */

import type { Entity, Statement } from '@intentweave/core';

/**
 * Base extractor interface
 */
export interface Extractor {
  /** Extractor name for logging */
  readonly name: string;
  
  /** File extensions this extractor handles */
  readonly extensions: string[];
  
  /** Check if extractor supports a file */
  supports(filePath: string): boolean;
  
  /** Extract entities and statements from content */
  extract(
    content: string,
    filePath: string,
    options?: ExtractorOptions
  ): Promise<ExtractorResult>;
}

/**
 * Extractor options
 */
export interface ExtractorOptions {
  /** Namespace for generated cgIds */
  namespace?: string;
  
  /** Include evidence in results */
  includeEvidence?: boolean;
  
  /** Existing entities for cross-referencing */
  existingEntities?: Entity[];
}

/**
 * Extractor result (distinct from core ExtractionResult)
 * 
 * @deprecated Prefer using ExtractionProvider from @intentweave/core for RX stage
 */
export interface ExtractorResult {
  entities: Entity[];
  statements: Statement[];
  warnings: string[];
}

/**
 * Legacy type alias for backward compatibility
 * @deprecated Use ExtractorResult or core ExtractionResult
 */
export type ExtractionResult = ExtractorResult;

/**
 * Extractor registry - manages available extractors
 */
export class ExtractorRegistry {
  private extractors: Map<string, Extractor> = new Map();
  
  /**
   * Register an extractor
   */
  register(extractor: Extractor): void {
    this.extractors.set(extractor.name, extractor);
  }
  
  /**
   * Unregister an extractor
   */
  unregister(name: string): boolean {
    return this.extractors.delete(name);
  }
  
  /**
   * Get all registered extractors
   */
  getAll(): Extractor[] {
    return Array.from(this.extractors.values());
  }
  
  /**
   * Find extractors that support a file
   */
  findForFile(filePath: string): Extractor[] {
    return this.getAll().filter(ext => ext.supports(filePath));
  }
  
  /**
   * Get extractor by name
   */
  get(name: string): Extractor | undefined {
    return this.extractors.get(name);
  }
}

/**
 * Global extractor registry
 */
export const extractorRegistry = new ExtractorRegistry();

/**
 * Helper to create a simple extractor
 */
export function createExtractor(
  name: string,
  extensions: string[],
  extractFn: (content: string, filePath: string, options?: ExtractorOptions) => Promise<ExtractionResult>
): Extractor {
  return {
    name,
    extensions,
    supports(filePath: string): boolean {
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      return extensions.includes(ext) || extensions.includes('.' + ext);
    },
    extract: extractFn,
  };
}

/**
 * Combine results from multiple extractors
 */
export function mergeExtractionResults(
  results: ExtractionResult[]
): ExtractionResult {
  return {
    entities: results.flatMap(r => r.entities),
    statements: results.flatMap(r => r.statements),
    warnings: results.flatMap(r => r.warnings),
  };
}

/**
 * Deduplicate entities by cgId
 */
export function deduplicateEntities(entities: Entity[]): Entity[] {
  const seen = new Map<string, Entity>();
  
  for (const entity of entities) {
    const existing = seen.get(entity.cgId);
    if (!existing || (entity.confidence ?? 0) > (existing.confidence ?? 0)) {
      seen.set(entity.cgId, entity);
    }
  }
  
  return Array.from(seen.values());
}

/**
 * Deduplicate statements by subject+predicate+object
 */
export function deduplicateStatements(statements: Statement[]): Statement[] {
  const seen = new Map<string, Statement>();
  
  for (const stmt of statements) {
    const key = `${stmt.subjectCgId}|${stmt.predicate}|${stmt.objectCgId}`;
    const existing = seen.get(key);
    if (!existing || (stmt.confidence ?? 0) > (existing.confidence ?? 0)) {
      seen.set(key, stmt);
    }
  }
  
  return Array.from(seen.values());
}
