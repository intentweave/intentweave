// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Weave Executor (WX Stage)
 * 
 * Phase 1 Implementation:
 * - Groups entities by canonicalKey within same artifactRole
 * - Assigns deterministic canonicalIds
 * - Detects conflicts (type mismatch, contradictory values)
 * - Deduplicates statements
 * - Merges evidence
 */

import type {
  WeaveRegistry,
  WeaveOverrides,
  WeaveResult,
  WeaveStats,
  WeaveConflict,
  RawEntity,
  RawStatement,
  CanonicalEntity,
  CanonicalStatement,
  EvidenceRecord,
  WeaveDebugInfo,
  MergeExplanation,
  PotentialMergePair,
} from './types.js';
import {
  buildCanonicalKey,
  generateCanonicalId,
  generateCanonicalStatementId,
  normalizePredicate,
  normalizeName,
} from './normalize.js';
import { deduplicateEvidence, mergeEvidenceIds } from './evidence.js';
import {
  createEmptyRegistry,
  resolveToCanonicalId,
  isDeprecated,
} from './registry.js';

// =============================================================================
// Types
// =============================================================================

export interface WeaveInput {
  /** Raw entities from extraction/aggregation */
  entities: RawEntity[];
  /** Raw statements from extraction/aggregation */
  statements: RawStatement[];
  /** All evidence records */
  evidence: EvidenceRecord[];
  /** Optional registry for alias resolution */
  registry?: WeaveRegistry;
  /** Optional overrides for manual merge/split */
  overrides?: WeaveOverrides;
}

export interface WeaveOptions {
  /** Only weave within same artifactRole (Phase 1 default) */
  sameRoleOnly?: boolean;
  /** Emit warnings for conflicts instead of failing */
  warnOnConflict?: boolean;
  /** Include debug information in result */
  debug?: boolean;
}

// =============================================================================
// Executor
// =============================================================================

/**
 * Execute the WX (Weave) stage.
 * 
 * Phase 1 algorithm:
 * 1. Group entities by (artifactRole, canonicalKey)
 * 2. For each group:
 *    a. Pick representative entity (most evidence)
 *    b. Merge evidence IDs
 *    c. Assign canonicalId via hash(canonicalKey)
 *    d. Detect conflicts (type mismatch, etc.)
 * 3. Remap statements to use canonicalIds
 * 4. Deduplicate statements by (subject, predicate, object)
 * 5. Merge evidence for deduplicated statements
 */
export function executeWeave(
  input: WeaveInput,
  options: WeaveOptions = {}
): WeaveResult {
  const { sameRoleOnly = true, warnOnConflict = true, debug = false } = options;
  const registry = input.registry ?? createEmptyRegistry();
  const overrides = input.overrides;

  const conflicts: WeaveConflict[] = [];
  const warnings: string[] = [];

  // Stats tracking
  const stats: WeaveStats = {
    rawEntityCount: input.entities.length,
    rawStatementCount: input.statements.length,
    canonicalEntityCount: 0,
    canonicalStatementCount: 0,
    mergedEntityGroups: 0,
    conflictCount: 0,
  };

  // Debug info
  const debugInfo: WeaveDebugInfo = {};
  const mergeExplanations: Record<string, MergeExplanation> = {};
  const normalizationTrace: Record<string, string> = {};

  // Compute role and type distributions for stats
  if (debug) {
    const roleDistribution: Record<string, number> = {};
    const typeDistribution: Record<string, number> = {};
    for (const entity of input.entities) {
      roleDistribution[entity.artifactRole] = (roleDistribution[entity.artifactRole] || 0) + 1;
      typeDistribution[entity.type] = (typeDistribution[entity.type] || 0) + 1;
      // Track normalization
      const normalized = normalizeName(entity.name);
      if (normalized !== entity.name.toLowerCase()) {
        normalizationTrace[entity.name] = normalized;
      }
    }
    stats.roleDistribution = roleDistribution;
    stats.typeDistribution = typeDistribution;
  }

  // Step 1: Group entities by canonical key
  const entityGroups = groupEntities(input.entities, sameRoleOnly);
  stats.mergedEntityGroups = entityGroups.size;

  // Compute cluster size distribution
  const clusterSizeDistribution: Record<number, number> = {};
  let totalMembers = 0;
  let largestClusterSize = 0;
  let largestClusterMembers: string[] = [];
  let singletonCount = 0;

  for (const [_groupKey, groupMembers] of entityGroups) {
    const size = groupMembers.length;
    clusterSizeDistribution[size] = (clusterSizeDistribution[size] || 0) + 1;
    totalMembers += size;
    
    if (size === 1) {
      singletonCount++;
    }
    
    if (size > largestClusterSize) {
      largestClusterSize = size;
      largestClusterMembers = groupMembers.map(e => `${e.name} (${e.cgId})`);
    }
  }

  stats.clusterSizeDistribution = clusterSizeDistribution;
  stats.singletonCount = singletonCount;
  stats.largestClusterSize = largestClusterSize;
  stats.avgMemberCount = entityGroups.size > 0 ? totalMembers / entityGroups.size : 0;
  
  if (debug) {
    stats.largestClusterMembers = largestClusterMembers;
  }

  if (debug) {
    debugInfo.normalizationTrace = normalizationTrace;
  }

  // Step 2: Create canonical entities
  const canonicalEntities: CanonicalEntity[] = [];
  const cgIdToCanonicalId = new Map<string, string>();

  for (const [groupKey, rawEntities] of entityGroups) {
    const result = mergeEntityGroup(groupKey, rawEntities, registry, overrides);
    
    if (result.conflict) {
      conflicts.push(result.conflict);
      stats.conflictCount++;
      
      if (!warnOnConflict) {
        throw new Error(`Weave conflict: ${result.conflict.description}`);
      }
      warnings.push(`Conflict in group ${groupKey}: ${result.conflict.description}`);
    }

    canonicalEntities.push(result.canonical);
    
    // Map all member cgIds to this canonical
    for (const cgId of result.canonical.memberCgIds) {
      cgIdToCanonicalId.set(cgId, result.canonical.canonicalId);
    }

    // Record merge explanation for debug
    if (debug && rawEntities.length > 1) {
      mergeExplanations[result.canonical.canonicalId] = {
        canonicalId: result.canonical.canonicalId,
        canonicalKey: result.canonical.key,
        role: result.canonical.artifactRole,
        type: result.canonical.type,
        normalizedName: normalizeName(result.canonical.displayName),
        memberCgIds: result.canonical.memberCgIds,
        originalNames: rawEntities.map(e => e.name),
        artifactIds: [...new Set(rawEntities.map(e => e.artifactId))],
        reason: 'same_key',
      };
    }
  }

  stats.canonicalEntityCount = canonicalEntities.length;

  // Step 3: Remap and deduplicate statements
  const canonicalStatements = remapAndDeduplicateStatements(
    input.statements,
    cgIdToCanonicalId,
    registry
  );

  stats.canonicalStatementCount = canonicalStatements.length;

  // Step 4: Deduplicate evidence
  const { deduplicated: deduplicatedEvidence, superseded } = deduplicateEvidence(
    input.evidence
  );

  if (superseded.size > 0 && debug) {
    (debugInfo as Record<string, unknown>).supersededEvidence = Array.from(superseded.entries());
  }

  // Step 5: Find potential merge pairs (false negative detection) - only if debug
  if (debug) {
    const potentialMergePairs = findPotentialMergePairs(input.entities, entityGroups, sameRoleOnly);
    stats.rejectedMergeCandidates = potentialMergePairs.length;
    
    debugInfo.mergeExplanations = mergeExplanations;
    debugInfo.potentialMergePairs = potentialMergePairs.slice(0, 100); // Top 100
  }

  return {
    entities: canonicalEntities,
    statements: canonicalStatements,
    evidence: deduplicatedEvidence,
    conflicts,
    stats,
    warnings: warnings.length > 0 ? warnings : undefined,
    debug: debug ? debugInfo : undefined,
  };
}

// =============================================================================
// Entity Grouping
// =============================================================================

interface GroupKey {
  role: string;
  canonicalKey: string;
}

function groupEntities(
  entities: RawEntity[],
  sameRoleOnly: boolean
): Map<string, RawEntity[]> {
  const groups = new Map<string, RawEntity[]>();

  for (const entity of entities) {
    const canonicalKey = buildCanonicalKey({
      role: entity.artifactRole,
      type: entity.type,
      name: entity.name,
    });

    // Group key includes role in Phase 1
    const groupKey = sameRoleOnly
      ? `${entity.artifactRole}|${canonicalKey}`
      : canonicalKey;

    const group = groups.get(groupKey) ?? [];
    group.push(entity);
    groups.set(groupKey, group);
  }

  return groups;
}

// =============================================================================
// Entity Merging
// =============================================================================

interface MergeResult {
  canonical: CanonicalEntity;
  conflict?: WeaveConflict;
}

function mergeEntityGroup(
  groupKey: string,
  rawEntities: RawEntity[],
  registry: WeaveRegistry,
  overrides?: WeaveOverrides
): MergeResult {
  // Validate all have same type
  const types = new Set(rawEntities.map(e => e.type));
  let conflict: WeaveConflict | undefined;

  if (types.size > 1) {
    conflict = {
      kind: 'type-mismatch',
      canonicalKey: groupKey,
      cgIds: rawEntities.map(e => e.cgId),
      description: `Type mismatch in group: ${Array.from(types).join(', ')}`,
      values: Array.from(types),
    };
  }

  // Pick representative (most evidence)
  const sorted = [...rawEntities].sort(
    (a, b) => (b.evidenceIds?.length ?? 0) - (a.evidenceIds?.length ?? 0)
  );
  const representative = sorted[0];

  // Build canonical key for this entity
  const canonicalKey = buildCanonicalKey({
    role: representative.artifactRole,
    type: representative.type,
    name: representative.name,
  });

  // Resolve through registry and get canonical ID
  const canonicalId = resolveToCanonicalId(canonicalKey, registry, overrides);

  // Check if this canonical is deprecated
  const deprecation = isDeprecated(canonicalId, registry);
  if (deprecation.deprecated) {
    // Emit warning but continue
    console.warn(
      `[WX] Canonical ${canonicalId} is deprecated (${deprecation.reason}). ` +
      `Consider using: ${deprecation.replacedBy?.join(', ')}`
    );
  }

  // Merge evidence from all members
  const allEvidenceIds = rawEntities.flatMap(e => e.evidenceIds ?? []);
  const mergedEvidenceIds = mergeEvidenceIds(...rawEntities.map(e => e.evidenceIds ?? []));

  // Choose display name by frequency + role trust
  const displayName = chooseDisplayName(rawEntities);

  // Merge properties (later entities override earlier)
  const mergedProperties: Record<string, unknown> = {};
  for (const entity of rawEntities) {
    if (entity.properties) {
      Object.assign(mergedProperties, entity.properties);
    }
  }

  const canonical: CanonicalEntity = {
    canonicalId,
    key: canonicalKey,
    type: representative.type,
    displayName,
    memberCgIds: rawEntities.map(e => e.cgId),
    evidenceIds: mergedEvidenceIds,
    artifactRole: representative.artifactRole,
    properties: Object.keys(mergedProperties).length > 0 ? mergedProperties : undefined,
  };

  return { canonical, conflict };
}

/**
 * Choose the best display name from a group of entities.
 * 
 * Priority:
 * 1. Most frequent name
 * 2. Break ties by role trust (spec > intent > implementation)
 * 3. Break ties by name length (prefer shorter)
 */
function chooseDisplayName(entities: RawEntity[]): string {
  const roleTrust: Record<string, number> = {
    spec: 4,
    intent: 3,
    implementation: 2,
    test: 1,
    config: 1,
    unknown: 0,
  };

  // Count frequencies
  const nameCounts = new Map<string, { count: number; role: string; length: number }>();
  for (const entity of entities) {
    const name = entity.name;
    const existing = nameCounts.get(name);
    if (existing) {
      existing.count++;
      // Keep highest role trust
      if ((roleTrust[entity.artifactRole] ?? 0) > (roleTrust[existing.role] ?? 0)) {
        existing.role = entity.artifactRole;
      }
    } else {
      nameCounts.set(name, {
        count: 1,
        role: entity.artifactRole,
        length: name.length,
      });
    }
  }

  // Sort by (count desc, role trust desc, length asc)
  const sorted = Array.from(nameCounts.entries()).sort((a, b) => {
    const [nameA, infoA] = a;
    const [nameB, infoB] = b;

    // Count (desc)
    if (infoB.count !== infoA.count) return infoB.count - infoA.count;
    
    // Role trust (desc)
    const trustA = roleTrust[infoA.role] ?? 0;
    const trustB = roleTrust[infoB.role] ?? 0;
    if (trustB !== trustA) return trustB - trustA;
    
    // Length (asc)
    return infoA.length - infoB.length;
  });

  return sorted[0]?.[0] ?? entities[0].name;
}

// =============================================================================
// Statement Remapping
// =============================================================================

function remapAndDeduplicateStatements(
  statements: RawStatement[],
  cgIdToCanonicalId: Map<string, string>,
  registry: WeaveRegistry
): CanonicalStatement[] {
  const statementMap = new Map<string, CanonicalStatement>();

  for (const stmt of statements) {
    // Resolve subject
    const subjectCanonicalId = cgIdToCanonicalId.get(stmt.subjectCgId);
    if (!subjectCanonicalId) {
      console.warn(`[WX] Subject cgId not found: ${stmt.subjectCgId}`);
      continue;
    }

    // Resolve object (entity or literal)
    let objectCanonicalId: string | undefined;
    let objectLiteral: string | undefined;

    if (stmt.objectCgId) {
      objectCanonicalId = cgIdToCanonicalId.get(stmt.objectCgId);
      if (!objectCanonicalId) {
        console.warn(`[WX] Object cgId not found: ${stmt.objectCgId}`);
        continue;
      }
    } else {
      objectLiteral = stmt.objectLiteral;
    }

    // Normalize predicate
    const normalizedPredicate = normalizePredicate(stmt.predicate);

    // Generate canonical statement ID
    const canonicalStmtId = generateCanonicalStatementId({
      subjectCanonicalId,
      predicate: normalizedPredicate,
      objectCanonicalId,
      objectLiteral,
    });

    // Check for existing (deduplication)
    const existing = statementMap.get(canonicalStmtId);
    if (existing) {
      // Merge evidence
      existing.evidenceIds = mergeEvidenceIds(
        existing.evidenceIds ?? [],
        stmt.evidenceIds ?? []
      );
      existing.memberStmtIds = [...(existing.memberStmtIds ?? []), stmt.id];
    } else {
      const canonical: CanonicalStatement = {
        canonicalId: canonicalStmtId,
        subjectCanonicalId,
        predicate: normalizedPredicate,
        objectCanonicalId,
        objectLiteral,
        evidenceIds: stmt.evidenceIds ?? [],
        memberStmtIds: [stmt.id],
      };
      statementMap.set(canonicalStmtId, canonical);
    }
  }

  return Array.from(statementMap.values());
}

// =============================================================================
// False Negative Detection
// =============================================================================

/**
 * Find entities that look similar but didn't merge.
 * Useful for identifying false negatives and tuning canonicalization.
 */
function findPotentialMergePairs(
  entities: RawEntity[],
  _existingGroups: Map<string, RawEntity[]>,
  sameRoleOnly: boolean
): PotentialMergePair[] {
  const pairs: PotentialMergePair[] = [];
  
  // Build normalized name index
  const byNormalizedName = new Map<string, RawEntity[]>();
  for (const entity of entities) {
    const normalized = normalizeName(entity.name);
    const existing = byNormalizedName.get(normalized) ?? [];
    existing.push(entity);
    byNormalizedName.set(normalized, existing);
  }
  
  // Find entities with same normalized name but different groups
  for (const [normalizedName, sameNameEntities] of byNormalizedName) {
    if (sameNameEntities.length < 2) continue;
    
    // Compare all pairs
    for (let i = 0; i < sameNameEntities.length; i++) {
      for (let j = i + 1; j < sameNameEntities.length; j++) {
        const a = sameNameEntities[i];
        const b = sameNameEntities[j];
        
        const keyA = buildCanonicalKey({
          role: a.artifactRole,
          type: a.type,
          name: a.name,
        });
        const keyB = buildCanonicalKey({
          role: b.artifactRole,
          type: b.type,
          name: b.name,
        });
        
        const groupKeyA = sameRoleOnly ? `${a.artifactRole}|${keyA}` : keyA;
        const groupKeyB = sameRoleOnly ? `${b.artifactRole}|${keyB}` : keyB;
        
        // They're already in same group
        if (groupKeyA === groupKeyB) continue;
        
        // Determine blocking reason
        let blockingReason: PotentialMergePair['blockingReason'] = 'different_key';
        if (a.artifactRole !== b.artifactRole) {
          blockingReason = 'different_role';
        } else if (a.type !== b.type) {
          blockingReason = 'different_type';
        }
        
        pairs.push({
          cgIdA: a.cgId,
          cgIdB: b.cgId,
          nameA: a.name,
          nameB: b.name,
          normalizedNameA: normalizeName(a.name),
          normalizedNameB: normalizeName(b.name),
          blockingReason,
          keyA,
          keyB,
          similarityScore: computeNameSimilarity(a.name, b.name),
        });
      }
    }
  }
  
  // Sort by similarity (highest first)
  pairs.sort((a, b) => (b.similarityScore ?? 0) - (a.similarityScore ?? 0));
  
  return pairs;
}

/**
 * Simple name similarity score (Jaccard on tokens).
 */
function computeNameSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\W+/).filter(t => t.length > 0));
  const tokensB = new Set(b.toLowerCase().split(/\W+/).filter(t => t.length > 0));
  
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}