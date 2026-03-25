// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KWG (Keyword Graph) — Phase A Evidence Graph
 *
 * Pipeline: KWX (keyword extraction) → COX (co-occurrence) → CLX (clustering)
 *
 * Exports the three pipeline stages, the heuristic extractor, qualifier
 * detector, and Neo4j persistence function.
 */

// Heuristic keyword extractor
export { HeuristicKeywordExtractor } from "./heuristicExtractor.js";
export type { HeuristicKeywordExtractorOptions } from "./heuristicExtractor.js";

// Regex qualifier detector
export { RegexQualifierDetector } from "./regexQualifier.js";

// KWX stage (keyword extraction, per-file)
export { runKwxStage } from "./kwxStage.js";
export type { KwxStageOptions } from "./kwxStage.js";

// COX stage (co-occurrence, session-level)
export { runCoxStage } from "./coxStage.js";

// CLX stage (clustering, session-level)
export { runClxStage } from "./clxStage.js";

// Verb hint detection (optional pass, post-KWX)
export { detectVerbHints, VERB_PATTERNS } from "./verbDetector.js";
export type {
  VerbHint,
  VerbDetectorResult,
  VerbPattern,
} from "./verbDetector.js";
