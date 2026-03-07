/**
 * Pipeline Orchestrator
 * 
 * Orchestrates the full analysis pipeline for a set of artifacts.
 * 
 * Pipeline: IN → RX (with REF) → CX → MX → PX (per artifact)
 * 
 * Responsibilities:
 * - Initialize run metadata (run.meta.json)
 * - Execute stages in sequence per artifact
 * - Write stage outputs to artifact store
 * - Update run metadata on completion/failure
 * - Provide progress callbacks
 * 
 * Note: REF (reference resolution) is now integrated into RX stage output.
 * RX output always contains REF-resolved statements, ensuring safety for MX.
 */

import type { Chunk, ExtractionHooks, DEFAULT_HOOKS } from '@intentweave/core';
import type { PipelineContext, PipelineRunMeta } from './context.js';
import { createRunMeta, completeRunMeta, failRunMeta } from './context.js';

// Stage imports
import { runInStage, type InStageInput, type InStageOutput } from '../stages/in.js';
import { runRxStage, type RxStageInput, type RxStageOutput } from '../stages/rx.js';
import { validatePredicateSchema } from '../stages/ref.js'; // REF resolution now in RX
import { runCxStage, type CxStageInput, type CxStageOutput } from '../stages/cx.js';
import { runMxStage, type MxStageInput, type MxStageOutput } from '../stages/mx.js';
import { runPxStage, type PxStageInput, type PxStageOutput } from '../stages/px.js';
import { runAggregation, type AggregateOutput } from './aggregation.js';

// =============================================================================
// Orchestrator Types
// =============================================================================

/**
 * Artifact input for pipeline processing
 */
export interface ArtifactInput {
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Raw file content */
  content: string;
  /** Optional artifact format override */
  artifactFormat?: string;
  /** Optional artifact role override */
  artifactRole?: string;
}

/**
 * Pipeline stage progress
 */
export type PipelineStage = 'IN' | 'RX' | 'CX' | 'MX' | 'PX' | 'AGG';

/**
 * Progress callback
 */
export interface PipelineProgress {
  /** Current artifact being processed */
  artifactId: string;
  /** Current stage */
  stage: PipelineStage;
  /** Artifact index (1-based) */
  artifactIndex: number;
  /** Total artifacts */
  totalArtifacts: number;
  /** Overall progress (0-1) */
  progress: number;
}

/**
 * Progress callback function
 */
export type ProgressCallback = (progress: PipelineProgress) => void;

/**
 * Orchestrator options
 */
export interface OrchestratorOptions {
  /** Progress callback */
  onProgress?: ProgressCallback;
  /** Whether to continue on artifact errors */
  continueOnError?: boolean;
  /** Whether to write outputs to artifact store */
  writeOutputs?: boolean;
  /** Maximum chunk size in characters for IN stage (default: 4000 ≈ 1k tokens) */
  maxChunkSize?: number;
}

const DEFAULT_OPTIONS: Required<Omit<OrchestratorOptions, 'maxChunkSize'>> & Pick<OrchestratorOptions, 'maxChunkSize'> = {
  onProgress: () => {},
  continueOnError: false,
  writeOutputs: true,
  maxChunkSize: undefined, // Use IN stage default (4000)
};

/**
 * Per-artifact output bundle
 */
export interface ArtifactPipelineOutput {
  artifactId: string;
  artifactType?: string;
  in: InStageOutput;
  rx: RxStageOutput;
  cx: CxStageOutput;
  mx: MxStageOutput;
  px: PxStageOutput;
}

/**
 * Full pipeline run result
 */
export interface PipelineRunResult {
  /** Run metadata */
  meta: PipelineRunMeta;
  /** Per-artifact outputs */
  artifacts: ArtifactPipelineOutput[];
  /** Aggregate output (cross-artifact analysis) */
  aggregate?: AggregateOutput;
  /** Errors by artifact ID (if continueOnError is true) */
  errors: Map<string, Error>;
}

// =============================================================================
// Orchestrator Implementation
// =============================================================================

/**
 * Run stages IN → RX → CX → MX → PX for a single artifact
 * 
 * This is the UNIFIED entry point for both CLI and server:
 * - CLI: Calls this with hooks = {} (via runPipeline)
 * - Server: Calls this directly with hooks = { context, events, budget, trace }
 * 
 * DESIGN PRINCIPLE: Same stages, same logic, different hooks.
 * 
 * @param artifact - Artifact input (content, paths, metadata)
 * @param ctx - Pipeline context (providers, store, logger)
 * @param hooks - Optional extraction hooks (context, events, budget, trace, strategy)
 * @param options - Options for progress and output writing
 * @returns ArtifactPipelineOutput with all stage results
 */
export async function runStagesForArtifact(
  artifact: ArtifactInput,
  ctx: PipelineContext,
  hooks: ExtractionHooks = {},
  options: { 
    writeOutputs?: boolean;
    onStage?: (stage: PipelineStage) => void;
  } = {}
): Promise<ArtifactPipelineOutput> {
  const { artifactId, filePath, content, artifactFormat, artifactRole } = artifact;
  const { writeOutputs = false, onStage } = options;
  
  // Emit stage start events via hooks
  hooks.events?.emit('artifact.start', { artifactId, filePath });
  
  // === IN Stage ===
  onStage?.('IN');
  hooks.events?.emit('stage.start', { stage: 'IN', artifactId });
  
  const inInput: InStageInput = {
    artifactId,
    filePath,
    content,
    artifactFormat,
    artifactRole,
  };
  const inOutput = await runInStage(inInput, ctx);
  
  hooks.events?.emit('stage.complete', { stage: 'IN', artifactId });
  
  if (writeOutputs) {
    await ctx.store.writeStageOutput(artifactId, 'IN', inOutput);
  }
  
  // === RX Stage ===
  onStage?.('RX');
  // Note: RX stage emits its own events via hooks.events
  
  // Convert IN chunks to RX-compatible chunks
  const rxChunks: Chunk[] = inOutput.chunks.map(chunk => ({
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
  
  // Pass hooks to RX stage for context/budget/strategy integration
  const rxOutput = await runRxStage(rxInput, {
    extractionProvider: ctx.providers.extraction,
    profile: {
      name: ctx.profile.name,
      artifactRole: inOutput.artifactRole,
    },
  }, hooks);
  
  if (writeOutputs) {
    await ctx.store.writeStageOutput(artifactId, 'RX', rxOutput);
  }
  
  // REF is now integrated into RX - statements are pre-resolved
  // Log REF stats from RX meta if available
  if (rxOutput.meta.refStats) {
    ctx.logger.debug(`[Pipeline] REF (in RX) resolved statement references`, {
      resolved: rxOutput.meta.refStats.resolved,
      unresolved: rxOutput.meta.refStats.unresolved,
      ambiguous: rxOutput.meta.refStats.ambiguous,
    });
  }
  
  // === P0: Predicate Schema Validation ===
  const schemaResult = validatePredicateSchema(rxOutput.entities, rxOutput.statements);
  if (!schemaResult.valid) {
    ctx.logger.warn(`[Pipeline] Predicate schema violations detected`, {
      violations: schemaResult.violations.length,
      byPredicate: schemaResult.stats.byPredicate,
    });
    // Log individual violations for debugging
    for (const v of schemaResult.violations.slice(0, 5)) {
      ctx.logger.debug(`[Pipeline] Schema violation: ${v.predicate} ${v.field} is ${v.actualType}, expected ${v.expectedTypes.join('|')}`, {
        cgId: v.cgId,
      });
    }
  }
  
  // === CX Stage ===
  onStage?.('CX');
  hooks.events?.emit('stage.start', { stage: 'CX', artifactId });
  
  const cxInput: CxStageInput = {
    artifactId,
    rxOutput, // RX output now has pre-resolved statements
    // CX uses context.priorSnapshot from hooks if available
    ...(hooks.context ? {} : {}), // TODO: Wire priorSnapshot from hooks.context into CX
  };
  const cxOutput = await runCxStage(cxInput, ctx);
  
  hooks.events?.emit('stage.complete', { stage: 'CX', artifactId });
  
  if (writeOutputs) {
    await ctx.store.writeStageOutput(artifactId, 'CX', cxOutput);
  }
  
  // === MX Stage ===
  onStage?.('MX');
  hooks.events?.emit('stage.start', { stage: 'MX', artifactId });
  
  const mxInput: MxStageInput = {
    artifactId,
    cxOutput,
  };
  const mxOutput = await runMxStage(mxInput, ctx);
  
  hooks.events?.emit('stage.complete', { stage: 'MX', artifactId });
  
  if (writeOutputs) {
    await ctx.store.writeStageOutput(artifactId, 'MX', mxOutput);
  }
  
  // === PX Stage ===
  onStage?.('PX');
  hooks.events?.emit('stage.start', { stage: 'PX', artifactId });
  
  const pxInput: PxStageInput = {
    artifactId,
    filePath,
    mxOutput,
    artifactRole: inOutput.artifactRole,  // Pass role from IN stage
  };
  const pxOutput = await runPxStage(pxInput, ctx);
  
  hooks.events?.emit('stage.complete', { stage: 'PX', artifactId });
  
  if (writeOutputs) {
    await ctx.store.writeStageOutput(artifactId, 'PX', pxOutput);
  }
  
  // Emit artifact complete event
  hooks.events?.emit('artifact.complete', {
    artifactId,
    entities: cxOutput.entities.length,
    statements: cxOutput.statements.length,
  });
  
  ctx.logger.info(`Completed artifact ${artifactId}`, {
    entities: cxOutput.entities.length,
    statements: cxOutput.statements.length,
  });
  
  return {
    artifactId,
    artifactType: artifact.artifactRole,
    in: inOutput,
    rx: rxOutput,
    cx: cxOutput,
    mx: mxOutput,
    px: pxOutput,
  };
}

/**
 * Run the full analysis pipeline on a set of artifacts
 */
export async function runPipeline(
  artifacts: ArtifactInput[],
  ctx: PipelineContext,
  options: OrchestratorOptions = {}
): Promise<PipelineRunResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { onProgress, continueOnError, writeOutputs } = opts;
  
  // Initialize run metadata
  let runMeta = createRunMeta(ctx);
  
  // Add extraction configuration metadata for parity evaluation
  // Use requested/effective structure for drift detection
  if (ctx.providers.extraction && 'getConfigMetadata' in ctx.providers.extraction) {
    const extractionMeta = (ctx.providers.extraction as any).getConfigMetadata();
    
    // Get model name and max tokens from LLM provider
    let modelName = 'unknown';
    let maxOutputTokens = 16384;
    
    if ('getModelName' in ctx.providers.llm) {
      modelName = (ctx.providers.llm as any).getModelName();
    }
    if ('getMaxOutputTokens' in ctx.providers.llm) {
      maxOutputTokens = (ctx.providers.llm as any).getMaxOutputTokens();
    }
    
    const temperature = extractionMeta.temperature ?? 0.1;
    const extractionMode = extractionMeta.extractionMode ?? 'single-pass';
    const provider = extractionMeta.provider ?? 'unknown';
    
    runMeta.extractionConfig = {
      requested: {
        model: modelName,
        temperature,
        maxOutputTokens,
        extractionMode,
        provider,
      },
      // Effective values will be populated after extraction
      // (may differ if provider clamps or overrides settings)
      effective: {
        model: modelName,
        temperature,
        maxOutputTokens,
      },
    };
  }
  
  const artifactOutputs: ArtifactPipelineOutput[] = [];
  const errors = new Map<string, Error>();
  
  // Write initial run.meta.json
  if (writeOutputs) {
    await ctx.store.writeRunMeta(ctx.runId, runMeta);
  }
  
  ctx.logger.info(`Starting pipeline run ${ctx.runId}`, {
    artifacts: artifacts.length,
    profile: ctx.profile.name,
  });
  
  const totalStages = 5; // IN, RX, CX, MX, PX
  const totalSteps = artifacts.length * totalStages;
  let currentStep = 0;
  
  try {
    // Process each artifact
    for (let i = 0; i < artifacts.length; i++) {
      const artifact = artifacts[i];
      const { artifactId, filePath, content, artifactFormat, artifactRole } = artifact;
      
      ctx.logger.info(`Processing artifact ${i + 1}/${artifacts.length}: ${artifactId}`);
      
      try {
        // === IN Stage ===
        const inProgress = () => {
          currentStep++;
          onProgress({
            artifactId,
            stage: 'IN',
            artifactIndex: i + 1,
            totalArtifacts: artifacts.length,
            progress: currentStep / totalSteps,
          });
        };
        inProgress();
        
        const inInput: InStageInput = {
          artifactId,
          filePath,
          content,
          artifactFormat,
          artifactRole,
        };
        const inStageOptions = opts.maxChunkSize ? { maxChunkSize: opts.maxChunkSize } : {};
        const inOutput = await runInStage(inInput, ctx, inStageOptions);
        
        if (writeOutputs) {
          await ctx.store.writeStageOutput(artifactId, 'IN', inOutput);
        }
        
        // === RX Stage ===
        currentStep++;
        onProgress({
          artifactId,
          stage: 'RX',
          artifactIndex: i + 1,
          totalArtifacts: artifacts.length,
          progress: currentStep / totalSteps,
        });
        
        // Convert IN chunks to RX-compatible chunks
        const rxChunks: Chunk[] = inOutput.chunks.map(chunk => ({
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
        const rxOutput = await runRxStage(rxInput, {
          extractionProvider: ctx.providers.extraction,
          profile: {
            name: ctx.profile.name,
            artifactRole: inOutput.artifactRole,
          },
        });
        
        if (writeOutputs) {
          await ctx.store.writeStageOutput(artifactId, 'RX', rxOutput);
        }
        
        // REF is now integrated into RX - statements are pre-resolved
        // Log REF stats from RX meta if available
        if (rxOutput.meta.refStats) {
          ctx.logger.debug(`REF (in RX) resolved statement references for ${artifactId}`, {
            resolved: rxOutput.meta.refStats.resolved,
            unresolved: rxOutput.meta.refStats.unresolved,
            ambiguous: rxOutput.meta.refStats.ambiguous,
          });
        }
        
        // === P0: Predicate Schema Validation ===
        const schemaResult = validatePredicateSchema(rxOutput.entities, rxOutput.statements);
        if (!schemaResult.valid) {
          ctx.logger.warn(`Predicate schema violations detected for ${artifactId}`, {
            violations: schemaResult.violations.length,
            byPredicate: schemaResult.stats.byPredicate,
          });
        }
        
        // === CX Stage ===
        currentStep++;
        onProgress({
          artifactId,
          stage: 'CX',
          artifactIndex: i + 1,
          totalArtifacts: artifacts.length,
          progress: currentStep / totalSteps,
        });
        
        const cxInput: CxStageInput = {
          artifactId,
          rxOutput, // RX output now has pre-resolved statements
        };
        const cxOutput = await runCxStage(cxInput, ctx);
        
        if (writeOutputs) {
          await ctx.store.writeStageOutput(artifactId, 'CX', cxOutput);
        }
        
        // === MX Stage ===
        currentStep++;
        onProgress({
          artifactId,
          stage: 'MX',
          artifactIndex: i + 1,
          totalArtifacts: artifacts.length,
          progress: currentStep / totalSteps,
        });
        
        const mxInput: MxStageInput = {
          artifactId,
          cxOutput,
        };
        const mxOutput = await runMxStage(mxInput, ctx);
        
        if (writeOutputs) {
          await ctx.store.writeStageOutput(artifactId, 'MX', mxOutput);
        }
        
        // === PX Stage ===
        currentStep++;
        onProgress({
          artifactId,
          stage: 'PX',
          artifactIndex: i + 1,
          totalArtifacts: artifacts.length,
          progress: currentStep / totalSteps,
        });
        
        const pxInput: PxStageInput = {
          artifactId,
          filePath,
          mxOutput,
          artifactRole: inOutput.artifactRole,  // Pass role from IN stage
        };
        const pxOutput = await runPxStage(pxInput, ctx);
        
        if (writeOutputs) {
          await ctx.store.writeStageOutput(artifactId, 'PX', pxOutput);
        }
        
        // Collect artifact output
        artifactOutputs.push({
          artifactId,
          in: inOutput,
          rx: rxOutput,
          cx: cxOutput,
          mx: mxOutput,
          px: pxOutput,
        });
        
        // Update run metadata
        runMeta.artifacts.push(artifactId);
        runMeta.stages = ['IN', 'RX', 'CX', 'MX', 'PX'];
        
        ctx.logger.info(`Completed artifact ${artifactId}`, {
          entities: cxOutput.entities.length,
          statements: cxOutput.statements.length,
        });
        
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        ctx.logger.error(`Error processing artifact ${artifactId}`, { error: err.message });
        
        if (continueOnError) {
          errors.set(artifactId, err);
          // Skip to next artifact
          currentStep = (i + 1) * totalStages;
        } else {
          // Fail the entire run
          runMeta = failRunMeta(runMeta, err.message, ctx.timestamp());
          if (writeOutputs) {
            await ctx.store.writeRunMeta(ctx.runId, runMeta);
          }
          throw err;
        }
      }
    }
    
    // Run aggregation stage (cross-artifact analysis)
    let aggregateOutput: AggregateOutput | undefined;
    if (artifactOutputs.length > 0) {
      ctx.logger.info('Running aggregation stage (AGG)', {
        artifactCount: artifactOutputs.length,
      });
      
      const pxOutputs = artifactOutputs.map(a => a.px);
      aggregateOutput = await runAggregation(
        { 
          artifactOutputs: pxOutputs,
          runId: ctx.runId,
        },
        ctx
      );
      
      // Update stages to include AGG
      if (!runMeta.stages.includes('AGG')) {
        runMeta.stages.push('AGG');
      }
      
      ctx.logger.debug('Aggregation complete', {
        entities: aggregateOutput.entities.length,
        statements: aggregateOutput.statements.length,
        lxProposals: aggregateOutput.lxProposals.length,
        findings: aggregateOutput.findings.findings.length,
      });
    }
    
    // Calculate summary
    const summary = {
      entityCount: artifactOutputs.reduce((sum, a) => sum + a.cx.entities.length, 0),
      statementCount: artifactOutputs.reduce((sum, a) => sum + a.cx.statements.length, 0),
      artifactCount: artifactOutputs.length,
    };
    
    // Complete run metadata
    runMeta = completeRunMeta(runMeta, summary, ctx.timestamp());
    
    if (writeOutputs) {
      await ctx.store.writeRunMeta(ctx.runId, runMeta);
    }
    
    ctx.logger.info(`Pipeline run ${ctx.runId} completed`, {
      artifacts: artifactOutputs.length,
      entities: summary.entityCount,
      statements: summary.statementCount,
      durationMs: runMeta.durationMs,
    });
    
    return {
      meta: runMeta,
      artifacts: artifactOutputs,
      aggregate: aggregateOutput,
      errors,
    };
    
  } catch (error) {
    // Handle top-level errors
    const err = error instanceof Error ? error : new Error(String(error));
    
    if (runMeta.status !== 'failed') {
      runMeta = failRunMeta(runMeta, err.message, ctx.timestamp());
      if (writeOutputs) {
        await ctx.store.writeRunMeta(ctx.runId, runMeta);
      }
    }
    
    throw err;
  }
}

/**
 * Run pipeline on a single artifact (convenience wrapper)
 */
export async function runSingleArtifact(
  artifact: ArtifactInput,
  ctx: PipelineContext,
  options?: OrchestratorOptions
): Promise<ArtifactPipelineOutput> {
  const result = await runPipeline([artifact], ctx, options);
  
  if (result.artifacts.length === 0) {
    throw new Error(`No output for artifact ${artifact.artifactId}`);
  }
  
  return result.artifacts[0];
}
