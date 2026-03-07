// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * cgId - CodeGraph Identifier Module
 * 
 * Migrated from src/domain/cgId.ts and src/domain/workspace/workspaceId.ts
 * 
 * cgId Format: root|kind|lang|signature[@version]
 * 
 * Workspace Stable ID Architecture:
 * - The `root` should be a stable workspace ID (e.g., "ws_8f3a", "ws_0000")
 * - This ensures workspace isolation and prevents ID collisions
 * - Legacy root "cgchat" is still supported for backwards compatibility
 * 
 * Examples:
 * - ws_8f3a|model|kg|resource/document
 * - ws_0000|model|kg|entity/user
 * - cgchat|model|kg|resource/document (legacy)
 */

import { randomBytes } from 'node:crypto';

// ============================================================================
// Constants
// ============================================================================

const CANONICAL_SEPARATOR = '|';
const ALIAS_SEPARATOR = ':';
const WORKSPACE_ID_PREFIX = 'ws_';
const LEGACY_ROOT = 'cgchat';
const DEFAULT_WORKSPACE_ID = 'ws_0000';
const KNOWN_KINDS = new Set(['code', 'model', 'api', 'db']);
const DEFAULT_KIND = 'model';
const DEFAULT_LANG = 'kg';

export const DEFAULT_CGID_ROOT = DEFAULT_WORKSPACE_ID;
export const LEGACY_CGID_ROOT = LEGACY_ROOT;

// ============================================================================
// Types
// ============================================================================

export interface CgId {
  root: string;
  kind: string;
  lang: string;
  signature: string;
  version?: string;
}

export interface BuildCgIdOptions {
  /** Workspace stable ID or legacy root. Defaults to DEFAULT_WORKSPACE_ID */
  root?: string;
  kind?: string;
  lang?: string;
  version?: string;
}

// ============================================================================
// Workspace ID Functions
// ============================================================================

/**
 * Generate a stable, immutable workspace ID
 * Format: ws_XXXX where XXXX is 4 random hex chars
 */
export function generateWorkspaceId(): string {
  const bytes = randomBytes(2);
  const hex = bytes.toString('hex');
  return `${WORKSPACE_ID_PREFIX}${hex}`;
}

/**
 * Generate a longer workspace ID for high-volume systems
 * Format: ws_XXXXXXXX (8 hex chars = 4 billion possibilities)
 */
export function generateLongWorkspaceId(): string {
  const bytes = randomBytes(4);
  const hex = bytes.toString('hex');
  return `${WORKSPACE_ID_PREFIX}${hex}`;
}

/**
 * Check if a string is a valid stable workspace ID
 */
export function isStableWorkspaceId(value: string): boolean {
  return /^ws_[a-f0-9]{4,8}$/i.test(value);
}

// ============================================================================
// Core cgId Functions
// ============================================================================

/**
 * Validates a cgId root.
 * Accepts:
 * - Stable workspace IDs: ws_XXXX (4-8 hex chars)
 * - Legacy roots: lowercase alphanumeric with hyphens (3-32 chars)
 */
function isValidRoot(root: string): boolean {
  if (isStableWorkspaceId(root)) {
    return true;
  }
  return /^[a-z0-9][a-z0-9-]{2,31}$/.test(root);
}

function ensureRoot(root?: string): string {
  if (root && isValidRoot(root)) return root;
  return DEFAULT_WORKSPACE_ID;
}

function encodeSignature(signature: string): string {
  return signature
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function decodeSignature(signature: string): string {
  return signature
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

export function slugifySegment(input: string): string {
  const normalized = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-_.]+/g, '')
    .replace(/-+/g, '-');

  if (!normalized) {
    // Fallback for inputs that only contain special characters (e.g., `- [ ]`)
    // Generate a deterministic slug from the original input's hash
    const hash = Array.from(input)
      .reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
      .toString(36)
      .replace('-', 'n');
    return `_special_${hash.slice(0, 8)}`;
  }

  return normalized;
}

function sanitizeSegments(segments: string[]): string[] {
  return segments.map((segment) => slugifySegment(segment));
}

/**
 * Parse a cgId string into components
 */
export function parseCgId(id: string): CgId {
  const trimmed = id.trim();
  const [preVersion, version] = trimmed.split('@', 2);
  const separator = preVersion.includes(CANONICAL_SEPARATOR) ? CANONICAL_SEPARATOR : ALIAS_SEPARATOR;
  const rawParts = preVersion.split(separator);

  if (rawParts.length < 4) {
    if (separator === ALIAS_SEPARATOR && rawParts.length >= 3) {
      const [scope, legacyType, ...rest] = rawParts;
      return {
        root: scope,
        kind: DEFAULT_KIND,
        lang: DEFAULT_LANG,
        signature: decodeSignature([legacyType, ...rest].join('/')),
        ...(version ? { version } : {})
      };
    }
    throw new Error(`Invalid cgId: ${id}`);
  }

  const [root, kindCandidate, langCandidate, ...sigParts] = rawParts;

  if (separator === ALIAS_SEPARATOR && !KNOWN_KINDS.has(kindCandidate)) {
    const legacyType = kindCandidate;
    return {
      root,
      kind: DEFAULT_KIND,
      lang: DEFAULT_LANG,
      signature: decodeSignature([legacyType, langCandidate, ...sigParts].join('/')),
      ...(version ? { version } : {})
    };
  }

  const signature = decodeSignature(sigParts.join(separator));

  return {
    root,
    kind: kindCandidate,
    lang: langCandidate,
    signature,
    ...(version ? { version } : {})
  };
}

/**
 * Convert a CgId object to canonical string format
 */
export function toCanonical(cgId: CgId): string {
  const root = ensureRoot(cgId.root);
  const kind = cgId.kind ?? DEFAULT_KIND;
  const lang = cgId.lang ?? DEFAULT_LANG;
  const encodedSignature = encodeSignature(cgId.signature);
  const base = [root, kind, lang, encodedSignature].join(CANONICAL_SEPARATOR);
  return cgId.version ? `${base}@${cgId.version}` : base;
}

/**
 * Convert a CgId object to alias string format
 */
export function toAlias(cgId: CgId): string {
  const root = ensureRoot(cgId.root);
  const kind = cgId.kind ?? DEFAULT_KIND;
  const lang = cgId.lang ?? DEFAULT_LANG;
  const encodedSignature = encodeSignature(cgId.signature);
  const base = [root, kind, lang, encodedSignature].join(ALIAS_SEPARATOR);
  return cgId.version ? `${base}@${cgId.version}` : base;
}

function resolveOptions(options?: BuildCgIdOptions): Required<Omit<BuildCgIdOptions, 'version'>> & { version?: string } {
  return {
    root: ensureRoot(options?.root),
    kind: options?.kind ?? DEFAULT_KIND,
    lang: options?.lang ?? DEFAULT_LANG,
    version: options?.version
  };
}

/**
 * Build a cgId from entity type and segments
 */
export function buildCgId(entityType: string, ...segments: Array<string | BuildCgIdOptions>): string {
  const rawSegments = [...segments];
  let options: BuildCgIdOptions | undefined;
  const last = rawSegments[rawSegments.length - 1];
  if (typeof last === 'object' && last !== null && !Array.isArray(last)) {
    options = last as BuildCgIdOptions;
    rawSegments.pop();
  }

  const stringSegments = rawSegments.map((segment) => {
    if (typeof segment !== 'string') {
      throw new Error('cgId segments must be strings');
    }
    return segment;
  });

  const { root, kind, lang, version } = resolveOptions(options);
  const signatureSegments = sanitizeSegments([entityType, ...stringSegments]);
  return toCanonical({ root, kind, lang, signature: signatureSegments.join('/'), version });
}

/**
 * Build a cgId with an explicit workspace ID as the root.
 */
export function buildWorkspaceCgId(
  workspaceId: string,
  entityType: string,
  ...segments: Array<string | Omit<BuildCgIdOptions, 'root'>>
): string {
  const rawSegments = [...segments];
  let options: Omit<BuildCgIdOptions, 'root'> | undefined;
  const last = rawSegments[rawSegments.length - 1];
  if (typeof last === 'object' && last !== null && !Array.isArray(last)) {
    options = last as Omit<BuildCgIdOptions, 'root'>;
    rawSegments.pop();
  }

  const stringSegments = rawSegments.map((segment) => {
    if (typeof segment !== 'string') {
      throw new Error('cgId segments must be strings');
    }
    return segment;
  });

  const root = ensureRoot(workspaceId);
  const kind = options?.kind ?? DEFAULT_KIND;
  const lang = options?.lang ?? DEFAULT_LANG;
  const version = options?.version;
  
  const signatureSegments = sanitizeSegments([entityType, ...stringSegments]);
  return toCanonical({ root, kind, lang, signature: signatureSegments.join('/'), version });
}

/**
 * Extract the workspace ID (root) from a cgId.
 */
export function extractWorkspaceId(cgIdString: string): string {
  try {
    const parsed = parseCgId(cgIdString);
    return parsed.root;
  } catch {
    return DEFAULT_WORKSPACE_ID;
  }
}

/**
 * Check if a cgId belongs to a specific workspace.
 */
export function cgIdBelongsToWorkspace(cgIdString: string, workspaceId: string): boolean {
  const cgIdRoot = extractWorkspaceId(cgIdString);
  return cgIdRoot === workspaceId;
}

/**
 * Check if a cgId uses a stable workspace ID (vs legacy root).
 */
export function hasStableWorkspaceRoot(cgIdString: string): boolean {
  const root = extractWorkspaceId(cgIdString);
  return isStableWorkspaceId(root);
}

/**
 * Check if a cgId uses the legacy "cgchat" root.
 */
export function hasLegacyRoot(cgIdString: string): boolean {
  const root = extractWorkspaceId(cgIdString);
  return root === LEGACY_ROOT;
}

/**
 * Migrate a cgId from legacy root to a stable workspace ID.
 */
export function migrateCgIdToWorkspace(cgIdString: string, newWorkspaceId: string): string {
  const parsed = parseCgId(cgIdString);
  return toCanonical({
    ...parsed,
    root: newWorkspaceId,
  });
}

/**
 * Validate a cgId format
 */
export function isValidCgId(cgId: string): boolean {
  try {
    parseCgId(cgId);
    return true;
  } catch {
    return false;
  }
}
