// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Transcript System Types
 * 
 * Canonical types for chat/conversation artifacts and adapter contracts.
 * All adapters produce TranscriptMessage[] in the same format.
 */

// =============================================================================
// Core Message Types
// =============================================================================

/**
 * Message role - what purpose a message serves in the transcript.
 * Orthogonal to speaker (who said it).
 * 
 * Note: Named MessageRole to avoid conflict with core ArtifactRole.
 */
export type MessageRole = 
  | 'intent'         // User goals, requests, requirements
  | 'spec'           // Design decisions, architecture, plans
  | 'implementation' // Code, configs, file changes
  | 'runlog'         // Execution output, errors, logs
  | 'meta'           // Session control, tool invocations, agent commands
  | 'unknown';       // Unclassified (default)

/**
 * Speaker - who authored the message.
 */
export type Speaker = 'user' | 'assistant' | 'system' | 'tool';

/**
 * How the message role was assigned.
 */
export type RoleSource = 'override' | 'inline' | 'heuristic' | 'llm';

/**
 * Source location in the original file.
 * Uses byte offsets for incremental correctness.
 */
export interface SourceLocation {
  file: string;
  byteStart: number;
  byteEnd: number;
}

/**
 * References extracted from message content.
 */
export interface MessageRefs {
  /** File names mentioned (e.g., "start-project.md") */
  files?: string[];
  /** Absolute paths mentioned */
  paths?: string[];
  /** Source location in original file */
  sourceLoc?: SourceLocation;
}

/**
 * A single message in a transcript.
 * 
 * Identity rules:
 * - sourceKey: stable identity based on seq (NO timestamps)
 * - id: equals sourceKey for storage
 * - contentHash: for change detection and dedup
 */
export interface TranscriptMessage {
  // === Identity (stable, seq-based) ===
  /** Stable source identifier: <source>:<sessionId>:m:<seq> */
  sourceKey: string;
  /** Storage identity (equals sourceKey) */
  id: string;
  /** Content fingerprint for change detection (sha256:... full 64 hex) */
  contentHash: string;
  
  // === Source Metadata ===
  /** Adapter that produced this message */
  source: string;
  /** Original session/conversation identifier */
  sourceSessionId: string;
  /** Monotonic sequence number within session (primary identity) */
  seq: number;
  /** Original timestamp (optional metadata, NOT identity) */
  ts?: string;
  
  // === Classification ===
  /** Who spoke */
  speaker: Speaker;
  /** What role this message plays in the transcript */
  messageRole: MessageRole;
  /** How the role was assigned */
  roleSource: RoleSource;
  
  // === Content ===
  /** Original message content (preserved for debugging) */
  rawText: string;
  /** Cleaned/normalized message content */
  text: string;
  
  // === Metadata ===
  /** Parser version that produced this message */
  parserVersion: string;
  /** Optional references extracted from content */
  refs?: MessageRefs;
}

// =============================================================================
// Import State Types
// =============================================================================

/**
 * Import state for append-only file adapters (e.g., SpecStory).
 * Tracks cursor position and hashes for incremental import.
 */
export interface ImportState {
  /** Absolute path to source file */
  sourcePath: string;
  /** Extracted session ID */
  sessionId: string;
  
  // === File State Tracking ===
  /** Last known file size in bytes */
  lastSize: number;
  /** Last modification time (ms since epoch) */
  lastMtimeMs: number;
  
  // === Rewrite Detection (prefix + suffix + anchor window) ===
  /** SHA256 of first 64KB */
  prefixHash64k: string;
  /** SHA256 of last 64KB */
  suffixHash64k: string;
  /** SHA256 of 64KB window around lastBoundaryOffset (detects middle edits) */
  anchorWindowHash: string;
  
  // === Incremental Cursor (byte-based) ===
  /** Last processed file size */
  lastOffset: number;
  /** Last known safe header boundary (absolute byte offset) */
  lastBoundaryOffset: number;
  /** Absolute byte offset of last processed message header */
  lastProcessedHeaderOffset: number;
  /** Monotonic sequence number for transcript */
  lastProcessedSeq: number;
  
  // === Metadata ===
  /** Number of messages in transcript */
  messageCount: number;
  /** Adapter version that produced this state */
  adapterVersion: string;
  /** When this state was last updated */
  updatedAt: string;
}

/**
 * Import state file structure.
 * Maps source file paths to their import state.
 */
export interface ImportStateFile {
  [sourcePath: string]: ImportState;
}

// =============================================================================
// Role Override Types
// =============================================================================

/**
 * A single role override entry.
 */
export interface RoleOverride {
  /** The assigned role */
  role: MessageRole;
  /** When the override was set (ISO timestamp) */
  setAt: string;
  /** Who set the override */
  setBy: 'user' | 'auto';
  /** Optional explanation */
  reason?: string;
  /** Content hash for reimport recovery */
  contentHash?: string;
}

/**
 * Role overrides file structure.
 * Maps sourceKey to role override.
 */
export interface RoleOverrides {
  [sourceKey: string]: RoleOverride;
}

// =============================================================================
// Adapter Contract Types
// =============================================================================

/**
 * Result of checking for updates.
 */
export interface UpdateCheck {
  /** Whether there's new content */
  hasUpdates: boolean;
  /** Whether file was rewritten (requires full reimport) */
  wasRewritten: boolean;
  /** Reason for rewrite detection (if applicable) */
  rewriteReason?: string;
  /** Estimated new bytes (for progress reporting) */
  newBytes: number;
}

/**
 * Options for import operations.
 */
export interface ImportOptions {
  /** Force full reimport (ignore cursor) */
  full?: boolean;
  /** Plan only, don't write */
  planOnly?: boolean;
  /** Session ID override */
  sessionId?: string;
  /** Verbose output */
  verbose?: boolean;
}

/**
 * Result of an import operation.
 */
export interface ImportResult {
  /** Session ID */
  sessionId: string;
  /** Path to written .jsonl file */
  transcriptPath: string;
  /** Total number of messages in transcript */
  messagesImported: number;
  /** Number of newly imported messages (incremental) */
  newMessages: number;
  /** Updated import state */
  state: ImportState;
  /** Role distribution stats */
  roleStats?: RoleStats;
}

/**
 * Role distribution statistics.
 */
export interface RoleStats {
  intent: number;
  spec: number;
  implementation: number;
  runlog: number;
  meta: number;
  unknown: number;
  total: number;
}

/**
 * Adapter contract for transcript importers.
 * 
 * Two adapter types:
 * - AppendOnlyFileAdapter: incremental import with byte cursors (SpecStory)
 * - SnapshotExportAdapter: re-parses full snapshot, dedupes by ID (ChatGPT)
 */
export interface TranscriptAdapter {
  /** Adapter identifier (e.g., 'specstory', 'chatgpt-export') */
  readonly name: string;
  
  /** Adapter version (bump when parser changes) */
  readonly version: string;
  
  /** File patterns this adapter handles */
  readonly patterns: string[];
  
  /**
   * Check if source has updates.
   * MUST be O(1) - stat + hashes only, NO parsing.
   */
  checkForUpdates(
    sourcePath: string,
    state: ImportState | null
  ): Promise<UpdateCheck>;
  
  /**
   * Import/update transcript from source.
   * Only called if checkForUpdates indicates changes.
   */
  import(
    sourcePath: string,
    options: ImportOptions
  ): Promise<ImportResult>;
  
  /**
   * Parse a single message (for testing/debugging).
   */
  parseMessage?(content: string): TranscriptMessage | null;
}

// =============================================================================
// Pipeline Integration Types
// =============================================================================

/**
 * Fingerprint inputs for transcript caching.
 * Must include version inputs for cache correctness.
 */
export interface TranscriptFingerprintInput {
  sessionId: string;
  count: number;
  lastSeq: number;
  /** Last 10 message contentHashes */
  lastContentHashes: string[];
  /** SHA256 of relevant roles.json entries */
  rolesHash: string;
  /** Bump when heuristic rules change */
  heuristicsVersion: string;
  /** Bump when parser changes */
  adapterVersion: string;
}

/**
 * Rewrite check result.
 */
export interface RewriteCheck {
  mode: 'unchanged' | 'append' | 'rewrite';
  reason?: string;
  /** Previous file size */
  previousSize?: number;
  /** Current file size */
  currentSize?: number;
  /** Current prefix hash */
  prefixHash?: string;
  /** Current suffix hash */
  suffixHash?: string;
  /** Current anchor window hash */
  anchorWindowHash?: string | null;
}

/**
 * Heuristics scoring result.
 */
export interface HeuristicsResult {
  /** Numeric score (positive = user, negative = assistant) */
  score: number;
  /** Predicted speaker based on score */
  speaker: Speaker;
  /** Confidence level (0-1) */
  confidence: number;
  /** Signals that contributed to the score */
  signals: string[];
  /** Heuristics version used */
  version: string;
}

/**
 * Transcript parse result from adapters (for internal use).
 * Named TranscriptParseResult to avoid conflict with core ParseResult.
 */
export interface TranscriptParseResult {
  /** Parsed messages */
  messages: TranscriptMessage[];
  /** New byte offset after parsing */
  newOffset: number;
  /** Number of new messages */
  newCount: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Size of hash windows (64KB) */
export const HASH_WINDOW_SIZE = 64 * 1024;

/** Size of lookback window for incremental parsing (32KB) */
export const LOOKBACK_SIZE = 32 * 1024;

/** Current heuristics version (bump when rules change) */
export const HEURISTICS_VERSION = 'v1';

/** All artifact roles */
export const MESSAGE_ROLES: readonly MessageRole[] = [
  'intent',
  'spec', 
  'implementation',
  'runlog',
  'meta',
  'unknown',
] as const;

/** All speakers */
export const SPEAKERS: readonly Speaker[] = [
  'user',
  'assistant',
  'system',
  'tool',
] as const;
