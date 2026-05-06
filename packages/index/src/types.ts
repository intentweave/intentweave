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

  /**
   * Per-file doc_group overrides for multi-root builds.
   * Maps absolute file path → group label (e.g. `"intentweave.org"`).
   * When a file has an entry here it takes precedence over `classifyDocGroup()`.
   */
  docGroupOverride?: Map<string, string>;
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
    rationale: number;
    calls: number;
    propertyAccesses: number;
    typeAssertions: number;
    testDescriptions: number;
    variableAssignments: number;
    defUseChains: number;
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
    /** Layer classification for this clone group (present when layerAnalysis option is enabled) */
    layerAnalysis?: {
      kind: "architectural" | "dry" | "unknown";
      layers: number[];
      uniqueLayers: number[];
      suggestion: string;
    };
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
    /** Layer classification for this clone group (present when layerAnalysis option is enabled) */
    layerAnalysis?: {
      kind: "architectural" | "dry" | "unknown";
      layers: number[];
      uniqueLayers: number[];
      suggestion: string;
    };
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

    /** Optional visual row for prescriptive SVG layout (smaller renders higher) */
    row?: number;

    /** Optional visual column for prescriptive SVG layout */
    column?: number;

    /** Optional visual horizontal span in grid cells */
    col_span?: number;

    /** Optional visual vertical span in grid cells */
    row_span?: number;

    /** Optional side-lane hint for cross-cutting layers */
    side?: "left" | "right";
  }>;

  /** Whether to allow skip-layer imports (default: false) */
  allowSkipLayer?: boolean;

  /**
   * Explicit allowed import overrides. Suppresses the synthetic forbidden edge
   * for the named from→to layer pair in the prescriptive architecture report.
   *
   * Example: providers layer is allowed to import node builtins even though
   * the rules.yaml adr003 rule also fires on its scope glob.
   */
  allowed?: Array<{ from: string; to: string }>;
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

// =============================================================================
// Spec-to-Code Verification (12.1)
// =============================================================================

/** Grounding status for a single KG entity. */
export type GroundingStatus =
  | "grounded"
  | "ungrounded"
  | "partial"
  | "untested";

/** A single entity verification finding. */
export interface VerifyEntityResult {
  /** Canonical entity ID from kg_entities. */
  canonId: string;
  /** Entity display name. */
  name: string;
  /** Entity type (decision, requirement, component, etc.). */
  entityType: string;
  /** Source doc file the entity was extracted from. */
  sourceFile: string;
  /** Grounding status. */
  status: GroundingStatus;
  /** Code symbols that ground this entity (empty if ungrounded). */
  groundedIn: Array<{
    symbolId: string;
    symbolName: string;
    filePath: string;
    kind: string;
    confidence: number;
  }>;
  /** Whether the grounded symbols have test coverage. */
  hasCoverage: boolean;
  /** Human-readable summary of the finding. */
  message: string;
}

/** Parameters for the verify query. */
export interface VerifyParams {
  /** Restrict verification to entities from these source files. */
  files?: string[];
  /** Only verify entities of these types. */
  types?: string[];
  /** Minimum annotation confidence to count as grounded. */
  minConfidence?: number;
  /** Check test coverage for grounded entities. */
  checkTests?: boolean;
}

/** Result of spec-to-code verification. */
export interface VerifyResult {
  /** All entity verification findings. */
  entities: VerifyEntityResult[];
  /** Summary statistics. */
  summary: {
    total: number;
    grounded: number;
    ungrounded: number;
    partial: number;
    untested: number;
    coveragePercent: number;
  };
  /** Per-source-file breakdown. */
  byFile: Array<{
    file: string;
    total: number;
    grounded: number;
    ungrounded: number;
    coveragePercent: number;
  }>;
}

// =============================================================================
// Query: consistency (12.2 — Constraint Consistency Check)
// =============================================================================

/** Severity of a constraint conflict. */
export type ConflictSeverity = "error" | "warning";

/** A single detected constraint conflict between two relationships. */
export interface ConstraintConflict {
  /** Entity on the "from" side of both relationships. */
  entityA: { canonId: string; name: string };
  /** Entity on the "to" side of both relationships. */
  entityB: { canonId: string; name: string };
  /** Predicate in the first relationship. */
  predicateA: string;
  /** Predicate in the second (contradicting) relationship. */
  predicateB: string;
  /** Source file of the first relationship. */
  sourceFileA: string;
  /** Source file of the second relationship. */
  sourceFileB: string;
  /** Error = hard contradiction, warning = potential conflict. */
  severity: ConflictSeverity;
  /** Human-readable conflict description. */
  message: string;
}

/** Parameters for the consistency check. */
export interface ConsistencyParams {
  /** Restrict check to relationships from these source files. */
  files?: string[];
  /** Only check relationships involving entities of these types. */
  types?: string[];
  /** Minimum relationship confidence to include. */
  minConfidence?: number;
}

/** Result of constraint consistency check. */
export interface ConsistencyResult {
  /** All detected conflicts. */
  conflicts: ConstraintConflict[];
  /** Summary statistics. */
  summary: {
    totalRelationships: number;
    totalConflicts: number;
    errors: number;
    warnings: number;
    consistencyPercent: number;
  };
}

// =============================================================================
// Query: livingScore (12.3 — Living Documentation Score)
// =============================================================================

/** Parameters for computing the living documentation score. */
export interface LivingScoreParams {
  /** Minimum annotation confidence to count as grounded (default: 0.5). */
  minConfidence?: number;
  /** Allow skipping layer-order violations in layer check (default: false). */
  allowSkipLayer?: boolean;
}

/** A single dimension of the living documentation score. */
export interface LivingScoreDimension {
  /** Human-readable label for the dimension. */
  label: string;
  /** Numeric score, 0–100. */
  score: number;
  /** Raw numerator (e.g. grounded entities count). */
  numerator: number;
  /** Raw denominator (e.g. total entities). */
  denominator: number;
  /** Short note — e.g. "17/20 requirements grounded". */
  detail: string;
  /** Whether the underlying data was available (false = dimension skipped). */
  available: boolean;
}

/** Composite living documentation score. */
export interface LivingScoreResult {
  /** Overall score 0–100, average of available dimensions. */
  score: number;
  /** Grade: A (≥90), B (≥75), C (≥60), D (≥45), F (<45). */
  grade: "A" | "B" | "C" | "D" | "F";
  /** Spec coverage (12.1): % of KG entities grounded in code. */
  specCoverage: LivingScoreDimension;
  /** Constraint consistency (12.2): % of constraints without contradictions. */
  constraintConsistency: LivingScoreDimension;
  /** Documentation freshness: % of docs not stale (from report). */
  docFreshness: LivingScoreDimension;
  /** Architecture conformance: % of layer imports without violations. */
  archConformance: LivingScoreDimension;
}

// =============================================================================
// Query: archCheck (5.8 — Architecture Diagram Validation)
// =============================================================================

/** A named component defined in architecture.yaml. */
export interface ArchComponent {
  /** Component display name. */
  name: string;
  /** File glob patterns that belong to this component. */
  files: string[];
  /**
   * Alternative names / known code symbols for this component.
   * Populated by the LLM at scan-diagrams time for noise-free entity matching.
   * E.g. KWG → ["keyword graph", "kwxStage", "heuristicExtractor"]
   */
  aliases?: string[];
}

/** A declared data flow between components. */
export interface ArchFlow {
  /** Source component name. */
  from: string;
  /** Target component name(s). */
  to: string | string[];
}

/** A forbidden-dependency constraint. */
export interface ArchConstraint {
  /** Constraint type. */
  type: "no-direct-dependency";
  /** Source component name. */
  from: string;
  /** Target component name. */
  to: string;
  /** Human-readable reason for the constraint. */
  reason?: string;
}

/** Architecture diagram configuration (from .iw/architecture.yaml). */
export interface ArchConfig {
  components: ArchComponent[];
  flows?: ArchFlow[];
  constraints?: ArchConstraint[];
}

/** Status of a declared flow. */
export type FlowStatus = "confirmed" | "missing";

/** A validated architecture flow finding. */
export interface ArchFlowResult {
  /** Source component. */
  from: string;
  /** Target component. */
  to: string;
  /** Whether the flow exists in the import graph. */
  status: FlowStatus;
  /** Import edges that confirm the flow (empty if missing). */
  evidence: Array<{ sourceFile: string; targetFile: string }>;
}

/** An undocumented import between components not declared in any flow. */
export interface UndocumentedFlow {
  /** Source component. */
  from: string;
  /** Target component. */
  to: string;
  /** Import edges that constitute this undocumented flow. */
  edges: Array<{ sourceFile: string; targetFile: string }>;
}

/** A constraint violation finding. */
export interface ArchConstraintViolation {
  /** Source component. */
  from: string;
  /** Target component. */
  to: string;
  /** Constraint reason. */
  reason: string;
  /** Import edges that violate the constraint. */
  edges: Array<{ sourceFile: string; targetFile: string }>;
}

// =============================================================================
// Query: resolveComponent
// =============================================================================

/**
 * A code symbol matched to an architecture diagram component.
 */
export interface ResolvedSymbol {
  /** Stable symbol ID from AX (impl:<path>#<kind>:<name>) */
  id: string;
  /** Symbol name as it appears in code */
  name: string;
  /** Symbol kind: class | function | variable | interface | type | etc. */
  kind: string;
  /** File path (relative to workspace) */
  filePath: string;
}

/**
 * Result of resolving an architecture diagram component name against
 * the CARI index (symbols, annotations, co-occurrences).
 */
export interface ResolvedComponent {
  /** Original diagram component name */
  name: string;

  /**
   * Normalized search terms derived from the index, suitable for use in
   * co-occurrence / annotation lookups. These replace LLM-guessed aliases
   * with index-grounded terms.
   *
   * Includes: normalised component name + matched symbol names + matched
   * annotation text values, all lowercased and deduplicated.
   */
  terms: string[];

  /** Code symbols that matched the component name */
  symbols: ResolvedSymbol[];

  /** Doc files that mention this component (ordered by mention count) */
  docFiles: string[];

  /**
   * Overall confidence that the component name resolves to real index entries.
   * - 0.0 = nothing found
   * - 0.0–0.3 = co-occurrence signal only
   * - 0.3–0.6 = annotation match (ungrounded)
   * - 0.6–0.85 = annotation match (grounded to symbol)
   * - 0.85–1.0 = exact symbol name match
   */
  confidence: number;

  /** Human-readable explanation of how the component was resolved */
  evidence: string[];
}

export interface ResolveComponentParams {
  /** Diagram component name to resolve */
  name: string;

  /** Maximum symbols to return (default: 10) */
  limitSymbols?: number;

  /** Maximum doc files to return (default: 5) */
  limitDocs?: number;
}

export interface ResolveComponentResult {
  resolved: ResolvedComponent;
}

/** Result of architecture diagram validation. */
export interface ArchCheckResult {
  /** Validated declared flows. */
  flows: ArchFlowResult[];
  /** Imports between components not declared in any flow. */
  undocumented: UndocumentedFlow[];
  /** Constraint violations. */
  constraintViolations: ArchConstraintViolation[];
  /** Components and their assigned file counts. */
  componentSummary: Array<{ name: string; fileCount: number }>;
  /** Summary statistics. */
  summary: {
    totalFlows: number;
    confirmedFlows: number;
    missingFlows: number;
    undocumentedFlows: number;
    constraintViolations: number;
    conformancePercent: number;
  };
}

// =============================================================================
// Query: namingViolations (6.1 — Naming Convention Violations)
// =============================================================================

/** A single naming convention violation. */
export interface NamingViolation {
  /** Symbol name that violates the convention */
  name: string;
  /** Symbol kind (function, class, method, etc.) */
  kind: string;
  /** File containing the symbol */
  filePath: string;
  /** Line number */
  line: number;
  /** Expected naming pattern (description) */
  expected: string;
  /** Export status */
  export: string;
}

/** Result of naming convention analysis. */
export interface NamingViolationsResult {
  violations: NamingViolation[];
  totalViolations: number;
  byKind: Record<string, number>;
}

// =============================================================================
// Query: commentCodeRatio (6.4 — Comment-to-Code Ratio Anomalies)
// =============================================================================

/** Per-file comment-to-code ratio entry. */
export interface CommentCodeRatioEntry {
  /** File path */
  filePath: string;
  /** Number of comment lines */
  commentLines: number;
  /** Number of code lines (non-blank, non-comment) */
  codeLines: number;
  /** Ratio of comment lines to code lines */
  ratio: number;
  /** Whether this file is an anomaly (too low or too high) */
  anomaly: "under-commented" | "over-commented" | null;
}

/** Result of comment-to-code ratio analysis. */
export interface CommentCodeRatioResult {
  files: CommentCodeRatioEntry[];
  /** Files with anomalous ratios */
  anomalies: CommentCodeRatioEntry[];
  /** Workspace average ratio */
  averageRatio: number;
  totalFiles: number;
}

// =============================================================================
// Query: skippedFiles (6.5 — AX File Skip Warning)
// =============================================================================

/** A file that was skipped during AX extraction due to size. */
export interface SkippedFileEntry {
  /** File path */
  filePath: string;
  /** Reason for skipping */
  reason: string;
}

/** Result of skipped files query. */
export interface SkippedFilesResult {
  skipped: SkippedFileEntry[];
  totalSkipped: number;
}

// ─── Semantic Rule Checking Types (13.2) ────────────────────────────────────

/**
 * One forbidden pattern clause inside a rule definition.
 */
export interface RuleForbidden {
  /**
   * Type of check:
   * - `property_access`: matches against `property_accesses.chain`
   * - `call`: matches against `symbol_calls.callee_name` (regex)
   * - `symbol_name`: matches against `symbols.name` (regex)
   * - `import_pattern`: matches against `imports.module_specifier` (glob)
   * - `variable_assignment`: matches assignment RHS text in `variable_assignments.value_text` (regex)
   * - `cypher`: CypherLite query over CARI graph projection (or raw SQL fallback)
   * - `property_chain_length`: flags property access chains rooted at a symbol that exceed a minimum depth
   */
  type:
    | "property_access"
    | "call"
    | "symbol_name"
    | "import_pattern"
    | "variable_assignment"
    | "cypher"
    | "property_chain_length";

  /** Glob for property_access chain (e.g. "**.source.path") */
  chain?: string;

  /** Regex or pipe-separated names for call/symbol_name (e.g. "refToId|idToName") */
  callee?: string;

  /** Regex/name pattern for symbol_name or import_pattern */
  pattern?: string;

  /** When true, treat `pattern` as a regex source (or /.../) for import_pattern */
  regex?: boolean;

  /**
   * Scope modifier for symbol_name rules (13.9):
   * - `exported` (default): only exported top-level declarations
   * - `top-level`: exported + non-exported top-level declarations (no container)
   * - `any`: same as `top-level` in Phase 1 (local vars require Phase 2 AX extension)
   */
  scope?: "exported" | "top-level" | "any";

  /**
   * RHS value pattern for variable_assignment rules (13.10).
   * Matched as a regex against the first 120 chars of the assignment RHS.
   */
  value_pattern?: string;

  /**
   * Query for cypher rules (13.11).
   * Preferred: CypherLite syntax over the CARI graph projection.
   * Also supported: raw SQL fallback for advanced/debug use.
   *
   * Query output must include three columns:
   * - `file TEXT`
   * - `line INTEGER|null`
   * - `detail TEXT`
   *
   * Any row returned = one violation.
   *
   * Example (CypherLite):
   * ```cypher
   * MATCH (s:Symbol)
   * WHERE s.fan_in > 0
   *   AND NOT EXISTS { MATCH (s)-[:ANNOTATED_BY]->(:DocSpan) }
   * RETURN s.file AS file, s.line AS line,
   *        s.name + ' has fan_in>0 but no doc annotation' AS detail
   * ```
   */
  query?: string;

  /** Glob restricting which files are in scope (e.g. "apps/ui/**") */
  in?: string;

  /**
   * Explicit target layer name for `import_pattern` rules whose `pattern` cannot be
   * resolved to a layer automatically (e.g. patterns starting with "**&#47;").
   * When set, the forbidden edge is drawn from the source layer to this named layer.
   *
   * Example: target_layer: "apps/arcdata-api"
   */
  target_layer?: string;

  /** Glob(s) to exclude from scope */
  except?: string | string[];

  /**
   * Only flag when the same file+line also has a property access matching this glob.
   * Used for context-specific detection (e.g. "flag match() only when .source.path is accessed").
   */
  context_access?: string;

  /**
   * Only flag when the caller file also imports from a glob-matching module specifier (15.1).
   * Restricts `call` and `property_access` rules to files that depend on a specific import.
   *
   * Example: `context_import: '@acme/engine/src/transformers/**'`
   */
  context_import?: string;

  /**
   * Suppress violations whose enclosing function/method name matches any of these values (15.2).
   * Matches against `symbol_calls.caller_name` / `property_accesses.symbol_name`.
   *
   * Example: `except_symbol: ['parseSearchQuery', 'formatBreadcrumb']`
   */
  except_symbol?: string | string[];

  /**
   * Enable intra-function taint propagation (16.1).
   *
   * When a `property_access` or `call` violation fires on an assignment line,
   * the assigned variable is treated as tainted and downstream reads of that
   * variable in the same function are also reported as violations.
   */
  taint_propagation?: boolean;

  /**
   * Root symbol name for `property_chain_length` rules (15.3).
   * Only property accesses that start from a variable with this name are evaluated.
   *
   * Example: `root: 'entity'`
   */
  root?: string;

  /**
   * Minimum chain depth (number of `.`-segments) for `property_chain_length` rules (15.3).
   * Chains with fewer segments are not flagged.
   *
   * Example: `min_depth: 4`
   */
  min_depth?: number;
}

/**
 * Autofix hint block embedded in a rule definition (15.5).
 * Rendered in `--format text` output and included in `--format json` violation objects.
 */
export interface AutofixHint {
  /** Short remediation instruction (shown in CLI output) */
  hint: string;
  /** Workspace-relative file path or URL pointing to the canonical fix location */
  reference?: string;
}

/** One rule definition (from rules.yaml). */
export interface RuleDefinition {
  id: string;
  description?: string;
  adr?: string;
  severity: "high" | "medium" | "low";
  /**
   * Violation counting mode (15.4).
   * - `per_occurrence` (default): one violation per matching occurrence
   * - `per_file`: at most one violation per file per rule (deduplicates multi-match files)
   */
  count_mode?: "per_occurrence" | "per_file";
  /**
   * Optional autofix hint shown in CLI output and included in JSON violations (15.5).
   */
  autofix?: AutofixHint;
  forbidden: RuleForbidden[];
}

/**
 * An explicit positive permission declared in `rules.yaml` (§17.2).
 * Used by the prescriptive architecture diagram to draw allowed (green) edges
 * between layers. When `allowed:` is omitted the prescriptive renderer derives
 * permitted edges as "within-layer or one-step-down in declared layer order".
 *
 * Can also feed into `cari_layers_check` to verify that the actual import graph
 * contains the expected flows (not just the absence of forbidden ones).
 *
 * Example (`rules.yaml`):
 * ```yaml
 * allowed:
 *   - from_layer: interface
 *     to_layer: service
 *     description: "Controllers may call service-layer code"
 *   - from_layer: service
 *     to_layer: data
 *     description: "Services may access repositories directly"
 * ```
 */
export interface RulesAllowedEntry {
  /** Source layer name (must match a layer name in layers.yaml or inferred layers) */
  from_layer: string;
  /** Destination layer name */
  to_layer: string;
  /** Optional human-readable rationale shown in CLI output and prescriptive diagram */
  description?: string;
}

/** Parsed .iw/rules.yaml config. */
export interface RulesConfig {
  version: number;
  /**
   * Optional explicit positive permissions (§17.2).
   * Declares which layer-to-layer flows are sanctioned by the team.
   * Powers green "allowed" edges in the prescriptive architecture diagram.
   * When absent, the prescriptive renderer derives permitted edges from layer order.
   */
  allowed?: RulesAllowedEntry[];
  rules: RuleDefinition[];
}

/** One violation found by rulesCheck. */
export interface RulesViolation {
  ruleId: string;
  ruleSeverity: "high" | "medium" | "low";
  ruleDescription?: string;
  adr?: string;
  filePath: string;
  line: number | null;
  symbol?: string | null;
  /** Human-readable detail about what was found */
  detail: string;
  /** Autofix hint carried from the rule definition (15.5) */
  autofix?: AutofixHint;
}

/** Result of rulesCheck. */
export interface RulesCheckResult {
  violations: RulesViolation[];
  totalViolations: number;
  bySeverity: Record<"high" | "medium" | "low", number>;
  byRule: Record<string, number>;
  rulesChecked: number;
}

// ── 14.1 Deprecated Caller Detection ────────────────────────────────────────

export interface DeprecatedCallerEntry {
  /** Stable symbol ID of the deprecated symbol */
  symbolId: string;
  /** Name of the deprecated symbol */
  symbolName: string;
  /** File path where the symbol is defined */
  symbolFile: string;
  /** Line number of the symbol definition */
  symbolLine: number;
  /** @deprecated tag note (if any) */
  deprecatedNote?: string;
  /** Callers of this deprecated symbol */
  callers: Array<{
    callerFile: string;
    callerName?: string;
    callerLine?: number;
  }>;
}

export interface DeprecatedCallersResult {
  /** One entry per deprecated symbol that has at least one active caller */
  callers: DeprecatedCallerEntry[];
  /** Total number of individual caller references */
  totalCallers: number;
  /** Total number of @deprecated symbols found in the index */
  deprecatedSymbols: number;
  /** Number of deprecated symbols that have at least one active caller */
  symbolsWithCallers: number;
}

// ── 14.2 Internal Violations ──────────────────────────────────────────────────

export interface InternalViolation {
  /** Stable symbol ID */
  symbolId: string;
  /** Symbol name */
  symbolName: string;
  /** File where the symbol is defined */
  symbolFile: string;
  /** Line of the symbol definition */
  symbolLine: number;
  /** How was it marked internal: JSDoc @internal or _prefix */
  marker: "jsdoc" | "_prefix";
  /** File that illegally imports it */
  importerFile: string;
  /** Package of the importer */
  importerPackage: string;
  /** Package of the symbol */
  symbolPackage: string;
}

export interface InternalViolationsResult {
  violations: InternalViolation[];
  totalViolations: number;
  byMarker: { jsdoc: number; underscore: number };
}

// ── 14.3 Type Assertion Inventory ───────────────────────────────────────────

export interface TypeAssertionEntry {
  file: string;
  line: number;
  kind: "as_any" | "double_cast" | "angle_cast" | "as_cast";
  context: string | null;
  targetType: string | null;
  /** Fan-in of the file (import count) — used as risk signal */
  fanIn?: number;
}

export interface TypeAssertionsResult {
  assertions: TypeAssertionEntry[];
  total: number;
  byKind: Record<"as_any" | "double_cast" | "angle_cast" | "as_cast", number>;
  /** Assertions in high fan-in files (fanIn ≥ risk threshold) */
  highRisk: TypeAssertionEntry[];
}

// ── 14.4 Decorator-Derived Layer Assignment ──────────────────────────────────

export interface DecoratorLayerAssignment {
  filePath: string;
  layer: number;
  layerName: string;
  decorators: string[];
  symbolName: string;
}

export interface LayersFromDecoratorsResult {
  assignments: DecoratorLayerAssignment[];
  layers: Record<
    number,
    { name: string; files: string[]; decorators: string[] }
  >;
  totalSymbols: number;
  preset: string;
}

// ── 14.5 ADR Conformance Trend ───────────────────────────────────────────────

export interface ConformanceSnapshot {
  snapshotId: string;
  timestamp: number;
  ruleId: string;
  adr?: string;
  filesInScope: number;
  filesClean: number;
  violationCount: number;
  conformancePct: number;
}

export interface RuleTrend {
  ruleId: string;
  adr?: string;
  snapshots: ConformanceSnapshot[];
  trend: "improving" | "worsening" | "stable" | "insufficient_data";
}

export interface RulesTrendResult {
  rules: RuleTrend[];
  days: number;
}

// ── 14.6 Test Description ↔ Symbol Alignment ─────────────────────────────────

/** A test description that references a symbol not found in the index. */
export interface TestDescriptionMatch {
  /** Test file path */
  file: string;
  /** Line number of the test call (1-based) */
  line: number;
  /** describe / it / test */
  kind: "describe" | "it" | "test";
  /** Full description text */
  description: string;
  /** Symbol name that was not found */
  missingSymbol: string;
}

export interface TestIntentResult {
  /** Total test descriptions found */
  total: number;
  /** Number of test descriptions with missing symbol references */
  staleCount: number;
  /** Test descriptions with missing symbols */
  staleTests: TestDescriptionMatch[];
  /** Test files that have multiple descriptions with no matching symbols */
  orphanedFiles: Array<{
    file: string;
    count: number;
  }>;
}
