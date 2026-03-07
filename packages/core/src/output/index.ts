// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical JSON Output Utilities
 * 
 * Provides consistent JSON serialization with $schema headers,
 * ensuring identical output formatting between CLI and server.
 * 
 * This module is critical for contract-identical .iw bundle exports.
 */

import { STAGE_SCHEMAS, CURRENT_SCHEMA_VERSION } from '../types/stages.js';

// =============================================================================
// Schema Constants
// =============================================================================

/**
 * Schema URIs for all output types
 */
export const SCHEMA_URIS = {
  ...STAGE_SCHEMAS,
  runMeta: 'intentweave://schemas/run-meta/v1',
} as const;

export type SchemaType = keyof typeof SCHEMA_URIS;

// =============================================================================
// Canonical Header Types
// =============================================================================

/**
 * Standard header fields for all canonical outputs
 */
export interface CanonicalHeader {
  /** JSON Schema URI for validation */
  $schema: string;
  /** Semantic version of the schema */
  schemaVersion: string;
  /** Processing timestamp (ISO 8601) */
  processedAt: string;
}

// =============================================================================
// Canonical JSON Writer
// =============================================================================

/**
 * Options for canonical JSON output
 */
export interface CanonicalJsonOptions {
  /** Indentation (default: 2 spaces) */
  indent?: number;
  /** Include trailing newline (default: true) */
  trailingNewline?: boolean;
}

/**
 * Create canonical header fields for a stage output
 * 
 * @param schemaType - Type of schema (in, rx, cx, mx, px, lx, coverage, findings, runMeta)
 * @param timestamp - Optional timestamp (default: now)
 * @returns Canonical header fields
 * 
 * @example
 * ```typescript
 * const header = createCanonicalHeader('px');
 * // { $schema: 'intentweave://schemas/px-graph/v1', schemaVersion: '0.1', processedAt: '...' }
 * ```
 */
export function createCanonicalHeader(
  schemaType: SchemaType,
  timestamp?: string
): CanonicalHeader {
  return {
    $schema: SCHEMA_URIS[schemaType],
    schemaVersion: CURRENT_SCHEMA_VERSION,
    processedAt: timestamp ?? new Date().toISOString(),
  };
}

/**
 * Serialize an object to canonical JSON with proper header fields
 * 
 * Ensures:
 * - $schema is always first
 * - schemaVersion is always second  
 * - processedAt is always third
 * - Consistent field ordering
 * - Consistent indentation
 * 
 * @param schemaType - Type of schema for the $schema URI
 * @param data - Data object to serialize
 * @param options - Serialization options
 * @returns Canonical JSON string
 * 
 * @example
 * ```typescript
 * const json = toCanonicalJson('px', {
 *   stage: 'PX',
 *   artifactId: 'prompt',
 *   entities: [...],
 *   statements: [...]
 * });
 * ```
 */
export function toCanonicalJson<T extends object>(
  schemaType: SchemaType,
  data: T,
  options: CanonicalJsonOptions = {}
): string {
  const { indent = 2, trailingNewline = true } = options;
  
  const header = createCanonicalHeader(schemaType);
  
  // Ensure header fields come first by constructing ordered object
  const ordered = {
    $schema: header.$schema,
    schemaVersion: header.schemaVersion,
    processedAt: header.processedAt,
    ...data,
  };
  
  const json = JSON.stringify(ordered, null, indent);
  return trailingNewline ? json + '\n' : json;
}

/**
 * Serialize an object to canonical JSON with an existing header
 * (for when processedAt should be preserved)
 * 
 * @param data - Data object with header fields already present
 * @param options - Serialization options
 * @returns Canonical JSON string
 */
export function toCanonicalJsonWithHeader<T extends CanonicalHeader>(
  data: T,
  options: CanonicalJsonOptions = {}
): string {
  const { indent = 2, trailingNewline = true } = options;
  
  // Extract header fields to ensure they come first
  const { $schema, schemaVersion, processedAt, ...rest } = data;
  
  const ordered = {
    $schema,
    schemaVersion,
    processedAt,
    ...rest,
  };
  
  const json = JSON.stringify(ordered, null, indent);
  return trailingNewline ? json + '\n' : json;
}

/**
 * Add canonical header to an existing object
 * 
 * @param schemaType - Type of schema
 * @param data - Data object
 * @param timestamp - Optional timestamp
 * @returns Object with canonical header fields
 */
export function withCanonicalHeader<T extends object>(
  schemaType: SchemaType,
  data: T,
  timestamp?: string
): T & CanonicalHeader {
  const header = createCanonicalHeader(schemaType, timestamp);
  return {
    ...header,
    ...data,
  };
}

// =============================================================================
// Field Ordering Utilities
// =============================================================================

/**
 * Standard field order for run.meta.json
 */
export const RUN_META_FIELD_ORDER = [
  '$schema',
  'schemaVersion', 
  'processedAt',
  'runId',
  'workspaceId',
  'workspaceKey',
  'startedAt',
  'completedAt',
  'durationMs',
  'status',
  'profile',
  'stages',
  'artifacts',
  'summary',
  'extractionConfig',
  'error',
] as const;

/**
 * Standard field order for stage outputs
 */
export const STAGE_OUTPUT_FIELD_ORDER = [
  '$schema',
  'schemaVersion',
  'processedAt',
  'stage',
  'artifactId',
  'filePath',
  'parentStage',
  'workspaceKey',
  'entities',
  'statements',
  'evidence',
  'aliases',
  'chunks',
  'meta',
] as const;

/**
 * Sort object keys according to a preferred order
 * (keys not in the order list come after, in their original order)
 */
export function sortKeys<T extends object>(
  obj: T,
  preferredOrder: readonly string[]
): T {
  const orderSet = new Set(preferredOrder);
  const orderedKeys = preferredOrder.filter(k => k in obj);
  const remainingKeys = Object.keys(obj).filter(k => !orderSet.has(k));
  
  const result: Record<string, unknown> = {};
  for (const key of [...orderedKeys, ...remainingKeys]) {
    result[key] = (obj as Record<string, unknown>)[key];
  }
  
  return result as T;
}
