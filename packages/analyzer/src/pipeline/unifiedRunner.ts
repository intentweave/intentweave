/**
 * Unified Pipeline Runner — supports track selection
 *
 * Allows running:
 * - 'main'     → IN → RX → CX → MX → PX → AGG  (existing, schema-constrained)
 * - 'open'     → IN → FX → KX                    (new, schema-free)
 * - 'both'     → runs both in parallel and returns combined results
 *
 * This is the top-level entry point that callers (server, CLI) should use
 * when they want to choose which pipeline track to run.
 */

import type { LLMProvider, ExtractionHooks } from '@intentweave/core';
import type { PipelineContext } from './context.js';
import type {
  ArtifactInput,
  OrchestratorOptions,
  PipelineRunResult,
  ArtifactPipelineOutput,
} from './orchestrator.js';
import { runPipeline } from './orchestrator.js';
import type { OpenTrackResult, OpenTrackOptions } from './openTrack.js';
import { runOpenTrack, runOpenTrackBatch } from './openTrack.js';

// =============================================================================
// Track Selection Types
// =============================================================================

/**
 * Which pipeline track to execute
 */
export type PipelineTrack = 'main' | 'open' | 'both';

/**
 * Options for the unified pipeline runner
 */
export interface UnifiedPipelineOptions {
  /** Which track to run: 'main' (schema-constrained), 'open' (schema-free), or 'both' */
  track: PipelineTrack;

  /** Options for the main pipeline (IN → RX → CX → MX → PX → AGG) */
  mainOptions?: OrchestratorOptions;

  /** Options for the open track (IN → FX → KX) — requires llmProvider */
  openOptions?: {
    /** LLM provider (required for open track) */
    llmProvider: LLMProvider;
    /** Optional document context hint for FX */
    documentContext?: string;
    /** Max triples per chunk */
    maxTriplesPerChunk?: number;
    /** Write stage outputs to artifact store */
    writeOutputs?: boolean;
  };

  /** Hooks for extraction (passed to main pipeline) */
  hooks?: ExtractionHooks;
}

/**
 * Result from the main (schema-constrained) pipeline track
 */
export interface MainTrackOutput {
  /** Full pipeline run result */
  result: PipelineRunResult;
}

/**
 * Result from the open (schema-free) pipeline track
 */
export interface OpenTrackOutput {
  /** Per-artifact open track results */
  artifacts: OpenTrackResult[];
  /** Aggregate metadata */
  meta: {
    totalLatencyMs: number;
    totalRawTriples: number;
    totalCanonTriples: number;
    totalCanonEntities: number;
  };
}

/**
 * Combined result from the unified pipeline runner
 */
export interface UnifiedPipelineResult {
  /** Which track(s) were executed */
  track: PipelineTrack;

  /** Main pipeline results (present if track is 'main' or 'both') */
  main?: MainTrackOutput;

  /** Open track results (present if track is 'open' or 'both') */
  open?: OpenTrackOutput;

  /** Total duration including both tracks */
  totalDurationMs: number;
}

// =============================================================================
// Unified Pipeline Runner
// =============================================================================

/**
 * Run the analysis pipeline with track selection.
 *
 * @param artifacts - Input artifacts to analyze
 * @param ctx       - Pipeline context (providers, store, logger)
 * @param options   - Track selection and per-track options
 * @returns Combined results from selected track(s)
 *
 * @example
 * ```ts
 * // Run only the open (schema-free) track
 * const result = await runUnifiedPipeline(artifacts, ctx, {
 *   track: 'open',
 *   openOptions: { llmProvider },
 * });
 *
 * // Run only the main (schema-constrained) track
 * const result = await runUnifiedPipeline(artifacts, ctx, {
 *   track: 'main',
 * });
 *
 * // Run both tracks and compare
 * const result = await runUnifiedPipeline(artifacts, ctx, {
 *   track: 'both',
 *   openOptions: { llmProvider },
 * });
 * ```
 */
export async function runUnifiedPipeline(
  artifacts: ArtifactInput[],
  ctx: PipelineContext,
  options: UnifiedPipelineOptions,
): Promise<UnifiedPipelineResult> {
  const totalStart = Date.now();
  const { track } = options;

  ctx.logger.info(`[UnifiedPipeline] Starting with track=${track}`, {
    artifacts: artifacts.length,
  });

  // Validate options
  if ((track === 'open' || track === 'both') && !options.openOptions?.llmProvider) {
    throw new Error(
      `Open track requires openOptions.llmProvider. ` +
      `Either provide it or use track='main'.`
    );
  }

  let mainOutput: MainTrackOutput | undefined;
  let openOutput: OpenTrackOutput | undefined;

  // ─── Run tracks ───

  if (track === 'main' || track === 'both') {
    ctx.logger.info('[UnifiedPipeline] Running main track (IN → RX → CX → MX → PX → AGG)');
    const mainResult = await runPipeline(artifacts, ctx, options.mainOptions);
    mainOutput = { result: mainResult };
  }

  if (track === 'open' || track === 'both') {
    ctx.logger.info('[UnifiedPipeline] Running open track (IN → FX → KX)');
    const openOpts = options.openOptions!;

    const openTrackOpts: OpenTrackOptions = {
      llmProvider: openOpts.llmProvider,
      documentContext: openOpts.documentContext,
      maxTriplesPerChunk: openOpts.maxTriplesPerChunk,
      writeOutputs: openOpts.writeOutputs ?? true,
    };

    const openResults = await runOpenTrackBatch(artifacts, ctx, openTrackOpts);

    // Build aggregate metadata
    const totalRawTriples = openResults.reduce(
      (sum, r) => sum + r.kx.rawTriples.length, 0
    );
    const totalCanonTriples = openResults.reduce(
      (sum, r) => sum + r.kx.canonTriples.length, 0
    );
    const totalCanonEntities = openResults.reduce(
      (sum, r) => sum + r.kx.canonEntities.length, 0
    );
    const totalLatencyMs = openResults.reduce(
      (sum, r) => sum + r.meta.totalLatencyMs, 0
    );

    openOutput = {
      artifacts: openResults,
      meta: {
        totalLatencyMs,
        totalRawTriples,
        totalCanonTriples,
        totalCanonEntities,
      },
    };
  }

  const totalDurationMs = Date.now() - totalStart;

  ctx.logger.info(`[UnifiedPipeline] Completed track=${track}`, {
    totalDurationMs,
    mainEntities: mainOutput?.result.meta.summary?.entityCount,
    mainStatements: mainOutput?.result.meta.summary?.statementCount,
    openRawTriples: openOutput?.meta.totalRawTriples,
    openCanonTriples: openOutput?.meta.totalCanonTriples,
    openCanonEntities: openOutput?.meta.totalCanonEntities,
  });

  return {
    track,
    main: mainOutput,
    open: openOutput,
    totalDurationMs,
  };
}
