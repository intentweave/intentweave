/**
 * Weave Normalization Utilities
 * 
 * Deterministic normalization for entity names, predicates, and canonical keys.
 * All normalization is versioned to prevent silent ID churn across algorithm changes.
 */

import { createHash } from 'node:crypto';

// =============================================================================
// Normalization Version (bump this when changing normalization algorithms)
// =============================================================================

export const NORMALIZATION_VERSION = 'norm-v1';

// =============================================================================
// Name Normalization
// =============================================================================

/**
 * Normalize an entity name for canonical key generation.
 * 
 * Rules (v1):
 * - Lowercase
 * - Trim whitespace
 * - Collapse internal whitespace to single underscore
 * - Remove punctuation except: - _ / (common in identifiers)
 * - Remove common stopwords (optional, controlled by flag)
 * 
 * @example
 * normalizeName("Session State") // "session_state"
 * normalizeName("The User's Profile") // "users_profile"
 * normalizeName("  Foo   Bar  ") // "foo_bar"
 */
export function normalizeName(name: string, options?: { removeStopwords?: boolean }): string {
  let result = name
    // Trim
    .trim()
    // Lowercase
    .toLowerCase()
    // Replace common separators with underscore
    .replace(/[\s\-\.]+/g, '_')
    // Remove punctuation except allowed: _ - /
    .replace(/[^a-z0-9_\-\/]/g, '')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '');

  if (options?.removeStopwords) {
    result = removeStopwords(result);
  }

  return result || 'unnamed';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
]);

function removeStopwords(normalized: string): string {
  const parts = normalized.split('_');
  const filtered = parts.filter(p => !STOPWORDS.has(p) && p.length > 0);
  return filtered.length > 0 ? filtered.join('_') : normalized;
}

// =============================================================================
// Predicate Normalization
// =============================================================================

/**
 * Convert camelCase or PascalCase to UPPER_SNAKE_CASE.
 */
function toUpperSnakeCase(str: string): string {
  // Insert underscore before capital letters (but not at start)
  // e.g. "hasState" -> "has_State" -> "HAS_STATE"
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[\s\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Predicate alias table for normalization.
 * Maps variant predicates to their canonical form.
 * All keys should be UPPER_SNAKE_CASE.
 */
const PREDICATE_ALIASES: Record<string, string> = {
  // State/status variants
  'HAS_STATUS': 'HAS_STATE',
  'STATUS': 'HAS_STATE',
  
  // Implementation variants
  'IMPLEMENTS': 'REALIZES',
  'SATISFIES': 'REALIZES',
  'FULFILLS': 'REALIZES',
  
  // Reference variants
  'MENTIONS': 'REFERENCES',
  'CITES': 'REFERENCES',
  'LINKS_TO': 'REFERENCES',
  
  // Containment variants
  'INCLUDES': 'CONTAINS',
  'HAS': 'CONTAINS',
  
  // Dependency variants
  'DEPENDS_ON': 'REQUIRES',
  'NEEDS': 'REQUIRES',
};

/**
 * Normalize a predicate for canonical statement generation.
 * 
 * Rules:
 * - Convert camelCase to UPPER_SNAKE_CASE
 * - Replace hyphens and spaces with underscore
 * - Apply alias table
 * 
 * @example
 * normalizePredicate("hasState") // "HAS_STATE"
 * normalizePredicate("depends-on") // "REQUIRES"
 */
export function normalizePredicate(predicate: string): string {
  const upper = toUpperSnakeCase(predicate);

  // Apply alias
  return PREDICATE_ALIASES[upper] ?? upper;
}

/**
 * Check if a predicate is a known alias (deprecated form).
 */
export function isDeprecatedPredicate(predicate: string): boolean {
  const upper = toUpperSnakeCase(predicate);
  return upper in PREDICATE_ALIASES;
}

/**
 * Get the canonical form for a predicate (returns same if not aliased).
 */
export function getCanonicalPredicate(predicate: string): string {
  return normalizePredicate(predicate);
}

// =============================================================================
// Canonical Key Generation
// =============================================================================

export type ArtifactRole = 'intent' | 'spec' | 'implementation' | 'test' | 'config' | 'unknown';
export type EntityType = 'resource' | 'state' | 'action' | 'rule' | 'transition' | 'event' | 'role' | 'unknown';

/**
 * Build a canonical key for entity grouping.
 * 
 * Format: <version>|<artifactRole>|<entityType>|<normalizedName>
 * 
 * @example
 * buildCanonicalKey({ role: 'spec', type: 'rule', name: 'Promotion Criteria' })
 * // "norm-v1|spec|rule|promotion_criteria"
 */
export function buildCanonicalKey(params: {
  role: ArtifactRole;
  type: EntityType;
  name: string;
}): string {
  const normName = normalizeName(params.name);
  return `${NORMALIZATION_VERSION}|${params.role}|${params.type}|${normName}`;
}

/**
 * Parse a canonical key into its components.
 */
export function parseCanonicalKey(key: string): {
  version: string;
  role: ArtifactRole;
  type: EntityType;
  normalizedName: string;
} | null {
  const parts = key.split('|');
  if (parts.length !== 4) return null;
  
  const [version, role, type, normalizedName] = parts;
  return {
    version,
    role: role as ArtifactRole,
    type: type as EntityType,
    normalizedName,
  };
}

// =============================================================================
// Deterministic ID Generation
// =============================================================================

/**
 * Generate a stable cgId for a raw entity.
 * 
 * This ID is stable across re-extractions as long as the concept
 * (name + type) remains the same in the artifact.
 * 
 * Format: sha256(artifactId|artifactRole|type|normalizedName)
 */
export function generateStableCgId(params: {
  artifactId: string;
  artifactRole: ArtifactRole;
  type: EntityType;
  name: string;
  /** Optional ordinal for same-name disambiguation within artifact */
  ordinal?: number;
}): string {
  const normName = normalizeName(params.name);
  const input = [
    params.artifactId,
    params.artifactRole,
    params.type,
    normName,
    params.ordinal !== undefined ? String(params.ordinal) : '',
  ].join('|');
  
  return sha256Short(input);
}

/**
 * Generate a deterministic canonicalId from a canonical key.
 * 
 * Format: ce_<base32(sha256(canonicalKey)).slice(0, 16)>
 * 
 * This eliminates the need for a registry to assign sequential IDs,
 * and avoids concurrency/locking issues.
 */
export function generateCanonicalId(canonicalKey: string): string {
  const hash = createHash('sha256').update(canonicalKey).digest();
  // Use base32 (alphanumeric, case-insensitive) for readability
  const base32 = hash.toString('hex').slice(0, 16);
  return `ce_${base32}`;
}

/**
 * Generate a deterministic canonical statement ID.
 * 
 * Format: cs_<sha256(subjectCanonicalId|predicate|objectCanonicalId|objectLiteral)>
 */
export function generateCanonicalStatementId(params: {
  subjectCanonicalId: string;
  predicate: string;
  objectCanonicalId?: string;
  objectLiteral?: string;
}): string {
  const normPred = normalizePredicate(params.predicate);
  const objectPart = params.objectCanonicalId ?? params.objectLiteral ?? '';
  const input = `${params.subjectCanonicalId}|${normPred}|${objectPart}`;
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 16);
  return `cs_${hash}`;
}

// =============================================================================
// Helper Functions
// =============================================================================

function sha256Short(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Hash a literal value for statement signature comparison.
 */
export function hashLiteral(value: string): string {
  return sha256Short(normalizeName(value));
}
