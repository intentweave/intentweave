// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Incremental Pipeline Executor
 *
 * Executes pipeline runs using the incremental cache.
 * Only recomputes stages that are invalidated according to the run plan.
 *
 * Key features:
 * - Uses cached outputs when valid
 * - Writes new outputs to cache
 * - Generates manifests and reports
 * - Supports plan-only mode (--plan)
 */

import type { PipelineContext } from "../pipeline/context.js";
import type {
  ArtifactPipelineOutput,
  PipelineProgress,
  PipelineRunResult,
} from "../pipeline/orchestrator.js";
import {
  createRunMeta,
  completeRunMeta,
  failRunMeta,
} from "../pipeline/context.js";
import {
  runInStage,
  type InStageInput,
  type InStageOutput,
} from "../stages/in.js";
import {
  runRxStage,
  type RxStageInput,
  type RxStageOutput,
} from "../stages/rx.js";
import {
  runCxStage,
  type CxStageInput,
  type CxStageOutput,
} from "../stages/cx.js";
import {
  runMxStage,
  type MxStageInput,
  type MxStageOutput,
} from "../stages/mx.js";
import {
  runPxStage,
  type PxStageInput,
  type PxStageOutput,
} from "../stages/px.js";
import {
  runAggregation,
  type AggregateOutput,
} from "../pipeline/aggregation.js";
import type { Chunk, ExtractionHooks } from "@intentweave/core";

import type {
  PerArtifactStage,
  RunPlan,
  ArtifactPlan,
  DiscoveredArtifact,
  StageMeta,
  GlobalStageMeta,
  PipelineConfig,
} from "./types.js";
import { PIPELINE_STAGES, STAGE_INDEX, serializeArtifactKey } from "./types.js";
import {
  IncrementalCache,
  computeStageConfigHash,
  computeGlobalConfigHash,
  computePxSetHash,
} from "./cache.js";
import {
  ArtifactRegistry,
  computeContentHash,
  hashContent,
} from "./registry.js";
import { generateRunPlan, formatRunPlan, type PlanOptions } from "./planner.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

// =============================================================================
// Executor Types
// =============================================================================

/**
 * Incremental execution options
 */
export interface IncrementalExecutorOptions {
  /** Pipeline configuration */
  config: PipelineConfig;
  /** Progress callback */
  onProgress?: (progress: PipelineProgress) => void;
  /** Whether to continue on artifact errors */
  continueOnError?: boolean;
  /** Force recomputation from a specific stage */
  forceFrom?: PerArtifactStage;
  /** Force recomputation for specific artifacts */
  forceArtifacts?: string[];
  /** Maximum chunk size for IN stage */
  maxChunkSize?: number;
  /** Skip aggregation stage */
  skipAgg?: boolean;
  /** Extraction hooks (for server integration) */
  hooks?: ExtractionHooks;
}

/**
 * Incremental execution result
 */
export interface IncrementalResult extends PipelineRunResult {
  /** The execution plan that was followed */
  plan: RunPlan;
  /** Cache statistics after run */
  cacheStats: {
    /** Artifacts reused from cache */
    cacheHits: number;
    /** Artifacts recomputed */
    cacheMisses: number;
    /** Stages reused from cache */
    stageHits: number;
    /** Stages recomputed */
    stageMisses: number;
  };
}

/**
 * Run manifest (written to .iw/runs/<runId>/)
 */
export interface RunManifest {
  /** Run ID */
  runId: string;
  /** When the run started */
  startedAt: string;
  /** When the run completed */
  completedAt?: string;
  /** Status */
  status: "running" | "completed" | "failed";
  /** The plan that was executed */
  plan: RunPlan;
  /** Artifacts processed */
  artifacts: string[];
  /** Summary statistics */
  summary?: {
    cacheHits: number;
    cacheMisses: number;
    entityCount: number;
    statementCount: number;
    durationMs: number;
  };
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Executor Implementation
// =============================================================================

/**
 * IncrementalExecutor
 *
 * Executes pipeline runs incrementally using cached outputs when valid.
 */
export class IncrementalExecutor {
  private cache: IncrementalCache;
  private registry: ArtifactRegistry;
  private runsDir: string;

  constructor(baseDir: string) {
    this.cache = new IncrementalCache(baseDir);
    this.registry = new ArtifactRegistry(baseDir);
    this.runsDir = path.join(baseDir, ".iw", "runs");
  }

  /**
   * Get the cache instance (for direct access)
   */
  getCache(): IncrementalCache {
    return this.cache;
  }

  /**
   * Get the registry instance (for direct access)
   */
  getRegistry(): ArtifactRegistry {
    return this.registry;
  }

  /**
   * Initialize the executor (creates directories)
   */
  async init(): Promise<void> {
    await this.cache.init();
    await fs.mkdir(this.runsDir, { recursive: true });
  }

  /**
   * Discover artifacts for processing
   */
  async discoverArtifacts(options: {
    patterns?: string[];
    exclude?: string[];
    includeChatTurns?: boolean;
    chatTurnsPath?: string;
    includeTranscripts?: boolean;
    transcriptSessionIds?: string[];
    transcriptLimit?: number;
  }): Promise<void> {
    await this.registry.discover(options);
  }

  /**
   * Generate a run plan without executing
   */
  async plan(options: PlanOptions): Promise<RunPlan> {
    return generateRunPlan(this.cache, this.registry, options);
  }

  /**
   * Execute an incremental pipeline run
   */
  async execute(
    ctx: PipelineContext,
    options: IncrementalExecutorOptions,
  ): Promise<IncrementalResult> {
    const {
      config,
      onProgress = () => {},
      continueOnError = false,
      forceFrom,
      forceArtifacts = [],
      maxChunkSize,
      skipAgg = false,
      hooks = {},
    } = options;

    // Generate the execution plan
    const plan = await generateRunPlan(this.cache, this.registry, {
      config,
      forceFrom,
      forceArtifacts,
    });

    // Initialize run manifest
    const manifest: RunManifest = {
      runId: ctx.runId,
      startedAt: new Date().toISOString(),
      status: "running",
      plan,
      artifacts: [],
    };

    // Write initial manifest
    await this.writeManifest(manifest);

    // Initialize run metadata
    let runMeta = createRunMeta(ctx);

    ctx.logger.info(`Starting incremental run ${ctx.runId}`, {
      totalArtifacts: plan.totalArtifacts,
      reuseCount: plan.reuseCount,
      recomputeCount: plan.recomputeCount,
    });

    const artifactOutputs: ArtifactPipelineOutput[] = [];
    const errors = new Map<string, Error>();
    let stageHits = 0;
    let stageMisses = 0;

    const totalStages = PIPELINE_STAGES.length;
    let processedArtifacts = 0;

    try {
      // Process each artifact according to plan
      for (const artifactPlan of plan.artifacts) {
        const keyString = serializeArtifactKey(artifactPlan.artifactKey);
        const artifact = this.registry.get(keyString);

        if (!artifact) {
          ctx.logger.warn(`Artifact not found in registry: ${keyString}`);
          continue;
        }

        processedArtifacts++;

        try {
          const output = await this.processArtifact(
            artifact,
            artifactPlan,
            ctx,
            config,
            hooks,
            maxChunkSize,
            (stage) => {
              const stageIdx = STAGE_INDEX[stage];
              const progress =
                (processedArtifacts - 1 + (stageIdx + 1) / totalStages) /
                plan.totalArtifacts;
              onProgress({
                artifactId: artifact.keyString,
                stage,
                artifactIndex: processedArtifacts,
                totalArtifacts: plan.totalArtifacts,
                progress,
              });
            },
          );

          artifactOutputs.push(output.pipelineOutput);
          stageHits += output.stageHits;
          stageMisses += output.stageMisses;

          manifest.artifacts.push(keyString);
          runMeta.artifacts.push(keyString);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          ctx.logger.error(`Error processing artifact ${keyString}`, {
            error: err.message,
          });

          if (continueOnError) {
            errors.set(keyString, err);
          } else {
            throw err;
          }
        }
      }

      // Run aggregation if enabled and we have outputs
      let aggregateOutput: AggregateOutput | undefined;

      if (!skipAgg && artifactOutputs.length > 0) {
        ctx.logger.info("Running aggregation stage (AGG)", {
          artifactCount: artifactOutputs.length,
        });

        // Report AGG progress
        onProgress({
          artifactId: "aggregate",
          stage: "AGG",
          artifactIndex: plan.totalArtifacts,
          totalArtifacts: plan.totalArtifacts,
          progress: 0.95,
        });

        const pxOutputs = artifactOutputs.map((a) => a.px);
        aggregateOutput = await runAggregation(
          {
            artifactOutputs: pxOutputs,
            runId: ctx.runId,
          },
          ctx,
        );

        // Cache AGG output
        await this.cacheGlobalOutput(
          "AGG",
          "all",
          aggregateOutput,
          config,
          pxOutputs,
        );

        if (!runMeta.stages.includes("AGG")) {
          runMeta.stages.push("AGG");
        }
      }

      // Calculate summary
      const summary = {
        entityCount: artifactOutputs.reduce(
          (sum, a) => sum + a.cx.entities.length,
          0,
        ),
        statementCount: artifactOutputs.reduce(
          (sum, a) => sum + a.cx.statements.length,
          0,
        ),
        artifactCount: artifactOutputs.length,
      };

      // Complete run metadata
      runMeta = completeRunMeta(runMeta, summary, ctx.timestamp());
      runMeta.stages = ["IN", "RX", "CX", "MX", "PX"];

      // Write run metadata
      await ctx.store.writeRunMeta(ctx.runId, runMeta);

      // Update manifest
      manifest.status = "completed";
      manifest.completedAt = new Date().toISOString();
      manifest.summary = {
        cacheHits: plan.reuseCount,
        cacheMisses: plan.recomputeCount,
        entityCount: summary.entityCount,
        statementCount: summary.statementCount,
        durationMs: runMeta.durationMs ?? 0,
      };
      await this.writeManifest(manifest);

      ctx.logger.info(`Incremental run ${ctx.runId} completed`, {
        artifacts: artifactOutputs.length,
        cacheHits: plan.reuseCount,
        cacheMisses: plan.recomputeCount,
        entities: summary.entityCount,
        statements: summary.statementCount,
      });

      return {
        meta: runMeta,
        artifacts: artifactOutputs,
        aggregate: aggregateOutput,
        errors,
        plan,
        cacheStats: {
          cacheHits: plan.reuseCount,
          cacheMisses: plan.recomputeCount,
          stageHits,
          stageMisses,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      runMeta = failRunMeta(runMeta, err.message, ctx.timestamp());
      await ctx.store.writeRunMeta(ctx.runId, runMeta);

      manifest.status = "failed";
      manifest.error = err.message;
      await this.writeManifest(manifest);

      throw err;
    }
  }

  /**
   * Process a single artifact according to its plan
   */
  private async processArtifact(
    artifact: DiscoveredArtifact,
    plan: ArtifactPlan,
    ctx: PipelineContext,
    config: PipelineConfig,
    hooks: ExtractionHooks,
    maxChunkSize: number | undefined,
    onStage: (stage: PerArtifactStage) => void,
  ): Promise<{
    pipelineOutput: ArtifactPipelineOutput;
    stageHits: number;
    stageMisses: number;
  }> {
    const keyString = artifact.keyString;
    const artifactId = keyString;
    const filePath = artifact.filePath ?? keyString;

    let stageHits = 0;
    let stageMisses = 0;

    // Stage outputs
    let inOutput: InStageOutput;
    let rxOutput: RxStageOutput;
    let cxOutput: CxStageOutput;
    let mxOutput: MxStageOutput;
    let pxOutput: PxStageOutput;

    // Determine which stages to recompute
    const recomputeFrom = plan.recomputeFrom;
    const recomputeSet = new Set(plan.stagesToRecompute);

    // Track output hashes for cache metadata
    const outputHashes: Partial<Record<PerArtifactStage, string>> = {};

    // === IN Stage ===
    onStage("IN");
    if (recomputeSet.has("IN")) {
      stageMisses++;
      const inInput: InStageInput = {
        artifactId,
        filePath,
        content: artifact.content,
        artifactFormat: artifact.format,
        artifactRole: artifact.role,
      };
      const startTime = Date.now();
      inOutput = await runInStage(
        inInput,
        ctx,
        maxChunkSize ? { maxChunkSize } : {},
      );
      const ms = Date.now() - startTime;

      // Cache the output
      const outputHash = hashContent(JSON.stringify(inOutput));
      outputHashes["IN"] = outputHash;
      await this.cacheStageOutput(
        "IN",
        keyString,
        inOutput,
        artifact,
        config,
        {},
        outputHash,
        ms,
      );
    } else {
      stageHits++;
      const cached = await this.cache.getStage<InStageOutput>(keyString, "IN");
      if (!cached) {
        throw new Error(`Expected cached IN output for ${keyString}`);
      }
      inOutput = cached.data;
      outputHashes["IN"] = cached.meta.outputHash;
    }

    // === RX Stage ===
    onStage("RX");
    if (recomputeSet.has("RX")) {
      stageMisses++;
      const rxChunks: Chunk[] = inOutput.chunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        filePath: inOutput.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      }));

      const rxInput: RxStageInput = {
        artifactId,
        filePath,
        chunks: rxChunks,
        meta: {
          artifactRole: inOutput.artifactRole,
          artifactFormat: inOutput.artifactFormat,
        },
      };

      const startTime = Date.now();
      rxOutput = await runRxStage(
        rxInput,
        {
          extractionProvider: ctx.providers.extraction,
          profile: {
            name: ctx.profile.name,
            artifactRole: inOutput.artifactRole,
          },
        },
        hooks,
      );
      const ms = Date.now() - startTime;

      const outputHash = hashContent(JSON.stringify(rxOutput));
      outputHashes["RX"] = outputHash;
      await this.cacheStageOutput(
        "RX",
        keyString,
        rxOutput,
        artifact,
        config,
        { IN: outputHashes["IN"]! },
        outputHash,
        ms,
      );
    } else {
      stageHits++;
      const cached = await this.cache.getStage<RxStageOutput>(keyString, "RX");
      if (!cached) {
        throw new Error(`Expected cached RX output for ${keyString}`);
      }
      rxOutput = cached.data;
      outputHashes["RX"] = cached.meta.outputHash;
    }

    // === CX Stage ===
    onStage("CX");
    if (recomputeSet.has("CX")) {
      stageMisses++;
      const cxInput: CxStageInput = {
        artifactId,
        rxOutput,
      };

      const startTime = Date.now();
      cxOutput = await runCxStage(cxInput, ctx);
      const ms = Date.now() - startTime;

      const outputHash = hashContent(JSON.stringify(cxOutput));
      outputHashes["CX"] = outputHash;
      await this.cacheStageOutput(
        "CX",
        keyString,
        cxOutput,
        artifact,
        config,
        { RX: outputHashes["RX"]! },
        outputHash,
        ms,
      );
    } else {
      stageHits++;
      const cached = await this.cache.getStage<CxStageOutput>(keyString, "CX");
      if (!cached) {
        throw new Error(`Expected cached CX output for ${keyString}`);
      }
      cxOutput = cached.data;
      outputHashes["CX"] = cached.meta.outputHash;
    }

    // === MX Stage ===
    onStage("MX");
    if (recomputeSet.has("MX")) {
      stageMisses++;
      const mxInput: MxStageInput = {
        artifactId,
        cxOutput,
      };

      const startTime = Date.now();
      mxOutput = await runMxStage(mxInput, ctx);
      const ms = Date.now() - startTime;

      const outputHash = hashContent(JSON.stringify(mxOutput));
      outputHashes["MX"] = outputHash;
      await this.cacheStageOutput(
        "MX",
        keyString,
        mxOutput,
        artifact,
        config,
        { CX: outputHashes["CX"]! },
        outputHash,
        ms,
      );
    } else {
      stageHits++;
      const cached = await this.cache.getStage<MxStageOutput>(keyString, "MX");
      if (!cached) {
        throw new Error(`Expected cached MX output for ${keyString}`);
      }
      mxOutput = cached.data;
      outputHashes["MX"] = cached.meta.outputHash;
    }

    // === PX Stage ===
    onStage("PX");
    if (recomputeSet.has("PX")) {
      stageMisses++;
      const pxInput: PxStageInput = {
        artifactId,
        filePath,
        mxOutput,
        artifactRole: inOutput.artifactRole, // Pass role from IN stage
      };

      const startTime = Date.now();
      pxOutput = await runPxStage(pxInput, ctx);
      const ms = Date.now() - startTime;

      const outputHash = hashContent(JSON.stringify(pxOutput));
      outputHashes["PX"] = outputHash;
      await this.cacheStageOutput(
        "PX",
        keyString,
        pxOutput,
        artifact,
        config,
        { MX: outputHashes["MX"]! },
        outputHash,
        ms,
      );
    } else {
      stageHits++;
      const cached = await this.cache.getStage<PxStageOutput>(keyString, "PX");
      if (!cached) {
        throw new Error(`Expected cached PX output for ${keyString}`);
      }
      pxOutput = cached.data;
      outputHashes["PX"] = cached.meta.outputHash;
    }

    return {
      pipelineOutput: {
        artifactId,
        in: inOutput,
        rx: rxOutput,
        cx: cxOutput,
        mx: mxOutput,
        px: pxOutput,
      },
      stageHits,
      stageMisses,
    };
  }

  /**
   * Cache a stage output with metadata
   */
  private async cacheStageOutput<T>(
    stage: PerArtifactStage,
    artifactKey: string,
    data: T,
    artifact: DiscoveredArtifact,
    config: PipelineConfig,
    inputDeps: Partial<Record<PerArtifactStage, string>>,
    outputHash: string,
    ms: number,
  ): Promise<void> {
    const meta: StageMeta = {
      artifactKey,
      stage,
      createdAt: new Date().toISOString(),
      contentHash: artifact.contentHash,
      configHash: computeStageConfigHash(stage, config),
      inputDeps,
      outputHash,
      stats: {
        ms,
      },
    };

    // Extract stats from output if available
    if (typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.entities)) {
        meta.stats.entities = d.entities.length;
      }
      if (Array.isArray(d.statements)) {
        meta.stats.statements = d.statements.length;
      }
    }

    await this.cache.putStage(artifactKey, stage, data, meta);
  }

  /**
   * Cache a global stage output
   */
  private async cacheGlobalOutput<T>(
    stage: "AGG" | "LX",
    aggKey: string,
    data: T,
    config: PipelineConfig,
    pxOutputs: PxStageOutput[],
  ): Promise<void> {
    // Compute PX set hash
    const pxSetItems = await Promise.all(
      pxOutputs.map(async (px) => {
        const artifactKey = px.artifactId;
        const outputHash = hashContent(JSON.stringify(px));
        return { artifactKey, outputHash };
      }),
    );
    const pxSetHash = computePxSetHash(pxSetItems);

    const meta: GlobalStageMeta = {
      aggKey,
      stage,
      createdAt: new Date().toISOString(),
      pxSetHash,
      configHash: computeGlobalConfigHash(stage, config),
      outputHash: hashContent(JSON.stringify(data)),
      artifactCount: pxOutputs.length,
      stats: {
        ms: 0, // AGG time not tracked separately here
      },
    };

    await this.cache.putGlobalStage(aggKey, stage, data, meta);
  }

  /**
   * Write run manifest
   */
  private async writeManifest(manifest: RunManifest): Promise<void> {
    const runDir = path.join(this.runsDir, manifest.runId);
    await fs.mkdir(runDir, { recursive: true });

    const manifestPath = path.join(runDir, "manifest.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    // Also write plan.json for easier access
    const planPath = path.join(runDir, "plan.json");
    await fs.writeFile(
      planPath,
      JSON.stringify(manifest.plan, null, 2),
      "utf-8",
    );
  }

  /**
   * Generate a report for a completed run
   */
  async generateReport(result: IncrementalResult): Promise<string> {
    const lines: string[] = [];

    lines.push("# Incremental Pipeline Run Report");
    lines.push("");
    lines.push(`**Run ID:** ${result.meta.runId}`);
    lines.push(`**Status:** ${result.meta.status}`);
    lines.push(`**Duration:** ${result.meta.durationMs}ms`);
    lines.push("");

    lines.push("## Cache Performance");
    lines.push("");
    lines.push(
      `- **Artifacts reused:** ${result.cacheStats.cacheHits}/${result.plan.totalArtifacts}`,
    );
    lines.push(
      `- **Artifacts recomputed:** ${result.cacheStats.cacheMisses}/${result.plan.totalArtifacts}`,
    );
    lines.push(`- **Stages reused:** ${result.cacheStats.stageHits}`);
    lines.push(`- **Stages recomputed:** ${result.cacheStats.stageMisses}`);
    lines.push("");

    lines.push("## Summary");
    lines.push("");
    lines.push(
      `- **Total entities:** ${result.meta.summary?.entityCount ?? 0}`,
    );
    lines.push(
      `- **Total statements:** ${result.meta.summary?.statementCount ?? 0}`,
    );
    lines.push(`- **Artifacts processed:** ${result.artifacts.length}`);
    lines.push("");

    if (result.plan.recomputeCount > 0) {
      lines.push("## Recomputed Artifacts");
      lines.push("");

      const recomputed = result.plan.artifacts.filter((a) => !a.canReuse);
      for (const a of recomputed.slice(0, 20)) {
        const path = a.filePath || serializeArtifactKey(a.artifactKey);
        lines.push(`- **${path}**`);
        lines.push(`  - Stages: ${a.stagesToRecompute.join(" → ")}`);
        lines.push(`  - Reason: ${a.reason || "unknown"}`);
      }

      if (recomputed.length > 20) {
        lines.push(`- ... and ${recomputed.length - 20} more`);
      }
      lines.push("");
    }

    if (result.errors.size > 0) {
      lines.push("## Errors");
      lines.push("");
      for (const [artifactId, error] of result.errors) {
        lines.push(`- **${artifactId}:** ${error.message}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

/**
 * Create a default pipeline config
 */
export function createDefaultPipelineConfig(options: {
  model?: string;
  profile?: string;
  profileVersion?: string;
}): PipelineConfig {
  return {
    pipelineVersion: "0.1.0",
    stages: {
      IN: {
        maxChunkSize: 16000,
        minChunkSize: 50,
        splitCodeBlocks: true,
      },
      RX: {
        model: options.model ?? "gpt-5-mini",
        temperature: 0.1,
        maxOutputTokens: 16384,
        profile: options.profile ?? "standard",
        profileVersion: options.profileVersion,
      },
      CX: {
        dedupStrategy: "name-merge",
      },
      MX: {
        semanticsVersion: "0.1",
      },
      PX: {
        projectionVersion: "0.1",
      },
    },
    global: {},
  };
}
