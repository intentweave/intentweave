// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider Interfaces - Abstract interfaces for pluggable implementations
 *
 * Two-Layer Provider Design (v0.6):
 * 1. LLMProvider = Low-level model transport (prompt → completion/JSON)
 * 2. ExtractionProvider = RX-stage service (uses LLMProvider, owns extraction logic)
 *
 * Other providers:
 * - Database providers (Neo4j, SQLite, in-memory)
 * - Parser providers (TreeSitter, TypeScript, custom)
 */

import type {
  Entity,
  Statement,
  StagingSnapshot,
  Evidence,
} from "./types/index.js";

// =============================================================================
// LLM Provider Layer (Low-Level Model Transport)
// =============================================================================

/**
 * LLM Provider Interface (Low-Level)
 *
 * Thin abstraction over LLM APIs. Handles prompt→completion transport.
 * Does NOT own extraction logic - that's ExtractionProvider's job.
 */
export interface LLMProvider {
  /** Absent means the legacy v1 transport contract. */
  readonly contractVersion?: 1 | 2;

  /** Provider name for logging/debugging */
  readonly name: string;

  /** Check if provider is available (API key set, model accessible) */
  isAvailable(): Promise<boolean>;

  /** Complete a prompt with optional JSON schema enforcement */
  complete(request: LLMRequest): Promise<LLMResponse>;

  /** Generate embeddings (optional capability) */
  embed?(text: string): Promise<number[]>;

  /** Get configured model name (optional — for cache provider tracking) */
  getModelName?(): string;

  /** Provider capabilities at the transport level */
  readonly capabilities: LLMProviderCapabilities;

  /** Resolve capabilities for a per-request model (required by v2). */
  capabilitiesFor?(model?: string): LLMProviderCapabilities;
}

/** Claims-grade transport contract that preserves terminal provider outcomes. */
export interface LLMProviderV2 extends LLMProvider {
  readonly contractVersion: 2;
  capabilitiesFor(model?: string): LLMProviderCapabilities;
}

export function isLLMProviderV2(
  provider: LLMProvider,
): provider is LLMProviderV2 {
  return (
    provider.contractVersion === 2 &&
    typeof provider.capabilitiesFor === "function"
  );
}

/**
 * LLM Request
 */
export interface LLMRequest {
  /** System prompt */
  system?: string;

  /** User messages / prompts */
  messages: LLMMessage[];

  /** JSON schema for structured output (if supported) */
  responseSchema?: Record<string, unknown>;

  /** Stable schema name used by providers with native structured output. */
  responseSchemaName?: string;

  /** Temperature (0-1) */
  temperature?: number;

  /** Max tokens in response */
  maxTokens?: number;

  /** Model override (optional) */
  model?: string;

  /** Per-request timeout in milliseconds (overrides provider default) */
  timeoutMs?: number;

  /** Caller-controlled cancellation, distinct from timeout. */
  signal?: AbortSignal;
}

/**
 * LLM Message
 */
export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * LLM Response
 */
export interface LLMResponse {
  /** Raw text content */
  content: string;

  /** Parsed JSON if responseSchema was provided */
  parsed?: unknown;

  /** Token usage */
  tokensUsed: {
    prompt: number;
    completion: number;
    reasoning?: number;
    cachedPrompt?: number;
  };

  /** Latency in milliseconds */
  latencyMs: number;

  /** Model used */
  model: string;

  /** Provider request ID, when exposed by the transport. */
  requestId?: string;

  /** Provider model revision or system fingerprint. */
  modelRevision?: string;

  /** Finish reason */
  finishReason: LLMFinishReason;

  /** Provider refusal detail, when present. */
  refusal?: string;

  /** Error message if finishReason is 'error' */
  error?: string;

  /** Typed v2 transport failure classification. */
  errorKind?: LLMTransportErrorKind;

  /** HTTP status from the provider, when applicable. */
  statusCode?: number;
}

export type LLMFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "refusal"
  | "content_filter"
  | "error"
  | "other";

export type LLMTransportErrorKind =
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "transport"
  | "provider";

export type LLMStructuredOutputMode = "strict" | "json" | "text";

/**
 * LLM Provider Capabilities
 */
export interface LLMProviderCapabilities {
  /** Maximum input tokens for this model */
  maxInputTokens: number;

  /** Supports JSON schema response format */
  supportsJsonSchema: boolean;

  /** Supports streaming responses */
  supportsStreaming: boolean;

  /** Supports tool/function calling */
  supportsToolCalls: boolean;

  /** Supports embeddings */
  supportsEmbeddings: boolean;

  /** Ordered structured-output modes supported for this effective model. */
  structuredOutputModes?: readonly LLMStructuredOutputMode[];
}

// =============================================================================
// Extraction Provider Layer (RX Stage Service)
// =============================================================================

/**
 * Chunk for extraction
 */
export interface Chunk {
  /** Chunk identifier */
  id: string;

  /** Text content */
  content: string;

  /** Chunk index within document/turn */
  index?: number;

  /** Turn index for chat-based documents */
  turnIndex?: number;

  /** Source file path */
  filePath?: string;

  /** Start line in source (1-based) */
  startLine?: number;

  /** End line in source (1-based) */
  endLine?: number;

  /** Chunk metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Entity schema for extraction
 */
export interface EntitySchema {
  /** Allowed entity kinds */
  kinds: string[];

  /** Allowed predicates */
  predicates: string[];

  /** Additional schema hints */
  hints?: string[];
}

/**
 * Profile for extraction
 */
export interface ExtractionProfile {
  /** Profile name */
  name: string;

  /** Entity kind mappings */
  kindMappings?: Record<string, string[]>;

  /** Artifact role hints */
  artifactRole?: string;

  /** Minimum confidence threshold */
  confidence?: number;
}

/**
 * Extraction Provider Interface (RX Stage)
 *
 * Uses an injected LLMProvider for LLM calls, but owns:
 * - Chunking strategy
 * - Schema orchestration
 * - Evidence tracking
 * - Result aggregation
 */
export interface ExtractionProvider {
  /** Provider name for logging */
  readonly name: string;

  /**
   * Extract entities and relationships from chunks.
   * This is the main RX-stage entry point.
   */
  extract(
    chunks: Chunk[],
    schema: EntitySchema,
    profile: ExtractionProfile,
  ): Promise<ExtractionResult>;

  /** Provider capabilities at the extraction level */
  readonly capabilities: ExtractionProviderCapabilities;
}

/**
 * Extraction Provider Capabilities
 */
export interface ExtractionProviderCapabilities {
  /** Supports confidence scores on entities/statements */
  supportsConfidence: boolean;

  /** Supports evidence span tracking */
  supportsEvidenceSpans: boolean;

  /** Supports parallel chunk processing */
  supportsParallelChunks: boolean;

  /** Underlying LLM provider capabilities (derived) */
  llmCapabilities?: LLMProviderCapabilities;
}

/**
 * Extraction Result
 */
export interface ExtractionResult {
  /** Extracted entities */
  entities: Entity[];

  /** Extracted statements */
  statements: Statement[];

  /** Evidence linking entities to source */
  evidence: Evidence[];

  /** Extraction metadata */
  meta: ExtractionMeta;
}

/**
 * Extraction Metadata
 */
export interface ExtractionMeta {
  /** Extraction provider name */
  provider: string;

  /** LLM provider name (if LLM-backed) */
  llmProvider?: string;

  /** Model used */
  model?: string;

  /** Total latency in milliseconds */
  latencyMs: number;

  /** Total tokens used (if LLM-backed) */
  tokensUsed?: number;

  /** Estimated cost in USD (if tracking enabled) */
  costUsd?: number;

  /** Whether results came from cache */
  cacheHit?: boolean;

  /** Number of chunks processed */
  chunksProcessed: number;
}

// =============================================================================
// Legacy Extraction Types (for backward compatibility)
// =============================================================================

/**
 * Context for extraction operations
 * @deprecated Use ExtractionProfile instead
 */
export interface ExtractContext {
  /** File path being processed */
  filePath?: string;

  /** File type/language */
  fileType?: string;

  /** Existing entities for reference */
  existingEntities?: Entity[];

  /** Additional context hints */
  hints?: string[];
}

/**
 * Result from entity extraction
 * @deprecated Use ExtractionResult instead
 */
export interface ExtractResult {
  entities: Entity[];
  confidence: number;
  tokensUsed?: number;
  error?: string;
}

/**
 * Result from statement extraction
 * @deprecated Use ExtractionResult instead
 */
export interface ExtractStatementsResult {
  statements: Statement[];
  confidence: number;
  tokensUsed?: number;
  error?: string;
}

/**
 * Result from entity classification
 */
export interface ClassifyResult {
  suggestedType: string;
  confidence: number;
  alternatives?: Array<{ type: string; confidence: number }>;
}

/**
 * Database Provider Interface
 *
 * Abstracts graph database operations
 */
export interface DatabaseProvider {
  /** Provider name */
  readonly name: string;

  /** Connect to database */
  connect(uri: string): Promise<void>;

  /** Disconnect from database */
  disconnect(): Promise<void>;

  /** Check connection status */
  isConnected(): boolean;

  /** Store entities */
  storeEntities(entities: Entity[], runId?: string): Promise<StoreResult>;

  /** Store statements */
  storeStatements(
    statements: Statement[],
    runId?: string,
  ): Promise<StoreResult>;

  /** Query entities */
  queryEntities(filter: EntityFilter): Promise<Entity[]>;

  /** Query statements */
  queryStatements(filter: StatementFilter): Promise<Statement[]>;

  /** Execute raw query (provider-specific) */
  executeQuery<T>(query: string, params?: Record<string, unknown>): Promise<T>;

  /** Clear all data (for testing) */
  clear?(): Promise<void>;
}

/**
 * Result from store operations
 */
export interface StoreResult {
  created: number;
  updated: number;
  errors: Array<{ item: unknown; error: string }>;
}

/**
 * Filter for entity queries
 */
export interface EntityFilter {
  cgId?: string;
  type?: string | string[];
  name?: string;
  nameContains?: string;
  origin?: string;
  reviewStatus?: string;
  sourceFile?: string;
  limit?: number;
  offset?: number;
}

/**
 * Filter for statement queries
 */
export interface StatementFilter {
  subjectCgId?: string;
  predicate?: string | string[];
  objectCgId?: string;
  origin?: string;
  reviewStatus?: string;
  limit?: number;
  offset?: number;
}

/**
 * Parser Provider Interface
 *
 * Abstracts source code parsing
 */
export interface ParserProvider {
  /** Provider name */
  readonly name: string;

  /** Supported file extensions */
  readonly supportedExtensions: string[];

  /** Check if file type is supported */
  supports(filePath: string): boolean;

  /** Parse a file and extract entities/statements */
  parseFile(filePath: string, content: string): Promise<ParseResult>;

  /** Parse multiple files */
  parseFiles?(
    files: Array<{ path: string; content: string }>,
  ): Promise<ParseResult[]>;
}

/**
 * Result from parsing
 */
export interface ParseResult {
  filePath: string;
  entities: Entity[];
  statements: Statement[];
  errors: ParseError[];
}

/**
 * Parsing error
 */
export interface ParseError {
  message: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
}

// ============================================================================
// LX Stage Types (Cross-Artifact Linking)
// ============================================================================

/**
 * Link predicate types for cross-artifact relationships
 */
export type LinkPredicate =
  | "REFINES" // Spec refines higher-level intent
  | "DERIVED_FROM" // Implementation derived from spec
  | "IMPLEMENTS" // Code implements specification
  | "DESCRIBES" // Documentation describes entity
  | "MAPS_TO"; // Entity maps to another entity

/**
 * Method used to match entities for linking
 */
export type LinkMatchMethod =
  | "name" // Direct name match
  | "alias" // Alias match via canonical index
  | "structural" // Structural similarity
  | "profile" // Profile-based matching
  | "semantic"; // Semantic similarity (embeddings)

/**
 * Evidence for a link proposal
 */
export interface LinkEvidence {
  /** Text snippet supporting the link */
  text: string;
  /** Source artifact ID */
  artifactId: string;
  /** Source entity cgId */
  sourceCgId?: string;
  /** Target entity cgId */
  targetCgId?: string;
}

/**
 * Cross-artifact link proposal from LX stage
 */
export interface LinkProposal {
  /** Unique proposal ID */
  id: string;
  /** Source artifact ID */
  sourceArtifact: string;
  /** Source entity cgId */
  sourceCgId: string;
  /** Target artifact ID */
  targetArtifact: string;
  /** Target entity cgId */
  targetCgId: string;
  /** Link relationship type */
  predicate: LinkPredicate;
  /** Confidence score (0-1) */
  confidence: number;
  /** Method used for matching */
  matchMethod: LinkMatchMethod;
  /** Supporting evidence */
  evidence: LinkEvidence[];
  /** Whether proposal has been accepted */
  accepted?: boolean;
  /** Rejection reason if rejected */
  rejectionReason?: string;
}

/**
 * LX stage output (aggregate level)
 */
export interface LxStageOutput {
  /** Schema version */
  schemaVersion: "0.1";
  /** Stage identifier */
  stage: "LX";
  /** Run ID */
  runId: string;
  /** Workspace key */
  workspaceKey: string;
  /** Generated timestamp */
  generatedAt: string;
  /** Link proposals */
  proposals: LinkProposal[];
  /** Processing metadata */
  meta: {
    /** Total entities analyzed */
    entitiesAnalyzed: number;
    /** Total entities in workspace (before limits) */
    entitiesTotal?: number;
    /** Whether entity limit was applied */
    entitiesLimited?: boolean;
    /** Proposals generated */
    proposalsGenerated: number;
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

/**
 * Staging Provider Interface
 *
 * Abstracts staging area operations (file-based or in-memory)
 */
export interface StagingProvider {
  /** Provider name */
  readonly name: string;

  /** Initialize staging area */
  initialize(workspaceDir: string): Promise<void>;

  /** Stage entities for later commit */
  stageEntities(entities: Entity[], runId: string): Promise<void>;

  /** Stage statements for later commit */
  stageStatements(statements: Statement[], runId: string): Promise<void>;

  /** Get current staging snapshot */
  getSnapshot(): Promise<StagingSnapshot>;

  /** Clear staging area */
  clear(): Promise<void>;

  /** Commit staged data to database */
  commit(database: DatabaseProvider): Promise<StoreResult>;
}

/**
 * Evidence Provider Interface
 *
 * Abstracts evidence collection and validation
 */
export interface EvidenceProvider {
  /** Collect evidence for an entity from source files */
  collectEvidence(entity: Entity, filePath: string): Promise<Evidence[]>;

  /** Validate that evidence still matches source */
  validateEvidence(evidence: Evidence): Promise<boolean>;

  /** Update evidence after source changes */
  refreshEvidence(evidence: Evidence): Promise<Evidence | null>;
}

// =============================================================================
// Ledger Writer Interface (Graph Persistence Boundary)
// =============================================================================

/**
 * Pipeline stage type for ledger writes
 */
export type LedgerStage = "IN" | "RX" | "CX" | "PX" | "MX" | "LX" | "CURATED";

/**
 * Ledger write context - metadata for each write operation
 */
export interface LedgerWriteContext {
  /** Turn/request ID (for provenance) */
  turnId: string;

  /** Session ID (for multi-project isolation) */
  sessionId: string;

  /** Workspace ID (for multi-tenant support) */
  workspaceId: string;

  /** Pipeline stage producing this snapshot */
  stage: LedgerStage;

  /** Profile IDs active during extraction */
  profileIds: string[];

  /** Optional lineage parent ID (for CX/PX/MX stages) */
  lineageParentId?: string;
}

/**
 * Result of a ledger write operation
 */
export interface LedgerWriteResult {
  /** Number of edge assertions written */
  edgesWritten: number;

  /** Number of edge assertions touched (copy-on-write: unchanged) */
  edgesTouched: number;

  /** Number of node assertions written */
  nodesWritten: number;

  /** Number of node assertions touched */
  nodesTouched: number;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Ledger Writer Interface
 *
 * Defines the contract for persisting StagingSnapshots to an append-only ledger.
 * This is the boundary between the core pipeline (@intentweave/analyzer) and
 * the server's persistence layer (Neo4j, SQLite, etc.).
 *
 * Design principles:
 * 1. Append-only: Never mutate existing assertions, create new versions
 * 2. Copy-on-write: If data hasn't changed, just "touch" (update last_seen_turn)
 * 3. Lineage tracking: Link assertions across stages via lineage_id
 * 4. Evidence linking: Connect assertions to source chunks
 *
 * Implementations:
 * - Neo4jLedgerWriter (server): Writes to Neo4j graph database
 * - NoopLedgerWriter (CLI): Does nothing (pure file-based output)
 * - MockLedgerWriter (tests): In-memory for assertions
 */
export interface LedgerWriter {
  /** Provider name for logging/debugging */
  readonly name: string;

  /**
   * Write a staging snapshot to the ledger
   *
   * Converts entities and statements to ledger assertions:
   * - Entity → NodeAssertion
   * - Statement → EdgeAssertion
   *
   * Uses copy-on-write: if an assertion already exists with the same
   * content (same lineage_id), only update `last_seen_turn`.
   *
   * @param snapshot - The staging snapshot to persist
   * @param context - Write context (turnId, session, stage, etc.)
   * @returns Write result with counts and timing
   */
  writeSnapshot(
    snapshot: StagingSnapshot,
    context: LedgerWriteContext,
  ): Promise<LedgerWriteResult>;

  /**
   * Touch existing assertions (update last_seen_turn without changes)
   *
   * Used when a stage produces the same output as before.
   * Marks assertions as "still valid" without creating new versions.
   *
   * @param lineageIds - Lineage IDs of assertions to touch
   * @param turnId - Current turn ID
   */
  touchAssertions(lineageIds: string[], turnId: string): Promise<void>;

  /**
   * Mark assertions as neutralized (soft delete)
   *
   * Creates a new assertion version with state='neutralized'.
   * The original assertion remains for audit trail.
   *
   * @param lineageIds - Lineage IDs of assertions to neutralize
   * @param reason - Reason for neutralization
   * @param turnId - Current turn ID
   */
  neutralizeAssertions(
    lineageIds: string[],
    reason: string,
    turnId: string,
  ): Promise<void>;

  /**
   * Check if ledger is available/connected
   */
  isAvailable(): Promise<boolean>;
}

/**
 * No-op Ledger Writer (for CLI and pure file-based workflows)
 *
 * Does nothing - used when ledger writes are disabled or not needed.
 */
export class NoopLedgerWriter implements LedgerWriter {
  readonly name = "noop";

  async writeSnapshot(): Promise<LedgerWriteResult> {
    return {
      edgesWritten: 0,
      edgesTouched: 0,
      nodesWritten: 0,
      nodesTouched: 0,
      durationMs: 0,
    };
  }

  async touchAssertions(): Promise<void> {
    // No-op
  }

  async neutralizeAssertions(): Promise<void> {
    // No-op
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
