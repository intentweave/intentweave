// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * TCG (Temporal Change Graph) Types — Phase B
 *
 * The TCG is the temporal dimension of the IntentWeave knowledge graph.
 * It extracts git history signals: co-change relationships, hotspot
 * detection, ownership mapping, and staleness scoring — all without
 * LLM calls ($0).
 *
 * Pipeline: TCX (commits) → COC (co-change) → HOT (hotspots) → OWN (ownership) → STL (staleness)
 *
 * @see PHASE-B-SPEC.md
 * @see LAYERED-GRAPH-ARCHITECTURE.md §4.6
 * @version 0.1
 */

// =============================================================================
// Schema Constants
// =============================================================================

export const TCG_SCHEMAS = {
  tcx: "intentweave://schemas/tcx/v1",
  coc: "intentweave://schemas/coc/v1",
  hot: "intentweave://schemas/hot/v1",
  own: "intentweave://schemas/own/v1",
  stl: "intentweave://schemas/stl/v1",
} as const;

// =============================================================================
// CommitRecord
// =============================================================================

/**
 * A parsed git commit with file-level change statistics.
 */
export interface CommitRecord {
  /** Full commit SHA */
  hash: string;

  /** Short SHA (first 8 chars) */
  shortHash: string;

  /** Author name */
  authorName: string;

  /** Author email */
  authorEmail: string;

  /** Commit date (ISO-8601) */
  date: string;

  /** Commit message (first line only) */
  message: string;

  /** Files changed in this commit */
  files: CommitFileChange[];
}

/**
 * A single file change within a commit.
 */
export interface CommitFileChange {
  /** File path (relative to repo root) */
  filePath: string;

  /** Change type */
  changeType: "added" | "modified" | "deleted" | "renamed";

  /** Lines added (0 for binary files) */
  linesAdded: number;

  /** Lines removed (0 for binary files) */
  linesRemoved: number;

  /** Previous path (only set when changeType === 'renamed') */
  previousPath?: string;
}

// =============================================================================
// CoChangeEdge
// =============================================================================

/**
 * A co-change relationship between two files.
 *
 * Two files co-change when they appear in the same commit. The frequency
 * and Jaccard score indicate how tightly coupled they are.
 */
export interface CoChangeEdge {
  /** First file path (alphabetically smaller for consistency) */
  fileA: string;

  /** Second file path */
  fileB: string;

  /** Number of commits containing both files */
  coChangeCount: number;

  /** Jaccard index: |commits(A) ∩ commits(B)| / |commits(A) ∪ commits(B)| */
  jaccardScore: number;

  /** Commit hashes where both files changed */
  commitHashes: string[];
}

// =============================================================================
// HotspotSignal
// =============================================================================

/**
 * A hotspot signal — a file with disproportionately high change frequency.
 */
export interface HotspotSignal {
  /** File path */
  filePath: string;

  /** Total number of commits touching this file in the time window */
  commitCount: number;

  /** Churn: total lines added + removed across all commits */
  churn: number;

  /** Recency-weighted score (recent changes weigh more than old ones) */
  recencyScore: number;

  /** Z-score relative to the repository mean (>2.0 = significant hotspot) */
  zScore: number;

  /** Most recent commit date */
  lastModified: string;

  /** Authors who touched this file */
  authors: string[];
}

// =============================================================================
// OwnershipRecord
// =============================================================================

/**
 * Ownership assignment for a file — which authors have contributed how much.
 */
export interface OwnershipRecord {
  /** File path */
  filePath: string;

  /** Authors ranked by contribution (most active first) */
  authors: AuthorContribution[];

  /** Gini coefficient of commit distribution (0=equal, 1=single author) */
  ownershipClarity: number;

  /** Is there a clear owner (top author > 50% of commits)? */
  hasClearOwner: boolean;

  /** Top author name (if hasClearOwner) */
  primaryOwner?: string;
}

/**
 * An author's contribution to a specific file.
 */
export interface AuthorContribution {
  /** Author name */
  name: string;

  /** Author email */
  email: string;

  /** Number of commits by this author to this file */
  commitCount: number;

  /** Percentage of total commits to this file */
  percentage: number;

  /** Most recent commit date by this author */
  lastTouch: string;
}

// =============================================================================
// StalenessSignal
// =============================================================================

/**
 * A staleness signal — a file (typically documentation) that hasn't been
 * updated relative to the code it describes.
 */
export interface StalenessSignal {
  /** The stale file (usually a doc) */
  filePath: string;

  /** Last modification date of this file (from git) */
  lastModified: string;

  /** Number of days since last modification */
  daysSinceModified: number;

  /** Related code files that have been modified more recently */
  fresherRelatedFiles: Array<{
    filePath: string;
    lastModified: string;
    daysSinceModified: number;
  }>;

  /** Staleness score: max(code_mtime) - doc_mtime in days. Higher = more stale. */
  stalenessScore: number;

  /** Severity based on staleness score */
  severity: "info" | "warning" | "critical";
}

// =============================================================================
// Stage Input Types
// =============================================================================

export interface TcxStageInput {
  /** Repository root directory */
  workspaceRoot: string;

  /** Git depth: 'full' or a number of commits */
  depth: "full" | number;

  /** Include commits since this date (ISO-8601). Overrides depth if set. */
  since?: string;

  /** Optional path filter */
  pathFilter?: string[];

  /** Logging callback */
  log?: (msg: string) => void;
}

export interface CocStageInput {
  /** TCX output with commit data */
  tcxOutput: TcxStageOutput;

  /** Minimum co-change count to emit an edge (default: 3) */
  minCoChanges?: number;

  /** Minimum Jaccard score to emit an edge (default: 0.1) */
  minJaccard?: number;

  /** Logging callback */
  log?: (msg: string) => void;
}

export interface HotStageInput {
  /** TCX output with commit data */
  tcxOutput: TcxStageOutput;

  /** Z-score threshold for hotspot classification (default: 2.0) */
  zScoreThreshold?: number;

  /** Logging callback */
  log?: (msg: string) => void;
}

export interface OwnStageInput {
  /** TCX output with commit data */
  tcxOutput: TcxStageOutput;

  /** Minimum commits to be considered an author (default: 1) */
  minCommits?: number;

  /** Logging callback */
  log?: (msg: string) => void;
}

export interface StlStageInput {
  /** TCX output with commit data (for lastModified dates) */
  tcxOutput: TcxStageOutput;

  /** KWG entity names (for matching doc mentions to code files) */
  kwgEntities?: string[];

  /** Workspace root (for resolving relative paths) */
  workspaceRoot: string;

  /** Minimum staleness days to emit a signal (default: 14) */
  minStalenessDays?: number;

  /** Logging callback */
  log?: (msg: string) => void;
}

// =============================================================================
// Stage Output Types
// =============================================================================

export interface TcxStageOutput {
  $schema: "intentweave://schemas/tcx/v1";
  stage: "TCX";

  /** Parsed commits */
  commits: CommitRecord[];

  /** Unique authors found */
  authors: Array<{ name: string; email: string; commitCount: number }>;

  /** Unique file paths touched */
  filePaths: string[];

  /** Processing metadata */
  meta: {
    commitCount: number;
    authorCount: number;
    fileCount: number;
    timeRangeStart: string;
    timeRangeEnd: string;
    processingTimeMs: number;
  };
}

export interface CocStageOutput {
  $schema: "intentweave://schemas/coc/v1";
  stage: "COC";

  /** Co-change edges between files */
  edges: CoChangeEdge[];

  /** Processing metadata */
  meta: {
    edgeCount: number;
    pairsConsidered: number;
    minCoChangeThreshold: number;
    minJaccardThreshold: number;
    processingTimeMs: number;
  };
}

export interface HotStageOutput {
  $schema: "intentweave://schemas/hot/v1";
  stage: "HOT";

  /** Hotspot signals */
  hotspots: HotspotSignal[];

  /** Repository-wide stats for reference */
  repoStats: {
    meanCommitsPerFile: number;
    stdDevCommitsPerFile: number;
    meanChurnPerFile: number;
  };

  /** Processing metadata */
  meta: {
    hotspotCount: number;
    totalFilesAnalyzed: number;
    zScoreThreshold: number;
    processingTimeMs: number;
  };
}

export interface OwnStageOutput {
  $schema: "intentweave://schemas/own/v1";
  stage: "OWN";

  /** Ownership records per file */
  ownership: OwnershipRecord[];

  /** Files with no clear owner */
  ownershipVacuums: string[];

  /** Processing metadata */
  meta: {
    filesAnalyzed: number;
    vacuumCount: number;
    processingTimeMs: number;
  };
}

export interface StlStageOutput {
  $schema: "intentweave://schemas/stl/v1";
  stage: "STL";

  /** Staleness signals */
  signals: StalenessSignal[];

  /** Processing metadata */
  meta: {
    signalCount: number;
    docsAnalyzed: number;
    codeFilesAnalyzed: number;
    processingTimeMs: number;
  };
}

// =============================================================================
// Pipeline Aggregate
// =============================================================================

/**
 * Complete TCG pipeline output — all 5 stages combined.
 */
export interface TcgPipelineOutput {
  /** TCX: raw commit data */
  tcx: TcxStageOutput;

  /** COC: co-change edges */
  coc: CocStageOutput;

  /** HOT: hotspot signals */
  hot: HotStageOutput;

  /** OWN: ownership records */
  own: OwnStageOutput;

  /** STL: staleness signals */
  stl: StlStageOutput;

  /** Overall pipeline metadata */
  meta: {
    session: string;
    workspaceRoot: string;
    gitDepth: string;
    totalDurationMs: number;
  };
}
