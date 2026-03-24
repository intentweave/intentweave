// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * RegexQualifierDetector — detects signal qualifiers via regex patterns.
 *
 * Matches regex patterns against the sentence surrounding a keyword mention
 * to classify the intent: decision, deprecated, planned, must, should,
 * alternative, risk, example.
 *
 * No interface — single implementation per Phase A §1.1.
 *
 * @version 0.1
 */

import type { KeywordMatch, SignalQualifier } from "@intentweave/core";

// =============================================================================
// Pattern Table
// =============================================================================

/**
 * Pattern definition: maps a signal qualifier to one or more regex patterns.
 * If any pattern matches the sentence context, the qualifier is assigned.
 */
interface QualifierPattern {
  qualifier: SignalQualifier;
  patterns: RegExp[];
}

const QUALIFIER_PATTERNS: QualifierPattern[] = [
  {
    qualifier: "decision",
    patterns: [
      /\b(decided|chose|selected|picked|went with|opted for|chosen|decided for|decision)\b/i,
    ],
  },
  {
    qualifier: "deprecated",
    patterns: [
      /\b(deprecated|obsolete|legacy|sunset|sunsetted)\b/i,
      /@deprecated/i,
    ],
  },
  {
    qualifier: "planned",
    patterns: [
      /\b(todo|planned|will\s+(?:be|have|add|implement|support|migrate)|upcoming|roadmap|future|later)\b/i,
    ],
  },
  {
    qualifier: "must",
    patterns: [
      /\b(must|required|mandatory|shall)\b/i,
    ],
  },
  {
    qualifier: "should",
    patterns: [
      /\b(should|recommended|ideally|prefer|preferably)\b/i,
    ],
  },
  {
    qualifier: "alternative",
    patterns: [
      /\b(alternative|instead of|versus|vs\.?)\b/i,
      /\bor\b.+\bor\b/i, // "X or Y or Z" pattern
      /\b(compared to|rather than|over)\b/i,
    ],
  },
  {
    qualifier: "risk",
    patterns: [
      /\b(risk|danger|concern|worry|caveat|warning|caution|threat)\b/i,
    ],
  },
  {
    qualifier: "example",
    patterns: [
      /\b(example|e\.g\.|for instance|such as|demo|sample)\b/i,
    ],
  },
];

// =============================================================================
// RegexQualifierDetector
// =============================================================================

/**
 * Regex-based qualifier detection.
 *
 * No interface — single implementation.
 */
export class RegexQualifierDetector {
  /**
   * Detect qualifiers for a keyword within its sentence context.
   *
   * @param _keyword          The keyword match (available for future per-keyword patterns)
   * @param sentenceContext   The sentence text surrounding the keyword
   * @returns                 Array of detected qualifiers (may be empty, always unique)
   */
  detect(_keyword: KeywordMatch, sentenceContext: string): SignalQualifier[] {
    const qualifiers: SignalQualifier[] = [];

    for (const { qualifier, patterns } of QUALIFIER_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(sentenceContext)) {
          qualifiers.push(qualifier);
          break; // One match per qualifier is enough
        }
      }
    }

    return qualifiers;
  }
}
