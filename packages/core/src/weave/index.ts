// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Weave Module
 *
 * WX (Weave/Canonicalization) stage for IntentWeave.
 *
 * Provides:
 * - Normalization utilities (names, predicates, canonical keys)
 * - Evidence management (creation, deduplication, physical + logical anchoring)
 * - Registry for alias resolution and deprecation tracking
 * - Type definitions for raw and canonical layers
 */

// Normalization
export {
  NORMALIZATION_VERSION,
  normalizeName,
  normalizePredicate,
  isDeprecatedPredicate,
  getCanonicalPredicate,
  buildCanonicalKey,
  parseCanonicalKey,
  generateStableCgId,
  generateCanonicalId,
  generateCanonicalStatementId,
  hashLiteral,
  // Note: ArtifactRole and EntityType are already exported from ./types/index.js
} from "./normalize.js";

// Evidence
export {
  generateEvidenceId,
  generateEvidenceLogicalKey,
  hashExcerpt,
  createFileEvidence,
  createIwEvidence,
  deduplicateEvidence,
  mergeEvidenceIds,
  sanitizeExcerpt,
  DEFAULT_EVIDENCE_POLICY,
} from "./evidence.js";

// Registry
export {
  createEmptyRegistry,
  createEmptyOverrides,
  loadRegistry,
  saveRegistry,
  loadOverrides,
  resolveCanonicalKey,
  resolveToCanonicalId,
  isDeprecated,
  addAlias,
  deprecateCanonical,
} from "./registry.js";

// Executor
export {
  executeWeave,
  type WeaveInput,
  type WeaveOptions,
} from "./executor.js";

// Types
export type {
  // Evidence
  EvidenceRecord,
  EvidencePolicy,

  // Raw layer
  RawEntity,
  RawStatement,

  // Canonical layer
  CanonicalEntity,
  CanonicalStatement,

  // Mappings
  EntityMapping,
  StatementMapping,

  // Conflicts & stats
  WeaveConflict,
  WeaveStats,
  WeaveResult,

  // Registry
  WeaveRegistry,
  WeaveOverrides,

  // Bundle v2
  GraphBundleV2,
  ArtifactSummary,
  LxLink,
} from "./types.js";
