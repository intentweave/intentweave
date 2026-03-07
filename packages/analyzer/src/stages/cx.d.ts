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
import type { PipelineContext } from '../pipeline/context.js';
import type { Entity, Statement, Evidence } from '@intentweave/core';
import type { RxStageOutput } from './rx.js';
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
    type: 'name' | 'kind' | 'merge';
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
    schemaVersion: '0.1';
    /** Stage identifier */
    stage: 'CX';
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
/**
 * Run CX stage on RX output
 *
 * Consolidates entities and statements while preserving graph shape.
 */
export declare function runCxStage(input: CxStageInput, ctx: PipelineContext, options?: CxStageOptions): Promise<CxStageOutput>;
/**
 * Get consolidated entities from CX output
 */
export declare function getEntities(cxOutput: CxStageOutput): Entity[];
/**
 * Get statements from CX output
 */
export declare function getStatements(cxOutput: CxStageOutput): Statement[];
/**
 * Get alias mappings for reference resolution
 */
export declare function getAliasMap(cxOutput: CxStageOutput): Map<string, string>;
/**
 * Resolve a cgId through alias chain
 */
export declare function resolveCgId(cgId: string, cxOutput: CxStageOutput): string;
//# sourceMappingURL=cx.d.ts.map