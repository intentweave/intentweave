// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Hash Utilities for Transcript System
 * 
 * Content-addressed hashing for messages and rewrite detection.
 * Uses SHA256 with full 64 hex chars.
 */

import { createHash } from 'node:crypto';
import { HASH_WINDOW_SIZE, LOOKBACK_SIZE, TranscriptFingerprintInput } from './types.js';

// =============================================================================
// Content Hash
// =============================================================================

/**
 * Compute SHA256 hash of normalized content.
 * Used for message `contentHash` field.
 * 
 * @param text - Raw message text
 * @returns 64 character lowercase hex string
 */
export function computeContentHash(text: string): string {
  const normalized = normalizeText(text);
  return sha256(normalized);
}

/**
 * Normalize text for hashing.
 * - Collapses whitespace runs to single space
 * - Trims leading/trailing whitespace
 * - Lowercases for case-insensitive matching
 * 
 * This ensures minor formatting changes don't invalidate hashes.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// =============================================================================
// Rewrite Detection Hashes
// =============================================================================

/**
 * Compute prefix hash for rewrite detection.
 * Hash of first HASH_WINDOW_SIZE bytes of file.
 * 
 * @param buffer - File content buffer
 * @returns 64 character lowercase hex string
 */
export function computePrefixHash(buffer: Buffer): string {
  const window = buffer.subarray(0, HASH_WINDOW_SIZE);
  return sha256Buffer(window);
}

/**
 * Compute suffix hash for rewrite detection.
 * Hash of last HASH_WINDOW_SIZE bytes of file.
 * 
 * @param buffer - File content buffer
 * @returns 64 character lowercase hex string
 */
export function computeSuffixHash(buffer: Buffer): string {
  const start = Math.max(0, buffer.length - HASH_WINDOW_SIZE);
  const window = buffer.subarray(start);
  return sha256Buffer(window);
}

/**
 * Compute anchor window hash for middle-of-file edit detection.
 * Hash of HASH_WINDOW_SIZE bytes ending at LOOKBACK_SIZE from the end.
 * 
 * Layout:
 *   [...file content...][anchor window (64KB)]---[LOOKBACK_SIZE (32KB)]---[EOF]
 *                       ^                   ^
 *                       |                   |
 *                       start               end (at file.length - LOOKBACK_SIZE)
 * 
 * @param buffer - File content buffer
 * @returns 64 character lowercase hex string, or null if file too small
 */
export function computeAnchorWindowHash(buffer: Buffer): string | null {
  // File must be large enough to have content before the anchor window
  const minSize = LOOKBACK_SIZE + HASH_WINDOW_SIZE;
  if (buffer.length < minSize) {
    return null;
  }
  
  const end = buffer.length - LOOKBACK_SIZE;
  const start = end - HASH_WINDOW_SIZE;
  const window = buffer.subarray(start, end);
  return sha256Buffer(window);
}

// =============================================================================
// Message Identity
// =============================================================================

/**
 * Build source key for a message.
 * Format: <source>:<sessionId>:m:<seq>
 * 
 * @param source - Adapter source name (e.g., 'specstory')
 * @param sessionId - Session identifier
 * @param seq - Message sequence number (1-based)
 * @returns Source key string
 */
export function buildSourceKey(source: string, sessionId: string, seq: number): string {
  return `${source}:${sessionId}:m:${seq}`;
}

/**
 * Parse a source key into components.
 * 
 * @param sourceKey - Source key string
 * @returns Parsed components or null if invalid
 */
export function parseSourceKey(sourceKey: string): {
  source: string;
  sessionId: string;
  seq: number;
} | null {
  const parts = sourceKey.split(':');
  
  // Expect: source:sessionId:m:seq
  // But sessionId might contain colons, so we need to be careful
  // Format is: <source>:<sessionId>:m:<seq>
  
  if (parts.length < 4) {
    return null;
  }
  
  // Last two parts should be 'm' and a number
  const seqStr = parts[parts.length - 1];
  const marker = parts[parts.length - 2];
  
  if (marker !== 'm') {
    return null;
  }
  
  const seq = parseInt(seqStr, 10);
  if (isNaN(seq) || seq < 1) {
    return null;
  }
  
  // Source is first part
  const source = parts[0];
  
  // SessionId is everything between source and `:m:`
  const sessionId = parts.slice(1, -2).join(':');
  
  if (!source || !sessionId) {
    return null;
  }
  
  return { source, sessionId, seq };
}

// =============================================================================
// Session ID Generation
// =============================================================================

/**
 * Generate session ID from source file path.
 * Uses the filename without extension.
 * 
 * @param filePath - Path to source file
 * @returns Session ID string
 */
export function generateSessionId(filePath: string): string {
  // Get basename without extension
  const basename = filePath.split('/').pop() ?? filePath;
  
  // Remove common extensions
  return basename
    .replace(/\.md$/, '')
    .replace(/\.json$/, '')
    .replace(/\.txt$/, '');
}

// =============================================================================
// Internal Utilities
// =============================================================================

/**
 * Compute SHA256 hash of a string.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Compute SHA256 hash of a buffer.
 */
function sha256Buffer(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

// =============================================================================
// Transcript Fingerprint
// =============================================================================

/**
 * Compute a stable fingerprint for a transcript session.
 * Includes version inputs for cache correctness.
 * 
 * @param input - Fingerprint inputs including content and version hashes
 * @returns 64 character lowercase hex hash
 */
export function computeTranscriptFingerprint(input: TranscriptFingerprintInput): string {
  // Create deterministic JSON representation
  const fingerprintData = JSON.stringify({
    sessionId: input.sessionId,
    count: input.count,
    lastSeq: input.lastSeq,
    lastContentHashes: input.lastContentHashes,
    rolesHash: input.rolesHash,
    heuristicsVersion: input.heuristicsVersion,
    adapterVersion: input.adapterVersion,
  });
  
  return sha256(fingerprintData);
}

/**
 * Compute roles hash for a specific session.
 * Hash of role overrides relevant to this session.
 * 
 * @param rolesJson - All role overrides
 * @param sessionId - Session ID to filter by
 * @returns 64 character lowercase hex hash (or 'none' if no overrides)
 */
export function computeRolesHash(
  rolesJson: Record<string, unknown>,
  sessionId: string
): string {
  // Extract roles relevant to this session
  const sessionRoles = Object.fromEntries(
    Object.entries(rolesJson).filter(([key]) => key.includes(sessionId))
  );
  
  if (Object.keys(sessionRoles).length === 0) {
    return 'none';
  }
  
  return sha256(JSON.stringify(sessionRoles));
}

// =============================================================================
// Byte Offset Utilities
// =============================================================================

/**
 * Get byte length of a UTF-8 string.
 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

/**
 * Get byte offset of a substring in UTF-8.
 * 
 * @param text - Full text
 * @param charOffset - Character offset
 * @returns Byte offset
 */
export function charToByteOffset(text: string, charOffset: number): number {
  const prefix = text.slice(0, charOffset);
  return Buffer.byteLength(prefix, 'utf-8');
}

/**
 * Get character offset from byte offset in UTF-8.
 * 
 * @param buffer - Buffer containing UTF-8 text
 * @param byteOffset - Byte offset
 * @returns Character offset
 */
export function byteToCharOffset(buffer: Buffer, byteOffset: number): number {
  const prefix = buffer.subarray(0, byteOffset);
  return prefix.toString('utf-8').length;
}
