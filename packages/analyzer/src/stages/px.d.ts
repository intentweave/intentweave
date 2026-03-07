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
import type { PipelineContext } from '../pipeline/context.js';
import type { Entity, Statement, Evidence } from '@intentweave/core';
import type { MxStageOutput } from './mx.js';
/**
 * Filter decision record for transparency
 */
export interface FilterDecision {
    /** Entity or statement cgId */
    id: string;
    /** What was filtered */
    type: 'entity' | 'statement';
    /** Why it was filtered */
    reason: 'low-confidence' | 'size-limit' | 'excluded-kind' | 'excluded-role';
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
    schemaVersion: '0.1';
    /** Stage identifier */
    stage: 'PX';
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
/**
 * Run PX stage on MX output
 *
 * Filters and prepares the graph for presentation/aggregation.
 */
export declare function runPxStage(input: PxStageInput, ctx: PipelineContext, options?: PxStageOptions): Promise<PxStageOutput>;
/**
 * Get filtered entities from PX output
 */
export declare function getFilteredEntities(pxOutput: PxStageOutput): Entity[];
/**
 * Get filtered statements from PX output
 */
export declare function getFilteredStatements(pxOutput: PxStageOutput): Statement[];
/**
 * Get artifact role from PX output
 */
export declare function getArtifactRole(pxOutput: PxStageOutput): string;
//# sourceMappingURL=px.d.ts.map