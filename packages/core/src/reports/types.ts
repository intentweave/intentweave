/**
 * Report Types
 * 
 * JSON schema types for IntentWeave reports.
 * See docs/REPORTING-SPEC.md for full specification.
 * 
 * Note: Some types are prefixed with "Report" to avoid collision
 * with existing core types (Evidence, ArtifactRole, ImportState).
 */

// =============================================================================
// Core Types
// =============================================================================

export type IssueKind = 'contradiction' | 'open_end' | 'needs_review' | 'error';
export type IssueSeverity = 'blocker' | 'warning' | 'info';
export type IssueStatus = 'active' | 'resolved' | 'regressed';
export type ReportArtifactRole = 'intent' | 'spec' | 'implementation' | 'runlog' | 'meta' | 'unknown';
export type PipelineStage = 'IN' | 'RX' | 'CX' | 'MX' | 'PX' | 'AGG' | 'WX' | 'LX';

export type SuggestedActionType = 'code_change' | 'spec_update' | 'role_override' | 'add_test';

// =============================================================================
// Report Policy
// =============================================================================

export interface ReportPolicy {
  /** Minimum confidence to include issue (default: 0.5) */
  minConfidence: number;
  
  /** Confidence threshold for blocker severity (default: 0.75) */
  blockerConfidence: number;
  
  /** Confidence threshold for warning severity (default: 0.6) */
  warningConfidence: number;
  
  /** Filter by issue kinds (default: all) */
  includeKinds: IssueKind[];
  
  /** Filter by artifact roles (default: intent, spec, implementation) */
  includeRoles: ReportArtifactRole[];
  
  // Compact mode limits
  /** Maximum issues to include (default: unlimited) */
  maxIssues?: number;
  
  /** Maximum issues per kind (default: unlimited) */
  maxIssuesPerKind?: number;
  
  /** Maximum evidence items per issue (default: 5) */
  maxEvidencePerIssue?: number;
  
  /** Maximum characters per excerpt (default: 500) */
  maxExcerptChars?: number;
}

export const DEFAULT_REPORT_POLICY: ReportPolicy = {
  minConfidence: 0.5,
  blockerConfidence: 0.75,
  warningConfidence: 0.6,
  includeKinds: ['contradiction', 'open_end', 'needs_review', 'error'],
  includeRoles: ['intent', 'spec', 'implementation'],
  maxEvidencePerIssue: 5,
  maxExcerptChars: 500,
};

// =============================================================================
// Evidence
// =============================================================================

export interface RawSourceLocation {
  file: string;
  byteStart: number;
  byteEnd: number;
}

export interface ReportEvidence {
  /** Source key: <source>:<sessionId>:m:<seq> */
  sourceKey: string;
  
  /** Message sequence number (redundant but convenient) */
  seq: number;
  
  /** Relevant text snippet */
  excerpt: string;
  
  /** UTF-8 character offset start */
  charStart?: number;
  
  /** UTF-8 character offset end */
  charEnd?: number;
  
  /** Canonical reference: iw://message/<sourceKey> */
  ref: string;
  
  /** Physical transcript path */
  transcriptPath?: string;
  
  /** Raw source location (adapter-level detail) */
  rawSourceLoc?: RawSourceLocation;
}

// =============================================================================
// Graph References
// =============================================================================

export interface GraphRef {
  nodeId?: string;
  edgeId?: string;
  predicate?: string;
  entityName?: string;
}

// =============================================================================
// Suggested Actions
// =============================================================================

export interface IssueSuggestedAction {
  type: SuggestedActionType;
  description: string;
  /** CLI command to apply (shown inline) */
  command?: string;
}

export interface SuggestedAction {
  rank: number;
  /** Links to issue */
  issueId?: string;
  description: string;
  /** Estimated effort: "2h", "0.5d", "2d" */
  estimatedEffort?: string;
  /** CLI command */
  command?: string;
  /** Computed score for transparency */
  actionScore?: number;
}

// =============================================================================
// Issues
// =============================================================================

export interface Issue {
  /** Short ID: C-1, O-2, N-3, E-4 */
  id: string;
  
  /** Globally unique: chat:specstory:90dd218c#C-1 */
  issueKey: string;
  
  /** SHA256 hash of semantic core for stability */
  fingerprint: string;
  
  severity: IssueSeverity;
  kind: IssueKind;
  
  /** One-line summary */
  title: string;
  
  /** Detailed explanation */
  description?: string;
  
  /** Confidence score 0.0-1.0 */
  confidence: number;
  
  // Status tracking
  status: IssueStatus;
  firstSeenRunId: string;
  lastSeenRunId: string;
  resolvedAt?: string;
  
  // Severity modifiers
  stage?: PipelineStage;
  /** True => blocker regardless of confidence */
  stageBreaking?: boolean;
  /** For "missing must-have ticket" open ends */
  mustHave?: boolean;
  
  // Evidence
  evidence: ReportEvidence[];
  
  // Graph references
  graphRefs?: GraphRef[];
  
  // Suggested fixes (inline commands for assistants)
  suggestedActions?: IssueSuggestedAction[];
}

// =============================================================================
// Fingerprint Inputs (for computing stable fingerprints)
// =============================================================================

export interface ContradictionFingerprint {
  kind: 'contradiction';
  specClaimSourceKey: string;
  implObservationSourceKey: string;
  predicate?: string;
  entityName?: string;
}

export interface OpenEndFingerprint {
  kind: 'open_end';
  fromRole: ReportArtifactRole;
  toRole: ReportArtifactRole;
  entityName?: string;
  predicate?: string;
}

export interface NeedsReviewFingerprint {
  kind: 'needs_review';
  ambiguityType: string;
  entityName?: string;
  predicate?: string;
}

export interface ErrorFingerprint {
  kind: 'error';
  errorCode: string;
  adapterName?: string;
  stage?: PipelineStage;
}

export type IssueFingerprint = 
  | ContradictionFingerprint 
  | OpenEndFingerprint 
  | NeedsReviewFingerprint 
  | ErrorFingerprint;

// =============================================================================
// Issue Registry (persisted per session)
// =============================================================================

export interface IssueRegistryEntry {
  id: string;
  firstSeen: string;
  lastSeen: string;
  resolved?: string;
}

export interface IssueRegistry {
  /** Map fingerprint hash -> entry */
  fingerprints: Record<string, IssueRegistryEntry>;
  /** Next ID counter per prefix */
  nextId: {
    C: number;
    O: number;
    N: number;
    E: number;
  };
}

export const EMPTY_ISSUE_REGISTRY: IssueRegistry = {
  fingerprints: {},
  nextId: { C: 1, O: 1, N: 1, E: 1 },
};

// =============================================================================
// Run Report (main output)
// =============================================================================

export interface ReportArtifact {
  id: string;
  type: 'chat' | 'file';
  source: string;
  messageCount?: number;
}

export interface ReportImportState {
  /** Last processed file offset */
  lastOffset: number;
  /** Last known file size */
  lastSize: number;
  /** Prefix hash for change detection */
  prefixHash: string;
  /** Last processed sequence number */
  lastProcessedSeq: number;
  /** Number of source files tracked */
  sourceCount?: number;
}

export interface ReportInputs {
  artifacts: ReportArtifact[];
  profile: string;
  configHash: string;
  transcriptPath?: string;
  rolesPath?: string;
  transcriptFingerprint?: string;
  importState?: ReportImportState;
  reportPolicy: ReportPolicy;
}

export interface FilteredOutCounts {
  meta: number;
  runlog: number;
  unknown: number;
}

export interface IssueTrend {
  newIssues: number;
  resolvedIssues: number;
  recurringIssues: number;
}

export interface ReportSummary {
  totalMessages: number;
  totalEntities: number;
  totalStatements: number;
  roleDistribution: Record<string, number>;
  filteredOutCounts?: FilteredOutCounts;
  
  // Coverage metrics
  intentToSpecCoverage: number;
  specToImplCoverage: number;
  
  // Issue counts
  contradictions: number;
  openEnds: number;
  needsReview: number;
  errors: number;
  
  // Trend vs previous run
  trend?: IssueTrend;
  
  // Top issue for TL;DR
  topIssue?: string;
}

export interface CacheReuse {
  totalChunks: number;
  reusedChunks: number;
  recomputedChunks: number;
}

export interface RunIdentity {
  id: string;
  ts: string;
  mode: 'full' | 'incremental';
  durationMs: number;
  reuse?: CacheReuse;
}

export interface StageTimings {
  IN?: number;
  RX?: number;
  CX?: number;
  MX?: number;
  PX?: number;
  AGG?: number;
  LX?: number;
  total: number;
}

export interface RunDelta {
  newMessages: number;
  roleOverrides: number;
  stagesRecomputed: string[];
}

export interface GeneratorMetadata {
  /** e.g., "iw@0.6.0" */
  version: string;
  /** Git commit hash if available */
  gitSha?: string;
  /** Heuristics version e.g., "1.2" */
  heuristicsVersion: string;
  /** Adapter versions e.g., { "specstory": "0.1.0" } */
  adapterVersions: Record<string, string>;
}

export interface RunReport {
  $schema: 'intentweave://schemas/report/v1';
  schemaVersion: '0.1';
  
  run: RunIdentity;
  inputs: ReportInputs;
  summary: ReportSummary;
  issues: Issue[];
  actions: SuggestedAction[];
  timings: StageTimings;
  delta?: RunDelta;
  generator: GeneratorMetadata;
}

// =============================================================================
// Problems Report (subset for UI/MCP)
// =============================================================================

export interface ProblemsReport {
  run: Pick<RunIdentity, 'id' | 'ts' | 'mode'>;
  summary: Pick<ReportSummary, 'contradictions' | 'openEnds' | 'needsReview' | 'errors'>;
  issues: Issue[];
  actions: SuggestedAction[];
}
