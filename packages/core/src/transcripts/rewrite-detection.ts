// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Rewrite Detection for Incremental Import
 *
 * Detects when a source file has been rewritten/edited vs appended.
 * Uses prefix, suffix, and anchor window hashes.
 */

import * as fs from "node:fs/promises";
import type { ImportState, RewriteCheck, UpdateCheck } from "./types.js";
import {
  computePrefixHash,
  computeSuffixHash,
  computeAnchorWindowHash,
} from "./hash.js";

// =============================================================================
// Rewrite Detection
// =============================================================================

/**
 * Detect if a file has been rewritten since last import.
 *
 * Rewrite signals:
 * 1. File size decreased
 * 2. Prefix hash changed (beginning of file modified)
 * 3. Anchor window hash changed (middle of file modified)
 *
 * @param filePath - Path to source file
 * @param state - Previous import state
 * @returns Rewrite check result
 */
export async function detectRewrite(
  filePath: string,
  state: ImportState,
): Promise<RewriteCheck> {
  // Read file
  const buffer = await fs.readFile(filePath);
  const currentSize = buffer.length;

  // Compute current hashes
  const currentPrefixHash = computePrefixHash(buffer);
  const currentSuffixHash = computeSuffixHash(buffer);
  const currentAnchorHash = computeAnchorWindowHash(buffer);

  // Check 1: File size decreased
  if (currentSize < state.lastSize) {
    return {
      mode: "rewrite",
      reason: "size_decreased",
      previousSize: state.lastSize,
      currentSize,
      prefixHash: currentPrefixHash,
      suffixHash: currentSuffixHash,
      anchorWindowHash: currentAnchorHash,
    };
  }

  // Check 2: Prefix hash changed
  if (currentPrefixHash !== state.prefixHash64k) {
    return {
      mode: "rewrite",
      reason: "prefix_changed",
      previousSize: state.lastSize,
      currentSize,
      prefixHash: currentPrefixHash,
      suffixHash: currentSuffixHash,
      anchorWindowHash: currentAnchorHash,
    };
  }

  // Check 3: Anchor window hash changed (if available)
  if (
    state.anchorWindowHash &&
    currentAnchorHash !== null &&
    currentAnchorHash !== state.anchorWindowHash
  ) {
    return {
      mode: "rewrite",
      reason: "anchor_changed",
      previousSize: state.lastSize,
      currentSize,
      prefixHash: currentPrefixHash,
      suffixHash: currentSuffixHash,
      anchorWindowHash: currentAnchorHash,
    };
  }

  // Check if file is unchanged
  if (currentSize === state.lastSize) {
    return {
      mode: "unchanged",
      previousSize: state.lastSize,
      currentSize,
      prefixHash: currentPrefixHash,
      suffixHash: currentSuffixHash,
      anchorWindowHash: currentAnchorHash,
    };
  }

  // File grew - append mode
  return {
    mode: "append",
    previousSize: state.lastSize,
    currentSize,
    prefixHash: currentPrefixHash,
    suffixHash: currentSuffixHash,
    anchorWindowHash: currentAnchorHash,
  };
}

/**
 * Check if file has updates since last import.
 * Implements the UpdateCheck interface from types.
 *
 * @param filePath - Path to source file
 * @param state - Previous import state (null for first import)
 * @returns Update check result
 */
export async function checkForUpdates(
  filePath: string,
  state: ImportState | null,
): Promise<UpdateCheck> {
  // Read file stats
  const stats = await fs.stat(filePath);
  const currentSize = stats.size;

  // First import - everything is new
  if (state === null) {
    return {
      hasUpdates: true,
      wasRewritten: false,
      newBytes: currentSize,
    };
  }

  // Check if file is unchanged (size and mtime)
  if (currentSize === state.lastSize && stats.mtimeMs === state.lastMtimeMs) {
    return {
      hasUpdates: false,
      wasRewritten: false,
      newBytes: 0,
    };
  }

  // Need to read file and check hashes
  const buffer = await fs.readFile(filePath);
  const rewriteCheck = detectRewriteFromBuffer(buffer, state);

  if (rewriteCheck.mode === "rewrite") {
    return {
      hasUpdates: true,
      wasRewritten: true,
      rewriteReason: rewriteCheck.reason,
      newBytes: currentSize,
    };
  }

  if (rewriteCheck.mode === "unchanged") {
    return {
      hasUpdates: false,
      wasRewritten: false,
      newBytes: 0,
    };
  }

  // Append mode - only new bytes
  return {
    hasUpdates: true,
    wasRewritten: false,
    newBytes: currentSize - state.lastOffset,
  };
}

/**
 * Detect rewrite from buffer directly.
 */
function detectRewriteFromBuffer(
  buffer: Buffer,
  state: ImportState,
): RewriteCheck {
  const currentSize = buffer.length;

  // Compute current hashes
  const currentPrefixHash = computePrefixHash(buffer);
  const currentSuffixHash = computeSuffixHash(buffer);
  const currentAnchorHash = computeAnchorWindowHash(buffer);

  // Check 1: File size decreased
  if (currentSize < state.lastSize) {
    return {
      mode: "rewrite",
      reason: "size_decreased",
      previousSize: state.lastSize,
      currentSize,
      prefixHash: currentPrefixHash,
      suffixHash: currentSuffixHash,
      anchorWindowHash: currentAnchorHash,
    };
  }

  // Check 2: Prefix hash changed
  if (currentPrefixHash !== state.prefixHash64k) {
    return {
      mode: "rewrite",
      reason: "prefix_changed",
      previousSize: state.lastSize,
      currentSize,
      prefixHash: currentPrefixHash,
      suffixHash: currentSuffixHash,
      anchorWindowHash: currentAnchorHash,
    };
  }

  // Check 3: Anchor window hash changed (if available)
  if (
    state.anchorWindowHash &&
    currentAnchorHash !== null &&
    currentAnchorHash !== state.anchorWindowHash
  ) {
    return {
      mode: "rewrite",
      reason: "anchor_changed",
      previousSize: state.lastSize,
      currentSize,
      prefixHash: currentPrefixHash,
      suffixHash: currentSuffixHash,
      anchorWindowHash: currentAnchorHash,
    };
  }

  // Check if file is unchanged
  if (currentSize === state.lastSize) {
    return {
      mode: "unchanged",
      previousSize: state.lastSize,
      currentSize,
      prefixHash: currentPrefixHash,
      suffixHash: currentSuffixHash,
      anchorWindowHash: currentAnchorHash,
    };
  }

  // File grew - append mode
  return {
    mode: "append",
    previousSize: state.lastSize,
    currentSize,
    prefixHash: currentPrefixHash,
    suffixHash: currentSuffixHash,
    anchorWindowHash: currentAnchorHash,
  };
}

// =============================================================================
// State Building Helpers
// =============================================================================

/**
 * Build partial import state from a file buffer.
 * Used when creating initial state for new files.
 *
 * @param buffer - File content buffer
 * @returns Partial import state with hash fields
 */
export function buildImportStateHashes(
  buffer: Buffer,
): Pick<ImportState, "prefixHash64k" | "suffixHash64k" | "anchorWindowHash"> {
  const anchorHash = computeAnchorWindowHash(buffer);
  return {
    prefixHash64k: computePrefixHash(buffer),
    suffixHash64k: computeSuffixHash(buffer),
    anchorWindowHash: anchorHash ?? "",
  };
}

/**
 * Create a new import state for a fresh import.
 *
 * @param sourcePath - Source file path
 * @param sessionId - Session identifier
 * @param buffer - File content buffer
 * @param messageCount - Number of messages imported
 * @param adapterVersion - Adapter version string
 * @param lastHeaderOffset - Byte offset of last processed header
 * @returns Complete import state
 */
export function createImportState(
  sourcePath: string,
  sessionId: string,
  buffer: Buffer,
  messageCount: number,
  adapterVersion: string,
  lastHeaderOffset: number = 0,
): ImportState {
  const hashes = buildImportStateHashes(buffer);
  const now = new Date().toISOString();

  return {
    sourcePath,
    sessionId,
    lastSize: buffer.length,
    lastMtimeMs: Date.now(),
    prefixHash64k: hashes.prefixHash64k,
    suffixHash64k: hashes.suffixHash64k,
    anchorWindowHash: hashes.anchorWindowHash,
    lastOffset: buffer.length,
    lastBoundaryOffset: buffer.length,
    lastProcessedHeaderOffset: lastHeaderOffset,
    lastProcessedSeq: messageCount,
    messageCount,
    adapterVersion,
    updatedAt: now,
  };
}

/**
 * Update import state after incremental append.
 *
 * @param state - Previous import state
 * @param buffer - New full file buffer
 * @param newMessageCount - Number of new messages imported
 * @param lastHeaderOffset - Byte offset of last processed header
 * @returns Updated import state
 */
export function updateImportState(
  state: ImportState,
  buffer: Buffer,
  newMessageCount: number,
  lastHeaderOffset: number,
): ImportState {
  const hashes = buildImportStateHashes(buffer);
  const now = new Date().toISOString();

  return {
    ...state,
    lastSize: buffer.length,
    lastMtimeMs: Date.now(),
    // Prefix stays same for appends (already validated)
    suffixHash64k: hashes.suffixHash64k,
    anchorWindowHash: hashes.anchorWindowHash,
    lastOffset: buffer.length,
    lastBoundaryOffset: buffer.length,
    lastProcessedHeaderOffset: lastHeaderOffset,
    lastProcessedSeq: state.lastProcessedSeq + newMessageCount,
    messageCount: state.messageCount + newMessageCount,
    updatedAt: now,
  };
}

// =============================================================================
// Type Exports
// =============================================================================

export type { RewriteCheck, UpdateCheck } from "./types.js";
