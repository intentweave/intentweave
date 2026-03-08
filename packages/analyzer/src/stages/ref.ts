// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * REF Stage - Reference Resolution (Core)
 *
 * Post-RX step that resolves statement references to canonical entity cgIds.
 *
 * This is a first-class step that runs immediately after RX parsing, before CX/MX.
 * It ensures statements reference actual entities, fixing LLM-generated cgIds that
 * don't match any existing entity.
 *
 * Why this exists:
 * - LLM extraction produces statements with cgIds that may not match entities
 * - e.g., Statement: `ws_0000|model|kg|resource/submitted`
 *         Entity:    `ws_0000|model|kg|state/submitted`
 * - Without resolution, downstream stages (MX) can't find entities for statements
 *
 * Architecture:
 * - Deterministic (no LLM calls)
 * - Runs after RX, before CX
 * - Logs resolution events for debugging
 * - Shared by CLI, server, and all pipeline consumers
 *
 * Resolution Strategy (ordered by precedence):
 * 1. Exact cgId match (confidence: 1.0)
 * 2. (type, normalizedName) exact match (confidence: 0.95)
 * 3. Aliases from extraction context (confidence: 0.9)
 * 4. Partial match - ONLY if unique (confidence: similarity)
 * 5. Unresolved with reason if ambiguous
 *
 * Evidence Preservation:
 * - Original cgId stored in statement._resolution.originalCgId
 * - Match method and confidence tracked for audit
 */

import type { Entity, Statement } from "@intentweave/core";

// =============================================================================
// Types
// =============================================================================

/**
 * Resolution event for debugging/audit
 */
export interface ResolutionEvent {
  /** Original cgId from statement */
  originalCgId: string;
  /** Resolved cgId (entity cgId it was matched to, or original if unresolved) */
  resolvedCgId: string;
  /** How the resolution was made */
  matchType:
    | "exact"
    | "type-name"
    | "name-match"
    | "normalized-name"
    | "alias"
    | "partial-match"
    | "unresolved";
  /** Confidence in the resolution (1.0 for exact, lower for fuzzy, 0 for unresolved) */
  confidence: number;
  /** Which statement field was resolved */
  field: "subjectCgId" | "objectCgId";
  /** Reason for unresolved (if applicable) */
  unresolvedReason?: "no-match" | "ambiguous" | "below-threshold";
  /** Number of candidate matches (for ambiguous case) */
  candidateCount?: number;
}

/**
 * Resolution metadata attached to statements for evidence preservation
 */
export interface ResolutionMeta {
  /** Original cgId before resolution */
  originalSubjectCgId?: string;
  /** Original object cgId before resolution */
  originalObjectCgId?: string;
  /** Match method for subject */
  subjectMatchType?: ResolutionEvent["matchType"];
  /** Match method for object */
  objectMatchType?: ResolutionEvent["matchType"];
  /** Confidence for subject resolution */
  subjectConfidence?: number;
  /** Confidence for object resolution */
  objectConfidence?: number;
}

/**
 * Extended statement with resolution metadata
 */
export interface ResolvedStatement extends Statement {
  /** Resolution metadata for evidence preservation */
  _resolution?: ResolutionMeta;
}

/**
 * Resolution result
 */
export interface RefResolutionResult {
  /** Statements with resolved cgIds */
  statements: ResolvedStatement[];
  /** Resolution events for debugging */
  resolutions: ResolutionEvent[];
  /** Stats */
  stats: {
    /** Total cgIds checked */
    totalChecked: number;
    /** cgIds that were already correct */
    alreadyResolved: number;
    /** cgIds resolved via name matching */
    resolvedByName: number;
    /** cgIds that couldn't be resolved */
    unresolved: number;
    /** cgIds unresolved due to ambiguity */
    ambiguous: number;
  };
}

/**
 * Options for reference resolution
 */
export interface RefResolutionOptions {
  /** Minimum similarity threshold for partial matching (default: 0.7) */
  minSimilarity?: number;
  /** Whether to log resolution events */
  verbose?: boolean;
  /** Entity aliases from extraction context (name → cgId mapping) */
  aliases?: Map<string, string>;
}

// =============================================================================
// Name Normalization
// =============================================================================

/**
 * Normalize a name for comparison
 *
 * Enhanced normalization strategy (P2 fix):
 * 1. Split camelCase/PascalCase into tokens ("UserDeactivated" → "user deactivated")
 * 2. Casefold (toLowerCase)
 * 3. Slugify (spaces/underscores/dashes → single space)
 * 4. Remove punctuation (but preserve alphanumeric)
 * 5. Trim and collapse whitespace
 *
 * @example
 * - "UserDeactivated" → "user deactivated"
 * - "user-deactivated" → "user deactivated"
 * - "requested (state)" → "requested state"
 * - "ACTIVE_STATE" → "active state"
 */
function normalizeName(name: string): string {
  // Step 1: Split camelCase/PascalCase into tokens
  // "UserDeactivated" → "User Deactivated"
  // "XMLParser" → "XML Parser"
  const withSpaces = name
    .replace(/([a-z])([A-Z])/g, "$1 $2") // lowercase followed by uppercase
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // sequence of uppercase followed by uppercase+lowercase

  // Step 2: Casefold
  const lower = withSpaces.toLowerCase();

  // Step 3: Slugify - convert separators to spaces
  const spaced = lower.replace(/[_-]+/g, " ");

  // Step 4: Remove punctuation (keep alphanumeric and spaces)
  const cleaned = spaced.replace(/[^a-z0-9\s]/g, "");

  // Step 5: Collapse whitespace and trim
  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Extract entity name from a cgId
 *
 * Handles formats:
 * - `ws_0000|model|kg|type/name`
 * - `ws_0000|model|kg|type/name-suffix`
 *
 * @returns Extracted name or null if can't parse
 */
export function extractNameFromCgId(cgId: string): string | null {
  // Match the last segment after the final /
  const match = cgId.match(/\/([^/]+)$/);
  if (!match) return null;

  let name = match[1];

  // Remove common type suffixes that get appended
  // e.g., "active-state" → "active", "submit-action" → "submit"
  name = name.replace(/-(state|action|resource|role|event|transition)$/i, "");

  // Convert kebab-case to space-separated for matching
  return name.replace(/-/g, " ").trim();
}

/**
 * Extract entity type from a cgId
 *
 * @returns Type like 'state', 'action', 'resource', or null
 */
export function extractTypeFromCgId(cgId: string): string | null {
  // Match the type segment before the final /name
  const match = cgId.match(/\|([^|/]+)\/[^/]+$/);
  return match ? match[1] : null;
}

/**
 * Calculate similarity between two strings
 * Uses Levenshtein distance normalized to 0-1
 */
function calculateSimilarity(a: string, b: string): number {
  const normA = normalizeName(a);
  const normB = normalizeName(b);

  if (normA === normB) return 1.0;

  // Levenshtein distance
  const matrix: number[][] = [];
  for (let i = 0; i <= normB.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= normA.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= normB.length; i++) {
    for (let j = 1; j <= normA.length; j++) {
      if (normB.charAt(i - 1) === normA.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  const distance = matrix[normB.length][normA.length];
  const maxLen = Math.max(normA.length, normB.length);
  return maxLen === 0 ? 0 : 1 - distance / maxLen;
}

// =============================================================================
// Entity Matching
// =============================================================================

/**
 * Build an index of entities by normalized name for fast lookup
 */
function buildEntityIndex(entities: Entity[]): Map<string, Entity[]> {
  const index = new Map<string, Entity[]>();

  for (const entity of entities) {
    const normalizedName = normalizeName(entity.name);
    const existing = index.get(normalizedName) ?? [];
    existing.push(entity);
    index.set(normalizedName, existing);
  }

  return index;
}

/**
 * Build an index of entities by (type, normalizedName) for exact type+name matching
 */
function buildTypeNameIndex(entities: Entity[]): Map<string, Entity> {
  const index = new Map<string, Entity>();

  for (const entity of entities) {
    const key = `${entity.type}:${normalizeName(entity.name)}`;
    // Only keep first match per type+name (avoid duplicates)
    if (!index.has(key)) {
      index.set(key, entity);
    }
  }

  return index;
}

/**
 * Find entity by exact cgId
 */
function findByExactCgId(cgId: string, entities: Entity[]): Entity | undefined {
  return entities.find((e) => e.cgId === cgId);
}

/**
 * Find entity by partial name match - returns all matches above threshold
 */
function findAllPartialMatches(
  name: string,
  entities: Entity[],
  minSimilarity: number,
): Array<{ entity: Entity; similarity: number }> {
  const normalizedName = normalizeName(name);
  const matches: Array<{ entity: Entity; similarity: number }> = [];

  for (const entity of entities) {
    const similarity = calculateSimilarity(entity.name, normalizedName);
    if (similarity >= minSimilarity) {
      matches.push({ entity, similarity });
    }
  }

  // Sort by similarity descending
  return matches.sort((a, b) => b.similarity - a.similarity);
}

// =============================================================================
// Resolution Result Type
// =============================================================================

interface InternalResolution {
  resolvedCgId: string;
  matchType: ResolutionEvent["matchType"];
  confidence: number;
  unresolvedReason?: "no-match" | "ambiguous" | "below-threshold";
  candidateCount?: number;
}

// =============================================================================
// Reference Resolution
// =============================================================================

/**
 * Resolve a single cgId to a canonical entity cgId
 *
 * Resolution strategy (ordered by precedence - SAFE):
 * 1. Exact cgId match (confidence: 1.0)
 * 2. (type, normalizedName) exact match (confidence: 0.95)
 * 3. Alias lookup (confidence: 0.9)
 * 4. Partial match - ONLY if unique (confidence: similarity)
 * 5. Unresolved with reason if no match or ambiguous
 */
function resolveCgId(
  cgId: string,
  entities: Entity[],
  entityIndex: Map<string, Entity[]>,
  typeNameIndex: Map<string, Entity>,
  options: Required<RefResolutionOptions>,
): InternalResolution {
  // 1. Exact cgId match
  const exactMatch = findByExactCgId(cgId, entities);
  if (exactMatch) {
    return { resolvedCgId: cgId, matchType: "exact", confidence: 1.0 };
  }

  // 2. Extract name and type from cgId
  const extractedName = extractNameFromCgId(cgId);
  const extractedType = extractTypeFromCgId(cgId);

  if (!extractedName) {
    // Can't extract name - unresolved
    return {
      resolvedCgId: cgId,
      matchType: "unresolved",
      confidence: 0.0,
      unresolvedReason: "no-match",
    };
  }

  // 3. (type, normalizedName) exact match
  if (extractedType) {
    const typeNameKey = `${extractedType}:${normalizeName(extractedName)}`;
    const typeNameMatch = typeNameIndex.get(typeNameKey);
    if (typeNameMatch) {
      return {
        resolvedCgId: typeNameMatch.cgId,
        matchType: "type-name",
        confidence: 0.95,
      };
    }
  }

  // 4. Alias lookup (from extraction context)
  if (options.aliases) {
    const aliasMatch = options.aliases.get(normalizeName(extractedName));
    if (aliasMatch) {
      // Verify the alias points to a real entity
      const aliasEntity = findByExactCgId(aliasMatch, entities);
      if (aliasEntity) {
        return {
          resolvedCgId: aliasMatch,
          matchType: "alias",
          confidence: 0.9,
        };
      }
    }
  }

  // 5. Name-only match (any type) - check for ambiguity
  const normalizedName = normalizeName(extractedName);
  const nameMatches = entityIndex.get(normalizedName);

  if (nameMatches && nameMatches.length === 1) {
    // Unique name match
    return {
      resolvedCgId: nameMatches[0].cgId,
      matchType: "name-match",
      confidence: 0.85,
    };
  } else if (nameMatches && nameMatches.length > 1) {
    // Ambiguous - multiple entities with same name
    return {
      resolvedCgId: cgId,
      matchType: "unresolved",
      confidence: 0.0,
      unresolvedReason: "ambiguous",
      candidateCount: nameMatches.length,
    };
  }

  // 6. Partial match - ONLY if unique
  const partialMatches = findAllPartialMatches(
    extractedName,
    entities,
    options.minSimilarity,
  );

  if (partialMatches.length === 1) {
    // Unique partial match
    return {
      resolvedCgId: partialMatches[0].entity.cgId,
      matchType: "partial-match",
      confidence: partialMatches[0].similarity,
    };
  } else if (partialMatches.length > 1) {
    // Check if there's a clear winner (significantly better than runner-up)
    const [best, second] = partialMatches;
    if (best.similarity - second.similarity > 0.15) {
      // Clear winner - use it
      return {
        resolvedCgId: best.entity.cgId,
        matchType: "partial-match",
        confidence: best.similarity,
      };
    }
    // Ambiguous partial matches
    return {
      resolvedCgId: cgId,
      matchType: "unresolved",
      confidence: 0.0,
      unresolvedReason: "ambiguous",
      candidateCount: partialMatches.length,
    };
  }

  // No match found
  return {
    resolvedCgId: cgId,
    matchType: "unresolved",
    confidence: 0.0,
    unresolvedReason: "no-match",
  };
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Resolve statement references to canonical entity cgIds
 *
 * This is the main entry point for reference resolution.
 * Call this after RX parsing, before CX/MX stages.
 *
 * Evidence Preservation:
 * - Stores original cgIds in statement._resolution for audit
 * - Tracks match method and confidence
 *
 * @param entities - Entities from RX extraction
 * @param statements - Statements from RX extraction
 * @param options - Resolution options
 * @returns Resolved statements and resolution events
 *
 * @example
 * ```typescript
 * const rxOutput = await runRxStage(input, ctx);
 * const { statements: resolvedStatements, resolutions } = resolveStatementRefs(
 *   rxOutput.entities,
 *   rxOutput.statements
 * );
 * // Pass resolvedStatements to CX/MX
 * ```
 */
export function resolveStatementRefs(
  entities: Entity[],
  statements: Statement[],
  options: RefResolutionOptions = {},
): RefResolutionResult {
  const opts: Required<RefResolutionOptions> = {
    minSimilarity: options.minSimilarity ?? 0.7,
    verbose: options.verbose ?? false,
    aliases: options.aliases ?? new Map(),
  };

  // Build entity indexes for fast lookup
  const entityIndex = buildEntityIndex(entities);
  const typeNameIndex = buildTypeNameIndex(entities);

  const resolutions: ResolutionEvent[] = [];
  const stats = {
    totalChecked: 0,
    alreadyResolved: 0,
    resolvedByName: 0,
    unresolved: 0,
    ambiguous: 0,
  };

  const resolvedStatements: ResolvedStatement[] = statements.map((stmt) => {
    let subjectCgId = stmt.subjectCgId;
    let objectCgId = stmt.objectCgId;

    // Track resolution metadata for evidence preservation
    const resolution: ResolutionMeta = {};

    // Track if subject/object are unresolved by REF
    let subjectUnresolved = false;
    let objectUnresolved = false;

    // Resolve subjectCgId
    stats.totalChecked++;
    const subjectResolution = resolveCgId(
      subjectCgId,
      entities,
      entityIndex,
      typeNameIndex,
      opts,
    );

    if (
      subjectResolution.matchType === "exact" &&
      subjectResolution.confidence === 1.0
    ) {
      stats.alreadyResolved++;
    } else if (subjectResolution.matchType === "unresolved") {
      stats.unresolved++;
      subjectUnresolved = true;
      if (subjectResolution.unresolvedReason === "ambiguous") {
        stats.ambiguous++;
      }
      // Record unresolved event
      resolutions.push({
        originalCgId: subjectCgId,
        resolvedCgId: subjectCgId,
        matchType: "unresolved",
        confidence: 0,
        field: "subjectCgId",
        unresolvedReason: subjectResolution.unresolvedReason,
        candidateCount: subjectResolution.candidateCount,
      });
    } else if (subjectResolution.resolvedCgId !== subjectCgId) {
      // Successfully resolved to different cgId
      resolutions.push({
        originalCgId: subjectCgId,
        resolvedCgId: subjectResolution.resolvedCgId,
        matchType: subjectResolution.matchType,
        confidence: subjectResolution.confidence,
        field: "subjectCgId",
      });

      // Preserve evidence
      resolution.originalSubjectCgId = subjectCgId;
      resolution.subjectMatchType = subjectResolution.matchType;
      resolution.subjectConfidence = subjectResolution.confidence;

      subjectCgId = subjectResolution.resolvedCgId;
      stats.resolvedByName++;
    }

    // Resolve objectCgId if present
    if (objectCgId) {
      stats.totalChecked++;
      const objectResolution = resolveCgId(
        objectCgId,
        entities,
        entityIndex,
        typeNameIndex,
        opts,
      );

      if (
        objectResolution.matchType === "exact" &&
        objectResolution.confidence === 1.0
      ) {
        stats.alreadyResolved++;
      } else if (objectResolution.matchType === "unresolved") {
        stats.unresolved++;
        objectUnresolved = true;
        if (objectResolution.unresolvedReason === "ambiguous") {
          stats.ambiguous++;
        }
        // Record unresolved event
        resolutions.push({
          originalCgId: objectCgId,
          resolvedCgId: objectCgId,
          matchType: "unresolved",
          confidence: 0,
          field: "objectCgId",
          unresolvedReason: objectResolution.unresolvedReason,
          candidateCount: objectResolution.candidateCount,
        });
      } else if (objectResolution.resolvedCgId !== objectCgId) {
        // Successfully resolved to different cgId
        resolutions.push({
          originalCgId: objectCgId,
          resolvedCgId: objectResolution.resolvedCgId,
          matchType: objectResolution.matchType,
          confidence: objectResolution.confidence,
          field: "objectCgId",
        });

        // Preserve evidence
        resolution.originalObjectCgId = objectCgId;
        resolution.objectMatchType = objectResolution.matchType;
        resolution.objectConfidence = objectResolution.confidence;

        objectCgId = objectResolution.resolvedCgId;
        stats.resolvedByName++;
      }
    }

    // Build resolved statement with evidence preservation
    const resolvedStmt: ResolvedStatement = {
      ...stmt,
      subjectCgId,
      objectCgId,
    };

    // Clear stale flags from DefaultExtraction (REF is the canonical resolver)
    delete (resolvedStmt as any)._unresolvedRef;
    delete (resolvedStmt as any)._refResolution;

    // Only attach _resolution if we actually resolved something
    if (Object.keys(resolution).length > 0) {
      resolvedStmt._resolution = resolution;
    }

    // Mark as unresolved only if REF couldn't resolve subject or object
    if (subjectUnresolved || objectUnresolved) {
      (resolvedStmt as any)._unresolvedRef = true;
    }

    return resolvedStmt;
  });

  if (opts.verbose && resolutions.length > 0) {
    console.log(`[REF] Resolved ${resolutions.length} statement references:`);
    for (const r of resolutions) {
      if (r.matchType === "unresolved") {
        console.log(
          `  ${r.field}: ${r.originalCgId} → UNRESOLVED (${r.unresolvedReason}, candidates: ${r.candidateCount ?? 0})`,
        );
      } else {
        console.log(
          `  ${r.field}: ${r.originalCgId} → ${r.resolvedCgId} (${r.matchType}, ${(r.confidence * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  return {
    statements: resolvedStatements,
    resolutions,
    stats,
  };
}

/**
 * Validate that all statement references point to existing entities
 *
 * @returns List of unresolved references
 */
export function validateStatementRefs(
  entities: Entity[],
  statements: Statement[],
): Array<{
  statementIndex: number;
  field: "subjectCgId" | "objectCgId";
  cgId: string;
}> {
  const entityCgIds = new Set(entities.map((e) => e.cgId));
  const unresolved: Array<{
    statementIndex: number;
    field: "subjectCgId" | "objectCgId";
    cgId: string;
  }> = [];

  statements.forEach((stmt, index) => {
    if (!entityCgIds.has(stmt.subjectCgId)) {
      unresolved.push({
        statementIndex: index,
        field: "subjectCgId",
        cgId: stmt.subjectCgId,
      });
    }
    if (stmt.objectCgId && !entityCgIds.has(stmt.objectCgId)) {
      unresolved.push({
        statementIndex: index,
        field: "objectCgId",
        cgId: stmt.objectCgId,
      });
    }
  });

  return unresolved;
}

// =============================================================================
// MX Pre-Gate: Assert resolvable endpoints
// =============================================================================

/**
 * Validation result for MX pre-gate
 */
export interface MxPreGateResult {
  /** Whether all required predicates have resolvable endpoints */
  valid: boolean;
  /** Unresolved reference stats */
  unresolvedStats: {
    /** Total unresolved references */
    total: number;
    /** Unresolved by predicate */
    byPredicate: Record<string, number>;
    /** Detailed unresolved references */
    details: Array<{
      predicate: string;
      field: "subjectCgId" | "objectCgId";
      cgId: string;
      statementIndex: number;
    }>;
  };
}

/**
 * Predicates that require both subject and object to be resolvable for MX
 */
const MX_REQUIRED_PREDICATES = [
  "TRANSITIONS_TO",
  "FROM_STATE",
  "TO_STATE",
  "HAS_STATE",
  "TRIGGERS",
] as const;

/**
 * Pre-gate check before MX stage
 *
 * Asserts that all required predicates have resolvable endpoints.
 * Use this to prevent silent "0 materialized" failures.
 *
 * @param entities - Entities after REF resolution
 * @param statements - Statements after REF resolution
 * @returns Validation result with detailed unresolved stats
 */
export function assertMxPreGate(
  entities: Entity[],
  statements: Statement[],
): MxPreGateResult {
  const entityCgIds = new Set(entities.map((e) => e.cgId));

  const unresolvedDetails: MxPreGateResult["unresolvedStats"]["details"] = [];
  const byPredicate: Record<string, number> = {};

  statements.forEach((stmt, index) => {
    // Only check predicates that MX cares about
    if (!MX_REQUIRED_PREDICATES.includes(stmt.predicate as any)) {
      return;
    }

    // Check subject
    if (!entityCgIds.has(stmt.subjectCgId)) {
      unresolvedDetails.push({
        predicate: stmt.predicate,
        field: "subjectCgId",
        cgId: stmt.subjectCgId,
        statementIndex: index,
      });
      byPredicate[stmt.predicate] = (byPredicate[stmt.predicate] ?? 0) + 1;
    }

    // Check object (if required for this predicate)
    if (stmt.objectCgId && !entityCgIds.has(stmt.objectCgId)) {
      unresolvedDetails.push({
        predicate: stmt.predicate,
        field: "objectCgId",
        cgId: stmt.objectCgId,
        statementIndex: index,
      });
      byPredicate[stmt.predicate] = (byPredicate[stmt.predicate] ?? 0) + 1;
    }
  });

  return {
    valid: unresolvedDetails.length === 0,
    unresolvedStats: {
      total: unresolvedDetails.length,
      byPredicate,
      details: unresolvedDetails,
    },
  };
}

// =============================================================================
// P0: TRANSITIONS_TO Schema Constraints
// =============================================================================

/**
 * Predicate-specific type constraints
 * Defines which entity types are valid for subject and object positions
 */
export const PREDICATE_CONSTRAINTS: Record<
  string,
  { subject: string[]; object: string[] }
> = {
  // State-to-state transitions
  TRANSITIONS_TO: {
    subject: ["state"],
    object: ["state"],
  },
  // Resource owns states
  HAS_STATE: {
    subject: ["resource", "entity", "component"],
    object: ["state"],
  },
  // Transition bindings
  FROM_STATE: {
    subject: ["transition"],
    object: ["state"],
  },
  TO_STATE: {
    subject: ["transition"],
    object: ["state"],
  },
  // Role permissions
  ROLE_CAN: {
    subject: ["role"],
    object: ["action"],
  },
};

/**
 * Schema violation for predicate type constraints
 */
export interface PredicateViolation {
  /** Statement index */
  statementIndex: number;
  /** The predicate that was violated */
  predicate: string;
  /** Which field has the wrong type */
  field: "subject" | "object";
  /** The cgId of the entity */
  cgId: string;
  /** Actual entity type found */
  actualType: string;
  /** Expected entity types */
  expectedTypes: string[];
}

/**
 * Result of predicate schema validation
 */
export interface PredicateSchemaResult {
  /** Whether all predicates pass type constraints */
  valid: boolean;
  /** Violations found */
  violations: PredicateViolation[];
  /** Stats by predicate */
  stats: {
    checked: number;
    valid: number;
    invalid: number;
    byPredicate: Record<string, { valid: number; invalid: number }>;
  };
}

/**
 * Validate that statements conform to predicate-specific type constraints
 *
 * This enforces semantic correctness:
 * - TRANSITIONS_TO: subject and object must be states
 * - HAS_STATE: subject must be resource, object must be state
 * - etc.
 *
 * @param entities - Entities to validate against
 * @param statements - Statements to validate
 * @returns Validation result with violations
 */
export function validatePredicateSchema(
  entities: Entity[],
  statements: Statement[],
): PredicateSchemaResult {
  const entityMap = new Map<string, Entity>();
  for (const entity of entities) {
    entityMap.set(entity.cgId, entity);
  }

  const violations: PredicateViolation[] = [];
  const byPredicate: Record<string, { valid: number; invalid: number }> = {};
  let checked = 0;
  let valid = 0;

  statements.forEach((stmt, index) => {
    const constraints = PREDICATE_CONSTRAINTS[stmt.predicate];
    if (!constraints) {
      // No constraints defined for this predicate - skip
      return;
    }

    checked++;
    byPredicate[stmt.predicate] = byPredicate[stmt.predicate] ?? {
      valid: 0,
      invalid: 0,
    };

    let isValid = true;

    // Check subject type
    const subjectEntity = entityMap.get(stmt.subjectCgId);
    if (subjectEntity) {
      const subjectType = subjectEntity.type.toLowerCase();
      if (!constraints.subject.includes(subjectType)) {
        violations.push({
          statementIndex: index,
          predicate: stmt.predicate,
          field: "subject",
          cgId: stmt.subjectCgId,
          actualType: subjectType,
          expectedTypes: constraints.subject,
        });
        isValid = false;
      }
    }

    // Check object type
    if (stmt.objectCgId) {
      const objectEntity = entityMap.get(stmt.objectCgId);
      if (objectEntity) {
        const objectType = objectEntity.type.toLowerCase();
        if (!constraints.object.includes(objectType)) {
          violations.push({
            statementIndex: index,
            predicate: stmt.predicate,
            field: "object",
            cgId: stmt.objectCgId,
            actualType: objectType,
            expectedTypes: constraints.object,
          });
          isValid = false;
        }
      }
    }

    if (isValid) {
      valid++;
      byPredicate[stmt.predicate].valid++;
    } else {
      byPredicate[stmt.predicate].invalid++;
    }
  });

  return {
    valid: violations.length === 0,
    violations,
    stats: {
      checked,
      valid,
      invalid: violations.length,
      byPredicate,
    },
  };
}

/**
 * Correct statements that violate predicate constraints
 *
 * Strategy:
 * - For TRANSITIONS_TO with resource subject: Look for HAS_STATE to find actual state
 * - Demote to warning and log for manual review
 *
 * @param entities - Entities to use for correction
 * @param statements - Statements to correct
 * @returns Corrected statements and correction events
 */
export function correctPredicateViolations(
  entities: Entity[],
  statements: Statement[],
): { statements: Statement[]; corrections: ResolutionEvent[] } {
  const entityMap = new Map<string, Entity>();
  const statesByResource = new Map<string, Entity[]>();

  for (const entity of entities) {
    entityMap.set(entity.cgId, entity);
  }

  // Build resource → states mapping from HAS_STATE statements
  for (const stmt of statements) {
    if (stmt.predicate === "HAS_STATE" && stmt.objectCgId) {
      const resourceCgId = stmt.subjectCgId;
      const stateCgId = stmt.objectCgId;
      const stateEntity = entityMap.get(stateCgId);
      if (stateEntity) {
        const existing = statesByResource.get(resourceCgId) ?? [];
        existing.push(stateEntity);
        statesByResource.set(resourceCgId, existing);
      }
    }
  }

  const corrections: ResolutionEvent[] = [];

  const correctedStatements = statements.map((stmt, _index) => {
    if (stmt.predicate !== "TRANSITIONS_TO") {
      return stmt;
    }

    // Check if subject is a resource (violation)
    const subjectEntity = entityMap.get(stmt.subjectCgId);
    if (!subjectEntity || subjectEntity.type.toLowerCase() === "state") {
      return stmt; // Already valid or can't determine
    }

    // Subject is not a state (e.g., it's a resource)
    // Try to find a state associated with this resource
    // This is a heuristic - we're essentially saying "document TRANSITIONS_TO active"
    // should become "some-state TRANSITIONS_TO active" if we can find one

    // For now, log as correction but don't actually correct
    // The LLM produced incorrect semantics that we should flag
    corrections.push({
      originalCgId: stmt.subjectCgId,
      resolvedCgId: stmt.subjectCgId, // Keep as-is
      matchType: "unresolved",
      confidence: 0,
      field: "subjectCgId",
      unresolvedReason: "ambiguous", // Semantically wrong, flagged for review
    });

    return stmt;
  });

  return { statements: correctedStatements, corrections };
}
