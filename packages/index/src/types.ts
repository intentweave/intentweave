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
    | "custom-pattern"
    | "external";

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
    imports: number;
    todos: number;
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

// =============================================================================
// Query: clones
// =============================================================================

export interface ClonesResult {
  /** Groups of symbols sharing identical normalised bodies */
  cloneGroups: Array<{
    bodyHash: string;
    bodyLines: number;
    symbols: Array<{
      name: string;
      filePath: string;
      line: number;
      kind: string;
    }>;
  }>;
  totalCloneGroups: number;
  totalClonedSymbols: number;
}

// =============================================================================
// Query: circular imports
// =============================================================================

export interface CircularImportsResult {
  cycles: Array<{
    files: string[];
    length: number;
  }>;
  totalCycles: number;
}

// =============================================================================
// Query: unused exports
// =============================================================================

export interface UnusedExportsResult {
  unused: Array<{
    name: string;
    filePath: string;
    kind: string;
    line: number;
  }>;
  totalUnused: number;
  totalExported: number;
}

// =============================================================================
// Query: hotspot priority
// =============================================================================

export interface HotspotPriorityResult {
  priorities: Array<{
    filePath: string;
    churn: number;
    documentedSymbols: number;
    totalExportedSymbols: number;
    coveragePercent: number;
    /** Higher = more urgent to document (churn × (1 − coverage)) */
    priorityScore: number;
  }>;
}

// =============================================================================
// Query: todos
// =============================================================================

export interface TodosResult {
  todos: Array<{
    filePath: string;
    line: number;
    kind: string;
    text: string;
  }>;
  totalCount: number;
  byKind: Record<string, number>;
}

// =============================================================================
// Query: module coverage (1.4)
// =============================================================================

export interface ModuleCoverageResult {
  modules: Array<{
    /** Directory path (e.g., "packages/analyzer/src") */
    module: string;
    /** Total exported symbols in this module */
    totalExported: number;
    /** Exported symbols with at least one annotation */
    documented: number;
    /** Coverage percentage */
    coveragePercent: number;
  }>;
}

// =============================================================================
// Query: orphaned sections (1.3)
// =============================================================================

export interface OrphanedSectionsResult {
  sections: Array<{
    /** Document file path */
    docPath: string;
    /** Heading text */
    heading: string;
    /** Line number of the heading */
    line: number;
    /** Number of ungrounded mentions in this section */
    ungroundedMentions: number;
  }>;
  totalOrphaned: number;
}

// =============================================================================
// Query: doc completeness (1.7)
// =============================================================================

export interface DocCompletenessResult {
  docs: Array<{
    /** Document file path */
    docPath: string;
    /** Exported symbols referenced from the files this doc covers */
    totalRelevantExports: number;
    /** How many of those are actually mentioned in this doc */
    coveredExports: number;
    /** Completeness percentage */
    completenessPercent: number;
    /** Symbols missing from the doc */
    missing: Array<{ name: string; filePath: string; kind: string }>;
  }>;
}

// =============================================================================
// Query: structural clones (2.2)
// =============================================================================

export interface StructuralClonesResult {
  /** Groups of symbols sharing identical AST structure (ignoring identifiers/literals) */
  cloneGroups: Array<{
    structureHash: string;
    bodyLines: number;
    symbols: Array<{
      name: string;
      filePath: string;
      line: number;
      kind: string;
    }>;
  }>;
  totalCloneGroups: number;
  totalClonedSymbols: number;
}

// =============================================================================
// Query: cross-group drift (1.2)
// =============================================================================

export interface CrossGroupDriftResult {
  drifts: Array<{
    /** Entity name mentioned in multiple doc groups */
    entity: string;
    /** Groups that mention this entity, with coverage details */
    groups: Array<{
      docGroup: string;
      docPaths: string[];
      mentionCount: number;
      qualifiers: string[];
    }>;
    /** Drift description */
    reason: string;
  }>;
  totalDrifts: number;
}

// =============================================================================
// External Entity (Entity Bridge)
// =============================================================================

/**
 * An external entity injected via the Entity Bridge.
 * Not derived from AST — comes from domain models, pipeline entities, etc.
 */
export interface ExternalEntity {
  /** Unique entity identifier (e.g., "entity:auth-service") */
  id: string;

  /** Display name */
  name: string;

  /** Entity type (e.g., "component", "decision", "concept") */
  type: string;

  /** Alternative names for alias matching */
  aliases?: string[];

  /** Arbitrary metadata (serialised as JSON) */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Query: mentionsOf
// =============================================================================

export interface MentionsOfParams {
  /** Entity ID (external entity or code symbol) */
  entityId: string;

  /** Minimum confidence threshold (default: 0) */
  minConfidence?: number;

  /** Maximum results (default: 100) */
  limit?: number;
}

export interface MentionsOfResult {
  entityId: string;
  mentions: Array<{
    docPath: string;
    line: number;
    text: string;
    confidence: number;
    source: string;
    qualifier?: string;
  }>;
  totalCount: number;
}

// =============================================================================
// Query: annotationsForFile
// =============================================================================

export interface AnnotationsForFileParams {
  /** Document file path (relative to workspace) */
  filePath: string;

  /** Minimum confidence threshold (default: 0) */
  minConfidence?: number;

  /** Maximum results (default: 500) */
  limit?: number;
}

export interface AnnotationsForFileResult {
  filePath: string;
  annotations: Array<{
    /** Mention text */
    text: string;
    /** Matched entity ID (symbol or external entity) */
    entityId: string | null;
    /** Entity name (resolved from external_entities or symbols table) */
    entityName?: string;
    /** Entity source: "symbol" or "external" */
    entitySource?: "symbol" | "external";
    line: number;
    confidence: number;
    source: string;
    qualifier?: string;
  }>;
  totalCount: number;
}
