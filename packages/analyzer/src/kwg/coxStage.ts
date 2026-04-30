// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * COX Stage — Co-occurrence
 *
 * Computes co-occurrence edges between keyword entities using a sliding
 * window over mentions. Runs at session level after all KWX outputs are ready.
 *
 * Algorithm:
 *   1. Per-document: sort mentions by (chunkId, startChar), slide window
 *   2. For each pair within the window: emit local edge (entityA, entityB)
 *   3. Session aggregation: group by (entityA, entityB), sum counts
 *   4. Filter: keep edges with count >= minCount
 *   5. Normalize scores
 *
 * Co-occurrence is computed per-document only — a sentence in file A has
 * no textual proximity to a sentence in file B. Cross-file aggregation
 * sums counts from independent per-document windows.
 *
 * @version 0.1
 */

import type {
  CoxStageInput,
  CoxStageOutput,
  CoOccurrenceEdge,
  MentionRecord,
  KwxStageOutput,
} from "@intentweave/core";
import { KWG_SCHEMAS, CURRENT_SCHEMA_VERSION } from "@intentweave/core";
import type { PipelineLogger } from "../pipeline/context.js";

// =============================================================================
// Constants (hardcoded in v1, configurable in v2)
// =============================================================================

/** How many subsequent mentions to consider in the sliding window */
const WINDOW_SIZE = 2;

/** Minimum co-occurrence count to create an edge */
const MIN_COUNT = 2;

// =============================================================================
// Local Edge (intermediate)
// =============================================================================

interface LocalEdge {
  entityA: string;
  entityB: string;
  filePath: string;
}

// =============================================================================
// Sliding Window Co-occurrence
// =============================================================================

/**
 * Compute local co-occurrence edges for a single document.
 *
 * Sorts mentions by (chunkId, startChar) to preserve document order,
 * then slides a window of size `windowSize` to find co-occurring pairs.
 */
function computeDocumentEdges(
  kwxOutput: KwxStageOutput,
  windowSize: number,
): LocalEdge[] {
  const mentions = [...kwxOutput.mentions];

  // Sort by document order: chunkId then startChar
  mentions.sort((a, b) => {
    const cmp = a.chunkId.localeCompare(b.chunkId);
    if (cmp !== 0) return cmp;
    return a.startChar - b.startChar;
  });

  const edges: LocalEdge[] = [];

  for (let i = 0; i < mentions.length; i++) {
    const limit = Math.min(i + windowSize, mentions.length - 1);
    for (let j = i + 1; j <= limit; j++) {
      const a = mentions[i].entityName;
      const b = mentions[j].entityName;

      // Skip self-co-occurrence
      if (a === b) continue;

      // Canonical ordering: alphabetically smaller first
      const [entityA, entityB] = a < b ? [a, b] : [b, a];

      edges.push({
        entityA,
        entityB,
        filePath: kwxOutput.filePath,
      });
    }
  }

  return edges;
}

/**
 * Aggregate local edges from all documents into session-level edges.
 *
 * Groups by (entityA, entityB), sums counts, collects file paths,
 * and filters by minimum count.
 */
function aggregateEdges(
  localEdges: LocalEdge[],
  minCount: number,
): CoOccurrenceEdge[] {
  // Group by edge key
  const groups = new Map<
    string,
    { entityA: string; entityB: string; count: number; filePaths: Set<string> }
  >();

  for (const edge of localEdges) {
    const key = `${edge.entityA}|||${edge.entityB}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.filePaths.add(edge.filePath);
    } else {
      groups.set(key, {
        entityA: edge.entityA,
        entityB: edge.entityB,
        count: 1,
        filePaths: new Set([edge.filePath]),
      });
    }
  }

  // Find max count for normalization
  let maxCount = 1;
  for (const group of groups.values()) {
    if (group.count > maxCount) maxCount = group.count;
  }

  // Filter + build result
  const edges: CoOccurrenceEdge[] = [];
  for (const group of groups.values()) {
    if (group.count < minCount) continue;

    edges.push({
      entityA: group.entityA,
      entityB: group.entityB,
      count: group.count,
      score: group.count / maxCount, // Simple normalization in v1
      filePaths: [...group.filePaths].sort(),
    });
  }

  // Sort by score descending for deterministic output
  edges.sort((a, b) => b.score - a.score || a.entityA.localeCompare(b.entityA));

  return edges;
}

// =============================================================================
// COX Stage
// =============================================================================

/**
 * Run the COX (co-occurrence) stage at session level.
 *
 * @param input   COX stage input (all KWX outputs)
 * @param ctx     Optional pipeline context (for logging)
 * @returns       COX stage output with co-occurrence edges
 */
export async function runCoxStage(
  input: CoxStageInput,
  ctx?: { logger?: PipelineLogger },
): Promise<CoxStageOutput> {
  const start = performance.now();
  const logger = ctx?.logger;

  logger?.info(
    `COX: computing co-occurrence for ${input.kwxOutputs.length} file(s)`,
    {
      windowSize: WINDOW_SIZE,
      minCount: MIN_COUNT,
    },
  );

  // Step 1: Compute per-document local edges
  const allLocalEdges: LocalEdge[] = [];
  for (const kwxOutput of input.kwxOutputs) {
    const docEdges = computeDocumentEdges(kwxOutput, WINDOW_SIZE);
    // Avoid variadic push with very large arrays, which can overflow call stack.
    for (const edge of docEdges) {
      allLocalEdges.push(edge);
    }
  }

  logger?.debug(
    `COX: ${allLocalEdges.length} local edge(s) from sliding window`,
  );

  // Step 2: Aggregate and filter
  const edges = aggregateEdges(allLocalEdges, MIN_COUNT);

  const processingTimeMs = Math.round(performance.now() - start);

  logger?.info(`COX: done`, {
    edges: edges.length,
    pairsConsidered: allLocalEdges.length,
    timeMs: processingTimeMs,
  });

  return {
    $schema: KWG_SCHEMAS.cox,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stage: "COX",
    processedAt: new Date().toISOString(),
    edges,
    meta: {
      edgeCount: edges.length,
      pairsConsidered: allLocalEdges.length,
      windowType: `sliding-${WINDOW_SIZE}`,
      processingTimeMs,
    },
  };
}
