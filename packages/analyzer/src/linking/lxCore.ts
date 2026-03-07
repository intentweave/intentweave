/**
 * LX-Core - Cross-Artifact Entity Linking
 * 
 * Implements the core linking algorithms for Phase 3.
 * 
 * Matching Algorithms (in priority order):
 * 1. Name matching - Direct name/alias matching (highest confidence)
 * 2. Structural matching - File/module boundary heuristics
 * 3. Profile matching - Kind-to-kind rules from profile
 * 
 * Semantic matching (embeddings) is optional and requires external provider.
 */

import type {
  Entity,
  LinkProposal,
  LinkEvidence,
  LinkPredicate,
  LinkMatchMethod,
  LxStageOutput,
} from '@intentweave/core';
import type { Profile } from '../pipeline/context.js';
import type { PxStageOutput } from '../stages/px.js';

// =============================================================================
// LX-Core Types
// =============================================================================

/**
 * Artifact entity input for linking
 */
export interface LxArtifactInput {
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Artifact role (spec, impl, prompt, etc.) */
  artifactRole: string;
  /** Entities from this artifact */
  entities: Entity[];
}

/**
 * LX-Core options
 */
export interface LxCoreOptions {
  /** Workspace key */
  workspaceKey: string;
  /** Run ID */
  runId: string;
  /** Active profile */
  profile: Profile;
  /** Minimum confidence threshold for proposals */
  minConfidence?: number;
  /** Enable name matching */
  enableNameMatching?: boolean;
  /** Enable alias matching */
  enableAliasMatching?: boolean;
  /** Enable structural matching */
  enableStructuralMatching?: boolean;
  /** Enable profile-based matching */
  enableProfileMatching?: boolean;
  /** Maximum proposals per entity pair */
  maxProposalsPerPair?: number;
}

const DEFAULT_OPTIONS: Required<Omit<LxCoreOptions, 'workspaceKey' | 'runId' | 'profile'>> = {
  minConfidence: 0.5,
  enableNameMatching: true,
  enableAliasMatching: true,
  enableStructuralMatching: true,
  enableProfileMatching: true,
  maxProposalsPerPair: 1,
};

/**
 * Matcher function signature
 */
type EntityMatcher = (
  source: Entity & { artifactId: string; artifactRole: string; filePath: string },
  target: Entity & { artifactId: string; artifactRole: string; filePath: string },
  options: LxCoreOptions
) => LinkProposal | null;

// =============================================================================
// Name Normalization
// =============================================================================

/**
 * Normalize a name for comparison
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize a name for similarity comparison
 */
function tokenize(name: string): Set<string> {
  return new Set(normalizeName(name).split(' ').filter(t => t.length > 0));
}

/**
 * Calculate Jaccard similarity between two token sets
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

// =============================================================================
// Matching Algorithms
// =============================================================================

/**
 * Generate unique proposal ID
 */
let proposalCounter = 0;
function generateProposalId(): string {
  return `lx-${Date.now()}-${proposalCounter++}`;
}

/**
 * Create a link proposal
 */
function createProposal(
  source: Entity & { artifactId: string },
  target: Entity & { artifactId: string },
  predicate: LinkPredicate,
  confidence: number,
  matchMethod: LinkMatchMethod,
  evidence: LinkEvidence[] = []
): LinkProposal {
  return {
    id: generateProposalId(),
    sourceArtifact: source.artifactId,
    sourceCgId: source.cgId,
    targetArtifact: target.artifactId,
    targetCgId: target.cgId,
    predicate,
    confidence,
    matchMethod,
    evidence,
  };
}

/**
 * Infer link predicate based on artifact roles
 */
function inferPredicate(sourceRole: string, targetRole: string): LinkPredicate {
  // Role hierarchy: prompt → spec → impl
  const roleOrder: Record<string, number> = {
    prompt: 0,
    intent: 0,
    spec: 1,
    design: 1,
    impl: 2,
    code: 2,
    test: 3,
    doc: 4,
  };

  const sourceOrder = roleOrder[sourceRole] ?? 99;
  const targetOrder = roleOrder[targetRole] ?? 99;

  if (sourceOrder < targetOrder) {
    // Higher-level → lower-level
    if (sourceRole === 'prompt' || sourceRole === 'intent') {
      return 'REFINES';
    }
    if (sourceRole === 'spec' || sourceRole === 'design') {
      return 'IMPLEMENTS';
    }
    return 'DERIVED_FROM';
  } else if (sourceOrder > targetOrder) {
    // Lower-level → higher-level
    return 'DERIVED_FROM';
  } else {
    // Same level
    return 'MAPS_TO';
  }
}

/**
 * Name Matcher - Direct name matching (highest confidence)
 * 
 * Matches entities with identical normalized names.
 */
const matchByName: EntityMatcher = (source, target, options) => {
  if (!options.enableNameMatching) return null;
  
  const sourceNorm = normalizeName(source.name);
  const targetNorm = normalizeName(target.name);
  
  if (sourceNorm === targetNorm) {
    const predicate = inferPredicate(source.artifactRole, target.artifactRole);
    return createProposal(
      source,
      target,
      predicate,
      0.95, // High confidence for exact match
      'name',
      [{
        text: `Exact name match: "${source.name}" ↔ "${target.name}"`,
        artifactId: source.artifactId,
        sourceCgId: source.cgId,
        targetCgId: target.cgId,
      }]
    );
  }
  
  // Check token similarity for near-matches
  const sourceTokens = tokenize(source.name);
  const targetTokens = tokenize(target.name);
  const similarity = jaccardSimilarity(sourceTokens, targetTokens);
  
  if (similarity >= 0.8) {
    const predicate = inferPredicate(source.artifactRole, target.artifactRole);
    return createProposal(
      source,
      target,
      predicate,
      similarity * 0.9, // Slightly lower than exact match
      'name',
      [{
        text: `Similar names (${(similarity * 100).toFixed(0)}%): "${source.name}" ↔ "${target.name}"`,
        artifactId: source.artifactId,
        sourceCgId: source.cgId,
        targetCgId: target.cgId,
      }]
    );
  }
  
  return null;
};

/**
 * Alias Matcher - Match via entity aliases
 * 
 * Matches entities where one's name matches another's alias.
 */
const matchByAlias: EntityMatcher = (source, target, options) => {
  if (!options.enableAliasMatching) return null;
  
  const sourceNorm = normalizeName(source.name);
  const targetNorm = normalizeName(target.name);
  
  // Check if source name matches any target alias
  const targetAliases = (target.aliases ?? []).map(normalizeName);
  if (targetAliases.includes(sourceNorm)) {
    const predicate = inferPredicate(source.artifactRole, target.artifactRole);
    return createProposal(
      source,
      target,
      predicate,
      0.85, // Alias match is slightly less confident than exact name
      'alias',
      [{
        text: `Alias match: "${source.name}" found as alias of "${target.name}"`,
        artifactId: target.artifactId,
        sourceCgId: source.cgId,
        targetCgId: target.cgId,
      }]
    );
  }
  
  // Check if target name matches any source alias
  const sourceAliases = (source.aliases ?? []).map(normalizeName);
  if (sourceAliases.includes(targetNorm)) {
    const predicate = inferPredicate(source.artifactRole, target.artifactRole);
    return createProposal(
      source,
      target,
      predicate,
      0.85,
      'alias',
      [{
        text: `Alias match: "${target.name}" found as alias of "${source.name}"`,
        artifactId: source.artifactId,
        sourceCgId: source.cgId,
        targetCgId: target.cgId,
      }]
    );
  }
  
  return null;
};

/**
 * Structural Matcher - File/module path heuristics
 * 
 * Matches entities from files that share structural patterns
 * (e.g., spec/auth.md ↔ src/auth.ts)
 */
const matchByStructure: EntityMatcher = (source, target, options) => {
  if (!options.enableStructuralMatching) return null;
  
  // Extract base file name without extension
  const getBaseName = (filePath: string): string => {
    const fileName = filePath.split('/').pop() ?? filePath;
    return fileName.replace(/\.[^.]+$/, '').toLowerCase();
  };
  
  const sourceBase = getBaseName(source.filePath);
  const targetBase = getBaseName(target.filePath);
  
  // Same base file name across different roles
  if (sourceBase === targetBase && source.artifactRole !== target.artifactRole) {
    // Check if entity types are compatible
    const typeCompatible = areTypesCompatible(source.type, target.type, options.profile);
    
    if (typeCompatible) {
      const predicate = inferPredicate(source.artifactRole, target.artifactRole);
      return createProposal(
        source,
        target,
        predicate,
        0.7, // Structural matching is less confident
        'structural',
        [{
          text: `Same base file: ${sourceBase} (${source.artifactRole} → ${target.artifactRole})`,
          artifactId: source.artifactId,
          sourceCgId: source.cgId,
          targetCgId: target.cgId,
        }]
      );
    }
  }
  
  return null;
};

/**
 * Check if two entity types are compatible for linking
 */
function areTypesCompatible(
  sourceType: string,
  targetType: string,
  profile: Profile
): boolean {
  // Same type is always compatible
  if (sourceType === targetType) return true;
  
  // Check profile artifact mappings for type compatibility
  const sourceMapping = profile.artifactMappings.find(m => 
    m.kinds.includes(sourceType)
  );
  const targetMapping = profile.artifactMappings.find(m => 
    m.kinds.includes(targetType)
  );
  
  // If both types are in the same mapping, they're compatible
  if (sourceMapping && targetMapping) {
    return sourceMapping.role !== targetMapping.role;
  }
  
  return false;
}

/**
 * Profile Matcher - Kind-to-kind rules from profile
 * 
 * Uses profile's artifact mappings to suggest links
 * between entities of compatible kinds across roles.
 */
const matchByProfile: EntityMatcher = (source, target, options) => {
  if (!options.enableProfileMatching) return null;
  
  const { profile } = options;
  
  // Guard against missing profile or artifactMappings
  if (!profile?.artifactMappings || profile.artifactMappings.length === 0) return null;
  
  // Look for profile rules that suggest linking
  const sourceMapping = profile.artifactMappings.find(m => 
    m.role === source.artifactRole && m.kinds.includes(source.type)
  );
  const targetMapping = profile.artifactMappings.find(m => 
    m.role === target.artifactRole && m.kinds.includes(target.type)
  );
  
  if (!sourceMapping || !targetMapping) return null;
  
  // Check if there's a natural flow between roles
  // prompt/intent → spec → impl is the expected flow
  const roleFlow: Record<string, string[]> = {
    prompt: ['spec', 'design'],
    intent: ['spec', 'design'],
    spec: ['impl', 'code'],
    design: ['impl', 'code'],
  };
  
  const expectedTargets = roleFlow[source.artifactRole] ?? [];
  if (!expectedTargets.includes(target.artifactRole)) return null;
  
  // Name similarity check for profile matching
  const sourceTokens = tokenize(source.name);
  const targetTokens = tokenize(target.name);
  const similarity = jaccardSimilarity(sourceTokens, targetTokens);
  
  if (similarity >= 0.5) {
    const predicate = inferPredicate(source.artifactRole, target.artifactRole);
    return createProposal(
      source,
      target,
      predicate,
      similarity * 0.6, // Profile matching confidence scaled by name similarity
      'profile',
      [{
        text: `Profile flow: ${source.artifactRole}:${source.type} → ${target.artifactRole}:${target.type}`,
        artifactId: source.artifactId,
        sourceCgId: source.cgId,
        targetCgId: target.cgId,
      }]
    );
  }
  
  return null;
};

// =============================================================================
// Main LX-Core Entry Point
// =============================================================================

/**
 * All matchers in priority order
 */
const MATCHERS: EntityMatcher[] = [
  matchByName,    // Highest priority
  matchByAlias,
  matchByStructure,
  matchByProfile, // Lowest priority
];

/**
 * Run LX-Core linking on all artifacts
 * 
 * @param artifacts - PX outputs from all artifacts
 * @param options - LX options
 * @returns LX stage output with link proposals
 */
export async function runLxCore(
  artifacts: LxArtifactInput[],
  options: LxCoreOptions
): Promise<LxStageOutput> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // Build entity list with artifact metadata
  const allEntities: Array<Entity & { artifactId: string; artifactRole: string; filePath: string }> = [];
  for (const artifact of artifacts) {
    for (const entity of artifact.entities) {
      allEntities.push({
        ...entity,
        artifactId: artifact.artifactId,
        artifactRole: artifact.artifactRole,
        filePath: artifact.filePath,
      });
    }
  }
  
  // OPTIMIZATION: Limit entity count for large workspaces
  const MAX_ENTITIES = 5000; // Limit to prevent memory issues
  let entitiesToProcess = allEntities;
  let wasLimited = false;
  if (allEntities.length > MAX_ENTITIES) {
    // Prioritize entities from different artifact roles for better coverage
    const byRole = new Map<string, typeof allEntities>();
    for (const e of allEntities) {
      const list = byRole.get(e.artifactRole) || [];
      list.push(e);
      byRole.set(e.artifactRole, list);
    }
    
    // Take proportionally from each role up to limit
    entitiesToProcess = [];
    const perRole = Math.floor(MAX_ENTITIES / byRole.size);
    for (const [, entities] of byRole) {
      entitiesToProcess.push(...entities.slice(0, perRole));
    }
    wasLimited = true;
  }
  
  // OPTIMIZATION: Use name-based bucketing for faster matching
  const nameIndex = new Map<string, typeof entitiesToProcess>();
  for (const entity of entitiesToProcess) {
    const normalizedName = normalizeName(entity.name);
    const list = nameIndex.get(normalizedName) || [];
    list.push(entity);
    nameIndex.set(normalizedName, list);
  }
  
  // Generate proposals using all matchers
  const proposals: LinkProposal[] = [];
  const seenPairs = new Set<string>();
  
  // OPTIMIZATION: First pass - exact name matches (fast)
  for (const [, sameNameEntities] of nameIndex) {
    if (sameNameEntities.length < 2) continue;
    
    for (let i = 0; i < sameNameEntities.length; i++) {
      for (let j = i + 1; j < sameNameEntities.length; j++) {
        const source = sameNameEntities[i];
        const target = sameNameEntities[j];
        
        // Skip same-artifact comparisons
        if (source.artifactId === target.artifactId) continue;
        
        // Create pair key to avoid duplicates
        const pairKey = [source.cgId, target.cgId].sort().join('::');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        
        // Try each matcher in priority order
        for (const matcher of MATCHERS) {
          const proposal = matcher(source, target, opts);
          if (proposal && proposal.confidence >= opts.minConfidence) {
            proposals.push(proposal);
            break; // Use first (highest priority) match
          }
        }
      }
    }
  }
  
  // OPTIMIZATION: Skip fuzzy matching for very large entity sets
  const MAX_FUZZY_ENTITIES = 1000;
  if (entitiesToProcess.length <= MAX_FUZZY_ENTITIES) {
    // Second pass - fuzzy matches (slower, only for smaller sets)
    for (let i = 0; i < entitiesToProcess.length; i++) {
      for (let j = i + 1; j < entitiesToProcess.length; j++) {
        const source = entitiesToProcess[i];
        const target = entitiesToProcess[j];
        
        // Skip same-artifact comparisons
        if (source.artifactId === target.artifactId) continue;
        
        // Create pair key to avoid duplicates
        const pairKey = [source.cgId, target.cgId].sort().join('::');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        
        // Try each matcher in priority order
        for (const matcher of MATCHERS) {
          const proposal = matcher(source, target, opts);
          if (proposal && proposal.confidence >= opts.minConfidence) {
            proposals.push(proposal);
            break; // Use first (highest priority) match
          }
        }
      }
    }
  }
  
  // Sort by confidence descending
  proposals.sort((a, b) => b.confidence - a.confidence);
  
  return {
    schemaVersion: '0.1',
    stage: 'LX',
    runId: opts.runId,
    workspaceKey: opts.workspaceKey,
    generatedAt: new Date().toISOString(),
    proposals,
    meta: {
      entitiesAnalyzed: entitiesToProcess.length,
      entitiesTotal: allEntities.length,
      entitiesLimited: wasLimited,
      proposalsGenerated: proposals.length,
      processingTimeMs: Date.now() - startTime,
    },
  };
}

/**
 * Convert PX outputs to LX inputs
 */
export function pxOutputsToLxInputs(pxOutputs: PxStageOutput[]): LxArtifactInput[] {
  return pxOutputs.map(px => ({
    artifactId: px.artifactId,
    filePath: px.artifactId, // PX doesn't have filePath, use artifactId
    artifactRole: px.artifactRole,
    entities: px.entities,
  }));
}

/**
 * Create empty LX output
 */
export function createEmptyLxOutput(
  runId: string,
  workspaceKey: string
): LxStageOutput {
  return {
    schemaVersion: '0.1',
    stage: 'LX',
    runId,
    workspaceKey,
    generatedAt: new Date().toISOString(),
    proposals: [],
    meta: {
      entitiesAnalyzed: 0,
      proposalsGenerated: 0,
      processingTimeMs: 0,
    },
  };
}
