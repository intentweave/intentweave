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
// Test Coverage Mapping
// =============================================================================

/** Parameters for test coverage mapping. */
export interface TestCoverageParams {
  /** Limit number of untested symbols returned (default: all) */
  limit?: number;
}

/** A single test→source file mapping. */
export interface TestMapping {
  /** Path to the test file */
  testFile: string;
  /** Path to the source file it tests */
  sourceFile: string;
  /** How the mapping was discovered */
  strategy: "naming" | "import" | "both";
  /** Symbol names imported by the test from the source */
  importedNames: string[];
}

/** Result of test coverage mapping analysis. */
export interface TestCoverageResult {
  /** Total number of exported symbols in non-test files */
  totalExported: number;
  /** Number of exported symbols that are referenced by at least one test */
  covered: number;
  /** Coverage percentage (0–100) */
  coveragePercent: number;
  /** Exported symbols with no test coverage */
  untested: Array<{
    name: string;
    filePath: string;
    kind: string;
    line: number;
  }>;
  /** Discovered test→source mappings */
  mappings: TestMapping[];
  /** Per-directory coverage summary */
  byDirectory: Array<{
    directory: string;
    totalExported: number;
    covered: number;
    coveragePercent: number;
  }>;
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

// =============================================================================
// 9.2 Hub Analysis
// =============================================================================

export interface HubAnalysisResult {
  hubs: Array<{
    /** Entity name */
    name: string;

    /** Entity kind: symbol kind or 'file' */
    kind: string;

    /** File path containing (or being) this entity */
    filePath: string;

    /** Number of annotation edges referencing this entity */
    annotationDegree: number;

    /** Number of import edges (incoming + outgoing) */
    importDegree: number;

    /** Number of co-occurrence edges */
    coOccurrenceDegree: number;

    /** Number of co-change edges */
    coChangeDegree: number;

    /** Sum of all edge degrees */
    totalDegree: number;
  }>;
}

// =============================================================================
// 9.1 Community Detection
// =============================================================================

/**
 * Community detection mode — controls which edges are used for clustering.
 *
 * - `structural` (default): import + co-change + file-to-file co-occurrence edges.
 *   Shows functional/modular architecture (packages, libraries).
 * - `semantic`: all co-occurrence + import + co-change edges (full entity graph).
 *   Shows conceptual/topic groupings — which concepts are discussed together.
 * - `temporal`: co-change edges only.
 *   Shows files that evolve together — reveals implicit coupling.
 */
export type CommunityMode = "structural" | "semantic" | "temporal";

/** Options for community detection granularity control. */
export interface CommunityOptions {
  /**
   * Which graph edges to use for community detection (default: "structural").
   * "structural" = imports + co-changes + file co-occurrences (architecture view).
   * "semantic"   = full co-occurrence graph (concept/topic view).
   * "temporal"   = co-change graph only (evolution/coupling view).
   */
  mode?: CommunityMode;

  /**
   * Resolution parameter (default: 1.0).
   * Higher values (e.g. 2.0–5.0) produce more, smaller communities.
   * Lower values (e.g. 0.5) merge into fewer, larger communities.
   */
  resolution?: number;

  /**
   * Maximum community size before recursive sub-splitting (default: 100).
   * Communities larger than this are re-analyzed internally.
   * Set to Infinity to disable recursive splitting.
   */
  maxSize?: number;

  /**
   * Minimum community size to keep (default: 2).
   * Communities smaller than this are discarded.
   */
  minSize?: number;
}

export interface CommunityMember {
  name: string;
  kind: string;
  filePath?: string;
}

export interface Community {
  /** Community identifier (0-based) */
  id: number;

  /** Auto-generated label from most central member */
  label: string;

  /** Members of this community */
  members: CommunityMember[];

  /** Number of members */
  size: number;
}

export interface CommunityDetectionResult {
  /** Detected communities sorted by size descending */
  communities: Community[];

  /** Total number of communities */
  totalCommunities: number;

  /** Total number of nodes in the graph */
  totalNodes: number;
}

// =============================================================================
// 5.7 Vertical Slice Detection
// =============================================================================

/** A vertical slice: a community whose members span multiple layers. */
export interface VerticalSlice {
  /** Community ID */
  communityId: number;

  /** Community label (from most central member) */
  label: string;

  /** Number of distinct layers this community spans */
  layerSpan: number;

  /** Layer indices this community has members in (sorted ascending) */
  layers: number[];

  /** Files in this slice, grouped by layer index */
  filesByLayer: Record<number, string[]>;

  /** Total number of files in this slice */
  totalFiles: number;

  /** Classification: "vertical" (spans ≥ minLayers) or "horizontal" (contained in 1-2 layers) */
  orientation: "vertical" | "horizontal";
}

/** Options for vertical slice detection. */
export interface SlicesOptions {
  /** Minimum number of layers a community must span to be considered a vertical slice. Default: 3. */
  minLayers?: number;

  /** Maximum number of slices to return. Default: all. */
  limit?: number;
}

/** Result of vertical slice detection. */
export interface SlicesResult {
  /** Vertical slices (communities spanning ≥ minLayers layers), sorted by layerSpan descending */
  slices: VerticalSlice[];

  /** Horizontal modules (communities contained in 1-2 layers) */
  horizontal: VerticalSlice[];

  /** Total layers detected */
  totalLayers: number;

  /** Total communities analysed */
  totalCommunities: number;
}

// =============================================================================
// 9.3 Surprising Connections
// =============================================================================

export interface SurprisingConnection {
  entityA: string;
  entityB: string;

  /** Composite surprise score (higher = more surprising) */
  score: number;

  /** Cross-layer weight component (code↔doc edges score higher) */
  crossLayerWeight: number;

  /** Community distance component (cross-community = higher) */
  communityDistance: number;

  /** Inverse frequency component (rare = higher) */
  inverseFrequency: number;

  /** Human-readable explanation of why this connection is surprising */
  reason: string;
}

export interface SurprisingConnectionsResult {
  surprises: SurprisingConnection[];
  totalEvaluated: number;
}

// =============================================================================
// 9.4 Rationale Extraction
// =============================================================================

export interface RationaleResult {
  rationale: Array<{
    filePath: string;
    line: number;
    kind: string;
    text: string;
    symbol?: string;
  }>;
  totalCount: number;
  byKind: Record<string, number>;
}

// =============================================================================
// 1.5 Terminology Inconsistency Detection
// =============================================================================

/** A single mention variant for a symbol. */
export interface TerminologyVariant {
  /** The mention text as it appears in documents */
  text: string;

  /** How many times this variant appears across all docs */
  count: number;

  /** Average confidence of annotations using this variant */
  avgConfidence: number;

  /** Documents where this variant appears */
  docPaths: string[];
}

/** An entity with inconsistent terminology across docs. */
export interface TerminologyInconsistency {
  /** Code symbol ID */
  symbolId: string;

  /** The actual symbol name from code (canonical name) */
  symbolName: string;

  /** Symbol kind (class, function, etc.) */
  kind: string;

  /** File containing the symbol */
  filePath: string;

  /** All distinct mention variants found in docs */
  variants: TerminologyVariant[];

  /** Consistency score 0–1 (1 = all mentions use exact symbol name) */
  consistency: number;

  /** Severity based on variant count and consistency */
  severity: "info" | "warning" | "critical";
}

export interface TerminologyInconsistencyResult {
  /** Entities with inconsistent terminology, sorted by severity */
  inconsistencies: TerminologyInconsistency[];

  /** Total entities flagged */
  totalInconsistencies: number;

  /** Total entities analyzed (with ≥1 annotation) */
  totalAnalyzed: number;
}

// =============================================================================
// 3.3 Dependency Depth Analysis
// =============================================================================

/** Per-file dependency depth metrics. */
export interface DependencyDepthEntry {
  /** File path */
  filePath: string;

  /** Direct outgoing imports (fan-out) */
  directDependencies: number;

  /** Transitive closure of outgoing imports */
  transitiveDependencies: number;

  /** Direct incoming dependents (fan-in) */
  directDependents: number;

  /** Transitive closure of incoming dependents */
  transitiveDependents: number;

  /** Max depth in the dependency chain (longest path from this file) */
  maxDepth: number;

  /** Risk assessment based on fan-in/fan-out */
  risk: "low" | "medium" | "high" | "critical";

  /** Human-readable risk reason */
  reason: string;
}

export interface DependencyDepthResult {
  files: DependencyDepthEntry[];
  totalFiles: number;

  /** Files flagged as high or critical risk */
  highRiskCount: number;
}

// =============================================================================
// 3.4 Package Boundary Violations
// =============================================================================

/** A single import that crosses a package boundary into internal modules. */
export interface BoundaryViolation {
  /** File that contains the violating import */
  sourceFile: string;

  /** Package the source file belongs to */
  sourcePackage: string;

  /** Target file being imported (internal module of another package) */
  targetFile: string;

  /** Package the target file belongs to */
  targetPackage: string;

  /** The module specifier used in the import */
  moduleSpecifier: string;

  /** Human-readable description */
  reason: string;
}

export interface BoundaryViolationsResult {
  violations: BoundaryViolation[];
  totalViolations: number;

  /** Violations grouped by source→target package pair */
  byPackagePair: Array<{
    sourcePackage: string;
    targetPackage: string;
    count: number;
  }>;
}

// =============================================================================
// 5.1a Layer Inference
// =============================================================================

/** A single inferred architectural layer. */
export interface InferredLayer {
  /** Layer index (0 = bottom/foundation, higher = closer to UI/entry points) */
  index: number;

  /** Auto-generated label from most common directory prefix or community */
  label: string;

  /** Files assigned to this layer */
  files: string[];

  /** Depth range (min–max topological depth of files in this layer) */
  depthRange: [number, number];

  /** Package names within this layer (hierarchical mode only) */
  packages?: string[];

  /** Sub-layers within this layer (hierarchical mode only) */
  subLayers?: InferredSubLayer[];
}

/** A sub-layer within a macro layer (5.5 hierarchical mode). */
export interface InferredSubLayer {
  /** Sub-layer index within the parent macro layer (0 = foundation within package) */
  index: number;

  /** Auto-generated label from directory prefixes within the package */
  label: string;

  /** Files assigned to this sub-layer */
  files: string[];

  /** Depth range within the package's internal import graph */
  depthRange: [number, number];

  /** The package this sub-layer belongs to */
  package: string;
}

/** Options for layer inference (5.1a + 5.5). */
export interface LayersInferOptions {
  /** Enable two-level hierarchical inference (macro layers + sub-layers). Default: false. */
  hierarchical?: boolean;

  /** Scope inference to a single package directory (e.g., "packages/analyzer"). */
  scope?: string;

  /** Minimum file count for a package to receive sub-layer analysis. Default: 10. */
  minFilesForSubLayers?: number;
}

/** Result of automatic layer inference from the import graph. */
export interface LayersInferResult {
  /** Inferred layers sorted from bottom (foundation) to top (entry points) */
  layers: InferredLayer[];

  /** Total files in the import graph */
  totalFiles: number;

  /** Files not reachable via any import (isolated) */
  isolatedFiles: string[];

  /** YAML-formatted layer config ready to write to .iw/layers.yaml */
  yaml: string;
}

// =============================================================================
// 5.1c Layer Naming (LLM-based)
// =============================================================================

/** A named layer produced by the LLM naming pass. */
export interface NamedLayer {
  /** Layer index (matches InferredLayer.index) */
  index: number;

  /** Original heuristic label from directory prefixes */
  heuristicLabel: string;

  /** LLM-generated descriptive name (e.g., "HTTP Layer", "Data Access") */
  name: string;

  /** Short description of the layer's architectural role */
  description: string;
}

/** A named directory produced by the LLM naming pass. */
export interface NamedDirectory {
  /** Directory path (parent of files in the aggregate) */
  path: string;

  /** LLM-generated descriptive name (e.g., "CLI Subcommands", "Pipeline Stages") */
  name: string;

  /** Short description of the directory's contents */
  description: string;
}

/** Result of LLM-based layer naming. */
export interface LayerNamingResult {
  /** Named layers with LLM-generated labels */
  layers: NamedLayer[];

  /** Named directories for aggregate node labels */
  directories: NamedDirectory[];

  /** Token usage for the LLM call */
  tokensUsed: { prompt: number; completion: number };

  /** LLM latency in milliseconds */
  latencyMs: number;
}

// =============================================================================
// 5.1b Layer Check
// =============================================================================

/** Layer configuration loaded from .iw/layers.yaml */
export interface LayerConfig {
  /** Ordered layers from bottom (index 0) to top */
  layers: Array<{
    /** Layer name */
    name: string;

    /** Glob patterns matching files in this layer */
    patterns: string[];
  }>;

  /** Whether to allow skip-layer imports (default: false) */
  allowSkipLayer?: boolean;
}

/** A single layer violation. */
export interface LayerViolation {
  /** File that contains the violating import */
  sourceFile: string;

  /** Layer the source file belongs to */
  sourceLayer: string;

  /** Layer index of the source (higher = upper layer) */
  sourceLayerIndex: number;

  /** File being imported */
  targetFile: string;

  /** Layer the target file belongs to */
  targetLayer: string;

  /** Layer index of the target */
  targetLayerIndex: number;

  /** Violation type */
  type: "reverse" | "skip-layer";

  /** Human-readable description */
  reason: string;
}

/** Result of layer violation check. */
export interface LayersCheckResult {
  /** All detected violations */
  violations: LayerViolation[];

  /** Total violations found */
  totalViolations: number;

  /** Violations by type */
  byType: {
    reverse: number;
    skipLayer: number;
  };

  /** Summary of files per layer */
  layerSummary: Array<{
    name: string;
    index: number;
    fileCount: number;
  }>;
}

// ─── 5.2 Interface Conformance Drift ────────────────────────────────────────

/** A single conformance violation: missing member, extra member, or signature mismatch. */
export interface ConformanceViolation {
  /** The class that claims to implement the interface */
  className: string;
  /** File where the class is defined */
  classFile: string;
  /** The interface being implemented */
  interfaceName: string;
  /** File where the interface is defined */
  interfaceFile: string;
  /** Type of violation */
  type: "missing-method" | "missing-property" | "signature-mismatch";
  /** Name of the member involved */
  memberName: string;
  /** Expected signature (from the interface), if applicable */
  expectedSignature?: string;
  /** Actual signature (from the class), if applicable */
  actualSignature?: string;
}

/** Result of interface conformance checking across the codebase. */
export interface InterfaceConformanceResult {
  /** All detected violations */
  violations: ConformanceViolation[];
  /** Total violations found */
  totalViolations: number;
  /** Number of (class, interface) pairs checked */
  pairsChecked: number;
  /** Violations grouped by type */
  byType: {
    missingMethod: number;
    missingProperty: number;
    signatureMismatch: number;
  };
}

// ─── 5.6 As-Is vs. As-Should Comparison ─────────────────────────────────────

/** Per-file comparison entry: inferred layer vs. configured layer. */
export interface LayersCompareEntry {
  /** File path */
  file: string;
  /** Layer assigned by inference (as-is), or null if not inferred */
  inferredLayer: string | null;
  /** Layer assigned by config patterns (as-should), or null if unassigned */
  configuredLayer: string | null;
  /** Comparison status */
  status: "ok" | "drift" | "unassigned";
}

/** Result of as-is vs. as-should layer comparison. */
export interface LayersCompareResult {
  /** Per-file comparisons */
  entries: LayersCompareEntry[];
  /** Files that match between inferred and configured layers */
  matchCount: number;
  /** Files with layer drift (different inferred vs. configured) */
  driftCount: number;
  /** Files unassigned in either inference or config */
  unassignedCount: number;
  /** Total files compared */
  totalFiles: number;
}

// ─── 10.1 Architecture Report ───────────────────────────────────────────────

/** A file node in the architecture report graph. */
export interface ArchReportNode {
  filePath: string;
  fileName: string;
  layerIndex: number;
  layerLabel: string;
  communityId: number;
  communityLabel: string;
  /** Community assignments per view mode: { "semantic": { id, label }, "temporal": { id, label } } */
  communityViews?: Record<string, { id: number; label: string }>;
  transitiveDependents: number;
  maxDepth: number;
  risk: "low" | "medium" | "high" | "critical";
  hubDegree: number;
  isDoc?: boolean;
}

/** An edge in the architecture report graph. */
export interface ArchReportEdge {
  source: string;
  target: string;
  type:
    | "import"
    | "layer-violation"
    | "boundary-violation"
    | "co-occurrence"
    | "co-change";
  violationType?: "reverse" | "skip-layer";
  reason?: string;
  /** Weight/score for co-occurrence and co-change edges. */
  weight?: number;
}

/** Full data payload for the architecture report. */
export interface ArchReportData {
  meta: {
    generated: string;
    totalFiles: number;
  };
  nodes: ArchReportNode[];
  edges: ArchReportEdge[];
  /** Co-occurrence + co-change edges for the Communities view. */
  coEdges: ArchReportEdge[];
  layers: Array<{
    index: number;
    label: string;
    fileCount: number;
    /** LLM-generated descriptive name (5.1c), if available */
    llmName?: string;
    /** LLM-generated description of the layer's architectural role */
    description?: string;
    /** Packages contained in this layer (hierarchical mode) */
    packages?: string[];
    /** Sub-layers within this macro layer (hierarchical mode) */
    subLayers?: Array<{
      index: number;
      label: string;
      fileCount: number;
      files: string[];
      package: string;
      depthRange: [number, number];
    }>;
  }>;
  communities: Array<{ id: number; label: string; size: number }>;
  /** Alternative community views keyed by mode. Each value is a community list. */
  communityViews?: Record<
    string,
    Array<{ id: number; label: string; size: number }>
  >;
  /** Active community mode label for the default view. */
  activeCommunityMode?: string;
  /** LLM-generated directory names for aggregate nodes (5.1c). Key = dir path. */
  directoryNames?: Record<string, { name: string; description: string }>;
  summary: {
    totalLayers: number;
    totalCommunities: number;
    layerViolations: number;
    boundaryViolations: number;
    highRiskFiles: number;
  };
}

// =============================================================================
// Focused Architecture View
// =============================================================================

/** Parameters for the focused architecture subgraph query. */
export interface FocusParams {
  /** Target entity — file path, symbol name, or topic keyword. */
  target: string;

  /** Number of import-graph hops to expand from the target (default: 2). */
  hops?: number;

  /** Maximum number of nodes in the returned subgraph (default: 25). */
  maxNodes?: number;
}

/** A node in the focused subgraph. */
export interface FocusNode {
  /** File path relative to workspace root. */
  filePath: string;

  /** Short display name (filename without extension). */
  name: string;

  /** Architectural layer index (-1 if unassigned). */
  layerIndex: number;

  /** Architectural layer label. */
  layerLabel: string;

  /** Community ID (-1 if unassigned). */
  communityId: number;

  /** Community label. */
  communityLabel: string;

  /** Number of transitive dependents (downstream impact). */
  dependents: number;

  /** Whether this is the seed/target node. */
  isTarget: boolean;

  /** Hop distance from the target (0 = target itself). */
  hopDistance: number;
}

/** An edge in the focused subgraph. */
export interface FocusEdge {
  /** Source file path. */
  source: string;

  /** Target file path. */
  target: string;

  /** Edge type: import, co-change, or doc co-occurrence. */
  type: "import" | "co_change" | "doc_cooc";

  /** Edge weight / score. */
  weight: number;
}

/** Result of a focused architecture subgraph query. */
export interface FocusResult {
  /** The resolved target (file path or search term). */
  target: string;

  /** Nodes in the focused subgraph. */
  nodes: FocusNode[];

  /** Edges in the focused subgraph. */
  edges: FocusEdge[];

  /** Total number of files in the expanded neighborhood (before truncation). */
  totalNeighborhood: number;

  /** Number of hops used. */
  hops: number;
}

// =============================================================================
// CARI Impact Analysis
// =============================================================================

export interface CariImpactParams {
  /** Changed file paths (relative to workspace root). */
  changed: string[];
  /** Max hops to expand via import graph (default: 2). */
  hops?: number;
  /** Max results per category (default: 50). */
  limit?: number;
}

export interface CariImpactFile {
  /** File path. */
  filePath: string;
  /** How this file is connected to the change. */
  via: "import" | "reverse-import" | "co-change" | "doc-mention";
  /** Hop distance from the changed file (imports only). */
  depth: number;
  /** Coupling strength (jaccard for co-change, confidence for annotations). */
  score: number;
}

export interface CariImpactDoc {
  /** Documentation file that references the changed code. */
  docPath: string;
  /** Number of annotations referencing changed files. */
  mentionCount: number;
  /** Max confidence among annotations. */
  maxConfidence: number;
  /** Specific symbols mentioned. */
  symbols: string[];
}

export interface CariImpactResult {
  /** The analyzed file(s). */
  files: string[];
  /** Files that import the changed file(s) (downstream dependents). */
  dependents: CariImpactFile[];
  /** Files imported by the changed file(s) (upstream dependencies). */
  dependencies: CariImpactFile[];
  /** Files that historically co-change with the changed file(s). */
  coChangePartners: CariImpactFile[];
  /** Documentation files referencing symbols in the changed file(s). */
  affectedDocs: CariImpactDoc[];
  /** Stats summary. */
  stats: {
    filesAnalyzed: number;
    dependentCount: number;
    dependencyCount: number;
    coChangeCount: number;
    affectedDocCount: number;
  };
}

// =============================================================================
// 5.3 Dead Feature Detection
// =============================================================================

/** A single dead feature candidate with evidence from all three signals. */
export interface DeadFeatureCandidate {
  /** Symbol name. */
  name: string;
  /** Symbol kind (function, class, method, variable, type). */
  kind: string;
  /** File path of the symbol. */
  filePath: string;
  /** Line number. */
  line: number;
  /** Whether the symbol is exported but never imported. */
  unusedExport: boolean;
  /** Whether the symbol has zero documentation references. */
  undocumented: boolean;
  /** Whether the file hasn't been modified in 6+ months. */
  stale: boolean;
  /** ISO timestamp of last modification (null if unknown). */
  lastModified: string | null;
  /** Number of signals that fired (1–3). Higher = more likely dead. */
  signalCount: number;
}

/** Result of the dead feature detection query. */
export interface DeadFeatureResult {
  /** Candidates sorted by signal count (desc) then name. */
  candidates: DeadFeatureCandidate[];
  /** Total candidates found. */
  totalCandidates: number;
  /** Breakdown by signal count. */
  bySignalCount: { three: number; two: number; one: number };
  /** Staleness threshold used (months). */
  stalenessMonths: number;
}

// =============================================================================
// 5.4 API Surface Changelog
// =============================================================================

/** A single API change between baseline and current state. */
export interface ApiChange {
  /** Symbol name. */
  name: string;
  /** Symbol kind (function, class, interface, type, variable, method). */
  kind: string;
  /** File path (relative to workspace). */
  filePath: string;
  /** Type of change. */
  changeType: "added" | "removed" | "signature-changed";
  /** Old signature (for removed and signature-changed). */
  oldSignature?: string;
  /** New signature (for added and signature-changed). */
  newSignature?: string;
  /** Current line number (for added and signature-changed). */
  line?: number;
}

/** Per-package summary of API changes. */
export interface ApiPackageSummary {
  added: number;
  removed: number;
  changed: number;
}

/** Result of the API surface changelog analysis. */
export interface ApiSurfaceResult {
  /** Git ref used as baseline. */
  baseline: string;
  /** All API changes sorted by type then name. */
  changes: ApiChange[];
  /** Overall summary counts. */
  summary: ApiPackageSummary;
  /** Breakdown by package/directory. */
  byPackage: Record<string, ApiPackageSummary>;
  /** Number of code files analyzed. */
  filesAnalyzed: number;
}

// =============================================================================
// Selective Semantic Enrichment (11.8)
// =============================================================================

/** Weights for the enrichment impact scoring formula. */
export interface EnrichmentWeights {
  hotspot: number;
  orphan: number;
  hub: number;
  coverage: number;
  drift: number;
}

/** A file scored as a candidate for semantic enrichment. */
export interface EnrichmentCandidate {
  /** File path (workspace-relative). */
  filePath: string;
  /** Composite impact score (higher = more valuable to enrich). */
  impactScore: number;
  /** Breakdown of signal contributions. */
  signals: {
    hotspotRank: number;
    orphanRatio: number;
    hubDegree: number;
    coverageGap: number;
    driftSeverity: number;
  };
  /** Whether this file was already enriched (content hash matched). */
  alreadyEnriched: boolean;
}

/** Result of scoring files for enrichment candidacy. */
export interface EnrichmentScoreResult {
  /** Candidates sorted by impactScore descending. */
  candidates: EnrichmentCandidate[];
  /** Total files evaluated. */
  totalEvaluated: number;
}

/** Options for the enrich command. */
export interface EnrichOptions {
  /** Max number of LLM calls (files to enrich). Default: 20. */
  budget?: number;
  /** Minimum impact score to qualify. Default: 0.1. */
  threshold?: number;
  /** Restrict to files under this directory prefix. */
  focus?: string;
  /** LLM provider name: "openai" or "smart-mock". */
  provider?: string;
  /** LLM model name. */
  model?: string;
  /** OpenAI API key override. */
  apiKey?: string;
  /** Skip files whose content hash hasn't changed since last enrichment. */
  incremental?: boolean;
  /** Only show what would be enriched, don't run LLM. */
  dryRun?: boolean;
  /** Verbose output. */
  verbose?: boolean;
  /** Custom weights for impact scoring. */
  weights?: Partial<EnrichmentWeights>;
}

/** Result of running semantic enrichment. */
export interface EnrichResult {
  /** Files that were enriched. */
  enriched: Array<{
    filePath: string;
    impactScore: number;
    entityCount: number;
    tripleCount: number;
    tokensUsed?: number;
  }>;
  /** Files skipped (already enriched / below threshold). */
  skipped: Array<{
    filePath: string;
    reason: "already-enriched" | "below-threshold" | "outside-focus";
  }>;
  /** Total entities written to kg_entities. */
  totalEntities: number;
  /** Total relationships written to kg_relationships. */
  totalRelationships: number;
  /** Total entities bridged into CARI via registerEntities(). */
  totalBridged: number;
  /** Token usage summary. */
  tokenUsage?: { prompt: number; completion: number; costUsd?: number };
}
