// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI IDF Scorer
 *
 * Computes Inverse Document Frequency scores for entity names across
 * the document corpus. Terms appearing in many documents get low IDF
 * (common, less discriminative). Terms appearing in few documents get
 * high IDF (specific, more valuable for retrieval).
 *
 * Formula: idf(t) = 1 - (df(t) / N)
 *   - df(t) = number of documents containing term t
 *   - N     = total number of documents
 *   - Result: 0 = appears in every doc, 1 = appears in exactly 1 doc
 *
 * Includes a stopword baseline: ~50 common software filler words
 * receive a fixed low IDF floor (0.15) even in small corpora where
 * statistical IDF wouldn't penalize them.
 */

import type { KwxStageOutput } from "@intentweave/core";
import type { IdfScores } from "./types.js";

// =============================================================================
// Stopword Baseline
// =============================================================================

/**
 * Common filler words in software documentation that should always have
 * low discriminative power, even in small corpora where IDF alone
 * wouldn't catch them. These get a maximum IDF of STOPWORD_CEILING.
 */
const STOPWORD_BASELINE = new Set([
  // Generic software terms
  "system",
  "implementation",
  "approach",
  "solution",
  "overview",
  "configuration",
  "application",
  "component",
  "module",
  "service",
  "function",
  "method",
  "class",
  "interface",
  "type",
  "data",
  "value",
  "result",
  "response",
  "request",
  "process",
  "operation",
  "action",
  "event",
  "handler",
  "state",
  "status",
  "context",
  "scope",
  "instance",
  // Documentation filler
  "example",
  "documentation",
  "description",
  "information",
  "details",
  "section",
  "chapter",
  "guide",
  "reference",
  "note",
  // Architecture filler
  "layer",
  "level",
  "step",
  "stage",
  "phase",
  "input",
  "output",
  "parameter",
  "argument",
  "option",
  "error",
  "issue",
  "problem",
  "update",
  "change",
  "file",
  "directory",
  "path",
  "name",
  "list",
]);

/** Maximum IDF score for stopword baseline terms. */
const STOPWORD_CEILING = 0.15;

/** Exported for testing. */
export { STOPWORD_BASELINE, STOPWORD_CEILING };

/**
 * Compute IDF scores from KWX outputs.
 *
 * Each KWX output represents one document. The entity names within
 * it are the "terms". IDF = 1 - (doc_freq / total_docs).
 */
export function computeIdf(kwxOutputs: KwxStageOutput[]): IdfScores {
  const totalDocs = kwxOutputs.length;
  if (totalDocs === 0) return new Map();

  // Count how many documents each entity appears in
  const docFreq = new Map<string, number>();

  for (const kwx of kwxOutputs) {
    // Collect unique entity names per document
    const seen = new Set<string>();
    for (const mention of kwx.mentions) {
      const key = mention.entityName.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        docFreq.set(key, (docFreq.get(key) ?? 0) + 1);
      }
    }
  }

  // Compute IDF: 1 - (df / N), then apply stopword ceiling
  const scores: IdfScores = new Map();
  for (const [term, df] of docFreq) {
    let idf = 1 - df / totalDocs;

    // Apply stopword ceiling: known filler words get capped
    if (STOPWORD_BASELINE.has(term)) {
      idf = Math.min(idf, STOPWORD_CEILING);
    }

    scores.set(term, idf);
  }

  // Also ensure any stopword not yet in the corpus gets a low score
  // (defensive: in case a stopword appears in only 1 doc via dictionary matching)
  for (const word of STOPWORD_BASELINE) {
    if (!scores.has(word)) {
      scores.set(word, STOPWORD_CEILING);
    }
  }

  return scores;
}
