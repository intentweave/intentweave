// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI (Code-Aware Retrieval Index) Types
 *
 * Lightweight types for the SQLite-based retrieval index.
 * Consumed by agents, CI, and editors — no Neo4j required.
 */

// =============================================================================
// Annotation (doc span → code symbol)
// =============================================================================

/**
 * How a doc mention was matched to a code symbol.
 */
export type MatchType = "exact" | "slug" | "token" | "heading" | "ungrounded";

/**
 * A link between a document text span and (optionally) a code symbol.
 */
export interface Annotation {
  /** Auto-incremented ID (assigned by SQLite) */
  id?: number;

  /** Document file path (relative to workspace) */
  docPath: string;

  /** Line number in the document (1-based) */
  line: number;

  /** The mention text as it appears in the doc */
  text: string;

  /** Matched code symbol ID (null = ungrounded mention) */
  symbolId: string | null;

  /** Confidence score 0–1 */
  confidence: number;

  /** Detection source from KWX */
  source:
    | "heading"
    | "bold"
    | "code-span"
    | "identifier"
    | "dictionary"
    | "custom-pattern";

  /** Signal qualifier (decision, deprecated, planned, etc.) */
  qualifier?: string;

  /** IDF score for this term (higher = more discriminative) */
  idfScore?: number;
}

// =============================================================================
// Symbol (from AX output)
// =============================================================================

/**
 * A code symbol stored in the index.
 */
export interface IndexSymbol {
  /** Stable ID from AX: impl:<path>#<kind>:<name> */
  id: string;

  /** Symbol name */
  name: string;

  /** Symbol kind */
  kind: string;

  /** Parent container (class for methods, etc.) */
  container?: string;

  /** Compact printable signature */
  signature?: string;

  /** File path (relative to workspace) */
  filePath: string;

  /** Start line (1-based) */
  line: number;

  /** End line */
  endLine?: number;

  /** Export status */
  export: "exported" | "internal";

  /** JSDoc summary (first line) */
  docSummary?: string;
}

// =============================================================================
// Co-occurrence
// =============================================================================

/**
 * Source type for co-occurrence edges.
 */
export type CoOccurrenceSource = "doc_cooc" | "code_import";

/**
 * A co-occurrence relationship between two entities.
 */
export interface IndexCoOccurrence {
  entityA: string;
  entityB: string;
  count: number;
  score: number;
  source: CoOccurrenceSource;
  filePaths: string[];
}

// =============================================================================
// Co-change
// =============================================================================

/**
 * A co-change relationship between two files.
 */
export interface IndexCoChange {
  fileA: string;
  fileB: string;
  count: number;
  jaccard: number;
  recency: number;
  commitHashes: string[];
}

// =============================================================================
// File metadata
// =============================================================================

/**
 * Per-file metadata in the index.
 */
export interface IndexFile {
  path: string;
  lastModified?: string;
  churn?: number;
  isHotspot: boolean;
  primaryOwner?: string;
  busFactor?: number;
  isDoc: boolean;
  contentHash?: string;
}

// =============================================================================
// Build options
// =============================================================================

/**
 * Options for building the CARI index.
 */
export interface IndexBuildOptions {
  /** Session name */
  session: string;

  /** Workspace root directory */
  workspaceRoot: string;

  /** Annotation depth: structured (headings/bold/code-spans) or full (all text + IDF) */
  depth: "structured" | "full";

  /** Output path for the SQLite database */
  outputPath?: string;

  /** Logging callback */
  log?: (msg: string) => void;
}

/**
 * Result of building the index.
 */
export interface IndexBuildResult {
  /** Path to the generated SQLite database */
  dbPath: string;

  /** Counts of inserted records */
  counts: {
    symbols: number;
    annotations: number;
    coOccurrences: number;
    coChanges: number;
    files: number;
  };

  /** Build duration in ms */
  durationMs: number;
}

// =============================================================================
// IDF scores
// =============================================================================

/**
 * IDF scores for terms across the document corpus.
 * Key = normalized term, Value = IDF score (0–1, higher = more discriminative).
 */
export type IdfScores = Map<string, number>;

// =============================================================================
// Query: retrieve
// =============================================================================

export interface RetrieveParams {
  /** Natural language topic or symbol name */
  query: string;

  /** Maximum results (default: 10) */
  limit?: number;

  /** Restrict to code files, doc files, or all */
  scope?: "code" | "docs" | "all";
}

export interface RetrieveResult {
  files: Array<{
    path: string;
    score: number;
    reason: string;
    spans?: Array<{ line: number; text: string }>;
  }>;
}

// =============================================================================
// Query: connections
// =============================================================================

export type ConnectionSourceType = "doc_cooc" | "co_change" | "code_import";

export interface ConnectionsParams {
  /** Symbol name or keyword */
  entity: string;

  /** Maximum connections per source type (default: 10) */
  limit?: number;

  /** Filter to specific source types */
  include?: ConnectionSourceType[];
}

export interface ConnectionSource {
  type: ConnectionSourceType;
  score: number;
  detail: string;
}

export interface Connection {
  name: string;
  sources: ConnectionSource[];
  gap?: string;
}

export interface ConnectionGap {
  description: string;
  severity: "info" | "warning";
  entities: string[];
}

export interface ConnectionsResult {
  entity: string;
  connections: Connection[];
  gaps: ConnectionGap[];
}

// =============================================================================
// Query: check
// =============================================================================

export interface CheckParams {
  /** Changed file paths from PR diff */
  changed: string[];

  /** Minimum severity to report (default: "info") */
  severity?: "info" | "warning" | "critical";

  /** Output format */
  format?: "text" | "json" | "github";
}

export interface CheckFinding {
  severity: "info" | "warning" | "critical";
  message: string;
  file: string;
  line?: number;
  related: string[];
}

export interface CheckResult {
  findings: CheckFinding[];
  /** 0 = clean, 1 = warnings, 2 = critical */
  exitCode: number;
}

// =============================================================================
// Query: report
// =============================================================================

export interface ReportResult {
  coverage: {
    documented: number;
    total: number;
    percentage: number;
    topUndocumented: Array<{ name: string; filePath: string; kind: string }>;
  };
  staleness: {
    staleDocCount: number;
    topStale: Array<{
      docPath: string;
      daysBehind: number;
      newerCodeFile: string;
    }>;
  };
  hiddenCouplings: Array<{
    entityA: string;
    entityB: string;
    docCoocScore: number;
    hasCodeDependency: boolean;
  }>;
  undocumentedDeps: Array<{
    entityA: string;
    entityB: string;
    coChangeCount: number;
    docMentions: number;
  }>;
}
