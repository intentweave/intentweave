// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file Coverage Report Generation
 * @description Generates detailed coverage reports for cross-artifact linking
 *
 * This module computes traceability metrics including:
 * - spec→impl coverage (how many specifications have implementations)
 * - prompt→spec coverage (how many prompts have specifications)
 * - Inconsistency detection (semantic drift between artifacts)
 * - Incompleteness detection (missing implementations)
 *
 * @packageDocumentation
 */

import type {
  Entity,
  Statement,
  LinkProposal,
  LinkPredicate,
  ArtifactRole,
} from "@intentweave/core";

// =============================================================================
// Types
// =============================================================================

/**
 * Coverage metrics for a specific role transition
 */
export interface RoleTransitionCoverage {
  /** Source role (e.g., 'spec') */
  sourceRole: ArtifactRole;
  /** Target role (e.g., 'impl') */
  targetRole: ArtifactRole;
  /** Predicate for this transition (e.g., 'IMPLEMENTS') */
  predicate: LinkPredicate;
  /** Total source entities */
  sourceCount: number;
  /** Linked source entities (have at least one link) */
  linkedCount: number;
  /** Coverage percentage (0-100) */
  coveragePercent: number;
  /** Unlinked source entities */
  unlinkedEntities: string[];
  /** Average confidence of links */
  avgConfidence: number;
}

/**
 * Inconsistency finding - semantic drift between linked artifacts
 */
export interface InconsistencyFinding {
  /** Unique finding ID */
  id: string;
  /** Type of inconsistency */
  type: "semantic-drift" | "stale-link" | "conflicting-definition";
  /** Severity level */
  severity: "warning" | "error";
  /** Source entity cgId */
  sourceCgId: string;
  /** Target entity cgId */
  targetCgId: string;
  /** Description of the inconsistency */
  message: string;
  /** Confidence that this is a real issue (0-1) */
  confidence: number;
  /** Suggested action */
  suggestion?: string;
}

/**
 * Incompleteness finding - missing implementations
 */
export interface IncompletenessFinding {
  /** Unique finding ID */
  id: string;
  /** Type of incompleteness */
  type:
    | "missing-implementation"
    | "missing-spec"
    | "missing-test"
    | "orphan-impl";
  /** Severity level */
  severity: "info" | "warning";
  /** Entity cgId that is incomplete */
  entityCgId: string;
  /** Entity name for display */
  entityName: string;
  /** Artifact ID containing the entity */
  artifactId: string;
  /** Expected target role */
  expectedRole: ArtifactRole;
  /** Description */
  message: string;
}

/**
 * Complete coverage report
 */
export interface CoverageReport {
  /** Schema identifier */
  $schema: "intentweave://schemas/coverage-report/v1";
  /** Schema version */
  schemaVersion: "0.1";
  /** Run ID */
  runId: string;
  /** Workspace key */
  workspaceKey: string;

  /** Summary metrics */
  summary: {
    /** Total entities across all artifacts */
    totalEntities: number;
    /** Total link proposals */
    totalLinks: number;
    /** Accepted link proposals */
    acceptedLinks: number;
    /** Overall traceability score (0-100) */
    traceabilityScore: number;
    /** Entities with at least one cross-artifact link */
    linkedEntityCount: number;
    /** Percentage of entities with links */
    linkedEntityPercent: number;
  };

  /** Role transition coverage */
  roleTransitions: RoleTransitionCoverage[];

  /** Detected inconsistencies */
  inconsistencies: InconsistencyFinding[];

  /** Detected incompletenesses */
  incompletenesses: IncompletenessFinding[];

  /** Per-artifact breakdown */
  artifacts: Array<{
    artifactId: string;
    artifactRole: ArtifactRole;
    entityCount: number;
    linkedCount: number;
    incomingLinks: number;
    outgoingLinks: number;
  }>;
}

/**
 * Options for coverage report generation
 */
export interface CoverageReportOptions {
  /** Run ID */
  runId: string;
  /** Workspace key */
  workspaceKey: string;
  /** Minimum confidence to count as linked */
  minLinkConfidence?: number;
  /** Whether to detect inconsistencies */
  detectInconsistencies?: boolean;
  /** Whether to detect incompletenesses */
  detectIncompletenesses?: boolean;
}

/**
 * Input for coverage report generation
 */
export interface CoverageReportInput {
  /** All entities with their artifact IDs */
  entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>;
  /** All statements with their artifact IDs */
  statements: Array<
    Statement & { artifactId: string; artifactRole: ArtifactRole }
  >;
  /** LX link proposals */
  linkProposals: LinkProposal[];
  /** Artifact metadata */
  artifacts: Array<{
    artifactId: string;
    artifactRole: ArtifactRole;
  }>;
}

// =============================================================================
// Role Transition Definitions
// =============================================================================

/**
 * Expected role transitions for traceability.
 *
 * Valid ArtifactRoles: 'intent' | 'spec' | 'code' | 'test' | 'doc' | 'config'
 */
const ROLE_TRANSITIONS: Array<{
  source: ArtifactRole;
  target: ArtifactRole;
  predicate: LinkPredicate;
  required: boolean;
}> = [
  { source: "intent", target: "spec", predicate: "REFINES", required: true },
  { source: "spec", target: "code", predicate: "IMPLEMENTS", required: true },
  { source: "code", target: "test", predicate: "MAPS_TO", required: false },
  { source: "spec", target: "doc", predicate: "DESCRIBES", required: false },
  { source: "spec", target: "test", predicate: "MAPS_TO", required: false },
];

// =============================================================================
// Main Export
// =============================================================================

/**
 * Generate a comprehensive coverage report
 */
export function generateCoverageReport(
  input: CoverageReportInput,
  options: CoverageReportOptions,
): CoverageReport {
  const { entities, statements, linkProposals, artifacts } = input;

  const {
    runId,
    workspaceKey,
    minLinkConfidence = 0.5,
    detectInconsistencies = true,
    detectIncompletenesses = true,
  } = options;

  // Filter to confident links
  const confidentLinks = linkProposals.filter(
    (l) => l.confidence >= minLinkConfidence,
  );

  // Build entity lookup
  const entityById = new Map<
    string,
    Entity & { artifactId: string; artifactRole: ArtifactRole }
  >();
  for (const e of entities) {
    entityById.set(e.cgId, e);
  }

  // Build artifact lookup
  const artifactRoles = new Map<string, ArtifactRole>();
  for (const a of artifacts) {
    artifactRoles.set(a.artifactId, a.artifactRole);
  }

  // Calculate role transition coverage
  const roleTransitions = calculateRoleTransitionCoverage(
    entities,
    confidentLinks,
    artifactRoles,
  );

  // Detect inconsistencies
  const inconsistencies = detectInconsistencies
    ? detectSemanticInconsistencies(
        entities,
        statements,
        confidentLinks,
        entityById,
      )
    : [];

  // Detect incompletenesses
  const incompletenesses = detectIncompletenesses
    ? detectMissingImplementations(entities, confidentLinks, artifactRoles)
    : [];

  // Calculate per-artifact metrics
  const artifactMetrics = calculateArtifactMetrics(
    entities,
    confidentLinks,
    artifacts,
  );

  // Calculate summary
  const linkedEntityIds = new Set<string>();
  for (const link of confidentLinks) {
    linkedEntityIds.add(link.sourceCgId);
    linkedEntityIds.add(link.targetCgId);
  }

  const acceptedLinks = confidentLinks.filter((l) => l.accepted !== false);

  // Calculate traceability score
  const traceabilityScore = calculateTraceabilityScore(
    roleTransitions,
    entities.length,
    linkedEntityIds.size,
  );

  return {
    $schema: "intentweave://schemas/coverage-report/v1",
    schemaVersion: "0.1",
    runId,
    workspaceKey,
    summary: {
      totalEntities: entities.length,
      totalLinks: confidentLinks.length,
      acceptedLinks: acceptedLinks.length,
      traceabilityScore,
      linkedEntityCount: linkedEntityIds.size,
      linkedEntityPercent:
        entities.length > 0
          ? Math.round((linkedEntityIds.size / entities.length) * 100)
          : 0,
    },
    roleTransitions,
    inconsistencies,
    incompletenesses,
    artifacts: artifactMetrics,
  };
}

// =============================================================================
// Role Transition Coverage
// =============================================================================

/**
 * Calculate coverage for each role transition
 */
function calculateRoleTransitionCoverage(
  entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>,
  links: LinkProposal[],
  artifactRoles: Map<string, ArtifactRole>,
): RoleTransitionCoverage[] {
  const result: RoleTransitionCoverage[] = [];

  for (const transition of ROLE_TRANSITIONS) {
    // Get source entities for this transition
    const sourceEntities = entities.filter(
      (e) => e.artifactRole === transition.source,
    );

    if (sourceEntities.length === 0) {
      continue; // Skip if no source entities
    }

    // Find links matching this transition
    const matchingLinks = links.filter((link) => {
      const sourceArtifactRole = artifactRoles.get(link.sourceArtifact);
      const targetArtifactRole = artifactRoles.get(link.targetArtifact);
      return (
        sourceArtifactRole === transition.source &&
        targetArtifactRole === transition.target &&
        link.predicate === transition.predicate
      );
    });

    // Count linked source entities
    const linkedSourceIds = new Set(matchingLinks.map((l) => l.sourceCgId));
    const linkedCount = sourceEntities.filter((e) =>
      linkedSourceIds.has(e.cgId),
    ).length;

    // Find unlinked entities
    const unlinkedEntities = sourceEntities
      .filter((e) => !linkedSourceIds.has(e.cgId))
      .map((e) => e.cgId);

    // Calculate average confidence
    const avgConfidence =
      matchingLinks.length > 0
        ? matchingLinks.reduce((sum, l) => sum + l.confidence, 0) /
          matchingLinks.length
        : 0;

    result.push({
      sourceRole: transition.source,
      targetRole: transition.target,
      predicate: transition.predicate,
      sourceCount: sourceEntities.length,
      linkedCount,
      coveragePercent: Math.round((linkedCount / sourceEntities.length) * 100),
      unlinkedEntities,
      avgConfidence,
    });
  }

  return result;
}

// =============================================================================
// Inconsistency Detection
// =============================================================================

/**
 * Detect semantic inconsistencies between linked artifacts
 */
function detectSemanticInconsistencies(
  entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>,
  statements: Array<
    Statement & { artifactId: string; artifactRole: ArtifactRole }
  >,
  links: LinkProposal[],
  entityById: Map<
    string,
    Entity & { artifactId: string; artifactRole: ArtifactRole }
  >,
): InconsistencyFinding[] {
  const findings: InconsistencyFinding[] = [];
  let findingId = 0;

  // Check for conflicting definitions in linked entities
  for (const link of links) {
    const source = entityById.get(link.sourceCgId);
    const target = entityById.get(link.targetCgId);

    if (!source || !target) continue;

    // Check for type mismatch (semantic drift)
    if (source.type !== target.type) {
      // Different types might indicate semantic drift
      // Only flag if confidence is high (should be same concept)
      if (link.confidence >= 0.9) {
        findings.push({
          id: `inconsistency-${++findingId}`,
          type: "semantic-drift",
          severity: "warning",
          sourceCgId: link.sourceCgId,
          targetCgId: link.targetCgId,
          message: `Linked entities have different types: ${source.type} vs ${target.type}`,
          confidence: link.confidence,
          suggestion: `Review if ${source.name} in ${source.artifactId} should match ${target.name} in ${target.artifactId}`,
        });
      }
    }

    // Check for stale links (low confidence on IMPLEMENTS)
    if (link.predicate === "IMPLEMENTS" && link.confidence < 0.7) {
      findings.push({
        id: `inconsistency-${++findingId}`,
        type: "stale-link",
        severity: "warning",
        sourceCgId: link.sourceCgId,
        targetCgId: link.targetCgId,
        message: `Implementation link has low confidence (${(link.confidence * 100).toFixed(0)}%)`,
        confidence: 1 - link.confidence,
        suggestion: `Verify that ${target.name} correctly implements ${source.name}`,
      });
    }
  }

  // Check for conflicting definitions (same name, different content)
  const entitiesByName = new Map<
    string,
    Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>
  >();
  for (const e of entities) {
    const normalized = e.name.toLowerCase().trim();
    if (!entitiesByName.has(normalized)) {
      entitiesByName.set(normalized, []);
    }
    entitiesByName.get(normalized)!.push(e);
  }

  for (const [name, sameNameEntities] of entitiesByName) {
    if (sameNameEntities.length > 1) {
      // Check if they are linked
      const cgIds = new Set(sameNameEntities.map((e) => e.cgId));
      const hasLink = links.some(
        (l) => cgIds.has(l.sourceCgId) && cgIds.has(l.targetCgId),
      );

      if (!hasLink) {
        // Same name but not linked - possible conflict
        const roles = [...new Set(sameNameEntities.map((e) => e.artifactRole))];
        if (roles.length > 1) {
          findings.push({
            id: `inconsistency-${++findingId}`,
            type: "conflicting-definition",
            severity: "warning",
            sourceCgId: sameNameEntities[0].cgId,
            targetCgId: sameNameEntities[1].cgId,
            message: `Multiple definitions of "${name}" across ${roles.join(", ")} artifacts without links`,
            confidence: 0.7,
            suggestion: `Review if these are the same concept and should be linked`,
          });
        }
      }
    }
  }

  return findings;
}

// =============================================================================
// Incompleteness Detection
// =============================================================================

/**
 * Detect missing implementations and other incompletenesses
 */
function detectMissingImplementations(
  entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>,
  links: LinkProposal[],
  artifactRoles: Map<string, ArtifactRole>,
): IncompletenessFinding[] {
  const findings: IncompletenessFinding[] = [];
  let findingId = 0;

  // Build set of linked entity IDs
  const linkedAsSource = new Set<string>();
  const linkedAsTarget = new Set<string>();
  for (const link of links) {
    linkedAsSource.add(link.sourceCgId);
    linkedAsTarget.add(link.targetCgId);
  }

  // Check spec entities without implementations
  // Valid roles: 'intent' | 'spec' | 'code' | 'test' | 'doc' | 'config'
  const specRoles: ArtifactRole[] = ["spec"];
  for (const entity of entities) {
    if (specRoles.includes(entity.artifactRole)) {
      // Check if this spec has an implementation link
      const hasImplLink = links.some(
        (l) => l.sourceCgId === entity.cgId && l.predicate === "IMPLEMENTS",
      );

      if (!hasImplLink) {
        findings.push({
          id: `incompleteness-${++findingId}`,
          type: "missing-implementation",
          severity: "warning",
          entityCgId: entity.cgId,
          entityName: entity.name,
          artifactId: entity.artifactId,
          expectedRole: "code",
          message: `Specification "${entity.name}" has no linked implementation`,
        });
      }
    }
  }

  // Check intent entities without specs
  const intentRoles: ArtifactRole[] = ["intent"];
  for (const entity of entities) {
    if (intentRoles.includes(entity.artifactRole)) {
      const hasSpecLink = links.some(
        (l) => l.sourceCgId === entity.cgId && l.predicate === "REFINES",
      );

      if (!hasSpecLink) {
        findings.push({
          id: `incompleteness-${++findingId}`,
          type: "missing-spec",
          severity: "info",
          entityCgId: entity.cgId,
          entityName: entity.name,
          artifactId: entity.artifactId,
          expectedRole: "spec",
          message: `Intent "${entity.name}" has no linked specification`,
        });
      }
    }
  }

  // Check code entities without specs (orphan implementations)
  const codeRoles: ArtifactRole[] = ["code"];
  for (const entity of entities) {
    if (codeRoles.includes(entity.artifactRole)) {
      const hasSpecLink = links.some(
        (l) => l.targetCgId === entity.cgId && l.predicate === "IMPLEMENTS",
      );

      if (!hasSpecLink) {
        findings.push({
          id: `incompleteness-${++findingId}`,
          type: "orphan-impl",
          severity: "info",
          entityCgId: entity.cgId,
          entityName: entity.name,
          artifactId: entity.artifactId,
          expectedRole: "spec",
          message: `Implementation "${entity.name}" has no linked specification`,
        });
      }
    }
  }

  return findings;
}

// =============================================================================
// Artifact Metrics
// =============================================================================

/**
 * Calculate per-artifact metrics
 */
function calculateArtifactMetrics(
  entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>,
  links: LinkProposal[],
  artifacts: Array<{ artifactId: string; artifactRole: ArtifactRole }>,
): CoverageReport["artifacts"] {
  return artifacts.map((artifact) => {
    const artifactEntities = entities.filter(
      (e) => e.artifactId === artifact.artifactId,
    );
    const entityIds = new Set(artifactEntities.map((e) => e.cgId));

    // Count entities with links
    const linkedIds = new Set<string>();
    let incomingLinks = 0;
    let outgoingLinks = 0;

    for (const link of links) {
      if (entityIds.has(link.sourceCgId)) {
        linkedIds.add(link.sourceCgId);
        outgoingLinks++;
      }
      if (entityIds.has(link.targetCgId)) {
        linkedIds.add(link.targetCgId);
        incomingLinks++;
      }
    }

    return {
      artifactId: artifact.artifactId,
      artifactRole: artifact.artifactRole,
      entityCount: artifactEntities.length,
      linkedCount: linkedIds.size,
      incomingLinks,
      outgoingLinks,
    };
  });
}

// =============================================================================
// Traceability Score
// =============================================================================

/**
 * Calculate overall traceability score (0-100)
 *
 * Factors:
 * - Role transition coverage (weighted by importance)
 * - Overall entity linkage percentage
 */
function calculateTraceabilityScore(
  roleTransitions: RoleTransitionCoverage[],
  totalEntities: number,
  linkedEntities: number,
): number {
  if (totalEntities === 0) return 100;

  // Weight required transitions higher
  let weightedSum = 0;
  let totalWeight = 0;

  for (const transition of roleTransitions) {
    const transitionDef = ROLE_TRANSITIONS.find(
      (t) =>
        t.source === transition.sourceRole &&
        t.target === transition.targetRole,
    );
    const weight = transitionDef?.required ? 2 : 1;
    weightedSum += transition.coveragePercent * weight;
    totalWeight += 100 * weight;
  }

  // If no transitions found, use entity linkage
  if (totalWeight === 0) {
    return Math.round((linkedEntities / totalEntities) * 100);
  }

  // Combine transition coverage (70%) with entity linkage (30%)
  const transitionScore = (weightedSum / totalWeight) * 100;
  const linkageScore = (linkedEntities / totalEntities) * 100;

  return Math.round(transitionScore * 0.7 + linkageScore * 0.3);
}

// =============================================================================
// Utility Exports
// =============================================================================

/**
 * Create an empty coverage report
 */
export function createEmptyCoverageReport(
  runId: string,
  workspaceKey: string,
): CoverageReport {
  return {
    $schema: "intentweave://schemas/coverage-report/v1",
    schemaVersion: "0.1",
    runId,
    workspaceKey,
    summary: {
      totalEntities: 0,
      totalLinks: 0,
      acceptedLinks: 0,
      traceabilityScore: 100,
      linkedEntityCount: 0,
      linkedEntityPercent: 0,
    },
    roleTransitions: [],
    inconsistencies: [],
    incompletenesses: [],
    artifacts: [],
  };
}

/**
 * Summarize coverage report for logging
 */
export function summarizeCoverageReport(report: CoverageReport): string {
  const lines = [
    `Coverage Report: ${report.summary.traceabilityScore}% traceability`,
    `  Entities: ${report.summary.linkedEntityCount}/${report.summary.totalEntities} linked (${report.summary.linkedEntityPercent}%)`,
    `  Links: ${report.summary.acceptedLinks}/${report.summary.totalLinks} accepted`,
  ];

  if (report.roleTransitions.length > 0) {
    lines.push("  Role Transitions:");
    for (const t of report.roleTransitions) {
      lines.push(
        `    ${t.sourceRole}→${t.targetRole}: ${t.coveragePercent}% (${t.linkedCount}/${t.sourceCount})`,
      );
    }
  }

  if (report.inconsistencies.length > 0) {
    lines.push(`  Inconsistencies: ${report.inconsistencies.length} found`);
  }

  if (report.incompletenesses.length > 0) {
    lines.push(`  Incompletenesses: ${report.incompletenesses.length} found`);
  }

  return lines.join("\n");
}
