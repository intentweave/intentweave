// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shapes - Schema validation rules for entity types
 *
 * This module provides shape validation using the UNIFIED schema from extractionSchema.
 * Shape rules are now defined in a single source of truth.
 *
 * @version 2.0.0 - Unified schema (imports from extractionSchema.ts)
 */

import type { Statement, EntityType } from "../types/index.js";
import {
  SHAPE_CONSTRAINTS,
  getShapeForPredicate,
  getAllowedSubjectTypes as getSubjectTypes,
  getAllowedObjectTypes as getObjectTypes,
  type ShapeConstraint,
} from "../schemas/extractionSchema.js";

// ============================================================================
// SHAPE_RULES - Derived from SHAPE_CONSTRAINTS for backward compatibility
// ============================================================================

/**
 * Shape rules in the old format (Record<predicate, {subj, obj}>)
 *
 * @deprecated Use SHAPE_CONSTRAINTS from extractionSchema.ts directly
 */
export const SHAPE_RULES: Record<
  string,
  { subj: EntityType[]; obj: (EntityType | "null")[] }
> = Object.fromEntries(
  SHAPE_CONSTRAINTS.map((c) => [
    c.predicate,
    { subj: c.subjects, obj: c.objects },
  ]),
);

// ============================================================================
// Shape Check Function
// ============================================================================

export interface ShapeCheckResult {
  ok: boolean;
  subjT?: string | null;
  objT?: string | null;
  reason?: string;
}

/**
 * Check if a statement conforms to shape rules
 */
export function shapeCheck(
  stmt: Statement,
  lookupType: (cgId: string | null) => string | null,
): ShapeCheckResult {
  const shape = getShapeForPredicate(stmt.predicate);
  if (!shape) return { ok: false, reason: "unknown_predicate" };

  const subjT = lookupType(stmt.subjectCgId);
  const objT = stmt.objectCgId ? lookupType(stmt.objectCgId) : "null";

  const allowedSubj = new Set<EntityType>(shape.subjects);
  const allowedObj = new Set<EntityType | "null">(shape.objects);

  const okSubj = subjT ? allowedSubj.has(subjT as EntityType) : false;
  const okObj =
    objT === "null"
      ? allowedObj.has("null")
      : objT
        ? allowedObj.has(objT as EntityType)
        : false;

  return { ok: !!(okSubj && okObj), subjT, objT };
}

// ============================================================================
// Helper Functions - Delegate to extractionSchema
// ============================================================================

/**
 * Get allowed subject types for a predicate
 */
export function getAllowedSubjectTypes(predicate: string): EntityType[] {
  return getSubjectTypes(predicate);
}

/**
 * Get allowed object types for a predicate
 */
export function getAllowedObjectTypes(
  predicate: string,
): (EntityType | "null")[] {
  return getObjectTypes(predicate);
}

/**
 * Check if a predicate is known
 */
export function isKnownPredicate(predicate: string): boolean {
  return getShapeForPredicate(predicate) !== undefined;
}

/**
 * Get all predicates that can have a given subject type
 */
export function getPredicatesForSubjectType(entityType: EntityType): string[] {
  return SHAPE_CONSTRAINTS.filter((c) => c.subjects.includes(entityType)).map(
    (c) => c.predicate,
  );
}

/**
 * Get all predicates that can have a given object type
 */
export function getPredicatesForObjectType(
  entityType: EntityType | "null",
): string[] {
  return SHAPE_CONSTRAINTS.filter((c) => c.objects.includes(entityType)).map(
    (c) => c.predicate,
  );
}

// Re-export ShapeConstraint type for convenience
export type { ShapeConstraint };
