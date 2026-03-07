/**
 * Weave Types
 * 
 * Type definitions for the WX (Weave/Canonicalization) stage.
 * Implements the two-layer identity model:
 * - cgId = provenance identity (artifact-scoped, stable across re-extractions)
 * - canonicalId = workspace identity (role-scoped, unified across artifacts)
 */

import type { ArtifactRole, EntityType } from './normalize.js';

// =============================================================================
// Evidence Types (First-Class)
// =============================================================================

/**
 * Evidence record with dual anchoring:
 * - Physical: stable within a specific artifact version (byte offsets)
 * - Logical: stable across edits (semantic content hash)
 */
export interface EvidenceRecord {
  /** Physical ID: sha256(artifactVersionId|uri|byteStart|byteEnd|excerptHash) */
  id: string;
  
  /** Logical key: sha256(artifactId|normalize(excerpt)) - stable across byte shifts */
  logicalKey: string;
  
  /** Evidence source kind */
  kind: 'iw' | 'file';
  
  /** Reference details */
  ref: {
    /** Full URI: iw://artifact/... or file path */
    uri: string;
    /** Artifact ID this evidence comes from */
    artifactId: string;
    /** Artifact version (git SHA or content hash) for physical stability */
    artifactVersionId?: string;
  };
  
  /** For transcript evidence */
  sourceKey?: string;
  /** Message sequence number (transcripts) */
  seq?: number;
  
  /** Physical location (best-effort, may shift with edits) */
  locator?: {
    byteStart?: number;
    byteEnd?: number;
    lineStart?: number;
    lineEnd?: number;
  };
  
  /** Excerpt text (truncated per policy) */
  excerpt: string;
  /** Hash of full excerpt for deduplication */
  excerptHash: string;
}

/**
 * Evidence policy configuration.
 */
export interface EvidencePolicy {
  /** Maximum excerpt length in characters */
  maxExcerptChars: number;
  /** Whether to sanitize secrets/credentials */
  sanitizeSecrets: boolean;
  /** Whether to allow code excerpts (may have IP implications) */
  allowCode: boolean;
}

export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = {
  maxExcerptChars: 300,
  sanitizeSecrets: true,
  allowCode: true,
};

// =============================================================================
// Raw Layer Types (Extended from BundleEntity/BundleStatement)
// =============================================================================

/**
 * Raw entity with evidence and canonical mapping.
 * Extends the existing BundleEntity with WX-required fields.
 */
export interface RawEntity {
  /** Stable artifact-scoped ID: sha256(artifactId|role|type|normName) */
  cgId: string;
  
  /** Display name as extracted */
  name: string;
  
  /** Entity type */
  type: EntityType;
  
  /** Source artifact */
  artifactId: string;
  
  /** Artifact role (for WX scoping) */
  artifactRole: ArtifactRole;
  
  /** Extraction confidence */
  confidence?: number;
  
  /** Evidence references */
  evidenceIds?: string[];
  
  /** Assigned by WX: canonical identity */
  canonicalId?: string;
  
  /** Additional properties */
  properties?: Record<string, unknown>;
}

/**
 * Raw statement with evidence and canonical mapping.
 */
export interface RawStatement {
  /** Statement ID (stable hash) */
  id: string;
  
  /** Subject entity cgId */
  subjectCgId: string;
  
  /** Predicate (will be normalized by WX) */
  predicate: string;
  
  /** Object entity cgId (for entity-to-entity statements) */
  objectCgId?: string;
  
  /** Literal value (for entity-to-literal statements) */
  objectLiteral?: string;
  
  /** Evidence references */
  evidenceIds?: string[];
}

// =============================================================================
// Canonical Layer Types
// =============================================================================

/**
 * Canonical entity: unified identity across artifacts within a role scope.
 * Phase 1: simplified structure focusing on core identity.
 */
export interface CanonicalEntity {
  /** Deterministic ID: ce_<hash(canonicalKey)> */
  canonicalId: string;
  
  /** Canonical key: <version>|<role>|<type>|<normName> */
  key: string;
  
  /** Entity type */
  type: EntityType;
  
  /** Artifact role scope (Phase 1: canonicalization is per-role) */
  artifactRole: ArtifactRole;
  
  /** Preferred display name */
  displayName: string;
  
  /** Raw entity cgIds that map to this canonical */
  memberCgIds: string[];
  
  /** Union of member evidence (deduplicated by logicalKey) */
  evidenceIds?: string[];
  
  /** Merged properties from member entities */
  properties?: Record<string, unknown>;
}

/**
 * Canonical statement: deduplicated relationship on canonical entities.
 */
export interface CanonicalStatement {
  /** Deterministic ID: cs_<hash(subj|pred|obj)> */
  canonicalId: string;
  
  /** Canonical subject ID */
  subjectCanonicalId: string;
  
  /** Normalized predicate */
  predicate: string;
  
  /** Canonical object ID (for entity-to-entity) */
  objectCanonicalId?: string;
  
  /** Literal value (for entity-to-literal) */
  objectLiteral?: string;
  
  /** Raw statement IDs that contribute to this canonical */
  memberStmtIds: string[];
  
  /** Union of member evidence */
  evidenceIds?: string[];
}

// =============================================================================
// Weave Mapping & Conflicts
// =============================================================================

/**
 * Mapping from raw to canonical entity.
 */
export interface EntityMapping {
  rawCgId: string;
  canonicalId: string;
}

/**
 * Mapping from raw to canonical statement.
 */
export interface StatementMapping {
  rawStatementId: string;
  canonicalStatementId: string;
}

/**
 * Conflict detected during weaving.
 */
export interface WeaveConflict {
  /** Type of conflict */
  kind: 'type-mismatch' | 'literal-contradiction' | 'manual-block';
  
  /** Canonical key for the conflicting group */
  canonicalKey: string;
  
  /** Member cgIds involved in the conflict */
  cgIds: string[];
  
  /** Human-readable description */
  description: string;
  
  /** Conflicting values (for type mismatch or literal contradiction) */
  values?: string[];
}

/**
 * Weave statistics for observability.
 */
export interface WeaveStats {
  /** Total raw entities input */
  rawEntityCount: number;
  
  /** Total raw statements input */
  rawStatementCount: number;
  
  /** Total canonical entities created */
  canonicalEntityCount: number;
  
  /** Total canonical statements created */
  canonicalStatementCount: number;
  
  /** Number of entity merge groups */
  mergedEntityGroups: number;
  
  /** Conflicts detected */
  conflictCount: number;
  
  // === Enhanced Debug Stats ===
  
  /** Singletons: entities with no merge (group of 1) */
  singletonCount?: number;
  
  /** Cluster size distribution: { size: count } */
  clusterSizeDistribution?: Record<number, number>;
  
  /** Average members per cluster */
  avgMemberCount?: number;
  
  /** Largest cluster size */
  largestClusterSize?: number;
  
  /** Largest cluster entities (for inspection) */
  largestClusterMembers?: string[];
  
  /** Role distribution in raw entities */
  roleDistribution?: Record<string, number>;
  
  /** Type distribution in raw entities */
  typeDistribution?: Record<string, number>;
  
  /** Merge candidates rejected (for debugging false negatives) */
  rejectedMergeCandidates?: number;
}

// =============================================================================
// Weave Output (Stage Result)
// =============================================================================

/**
 * Complete WX stage output.
 */
export interface WeaveResult {
  /** Canonical entities */
  entities: CanonicalEntity[];
  
  /** Canonical statements */
  statements: CanonicalStatement[];
  
  /** Deduplicated evidence */
  evidence: EvidenceRecord[];
  
  /** Detected conflicts */
  conflicts: WeaveConflict[];
  
  /** Processing statistics */
  stats: WeaveStats;
  
  /** Warnings (non-fatal issues) */
  warnings?: string[];
  
  /** Debug information (if requested) */
  debug?: WeaveDebugInfo;
}

/**
 * Debug information for merge analysis.
 */
export interface WeaveDebugInfo {
  /** Map of canonicalId -> merge explanation */
  mergeExplanations?: Record<string, MergeExplanation>;
  
  /** Potential merge candidates that didn't merge (for false negative analysis) */
  potentialMergePairs?: PotentialMergePair[];
  
  /** Normalization trace (name -> normalized) */
  normalizationTrace?: Record<string, string>;
}

/**
 * Explanation of why entities were merged.
 */
export interface MergeExplanation {
  /** The canonical ID */
  canonicalId: string;
  
  /** The canonical key used for grouping */
  canonicalKey: string;
  
  /** Role scope */
  role: string;
  
  /** Entity type */
  type: string;
  
  /** The normalized name used in the key */
  normalizedName: string;
  
  /** Raw entity IDs that were merged */
  memberCgIds: string[];
  
  /** Original names before normalization */
  originalNames: string[];
  
  /** Artifacts these came from */
  artifactIds: string[];
  
  /** Reason code for the merge */
  reason: 'same_key' | 'alias_match' | 'override';
}

/**
 * A pair of entities that look similar but weren't merged.
 * For finding false negatives.
 */
export interface PotentialMergePair {
  /** Entity A cgId */
  cgIdA: string;
  /** Entity B cgId */
  cgIdB: string;
  /** Entity A name */
  nameA: string;
  /** Entity B name */
  nameB: string;
  /** Entity A normalized name */
  normalizedNameA: string;
  /** Entity B normalized name */
  normalizedNameB: string;
  /** Why they didn't merge */
  blockingReason: 'different_key' | 'different_role' | 'different_type' | 'threshold';
  /** Key A */
  keyA: string;
  /** Key B */
  keyB: string;
  /** Similarity score (0-1) */
  similarityScore?: number;
}

// =============================================================================
// Registry Types (For Aliasing & Deprecation)
// =============================================================================

/**
 * Weave registry for persistent state across runs.
 * Stored in .iw/weave/registry.json
 */
export interface WeaveRegistry {
  /** Schema version */
  version: '0.1';
  
  /** Normalization version in use */
  normalizationVersion: string;
  
  /**
   * Canonical key aliases.
   * Maps old/variant keys to current canonical key.
   * 
   * When an entity is renamed, add an alias from old key → new key.
   * The canonicalId is derived from the resolved key.
   */
  aliases: Record<string, string>;
  
  /**
   * Deprecated canonical entities.
   * Used when an entity is split or permanently removed.
   */
  deprecated: Record<string, {
    reason: 'split' | 'merged' | 'removed';
    replacedBy?: string[];
    deprecatedAt: string;
  }>;
  
  /** Last updated timestamp */
  lastUpdated: string;
}

/**
 * Weave overrides for manual curation.
 * Stored in .iw/weave/overrides.json
 */
export interface WeaveOverrides {
  /** Force specific cgIds to merge to a canonical key */
  forceMerge: Array<{
    memberCgIds: string[];
    canonicalKey: string;
    reason: string;
  }>;
  
  /** Block specific cgIds from merging */
  forceSplit: Array<{
    cgIds: string[];
    reason: string;
  }>;
  
  /** Manual aliases (key → key) */
  aliases: Array<{
    fromKey: string;
    toKey: string;
    reason: string;
  }>;
}

// =============================================================================
// Graph Bundle v2 (Extended with Evidence + Weave)
// =============================================================================

/**
 * Extended Graph Bundle with evidence and weave layers.
 */
export interface GraphBundleV2 {
  $schema: 'intentweave://schemas/graph-bundle/v2';
  schemaVersion: '0.2';
  
  runId: string;
  sessionKey?: string;
  generatedAt: string;
  
  /** Artifact summaries */
  artifacts: ArtifactSummary[];
  
  /** Evidence table (deduplicated) */
  evidence: EvidenceRecord[];
  
  /** Raw layer (as extracted) */
  raw: {
    entities: RawEntity[];
    statements: RawStatement[];
  };
  
  /** Weave layer (canonicalized) - optional if WX hasn't run */
  weave?: WeaveResult;
  
  /** LX links (should reference canonicalIds when weave exists) */
  lx?: {
    links: LxLink[];
  };
}

/**
 * Artifact summary for bundle.
 */
export interface ArtifactSummary {
  id: string;
  path: string;
  role: ArtifactRole;
  versionId?: string;
  entityCount: number;
  statementCount: number;
}

/**
 * LX link (updated to support canonical references).
 */
export interface LxLink {
  id: string;
  
  /** Source: canonical or raw ID */
  sourceId: string;
  sourceIsCanonical: boolean;
  
  /** Target: canonical or raw ID */
  targetId: string;
  targetIsCanonical: boolean;
  
  /** Link predicate */
  predicate: string;
  
  /** Match confidence */
  confidence: number;
  
  /** How the match was made */
  matchMethod: string;
  
  /** Evidence for this link */
  evidenceIds?: string[];
}
