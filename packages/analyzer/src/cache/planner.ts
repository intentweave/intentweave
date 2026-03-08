// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Run Planner
 *
 * Analyzes artifacts and cached outputs to determine what work needs to be done.
 * Generates a RunPlan that can be displayed to the user before execution.
 *
 * Key responsibilities:
 * - Compare content hashes to detect input changes
 * - Compare config hashes to detect configuration changes
 * - Cascade invalidation through the pipeline
 * - Compute global stage invalidation based on PX set changes
 * - Generate a human-readable execution plan
 */

import type {
  PerArtifactStage,
  ArtifactKey,
  ArtifactPlan,
  GlobalPlan,
  RunPlan,
  InvalidationReason,
  ArtifactInvalidation,
  StageInvalidation,
  PipelineConfig,
  DiscoveredArtifact,
  StageMeta,
} from "./types.js";
import { PIPELINE_STAGES, STAGE_INDEX, serializeArtifactKey } from "./types.js";
import {
  IncrementalCache,
  computeStageConfigHash,
  computePxSetHash,
  checkCacheValidity,
} from "./cache.js";
import { ArtifactRegistry, computeContentHash } from "./registry.js";
import { createHash } from "node:crypto";

// =============================================================================
// Planner Types
// =============================================================================

/**
 * Options for plan generation
 */
export interface PlanOptions {
  /** Pipeline configuration for config hashing */
  config: PipelineConfig;
  /** Force recomputation from a specific stage */
  forceFrom?: PerArtifactStage;
  /** Force recomputation for specific artifacts (by key string) */
  forceArtifacts?: string[];
  /** Include context in invalidation (for server mode) */
  includeContext?: boolean;
  /** Prior snapshot hash (if using context) */
  priorSnapshotHash?: string;
}

/**
 * Planner context (internal)
 */
interface PlannerContext {
  cache: IncrementalCache;
  registry: ArtifactRegistry;
  config: PipelineConfig;
  configHashes: Map<PerArtifactStage, string>;
  forceFrom?: PerArtifactStage;
  forceArtifacts: Set<string>;
  includeContext: boolean;
  priorSnapshotHash?: string;
}

// =============================================================================
// Invalidation Logic
// =============================================================================

/**
 * Compute invalidation status for a single artifact
 */
async function computeArtifactInvalidation(
  artifact: DiscoveredArtifact,
  ctx: PlannerContext,
): Promise<ArtifactInvalidation> {
  const artifactKey = serializeArtifactKey(artifact.key);

  const stages: Record<PerArtifactStage, StageInvalidation> = {
    IN: { stage: "IN", invalid: false },
    RX: { stage: "RX", invalid: false },
    CX: { stage: "CX", invalid: false },
    MX: { stage: "MX", invalid: false },
    PX: { stage: "PX", invalid: false },
  };

  // Check if artifact is force-invalidated
  const isForced = ctx.forceArtifacts.has(artifactKey);

  // Get all cached metadata for this artifact
  const cachedMeta = await ctx.cache.getAllStageMeta(artifactKey);

  // Track the current upstream hash for cascade
  let upstreamHash: string | undefined = undefined;
  let cascadeInvalid = false;
  let cascadeReason: InvalidationReason | undefined;
  let cascadeDetails: string | undefined;

  for (const stage of PIPELINE_STAGES) {
    const configHash = ctx.configHashes.get(stage)!;
    const cached = cachedMeta?.[stage];

    // If already in cascade, mark invalid
    if (cascadeInvalid) {
      stages[stage] = {
        stage,
        invalid: true,
        reason: "upstream-changed",
        details: cascadeDetails,
      };
      continue;
    }

    // Check for forced invalidation
    if (isForced) {
      stages[stage] = {
        stage,
        invalid: true,
        reason: "forced",
        details: "Artifact explicitly forced",
      };
      cascadeInvalid = true;
      cascadeReason = "forced";
      cascadeDetails = "Forced invalidation cascade";
      continue;
    }

    // Check for force-from stage
    if (ctx.forceFrom && STAGE_INDEX[stage] >= STAGE_INDEX[ctx.forceFrom]) {
      stages[stage] = {
        stage,
        invalid: true,
        reason: "forced",
        details: `Forced from stage ${ctx.forceFrom}`,
      };
      cascadeInvalid = true;
      cascadeReason = "forced";
      cascadeDetails = `Forced from stage ${ctx.forceFrom}`;
      continue;
    }

    // No cache entry
    if (!cached) {
      stages[stage] = {
        stage,
        invalid: true,
        reason: "cache-miss",
        details: "No cached output found",
      };
      cascadeInvalid = true;
      cascadeReason = "cache-miss";
      cascadeDetails = `Cache miss at ${stage}`;
      continue;
    }

    // Check validity
    const validity = checkCacheValidity(
      cached,
      artifact.contentHash,
      configHash,
      upstreamHash,
    );

    if (!validity.valid) {
      const reasonMap: Record<string, InvalidationReason> = {
        "content-mismatch": "content-changed",
        "config-mismatch": "config-changed",
        "upstream-mismatch": "upstream-changed",
      };
      stages[stage] = {
        stage,
        invalid: true,
        reason: reasonMap[validity.reason!],
        details: `${validity.reason} for ${stage}`,
      };
      cascadeInvalid = true;
      cascadeReason = reasonMap[validity.reason!];
      cascadeDetails = `${validity.reason} at ${stage}`;
      continue;
    }

    // Valid cache hit
    stages[stage] = { stage, invalid: false };
    upstreamHash = cached.outputHash;
  }

  // Find first stage to recompute
  let recomputeFrom: PerArtifactStage | null = null;
  const stagesToRecompute: PerArtifactStage[] = [];

  for (const stage of PIPELINE_STAGES) {
    if (stages[stage].invalid) {
      if (!recomputeFrom) {
        recomputeFrom = stage;
      }
      stagesToRecompute.push(stage);
    }
  }

  return {
    artifactKey: artifact.key,
    stages,
    recomputeFrom,
    stagesToRecompute,
  };
}

/**
 * Compute invalidation for global stages (AGG/LX)
 */
async function computeGlobalInvalidation(
  artifactPlans: ArtifactPlan[],
  ctx: PlannerContext,
): Promise<GlobalPlan> {
  // Get current PX output hashes for all artifacts that will have valid PX
  const pxOutputs: Array<{ artifactKey: string; outputHash: string }> = [];

  for (const plan of artifactPlans) {
    const keyString = serializeArtifactKey(plan.artifactKey);

    if (plan.canReuse) {
      // Use cached PX output hash
      const pxMeta = await ctx.cache.getStageMeta(keyString, "PX");
      if (pxMeta) {
        pxOutputs.push({
          artifactKey: keyString,
          outputHash: pxMeta.outputHash,
        });
      }
    } else {
      // Will recompute - use placeholder to indicate change
      pxOutputs.push({
        artifactKey: keyString,
        outputHash: "pending-recompute",
      });
    }
  }

  // Compute current PX set hash
  const currentPxSetHash = computePxSetHash(pxOutputs);

  // Check cached AGG metadata
  const cachedAggMeta = await ctx.cache.getGlobalMeta("all", "AGG");
  const cachedLxMeta = await ctx.cache.getGlobalMeta("all", "LX");

  // Check if any artifact needs recomputation
  const anyRecompute = artifactPlans.some((p) => !p.canReuse);

  // AGG is invalid if:
  // - Any artifact PX will change
  // - No cached AGG exists
  // - Cached AGG pxSetHash doesn't match
  let aggInvalid = false;
  let aggReason: InvalidationReason | undefined;

  if (!cachedAggMeta) {
    aggInvalid = true;
    aggReason = "cache-miss";
  } else if (anyRecompute) {
    aggInvalid = true;
    aggReason = "px-set-changed";
  } else if (cachedAggMeta.pxSetHash !== currentPxSetHash) {
    aggInvalid = true;
    aggReason = "px-set-changed";
  }

  // LX is invalid if:
  // - AGG is invalid
  // - No cached LX exists
  let lxInvalid = aggInvalid;
  let lxReason: InvalidationReason | undefined = aggInvalid
    ? "upstream-changed"
    : undefined;

  if (!cachedLxMeta) {
    lxInvalid = true;
    lxReason = "cache-miss";
  }

  return {
    aggInvalid,
    lxInvalid,
    aggReason,
    lxReason,
  };
}

// =============================================================================
// Plan Generation
// =============================================================================

/**
 * Generate a run plan for the given artifacts
 */
export async function generateRunPlan(
  cache: IncrementalCache,
  registry: ArtifactRegistry,
  options: PlanOptions,
): Promise<RunPlan> {
  const {
    config,
    forceFrom,
    forceArtifacts = [],
    includeContext = false,
    priorSnapshotHash,
  } = options;

  // Pre-compute config hashes for all stages
  const configHashes = new Map<PerArtifactStage, string>();
  for (const stage of PIPELINE_STAGES) {
    configHashes.set(stage, computeStageConfigHash(stage, config));
  }

  const ctx: PlannerContext = {
    cache,
    registry,
    config,
    configHashes,
    forceFrom,
    forceArtifacts: new Set(forceArtifacts),
    includeContext,
    priorSnapshotHash,
  };

  // Generate plan for each artifact
  const artifacts = registry.all();
  const artifactPlans: ArtifactPlan[] = [];
  const stageWork: Record<PerArtifactStage, number> = {
    IN: 0,
    RX: 0,
    CX: 0,
    MX: 0,
    PX: 0,
  };

  for (const artifact of artifacts) {
    const invalidation = await computeArtifactInvalidation(artifact, ctx);

    const plan: ArtifactPlan = {
      artifactKey: artifact.key,
      filePath: artifact.filePath,
      canReuse: invalidation.recomputeFrom === null,
      stagesToRecompute: invalidation.stagesToRecompute,
      recomputeFrom: invalidation.recomputeFrom,
      reason: invalidation.recomputeFrom
        ? invalidation.stages[invalidation.recomputeFrom].reason
        : undefined,
      details: invalidation.recomputeFrom
        ? invalidation.stages[invalidation.recomputeFrom].details
        : undefined,
    };

    artifactPlans.push(plan);

    // Count stage work
    for (const stage of invalidation.stagesToRecompute) {
      stageWork[stage]++;
    }
  }

  // Compute global stage invalidation
  const globalPlan = await computeGlobalInvalidation(artifactPlans, ctx);

  // Generate plan summary
  const reuseCount = artifactPlans.filter((p) => p.canReuse).length;
  const recomputeCount = artifactPlans.length - reuseCount;

  const planId = `plan-${Date.now()}-${createHash("sha256").update(Math.random().toString()).digest("hex").slice(0, 8)}`;

  return {
    planId,
    createdAt: new Date().toISOString(),
    totalArtifacts: artifacts.length,
    reuseCount,
    recomputeCount,
    artifacts: artifactPlans,
    global: globalPlan,
    summary: {
      stageWork,
    },
  };
}

// =============================================================================
// Plan Formatting
// =============================================================================

/**
 * Format a run plan for display
 */
export function formatRunPlan(plan: RunPlan): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(
    "                      INCREMENTAL RUN PLAN                      ",
  );
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // Summary
  lines.push(`Artifacts: ${plan.totalArtifacts} total`);
  lines.push(`  ✓ Reuse full chain: ${plan.reuseCount}`);
  lines.push(`  ✗ Recompute: ${plan.recomputeCount}`);
  lines.push("");

  // Stage work breakdown
  if (plan.recomputeCount > 0) {
    lines.push("Stage Work:");
    for (const stage of PIPELINE_STAGES) {
      const count = plan.summary.stageWork[stage];
      if (count > 0) {
        lines.push(`  ${stage}: ${count} artifact${count > 1 ? "s" : ""}`);
      }
    }
    lines.push("");
  }

  // Artifacts to recompute (limited to first 10)
  const toRecompute = plan.artifacts.filter((a) => !a.canReuse);
  if (toRecompute.length > 0) {
    lines.push("Artifacts to Recompute:");
    const displayCount = Math.min(toRecompute.length, 10);
    for (let i = 0; i < displayCount; i++) {
      const a = toRecompute[i];
      const path = a.filePath || serializeArtifactKey(a.artifactKey);
      const stages = a.stagesToRecompute.join("→");
      const reason = a.reason || "unknown";
      lines.push(`  • ${path}`);
      lines.push(`    Stages: ${stages} (${reason})`);
    }
    if (toRecompute.length > displayCount) {
      lines.push(`  ... and ${toRecompute.length - displayCount} more`);
    }
    lines.push("");
  }

  // Global stages
  lines.push("Global Stages:");
  lines.push(
    `  AGG: ${plan.global.aggInvalid ? `recompute (${plan.global.aggReason})` : "reuse"}`,
  );
  lines.push(
    `  LX:  ${plan.global.lxInvalid ? `recompute (${plan.global.lxReason})` : "reuse"}`,
  );
  lines.push("");

  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

/**
 * Format plan as JSON for machine consumption
 */
export function formatRunPlanJson(plan: RunPlan): string {
  return JSON.stringify(plan, null, 2);
}
