/**
 * LX Stage - Cross-Artifact Linking (Aggregate)
 * 
 * Phase 1 Placeholder - No linking logic yet.
 * This stub establishes IO contracts for Phase 3+ implementation.
 * 
 * The LX stage runs at the aggregate level (not per-artifact) and:
 * - Analyzes entities across all artifacts in a run
 * - Generates link proposals for cross-artifact relationships
 * - Writes lx.json to the aggregate directory
 */

import type { LinkProposal, LxStageOutput } from '@intentweave/core';

/**
 * LX Stage Options
 */
export interface LxStageOptions {
  /** Workspace key for scoping */
  workspaceKey: string;
  
  /** Run ID */
  runId: string;
  
  /** Minimum confidence threshold for proposals */
  minConfidence?: number;
  
  /** Enable semantic matching (requires embeddings) */
  enableSemantic?: boolean;
}

/**
 * LX Stage Input (from MX/PX stages)
 */
export interface LxStageInput {
  /** Artifacts with their extracted entities */
  artifacts: Array<{
    id: string;
    filePath: string;
    entities: Array<{
      cgId: string;
      name: string;
      type: string;
      aliases?: string[];
    }>;
  }>;
}

/**
 * Run LX stage (aggregate-level cross-artifact linking)
 * 
 * Phase 1: Returns empty proposals. Actual linking logic in Phase 3+.
 * 
 * @param input - Entities from all artifacts
 * @param options - LX stage options
 * @returns LX stage output with link proposals
 */
export async function runLxCore(
  input: LxStageInput,
  options: LxStageOptions
): Promise<LxStageOutput> {
  const startTime = Date.now();
  
  // Phase 1: No linking logic - just establish the contract
  const proposals: LinkProposal[] = [];
  
  // Count total entities
  const totalEntities = input.artifacts.reduce(
    (sum, artifact) => sum + artifact.entities.length,
    0
  );
  
  return {
    schemaVersion: '0.1',
    stage: 'LX',
    runId: options.runId,
    workspaceKey: options.workspaceKey,
    generatedAt: new Date().toISOString(),
    proposals,
    meta: {
      entitiesAnalyzed: totalEntities,
      proposalsGenerated: 0,
      processingTimeMs: Date.now() - startTime,
    },
  };
}

/**
 * Create an empty LX output (for initialization)
 */
export function createEmptyLxOutput(
  runId: string,
  workspaceKey: string
): LxStageOutput {
  return {
    schemaVersion: '0.1',
    stage: 'LX',
    runId,
    workspaceKey,
    generatedAt: new Date().toISOString(),
    proposals: [],
    meta: {
      entitiesAnalyzed: 0,
      proposalsGenerated: 0,
      processingTimeMs: 0,
    },
  };
}
