// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CX Stage - Consolidation (Core)
 *
 * Per-artifact stage that consolidates RX output.
 *
 * Input: rx.json (entities/statements graph)
 * Output: cx.json (normalized entities/statements graph + aliases)
 *
 * Responsibilities (SPEC-COMPLIANT):
 * - Normalize entity names (casing, whitespace)
 * - Deduplicate entities (merge by name similarity)
 * - Infer entity kinds from statement participation (shape inference)
 * - Record alias mappings for merged entities
 * - Pass through statements with updated cgIds
 *
 * NOTE: CX does NOT create new entity types or domain-specific structures.
 * Domain-specific materialization (transitions, etc.) belongs in MX.
 */

import type { PipelineContext } from "../pipeline/context.js";
import type { Entity, Statement, Evidence } from "@intentweave/core";
import type { RxStageOutput } from "./rx.js";

// =============================================================================
// CX Stage Types
// =============================================================================

/**
 * Alias mapping for merged entities
 */
export interface AliasMapping {
  /** Original cgId that was merged away */
  originalCgId: string;
  /** Original name */
  originalName: string;
  /** Canonical cgId it was merged into */
  canonicalCgId: string;
  /** Canonical name */
  canonicalName: string;
  /** Similarity score that triggered merge */
  similarity: number;
}

/**
 * Normalization record for tracking changes
 */
export interface Normalization {
  /** Entity cgId */
  cgId: string;
  /** Type of normalization applied */
  type: "name" | "kind" | "merge";
  /** Original value */
  from: string;
  /** New value */
  to: string;
  /** Reason for normalization */
  reason: string;
}

/**
 * CX Stage Output (spec-compliant: same graph shape as RX)
 */
export interface CxStageOutput {
  /** JSON Schema reference */
  $schema: string;
  /** Schema version */
  schemaVersion: "0.1";
  /** Stage identifier */
  stage: "CX";
  /** Artifact ID */
  artifactId: string;
  /** Processing timestamp */
  processedAt: string;

  /** Consolidated entities (same type as RX, normalized) */
  entities: Entity[];
  /** Statements with updated cgIds (reflecting merges) */
  statements: Statement[];
  /** Evidence preserved from RX */
  evidence: Evidence[];

  /** Alias mappings for merged entities */
  aliases: AliasMapping[];

  /** Processing metadata */
  meta: {
    /** Entities after consolidation */
    entityCount: number;
    /** Entities merged (removed as duplicates) */
    mergedCount: number;
    /** Statements after cgId updates */
    statementCount: number;
    /** Normalizations applied */
    normalizations: Normalization[];
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

/**
 * CX Stage Input
 */
export interface CxStageInput {
  /** Artifact ID */
  artifactId: string;
  /** RX stage output to consolidate */
  rxOutput: RxStageOutput;
}

/**
 * CX Stage Options
 */
export interface CxStageOptions {
  /** Similarity threshold for merging (0-1) */
  mergeThreshold?: number;
  /** Whether to apply profile shape rules for kind inference */
  applyShapeRules?: boolean;
}

const DEFAULT_OPTIONS: Required<CxStageOptions> = {
  mergeThreshold: 0.75, // Lowered from 0.85 for better deduplication
  applyShapeRules: true,
};

// =============================================================================
// Name Normalization
// =============================================================================

/**
 * Generate a canonical key for entity matching (type-aware)
 * This is the foundation for improved deduplication
 */
function generateCanonicalKey(entity: Entity): string {
  const normalized = entity.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/-+/g, "-");

  return `${entity.type}:${normalized}`;
}

/**
 * Normalize an entity name for comparison
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Canonicalize an entity name (for display)
 */
function canonicalizeName(name: string): string {
  // Title case, collapse whitespace
  return name
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Calculate Levenshtein distance between two strings
 * More accurate than Jaccard for detecting typos and variants
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity between two strings (combined approach)
 * Uses both Jaccard and Levenshtein for better matching
 */
function calculateSimilarity(a: string, b: string): number {
  const normA = normalizeName(a);
  const normB = normalizeName(b);

  // Exact match
  if (normA === normB) return 1.0;

  // Jaccard similarity (word overlap)
  const setA = new Set(normA.split(" "));
  const setB = new Set(normB.split(" "));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  const jaccard = union.size === 0 ? 0 : intersection.size / union.size;

  // Levenshtein similarity (character-level)
  const maxLen = Math.max(normA.length, normB.length);
  const distance = levenshteinDistance(normA, normB);
  const levenshtein = maxLen === 0 ? 0 : 1 - distance / maxLen;

  // Combined score (weighted average: 60% Jaccard, 40% Levenshtein)
  // Jaccard is better for word-based variants, Levenshtein for typos
  return jaccard * 0.6 + levenshtein * 0.4;
}

// =============================================================================
// Entity Merging
// =============================================================================

/**
 * Find merge candidate for an entity
 * Enhanced with canonical key matching and multi-stage similarity
 */
function findMergeCandidate(
  entity: Entity,
  existing: Entity[],
  threshold: number,
): { target: Entity; similarity: number; matchType: string } | null {
  // Stage 1: Exact canonical key match (type-aware)
  const canonicalKey = generateCanonicalKey(entity);
  for (const e of existing) {
    if (generateCanonicalKey(e) === canonicalKey) {
      return { target: e, similarity: 1.0, matchType: "canonical-key" };
    }
  }

  // Stage 2: Type-constrained similarity matching
  // Only compare entities of the same type to avoid false positives
  const sameTypeEntities = existing.filter((e) => e.type === entity.type);

  for (const e of sameTypeEntities) {
    const similarity = calculateSimilarity(e.name, entity.name);
    if (similarity >= threshold) {
      return { target: e, similarity, matchType: "name-similarity" };
    }

    // Also check against aliases
    for (const alias of e.aliases ?? []) {
      const aliasSimilarity = calculateSimilarity(alias, entity.name);
      if (aliasSimilarity >= threshold) {
        return {
          target: e,
          similarity: aliasSimilarity,
          matchType: "alias-match",
        };
      }
    }
  }

  // Stage 3: Relaxed similarity for short names (3 chars or less)
  // Short names need higher similarity to avoid false positives
  if (entity.name.length <= 3) {
    const relaxedThreshold = 0.95; // Very high threshold for short names
    for (const e of sameTypeEntities) {
      const similarity = calculateSimilarity(e.name, entity.name);
      if (similarity >= relaxedThreshold) {
        return { target: e, similarity, matchType: "short-name-match" };
      }
    }
  }

  return null;
}

/**
 * Merge two entities together (primary absorbs secondary)
 * Enhanced with better confidence calculation and alias tracking
 */
function mergeEntities(primary: Entity, secondary: Entity): Entity {
  // Combine aliases intelligently
  const allAliases = [
    ...(primary.aliases ?? []),
    // Add secondary name as alias if different from primary
    ...(normalizeName(primary.name) !== normalizeName(secondary.name)
      ? [secondary.name]
      : []),
    ...(secondary.aliases ?? []),
  ];

  // Deduplicate aliases (case-insensitive)
  const uniqueAliases = Array.from(
    new Map(allAliases.map((alias) => [normalizeName(alias), alias])).values(),
  ).filter((alias) => normalizeName(alias) !== normalizeName(primary.name));

  // Combine evidence
  const evidence = [...primary.evidence, ...secondary.evidence];

  // Weighted confidence (favor higher confidence, weighted by evidence count)
  const totalEvidence = evidence.length;
  const primaryWeight = primary.evidence.length / totalEvidence;
  const secondaryWeight = secondary.evidence.length / totalEvidence;
  const weightedConfidence =
    primary.confidence * primaryWeight + secondary.confidence * secondaryWeight;

  // Merge props (primary takes precedence for conflicts)
  const props = {
    ...(secondary.props ?? {}),
    ...(primary.props ?? {}),
    // Track merge count
    mergeCount: ((primary.props?.mergeCount as number) ?? 0) + 1,
    // Track all merged names for debugging
    mergedFrom: [
      ...((primary.props?.mergedFrom as string[]) ?? []),
      secondary.name,
    ],
  };

  return {
    ...primary,
    aliases: uniqueAliases,
    evidence,
    confidence: Math.min(1.0, weightedConfidence), // Cap at 1.0
    props,
    state: "merged",
  };
}

// =============================================================================
// Shape Inference
// =============================================================================

/**
 * Infer entity kind from statement participation
 * This is the spec-compliant way to determine kinds (shape-based)
 */
function inferKindFromStatements(
  entity: Entity,
  statements: Statement[],
  profile: PipelineContext["profile"],
): string | null {
  // Find statements where this entity participates
  const asSubject = statements.filter((s) => s.subjectCgId === entity.cgId);
  const asObject = statements.filter((s) => s.objectCgId === entity.cgId);

  // Apply profile shape rules
  for (const rule of profile.shapes) {
    const participatesInPredicate = (predicates: string[]) =>
      predicates.some(
        (p) =>
          asSubject.some((s) => s.predicate === p) ||
          asObject.some((s) => s.predicate === p),
      );

    if (!participatesInPredicate(rule.participatesIn)) continue;

    // Check position constraint
    if (rule.position === "subject") {
      if (!asSubject.some((s) => rule.participatesIn.includes(s.predicate)))
        continue;
    } else if (rule.position === "object") {
      if (!asObject.some((s) => rule.participatesIn.includes(s.predicate)))
        continue;
    }

    return rule.inferredKind;
  }

  return null;
}

// =============================================================================
// CX Stage Entry Point
// =============================================================================

/**
 * Run CX stage on RX output
 *
 * Consolidates entities and statements while preserving graph shape.
 */
export async function runCxStage(
  input: CxStageInput,
  ctx: PipelineContext,
  options: CxStageOptions = {},
): Promise<CxStageOutput> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const { artifactId, rxOutput } = input;
  const {
    entities: rxEntities,
    statements: rxStatements,
    evidence: rxEvidence,
  } = rxOutput;

  // Track normalizations and aliases
  const normalizations: Normalization[] = [];
  const aliases: AliasMapping[] = [];

  // Map from old cgId to new cgId (for merged entities)
  const cgIdRemap = new Map<string, string>();

  // Consolidated entities
  const consolidatedEntities: Entity[] = [];

  // Process each entity
  for (const entity of rxEntities) {
    // Find merge candidate with enhanced matching
    const mergeCandidate = findMergeCandidate(
      entity,
      consolidatedEntities,
      opts.mergeThreshold,
    );

    if (mergeCandidate) {
      // Merge into existing entity
      const { target, similarity, matchType } = mergeCandidate;
      const mergedIdx = consolidatedEntities.indexOf(target);
      consolidatedEntities[mergedIdx] = mergeEntities(target, entity);

      // Record cgId remapping
      cgIdRemap.set(entity.cgId, target.cgId);

      // Record alias with match type
      aliases.push({
        originalCgId: entity.cgId,
        originalName: entity.name,
        canonicalCgId: target.cgId,
        canonicalName: target.name,
        similarity,
      });

      normalizations.push({
        cgId: entity.cgId,
        type: "merge",
        from: entity.name,
        to: target.name,
        reason: `Merged via ${matchType} (similarity: ${similarity.toFixed(3)})`,
      });
    } else {
      // Add as new entity (potentially with normalized name)
      const normalizedName = canonicalizeName(entity.name);

      if (normalizedName !== entity.name) {
        normalizations.push({
          cgId: entity.cgId,
          type: "name",
          from: entity.name,
          to: normalizedName,
          reason: "Name canonicalization",
        });
      }

      consolidatedEntities.push({
        ...entity,
        name: normalizedName,
      });
    }
  }

  // Apply shape inference for kind
  if (opts.applyShapeRules) {
    for (const entity of consolidatedEntities) {
      const inferredKind = inferKindFromStatements(
        entity,
        rxStatements,
        ctx.profile,
      );
      if (inferredKind && entity.type !== inferredKind) {
        normalizations.push({
          cgId: entity.cgId,
          type: "kind",
          from: entity.type,
          to: inferredKind,
          reason: `Inferred from statement participation`,
        });
        // Note: We don't actually change entity.type here as it's a union type
        // Instead, we could store inferredKind in props for downstream use
        entity.props = {
          ...entity.props,
          inferredKind,
        };
      }
    }
  }

  // Update statements with remapped cgIds (from entity merging)
  // Note: Reference resolution (mismatched cgIds) is now handled by REF stage
  const consolidatedStatements: Statement[] = rxStatements.map((stmt) => ({
    ...stmt,
    subjectCgId: cgIdRemap.get(stmt.subjectCgId) ?? stmt.subjectCgId,
    objectCgId: stmt.objectCgId
      ? (cgIdRemap.get(stmt.objectCgId) ?? stmt.objectCgId)
      : null,
  }));

  const processingTimeMs = Date.now() - startTime;

  const output: CxStageOutput = {
    $schema: "intentweave://schemas/cx-graph/v1",
    schemaVersion: "0.1",
    stage: "CX",
    artifactId,
    processedAt: ctx.timestamp(),
    entities: consolidatedEntities,
    statements: consolidatedStatements,
    evidence: rxEvidence,
    aliases,
    meta: {
      entityCount: consolidatedEntities.length,
      mergedCount: aliases.length,
      statementCount: consolidatedStatements.length,
      normalizations,
      processingTimeMs,
    },
  };

  ctx.logger.debug(`CX stage complete for ${artifactId}`, {
    entities: consolidatedEntities.length,
    merged: aliases.length,
    statements: consolidatedStatements.length,
  });

  return output;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get consolidated entities from CX output
 */
export function getEntities(cxOutput: CxStageOutput): Entity[] {
  return cxOutput.entities;
}

/**
 * Get statements from CX output
 */
export function getStatements(cxOutput: CxStageOutput): Statement[] {
  return cxOutput.statements;
}

/**
 * Get alias mappings for reference resolution
 */
export function getAliasMap(cxOutput: CxStageOutput): Map<string, string> {
  const map = new Map<string, string>();
  for (const alias of cxOutput.aliases) {
    map.set(alias.originalCgId, alias.canonicalCgId);
  }
  return map;
}

/**
 * Resolve a cgId through alias chain
 */
export function resolveCgId(cgId: string, cxOutput: CxStageOutput): string {
  const aliasMap = getAliasMap(cxOutput);
  let resolved = cgId;
  // Follow alias chain (max 10 hops to prevent infinite loops)
  for (let i = 0; i < 10 && aliasMap.has(resolved); i++) {
    resolved = aliasMap.get(resolved)!;
  }
  return resolved;
}
