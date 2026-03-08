// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * PX Stage - Presentation (Core)
 *
 * Per-artifact stage that applies filtering and prepares for output.
 *
 * Input: mx.json (entities/statements with materializations)
 * Output: px.json (filtered entities/statements ready for aggregation)
 *
 * Responsibilities (SPEC-COMPLIANT):
 * - Apply confidence-based filtering (noise reduction)
 * - Apply profile-based filtering rules
 * - Infer artifact role from file path
 * - Track filter decisions for transparency
 *
 * NOTE: PX does NOT do semantic diffing (per Gap Analysis).
 * Noise reduction = confidence-based + profile-based filtering only.
 */

import type { PipelineContext } from "../pipeline/context.js";
import type { Entity, Statement, Evidence } from "@intentweave/core";
import type { MxStageOutput } from "./mx.js";
import { inferArtifactRole } from "../profiles/loader.js";
import { getAllEntities, getAllStatements, getOrphanIds } from "./mx.js";

// =============================================================================
// PX Stage Types
// =============================================================================

/**
 * Filter decision record for transparency
 */
export interface FilterDecision {
  /** Entity or statement cgId */
  id: string;
  /** What was filtered */
  type: "entity" | "statement";
  /** Why it was filtered */
  reason: "low-confidence" | "size-limit" | "excluded-kind" | "excluded-role";
  /** The confidence score (if applicable) */
  confidence?: number;
  /** The threshold used (if applicable) */
  threshold?: number;
  /** Additional context */
  context?: string;
}

/**
 * PX Stage Output (spec-compliant: filtered graph)
 */
export interface PxStageOutput {
  /** JSON Schema reference */
  $schema: string;
  /** Schema version */
  schemaVersion: "0.1";
  /** Stage identifier */
  stage: "PX";
  /** Artifact ID */
  artifactId: string;
  /** Processing timestamp */
  processedAt: string;

  /** Inferred artifact role */
  artifactRole: string;

  /** Filtered entities (presentation-ready) */
  entities: Entity[];
  /** Filtered statements */
  statements: Statement[];
  /** Evidence preserved */
  evidence: Evidence[];

  /** IDs of orphan entities (not in transitions) */
  orphanEntityIds: string[];

  /** Filter decisions for transparency */
  filterDecisions: FilterDecision[];

  /** Processing metadata */
  meta: {
    /** Entities included */
    includedEntityCount: number;
    /** Entities filtered out */
    filteredEntityCount: number;
    /** Statements included */
    includedStatementCount: number;
    /** Statements filtered out */
    filteredStatementCount: number;
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

/**
 * PX Stage Input
 */
export interface PxStageInput {
  /** Artifact ID */
  artifactId: string;
  /** File path for role inference */
  filePath: string;
  /** MX stage output to filter */
  mxOutput: MxStageOutput;
  /** Artifact role from IN stage (takes precedence over profile inference) */
  artifactRole?: string;
}

/**
 * PX Stage Options
 */
export interface PxStageOptions {
  /** Minimum confidence for including entities */
  minEntityConfidence?: number;
  /** Minimum confidence for including statements */
  minStatementConfidence?: number;
  /** Whether to apply profile filtering rules */
  applyProfileFilters?: boolean;
  /** Whether to record filter decisions */
  recordFilterDecisions?: boolean;
  /** Maximum entities to include */
  maxEntities?: number;
  /** Maximum statements to include */
  maxStatements?: number;
}

const DEFAULT_OPTIONS: Required<PxStageOptions> = {
  minEntityConfidence: 0.5,
  minStatementConfidence: 0.5,
  applyProfileFilters: true,
  recordFilterDecisions: true,
  maxEntities: 500,
  maxStatements: 1000,
};

// =============================================================================
// Filtering Logic
// =============================================================================

/**
 * Check if entity kind is included by profile
 */
function isKindIncluded(
  kind: string,
  profile: PipelineContext["profile"],
): boolean {
  const includeKinds = profile.px?.includeKinds;
  const excludeKinds = profile.px?.excludeKinds;

  if (includeKinds && includeKinds.length > 0) {
    return includeKinds.includes(kind);
  }

  if (excludeKinds && excludeKinds.length > 0) {
    return !excludeKinds.includes(kind);
  }

  return true;
}

/**
 * Check if artifact role should be processed
 */
function isRoleIncluded(
  role: string | undefined,
  profile: PipelineContext["profile"],
): boolean {
  // If role is undefined, include by default
  if (!role) return true;

  const includeRoles = profile.px?.includeRoles;
  const excludeRoles = profile.px?.excludeRoles;

  if (includeRoles && includeRoles.length > 0) {
    return includeRoles.includes(role);
  }

  if (excludeRoles && excludeRoles.length > 0) {
    return !excludeRoles.includes(role);
  }

  return true;
}

/**
 * Filter entities based on options and profile
 */
function filterEntities(
  entities: Entity[],
  opts: Required<PxStageOptions>,
  profile: PipelineContext["profile"],
): { included: Entity[]; decisions: FilterDecision[] } {
  const included: Entity[] = [];
  const decisions: FilterDecision[] = [];

  for (const entity of entities) {
    // Check confidence
    if (entity.confidence < opts.minEntityConfidence) {
      if (opts.recordFilterDecisions) {
        decisions.push({
          id: entity.cgId,
          type: "entity",
          reason: "low-confidence",
          confidence: entity.confidence,
          threshold: opts.minEntityConfidence,
        });
      }
      continue;
    }

    // Check profile kind filter
    if (opts.applyProfileFilters && !isKindIncluded(entity.type, profile)) {
      if (opts.recordFilterDecisions) {
        decisions.push({
          id: entity.cgId,
          type: "entity",
          reason: "excluded-kind",
          context: `Kind '${entity.type}' excluded by profile`,
        });
      }
      continue;
    }

    included.push(entity);
  }

  // Apply size limit
  if (included.length > opts.maxEntities) {
    // Sort by confidence descending, keep top N
    included.sort((a, b) => b.confidence - a.confidence);
    const removed = included.splice(opts.maxEntities);

    if (opts.recordFilterDecisions) {
      for (const entity of removed) {
        decisions.push({
          id: entity.cgId,
          type: "entity",
          reason: "size-limit",
          confidence: entity.confidence,
          context: `Exceeded max entities (${opts.maxEntities})`,
        });
      }
    }
  }

  return { included, decisions };
}

/**
 * Filter statements based on options
 */
function filterStatements(
  statements: Statement[],
  includedEntityIds: Set<string>,
  opts: Required<PxStageOptions>,
): { included: Statement[]; decisions: FilterDecision[] } {
  const included: Statement[] = [];
  const decisions: FilterDecision[] = [];

  for (const stmt of statements) {
    // Check confidence
    if (stmt.confidence < opts.minStatementConfidence) {
      if (opts.recordFilterDecisions) {
        decisions.push({
          id:
            stmt.id ??
            `${stmt.subjectCgId}-${stmt.predicate}-${stmt.objectCgId}`,
          type: "statement",
          reason: "low-confidence",
          confidence: stmt.confidence,
          threshold: opts.minStatementConfidence,
        });
      }
      continue;
    }

    // Only include statements where both entities are included
    const subjectIncluded = includedEntityIds.has(stmt.subjectCgId);
    const objectIncluded =
      !stmt.objectCgId || includedEntityIds.has(stmt.objectCgId);

    if (!subjectIncluded || !objectIncluded) {
      // Don't record this as a decision - it's a consequence of entity filtering
      continue;
    }

    included.push(stmt);
  }

  // Apply size limit
  if (included.length > opts.maxStatements) {
    included.sort((a, b) => b.confidence - a.confidence);
    const removed = included.splice(opts.maxStatements);

    if (opts.recordFilterDecisions) {
      for (const stmt of removed) {
        decisions.push({
          id:
            stmt.id ??
            `${stmt.subjectCgId}-${stmt.predicate}-${stmt.objectCgId}`,
          type: "statement",
          reason: "size-limit",
          confidence: stmt.confidence,
          context: `Exceeded max statements (${opts.maxStatements})`,
        });
      }
    }
  }

  return { included, decisions };
}

// =============================================================================
// PX Stage Entry Point
// =============================================================================

/**
 * Run PX stage on MX output
 *
 * Filters and prepares the graph for presentation/aggregation.
 */
export async function runPxStage(
  input: PxStageInput,
  ctx: PipelineContext,
  options: PxStageOptions = {},
): Promise<PxStageOutput> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const { artifactId, filePath, mxOutput } = input;
  const mxEntities = getAllEntities(mxOutput);
  const mxStatements = getAllStatements(mxOutput);

  // Use input artifact role (from IN stage) if provided, otherwise infer from profile
  const artifactRole =
    input.artifactRole ?? inferArtifactRole(filePath, ctx.profile);

  // Check if entire artifact should be skipped
  if (opts.applyProfileFilters && !isRoleIncluded(artifactRole, ctx.profile)) {
    const processingTimeMs = Date.now() - startTime;

    return {
      $schema: "intentweave://schemas/px-graph/v1",
      schemaVersion: "0.1",
      stage: "PX",
      artifactId,
      processedAt: ctx.timestamp(),
      artifactRole: artifactRole ?? "unknown",
      entities: [],
      statements: [],
      evidence: [],
      orphanEntityIds: [],
      filterDecisions: [
        {
          id: artifactId,
          type: "entity",
          reason: "excluded-role",
          context: `Artifact role '${artifactRole}' excluded by profile`,
        },
      ],
      meta: {
        includedEntityCount: 0,
        filteredEntityCount: mxEntities.length,
        includedStatementCount: 0,
        filteredStatementCount: mxStatements.length,
        processingTimeMs,
      },
    };
  }

  // Filter entities
  const { included: includedEntities, decisions: entityDecisions } =
    filterEntities(mxEntities, opts, ctx.profile);

  // Build set of included entity IDs
  const includedEntityIds = new Set(includedEntities.map((e) => e.cgId));

  // Filter statements
  const { included: includedStatements, decisions: statementDecisions } =
    filterStatements(mxStatements, includedEntityIds, opts);

  // Update orphan list (only include orphans that made it through filtering)
  const mxOrphans = getOrphanIds(mxOutput);
  const orphanEntityIds = mxOrphans.filter((id) => includedEntityIds.has(id));

  const filterDecisions = [...entityDecisions, ...statementDecisions];
  const processingTimeMs = Date.now() - startTime;

  const output: PxStageOutput = {
    $schema: "intentweave://schemas/px-graph/v1",
    schemaVersion: "0.1",
    stage: "PX",
    artifactId,
    processedAt: ctx.timestamp(),
    artifactRole: artifactRole ?? "unknown",
    entities: includedEntities,
    statements: includedStatements,
    evidence: mxOutput.evidence,
    orphanEntityIds,
    filterDecisions,
    meta: {
      includedEntityCount: includedEntities.length,
      filteredEntityCount: mxEntities.length - includedEntities.length,
      includedStatementCount: includedStatements.length,
      filteredStatementCount: mxStatements.length - includedStatements.length,
      processingTimeMs,
    },
  };

  ctx.logger.debug(`PX stage complete for ${artifactId}`, {
    role: artifactRole,
    entities: includedEntities.length,
    filtered: mxEntities.length - includedEntities.length,
    statements: includedStatements.length,
  });

  return output;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get filtered entities from PX output
 */
export function getFilteredEntities(pxOutput: PxStageOutput): Entity[] {
  return pxOutput.entities;
}

/**
 * Get filtered statements from PX output
 */
export function getFilteredStatements(pxOutput: PxStageOutput): Statement[] {
  return pxOutput.statements;
}

/**
 * Get artifact role from PX output
 */
export function getArtifactRole(pxOutput: PxStageOutput): string {
  return pxOutput.artifactRole;
}
