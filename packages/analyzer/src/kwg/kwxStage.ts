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
  KeywordMatch,
  SignalQualifier,
  SemanticChunk,
} from "@intentweave/core";
import { KWG_SCHEMAS, CURRENT_SCHEMA_VERSION } from "@intentweave/core";
import { HeuristicKeywordExtractor } from "./heuristicExtractor.js";
import { RegexQualifierDetector } from "./regexQualifier.js";
import type { PipelineLogger } from "../pipeline/context.js";

// =============================================================================
// Sentence Extraction
// =============================================================================

/**
 * Extract the sentence surrounding a character offset in a text.
 *
 * Splits on sentence-ending punctuation (., !, ?) followed by whitespace or EOL.
 * Falls back to returning a window of ±120 chars if no sentence boundary is found.
 */
function extractSentence(text: string, offset: number): string {
  // Simple sentence splitting: look for sentence boundaries
  const sentenceBreakRe = /[.!?]\s+|\n\n/g;
  let sentenceStart = 0;
  let sentenceEnd = text.length;

  let match: RegExpExecArray | null;
  let prevEnd = 0;

  while ((match = sentenceBreakRe.exec(text)) !== null) {
    const breakEnd = match.index + match[0].length;
    if (breakEnd <= offset) {
      sentenceStart = breakEnd;
    }
    if (match.index >= offset && sentenceEnd === text.length) {
      sentenceEnd = match.index + 1; // Include the period
      break;
    }
    prevEnd = breakEnd;
  }

  // Fallback: window of ±120 chars
  if (sentenceEnd - sentenceStart > 300) {
    sentenceStart = Math.max(0, offset - 120);
    sentenceEnd = Math.min(text.length, offset + 120);
  }

  return text.slice(sentenceStart, sentenceEnd).trim();
}

/**
 * Find the current heading context for a chunk.
 * Returns the title if the chunk is a heading/section, or the heading
 * from the chunk's metadata otherwise.
 */
function getHeadingContext(chunk: SemanticChunk): string | undefined {
  if (chunk.type === "heading" || chunk.type === "section") {
    return chunk.title;
  }
  // chunk.metadata may contain heading context set during IN stage
  return chunk.metadata?.heading as string | undefined;
}

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

  const extractor = new HeuristicKeywordExtractor({
    minLength: options?.minLength,
    depth: options?.depth,
    dictionary: options?.dictionary,
  });
  const qualifierDetector = new RegexQualifierDetector();

  const mentions: MentionRecord[] = [];

  for (const chunk of inOutput.chunks) {
    const heading = getHeadingContext(chunk);

    // Extract keywords from chunk content
    const kwMatches: KeywordMatch[] = extractor.extract(
      chunk.content,
      heading,
    );

    for (const kw of kwMatches) {
      // Extract sentence context around the keyword
      const sentence = extractSentence(chunk.content, kw.offset);

      // Detect signal qualifiers
      const qualifiers = qualifierDetector.detect(kw, sentence);

      // Build mention record
      const mention: MentionRecord = {
        entityName: kw.name,
        text: sentence,
        heading,
        filePath: inOutput.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        startChar: kw.offset,
        endChar: kw.offset + kw.length,
        qualifiers,
        source: kw.source,
        chunkId: chunk.id,
        chunkType: chunk.type,
      };

      mentions.push(mention);
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
