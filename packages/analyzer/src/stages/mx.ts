/**
 * MX Stage - Materialization (Core)
 * 
 * Per-artifact stage that materializes domain-specific structures from the graph.
 * 
 * Input: cx.json (consolidated entities/statements graph)
 * Output: mx.json (same graph + materialized transition entities)
 * 
 * Responsibilities (SPEC-COMPLIANT):
 * - Materialize transition entities from TRANSITIONS_TO statements
 * - Create FROM_STATE/TO_STATE/TRIGGERS statements for transitions
 * - Bind guards and actions to transitions
 * - Preserve original entities/statements
 * 
 * NOTE: MX is where domain-specific materialization happens.
 * It creates new entities (transitions) and statements (bindings).
 */

import type { PipelineContext } from '../pipeline/context.js';
import type { Entity, Statement, Evidence } from '@intentweave/core';
import type { CxStageOutput } from './cx.js';
import { getEntities, getStatements, resolveCgId } from './cx.js';
import { assertMxPreGate } from './ref.js';

// =============================================================================
// MX Stage Types
// =============================================================================

/**
 * MX Stage Output (spec-compliant: extends graph with materialized entities)
 */
export interface MxStageOutput {
  /** JSON Schema reference */
  $schema: string;
  /** Schema version */
  schemaVersion: '0.1';
  /** Stage identifier */
  stage: 'MX';
  /** Artifact ID */
  artifactId: string;
  /** Processing timestamp */
  processedAt: string;
  
  /** All entities (original + materialized transitions) */
  entities: Entity[];
  /** All statements (original + transition bindings) */
  statements: Statement[];
  /** Evidence preserved */
  evidence: Evidence[];
  
  /** IDs of entities not bound to any transition */
  orphanEntityIds: string[];
  
  /** Processing metadata */
  meta: {
    /** Total entities after materialization */
    entityCount: number;
    /** Entities added by materialization */
    materializedCount: number;
    /** Statements after materialization */
    statementCount: number;
    /** Statements added by materialization */
    bindingCount: number;
    /** Resource entity inferred from states (when LLM missed it) */
    inferredResource?: {
      /** Reason for inference */
      reason: 'inferred-from-states' | 'inferred-from-cgid-path';
      /** Inferred resource name */
      inferredName: string;
      /** Sample source state cgIds (truncated if >5) */
      sourceStateCgIds: string[];
    };
    /** HAS_STATE statements synthesized by single-resource fallback */
    synthesizedHasState?: {
      /** Number of synthesized statements */
      count: number;
      /** Reason for synthesis */
      reason: 'single-resource-fallback';
      /** The resource cgId used for binding */
      resourceCgId: string;
      /** List of state cgIds that were bound (truncated if >10) */
      stateCgIds: string[];
    };
    /** Orphan entities (not participating in transitions) */
    orphanCount: number;
    /** Processing time in ms */
    processingTimeMs: number;
    /** Unresolved reference stats (from REF pre-gate) */
    unresolvedRefs?: {
      /** Total unresolved references */
      total: number;
      /** Unresolved by predicate */
      byPredicate: Record<string, number>;
    };
    /** Canonical semantics validation (post-MX) */
    canonicalValidation?: {
      /** Whether all invariants passed */
      valid: boolean;
      /** Number of warnings */
      warningCount: number;
      /** Validation warnings (semantic direction issues) */
      warnings: string[];
    };
    /** Number of TRANSITIONS_TO statements lowered to canonical form */
    loweredTransitionsTo?: number;
    /** Number of TRIGGERED_BY statements inverted to TRIGGERS */
    invertedTriggeredBy?: number;
  };
}

/**
 * MX Stage Input
 */
export interface MxStageInput {
  /** Artifact ID */
  artifactId: string;
  /** CX stage output to materialize */
  cxOutput: CxStageOutput;
}

/**
 * MX Stage Options
 */
export interface MxStageOptions {
  /** Minimum confidence for materializing a transition */
  minTransitionConfidence?: number;
  /** Whether to infer transitions from entity kinds */
  inferTransitions?: boolean;
  /** Whether to track orphan entities */
  trackOrphans?: boolean;
}

const DEFAULT_OPTIONS: Required<MxStageOptions> = {
  minTransitionConfidence: 0.3,
  inferTransitions: true,
  trackOrphans: true,
};

// =============================================================================
// Transition Predicates (domain-specific)
// =============================================================================

const TRANSITION_PREDICATES = {
  TRANSITIONS_TO: 'TRANSITIONS_TO',
  FROM_STATE: 'FROM_STATE',
  TO_STATE: 'TO_STATE',
  TRIGGERS: 'TRIGGERS',
  TRIGGERED_BY: 'TRIGGERED_BY',  // Extracted predicate - inverted to TRIGGERS
  GUARDS: 'GUARDS',
  EXECUTES: 'EXECUTES',
  HAS_STATE: 'HAS_STATE',
} as const;

// =============================================================================
// State Prefixing
// =============================================================================

/**
 * Result of resource inference for structured meta reporting
 */
interface ResourceInferenceResult {
  /** Inferred resource entity (undefined if no inference needed) */
  entity?: Entity;
  /** Metadata for MX output */
  meta?: {
    reason: 'inferred-from-states' | 'inferred-from-cgid-path';
    inferredName: string;
    sourceStateCgIds: string[];
  };
}

/**
 * Infer a resource entity when states exist but no resource was extracted
 * 
 * This is a deterministic fallback for when the LLM fails to extract a resource entity.
 * We attempt to infer the resource name from:
 * 1. State cgId paths (e.g., "state/document/submitted" → "document")
 * 2. Common patterns in state names
 * 
 * @returns Inferred resource entity or undefined if no inference possible
 */
function inferResourceFromStates(
  entities: Entity[],
  artifactId: string
): ResourceInferenceResult {
  const resources = entities.filter(e => e.type === 'resource');
  const states = entities.filter(e => e.type === 'state');
  
  // Only infer if no resources exist but states do
  if (resources.length > 0 || states.length === 0) {
    return {};
  }
  
  // Try to infer resource name from state cgId paths
  // Pattern: "state/resource/stateName" or "state/stateName"
  const resourceCandidates = new Map<string, number>();
  
  for (const state of states) {
    const cgIdParts = state.cgId.split('/');
    // Look for pattern like: prefix|model|kg|state/document/submitted
    // or: prefix|model|kg|state/submitted
    const stateIdx = cgIdParts.findIndex(p => p === 'state' || p.startsWith('state'));
    
    if (stateIdx >= 0 && cgIdParts.length > stateIdx + 2) {
      // Found "state/resource/stateName" pattern
      const resourceName = cgIdParts[stateIdx + 1].toLowerCase();
      // Skip if it looks like a state name (common suffixes)
      if (!isLikelyStateName(resourceName)) {
        resourceCandidates.set(resourceName, (resourceCandidates.get(resourceName) ?? 0) + 1);
      }
    }
  }
  
  // Pick the most common resource candidate
  let bestCandidate: string | undefined;
  let bestCount = 0;
  for (const [name, count] of resourceCandidates) {
    if (count > bestCount) {
      bestCandidate = name;
      bestCount = count;
    }
  }
  
  if (!bestCandidate) {
    // Fallback: try to infer from artifact context
    // Extract potential resource from artifactId or use generic "entity"
    const artifactParts = artifactId.split(/[-_/]/);
    const potentialResource = artifactParts.find(p => 
      p.length > 2 && !isLikelyStateName(p) && !['ws', 'model', 'kg', 'prompt', 'run'].includes(p.toLowerCase())
    );
    
    if (potentialResource) {
      bestCandidate = potentialResource.toLowerCase();
    }
  }
  
  if (!bestCandidate) {
    // Last resort: use generic "entity" as resource name
    // This ensures states get bound to something for materialization
    bestCandidate = 'entity';
    console.log('[MX] Using generic "entity" as inferred resource name (no context available)');
  }
  
  // Create synthetic resource entity
  const resourceCgId = `${artifactId.split('|')[0]}|model|kg|resource/${bestCandidate}`;
  
  const inferredResource: Entity = {
    cgId: resourceCgId,
    name: bestCandidate,
    type: 'resource',
    source: 'heuristic', // Inferred by MX fallback
    confidence: 0.5, // Lower confidence for inferred entities
    evidence: [],
    labels: ['Staging'],
    state: 'new',
    props: {
      _inferred: true,
      _inferredReason: 'missing-resource-fallback',
      _inferredAt: 'MX',
      _description: 'Resource inferred from state entities',
    },
  };
  
  console.log(`[MX] Inferred resource '${bestCandidate}' from ${states.length} state entities`);
  
  return {
    entity: inferredResource,
    meta: {
      reason: 'inferred-from-states',
      inferredName: bestCandidate,
      sourceStateCgIds: states.slice(0, 5).map(s => s.cgId),
    },
  };
}

/**
 * Check if a string looks like a state name rather than a resource name
 */
function isLikelyStateName(name: string): boolean {
  const statePatterns = [
    'pending', 'active', 'inactive', 'approved', 'rejected', 'archived',
    'submitted', 'draft', 'published', 'deleted', 'cancelled', 'completed',
    'open', 'closed', 'new', 'review', 'processing', 'shipped', 'delivered',
    'state', 'status', 'under-review', 'in-progress', 'on-hold',
  ];
  return statePatterns.includes(name.toLowerCase());
}

/**
 * Check if a state name looks like a terminal state (end state)
 * Terminal states typically cannot transition to other states
 */
function isTerminalState(name: string): boolean {
  const terminalPatterns = [
    'archived', 'deleted', 'cancelled', 'completed', 'closed',
    'rejected', 'expired', 'terminated', 'finalized', 'done',
  ];
  const normalizedName = name.toLowerCase().replace(/[^a-z]/g, '');
  return terminalPatterns.some(p => normalizedName.includes(p));
}

/**
 * Result of HAS_STATE synthesis for structured meta reporting
 */
interface SynthesisResult {
  /** Synthesized statements */
  statements: Statement[];
  /** Metadata for MX output (undefined if no synthesis) */
  meta?: {
    count: number;
    reason: 'single-resource-fallback';
    resourceCgId: string;
    stateCgIds: string[];
  };
}

/**
 * Synthesize HAS_STATE statements when exactly one resource exists
 * 
 * This is a deterministic fallback for when the LLM fails to extract HAS_STATE
 * relationships. If there's exactly one resource entity and state entities
 * without explicit HAS_STATE bindings, we synthesize them with moderate confidence.
 * 
 * Guards:
 * - Exactly one resource must exist in entities
 * - Resource must be the dominant entity (appears in statements or is sole resource)
 * - Only unbound states are synthesized
 * 
 * @returns Statements and structured metadata for reporting
 */
function synthesizeHasStateStatements(
  entities: Entity[],
  statements: Statement[],
  artifactId: string
): SynthesisResult {
  const resources = entities.filter(e => e.type === 'resource');
  const states = entities.filter(e => e.type === 'state');
  
  // Only synthesize if exactly one resource exists
  if (resources.length !== 1 || states.length === 0) {
    return { statements: [] };
  }
  
  const resource = resources[0];
  
  // Additional guard: verify resource is referenced in statements OR is sole resource
  // (sole resource case is already covered by resources.length === 1)
  const resourceReferencedInStatements = statements.some(
    s => s.subjectCgId === resource.cgId || s.objectCgId === resource.cgId
  );
  
  // If resource is not referenced anywhere and there are other entities, be cautious
  if (!resourceReferencedInStatements && entities.length > states.length + 1) {
    console.warn(`[MX] Skipping HAS_STATE synthesis: resource '${resource.name}' not referenced in statements`);
    return { statements: [] };
  }
  
  // Check which states already have HAS_STATE bindings
  const existingHasStateStmts = statements.filter(
    s => s.predicate === TRANSITION_PREDICATES.HAS_STATE
  );
  const boundStateCgIds = new Set(
    existingHasStateStmts
      .map(s => s.objectCgId?.toLowerCase())
      .filter((cgId): cgId is string => !!cgId)
  );
  
  // Find states without HAS_STATE bindings
  const unboundStates = states.filter(
    s => !boundStateCgIds.has(s.cgId.toLowerCase())
  );
  
  if (unboundStates.length === 0) {
    return { statements: [] }; // All states already bound
  }
  
  console.log(`[MX] Synthesizing ${unboundStates.length} HAS_STATE statements (single resource fallback: ${resource.name})`);
  
  // Synthesize HAS_STATE statements for unbound states
  const synthesized = unboundStates.map((state): Statement => ({
    subjectCgId: resource.cgId,
    predicate: TRANSITION_PREDICATES.HAS_STATE,
    objectCgId: state.cgId,
    confidence: 0.6, // Moderate confidence for synthesized relationships
    evidence: [], // No LLM evidence for synthesized statements
    labels: ['Staging'],
    state: 'new',
    metadata: {
      inference: 'mx.fallback', // Marker for downstream to filter/treat differently
      _synthesized: true,
      _synthesizedReason: 'single-resource-fallback',
      _synthesizedAt: 'MX',
      _resourceCgId: resource.cgId,
    },
  }));
  
  return {
    statements: synthesized,
    meta: {
      count: synthesized.length,
      reason: 'single-resource-fallback',
      resourceCgId: resource.cgId,
      // Truncate to 10 for readability in meta
      stateCgIds: unboundStates.slice(0, 10).map(s => s.cgId),
    },
  };
}

/**
 * Find the resource associated with a state entity via HAS_STATE statements
 */
function findAssociatedResource(
  stateEntity: Entity,
  statements: Statement[],
  entities: Entity[]
): Entity | undefined {
  // Normalize cgId for comparison (case-insensitive)
  const normalizedStateCgId = stateEntity.cgId.toLowerCase();
  
  // Look for HAS_STATE statement where this state is the object
  const hasStateStmts = statements.filter(
    s => s.predicate === TRANSITION_PREDICATES.HAS_STATE
  );
  
  const hasStateStmt = hasStateStmts.find(
    s => s.objectCgId?.toLowerCase() === normalizedStateCgId
  );
  
  if (hasStateStmt) {
    // Find resource by cgId (also case-insensitive)
    const normalizedSubjectCgId = hasStateStmt.subjectCgId.toLowerCase();
    const resource = entities.find(e => e.cgId.toLowerCase() === normalizedSubjectCgId);
    if (resource) return resource;
  }
  
  // Fallback: look for resource in cgId path (e.g., "state/document/submitted" → "document")
  const cgIdParts = stateEntity.cgId.split('/');
  if (cgIdParts.length >= 2) {
    const potentialResourceName = cgIdParts[cgIdParts.length - 2].toLowerCase();
    const resource = entities.find(e => e.type === 'resource' && e.name.toLowerCase() === potentialResourceName);
    if (resource) return resource;
  }
  
  // Final fallback: find any resource entity (only if there's exactly one)
  const resources = entities.filter(e => e.type === 'resource');
  return resources.length === 1 ? resources[0] : undefined;
}

/**
 * Prefix state entities with their associated resource name
 * 
 * Transforms: "submitted" → "state-document-submitted"
 * 
 * This prevents collisions between different resources with same state names
 * and provides clearer naming in the graph.
 * 
 * @returns Map of old cgId → new cgId for updating statements
 */
function prefixStatesWithResource(
  entities: Entity[],
  statements: Statement[]
): { entities: Entity[]; cgIdRemap: Map<string, string> } {
  const cgIdRemap = new Map<string, string>();
  
  const updatedEntities = entities.map(entity => {
    if (entity.type !== 'state') {
      return entity;
    }
    
    // Skip if already prefixed
    if (entity.name.startsWith('state-')) {
      return entity;
    }
    
    const resource = findAssociatedResource(entity, statements, entities);
    if (!resource) {
      return entity;
    }
    
    const newName = `state-${resource.name}-${entity.name}`;
    
    // Build new cgId with prefixed name
    const oldCgId = entity.cgId;
    const cgIdBase = oldCgId.substring(0, oldCgId.lastIndexOf('/') + 1);
    const newCgId = `${cgIdBase}${newName}`;
    
    cgIdRemap.set(oldCgId, newCgId);
    
    return {
      ...entity,
      cgId: newCgId,
      name: newName,
      props: {
        ...entity.props,
        _originalCgId: oldCgId,
        _originalName: entity.name,
      },
    };
  });
  
  return { entities: updatedEntities, cgIdRemap };
}

/**
 * Update statement cgIds based on remap
 */
function remapStatementCgIds(
  statements: Statement[],
  cgIdRemap: Map<string, string>
): Statement[] {
  if (cgIdRemap.size === 0) return statements;
  
  return statements.map(stmt => {
    const newSubject = cgIdRemap.get(stmt.subjectCgId) ?? stmt.subjectCgId;
    const newObject = stmt.objectCgId ? (cgIdRemap.get(stmt.objectCgId) ?? stmt.objectCgId) : stmt.objectCgId;
    
    if (newSubject === stmt.subjectCgId && newObject === stmt.objectCgId) {
      return stmt;
    }
    
    return {
      ...stmt,
      subjectCgId: newSubject,
      objectCgId: newObject,
    };
  });
}

// =============================================================================
// Entity Lookup Helpers
// =============================================================================

/**
 * Find entity by cgId
 */
function findEntity(cgId: string, entities: Entity[]): Entity | undefined {
  return entities.find(e => e.cgId === cgId);
}

/**
 * Find entities by kind/type
 */
function findEntitiesByType(type: string, entities: Entity[]): Entity[] {
  return entities.filter(e => e.type === type || e.props?.inferredKind === type);
}

/**
 * Generate unique cgId for materialized transition entity.
 * 
 * Uses resource identity to avoid collisions across different workflows.
 * Format: <artifactId>|model|kg|transition/<resource>/<from>-><to>[@<trigger>]
 * 
 * @example
 *   buildTransitionCgId('doc1', 'Document', 'Draft', 'Approved', 'approve')
 *   // => 'doc1|model|kg|transition/Document/Draft->Approved@approve'
 */
function buildTransitionCgId(
  artifactId: string,
  resourceName: string,
  fromStateName: string,
  toStateName: string,
  triggerName?: string
): string {
  // Sanitize names for cgId (replace spaces, special chars)
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  const resource = sanitize(resourceName || 'unknown');
  const from = sanitize(fromStateName);
  const to = sanitize(toStateName);
  const trigger = triggerName ? `@${sanitize(triggerName)}` : '';
  
  return `${artifactId}|model|kg|transition/${resource}/${from}->${to}${trigger}`;
}

/**
 * Legacy index-based cgId generator (fallback when resource unknown)
 * @deprecated Use buildTransitionCgId with resource identity instead
 */
function generateTransitionCgIdFallback(artifactId: string, index: number): string {
  return `${artifactId}:transition:${index}`;
}

// =============================================================================
// Transition Materialization
// =============================================================================

/**
 * Materialize transitions from TRANSITIONS_TO statements.
 * 
 * Implements canonical state machine semantics:
 * - FROM_STATE: state → transition (source state points to transition)
 * - TO_STATE: transition → state (transition points to target state)
 * - TRIGGERS: event → transition (event triggers transition)
 * 
 * @returns Materialized entities/statements + list of lowered TRANSITIONS_TO statement IDs
 */
function materializeFromStatements(
  statements: Statement[],
  entities: Entity[],
  artifactId: string,
  minConfidence: number
): { entities: Entity[]; statements: Statement[]; loweredStatementIds: Set<string> } {
  const newEntities: Entity[] = [];
  const newStatements: Statement[] = [];
  const loweredStatementIds = new Set<string>();
  
  // Find TRANSITIONS_TO statements (to be lowered)
  const transitionStmts = statements.filter(
    s => s.predicate === TRANSITION_PREDICATES.TRANSITIONS_TO
  );
  
  for (const stmt of transitionStmts) {
    if (stmt.confidence < minConfidence) continue;
    
    const fromEntity = findEntity(stmt.subjectCgId, entities);
    const toEntity = stmt.objectCgId ? findEntity(stmt.objectCgId, entities) : undefined;
    
    if (!fromEntity || !toEntity) continue;
    
    // Check if subject is an action (action TRANSITIONS_TO state pattern)
    // In this case, we need to infer the source state(s)
    const isActionTriggered = fromEntity.type === 'action';
    
    // Find resource for this transition (for cgId construction)
    // First try from the subject, then from the target state
    let resource = findAssociatedResource(fromEntity, statements, entities);
    if (!resource && toEntity.type === 'state') {
      // For action-triggered transitions, find resource from the target state
      // Look for what resource HAS_STATE the target
      const hasStateForTarget = statements.find(
        s => s.predicate === TRANSITION_PREDICATES.HAS_STATE &&
             s.objectCgId === toEntity.cgId
      );
      if (hasStateForTarget) {
        resource = findEntity(hasStateForTarget.subjectCgId, entities) ?? undefined;
      }
    }
    const resourceName = resource?.name ?? 'unknown';
    
    // Look for TRIGGERS statements that target the "from" or "to" state
    // (legacy pattern: event TRIGGERS state, meaning "triggers transition to that state")
    const triggerStmts = statements.filter(
      s => s.predicate === TRANSITION_PREDICATES.TRIGGERS &&
           (s.objectCgId === stmt.subjectCgId || s.objectCgId === stmt.objectCgId)
    );
    const triggerName = triggerStmts.length > 0 
      ? findEntity(triggerStmts[0].subjectCgId, entities)?.name 
      : undefined;
    
    // For action-triggered transitions, find potential source states
    // These are states that belong to the same resource and can lead to the target
    let sourceStates: Entity[] = [];
    if (isActionTriggered && resource) {
      // Find all states for this resource via HAS_STATE
      const hasStateStmts = statements.filter(
        s => s.predicate === TRANSITION_PREDICATES.HAS_STATE &&
             s.subjectCgId === resource.cgId &&
             s.objectCgId // Ensure objectCgId exists
      );
      sourceStates = hasStateStmts
        .map(s => findEntity(s.objectCgId!, entities))
        .filter((e): e is Entity => 
          e !== undefined && 
          e.cgId !== toEntity.cgId && // Exclude target state
          !isTerminalState(e.name) // Exclude terminal states
        );
    }
    
    // Create transition entity with resource-aware cgId
    const transitionCgId = buildTransitionCgId(
      artifactId,
      resourceName,
      isActionTriggered && sourceStates.length > 0 ? sourceStates[0].name : fromEntity.name,
      toEntity.name,
      isActionTriggered ? fromEntity.name : triggerName
    );
    
    const transitionEntity: Entity = {
      cgId: transitionCgId,
      type: 'transition',
      name: isActionTriggered 
        ? `${fromEntity.name} → ${toEntity.name}` 
        : `${fromEntity.name} → ${toEntity.name}`,
      labels: ['Staging'],
      evidence: stmt.evidence,
      confidence: stmt.confidence,
      source: 'heuristic',
      state: 'new',
      props: {
        fromStateCgId: isActionTriggered && sourceStates.length > 0 
          ? sourceStates[0].cgId 
          : fromEntity.cgId,
        toStateCgId: toEntity.cgId,
        resourceCgId: resource?.cgId,
        resourceName,
        originalStatementId: stmt.id,
        actionTriggered: isActionTriggered,
        triggerActionCgId: isActionTriggered ? fromEntity.cgId : undefined,
      },
    };
    
    newEntities.push(transitionEntity);
    
    // Track this TRANSITIONS_TO statement for filtering (lowering)
    if (stmt.id) {
      loweredStatementIds.add(stmt.id);
    }
    
    // Create canonical binding statements:
    // source_state --FROM_STATE--> Transition --TO_STATE--> target_state
    
    // FROM_STATE: state → transition (source state points to transition)
    if (isActionTriggered && sourceStates.length > 0) {
      // For action-triggered transitions, create FROM_STATE for each inferred source state
      for (const sourceState of sourceStates) {
        newStatements.push({
          subjectCgId: sourceState.cgId,      // Source state is subject
          predicate: TRANSITION_PREDICATES.FROM_STATE,
          objectCgId: transitionCgId,         // Transition is object
          confidence: stmt.confidence * 0.8,  // Slightly lower confidence for inferred
          evidence: stmt.evidence,
          labels: ['Staging'],
          state: 'new',
          _inferred: true,
          _inferredReason: 'action-triggered-source-state',
        } as Statement);
      }
      
      // Also create TRIGGERS: action → transition
      newStatements.push({
        subjectCgId: fromEntity.cgId,         // Action is subject
        predicate: TRANSITION_PREDICATES.TRIGGERS,
        objectCgId: transitionCgId,           // Transition is object
        confidence: stmt.confidence,
        evidence: stmt.evidence,
        labels: ['Staging'],
        state: 'new',
      });
    } else if (!isActionTriggered) {
      // Normal state-to-state transition
      newStatements.push({
        subjectCgId: fromEntity.cgId,         // Source state is subject
        predicate: TRANSITION_PREDICATES.FROM_STATE,
        objectCgId: transitionCgId,           // Transition is object
        confidence: stmt.confidence,
        evidence: stmt.evidence,
        labels: ['Staging'],
        state: 'new',
      });
    }
    // Note: If action-triggered but no source states found, we skip FROM_STATE
    // This will be flagged by completeness-010 as expected (missing source state)
    
    // TO_STATE: transition → state (transition points to arrival state)
    newStatements.push({
      subjectCgId: transitionCgId,          // Transition is subject
      predicate: TRANSITION_PREDICATES.TO_STATE,
      objectCgId: toEntity.cgId,            // State is object
      confidence: stmt.confidence,
      evidence: stmt.evidence,
      labels: ['Staging'],
      state: 'new',
    });
    
    // TRIGGERS: event → transition (canonical direction) - for explicit triggers
    for (const trigger of triggerStmts) {
      newStatements.push({
        subjectCgId: trigger.subjectCgId,   // Event is subject
        predicate: TRANSITION_PREDICATES.TRIGGERS,
        objectCgId: transitionCgId,         // Transition is object
        confidence: trigger.confidence,
        evidence: trigger.evidence,
        labels: ['Staging'],
        state: 'new',
      });
    }
  }
  
  return { entities: newEntities, statements: newStatements, loweredStatementIds };
}

/**
 * Infer transitions from entity kinds (when no explicit TRANSITIONS_TO)
 * 
 * Uses canonical state machine semantics:
 * - FROM_STATE: state → transition (source state points to transition)
 * - TO_STATE: transition → state (transition points to target state)
 * - TRIGGERS: event → transition (event triggers transition)
 */
function inferTransitionsFromEntities(
  entities: Entity[],
  existingStatements: Statement[],
  artifactId: string
): { entities: Entity[]; statements: Statement[] } {
  const newEntities: Entity[] = [];
  const newStatements: Statement[] = [];
  
  // Find state entities
  const states = findEntitiesByType('state', entities);
  const events = findEntitiesByType('event', entities);
  
  // Check if we already have explicit transitions
  const hasExplicitTransitions = existingStatements.some(
    s => s.predicate === TRANSITION_PREDICATES.TRANSITIONS_TO
  );
  
  if (hasExplicitTransitions || states.length < 2) {
    return { entities: newEntities, statements: newStatements };
  }
  
  // Find resource for cgId construction
  const resources = entities.filter(e => e.type === 'resource');
  const resourceName = resources.length === 1 ? resources[0].name : 'unknown';
  
  // Infer transitions from events that mention states
  for (const event of events) {
    const eventText = [
      event.name,
      JSON.stringify(event.props ?? {}),
    ].join(' ').toLowerCase();
    
    // Find states mentioned in event
    const mentionedStates = states.filter(s => 
      eventText.includes(s.name.toLowerCase())
    );
    
    if (mentionedStates.length >= 2) {
      const [fromState, toState] = mentionedStates;
      
      // Use resource-aware cgId
      const transitionCgId = buildTransitionCgId(
        artifactId,
        resourceName,
        fromState.name,
        toState.name,
        event.name  // Include triggering event in cgId
      );
      
      const transitionEntity: Entity = {
        cgId: transitionCgId,
        type: 'transition',
        name: `${fromState.name} → ${toState.name} (inferred)`,
        labels: ['Staging'],
        evidence: event.evidence,
        confidence: 0.4, // Lower confidence for inferred
        source: 'heuristic',
        state: 'new',
        props: {
          fromStateCgId: fromState.cgId,
          toStateCgId: toState.cgId,
          eventCgId: event.cgId,
          resourceName,
          inferred: true,
        },
      };
      
      newEntities.push(transitionEntity);
      
      // Add canonical binding statements:
      // source_state --FROM_STATE--> Transition --TO_STATE--> target_state
      
      // FROM_STATE: state → transition (source state points to transition)
      newStatements.push({
        subjectCgId: fromState.cgId,        // Source state is subject
        predicate: TRANSITION_PREDICATES.FROM_STATE,
        objectCgId: transitionCgId,         // Transition is object
        confidence: 0.4,
        evidence: event.evidence,
        labels: ['Staging'],
        state: 'new',
      });
      
      // TO_STATE: transition → state (transition points to arrival state)
      newStatements.push({
        subjectCgId: transitionCgId,        // Transition is subject
        predicate: TRANSITION_PREDICATES.TO_STATE,
        objectCgId: toState.cgId,           // State is object
        confidence: 0.4,
        evidence: event.evidence,
        labels: ['Staging'],
        state: 'new',
      });
      
      // TRIGGERS: event → transition (canonical direction)
      newStatements.push({
        subjectCgId: event.cgId,            // Event is subject
        predicate: TRANSITION_PREDICATES.TRIGGERS,
        objectCgId: transitionCgId,         // Transition is object
        confidence: 0.4,
        evidence: event.evidence,
        labels: ['Staging'],
        state: 'new',
      });
    }
  }
  
  return { entities: newEntities, statements: newStatements };
}

/**
 * Find orphan entities (not participating in any transition)
 */
function findOrphanEntities(
  entities: Entity[],
  statements: Statement[]
): string[] {
  const participatingCgIds = new Set<string>();
  
  // Collect all cgIds that participate in transition-related statements
  const transitionPredicates = Object.values(TRANSITION_PREDICATES);
  
  for (const stmt of statements) {
    if (transitionPredicates.includes(stmt.predicate as any)) {
      participatingCgIds.add(stmt.subjectCgId);
      if (stmt.objectCgId) participatingCgIds.add(stmt.objectCgId);
    }
  }
  
  // Also include transition entities themselves
  for (const entity of entities) {
    if (entity.type === 'transition') {
      participatingCgIds.add(entity.cgId);
    }
  }
  
  // Find entities not participating
  return entities
    .filter(e => !participatingCgIds.has(e.cgId) && e.type !== 'transition')
    .map(e => e.cgId);
}

/**
 * Validate canonical state machine invariants post-MX.
 * 
 * Checks:
 * 1. FROM_STATE: subject must be state, object must be transition
 * 2. TO_STATE: subject must be transition, object must be state
 * 3. TRIGGERS: subject must be event/action, object must be transition
 * 4. No remaining TRANSITIONS_TO statements (should all be lowered)
 * 5. No remaining TRIGGERED_BY statements (should all be inverted)
 * 
 * @returns Validation result with warnings (not errors - we log but don't fail)
 */
function validateCanonicalSemantics(
  entities: Entity[],
  statements: Statement[]
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const entityByCgId = new Map(entities.map(e => [e.cgId, e]));
  
  for (const stmt of statements) {
    const subject = entityByCgId.get(stmt.subjectCgId);
    const object = stmt.objectCgId ? entityByCgId.get(stmt.objectCgId) : undefined;
    
    switch (stmt.predicate) {
      case TRANSITION_PREDICATES.FROM_STATE:
        // FROM_STATE: state → transition (subject=state, object=transition)
        if (subject && subject.type !== 'state') {
          // Check for projection metadata (entry/exit projections are exempt)
          const isProjection = subject.props?._projection === true;
          if (!isProjection) {
            warnings.push(
              `FROM_STATE subject should be state, got ${subject.type}: ${stmt.subjectCgId}`
            );
          }
        }
        if (object && object.type !== 'transition') {
          warnings.push(
            `FROM_STATE object should be transition, got ${object.type}: ${stmt.objectCgId}`
          );
        }
        break;
        
      case TRANSITION_PREDICATES.TO_STATE:
        // TO_STATE: transition → state (subject=transition, object=state)
        if (subject && subject.type !== 'transition') {
          warnings.push(
            `TO_STATE subject should be transition, got ${subject.type}: ${stmt.subjectCgId}`
          );
        }
        if (object && object.type !== 'state') {
          // Check for projection metadata
          const isProjection = object.props?._projection === true;
          if (!isProjection) {
            warnings.push(
              `TO_STATE object should be state, got ${object.type}: ${stmt.objectCgId}`
            );
          }
        }
        break;
        
      case TRANSITION_PREDICATES.TRIGGERS:
        // TRIGGERS: event → transition (subject=event/action, object=transition)
        if (subject && !['event', 'action', 'command'].includes(subject.type)) {
          warnings.push(
            `TRIGGERS subject should be event/action, got ${subject.type}: ${stmt.subjectCgId}`
          );
        }
        if (object && object.type !== 'transition') {
          warnings.push(
            `TRIGGERS object should be transition, got ${object.type}: ${stmt.objectCgId}`
          );
        }
        break;
        
      case TRANSITION_PREDICATES.TRANSITIONS_TO:
        // Should have been lowered
        warnings.push(
          `Unexpected TRANSITIONS_TO statement not lowered: ${stmt.subjectCgId} → ${stmt.objectCgId}`
        );
        break;
        
      case TRANSITION_PREDICATES.TRIGGERED_BY:
        // Should have been inverted
        warnings.push(
          `Unexpected TRIGGERED_BY statement not inverted: ${stmt.subjectCgId} ← ${stmt.objectCgId}`
        );
        break;
    }
  }
  
  return { valid: warnings.length === 0, warnings };
}

// =============================================================================
// MX Stage Entry Point
// =============================================================================

/**
 * Run MX stage on CX output
 * 
 * Materializes domain-specific structures (transitions) from the graph.
 * 
 * Pre-gate: Checks for unresolved references and reports them in meta.
 * This prevents silent "0 materialized" failures.
 */
export async function runMxStage(
  input: MxStageInput,
  ctx: PipelineContext,
  options: MxStageOptions = {}
): Promise<MxStageOutput> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  const { artifactId, cxOutput } = input;
  const cxEntities = getEntities(cxOutput);
  const cxStatements = getStatements(cxOutput);
  
  // Pre-gate: Check for unresolved references
  const preGate = assertMxPreGate(cxEntities, cxStatements);
  if (!preGate.valid) {
    console.warn('[MX] Pre-gate detected unresolved references', {
      total: preGate.unresolvedStats.total,
      byPredicate: preGate.unresolvedStats.byPredicate,
    });
  }
  
  // Step -1: Infer resource entity if none exists but states do
  // This is a deterministic fallback when LLM fails to extract the resource
  const resourceInference = inferResourceFromStates(cxEntities, artifactId);
  const entitiesWithResource = resourceInference.entity 
    ? [...cxEntities, resourceInference.entity]
    : cxEntities;
  
  // Step 0: Synthesize HAS_STATE statements if exactly one resource exists
  // This is a deterministic fallback when LLM fails to extract HAS_STATE
  const synthesisResult = synthesizeHasStateStatements(entitiesWithResource, cxStatements, artifactId);
  const statementsWithHasState = [...cxStatements, ...synthesisResult.statements];
  
  // Step 1: Prefix state entities with their associated resource
  const prefixed = prefixStatesWithResource(entitiesWithResource, statementsWithHasState);
  const prefixedStatements = remapStatementCgIds(statementsWithHasState, prefixed.cgIdRemap);
  
  // Log prefixing stats
  if (prefixed.cgIdRemap.size > 0) {
    console.log(`[MX] Prefixed ${prefixed.cgIdRemap.size} state entities with resource names`);
  }
  
  // Start with prefixed entities and statements
  let allEntities = [...prefixed.entities];
  let allStatements = [...prefixedStatements];
  
  // Step 2: Materialize transitions from explicit TRANSITIONS_TO statements
  const explicit = materializeFromStatements(
    prefixedStatements,
    prefixed.entities,
    artifactId,
    opts.minTransitionConfidence
  );
  
  allEntities.push(...explicit.entities);
  allStatements.push(...explicit.statements);
  
  // Step 2b: Filter out lowered TRANSITIONS_TO statements (canonical lowering)
  // After materialization, TRANSITIONS_TO becomes FROM_STATE + TO_STATE + transition entity
  if (explicit.loweredStatementIds.size > 0) {
    allStatements = allStatements.filter(
      s => s.predicate !== TRANSITION_PREDICATES.TRANSITIONS_TO ||
           !s.id ||
           !explicit.loweredStatementIds.has(s.id)
    );
    console.log(`[MX] Lowered ${explicit.loweredStatementIds.size} TRANSITIONS_TO statements to canonical form`);
  }
  
  // Step 2c: Invert TRIGGERED_BY statements to canonical TRIGGERS
  // TRIGGERED_BY: transition TRIGGERED_BY event → TRIGGERS: event TRIGGERS transition
  const triggeredByStmts = allStatements.filter(
    s => s.predicate === TRANSITION_PREDICATES.TRIGGERED_BY
  );
  if (triggeredByStmts.length > 0) {
    const invertedTriggers: Statement[] = [];
    const triggeredByIds = new Set<string>();
    
    for (const stmt of triggeredByStmts) {
      if (stmt.objectCgId) {
        invertedTriggers.push({
          subjectCgId: stmt.objectCgId,        // Event becomes subject
          predicate: TRANSITION_PREDICATES.TRIGGERS,
          objectCgId: stmt.subjectCgId,        // Transition becomes object
          confidence: stmt.confidence,
          evidence: stmt.evidence,
          labels: stmt.labels,
          state: 'new',
        });
        if (stmt.id) triggeredByIds.add(stmt.id);
      }
    }
    
    // Remove original TRIGGERED_BY statements
    allStatements = allStatements.filter(
      s => s.predicate !== TRANSITION_PREDICATES.TRIGGERED_BY ||
           !s.id ||
           !triggeredByIds.has(s.id)
    );
    
    // Add inverted TRIGGERS statements
    allStatements.push(...invertedTriggers);
    console.log(`[MX] Inverted ${triggeredByStmts.length} TRIGGERED_BY statements to canonical TRIGGERS`);
  }
  
  // Step 3: Infer additional transitions if enabled
  if (opts.inferTransitions) {
    const inferred = inferTransitionsFromEntities(
      prefixed.entities,
      allStatements,
      artifactId
    );
    
    allEntities.push(...inferred.entities);
    allStatements.push(...inferred.statements);
  }
  
  // Find orphan entities
  const orphanEntityIds = opts.trackOrphans
    ? findOrphanEntities(allEntities, allStatements)
    : [];
  
  // Step 4: Validate canonical semantics post-MX
  const canonicalValidation = validateCanonicalSemantics(allEntities, allStatements);
  if (!canonicalValidation.valid) {
    console.warn('[MX] Canonical semantics validation warnings:', {
      count: canonicalValidation.warnings.length,
      warnings: canonicalValidation.warnings.slice(0, 5), // Log first 5
    });
  }
  
  const materializedCount = allEntities.length - prefixed.entities.length;
  const bindingCount = allStatements.length - prefixedStatements.length;
  const processingTimeMs = Date.now() - startTime;
  
  // Build unresolvedRefs for meta (only if there are issues)
  const unresolvedRefs = preGate.unresolvedStats.total > 0 
    ? {
        total: preGate.unresolvedStats.total,
        byPredicate: preGate.unresolvedStats.byPredicate,
      }
    : undefined;
  
  // Build canonical validation meta
  const canonicalValidationMeta = !canonicalValidation.valid
    ? {
        valid: false,
        warningCount: canonicalValidation.warnings.length,
        warnings: canonicalValidation.warnings,
      }
    : undefined;
  
  const output: MxStageOutput = {
    $schema: 'intentweave://schemas/mx-graph/v1',
    schemaVersion: '0.1',
    stage: 'MX',
    artifactId,
    processedAt: ctx.timestamp(),
    entities: allEntities,
    statements: allStatements,
    evidence: cxOutput.evidence,
    orphanEntityIds,
    meta: {
      entityCount: allEntities.length,
      materializedCount,
      statementCount: allStatements.length,
      bindingCount,
      inferredResource: resourceInference.meta,
      synthesizedHasState: synthesisResult.meta,
      orphanCount: orphanEntityIds.length,
      processingTimeMs,
      unresolvedRefs,
      canonicalValidation: canonicalValidationMeta,
      loweredTransitionsTo: explicit.loweredStatementIds.size,
      invertedTriggeredBy: triggeredByStmts?.length ?? 0,
    },
  };
  
  ctx.logger.debug(`MX stage complete for ${artifactId}`, {
    entities: allEntities.length,
    materialized: materializedCount,
    statements: allStatements.length,
    bindings: bindingCount,
    inferredResource: resourceInference.meta?.inferredName ?? null,
    synthesizedHasState: synthesisResult.meta?.count ?? 0,
    orphans: orphanEntityIds.length,
    unresolvedRefs: unresolvedRefs?.total ?? 0,
    canonicalWarnings: canonicalValidationMeta?.warningCount ?? 0,
  });
  
  return output;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get all entities from MX output
 */
export function getAllEntities(mxOutput: MxStageOutput): Entity[] {
  return mxOutput.entities;
}

/**
 * Get transition entities only
 */
export function getTransitionEntities(mxOutput: MxStageOutput): Entity[] {
  return mxOutput.entities.filter(e => e.type === 'transition');
}

/**
 * Get all statements from MX output
 */
export function getAllStatements(mxOutput: MxStageOutput): Statement[] {
  return mxOutput.statements;
}

/**
 * Get orphan entity IDs
 */
export function getOrphanIds(mxOutput: MxStageOutput): string[] {
  return mxOutput.orphanEntityIds;
}
