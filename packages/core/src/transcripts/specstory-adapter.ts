// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * SpecStory Adapter
 * 
 * Implements TranscriptAdapter for SpecStory markdown files.
 * Supports incremental import with byte-offset tracking.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  TranscriptAdapter,
  TranscriptMessage,
  ImportState,
  ImportOptions,
  ImportResult,
  UpdateCheck,
  RoleStats,
  MessageRole,
} from './types.js';
import {
  getTranscriptPath,
  loadImportState,
  saveImportState,
  loadTranscript,
  appendToTranscript,
  writeTranscript,
  loadRoleOverrides,
} from './storage.js';
import {
  computePrefixHash,
  computeSuffixHash,
  computeAnchorWindowHash,
  buildSourceKey,
} from './hash.js';
import {
  detectRewrite,
  createImportState,
  updateImportState,
} from './rewrite-detection.js';
import {
  parseSpecStoryFile,
  parseSpecStorySlice,
  buildTranscriptMessages,
  filterNewMessages,
  extractSessionIdFromFilename,
  extractSessionUUID,
  SPECSTORY_ADAPTER_NAME,
  SPECSTORY_ADAPTER_VERSION,
  SPECSTORY_PARSER_VERSION,
} from './specstory-parser.js';
import { LOOKBACK_SIZE } from './types.js';

// =============================================================================
// SpecStory Adapter Implementation
// =============================================================================

/**
 * SpecStory adapter for importing markdown conversation logs.
 */
export const specstoryAdapter: TranscriptAdapter = {
  name: SPECSTORY_ADAPTER_NAME,
  version: SPECSTORY_ADAPTER_VERSION,
  patterns: [
    '.specstory/history/*.md',
  ],
  
  async checkForUpdates(
    sourcePath: string,
    state: ImportState | null
  ): Promise<UpdateCheck> {
    const stats = await fs.stat(sourcePath);
    const currentSize = stats.size;
    
    // First import
    if (state === null) {
      return {
        hasUpdates: true,
        wasRewritten: false,
        newBytes: currentSize,
      };
    }
    
    // Quick check: same size and mtime means no changes
    if (currentSize === state.lastSize && stats.mtimeMs === state.lastMtimeMs) {
      return {
        hasUpdates: false,
        wasRewritten: false,
        newBytes: 0,
      };
    }
    
    // Read file and check for rewrite
    const buffer = await fs.readFile(sourcePath);
    const rewriteCheck = await detectRewrite(sourcePath, state);
    
    if (rewriteCheck.mode === 'rewrite') {
      return {
        hasUpdates: true,
        wasRewritten: true,
        rewriteReason: rewriteCheck.reason,
        newBytes: currentSize,
      };
    }
    
    if (rewriteCheck.mode === 'unchanged') {
      return {
        hasUpdates: false,
        wasRewritten: false,
        newBytes: 0,
      };
    }
    
    // Append mode
    return {
      hasUpdates: true,
      wasRewritten: false,
      newBytes: currentSize - state.lastOffset,
    };
  },
  
  async import(
    sourcePath: string,
    options: ImportOptions = {}
  ): Promise<ImportResult> {
    const absPath = path.resolve(sourcePath);
    const workspaceRoot = findWorkspaceRoot(absPath);
    
    // Load existing state
    const stateFile = await loadImportState(workspaceRoot);
    const existingState = stateFile[absPath] ?? null;
    
    // Determine import mode
    if (options.full || !existingState) {
      return fullImport(absPath, workspaceRoot, existingState, options);
    }
    
    const check = await this.checkForUpdates(absPath, existingState);
    
    if (!check.hasUpdates) {
      // No changes
      return {
        sessionId: existingState.sessionId,
        transcriptPath: getTranscriptPath(workspaceRoot, SPECSTORY_ADAPTER_NAME, existingState.sessionId),
        messagesImported: existingState.messageCount,
        newMessages: 0,
        state: existingState,
      };
    }
    
    if (check.wasRewritten) {
      console.log(`File rewritten (${check.rewriteReason}), full reimport`);
      return fullImport(absPath, workspaceRoot, existingState, options);
    }
    
    // Incremental import
    return incrementalImport(absPath, workspaceRoot, existingState, options);
  },
  
  parseMessage(content: string): TranscriptMessage | null {
    const buffer = Buffer.from(content, 'utf-8');
    const result = parseSpecStoryFile(buffer, 'test-session');
    
    if (result.rawMessages.length === 0) {
      return null;
    }
    
    const messages = buildTranscriptMessages(result.rawMessages, result.sessionId, 1);
    return messages[0] ?? null;
  },
};

// =============================================================================
// Import Functions
// =============================================================================

/**
 * Perform full import of a SpecStory file.
 */
async function fullImport(
  sourcePath: string,
  workspaceRoot: string,
  existingState: ImportState | null,
  options: ImportOptions
): Promise<ImportResult> {
  // Read file
  const buffer = await fs.readFile(sourcePath);
  const stats = await fs.stat(sourcePath);
  
  // Parse entire file
  const parseResult = parseSpecStoryFile(buffer);
  
  // Determine session ID
  const sessionId = options.sessionId 
    ?? parseResult.sessionId 
    ?? extractSessionIdFromFilename(path.basename(sourcePath));
  
  // Build transcript messages
  const messages = buildTranscriptMessages(
    parseResult.rawMessages,
    sessionId,
    1,
    SPECSTORY_ADAPTER_NAME
  );
  
  // Set source file in refs
  for (const msg of messages) {
    if (msg.refs?.sourceLoc) {
      msg.refs.sourceLoc.file = sourcePath;
    }
  }
  
  // Apply role overrides from existing transcript (if reimporting)
  if (existingState) {
    await applyRoleOverrides(workspaceRoot, messages);
  }
  
  // Write transcript
  const transcriptPath = getTranscriptPath(workspaceRoot, SPECSTORY_ADAPTER_NAME, sessionId);
  
  if (!options.planOnly) {
    await writeTranscript(transcriptPath, messages);
  }
  
  // Build and save state
  const lastMsg = messages[messages.length - 1];
  const lastHeaderOffset = lastMsg?.refs?.sourceLoc?.byteStart ?? 0;
  
  const newState = createImportState(
    sourcePath,
    sessionId,
    buffer,
    messages.length,
    `${SPECSTORY_ADAPTER_NAME}@${SPECSTORY_ADAPTER_VERSION}`,
    lastHeaderOffset
  );
  
  if (!options.planOnly) {
    await saveImportState(workspaceRoot, sourcePath, newState);
  }
  
  // Compute role stats
  const roleStats = computeRoleStats(messages);
  
  return {
    sessionId,
    transcriptPath,
    messagesImported: messages.length,
    newMessages: messages.length,
    state: newState,
    roleStats,
  };
}

/**
 * Perform incremental import of a SpecStory file.
 */
async function incrementalImport(
  sourcePath: string,
  workspaceRoot: string,
  state: ImportState,
  options: ImportOptions
): Promise<ImportResult> {
  // Read file
  const buffer = await fs.readFile(sourcePath);
  const stats = await fs.stat(sourcePath);
  const currentSize = buffer.length;
  
  // Calculate read window with lookback
  const startOffset = Math.max(0, state.lastBoundaryOffset - LOOKBACK_SIZE);
  const sliceBuffer = buffer.subarray(startOffset);
  
  // Parse slice
  const parseResult = parseSpecStorySlice(sliceBuffer, startOffset, state.sessionId);
  
  // Filter to only NEW messages (by absolute header offset)
  const newRawMessages = filterNewMessages(
    parseResult.rawMessages,
    state.lastProcessedHeaderOffset
  );
  
  if (newRawMessages.length === 0) {
    // No new messages, just update state timestamps
    const updatedState: ImportState = {
      ...state,
      lastSize: currentSize,
      lastMtimeMs: stats.mtimeMs,
      lastOffset: currentSize,
      updatedAt: new Date().toISOString(),
    };
    
    if (!options.planOnly) {
      await saveImportState(workspaceRoot, sourcePath, updatedState);
    }
    
    return {
      sessionId: state.sessionId,
      transcriptPath: getTranscriptPath(workspaceRoot, SPECSTORY_ADAPTER_NAME, state.sessionId),
      messagesImported: state.messageCount,
      newMessages: 0,
      state: updatedState,
    };
  }
  
  // Build transcript messages with correct seq numbers
  const startSeq = state.lastProcessedSeq + 1;
  const newMessages = buildTranscriptMessages(
    newRawMessages,
    state.sessionId,
    startSeq,
    SPECSTORY_ADAPTER_NAME
  );
  
  // Set source file in refs
  for (const msg of newMessages) {
    if (msg.refs?.sourceLoc) {
      msg.refs.sourceLoc.file = sourcePath;
    }
  }
  
  // Append to transcript
  const transcriptPath = getTranscriptPath(workspaceRoot, SPECSTORY_ADAPTER_NAME, state.sessionId);
  
  if (!options.planOnly) {
    await appendToTranscript(transcriptPath, newMessages);
  }
  
  // Update state
  const lastNewMsg = newMessages[newMessages.length - 1];
  const lastHeaderOffset = lastNewMsg.refs?.sourceLoc?.byteStart ?? state.lastProcessedHeaderOffset;
  
  const newState = updateImportState(state, buffer, newMessages.length, lastHeaderOffset);
  
  if (!options.planOnly) {
    await saveImportState(workspaceRoot, sourcePath, newState);
  }
  
  // Compute role stats for new messages
  const roleStats = computeRoleStats(newMessages);
  
  return {
    sessionId: state.sessionId,
    transcriptPath,
    messagesImported: state.messageCount + newMessages.length,
    newMessages: newMessages.length,
    state: newState,
    roleStats,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Apply role overrides from roles.json to messages.
 * Used during reimport to preserve user overrides.
 */
async function applyRoleOverrides(
  workspaceRoot: string,
  messages: TranscriptMessage[]
): Promise<void> {
  const overrides = await loadRoleOverrides(workspaceRoot);
  
  // Build contentHash → override map
  const hashToOverride = new Map<string, MessageRole>();
  for (const [sourceKey, override] of Object.entries(overrides)) {
    if (override.contentHash) {
      hashToOverride.set(override.contentHash, override.role);
    }
  }
  
  // Apply overrides by content hash
  for (const msg of messages) {
    const overrideRole = hashToOverride.get(msg.contentHash);
    if (overrideRole) {
      msg.messageRole = overrideRole;
      msg.roleSource = 'override';
    }
  }
}

/**
 * Compute role distribution statistics.
 */
function computeRoleStats(messages: TranscriptMessage[]): RoleStats {
  const stats: RoleStats = {
    intent: 0,
    spec: 0,
    implementation: 0,
    runlog: 0,
    meta: 0,
    unknown: 0,
    total: messages.length,
  };
  
  for (const msg of messages) {
    const role = msg.messageRole as keyof Omit<RoleStats, 'total'>;
    if (role in stats) {
      stats[role]++;
    } else {
      stats.unknown++;
    }
  }
  
  return stats;
}

/**
 * Find workspace root by looking for .iw directory or package.json.
 */
function findWorkspaceRoot(filePath: string): string {
  let dir = path.dirname(filePath);
  
  // Walk up to find workspace markers
  for (let i = 0; i < 10; i++) {
    // Check for .iw directory
    try {
      const iwPath = path.join(dir, '.iw');
      // We can't do sync fs here, so just return the directory containing .specstory
      if (filePath.includes('.specstory')) {
        const specstoryIdx = filePath.indexOf('.specstory');
        return filePath.slice(0, specstoryIdx);
      }
    } catch {
      // Continue
    }
    
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  
  // Default to directory containing the file's .specstory
  if (filePath.includes('.specstory')) {
    const idx = filePath.indexOf('.specstory');
    return filePath.slice(0, idx);
  }
  
  return path.dirname(filePath);
}

// =============================================================================
// Exports
// =============================================================================

export {
  SPECSTORY_ADAPTER_NAME,
  SPECSTORY_ADAPTER_VERSION,
};
