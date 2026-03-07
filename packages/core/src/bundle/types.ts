/**
 * Graph Bundle Types
 * 
 * Defines the consolidated bundle format for run outputs.
 */

// =============================================================================
// Overview (fast-loading summary)
// =============================================================================

export interface RunOverview {
  $schema: 'intentweave://schemas/run-overview/v1';
  schemaVersion: '0.1';
  
  runId: string;
  workspaceKey: string;
  sessionKey?: string;
  
  // Timing
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  
  // Status
  status: 'running' | 'completed' | 'failed';
  profile: string;
  stages: string[];
  
  // Counts
  counts: {
    artifacts: number;
    entities: number;
    statements: number;
    lxProposals: number;
    findings: number;
  };
  
  // Entity type distribution
  entityTypes: Record<string, number>;
  
  // Artifact role distribution
  artifactRoles: Record<string, number>;
  
  // Top artifacts by entity count
  topArtifacts: Array<{
    id: string;
    path: string;
    role: string;
    entityCount: number;
    statementCount: number;
  }>;
}

// =============================================================================
// Graph Bundle (consolidated)
// =============================================================================

export interface GraphBundle {
  $schema: 'intentweave://schemas/graph-bundle/v1';
  schemaVersion: '0.1';
  
  runId: string;
  sessionKey?: string;
  generatedAt: string;
  
  artifacts: BundleArtifact[];
  entities: BundleEntity[];
  statements: BundleStatement[];
  lx: BundleLinkProposal[];
}

export interface BundleArtifact {
  id: string;
  path: string;
  role: string;
  entityCount: number;
  statementCount: number;
}

export interface BundleEntity {
  cgId: string;
  name: string;
  type: string;
  artifactId: string;
  artifactRole: string;
  confidence?: number;
  aliases?: string[];
}

export interface BundleStatement {
  id: string;
  subjectCgId: string;
  predicate: string;
  objectCgId?: string;
  objectLiteral?: string;
  artifactId: string;
  confidence?: number;
  evidenceSourceKey?: string;
}

export interface BundleLinkProposal {
  id: string;
  sourceCgId: string;
  targetCgId: string;
  predicate: string;
  confidence: number;
  matchMethod: string;
}

// =============================================================================
// JSONL Record Types (for streaming large bundles)
// =============================================================================

export interface EntityRecord extends BundleEntity {
  _type: 'entity';
}

export interface StatementRecord extends BundleStatement {
  _type: 'statement';
}

export interface LxRecord extends BundleLinkProposal {
  _type: 'lx';
}

// =============================================================================
// Bundle Options
// =============================================================================

export interface BundleOptions {
  /** Threshold for switching to JSONL format */
  jsonlThreshold?: number;
  /** Include full evidence in statements */
  includeEvidence?: boolean;
  /** Maximum entities per artifact in top list */
  topArtifactLimit?: number;
}

export const DEFAULT_BUNDLE_OPTIONS: Required<BundleOptions> = {
  jsonlThreshold: 10000,
  includeEvidence: false,
  topArtifactLimit: 20,
};
