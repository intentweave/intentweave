// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * LX-Core - Cross-Artifact Entity Linking
 *
 * Implements the core linking algorithms for Phase 3.
 *
 * Matching Algorithms (in priority order):
 * 1. Name matching - Direct name/alias matching (highest confidence)
 * 2. Structural matching - File/module boundary heuristics
 * 3. Profile matching - Kind-to-kind rules from profile
 *
 * Semantic matching (embeddings) is optional and requires external provider.
 */
import type { Entity, LxStageOutput } from "@intentweave/core";
import type { Profile } from "../pipeline/context.js";
import type { PxStageOutput } from "../stages/px.js";
/**
 * Artifact entity input for linking
 */
export interface LxArtifactInput {
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Artifact role (spec, impl, prompt, etc.) */
  artifactRole: string;
  /** Entities from this artifact */
  entities: Entity[];
}
/**
 * LX-Core options
 */
export interface LxCoreOptions {
  /** Workspace key */
  workspaceKey: string;
  /** Run ID */
  runId: string;
  /** Active profile */
  profile: Profile;
  /** Minimum confidence threshold for proposals */
  minConfidence?: number;
  /** Enable name matching */
  enableNameMatching?: boolean;
  /** Enable alias matching */
  enableAliasMatching?: boolean;
  /** Enable structural matching */
  enableStructuralMatching?: boolean;
  /** Enable profile-based matching */
  enableProfileMatching?: boolean;
  /** Maximum proposals per entity pair */
  maxProposalsPerPair?: number;
}
/**
 * Run LX-Core linking on all artifacts
 *
 * @param artifacts - PX outputs from all artifacts
 * @param options - LX options
 * @returns LX stage output with link proposals
 */
export declare function runLxCore(
  artifacts: LxArtifactInput[],
  options: LxCoreOptions,
): Promise<LxStageOutput>;
/**
 * Convert PX outputs to LX inputs
 */
export declare function pxOutputsToLxInputs(
  pxOutputs: PxStageOutput[],
): LxArtifactInput[];
/**
 * Create empty LX output
 */
export declare function createEmptyLxOutput(
  runId: string,
  workspaceKey: string,
): LxStageOutput;
//# sourceMappingURL=lxCore.d.ts.map
