// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift Detection Types — Phase C
 *
 * Unified type system for all four drift detectors:
 *   C1: doc↔code (ungrounded, undocumented, signature mismatch)
 *   C2: temporal (staleness, decision volatility, correlated change lag, abandoned code)
 *   C3: deps (unused, undeclared, version drift)
 *   C4: doc↔doc (mention footprint divergence, qualifier contradictions)
 *
 * All detectors are non-LLM, $0 — they compose existing KWG, TCG, and AX data.
 *
 * @see PHASE-C-SPEC.md
 * @see LAYERED-GRAPH-ARCHITECTURE.md §10
 * @version 0.1
 */

import type { SignalQualifier } from "./kwg.js";
import type { TcgPipelineOutput } from "./tcg.js";

// =============================================================================
// Schema Constants
// =============================================================================

export const DRIFT_SCHEMAS = {
  report: "intentweave://schemas/drift-report/v1",
} as const;

// =============================================================================
// DriftCategory
// =============================================================================

/**
 * Categories of drift that can be detected.
 * Each detector produces signals in one or more categories.
 */
export type DriftCategory =
  | "ungrounded" // C1: entity in docs but not in code
  | "undocumented" // C1: code symbol not referenced in docs
  | "signature-mismatch" // C1: doc mentions entity with wrong signature
  | "temporal-stale" // C2: doc not updated despite code changes
  | "temporal-volatile" // C2: section has high decision churn
  | "abandoned-code" // C2: code entity with zero recent commits
  | "dep-unused" // C3: declared dependency not imported
  | "dep-undeclared" // C3: imported module not in package.json
  | "dep-version-drift" // C3: doc mentions different version than declared
  | "doc-doc-diverged" // C4: two docs cover same topic, mention footprints differ
  | "doc-doc-contradicts"; // C4: two docs have conflicting qualifiers for same entity

// =============================================================================
// DriftSeverity
// =============================================================================

export type DriftSeverity = "critical" | "warning" | "info";

// =============================================================================
// DriftSignal
// =============================================================================

/**
 * A single drift signal — the atomic unit of drift detection output.
 * All four detectors produce DriftSignal[], which are merged in the unified report.
 */
export interface DriftSignal {
  /** Signal category */
  category: DriftCategory;

  /** Severity for triage */
  severity: DriftSeverity;

  /** Which detector produced this signal */
  detector: "doc-code" | "temporal" | "deps" | "doc-doc";

  /** Human-readable explanation */
  message: string;

  /** Primary entity or symbol name */
  name: string;

  /** File(s) where the issue manifests */
  files: string[];

  /** Evidence supporting this signal */
  evidence: DriftEvidence;
}

// =============================================================================
// DriftEvidence
// =============================================================================

/**
 * Structured evidence — what data backs up this drift signal?
 * Each field is optional because different detectors produce different evidence.
 */
export interface DriftEvidence {
  // ── KWG evidence ─────────────────────────────────────────
  /** Mention count from KWG */
  mentionCount?: number;
  /** Signal qualifiers from KWG (decision, planned, etc.) */
  qualifiers?: SignalQualifier[];
  /** Source sentences/headings from KWG mentions */
  mentionContexts?: Array<{
    text: string;
    heading?: string;
    filePath: string;
    startLine: number;
  }>;

  // ── AX evidence ──────────────────────────────────────────
  /** Code symbol signature (from AX) */
  codeSignature?: string;
  /** Doc-mentioned signature (from KWG mention text) */
  docSignature?: string;
  /** Near-match score (0–1) */
  nearMatchScore?: number;
  /** Near-match candidate name */
  nearMatchName?: string;

  // ── TCG evidence ─────────────────────────────────────────
  /** Days since doc was last modified (from TCG) */
  docStalenessDays?: number;
  /** Number of code commits since doc was last updated */
  codeCommitsSinceDocUpdate?: number;
  /** Last code modification date */
  lastCodeModified?: string;
  /** Last doc modification date */
  lastDocModified?: string;
  /** Is this a hotspot file? */
  isHotspot?: boolean;
  /** Hotspot z-score */
  hotspotZScore?: number;
  /** Ownership information */
  codeOwner?: string;
  /** Decision volatility count (number of qualifier changes) */
  decisionVolatility?: number;

  // ── Dependency evidence ──────────────────────────────────
  /** Package name */
  packageName?: string;
  /** Declared version */
  declaredVersion?: string;
  /** Doc-mentioned version */
  docMentionedVersion?: string;
  /** Import paths using the dependency */
  importPaths?: string[];

  // ── Doc↔doc evidence ─────────────────────────────────────
  /** The two files being compared */
  docPair?: [string, string];
  /** Entities unique to doc A */
  uniqueToA?: string[];
  /** Entities unique to doc B */
  uniqueToB?: string[];
  /** Shared entities (for context) */
  shared?: string[];
  /** Jaccard similarity of mention footprints */
  footprintSimilarity?: number;
  /** Conflicting qualifiers (same entity, different qualifiers in different docs) */
  conflictingQualifiers?: Array<{
    entity: string;
    qualifiersInA: SignalQualifier[];
    qualifiersInB: SignalQualifier[];
  }>;
}

// =============================================================================
// UnifiedDriftReport
// =============================================================================

/**
 * Unified drift report combining all four detectors.
 * This is the input to both CLI rendering and Neo4j persistence.
 */
export interface UnifiedDriftReport {
  /** Schema identifier */
  $schema: typeof DRIFT_SCHEMAS.report;

  /** Session analyzed */
  session: string;

  /** Workspace root */
  workspaceRoot: string;

  /** When analysis was run (ISO-8601) */
  analyzedAt: string;

  /** All drift signals (from all detectors) */
  signals: DriftSignal[];

  /** Per-detector statistics */
  detectorStats: {
    docCode: DetectorStats;
    temporal: DetectorStats;
    deps: DetectorStats;
    docDoc: DetectorStats;
  };

  /** Aggregate statistics */
  stats: {
    totalSignals: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    totalDurationMs: number;
  };
}

// =============================================================================
// DetectorStats
// =============================================================================

export interface DetectorStats {
  /** Whether this detector was run */
  enabled: boolean;

  /** Number of signals produced */
  signalCount: number;

  /** Duration in ms */
  durationMs: number;

  /** Detector-specific metrics (e.g., totalKwgEntities, totalCodeSymbols) */
  metrics: Record<string, number>;
}

// =============================================================================
// Detector Input Types
// =============================================================================

// ── Shared lightweight types for drift (avoid importing full KWG records) ──

/**
 * Lightweight KWG entity record for drift detection.
 * Avoids tight coupling to the full KwgEntityRecord.
 */
export interface KwgEntityForDrift {
  name: string;
  mentionCount: number;
  qualifiers: SignalQualifier[];
  filePaths: string[];
}

/**
 * Lightweight KWG mention for drift detection.
 */
export interface KwgMentionForDrift {
  entityName: string;
  text: string;
  heading?: string;
  filePath: string;
  startLine: number;
  /** Signal qualifiers (for doc-doc contradiction detection) */
  qualifiers?: SignalQualifier[];
}

// ── C1: doc-code ───────────────────────────────────────────────

/**
 * Input for the doc↔code drift detector (C1).
 * Requires KWG entities (from Neo4j or in-memory) + AX output.
 *
 * Note: `axOutput` typed as `unknown` here — detector imports `AxOutput`
 * from `@intentweave/analyzer` directly (core cannot depend on analyzer).
 */
export interface DocCodeDriftInput {
  /** KWG entities (from Neo4j or in-memory KWG pipeline output) */
  kwgEntities: KwgEntityForDrift[];

  /** KWG mentions for context (for signature matching) */
  kwgMentions?: KwgMentionForDrift[];

  /** AX output (code symbols) — typed as AxOutput at call site */
  axOutput: unknown;

  /** Minimum KWG mention count to consider entity significant (default: 2) */
  minMentions?: number;

  /** Only consider exported code symbols (default: true) */
  exportedOnly?: boolean;

  /** Token overlap threshold for near-match detection (default: 0.5) */
  nearMatchThreshold?: number;

  /** Log callback */
  log?: (msg: string) => void;
}

// ── C2: temporal ───────────────────────────────────────────────

/**
 * Input for the temporal drift detector (C2).
 * Requires in-memory TCG pipeline output.
 */
export interface TemporalDriftInput {
  /** TCG pipeline output (or loaded from Neo4j) */
  tcgOutput: TcgPipelineOutput;

  /** KWG entities (for entity-level temporal analysis) */
  kwgEntities?: KwgEntityForDrift[];

  /** KWG mentions (for decision volatility analysis) */
  kwgMentions?: KwgMentionForDrift[];

  /** Git workspace root for path resolution */
  workspaceRoot: string;

  /** Staleness threshold in days (default: 14) */
  minStalenessDays?: number;

  /** Log callback */
  log?: (msg: string) => void;
}

// ── C3: deps ───────────────────────────────────────────────────

/**
 * Input for the dependency drift detector (C3).
 * Requires AX output (imports) + package.json + optional KWG mentions.
 *
 * Note: `axOutput` typed as `unknown` here — detector imports `AxOutput`
 * from `@intentweave/analyzer` directly (core cannot depend on analyzer).
 */
export interface DepsDriftInput {
  /** AX output (code imports) — typed as AxOutput at call site */
  axOutput: unknown;

  /** KWG entities (for doc-mentioned version detection) */
  kwgEntities?: KwgEntityForDrift[];

  /** KWG mentions (for version extraction from text) */
  kwgMentions?: KwgMentionForDrift[];

  /** Workspace root (for finding package.json) */
  workspaceRoot: string;

  /** Package manager: npm | pnpm | yarn | auto (default: auto) */
  packageManager?: "npm" | "pnpm" | "yarn" | "auto";

  /** Log callback */
  log?: (msg: string) => void;
}

// ── C4: doc-doc ────────────────────────────────────────────────

/**
 * Input for the doc↔doc drift detector (C4).
 * Requires KWG entities with per-file mention breakdown.
 */
export interface DocDocDriftInput {
  /** KWG entities with per-file mention breakdown */
  kwgEntities: KwgEntityForDrift[];

  /** KWG mentions (per-file, for qualifier comparison) */
  kwgMentions: KwgMentionForDrift[];

  /** Minimum shared entities to consider a doc pair "about the same topic" (default: 3) */
  minSharedEntities?: number;

  /** Minimum divergence to report (default: 0.3 = 30% of entities are unique to one doc) */
  minDivergence?: number;

  /** Log callback */
  log?: (msg: string) => void;
}

// =============================================================================
// Detector Output Types
// =============================================================================

/**
 * Output from a single detector — signals + stats.
 */
export interface DetectorOutput {
  /** Drift signals produced */
  signals: DriftSignal[];

  /** Per-detector stats */
  stats: DetectorStats;
}

/** C1 output */
export type DocCodeDriftOutput = DetectorOutput;

/** C2 output */
export type TemporalDriftOutput = DetectorOutput;

/** C3 output */
export type DepsDriftOutput = DetectorOutput;

/** C4 output */
export type DocDocDriftOutput = DetectorOutput;
