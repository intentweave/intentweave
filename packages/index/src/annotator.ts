// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Annotation Engine
 *
 * Matches KWX mention records to AX code symbols to produce grounded
 * annotations. Three matching strategies (highest confidence first):
 *
 * 1. Exact  — mention text matches symbol name exactly (case-insensitive)
 * 2. Slug   — slug(mention) matches slug(symbol.name) e.g. "co-occurrence" → "cooccurrence"
 * 3. Token  — any token in the mention appears as a symbol name
 *
 * Unmatched mentions become "ungrounded" annotations (symbolId = null)
 * which are still useful for full-text search and IDF scoring.
 */

import type { AxOutput, AxSymbol } from "@intentweave/analyzer";
import type { KwxStageOutput, MentionRecord } from "@intentweave/core";
import type { Annotation, MatchType, IdfScores } from "./types.js";

// =============================================================================
// Public API
// =============================================================================

export interface AnnotateOptions {
  /** IDF scores — if provided, annotations get idfScore field */
  idfScores?: IdfScores;

  /**
   * When true, apply IDF as a confidence multiplier on body-text
   * annotations (source = "dictionary" or "identifier").
   * This penalizes ubiquitous terms like "system" or "data".
   * Structured sources (heading, bold, code-span) are not penalized.
   */
  applyIdfPenalty?: boolean;

  /** Minimum confidence to include (default: 0) */
  minConfidence?: number;

  /** Log callback */
  log?: (msg: string) => void;
}

/**
 * Produce annotations by matching KWX mentions to AX symbol names.
 *
 * @returns annotations sorted by (docPath, line)
 */
export function annotate(
  ax: AxOutput,
  kwxOutputs: KwxStageOutput[],
  opts?: AnnotateOptions,
): Annotation[] {
  const minConf = opts?.minConfidence ?? 0;

  // Build symbol lookup indexes
  const { byExactName, bySlug, allNames } = buildSymbolIndex(ax);

  const annotations: Annotation[] = [];

  for (const kwx of kwxOutputs) {
    for (const mention of kwx.mentions) {
      const match = matchMention(mention, byExactName, bySlug, allNames);

      let confidence = match.confidence;
      const idfScore = opts?.idfScores?.get(normalizeForIdf(mention.entityName));

      // Apply IDF penalty for body-text sources when enabled.
      // Low-IDF terms (appearing in many docs) get reduced confidence.
      // Structured sources (heading, bold, code-span) are exempt.
      if (
        opts?.applyIdfPenalty &&
        idfScore !== undefined &&
        (mention.source === "dictionary" || mention.source === "identifier")
      ) {
        confidence *= Math.max(idfScore, 0.1); // floor at 0.1 to avoid zeroing out
      }

      if (confidence < minConf) continue;

      annotations.push({
        docPath: mention.filePath,
        line: mention.startLine,
        text: mention.entityName,
        symbolId: match.symbolId,
        confidence,
        source: mention.source,
        qualifier: mention.qualifiers[0],
        idfScore,
      });
    }
  }

  // Sort by (docPath, line)
  annotations.sort((a, b) => a.docPath.localeCompare(b.docPath) || a.line - b.line);

  opts?.log?.(
    `Annotated: ${annotations.length} total, ` +
      `${annotations.filter((a) => a.symbolId).length} grounded, ` +
      `${annotations.filter((a) => !a.symbolId).length} ungrounded`,
  );

  return annotations;
}

// =============================================================================
// Symbol Index
// =============================================================================

interface SymbolIndex {
  /** Exact name → symbol ID (first match wins for duplicates) */
  byExactName: Map<string, string>;

  /** Slug → symbol ID */
  bySlug: Map<string, string>;

  /** Set of all lowercase symbol names (for token matching) */
  allNames: Set<string>;
}

function buildSymbolIndex(ax: AxOutput): SymbolIndex {
  const byExactName = new Map<string, string>();
  const bySlug = new Map<string, string>();
  const allNames = new Set<string>();

  for (const file of ax.files) {
    for (const sym of file.symbols) {
      const lower = sym.name.toLowerCase();
      allNames.add(lower);

      // Prefer exported symbols over internal ones
      if (!byExactName.has(lower) || sym.export === "exported") {
        byExactName.set(lower, sym.id);
      }

      const slug = toSlug(sym.name);
      if (!bySlug.has(slug) || sym.export === "exported") {
        bySlug.set(slug, sym.id);
      }
    }
  }

  return { byExactName, bySlug, allNames };
}

// =============================================================================
// Matching
// =============================================================================

interface MatchResult {
  symbolId: string | null;
  matchType: MatchType;
  confidence: number;
}

function matchMention(
  mention: MentionRecord,
  byExactName: Map<string, string>,
  bySlug: Map<string, string>,
  allNames: Set<string>,
): MatchResult {
  const mentionLower = mention.entityName.toLowerCase().trim();

  // 1. Exact match
  const exact = byExactName.get(mentionLower);
  if (exact) {
    return { symbolId: exact, matchType: "exact", confidence: 1.0 };
  }

  // 2. Slug match
  const mentionSlug = toSlug(mention.entityName);
  const slugMatch = bySlug.get(mentionSlug);
  if (slugMatch && mentionSlug.length >= 3) {
    return { symbolId: slugMatch, matchType: "slug", confidence: 0.8 };
  }

  // 3. Token overlap — split mention into tokens, check if any is a symbol name
  const tokens = tokenize(mention.entityName);
  for (const token of tokens) {
    if (token.length < 3) continue;
    const tokenMatch = byExactName.get(token);
    if (tokenMatch) {
      return { symbolId: tokenMatch, matchType: "token", confidence: 0.5 };
    }
  }

  // 4. Heading mentions get a small confidence bump (structural signal)
  if (mention.source === "heading") {
    return { symbolId: null, matchType: "heading", confidence: 0.3 };
  }

  // 5. Ungrounded
  return { symbolId: null, matchType: "ungrounded", confidence: 0.1 };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a name to a slug: lowercase, remove non-alphanumeric, collapse.
 * "co-occurrence" → "cooccurrence", "TcgPipeline" → "tcgpipeline"
 */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Split a name into tokens by common separators (camelCase, kebab, snake, space).
 */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase split
    .replace(/[-_./]/g, " ") // kebab/snake/path split
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Normalize a term for IDF lookup (lowercase, trim).
 */
function normalizeForIdf(term: string): string {
  return term.toLowerCase().trim();
}
