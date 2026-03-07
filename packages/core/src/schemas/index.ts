/**
 * @intentweave/core/schemas
 *
 * JSON Schema definitions and utilities for IntentWeave output files.
 * These schemas define the contract for .iw bundle files.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Re-export validation utilities
export * from './validation.js';

// Re-export extraction schema contract
export * from './extractionSchema.js';

// Re-export stage output contract
export * from './stageOutputContract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Schema URIs for each output type
 */
export const SCHEMA_IDS = {
  RUN_META: 'intentweave://schemas/run-meta/v1',
  PX_GRAPH: 'intentweave://schemas/px-graph/v1',
  LX_PROPOSALS: 'intentweave://schemas/lx-proposals/v1',
  COVERAGE: 'intentweave://schemas/coverage/v1',
  FINDINGS: 'intentweave://schemas/findings/v1',
} as const;

export type SchemaId = keyof typeof SCHEMA_IDS;

/**
 * Schema file names
 */
const SCHEMA_FILES: Record<SchemaId, string> = {
  RUN_META: 'run-meta-v1.json',
  PX_GRAPH: 'px-output-v1.json',
  LX_PROPOSALS: 'lx-proposals-v1.json',
  COVERAGE: 'coverage-v1.json',
  FINDINGS: 'findings-v1.json',
};

/**
 * Cached schemas
 */
const schemaCache = new Map<SchemaId, object>();

/**
 * Get the path to the schemas directory
 */
function getSchemasDir(): string {
  // In dist: __dirname is dist/schemas, schemas are at ../schemas
  // In src:  __dirname is src/schemas, schemas are at ../../schemas
  const distPath = join(__dirname, '..', 'schemas');
  const srcPath = join(__dirname, '..', '..', 'schemas');
  
  try {
    // Check if we're running from dist
    readFileSync(join(distPath, 'run-meta-v1.json'));
    return distPath;
  } catch {
    return srcPath;
  }
}

/**
 * Load a schema by type
 */
export function loadSchema(type: SchemaId): object {
  if (schemaCache.has(type)) {
    return schemaCache.get(type)!;
  }

  const schemasDir = getSchemasDir();
  const schemaPath = join(schemasDir, SCHEMA_FILES[type]);
  const content = readFileSync(schemaPath, 'utf-8');
  const schema = JSON.parse(content) as object;
  
  schemaCache.set(type, schema);
  return schema;
}

/**
 * Get schema ID (URI) by type
 */
export function getSchemaIdUri(type: SchemaId): string {
  return SCHEMA_IDS[type];
}

/**
 * Get all schema types
 */
export function getSchemaTypes(): SchemaId[] {
  return Object.keys(SCHEMA_IDS) as SchemaId[];
}

/**
 * Load all schemas
 */
export function loadAllSchemas(): Record<SchemaId, object> {
  const result = {} as Record<SchemaId, object>;
  for (const type of getSchemaTypes()) {
    result[type] = loadSchema(type);
  }
  return result;
}
