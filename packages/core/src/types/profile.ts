// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile Runtime Types
 *
 * Defines the boundary contract between server/CLI and core pipeline stages.
 * Core stages receive ProfileRuntime, not implementation details like ProfilePack.
 *
 * @see docs/STATE-MACHINE-CANONICAL-SEMANTICS.md
 * @version 1.0.0
 */

// ============================================================================
// Profile Identity
// ============================================================================

/**
 * Profile identity for reproducibility tracking.
 * Stored in run.meta.json to enable debugging and parity analysis.
 */
export interface ProfileIdentity {
  /** Profile name (e.g., "planpling", "starter") */
  name: string;

  /** Profile version (e.g., "1.0.0") */
  version: string;

  /** Source of the profile */
  source: "builtin" | "workspace" | "path";

  /** Content fingerprint (SHA256, first 16 chars) for change detection */
  fingerprint: string;
}

// ============================================================================
// Profile Runtime Contract
// ============================================================================

/**
 * ProfileRuntime - boundary contract between server/CLI and core stages.
 *
 * This interface defines what core stages receive. Implementation details
 * (ProfilePack YAML, Neo4j storage, etc.) are hidden behind this interface.
 *
 * Key principles:
 * - Profiles define what the extractor MAY emit (kinds, predicates, shapes)
 * - MX guarantees canonical output regardless of what was extracted
 * - Post-MX validation is profile-aware for shapes only
 * - Canonical invariants always hold, independent of profile
 *
 * @example
 * ```typescript
 * const runtime: ProfileRuntime = {
 *   activeProfiles: ['planpling'],
 *   kinds: ['resource', 'state', 'action', 'role', 'transition'],
 *   predicates: ['HAS_STATE', 'TRANSITIONS_TO', 'ROLE_CAN'],
 *   shapes: [
 *     ['resource', 'HAS_STATE', 'state'],
 *     ['state', 'TRANSITIONS_TO', 'state'],
 *     ['role', 'ROLE_CAN', 'action'],
 *   ],
 *   identity: {
 *     name: 'planpling',
 *     version: '1.0.0',
 *     source: 'builtin',
 *     fingerprint: 'a1b2c3d4e5f6g7h8',
 *   },
 * };
 * ```
 */
export interface ProfileRuntime {
  /** Active profile names (for logging/debugging) */
  activeProfiles: string[];

  /** Valid entity kinds for this profile */
  kinds: string[];

  /** Valid predicates for this profile (includes extracted predicates) */
  predicates: string[];

  /**
   * Shape constraints as tuples: [subject, predicate, object]
   * Used for profile-aware validation (not canonical validation)
   */
  shapes: [subject: string, predicate: string, object: string][];

  /** Profile identity for reproducibility */
  identity: ProfileIdentity;
}

// ============================================================================
// Profile Runtime Stats (for run.meta.json)
// ============================================================================

/**
 * Profile runtime statistics for run metadata.
 */
export interface ProfileRuntimeStats {
  /** Number of entity kinds in profile */
  kindCount: number;

  /** Number of predicates in profile */
  predicateCount: number;

  /** Number of shape constraints in profile */
  shapeCount: number;
}

/**
 * Complete profile runtime metadata for run.meta.json.
 */
export interface ProfileRuntimeMeta {
  /** Active profile names */
  activeProfiles: string[];

  /** Profile identity */
  identity: ProfileIdentity;

  /** Profile statistics */
  stats: ProfileRuntimeStats;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an empty/default profile runtime (for testing or fallback).
 */
export function createEmptyProfileRuntime(): ProfileRuntime {
  return {
    activeProfiles: [],
    kinds: [],
    predicates: [],
    shapes: [],
    identity: {
      name: "empty",
      version: "0.0.0",
      source: "builtin",
      fingerprint: "0000000000000000",
    },
  };
}

/**
 * Create profile runtime metadata for run.meta.json.
 */
export function createProfileRuntimeMeta(
  runtime: ProfileRuntime,
): ProfileRuntimeMeta {
  return {
    activeProfiles: runtime.activeProfiles,
    identity: runtime.identity,
    stats: {
      kindCount: runtime.kinds.length,
      predicateCount: runtime.predicates.length,
      shapeCount: runtime.shapes.length,
    },
  };
}
