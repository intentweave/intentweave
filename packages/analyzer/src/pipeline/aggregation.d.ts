// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Aggregation Step (AGG-Prep)
 *
 * Per-run stage that combines outputs from all per-artifact stages.
 *
 * Input: All artifact px.json files
 * Output: aggregate/*.json files (lx.proposals.json, coverage.json, validation.json)
 *
 * Responsibilities:
 * - Merge all artifact PX outputs into unified entity/statement lists
 * - Generate LX proposals (cross-artifact linking candidates)
 * - Calculate coverage metrics
 * - Run validation checks
 * - Write to aggregate/ directory
 */
import type { PipelineContext } from "./context.js";
import type {
  Entity,
  Statement,
  LinkProposal,
  LxStageOutput,
} from "@intentweave/core";
import type { PxStageOutput } from "../stages/px.js";
import { type CoverageReport } from "../linking/coverageReport.js";
import { type ValidationOutput } from "../validation/coreRules.js";
/**
 * Validation finding
 */
export interface ValidationFinding {
  id: string;
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  entities?: string[];
}
/**
 * Coverage stage output
 */
export interface CoverageStageOutput {
  $schema: string;
  schemaVersion: string;
  stage: "Coverage";
  summary: {
    totalArtifacts: number;
    totalConcepts: number;
    totalTransitions: number;
    avgConfidence: number;
    kindCounts: Record<string, number>;
    roleCounts: Record<string, number>;
  };
  artifacts: Array<{
    artifactId: string;
    artifactRole: string;
    conceptCount: number;
    transitionCount: number;
    kindCounts: Record<string, number>;
    avgConfidence: number;
  }>;
}
/**
 * Findings stage output
 */
export interface FindingsStageOutput {
  $schema: string;
  schemaVersion: string;
  stage: "Validation";
  findings: ValidationFinding[];
  summary: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  };
}
/**
 * Aggregation Input
 */
export interface AggregationInput {
  /** Run ID */
  runId: string;
  /** All artifact PX outputs to aggregate */
  artifactOutputs: PxStageOutput[];
}
/**
 * Aggregation Options
 */
export interface AggregationOptions {
  /** Whether to generate LX proposals */
  generateLxProposals?: boolean;
  /** Whether to calculate coverage metrics */
  calculateCoverage?: boolean;
  /** Whether to run validation checks */
  runValidation?: boolean;
  /** Minimum similarity for cross-artifact linking proposals */
  lxSimilarityThreshold?: number;
}
/**
 * LX Proposal (cross-artifact linking candidate)
 */
export interface LxProposal {
  /** Proposal ID */
  id: string;
  /** Source concept ID */
  sourceId: string;
  /** Source artifact ID */
  sourceArtifact: string;
  /** Target concept ID */
  targetId: string;
  /** Target artifact ID */
  targetArtifact: string;
  /** Similarity score */
  similarity: number;
  /** Proposal type */
  type: "same-entity" | "related-entity" | "hierarchy";
  /** Proposal confidence */
  confidence: number;
}
/**
 * Aggregate output combining all artifacts
 */
export interface AggregateOutput {
  /** All entities from all artifacts */
  entities: Array<
    Entity & {
      artifactId: string;
    }
  >;
  /** All statements from all artifacts */
  statements: Array<
    Statement & {
      artifactId: string;
    }
  >;
  /** LX proposals for cross-artifact linking */
  lxProposals: LinkProposal[];
  /** LX stage output (if generated) */
  lxOutput?: LxStageOutput;
  /** Coverage metrics (simple summary) */
  coverage: CoverageStageOutput;
  /** Validation findings (simple summary) */
  findings: FindingsStageOutput;
  /** Rich coverage report from coverageReport module (for file output) */
  coverageReport?: CoverageReport;
  /** Rich validation output from coreRules module (for file output) */
  validationOutput?: ValidationOutput;
}
/**
 * Run aggregation on all artifact outputs
 */
export declare function runAggregation(
  input: AggregationInput,
  ctx: PipelineContext,
  options?: AggregationOptions,
): Promise<AggregateOutput>;
/**
 * LX Proposals output format for aggregate/lx.proposals.json
 */
export interface LxProposalsFile {
  $schema: string;
  schemaVersion: string;
  stage: "LX";
  processedAt: string;
  proposals: LxProposal[];
  meta: {
    proposalCount: number;
    sameConceptCount: number;
    relatedConceptCount: number;
    avgSimilarity: number;
  };
}
/**
 * Format LX proposals for file output
 */
export declare function formatLxProposals(
  proposals: LxProposal[],
  processedAt: string,
): LxProposalsFile;
/**
 * Persist aggregate output to the store
 *
 * Writes the following files to aggregate/:
 * - lx.proposals.json (with $schema)
 * - coverage.json (with $schema)
 * - findings.json (with $schema)
 * - coverage-report.json (rich, with $schema)
 * - validation.json (rich, with $schema)
 *
 * @param output - The aggregate output to persist
 * @param runId - The run ID
 * @param runStore - The run store with saveAggregates method
 * @param logger - Optional logger for debug output
 */
export declare function persistAggregateOutput(
  output: AggregateOutput,
  runId: string,
  runStore: {
    saveAggregates(
      runId: string,
      aggregates: Record<string, unknown>,
    ): Promise<void>;
  },
  logger?: {
    debug(msg: string, meta?: Record<string, unknown>): void;
  },
): Promise<void>;
//# sourceMappingURL=aggregation.d.ts.map
