/**
 * Incremental Pipeline Cache Types
 * 
 * Content-addressed cache with dependency graph and invalidation cascade.
 * Provides Bazel-like incremental behavior without external build tools.
 * 
 * Key concepts:
 * - ArtifactKey: stable identifier for an artifact (not a hash)
 * - Fingerprint: content hash + config hash for cache invalidation
 * - StageMeta: metadata stored with each cached stage output
 * - RunPlan: computed plan of what to (re)compute
 */

// =============================================================================
// Stage Types
// =============================================================================

/** Per-artifact pipeline stages in execution order */
export type PerArtifactStage = 'IN' | 'RX' | 'CX' | 'MX' | 'PX';

/** Global (cross-artifact) stages */
export type GlobalStage = 'AGG' | 'LX';

/** All stages (reexport PerArtifactStage from orchestrator includes AGG) */
export type AllStage = PerArtifactStage | GlobalStage;

/** Ordered per-artifact stages for cascade logic */
export const PIPELINE_STAGES: readonly PerArtifactStage[] = ['IN', 'RX', 'CX', 'MX', 'PX'] as const;

/** Stage index for cascade computation */
export const STAGE_INDEX: Record<PerArtifactStage, number> = {
  IN: 0,
  RX: 1,
  CX: 2,
  MX: 3,
  PX: 4,
};

// =============================================================================
// Artifact Key Types
// =============================================================================

/**
 * Artifact key type discriminator
 * - file: regular file artifact
 * - chat: chat turn artifact
 * - bundle: code bundle (future)
 */
export type ArtifactKeyType = 'file' | 'chat' | 'bundle';

/**
 * ArtifactKey: stable identifier for an artifact (not a hash)
 * 
 * Format examples:
 * - file:spec/intent.md
 * - chat:conv_<id>:turn_<id>
 * - bundle:code:rev_<gitsha>|path_<...>
 */
export interface ArtifactKey {
  /** Key type */
  type: ArtifactKeyType;
  /** Key value (type-specific format) */
  key: string;
}

/**
 * Parse an artifact key string into structured form
 */
export function parseArtifactKey(keyString: string): ArtifactKey {
  const colonIndex = keyString.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid artifact key format: ${keyString}`);
  }
  const type = keyString.slice(0, colonIndex) as ArtifactKeyType;
  const key = keyString.slice(colonIndex + 1);
  return { type, key };
}

/**
 * Serialize an artifact key to string
 */
export function serializeArtifactKey(artifactKey: ArtifactKey): string {
  return `${artifactKey.type}:${artifactKey.key}`;
}

/**
 * Create a file artifact key from a relative path
 */
export function fileArtifactKey(relativePath: string): ArtifactKey {
  // Normalize path separators
  const normalized = relativePath.replace(/\\/g, '/');
  return { type: 'file', key: normalized };
}

/**
 * Create a chat turn artifact key
 */
export function chatArtifactKey(conversationId: string, turnId: string): ArtifactKey {
  return { type: 'chat', key: `${conversationId}:${turnId}` };
}

/**
 * Create a transcript session artifact key
 * Format: chat:specstory:<sessionId>
 */
export function transcriptArtifactKey(source: string, sessionId: string): ArtifactKey {
  return { type: 'chat', key: `${source}:${sessionId}` };
}

// =============================================================================
// Fingerprint Types
// =============================================================================

/**
 * Fingerprint: content hash + configuration hash for cache invalidation
 * 
 * Combined with upstream hashes to create a cache key that prevents
 * "cache hits" across incompatible runs.
 */
export interface Fingerprint {
  /** SHA256 of canonicalized input content */
  contentHash: string;
  /** SHA256 of stage-relevant config (profiles, model, prompts, chunking) */
  configHash: string;
}

/**
 * Full cache key for a stage output
 * Includes all dependencies for hermetic caching
 */
export interface StageCacheKey {
  /** Artifact key string */
  artifactKey: string;
  /** Pipeline stage */
  stage: PerArtifactStage;
  /** Content hash of input */
  contentHash: string;
  /** Config hash for this stage */
  configHash: string;
  /** Hash of upstream stage output (IN has none) */
  upstreamHash?: string;
  /** Hash of context inputs (conversation history, prior snapshot) */
  contextHash?: string;
}

/**
 * Compute a combined cache key hash from all components
 */
export function computeCacheKeyHash(key: StageCacheKey): string {
  const components = [
    key.artifactKey,
    key.stage,
    key.contentHash,
    key.configHash,
    key.upstreamHash ?? 'none',
    key.contextHash ?? 'none',
  ];
  // Hash will be computed using crypto in the cache implementation
  return components.join('|');
}

// =============================================================================
// Stage Metadata Types
// =============================================================================

/**
 * Stage processing statistics
 */
export interface StageStats {
  /** Number of entities in output */
  entities?: number;
  /** Number of statements in output */
  statements?: number;
  /** Input tokens (LLM calls) */
  tokensIn?: number;
  /** Output tokens (LLM calls) */
  tokensOut?: number;
  /** Processing time in milliseconds */
  ms: number;
}

/**
 * Stage metadata stored with each cached output
 * Used for debugging, "why did this rerun?", and reports
 */
export interface StageMeta {
  /** Artifact key string */
  artifactKey: string;
  /** Pipeline stage */
  stage: PerArtifactStage;
  /** When this output was created */
  createdAt: string;
  /** Content hash of input */
  contentHash: string;
  /** Config hash for this stage */
  configHash: string;
  /** Input dependencies (upstream stage → output hash) */
  inputDeps: Partial<Record<PerArtifactStage, string>>;
  /** Context dependencies (optional) */
  contextDeps?: {
    /** Hash of prior snapshot if used */
    priorSnapshotHash?: string;
    /** Hash of conversation history if used */
    conversationHash?: string;
  };
  /** Hash of this stage's output */
  outputHash: string;
  /** Processing statistics */
  stats: StageStats;
}

// =============================================================================
// Global Stage Metadata Types
// =============================================================================

/**
 * Metadata for aggregate (cross-artifact) stage outputs
 */
export interface GlobalStageMeta {
  /** Aggregate key (e.g., "all" or a filter key) */
  aggKey: string;
  /** Global stage */
  stage: GlobalStage;
  /** When this output was created */
  createdAt: string;
  /** Hash of input PX set (list of artifactKey:pxOutputHash pairs) */
  pxSetHash: string;
  /** Config hash for this stage */
  configHash: string;
  /** Hash of this stage's output */
  outputHash: string;
  /** Number of artifacts included */
  artifactCount: number;
  /** Processing statistics */
  stats: StageStats;
}

// =============================================================================
// Invalidation Types
// =============================================================================

/**
 * Reason why a stage is invalidated
 */
export type InvalidationReason =
  | 'content-changed'     // Input content hash changed
  | 'config-changed'      // Stage config hash changed
  | 'upstream-changed'    // Upstream stage output changed (cascade)
  | 'context-changed'     // Context dependencies changed
  | 'cache-miss'          // No cached output found
  | 'forced'              // Explicitly forced by user
  | 'px-set-changed';     // PX outputs changed (for AGG/LX)

/**
 * Invalidation status for a single stage
 */
export interface StageInvalidation {
  /** Stage identifier */
  stage: PerArtifactStage;
  /** Whether this stage needs to be recomputed */
  invalid: boolean;
  /** Reason for invalidation (if invalid) */
  reason?: InvalidationReason;
  /** Details about what changed (for debugging) */
  details?: string;
}

/**
 * Full invalidation status for an artifact
 */
export interface ArtifactInvalidation {
  /** Artifact key */
  artifactKey: ArtifactKey;
  /** Per-stage invalidation status */
  stages: Record<PerArtifactStage, StageInvalidation>;
  /** First stage that needs recomputation (null if all valid) */
  recomputeFrom: PerArtifactStage | null;
  /** All stages that need recomputation (cascade) */
  stagesToRecompute: PerArtifactStage[];
}

// =============================================================================
// Run Plan Types
// =============================================================================

/**
 * Plan for a single artifact
 */
export interface ArtifactPlan {
  /** Artifact key */
  artifactKey: ArtifactKey;
  /** File path (for file artifacts) */
  filePath?: string;
  /** Whether this artifact can fully reuse cached outputs */
  canReuse: boolean;
  /** Stages to recompute (empty if canReuse is true) */
  stagesToRecompute: PerArtifactStage[];
  /** First stage to recompute (null if canReuse is true) */
  recomputeFrom: PerArtifactStage | null;
  /** Reason for recomputation (if any) */
  reason?: InvalidationReason;
  /** Details about what triggered recomputation */
  details?: string;
}

/**
 * Plan for global (cross-artifact) stages
 */
export interface GlobalPlan {
  /** Whether AGG needs recomputation */
  aggInvalid: boolean;
  /** Whether LX needs recomputation */
  lxInvalid: boolean;
  /** Reason for AGG invalidation */
  aggReason?: InvalidationReason;
  /** Reason for LX invalidation */
  lxReason?: InvalidationReason;
}

/**
 * Complete run plan
 * 
 * Generated before execution to show what work will be done.
 * Can be printed with --plan flag before running.
 */
export interface RunPlan {
  /** Plan ID */
  planId: string;
  /** When the plan was created */
  createdAt: string;
  /** Total artifacts */
  totalArtifacts: number;
  /** Artifacts that can fully reuse cached outputs */
  reuseCount: number;
  /** Artifacts that need some recomputation */
  recomputeCount: number;
  /** Per-artifact plans */
  artifacts: ArtifactPlan[];
  /** Global stage plan */
  global: GlobalPlan;
  /** Summary of work to be done */
  summary: {
    /** Stages to run (artifact count by stage) */
    stageWork: Record<PerArtifactStage, number>;
    /** Estimated tokens (if available) */
    estimatedTokens?: number;
  };
}

// =============================================================================
// Configuration Hashing Types
// =============================================================================

/**
 * Stage-specific config for hashing
 * Each stage only includes the config that affects its output
 */
export interface StageConfig {
  /** IN stage config */
  IN: {
    /** Max chunk size */
    maxChunkSize?: number;
    /** Min chunk size */
    minChunkSize?: number;
    /** Whether to split code blocks */
    splitCodeBlocks?: boolean;
  };
  /** RX stage config */
  RX: {
    /** Model name */
    model: string;
    /** Temperature */
    temperature?: number;
    /** Max output tokens */
    maxOutputTokens?: number;
    /** Profile name */
    profile: string;
    /** Profile version */
    profileVersion?: string;
  };
  /** CX stage config */
  CX: {
    /** Reference resolution rules version */
    refVersion?: string;
    /** Dedup strategy */
    dedupStrategy?: string;
  };
  /** MX stage config */
  MX: {
    /** Canonical semantics version */
    semanticsVersion?: string;
    /** Synthesis rules version */
    synthVersion?: string;
  };
  /** PX stage config */
  PX: {
    /** Projection rules version */
    projectionVersion?: string;
    /** Profile filters */
    filters?: Record<string, unknown>;
  };
}

/**
 * Full pipeline config for hashing
 */
export interface PipelineConfig {
  /** Version of the pipeline implementation */
  pipelineVersion: string;
  /** Per-stage configs */
  stages: Partial<StageConfig>;
  /** Global config affecting all stages */
  global?: {
    /** Profile pack fingerprint */
    profilePackHash?: string;
    /** Workspace key */
    workspaceKey?: string;
  };
}

// =============================================================================
// Artifact Registry Types
// =============================================================================

/**
 * Discovered artifact with content hash
 */
export interface DiscoveredArtifact {
  /** Artifact key */
  key: ArtifactKey;
  /** Key string */
  keyString: string;
  /** File path (for file artifacts) */
  filePath?: string;
  /** Raw content */
  content: string;
  /** Content hash */
  contentHash: string;
  /** Artifact format (markdown, yaml, etc.) */
  format?: string;
  /** Artifact role (spec, docs, etc.) */
  role?: string;
  /** Additional metadata (source-specific) */
  metadata?: Record<string, unknown>;
}

/**
 * Artifact discovery options
 */
export interface DiscoveryOptions {
  /** Base path for relative paths */
  basePath: string;
  /** File patterns to include */
  patterns?: string[];
  /** Paths to exclude */
  exclude?: string[];
  /** Include chat turns from logs */
  includeChatTurns?: boolean;
  /** Chat turns file path */
  chatTurnsPath?: string;
  /** Include transcript sessions from .iw/transcripts */
  includeTranscripts?: boolean;
  /** Limit to specific transcript session IDs */
  transcriptSessionIds?: string[];
  /** Maximum number of transcripts to include */
  transcriptLimit?: number;
}
