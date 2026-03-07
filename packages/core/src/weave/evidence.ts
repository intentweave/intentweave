/**
 * Weave Evidence Utilities
 * 
 * Functions for creating, deduplicating, and managing evidence records.
 */

import { createHash } from 'node:crypto';
import type { EvidenceRecord, EvidencePolicy } from './types.js';
import { DEFAULT_EVIDENCE_POLICY } from './types.js';
import { normalizeName } from './normalize.js';

// =============================================================================
// Evidence ID Generation
// =============================================================================

/**
 * Generate a physical evidence ID.
 * Stable within a specific artifact version (byte offsets + content).
 */
export function generateEvidenceId(params: {
  artifactVersionId?: string;
  uri: string;
  byteStart?: number;
  byteEnd?: number;
  excerptHash: string;
}): string {
  const input = [
    params.artifactVersionId ?? 'unknown',
    params.uri,
    params.byteStart ?? 0,
    params.byteEnd ?? 0,
    params.excerptHash,
  ].join('|');
  
  return `ev_${sha256Short(input)}`;
}

/**
 * Generate a logical evidence key.
 * Stable across byte shifts (based on content, not position).
 */
export function generateEvidenceLogicalKey(params: {
  artifactId: string;
  sourceKey?: string;
  excerpt: string;
}): string {
  const normExcerpt = normalizeName(params.excerpt);
  const input = [
    params.artifactId,
    params.sourceKey ?? '',
    normExcerpt,
  ].join('|');
  
  return sha256Short(input);
}

/**
 * Hash an excerpt for deduplication.
 */
export function hashExcerpt(excerpt: string): string {
  return sha256Short(excerpt);
}

// =============================================================================
// Evidence Record Creation
// =============================================================================

/**
 * Create an evidence record from file source.
 */
export function createFileEvidence(params: {
  artifactId: string;
  artifactVersionId?: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  byteStart?: number;
  byteEnd?: number;
  excerpt: string;
  policy?: EvidencePolicy;
}): EvidenceRecord {
  const policy = params.policy ?? DEFAULT_EVIDENCE_POLICY;
  const truncatedExcerpt = truncateExcerpt(params.excerpt, policy);
  const excerptHash = hashExcerpt(params.excerpt);
  
  const uri = params.filePath;
  
  return {
    id: generateEvidenceId({
      artifactVersionId: params.artifactVersionId,
      uri,
      byteStart: params.byteStart,
      byteEnd: params.byteEnd,
      excerptHash,
    }),
    logicalKey: generateEvidenceLogicalKey({
      artifactId: params.artifactId,
      excerpt: params.excerpt,
    }),
    kind: 'file',
    ref: {
      uri,
      artifactId: params.artifactId,
      artifactVersionId: params.artifactVersionId,
    },
    locator: {
      lineStart: params.lineStart,
      lineEnd: params.lineEnd,
      byteStart: params.byteStart,
      byteEnd: params.byteEnd,
    },
    excerpt: truncatedExcerpt,
    excerptHash,
  };
}

/**
 * Create an evidence record from transcript/IW source.
 */
export function createIwEvidence(params: {
  artifactId: string;
  sourceKey: string;
  seq?: number;
  excerpt: string;
  policy?: EvidencePolicy;
}): EvidenceRecord {
  const policy = params.policy ?? DEFAULT_EVIDENCE_POLICY;
  const truncatedExcerpt = truncateExcerpt(params.excerpt, policy);
  const excerptHash = hashExcerpt(params.excerpt);
  
  const uri = `iw://artifact/${params.artifactId}#${params.sourceKey}`;
  
  return {
    id: generateEvidenceId({
      uri,
      excerptHash,
    }),
    logicalKey: generateEvidenceLogicalKey({
      artifactId: params.artifactId,
      sourceKey: params.sourceKey,
      excerpt: params.excerpt,
    }),
    kind: 'iw',
    ref: {
      uri,
      artifactId: params.artifactId,
    },
    sourceKey: params.sourceKey,
    seq: params.seq,
    excerpt: truncatedExcerpt,
    excerptHash,
  };
}

// =============================================================================
// Evidence Deduplication
// =============================================================================

/**
 * Deduplicate evidence records by ID.
 * For records with same logical key but different physical IDs,
 * keeps the most recent (by position, if available).
 */
export function deduplicateEvidence(records: EvidenceRecord[]): {
  deduplicated: EvidenceRecord[];
  /** Maps superseded physical IDs to kept IDs */
  superseded: Map<string, string>;
} {
  const byLogicalKey = new Map<string, EvidenceRecord[]>();
  
  // Group by logical key
  for (const record of records) {
    const existing = byLogicalKey.get(record.logicalKey) ?? [];
    existing.push(record);
    byLogicalKey.set(record.logicalKey, existing);
  }
  
  const deduplicated: EvidenceRecord[] = [];
  const superseded = new Map<string, string>();
  
  for (const [, group] of byLogicalKey) {
    if (group.length === 1) {
      deduplicated.push(group[0]);
      continue;
    }
    
    // Multiple records with same logical key = same evidence, different positions
    // Keep the first by ID (deterministic), but track superseded
    const sorted = group.sort((a, b) => a.id.localeCompare(b.id));
    const kept = sorted[0];
    deduplicated.push(kept);
    
    for (let i = 1; i < sorted.length; i++) {
      superseded.set(sorted[i].id, kept.id);
    }
  }
  
  return { deduplicated, superseded };
}

/**
 * Merge evidence ID arrays, deduplicating by ID.
 */
export function mergeEvidenceIds(...arrays: string[][]): string[] {
  const set = new Set<string>();
  for (const arr of arrays) {
    for (const id of arr) {
      set.add(id);
    }
  }
  return Array.from(set).sort();
}

// =============================================================================
// Helper Functions
// =============================================================================

function sha256Short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Truncate excerpt per policy.
 */
function truncateExcerpt(excerpt: string, policy: EvidencePolicy): string {
  if (excerpt.length <= policy.maxExcerptChars) {
    return excerpt;
  }
  return excerpt.slice(0, policy.maxExcerptChars - 3) + '...';
}

/**
 * Sanitize excerpt (remove potential secrets).
 * Basic implementation - can be extended with pattern matching.
 */
export function sanitizeExcerpt(excerpt: string): string {
  // Remove common secret patterns
  return excerpt
    // API keys (generic patterns)
    .replace(/(?:api[_-]?key|apikey|secret|password|token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{16,}['"]?/gi, '[REDACTED]')
    // Bearer tokens
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    // AWS keys
    .replace(/AKIA[A-Z0-9]{16}/g, '[AWS_KEY_REDACTED]')
    // Generic long hex strings that look like secrets
    .replace(/['"][a-f0-9]{32,}['"]/gi, '"[HASH_REDACTED]"');
}

// Re-export default policy for convenience
export { DEFAULT_EVIDENCE_POLICY } from './types.js';
