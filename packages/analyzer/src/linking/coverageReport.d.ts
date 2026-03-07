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
import type { Entity, Statement, LinkProposal, LinkPredicate, ArtifactRole } from '@intentweave/core';
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
    type: 'semantic-drift' | 'stale-link' | 'conflicting-definition';
    /** Severity level */
    severity: 'warning' | 'error';
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
    type: 'missing-implementation' | 'missing-spec' | 'missing-test' | 'orphan-impl';
    /** Severity level */
    severity: 'info' | 'warning';
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
    $schema: 'intentweave://schemas/coverage-report/v1';
    /** Schema version */
    schemaVersion: '0.1';
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
    entities: Array<Entity & {
        artifactId: string;
        artifactRole: ArtifactRole;
    }>;
    /** All statements with their artifact IDs */
    statements: Array<Statement & {
        artifactId: string;
        artifactRole: ArtifactRole;
    }>;
    /** LX link proposals */
    linkProposals: LinkProposal[];
    /** Artifact metadata */
    artifacts: Array<{
        artifactId: string;
        artifactRole: ArtifactRole;
    }>;
}
/**
 * Generate a comprehensive coverage report
 */
export declare function generateCoverageReport(input: CoverageReportInput, options: CoverageReportOptions): CoverageReport;
/**
 * Create an empty coverage report
 */
export declare function createEmptyCoverageReport(runId: string, workspaceKey: string): CoverageReport;
/**
 * Summarize coverage report for logging
 */
export declare function summarizeCoverageReport(report: CoverageReport): string;
//# sourceMappingURL=coverageReport.d.ts.map