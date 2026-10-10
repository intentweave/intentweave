// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KWX Stage — Keyword Extraction
 *
 * Extracts keyword mentions with positions, headings, and signal qualifiers
 * from each input file. Runs per-file (one InStageOutput → one KwxStageOutput).
 *
 * Processing:
 *   1. For each SemanticChunk, run HeuristicKeywordExtractor
 *   2. For each match, extract surrounding sentence and detect qualifiers
 *   3. Emit MentionRecord per match
 *   4. Deduplicate entities: group mentions by normalized name
 *   5. Build KwxStageOutput
 *
 * @version 0.1
 */

import type {
  KwxStageInput,
  KwxStageOutput,
  MentionRecord,
  KwgEntityRecord,
  SignalQualifier,
} from "@intentweave/core";
import { KWG_SCHEMAS, CURRENT_SCHEMA_VERSION } from "@intentweave/core";
import { KwxChunkProcessor } from "./kwxChunkProcessor.js";
import type { KwxChunkProcessorOptions } from "./kwxChunkProcessor.js";
import type { KwxChunkWorkerPool } from "./kwxChunkWorkerPool.js";
import type { PipelineLogger } from "../pipeline/context.js";

// =============================================================================
// Entity Aggregation
// =============================================================================

/**
 * Aggregate mentions into deduplicated entity records.
 */
function aggregateEntities(mentions: MentionRecord[]): KwgEntityRecord[] {
  const byName = new Map<string, MentionRecord[]>();

  for (const m of mentions) {
    const existing = byName.get(m.entityName);
    if (existing) {
      existing.push(m);
    } else {
      byName.set(m.entityName, [m]);
    }
  }

  const entities: KwgEntityRecord[] = [];

  for (const [name, entityMentions] of byName) {
    // Collect unique file paths
    const filePaths = [...new Set(entityMentions.map((m) => m.filePath))];

    // Union of all qualifiers
    const qualifiers = [
      ...new Set(entityMentions.flatMap((m) => m.qualifiers)),
    ] as SignalQualifier[];

    // Predominant source: most common detection method
    const sourceCounts = new Map<string, number>();
    for (const m of entityMentions) {
      sourceCounts.set(m.source, (sourceCounts.get(m.source) ?? 0) + 1);
    }
    let predominantSource = entityMentions[0].source;
    let maxCount = 0;
    for (const [source, count] of sourceCounts) {
      if (count > maxCount) {
        maxCount = count;
        predominantSource = source as MentionRecord["source"];
      }
    }

    entities.push({
      name,
      mentionCount: entityMentions.length,
      filePaths,
      qualifiers,
      predominantSource,
    });
  }

  return entities;
}

// =============================================================================
// KWX Stage
// =============================================================================

export interface KwxStageOptions {
  /** Minimum keyword length (default: 3) */
  minLength?: number;

  /** Annotation depth: 'full' enables body-text dictionary matching */
  depth?: "structured" | "full";

  /** External dictionary of known terms for body-text matching (depth=full) */
  dictionary?: Set<string>;

  /** Reusable opt-in chunk worker pool for an experimental parallel run */
  workerPool?: KwxChunkWorkerPool;
}

/**
 * Run the KWX (keyword extraction) stage on a single file's IN output.
 *
 * @param input   KWX stage input (contains InStageOutput)
 * @param options Optional configuration
 * @param ctx     Optional pipeline context (for logging)
 * @returns       KWX stage output with mentions and entities
 */
export async function runKwxStage(
  input: KwxStageInput,
  options?: KwxStageOptions,
  ctx?: { logger?: PipelineLogger },
): Promise<KwxStageOutput> {
  const start = performance.now();
  const { inOutput } = input;
  const logger = ctx?.logger;

  logger?.debug(`KWX: processing ${inOutput.filePath}`, {
    chunks: inOutput.chunks.length,
  });

  const processorOptions: KwxChunkProcessorOptions = {
    minLength: options?.minLength,
    depth: options?.depth,
    dictionary: options?.dictionary,
  };

  const mentions: MentionRecord[] = [];
  if (options?.workerPool) {
    const chunkMentions = await options.workerPool.processChunks(
      inOutput.filePath,
      inOutput.chunks,
      processorOptions,
    );
    for (const chunkResult of chunkMentions) mentions.push(...chunkResult);
  } else {
    const processor = new KwxChunkProcessor(processorOptions);
    for (const chunk of inOutput.chunks) {
      mentions.push(...processor.process(inOutput.filePath, chunk));
    }
  }

  // Aggregate entities
  const entities = aggregateEntities(mentions);

  const qualifiedMentionCount = mentions.filter(
    (m) => m.qualifiers.length > 0,
  ).length;

  const processingTimeMs = Math.round(performance.now() - start);

  logger?.debug(`KWX: done ${inOutput.filePath}`, {
    mentions: mentions.length,
    entities: entities.length,
    qualified: qualifiedMentionCount,
    timeMs: processingTimeMs,
  });

  return {
    $schema: KWG_SCHEMAS.kwx,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stage: "KWX",
    artifactId: inOutput.artifactId,
    processedAt: new Date().toISOString(),
    filePath: inOutput.filePath,
    mentions,
    entities,
    meta: {
      mentionCount: mentions.length,
      entityCount: entities.length,
      qualifiedMentionCount,
      processingTimeMs,
    },
  };
}
