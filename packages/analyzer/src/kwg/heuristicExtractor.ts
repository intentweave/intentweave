// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * HeuristicKeywordExtractor — extracts keyword entities from Markdown / prose.
 *
 * Sources (in priority order):
 *   1. Headings (H1-H4) — stripped of inline formatting
 *   2. Bold phrases (**text** / __text__)
 *   3. Code spans (`text`) — filtered to PascalCase / meaningful identifiers
 *   4. PascalCase / camelCase identifiers in prose
 *
 * Ported from `preflightDocHealth.extractMarkdownEntities()` with:
 *   - KeywordMatch output (includes offset + length)
 *   - camelCase identifier detection (new)
 *   - Configurable minimum length
 *
 * No interface — single implementation per Phase A §1.1.
 *
 * @version 0.1
 */

import type { KeywordMatch } from "@intentweave/core";

// =============================================================================
// Noise Words
// =============================================================================

/**
 * Common noise words to skip — these appear frequently but carry no
 * entity-level meaning.
 */
const NOISE_WORDS = new Set([
  // English noise
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "its", "let", "say", "she",
  "too", "use", "how", "why", "see", "now", "way", "may", "also", "then",
  "than", "that", "this", "with", "will", "each", "make", "like", "from",
  "have", "been", "just", "more", "over", "such", "note", "todo", "done",
  "here", "true", "false", "null", "undefined",
  // Markdown noise
  "table", "example", "summary", "overview", "introduction", "conclusion",
  "appendix", "references", "changelog", "version", "status", "usage",
  "setup", "install", "getting started", "quick start", "prerequisites",
  "important", "warning", "deprecated",
]);

// =============================================================================
// Helpers
// =============================================================================

/** Check if a string is PascalCase (e.g., "AuthService", "Neo4j"). */
function isPascalCase(s: string): boolean {
  return /^[A-Z][a-zA-Z0-9]+$/.test(s) && /[a-z]/.test(s);
}

/** Check if a string is camelCase (e.g., "authService", "getUser"). */
function isCamelCase(s: string): boolean {
  return /^[a-z][a-zA-Z0-9]*$/.test(s) && /[A-Z]/.test(s);
}

/** Strip inline markdown formatting from text. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")     // bold
    .replace(/__(.+?)__/g, "$1")          // bold alt
    .replace(/\*(.+?)\*/g, "$1")          // italic
    .replace(/_(.+?)_/g, "$1")            // italic alt
    .replace(/`(.+?)`/g, "$1")            // code span
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .trim();
}

/**
 * Normalize a keyword name:
 *   - Lowercase
 *   - Trim whitespace
 *   - Collapse internal whitespace to a single space
 *   - Strip markdown formatting characters
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[*_`~]/g, "");
}

// =============================================================================
// HeuristicKeywordExtractor
// =============================================================================

export interface HeuristicKeywordExtractorOptions {
  /** Minimum keyword length after normalization (default: 3) */
  minLength?: number;

  /** Annotation depth: 'full' enables body-text dictionary matching */
  depth?: "structured" | "full";

  /** External dictionary of known terms (e.g., symbol names from AX) */
  dictionary?: Set<string>;
}

/**
 * Heuristic keyword extraction from Markdown / prose text.
 *
 * No interface — single implementation.
 */
export class HeuristicKeywordExtractor {
  private readonly minLength: number;
  private readonly depth: "structured" | "full";
  private readonly dictionary: Set<string>;

  constructor(options?: HeuristicKeywordExtractorOptions) {
    this.minLength = options?.minLength ?? 3;
    this.depth = options?.depth ?? "structured";
    this.dictionary = options?.dictionary ?? new Set();
  }

  /**
   * Extract keyword entities from a single text chunk.
   *
   * @param text    The raw text content (may contain Markdown)
   * @param heading Optional heading context (for heading source type)
   * @returns       Array of keyword matches, deduplicated by normalized name
   */
  extract(text: string, heading?: string): KeywordMatch[] {
    const seen = new Set<string>();
    const matches: KeywordMatch[] = [];

    const addMatch = (
      originalText: string,
      offset: number,
      source: KeywordMatch["source"],
    ): void => {
      const name = normalize(originalText);
      if (name.length < this.minLength) return;
      if (NOISE_WORDS.has(name)) return;
      if (seen.has(name)) return;
      seen.add(name);
      matches.push({
        name,
        originalText,
        offset,
        length: originalText.length,
        source,
      });
    };

    // ── 1. Headings (H1–H4) ─────────────────────────────────────────
    const headingRe = /^#{1,4}\s+(.+)$/gm;
    for (const match of text.matchAll(headingRe)) {
      const cleaned = stripInlineMarkdown(match[1]);
      if (cleaned.length >= this.minLength) {
        addMatch(cleaned, match.index!, "heading");
      }
    }

    // ── 2. Bold phrases (**text** or __text__) ───────────────────────
    const boldRe = /\*\*([^*]+?)\*\*|__([^_]+?)__/g;
    for (const match of text.matchAll(boldRe)) {
      const bold = match[1] ?? match[2];
      if (bold) {
        addMatch(bold.trim(), match.index!, "bold");
      }
    }

    // ── 3. Code spans (`text`) — only meaningful identifiers ─────────
    const codeSpanRe = /`([^`\n]+?)`/g;
    for (const match of text.matchAll(codeSpanRe)) {
      const code = match[1].trim();
      if (
        isPascalCase(code) ||
        isCamelCase(code) ||
        code.includes("-") ||
        code.includes("_") ||
        /^[A-Z]/.test(code)
      ) {
        // Offset +1 to account for the opening backtick
        addMatch(code, match.index! + 1, "code-span");
      }
    }

    // ── 4. PascalCase / camelCase identifiers in prose ───────────────
    // Matches words not inside markdown formatting
    const identRe = /(?<![`*_#\[])\b([A-Z][a-zA-Z0-9]{2,})\b(?![`*_\]])/g;
    for (const match of text.matchAll(identRe)) {
      const word = match[1];
      if (isPascalCase(word)) {
        addMatch(word, match.index!, "identifier");
      }
    }

    // Also match camelCase in prose
    const camelRe = /(?<![`*_#\[])\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b(?![`*_\]])/g;
    for (const match of text.matchAll(camelRe)) {
      const word = match[1];
      if (isCamelCase(word)) {
        addMatch(word, match.index!, "identifier");
      }
    }

    // ── 5. Dictionary matching (--depth full only) ───────────────
    if (this.depth === "full" && this.dictionary.size > 0) {
      this.extractDictionary(text, seen, matches, addMatch);
    }

    return matches;
  }

  /**
   * Scan body text for known dictionary terms.
   *
   * Matches multi-word and single-word terms from the dictionary
   * that weren't already captured by structured extractors.
   */
  private extractDictionary(
    text: string,
    seen: Set<string>,
    matches: KeywordMatch[],
    addMatch: (text: string, offset: number, source: KeywordMatch["source"]) => void,
  ): void {
    // Strip markdown formatting for clean body text scanning
    const stripped = stripInlineMarkdown(
      text.replace(/^#{1,6}\s+.+$/gm, ""), // remove heading lines
    );

    for (const term of this.dictionary) {
      if (term.length < this.minLength) continue;
      if (seen.has(term)) continue;

      // Build a regex for the term (word-boundary, case-insensitive)
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const termRe = new RegExp(`\\b${escaped}\\b`, "gi");

      const match = termRe.exec(stripped);
      if (match) {
        addMatch(match[0], match.index, "dictionary");
      }
    }
  }
}
