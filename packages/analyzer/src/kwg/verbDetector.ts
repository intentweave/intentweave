// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Verb Hint Detector — Lightweight verb pattern extraction for KWG edges.
 *
 * Scans sentence text between co-occurring entity mentions and detects
 * verb phrases that suggest directional relationships. These are NOT full
 * triples (that's SKG's job) — they're cheap directional hints stored on
 * CO_OCCURS edges.
 *
 * Design: regex-only, no LLM cost. Confidence is always 0.3–0.6.
 *
 * @see PHASE-D-SPEC.md §5
 * @version 0.1
 */

import type { MentionRecord } from "@intentweave/core";

// =============================================================================
// Types
// =============================================================================

export interface VerbPattern {
  pattern: RegExp;
  predicate: string;
  direction: "forward" | "backward";
}

export interface VerbHint {
  /** Source entity (before the verb) */
  subjectName: string;
  /** Target entity (after the verb) */
  objectName: string;
  /** Detected predicate */
  predicate: string;
  /** Confidence (always low: 0.3–0.6 for regex matches) */
  confidence: number;
  /** Source text snippet for provenance */
  sourceText: string;
  /** File where the pattern was found */
  filePath: string;
}

export interface VerbDetectorResult {
  /** All verb hints found */
  hints: VerbHint[];
  /** Stats */
  stats: {
    pairsScanned: number;
    hintsFound: number;
    byPredicate: Record<string, number>;
  };
}

// =============================================================================
// Verb patterns (regex-based, high-precision only)
// =============================================================================

export const VERB_PATTERNS: VerbPattern[] = [
  // Structural
  { pattern: /\bcontains?\b/i, predicate: "CONTAINS", direction: "forward" },
  {
    pattern: /\bdepends?\s+on\b/i,
    predicate: "DEPENDS_ON",
    direction: "forward",
  },
  { pattern: /\bextends?\b/i, predicate: "EXTENDS", direction: "forward" },
  {
    pattern: /\bimplements?\b/i,
    predicate: "IMPLEMENTS",
    direction: "forward",
  },
  { pattern: /\breplaces?\b/i, predicate: "REPLACES", direction: "forward" },
  { pattern: /\brequires?\b/i, predicate: "REQUIRES", direction: "forward" },

  // Behavioral
  { pattern: /\benables?\b/i, predicate: "ENABLES", direction: "forward" },
  { pattern: /\bblocks?\b/i, predicate: "BLOCKS", direction: "forward" },
  { pattern: /\btriggers?\b/i, predicate: "TRIGGERS", direction: "forward" },
  { pattern: /\bproduces?\b/i, predicate: "PRODUCES", direction: "forward" },
  { pattern: /\bconsumes?\b/i, predicate: "CONSUMES", direction: "forward" },
  { pattern: /\buses?\b/i, predicate: "USES", direction: "forward" },
  { pattern: /\bcalls?\b/i, predicate: "CALLS", direction: "forward" },

  // Decision
  {
    pattern: /\bis\s+(?:an?\s+)?alternative\s+to\b/i,
    predicate: "ALTERNATIVE_TO",
    direction: "forward",
  },
  {
    pattern: /\bsupersedes?\b/i,
    predicate: "SUPERSEDES",
    direction: "forward",
  },
];

// =============================================================================
// Core detector
// =============================================================================

/**
 * Detect verb hints between pairs of co-occurring entity mentions.
 *
 * For each pair of mentions that share the same sentence/chunk, scans the
 * text between them for verb patterns.
 *
 * @param mentions - All entity mentions from KWX stage (sorted by chunkId, startChar)
 * @param windowSize - Sliding window size (default: 2, matching COX)
 * @returns VerbDetectorResult with hints and stats
 */
export function detectVerbHints(
  mentions: MentionRecord[],
  windowSize = 2,
): VerbDetectorResult {
  const hints: VerbHint[] = [];
  const byPredicate: Record<string, number> = {};
  let pairsScanned = 0;

  // Sort by chunkId then startChar (same order as COX)
  const sorted = [...mentions].sort((a, b) => {
    const cmp = a.chunkId.localeCompare(b.chunkId);
    return cmp !== 0 ? cmp : a.startChar - b.startChar;
  });

  // Sliding window (same as COX)
  for (let i = 0; i < sorted.length; i++) {
    const mA = sorted[i];
    for (let j = i + 1; j <= i + windowSize && j < sorted.length; j++) {
      const mB = sorted[j];

      // Skip if different chunks or same entity
      if (mA.chunkId !== mB.chunkId) break;
      if (mA.entityName === mB.entityName) continue;

      pairsScanned++;

      // Use the sentence text that contains both entities
      // Prefer mA.text (sentence around first mention) — usually covers both
      // when they're in the same sentence
      const sentenceText = mA.text;
      if (!sentenceText) continue;

      // Find verb patterns in the sentence
      const detected = scanForVerbs(
        sentenceText,
        mA.entityName,
        mB.entityName,
        mA.filePath,
      );
      if (detected) {
        hints.push(detected);
        byPredicate[detected.predicate] =
          (byPredicate[detected.predicate] ?? 0) + 1;
      }
    }
  }

  // Dedupe: keep the highest-confidence hint per (subject, object, predicate)
  const deduped = dedupeHints(hints);

  return {
    hints: deduped,
    stats: {
      pairsScanned,
      hintsFound: deduped.length,
      byPredicate,
    },
  };
}

// =============================================================================
// Verb scanning
// =============================================================================

/**
 * Scan a sentence for verb patterns between two entities.
 *
 * Returns the first (highest-priority) match, or null if no pattern found.
 */
function scanForVerbs(
  sentence: string,
  entityA: string,
  entityB: string,
  filePath: string,
): VerbHint | null {
  const lower = sentence.toLowerCase();
  const posA = lower.indexOf(entityA.toLowerCase());
  const posB = lower.indexOf(entityB.toLowerCase());

  // Both entities must appear in the sentence
  if (posA < 0 || posB < 0) return null;

  // Determine which entity comes first in the text
  const [first, second, firstPos, secondPos] =
    posA < posB
      ? [entityA, entityB, posA, posB]
      : [entityB, entityA, posB, posA];

  // Extract the text between the two entities
  const between = lower.slice(firstPos + first.length, secondPos).trim();

  // Skip if the gap is too large (probably different sentences)
  if (between.length > 120) return null;
  // Skip if the gap is too small (probably compound word)
  if (between.length < 2) return null;

  // Try each verb pattern
  for (const vp of VERB_PATTERNS) {
    if (vp.pattern.test(between)) {
      const [subject, object] =
        vp.direction === "forward" ? [first, second] : [second, first];

      return {
        subjectName: subject,
        objectName: object,
        predicate: vp.predicate,
        confidence: computeConfidence(between, vp.pattern),
        sourceText: sentence.slice(0, 200),
        filePath,
      };
    }
  }

  return null;
}

/**
 * Compute confidence based on the verb match context.
 *
 * Higher confidence when:
 * - The gap between entities is small (likely same clause)
 * - The verb is the primary verb in the gap (no other verbs competing)
 */
function computeConfidence(between: string, pattern: RegExp): number {
  const base = 0.4;
  // Shorter gap → higher confidence
  const lengthBonus =
    between.length < 20 ? 0.15 : between.length < 50 ? 0.05 : 0;
  // Single verb match → higher confidence (no competing verbs)
  const matches = between.match(pattern);
  const singleMatch = matches && matches.length === 1 ? 0.05 : 0;
  return Math.min(0.6, base + lengthBonus + singleMatch);
}

// =============================================================================
// Deduplication
// =============================================================================

function dedupeHints(hints: VerbHint[]): VerbHint[] {
  const seen = new Map<string, VerbHint>();
  for (const h of hints) {
    const key = `${h.subjectName}|${h.objectName}|${h.predicate}`;
    const existing = seen.get(key);
    if (!existing || h.confidence > existing.confidence) {
      seen.set(key, h);
    }
  }
  return Array.from(seen.values());
}
