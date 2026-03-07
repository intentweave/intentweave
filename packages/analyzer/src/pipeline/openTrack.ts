// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Open Track Orchestrator — IN → FX → KX
 *
 * Runs the schema-free extraction pipeline as a parallel track alongside
 * the existing IN → RX → CX → MX → PX pipeline.
 *
 * Usage:
 *   const result = await runOpenTrack(artifact, ctx, { llmProvider });
 *
 * The output contains both layers:
 * - rawTriples:    full LLM-extracted relationships (for RAG / agent context)
 * - canonEntities: deduplicated, typed entities (for Cypher queries)
 * - canonTriples:  normalized relationships (for Cypher queries)
 *
 * This track reuses the IN stage from the main pipeline — same chunking,
 * same artifact metadata, just a different extraction strategy.
 */

import type { ExtractionHooks, LLMProvider, TokenUsage } from '@intentweave/core';
import { sumTokenUsage, zeroTokenUsage, AbortThresholdError } from '@intentweave/core';
import type { PipelineContext } from './context.js';
import type { ArtifactInput, PipelineStage } from './orchestrator.js';
import { runInStage, type InStageInput } from '../stages/in.js';
import { runFxStage, type FxStageInput, type FxStageOutput, FX_PROMPT_VERSION } from '../stages/fx.js';
import { runKxStage, type KxStageInput, type KxStageOutput, KX_PROMPT_VERSION } from '../stages/kx.js';
import { computeContentHash } from '../cache/registry.js';
import type { OpenTrackCache } from '../cache/openTrackCache.js';

// =============================================================================
// Open Track Types
// =============================================================================

export type OpenTrackStage = 'IN' | 'FX' | 'KX';

/**
 * Open track pipeline result (per artifact)
 */
export interface OpenTrackResult {
  /** Artifact ID */
  artifactId: string;
  /** FX stage output (raw triples) */
  fx: FxStageOutput;
  /** KX stage output (canonical + raw, dual layer) */
  kx: KxStageOutput;
  /** Overall pipeline metadata */
  meta: {
    totalLatencyMs: number;
    stages: Record<OpenTrackStage, { latencyMs: number; cached?: boolean }>;
  };
  /** Aggregated token usage across FX + KX (undefined when fully cached) */
  tokenUsage?: TokenUsage;
}

/**
 * Options for the open track pipeline
 */
export interface OpenTrackOptions {
  /** LLM provider (required — used for both FX and KX) */
  llmProvider: LLMProvider;
  /** Optional document context hint for FX */
  documentContext?: string;
  /** Max triples per chunk (FX) */
  maxTriplesPerChunk?: number;
  /** Write stage outputs to artifact store */
  writeOutputs?: boolean;
  /** Progress callback */
  onStage?: (stage: OpenTrackStage) => void;
  /** Open-track incremental cache (optional — if provided, enables caching) */
  cache?: OpenTrackCache;
  /** Force recomputation even if cache hit (with cache) */
  force?: boolean;
  /** FX chunk concurrency (default 5) */
  concurrency?: number;
}

// =============================================================================
// Open Track Implementation
// =============================================================================

/**
 * Run the open (schema-free) extraction track for a single artifact.
 *
 * Pipeline: IN → FX → KX
 *
 * Reuses the same IN stage as the main pipeline — the artifact is chunked
 * identically, ensuring both tracks operate on the same input.
 *
 * @param artifact - Artifact input (content, paths, metadata)
 * @param ctx      - Pipeline context (store, logger, providers)
 * @param options  - LLM provider and configuration
 * @returns OpenTrackResult with FX + KX outputs
 */
export async function runOpenTrack(
  artifact: ArtifactInput,
  ctx: PipelineContext,
  options: OpenTrackOptions,
): Promise<OpenTrackResult> {
  const totalStart = Date.now();
  const stageTimes: Record<OpenTrackStage, { latencyMs: number; cached?: boolean }> = {
    IN: { latencyMs: 0 },
    FX: { latencyMs: 0 },
    KX: { latencyMs: 0 },
  };

  ctx.logger.info(`[OpenTrack] Starting for ${artifact.artifactId}`, {
    filePath: artifact.filePath,
  });

  // ─── Incremental cache check ────────────────────────────────────────────
  const cache = options.cache;
  const contentHash = cache ? computeContentHash(artifact.content) : '';
  const cacheCheck = cache
    ? await cache.check(
        artifact.artifactId,
        contentHash,
        options.force,
        FX_PROMPT_VERSION,
        KX_PROMPT_VERSION,
        options.llmProvider.name,
        options.llmProvider.getModelName?.(),
      )
    : { fxHit: false, kxHit: false };

  if (cache && cacheCheck.fxHit) {
    ctx.logger.info(`[OpenTrack] Cache: FX ${cacheCheck.fxHit ? 'HIT' : 'miss'}, KX ${cacheCheck.kxHit ? 'HIT' : 'miss'} for ${artifact.artifactId}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 1: IN (shared with main pipeline — same chunking)
  // ═══════════════════════════════════════════════════════════════════════════
  options.onStage?.('IN');
  const inStart = Date.now();

  const inInput: InStageInput = {
    artifactId: artifact.artifactId,
    filePath: artifact.filePath,
    content: artifact.content,
    artifactFormat: artifact.artifactFormat,
    artifactRole: artifact.artifactRole,
  };
  const inOutput = await runInStage(inInput, ctx);
  stageTimes.IN.latencyMs = Date.now() - inStart;

  if (options.writeOutputs) {
    await ctx.store.writeStageOutput(artifact.artifactId, 'IN', inOutput);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 2: FX — Free Extraction (schema-free)
  // ═══════════════════════════════════════════════════════════════════════════
  options.onStage?.('FX');
  let fxOutput: FxStageOutput;

  if (cacheCheck.fxHit && cache) {
    // Cache hit — reuse cached FX output
    fxOutput = (await cache.getFx<FxStageOutput>(artifact.artifactId))!;
    stageTimes.FX = { latencyMs: 0, cached: true };
    ctx.logger.info(`[OpenTrack] FX cache hit for ${artifact.artifactId} (${fxOutput.triples.length} triples)`);
  } else {
    // Cache miss — run FX
    const fxStart = Date.now();

    const fxInput: FxStageInput = {
      artifactId: artifact.artifactId,
      filePath: artifact.filePath,
      chunks: inOutput.chunks.map(chunk => ({
        id: chunk.id,
        content: chunk.content,
        filePath: inOutput.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      })),
      meta: {
        artifactRole: inOutput.artifactRole,
        artifactFormat: inOutput.artifactFormat,
      },
    };

    fxOutput = await runFxStage(fxInput, {
      llmProvider: options.llmProvider,
      documentContext: options.documentContext,
      maxTriplesPerChunk: options.maxTriplesPerChunk,
      concurrency: options.concurrency,
    }, ctx);

    stageTimes.FX.latencyMs = Date.now() - fxStart;

    // Persist into cache
    if (cache) {
      await cache.putFx(
        artifact.artifactId,
        contentHash,
        fxOutput,
        stageTimes.FX.latencyMs,
        FX_PROMPT_VERSION,
        options.llmProvider.name,
        options.llmProvider.getModelName?.(),
      );
    }
  }

  if (options.writeOutputs) {
    await ctx.store.writeStageOutput(artifact.artifactId, 'FX' as any, fxOutput);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3: KX — Canonicalization
  // ═══════════════════════════════════════════════════════════════════════════
  options.onStage?.('KX');
  let kxOutput: KxStageOutput;

  if (cacheCheck.kxHit && cache) {
    // Cache hit — reuse cached KX output
    kxOutput = (await cache.getKx<KxStageOutput>(artifact.artifactId))!;
    stageTimes.KX = { latencyMs: 0, cached: true };
    ctx.logger.info(`[OpenTrack] KX cache hit for ${artifact.artifactId} (${kxOutput.canonEntities.length} entities, ${kxOutput.canonTriples.length} triples)`);
  } else {
    // Cache miss — run KX
    const kxStart = Date.now();

    const kxInput: KxStageInput = {
      artifactId: artifact.artifactId,
      fxOutput,
    };

    kxOutput = await runKxStage(kxInput, options.llmProvider, ctx);
    stageTimes.KX.latencyMs = Date.now() - kxStart;

    // Persist into cache
    if (cache) {
      await cache.putKx(artifact.artifactId, kxOutput, stageTimes.KX.latencyMs, KX_PROMPT_VERSION);
    }
  }

  if (options.writeOutputs) {
    await ctx.store.writeStageOutput(artifact.artifactId, 'KX' as any, kxOutput);
  }

  const totalLatencyMs = Date.now() - totalStart;

  ctx.logger.info(`[OpenTrack] Completed ${artifact.artifactId}`, {
    rawTriples: kxOutput.rawTriples.length,
    canonEntities: kxOutput.canonEntities.length,
    canonTriples: kxOutput.canonTriples.length,
    totalLatencyMs,
    fxCached: stageTimes.FX.cached ?? false,
    kxCached: stageTimes.KX.cached ?? false,
  });

  // Aggregate token usage from FX + KX (skip stages that were cached)
  const stageUsages: TokenUsage[] = [];
  if (fxOutput.tokenUsage && !stageTimes.FX.cached) stageUsages.push(fxOutput.tokenUsage);
  if (kxOutput.tokenUsage && !stageTimes.KX.cached) stageUsages.push(kxOutput.tokenUsage);
  const tokenUsage = stageUsages.length > 0
    ? sumTokenUsage(...stageUsages)
    : undefined;

  return {
    artifactId: artifact.artifactId,
    fx: fxOutput,
    kx: kxOutput,
    meta: {
      totalLatencyMs,
      stages: stageTimes,
    },
    tokenUsage,
  };
}

/**
 * Run open track for multiple artifacts.
 *
 * Includes cross-artifact failure detection: if consecutive artifacts fail
 * (via AbortThresholdError from FX/KX), the batch aborts early to avoid
 * burning API budget on a sustained outage (e.g. quota exhaustion).
 *
 * Network recovery: when failures look like network drops (fetch failed,
 * ECONNRESET, etc.), inserts a 30s cooldown before the next artifact to
 * give the connection time to recover (e.g. macOS wake from sleep).
 */
export async function runOpenTrackBatch(
  artifacts: ArtifactInput[],
  ctx: PipelineContext,
  options: OpenTrackOptions,
): Promise<OpenTrackResult[]> {
  // Initialise cache if provided
  if (options.cache) {
    await options.cache.init();
  }

  const MAX_CONSECUTIVE_FAILURES = 3;
  const NETWORK_COOLDOWN_MS = 30_000; // 30s pause after a network error
  const NETWORK_ERROR_RE = /fetch failed|econnreset|econnrefused|etimedout|socket hang up|network/i;

  const results: OpenTrackResult[] = [];
  let cacheHits = 0;
  let consecutiveFailures = 0;

  for (const artifact of artifacts) {
    try {
      const result = await runOpenTrack(artifact, ctx, options);
      results.push(result);

      if (result.meta.stages.FX.cached && result.meta.stages.KX.cached) {
        cacheHits++;
      }

      // Reset failure counter on success (has triples OR was cached)
      if (result.fx.triples.length > 0 || result.meta.stages.FX.cached) {
        consecutiveFailures = 0;
      } else {
        // 0 triples from a non-cached FX run — possible API issue
        consecutiveFailures++;
        ctx.logger.warn(`[OpenTrack] ${artifact.artifactId}: 0 triples extracted (${consecutiveFailures} consecutive failures)`);
      }
    } catch (err) {
      if (err instanceof AbortThresholdError) {
        consecutiveFailures++;
        const errMsg = err.message;
        ctx.logger.warn(`[OpenTrack] ${artifact.artifactId}: stage aborted (${errMsg}), ${consecutiveFailures} consecutive failures`);

        // Network error cooldown: if the failure looks like a network drop,
        // wait before hitting the next artifact to let the connection recover.
        if (NETWORK_ERROR_RE.test(errMsg) && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
          ctx.logger.warn(
            `[OpenTrack] Network error detected — pausing ${NETWORK_COOLDOWN_MS / 1000}s before next artifact…`,
          );
          await new Promise(resolve => setTimeout(resolve, NETWORK_COOLDOWN_MS));
        }
      } else {
        throw err;
      }
    }

    // Abort if too many consecutive artifacts failed — likely a sustained API issue
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      ctx.logger.error(
        `[OpenTrack] Aborting batch: ${MAX_CONSECUTIVE_FAILURES} consecutive artifacts failed. ` +
        `Likely API quota exhaustion or sustained outage. ` +
        `Processed ${results.length}/${artifacts.length} artifacts before abort.`
      );
      break;
    }
  }

  if (options.cache && artifacts.length > 1) {
    ctx.logger.info(`[OpenTrack] Batch complete: ${results.length}/${artifacts.length} processed, ${cacheHits} fully cached`);
  }

  return results;
}

/**
 * Run only the KX stage from pre-computed FX output.
 *
 * Useful when FX completed successfully but KX failed (timeout, etc.)
 * and you want to retry canonicalization without re-running extraction.
 */
export async function runKxFromFxOutput(
  fxOutput: FxStageOutput,
  ctx: PipelineContext,
  options: Pick<OpenTrackOptions, 'llmProvider'>,
): Promise<OpenTrackResult> {
  const totalStart = Date.now();

  ctx.logger.info(`[OpenTrack] Running KX-only for ${fxOutput.artifactId}`, {
    rawTriples: fxOutput.triples.length,
  });

  const kxInput: KxStageInput = {
    artifactId: fxOutput.artifactId,
    fxOutput,
  };

  const kxOutput = await runKxStage(kxInput, options.llmProvider, ctx);
  const totalLatencyMs = Date.now() - totalStart;

  ctx.logger.info(`[OpenTrack] KX-only completed ${fxOutput.artifactId}`, {
    rawTriples: kxOutput.rawTriples.length,
    canonEntities: kxOutput.canonEntities.length,
    canonTriples: kxOutput.canonTriples.length,
    totalLatencyMs,
  });

  return {
    artifactId: fxOutput.artifactId,
    fx: fxOutput,
    kx: kxOutput,
    meta: {
      totalLatencyMs,
      stages: {
        IN: { latencyMs: 0 },
        FX: { latencyMs: 0 },
        KX: { latencyMs: totalLatencyMs },
      },
    },
    tokenUsage: kxOutput.tokenUsage,
  };
}
