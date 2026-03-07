// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue Fingerprint Utilities
 * 
 * Computes stable fingerprints for issues based on their semantic core.
 * Fingerprints are used to maintain stable issue IDs across runs.
 */

import { createHash } from 'crypto';
import type { 
  IssueFingerprint, 
  ContradictionFingerprint,
  OpenEndFingerprint,
  NeedsReviewFingerprint,
  ErrorFingerprint,
  IssueKind,
} from './types.js';

/**
 * Compute SHA256 hash of fingerprint inputs.
 * Returns first 16 hex chars for readability.
 */
export function computeFingerprintHash(fingerprint: IssueFingerprint): string {
  // Normalize and serialize deterministically
  const normalized = normalizeFingerprint(fingerprint);
  const json = JSON.stringify(normalized);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  return hash.substring(0, 16);
}

/**
 * Normalize fingerprint inputs for stable hashing.
 * - Sort keys
 * - Lowercase strings
 * - Remove undefined values
 */
function normalizeFingerprint(fp: IssueFingerprint): Record<string, unknown> {
  const result: Record<string, unknown> = { kind: fp.kind };
  
  switch (fp.kind) {
    case 'contradiction': {
      const c = fp as ContradictionFingerprint;
      result.specClaimSourceKey = c.specClaimSourceKey;
      result.implObservationSourceKey = c.implObservationSourceKey;
      if (c.predicate) result.predicate = c.predicate.toLowerCase();
      if (c.entityName) result.entityName = c.entityName.toLowerCase();
      break;
    }
    case 'open_end': {
      const o = fp as OpenEndFingerprint;
      result.fromRole = o.fromRole;
      result.toRole = o.toRole;
      if (o.entityName) result.entityName = o.entityName.toLowerCase();
      if (o.predicate) result.predicate = o.predicate.toLowerCase();
      break;
    }
    case 'needs_review': {
      const n = fp as NeedsReviewFingerprint;
      result.ambiguityType = n.ambiguityType.toLowerCase();
      if (n.entityName) result.entityName = n.entityName.toLowerCase();
      if (n.predicate) result.predicate = n.predicate.toLowerCase();
      break;
    }
    case 'error': {
      const e = fp as ErrorFingerprint;
      result.errorCode = e.errorCode.toUpperCase();
      if (e.adapterName) result.adapterName = e.adapterName.toLowerCase();
      if (e.stage) result.stage = e.stage;
      break;
    }
  }
  
  return result;
}

/**
 * Get the issue ID prefix for a kind.
 */
export function getIssuePrefix(kind: IssueKind): 'C' | 'O' | 'N' | 'E' {
  switch (kind) {
    case 'contradiction': return 'C';
    case 'open_end': return 'O';
    case 'needs_review': return 'N';
    case 'error': return 'E';
  }
}

/**
 * Create a contradiction fingerprint.
 */
export function createContradictionFingerprint(
  specClaimSourceKey: string,
  implObservationSourceKey: string,
  predicate?: string,
  entityName?: string
): ContradictionFingerprint {
  return {
    kind: 'contradiction',
    specClaimSourceKey,
    implObservationSourceKey,
    predicate,
    entityName,
  };
}

/**
 * Create an open-end fingerprint.
 */
export function createOpenEndFingerprint(
  fromRole: OpenEndFingerprint['fromRole'],
  toRole: OpenEndFingerprint['toRole'],
  entityName?: string,
  predicate?: string
): OpenEndFingerprint {
  return {
    kind: 'open_end',
    fromRole,
    toRole,
    entityName,
    predicate,
  };
}

/**
 * Create a needs-review fingerprint.
 */
export function createNeedsReviewFingerprint(
  ambiguityType: string,
  entityName?: string,
  predicate?: string
): NeedsReviewFingerprint {
  return {
    kind: 'needs_review',
    ambiguityType,
    entityName,
    predicate,
  };
}

/**
 * Create an error fingerprint.
 */
export function createErrorFingerprint(
  errorCode: string,
  adapterName?: string,
  stage?: ErrorFingerprint['stage']
): ErrorFingerprint {
  return {
    kind: 'error',
    errorCode,
    adapterName,
    stage,
  };
}
