// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * MX Stage - Materialization (Core)
 *
 * Per-artifact stage that materializes domain-specific structures from the graph.
 *
 * Input: cx.json (consolidated entities/statements graph)
 * Output: mx.json (same graph + materialized transition entities)
 *
 * Responsibilities (SPEC-COMPLIANT):
 * - Materialize transition entities from TRANSITIONS_TO statements
 * - Create FROM_STATE/TO_STATE/TRIGGERS statements for transitions
 * - Bind guards and actions to transitions
 * - Preserve original entities/statements
 *
 * NOTE: MX is where domain-specific materialization happens.
 * It creates new entities (transitions) and statements (bindings).
 */
import type { PipelineContext } from "../pipeline/context.js";
import type { Entity, Statement, Evidence } from "@intentweave/core";
import type { CxStageOutput } from "./cx.js";
/**
 * MX Stage Output (spec-compliant: extends graph with materialized entities)
 */
export interface MxStageOutput {
  /** JSON Schema reference */
  $schema: string;
  /** Schema version */
  schemaVersion: "0.1";
  /** Stage identifier */
  stage: "MX";
  /** Artifact ID */
  artifactId: string;
  /** Processing timestamp */
  processedAt: string;
  /** All entities (original + materialized transitions) */
  entities: Entity[];
  /** All statements (original + transition bindings) */
  statements: Statement[];
  /** Evidence preserved */
  evidence: Evidence[];
  /** IDs of entities not bound to any transition */
  orphanEntityIds: string[];
  /** Processing metadata */
  meta: {
    /** Total entities after materialization */
    entityCount: number;
    /** Entities added by materialization */
    materializedCount: number;
    /** Statements after materialization */
    statementCount: number;
    /** Statements added by materialization */
    bindingCount: number;
    /** Orphan entities (not participating in transitions) */
    orphanCount: number;
    /** Processing time in ms */
    processingTimeMs: number;
  };
}
/**
 * MX Stage Input
 */
export interface MxStageInput {
  /** Artifact ID */
  artifactId: string;
  /** CX stage output to materialize */
  cxOutput: CxStageOutput;
}
/**
 * MX Stage Options
 */
export interface MxStageOptions {
  /** Minimum confidence for materializing a transition */
  minTransitionConfidence?: number;
  /** Whether to infer transitions from entity kinds */
  inferTransitions?: boolean;
  /** Whether to track orphan entities */
  trackOrphans?: boolean;
}
/**
 * Run MX stage on CX output
 *
 * Materializes domain-specific structures (transitions) from the graph.
 */
export declare function runMxStage(
  input: MxStageInput,
  ctx: PipelineContext,
  options?: MxStageOptions,
): Promise<MxStageOutput>;
/**
 * Get all entities from MX output
 */
export declare function getAllEntities(mxOutput: MxStageOutput): Entity[];
/**
 * Get transition entities only
 */
export declare function getTransitionEntities(
  mxOutput: MxStageOutput,
): Entity[];
/**
 * Get all statements from MX output
 */
export declare function getAllStatements(mxOutput: MxStageOutput): Statement[];
/**
 * Get orphan entity IDs
 */
export declare function getOrphanIds(mxOutput: MxStageOutput): string[];
//# sourceMappingURL=mx.d.ts.map
