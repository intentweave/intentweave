// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Extraction Provider Types
 * 
 * Internal types for extraction provider implementations.
 * Core types (ExtractionProvider, ExtractionResult, Chunk, etc.) are in @intentweave/core.
 */

/**
 * Extraction mode: controls what gets extracted
 */
export type ExtractionMode = 
  | 'single-pass'      // Extract entities and statements together (original behavior)
  | 'two-pass'         // Extract entities first, then statements (better quality)
  | 'entities-only'    // Extract only entities
  | 'statements-only'; // Extract only statements (requires entities as input)

/**
 * Default extraction provider configuration
 */
export interface DefaultExtractionConfig {
  /** System prompt for entity extraction */
  systemPrompt?: string;
  
  /** Maximum chunks to process in parallel */
  parallelChunks?: number;
  
  /** Enable confidence scoring */
  enableConfidence?: boolean;
  
  /** Enable evidence span tracking */
  enableEvidenceSpans?: boolean;
  
  /** Temperature for LLM calls */
  temperature?: number;
  
  /** Extraction mode (single-pass, two-pass, entities-only, statements-only) */
  extractionMode?: ExtractionMode;
  
  /** Workspace key/ID for cgId generation (defaults to 'ws_0000' if not provided) */
  workspaceKey?: string;
}

/**
 * JSON Schema for extraction response (single-pass: entities + statements)
 * 
 * Note: OpenAI's strict mode requires all properties to be in 'required' array.
 * Fields cannot be optional - they must either be required or omitted entirely.
 */
export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Entity name' },
          kind: { type: 'string', description: 'Entity kind (role, action, resource, state, etc.)' },
          description: { type: 'string', description: 'Brief description' },
          confidence: { type: 'number', description: 'Confidence score 0-1' },
        },
        required: ['name', 'kind', 'description', 'confidence'],
        additionalProperties: false,
      },
    },
    statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Subject entity name' },
          predicate: { type: 'string', description: 'Relationship type (ROLE_CAN, HAS_STATE, etc.)' },
          object: { type: 'string', description: 'Object entity name' },
          confidence: { type: 'number', description: 'Confidence score 0-1' },
        },
        required: ['subject', 'predicate', 'object', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities', 'statements'],
  additionalProperties: false,
} as const;

/**
 * JSON Schema for entities-only extraction (Pass 1 of 2-pass mode)
 */
export const ENTITIES_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Entity name (MUST be exact substring from source text)' },
          kind: { type: 'string', description: 'Entity kind from allowed list' },
          description: { type: 'string', description: 'Brief description' },
          confidence: { type: 'number', description: 'Confidence score 0-1' },
        },
        required: ['name', 'kind', 'description', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities'],
  additionalProperties: false,
} as const;

/**
 * JSON Schema for statements-only extraction (Pass 2 of 2-pass mode)
 */
export const STATEMENTS_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Subject entity name (must match Pass 1 entity)' },
          predicate: { type: 'string', description: 'Relationship type from allowed list' },
          object: { type: 'string', description: 'Object entity name (must match Pass 1 entity)' },
          confidence: { type: 'number', description: 'Confidence score 0-1' },
        },
        required: ['subject', 'predicate', 'object', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['statements'],
  additionalProperties: false,
} as const;
