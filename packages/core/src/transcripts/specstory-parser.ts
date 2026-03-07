/**
 * SpecStory Markdown Parser
 * 
 * Parses SpecStory markdown files into TranscriptMessage format.
 * Handles incremental parsing with absolute byte offsets.
 */

import type {
  TranscriptMessage,
  MessageRole,
  Speaker,
  TranscriptParseResult,
} from './types.js';
import {
  computeContentHash,
  buildSourceKey,
  charToByteOffset,
} from './hash.js';
import {
  scoreMessage,
  speakerToMessageRole,
  stripInlineTags,
} from './heuristics.js';

// =============================================================================
// Constants
// =============================================================================

/** Adapter name for SpecStory */
export const SPECSTORY_ADAPTER_NAME = 'specstory';

/** Current adapter version */
export const SPECSTORY_ADAPTER_VERSION = '0.1.0';

/** Parser version string */
export const SPECSTORY_PARSER_VERSION = `specstory-parser@${SPECSTORY_ADAPTER_VERSION}`;

// =============================================================================
// Types
// =============================================================================

/**
 * Intermediate parsed message before seq assignment.
 */
interface RawParsedMessage {
  speaker: Speaker;
  model?: string;
  ts?: string;
  rawText: string;
  text: string;
  absHeaderOffset: number;
  absContentEnd: number;
  contentHash: string;
  messageRole: MessageRole;
  roleSource: 'heuristic' | 'inline';
}

/**
 * Result of parsing a SpecStory file or slice.
 */
export interface SpecStoryParseResult {
  /** Parsed messages (without seq/sourceKey assigned) */
  rawMessages: RawParsedMessage[];
  /** Extracted session ID from file header */
  sessionId: string;
  /** Absolute byte offset of last safe message boundary */
  lastSafeBoundaryOffset: number;
}

// =============================================================================
// Pattern Definitions
// =============================================================================

/** Session ID pattern in HTML comment */
const SESSION_PATTERN = /<!-- vscode Session ([a-f0-9-]+) \(([^)]+)\) -->/;

/**
 * Message header pattern.
 * Matches: _**User (timestamp)**_, _**Assistant (model)**_, etc.
 * Must be anchored at start of line.
 */
const MESSAGE_HEADER_PATTERN = /^_\*\*(User|Assistant|System|Tool)\s*(?:\(([^)]*)\))?\*\*_/gm;

/** Timestamp pattern in header metadata */
const TIMESTAMP_PATTERN = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?Z?)/;

/** Model pattern (alphanumeric with dashes/slashes, not starting with year) */
const MODEL_PATTERN = /^([a-zA-Z][a-zA-Z0-9\-\/._]+)$/;

/** Inline role override pattern */
const INLINE_ROLE_PATTERN = /@iw\s+role=(\w+)/i;

/** HTML comment role override pattern */
const COMMENT_ROLE_PATTERN = /<!--\s*iw:role=(\w+)\s*-->/i;

/** Message separator before next header (for safe boundary detection) */
const SAFE_BOUNDARY_PATTERN = /---\s*\n\s*_\*\*(?:User|Assistant|System|Tool)/g;

// =============================================================================
// Parser Functions
// =============================================================================

/**
 * Parse a SpecStory file buffer completely.
 * 
 * @param buffer - File content as Buffer
 * @param sessionId - Optional session ID override
 * @returns Parse result with raw messages
 */
export function parseSpecStoryFile(
  buffer: Buffer,
  sessionId?: string
): SpecStoryParseResult {
  return parseSpecStorySlice(buffer, 0, sessionId ?? '');
}

/**
 * Parse a slice of a SpecStory file (for incremental import).
 * 
 * @param buffer - Slice content as Buffer
 * @param sliceStartOffset - Absolute byte offset where this slice begins
 * @param fallbackSessionId - Session ID to use if not found in content
 * @returns Parse result with raw messages and offsets
 */
export function parseSpecStorySlice(
  buffer: Buffer,
  sliceStartOffset: number,
  fallbackSessionId: string
): SpecStoryParseResult {
  const content = buffer.toString('utf-8');
  const rawMessages: RawParsedMessage[] = [];
  
  // Extract session ID from header if present
  const sessionMatch = content.match(SESSION_PATTERN);
  const sessionId = sessionMatch?.[1] ?? fallbackSessionId;
  
  // Reset pattern for fresh matching
  MESSAGE_HEADER_PATTERN.lastIndex = 0;
  
  let match: RegExpExecArray | null;
  let lastHeaderEndCharOffset = 0;
  let prevMessage: RawParsedMessage | null = null;
  let prevHeaderCharOffset = 0;
  
  while ((match = MESSAGE_HEADER_PATTERN.exec(content)) !== null) {
    const charOffset = match.index;
    const headerText = match[0];
    const speakerRaw = match[1].toLowerCase() as Speaker;
    const meta = match[2] ?? '';
    
    // Convert char offset to byte offset
    const byteOffset = charToByteOffset(content, charOffset);
    const absHeaderOffset = sliceStartOffset + byteOffset;
    
    // Close previous message
    if (prevMessage) {
      const rawContent = content.slice(lastHeaderEndCharOffset, charOffset);
      finalizeParsedMessage(prevMessage, rawContent, sliceStartOffset, charOffset, content);
    }
    
    // Parse timestamp (optional, NOT used for identity)
    const tsMatch = meta.match(TIMESTAMP_PATTERN);
    const timestamp = tsMatch?.[1];
    
    // Parse model for assistant
    let model: string | undefined;
    if (speakerRaw === 'assistant') {
      const modelMatch = meta.match(MODEL_PATTERN);
      if (modelMatch && !meta.match(/^\d{4}/)) {
        model = modelMatch[1];
      }
    }
    
    // Create raw message
    const msg: RawParsedMessage = {
      speaker: speakerRaw,
      model,
      ts: timestamp,
      rawText: '',
      text: '',
      absHeaderOffset,
      absContentEnd: 0,
      contentHash: '',
      messageRole: 'unknown',
      roleSource: 'heuristic',
    };
    
    rawMessages.push(msg);
    prevMessage = msg;
    prevHeaderCharOffset = charOffset;
    lastHeaderEndCharOffset = charOffset + headerText.length;
  }
  
  // Finalize last message
  if (prevMessage) {
    const rawContent = content.slice(lastHeaderEndCharOffset);
    finalizeParsedMessage(
      prevMessage,
      rawContent,
      sliceStartOffset,
      content.length,
      content
    );
  }
  
  // Find last safe boundary
  const lastSafeBoundaryOffset = findLastSafeBoundary(content, sliceStartOffset);
  
  return {
    rawMessages,
    sessionId,
    lastSafeBoundaryOffset,
  };
}

/**
 * Finalize a parsed message by computing its content fields.
 */
function finalizeParsedMessage(
  msg: RawParsedMessage,
  rawContent: string,
  sliceStartOffset: number,
  contentEndCharOffset: number,
  fullContent: string
): void {
  // Clean content
  msg.rawText = cleanMessageContent(rawContent);
  msg.text = stripInlineTags(msg.rawText);
  msg.contentHash = computeContentHash(msg.text);
  
  // Compute content end byte offset
  msg.absContentEnd = sliceStartOffset + charToByteOffset(fullContent, contentEndCharOffset);
  
  // Check for inline role override
  const inlineMatch = msg.rawText.match(INLINE_ROLE_PATTERN);
  const commentMatch = msg.rawText.match(COMMENT_ROLE_PATTERN);
  const inlineRole = inlineMatch?.[1] ?? commentMatch?.[1];
  
  if (inlineRole && isValidMessageRole(inlineRole)) {
    msg.messageRole = inlineRole as MessageRole;
    msg.roleSource = 'inline';
  } else {
    // Use heuristics
    msg.messageRole = speakerToMessageRole(msg.speaker);
    msg.roleSource = 'heuristic';
  }
}

/**
 * Clean raw message content.
 */
function cleanMessageContent(raw: string): string {
  return raw
    .replace(/^---\s*/, '')      // Remove leading separator
    .replace(/\s*---$/, '')      // Remove trailing separator
    .trim();
}

/**
 * Find the last safe message boundary in content.
 * A safe boundary is where we can safely resume parsing without splitting a message.
 */
function findLastSafeBoundary(content: string, sliceStartOffset: number): number {
  SAFE_BOUNDARY_PATTERN.lastIndex = 0;
  
  let lastMatch = -1;
  let match: RegExpExecArray | null;
  
  while ((match = SAFE_BOUNDARY_PATTERN.exec(content)) !== null) {
    lastMatch = match.index;
  }
  
  if (lastMatch < 0) {
    return sliceStartOffset;
  }
  
  return sliceStartOffset + charToByteOffset(content, lastMatch);
}

/**
 * Check if a string is a valid MessageRole.
 */
function isValidMessageRole(role: string): boolean {
  const validRoles: MessageRole[] = ['intent', 'spec', 'implementation', 'runlog', 'meta', 'unknown'];
  return validRoles.includes(role.toLowerCase() as MessageRole);
}

// =============================================================================
// Session ID Extraction
// =============================================================================

/**
 * Extract session ID from SpecStory filename.
 * 
 * @param filename - Filename like "2025-09-25_18-36Z-project-setup.md"
 * @returns Extracted slug or full basename
 */
export function extractSessionIdFromFilename(filename: string): string {
  // Remove .md extension
  const base = filename.replace(/\.md$/, '');
  
  // Try to extract slug after timestamp
  // Pattern: YYYY-MM-DD_HH-MMZ-<slug>
  const slugMatch = base.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}Z?-(.+)$/);
  if (slugMatch) {
    return slugMatch[1];
  }
  
  return base;
}

/**
 * Extract session UUID from file content.
 * 
 * @param content - File content string
 * @returns Session UUID or null
 */
export function extractSessionUUID(content: string): string | null {
  const match = content.match(SESSION_PATTERN);
  return match?.[1] ?? null;
}

// =============================================================================
// Message Building
// =============================================================================

/**
 * Convert raw parsed messages to TranscriptMessages with seq assignment.
 * 
 * @param rawMessages - Raw parsed messages
 * @param sessionId - Session identifier
 * @param startSeq - Starting sequence number
 * @param source - Adapter source name
 * @returns Array of TranscriptMessages
 */
export function buildTranscriptMessages(
  rawMessages: RawParsedMessage[],
  sessionId: string,
  startSeq: number = 1,
  source: string = SPECSTORY_ADAPTER_NAME
): TranscriptMessage[] {
  return rawMessages.map((raw, index) => {
    const seq = startSeq + index;
    const sourceKey = buildSourceKey(source, sessionId, seq);
    
    return {
      sourceKey,
      id: sourceKey,
      contentHash: raw.contentHash,
      source,
      sourceSessionId: sessionId,
      seq,
      ts: raw.ts,
      speaker: raw.speaker,
      messageRole: raw.messageRole,
      roleSource: raw.roleSource,
      rawText: raw.rawText,
      text: raw.text,
      parserVersion: SPECSTORY_PARSER_VERSION,
      refs: {
        sourceLoc: {
          file: '', // Filled in by adapter
          byteStart: raw.absHeaderOffset,
          byteEnd: raw.absContentEnd,
        },
      },
    };
  });
}

/**
 * Filter messages to only those with header offset greater than threshold.
 * Used for incremental import.
 * 
 * @param messages - Raw parsed messages
 * @param lastProcessedHeaderOffset - Offset of last processed header
 * @returns Filtered messages
 */
export function filterNewMessages(
  messages: RawParsedMessage[],
  lastProcessedHeaderOffset: number
): RawParsedMessage[] {
  return messages.filter(m => m.absHeaderOffset > lastProcessedHeaderOffset);
}
