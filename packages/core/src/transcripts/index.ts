// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Transcript Module
 *
 * Core infrastructure for chat/conversation as first-class artifacts.
 * Provides types, storage, hashing, heuristics, and rewrite detection.
 */

// =============================================================================
// Types
// =============================================================================

export type {
  MessageRole,
  Speaker,
  RoleSource,
  SourceLocation,
  MessageRefs,
  TranscriptMessage,
  ImportState,
  ImportStateFile,
  RoleOverride,
  RoleOverrides,
  TranscriptAdapter,
  ImportOptions,
  TranscriptParseResult,
  RewriteCheck,
  UpdateCheck,
  ImportResult,
  HeuristicsResult,
  RoleStats,
} from "./types.js";

export {
  HASH_WINDOW_SIZE,
  LOOKBACK_SIZE,
  HEURISTICS_VERSION,
} from "./types.js";

// =============================================================================
// Storage
// =============================================================================

export {
  getTranscriptDir,
  getTranscriptPath,
  getImportStatePath,
  getRolesPath,
  loadImportState,
  saveImportState,
  loadTranscript,
  appendToTranscript,
  writeTranscript,
  loadRoleOverrides,
  saveRoleOverride,
  deleteRoleOverride,
  getRoleOverridesForSession,
  listTranscriptSessions,
  listTranscriptSources,
  deleteTranscript,
} from "./storage.js";

// =============================================================================
// Hash
// =============================================================================

export {
  computeContentHash,
  normalizeText,
  computePrefixHash,
  computeSuffixHash,
  computeAnchorWindowHash,
  buildSourceKey,
  parseSourceKey,
  generateSessionId,
  byteLength,
  charToByteOffset,
  byteToCharOffset,
  sha256,
  computeTranscriptFingerprint,
  computeRolesHash,
} from "./hash.js";

// =============================================================================
// Heuristics
// =============================================================================

export {
  scoreMessage,
  scoreMessages,
  applyStructuralFallback,
  speakerToMessageRole,
  stripInlineTags,
  extractInlineTag,
} from "./heuristics.js";

// =============================================================================
// Rewrite Detection
// =============================================================================

export {
  detectRewrite,
  checkForUpdates,
  buildImportStateHashes,
  createImportState,
  updateImportState,
} from "./rewrite-detection.js";

// =============================================================================
// SpecStory Parser
// =============================================================================

export {
  parseSpecStoryFile,
  parseSpecStorySlice,
  buildTranscriptMessages,
  filterNewMessages,
  extractSessionIdFromFilename,
  extractSessionUUID,
  SPECSTORY_ADAPTER_NAME,
  SPECSTORY_ADAPTER_VERSION,
  SPECSTORY_PARSER_VERSION,
  type SpecStoryParseResult,
} from "./specstory-parser.js";

// =============================================================================
// SpecStory Adapter
// =============================================================================

export { specstoryAdapter } from "./specstory-adapter.js";
