/**
 * Extraction Schema Contract
 * 
 * UNIFIED schema definition for IntentWeave extraction.
 * 
 * This file is a POLICY LAYER that imports from the single sources of truth:
 * - Entity types from: ../types/index.ts (ENTITY_TYPES)
 * - Predicates from: ../predicates/index.ts (PREDICATES)
 * 
 * The schema defines:
 * - Shape constraints (predicate → subject/object type rules)
 * - Extraction limits (max entities/statements)
 * - Quality requirements (evidence, confidence)
 * - Schema fingerprinting for version tracking
 * 
 * @version 2.0.0 - Unified schema (no serverInteractive/coreRich split)
 */

import { z } from 'zod';
import { createHash } from 'crypto';
import { ENTITY_TYPES, type EntityType } from '../types/index.js';
import { PREDICATES, type Predicate } from '../predicates/index.js';

// =============================================================================
// Re-exports from Single Sources of Truth
// =============================================================================

/**
 * @deprecated Import EntityType directly from '../types/index.js'
 * Kept for backward compatibility during migration.
 */
export { ENTITY_TYPES, type EntityType } from '../types/index.js';
export { PREDICATES, type Predicate } from '../predicates/index.js';

// Backward compatibility aliases
export const ALL_ENTITY_KINDS = ENTITY_TYPES;
export type EntityKind = EntityType;
export const ALL_PREDICATES = PREDICATES;
export type SchemaPredicate = Predicate;

// =============================================================================
// Shape Constraints - The Policy Layer
// =============================================================================

/**
 * Shape constraint - defines valid subject→predicate→object patterns
 * 
 * This is where we enforce domain rules like:
 * - HAS_STATE: resource → state (not state → resource)
 * - TRANSITIONS_TO: state → state (not resource → state)
 */
export interface ShapeConstraint {
  predicate: Predicate;
  subjects: EntityType[];
  objects: (EntityType | 'null')[];  // 'null' for predicates with literal object values
}

/**
 * All shape constraints - unified across the system
 * 
 * CANONICAL DIRECTIONS (post-MX):
 * - FROM_STATE: state → transition (state is subject, transition is object)
 * - TO_STATE: transition → state (transition is subject, state is object)
 * - TRIGGERS: action|event → transition (action/event is subject, transition is object)
 * 
 * See: packages/core/src/predicates/index.ts for authoritative definitions
 */
export const SHAPE_CONSTRAINTS: ShapeConstraint[] = [
  // ============================================
  // State Machine Shapes
  // ============================================
  { predicate: 'HAS_STATE', subjects: ['resource'], objects: ['state'] },
  { predicate: 'TRANSITIONS_TO', subjects: ['state'], objects: ['state'] },
  // Canonical directions (see packages/core/src/predicates/index.ts)
  { predicate: 'FROM_STATE', subjects: ['state'], objects: ['transition'] },       // state → transition
  { predicate: 'TO_STATE', subjects: ['transition'], objects: ['state'] },          // transition → state
  { predicate: 'TRIGGERS', subjects: ['action', 'event'], objects: ['transition'] }, // action|event → transition
  { predicate: 'TRIGGERED_BY', subjects: ['transition'], objects: ['action', 'event'] }, // LEGACY: inverted to TRIGGERS by MX
  { predicate: 'ABSENCE_OF', subjects: ['condition'], objects: ['action'] },
  { predicate: 'WITHIN', subjects: ['condition'], objects: ['null'] },
  
  // ============================================
  // Domain/Rule Shapes
  // ============================================
  { predicate: 'ABOUT_RESOURCE', subjects: ['rule'], objects: ['resource'] },
  { predicate: 'REQUIRES', subjects: ['action', 'transition', 'endpoint'], objects: ['condition', 'role', 'resource'] },
  { predicate: 'CONTAINS', subjects: ['resource', 'module', 'service'], objects: ['resource', 'action', 'state', 'function', 'class'] },
  { predicate: 'IMPLEMENTS', subjects: ['class', 'service'], objects: ['interface'] },
  
  // ============================================
  // Authorization Shapes
  // ============================================
  { predicate: 'ROLE_CAN', subjects: ['role'], objects: ['action', 'endpoint', 'page'] },
  { predicate: 'REQUIRES_ROLE', subjects: ['endpoint', 'page', 'service', 'action'], objects: ['role'] },
  
  // ============================================
  // Service Architecture Shapes
  // ============================================
  { predicate: 'DEPENDS_ON', subjects: ['service', 'frontend', 'queue', 'module'], objects: ['service', 'database', 'queue', 'module'] },
  { predicate: 'EXPOSES_ENDPOINT', subjects: ['service'], objects: ['endpoint'] },
  { predicate: 'CALLS', subjects: ['service', 'frontend', 'page', 'function'], objects: ['endpoint', 'function'] },
  { predicate: 'CONSUMES_ENDPOINT', subjects: ['service', 'frontend', 'page'], objects: ['endpoint'] },
  { predicate: 'PRODUCES_EVENT', subjects: ['service', 'frontend', 'endpoint', 'action'], objects: ['event'] },
  { predicate: 'SUBSCRIBES_EVENT', subjects: ['service', 'frontend', 'queue'], objects: ['event'] },
  
  // ============================================
  // Data Layer Shapes
  // ============================================
  { predicate: 'STORES_IN', subjects: ['service', 'resource'], objects: ['database'] },
  { predicate: 'READS_FROM', subjects: ['service', 'endpoint'], objects: ['database'] },
  { predicate: 'WRITES_TO', subjects: ['service', 'endpoint'], objects: ['database'] },
  { predicate: 'PUBLISHES_TO', subjects: ['service', 'endpoint'], objects: ['queue'] },
  { predicate: 'SUBSCRIBES_TO', subjects: ['service'], objects: ['queue'] },
  { predicate: 'CACHES_IN', subjects: ['service', 'endpoint'], objects: ['database'] },
  
  // ============================================
  // Legacy Shapes (backward compatibility)
  // ============================================
  { predicate: 'SUPPORTS', subjects: ['page', 'service', 'frontend'], objects: ['question', 'concept'] },
  { predicate: 'HAS_OPTION', subjects: ['question', 'concept'], objects: ['state'] },
  { predicate: 'CONTRADICTS', subjects: ['concept', 'rule'], objects: ['concept', 'rule'] },
];

// =============================================================================
// Extraction Limits & Quality - Configuration
// =============================================================================

/**
 * Extraction limits - applies uniformly (no mode distinction)
 */
export interface ExtractionLimits {
  /** Max entities per artifact */
  maxEntitiesPerArtifact: number;
  /** Max statements per artifact */
  maxStatementsPerArtifact: number;
  /** Max evidence items per entity/statement */
  maxEvidenceItems: number;
  /** Target processing time (ms) - informational only */
  targetProcessingMs: number;
}

/**
 * Quality requirements for extraction
 */
export interface QualityRequirements {
  /** Minimum confidence threshold for entities */
  minEntityConfidence: number;
  /** Minimum confidence threshold for statements */
  minStatementConfidence: number;
  /** Whether evidence is required for non-scaffold items */
  evidenceRequired: boolean;
  /** Whether shape validation is enforced */
  shapeValidationStrict: boolean;
}

/**
 * Default extraction limits
 */
export const DEFAULT_LIMITS: ExtractionLimits = {
  maxEntitiesPerArtifact: 100,
  maxStatementsPerArtifact: 200,
  maxEvidenceItems: 5,
  targetProcessingMs: 60000, // 60s is reasonable for real LLM
};

/**
 * Default quality requirements
 */
export const DEFAULT_QUALITY: QualityRequirements = {
  minEntityConfidence: 0.5,
  minStatementConfidence: 0.4,
  evidenceRequired: true,
  shapeValidationStrict: false, // Warn but don't reject
};

// =============================================================================
// Unified Extraction Schema
// =============================================================================

/**
 * Complete extraction schema - ONE schema for all use cases
 * 
 * Different needs (DB persistence, additional LX input) are handled via:
 * - Feature flags in the pipeline configuration
 * - Post-extraction adapters
 * NOT by having different schemas
 */
export interface ExtractionSchema {
  /** Schema identifier */
  schemaId: string;
  /** Semantic version */
  version: string;
  /** Fingerprint hash for drift detection */
  fingerprint: string;
  /** All allowed entity types */
  entityTypes: readonly EntityType[];
  /** All allowed predicates */
  predicates: readonly Predicate[];
  /** Shape constraints for validation */
  shapes: readonly ShapeConstraint[];
  /** Extraction limits */
  limits: ExtractionLimits;
  /** Quality requirements */
  quality: QualityRequirements;
  /** Description */
  description: string;
}

/**
 * Compute a fingerprint hash for schema drift detection
 */
function computeSchemaFingerprint(
  entityTypes: readonly string[],
  predicates: readonly string[],
  shapes: readonly ShapeConstraint[]
): string {
  const content = JSON.stringify({
    entityTypes: [...entityTypes].sort(),
    predicates: [...predicates].sort(),
    shapes: shapes.map(s => ({
      p: s.predicate,
      s: [...s.subjects].sort(),
      o: [...s.objects].sort(),
    })).sort((a, b) => a.p.localeCompare(b.p)),
  });
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * THE unified extraction schema
 * 
 * This is the single schema used across all pipelines.
 * No more serverInteractive vs coreRich distinction.
 */
export const UNIFIED_EXTRACTION_SCHEMA: ExtractionSchema = {
  schemaId: 'intentweave-unified',
  version: '2.0.0',
  fingerprint: computeSchemaFingerprint(ENTITY_TYPES, PREDICATES, SHAPE_CONSTRAINTS),
  entityTypes: ENTITY_TYPES,
  predicates: PREDICATES,
  shapes: SHAPE_CONSTRAINTS,
  limits: DEFAULT_LIMITS,
  quality: DEFAULT_QUALITY,
  description: 'Unified IntentWeave extraction schema - single source of truth for all pipelines',
};

// =============================================================================
// Backward Compatibility - Deprecated Mode APIs
// =============================================================================

/**
 * @deprecated Use UNIFIED_EXTRACTION_SCHEMA directly. Modes are no longer supported.
 */
export type ExtractionMode = 'unified';

/**
 * @deprecated Use UNIFIED_EXTRACTION_SCHEMA directly.
 */
export const SERVER_INTERACTIVE_SCHEMA = UNIFIED_EXTRACTION_SCHEMA;

/**
 * @deprecated Use UNIFIED_EXTRACTION_SCHEMA directly.
 */
export const CORE_RICH_SCHEMA = UNIFIED_EXTRACTION_SCHEMA;

/**
 * @deprecated Use UNIFIED_EXTRACTION_SCHEMA directly.
 */
export const EXTRACTION_SCHEMAS = {
  unified: UNIFIED_EXTRACTION_SCHEMA,
  serverInteractive: UNIFIED_EXTRACTION_SCHEMA, // Alias for backward compat
  coreRich: UNIFIED_EXTRACTION_SCHEMA, // Alias for backward compat
} as const;

/**
 * @deprecated Use UNIFIED_EXTRACTION_SCHEMA directly.
 */
export function getExtractionSchema(_mode?: string): ExtractionSchema {
  return UNIFIED_EXTRACTION_SCHEMA;
}

// =============================================================================
// Schema Validation Helpers
// =============================================================================

/**
 * Get shape constraint for a predicate
 */
export function getShapeForPredicate(predicate: string): ShapeConstraint | undefined {
  return SHAPE_CONSTRAINTS.find(s => s.predicate === predicate);
}

/**
 * Validate a statement against shape constraints
 */
export function validateShape(
  predicate: string,
  subjectType: string,
  objectType: string | null
): { valid: boolean; reason?: string } {
  const shape = getShapeForPredicate(predicate);
  
  if (!shape) {
    return { valid: false, reason: `Unknown predicate: ${predicate}` };
  }
  
  if (!shape.subjects.includes(subjectType as EntityType)) {
    return { 
      valid: false, 
      reason: `Invalid subject type '${subjectType}' for ${predicate}. Expected: ${shape.subjects.join(', ')}` 
    };
  }
  
  const objType = objectType ?? 'null';
  if (!shape.objects.includes(objType as EntityType | 'null')) {
    return { 
      valid: false, 
      reason: `Invalid object type '${objType}' for ${predicate}. Expected: ${shape.objects.join(', ')}` 
    };
  }
  
  return { valid: true };
}

/**
 * Get allowed subject types for a predicate
 */
export function getAllowedSubjectTypes(predicate: string): EntityType[] {
  return getShapeForPredicate(predicate)?.subjects ?? [];
}

/**
 * Get allowed object types for a predicate
 */
export function getAllowedObjectTypes(predicate: string): (EntityType | 'null')[] {
  return getShapeForPredicate(predicate)?.objects ?? [];
}

/**
 * Filter entities to valid types only
 */
export function filterValidEntities<T extends { type: string }>(entities: T[]): T[] {
  return entities.filter(e => ENTITY_TYPES.includes(e.type as EntityType));
}

/**
 * Filter statements to valid predicates only
 */
export function filterValidStatements<T extends { predicate: string }>(statements: T[]): T[] {
  return statements.filter(s => PREDICATES.includes(s.predicate as Predicate));
}

// =============================================================================
// Zod Schemas for Runtime Validation
// =============================================================================

export const EntityTypeZodSchema = z.enum(ENTITY_TYPES);
export const PredicateZodSchema = z.enum(PREDICATES);

// Backward compatibility aliases
export const EntityKindZodSchema = EntityTypeZodSchema;
export const SchemaPredicateZodSchema = PredicateZodSchema;
export const ExtractionModeZodSchema = z.literal('unified');

export const ExtractionLimitsZodSchema = z.object({
  maxEntitiesPerArtifact: z.number().int().positive(),
  maxStatementsPerArtifact: z.number().int().positive(),
  maxEvidenceItems: z.number().int().positive(),
  targetProcessingMs: z.number().int().positive(),
});

export const QualityRequirementsZodSchema = z.object({
  minEntityConfidence: z.number().min(0).max(1),
  minStatementConfidence: z.number().min(0).max(1),
  evidenceRequired: z.boolean(),
  shapeValidationStrict: z.boolean(),
});

export const ShapeConstraintZodSchema = z.object({
  predicate: PredicateZodSchema,
  subjects: z.array(EntityTypeZodSchema),
  objects: z.array(z.union([EntityTypeZodSchema, z.literal('null')])),
});

export const ExtractionSchemaZodSchema = z.object({
  schemaId: z.string(),
  version: z.string(),
  fingerprint: z.string(),
  entityTypes: z.array(EntityTypeZodSchema),
  predicates: z.array(PredicateZodSchema),
  shapes: z.array(ShapeConstraintZodSchema),
  limits: ExtractionLimitsZodSchema,
  quality: QualityRequirementsZodSchema,
  description: z.string(),
});

/**
 * Validate an extraction schema at runtime
 */
export function validateExtractionSchema(schema: unknown): ExtractionSchema {
  return ExtractionSchemaZodSchema.parse(schema);
}

/**
 * Get the current schema fingerprint for embedding in run metadata
 */
export function getSchemaFingerprint(): string {
  return UNIFIED_EXTRACTION_SCHEMA.fingerprint;
}

/**
 * Check if a schema fingerprint matches the current schema
 */
export function isSchemaCompatible(fingerprint: string): boolean {
  return fingerprint === UNIFIED_EXTRACTION_SCHEMA.fingerprint;
}

// =============================================================================
// Deprecated Exports - Keep for backward compatibility
// =============================================================================

/**
 * @deprecated Use SHAPE_CONSTRAINTS directly
 */
export const CORE_SHAPE_CONSTRAINTS = SHAPE_CONSTRAINTS;
export const EXTENDED_SHAPE_CONSTRAINTS: ShapeConstraint[] = [];
export const LEGACY_SHAPE_CONSTRAINTS: ShapeConstraint[] = [];
export const ALL_SHAPE_CONSTRAINTS = SHAPE_CONSTRAINTS;

/**
 * @deprecated Use isValidEntityType from types/index.js
 */
export function isKindAllowed(kind: string, _schema?: ExtractionSchema): boolean {
  return ENTITY_TYPES.includes(kind as EntityType);
}

/**
 * @deprecated Use isValidPredicate from predicates/index.js
 */
export function isPredicateAllowed(predicate: string, _schema?: ExtractionSchema): boolean {
  return PREDICATES.includes(predicate as Predicate);
}

/**
 * @deprecated Use filterValidEntities
 */
export function filterEntitiesToSchema<T extends { type: string }>(
  entities: T[],
  _schema?: ExtractionSchema
): T[] {
  return filterValidEntities(entities);
}

/**
 * @deprecated Use filterValidStatements
 */
export function filterStatementsToSchema<T extends { predicate: string }>(
  statements: T[],
  _schema?: ExtractionSchema
): T[] {
  return filterValidStatements(statements);
}
