// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * MX (Materialization) - Entity extraction and transition reification
 * 
 * Migrated from src/services/mxStandalone.ts
 * 
 * MX runs in-memory materialization of higher-level behavioral structures:
 * - Works purely on StagingSnapshot (no Neo4j dependency)
 * - Creates transition entities from TRANSITIONS_TO statements
 * - Generates FROM_STATE, TO_STATE statements
 * - Binds actions to transitions via naming heuristics
 * 
 * Architecture:
 * - Standalone: CLI analysis (open source)
 * - Server-side: Can be persisted to Neo4j after processing
 */

import type { Entity, Statement, Evidence, StagingSnapshot, Origin } from '@intentweave/core';
import { buildCgId } from '@intentweave/core';

// ============================================================================
// Types
// ============================================================================

export interface MxOptions {
  /** Enable action binding heuristics */
  bindActions?: boolean;
  /** Enable LLM-based discovery (requires adapter) */
  llmDiscovery?: boolean;
  /** Minimum confidence for transition creation */
  minConfidence?: number;
}

export interface MxResult {
  /** Transformed snapshot with MX entities and statements */
  snapshot: StagingSnapshot;
  /** Statistics */
  stats: {
    transitionsCreated: number;
    statementsCreated: number;
    actionsBound: number;
    warnings: string[];
  };
}

export interface TransitionCandidate {
  fromState: Entity;
  toState: Entity;
  resource?: string;
  confidence: number;
  evidence: Evidence[];
  discoverySource: 'heuristic' | 'llm' | 'explicit';
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIDENCE = 0.7;

/** Action verbs that suggest state transitions */
export const TRANSITION_ACTION_VERBS = [
  'approve', 'reject', 'request', 'activate', 'deactivate',
  'suspend', 'cancel', 'create', 'delete', 'enable', 'disable',
  'lock', 'unlock', 'complete', 'start', 'finish', 'submit',
  'review', 'verify', 'confirm', 'deny', 'grant', 'revoke'
];

// ============================================================================
// Main Export
// ============================================================================

/**
 * Run MX (Materialization) stage on a StagingSnapshot
 * 
 * This is the standalone entry point that works in-memory.
 */
export async function runMx(
  snapshot: StagingSnapshot,
  options: MxOptions = {}
): Promise<MxResult> {
  const { bindActions = true, minConfidence = 0.6 } = options;

  const result: MxResult = {
    snapshot: {
      entities: [...snapshot.entities],
      statements: [...snapshot.statements]
    },
    stats: {
      transitionsCreated: 0,
      statementsCreated: 0,
      actionsBound: 0,
      warnings: []
    }
  };

  // Step 1: Discover transition candidates from TRANSITIONS_TO statements
  const candidates = discoverTransitionCandidates(snapshot, minConfidence);
  
  if (candidates.length === 0) {
    return result;
  }

  // Step 2: Reify transitions into entities
  for (const candidate of candidates) {
    const reified = reifyTransition(candidate);
    
    // Add transition entity if new
    if (!result.snapshot.entities.some(e => e.cgId === reified.transitionEntity.cgId)) {
      result.snapshot.entities.push(reified.transitionEntity);
      result.stats.transitionsCreated++;
    }
    
    // Add FROM_STATE and TO_STATE statements
    for (const stmt of reified.statements) {
      if (!statementExists(result.snapshot.statements, stmt)) {
        result.snapshot.statements.push(stmt);
        result.stats.statementsCreated++;
      }
    }
  }

  // Step 3: Bind actions to transitions
  if (bindActions) {
    const actionBindings = bindActionsToTransitions(result.snapshot);
    for (const stmt of actionBindings) {
      if (!statementExists(result.snapshot.statements, stmt)) {
        result.snapshot.statements.push(stmt);
        result.stats.actionsBound++;
      }
    }
  }

  // Step 4: Validate and annotate
  const warnings = validateMxLayer(result.snapshot);
  result.stats.warnings = warnings;

  return result;
}

// Alias for backwards compatibility
export const runMxStandalone = runMx;

// ============================================================================
// Discovery
// ============================================================================

/**
 * Discover transition candidates from existing statements
 */
export function discoverTransitionCandidates(
  snapshot: StagingSnapshot,
  minConfidence: number
): TransitionCandidate[] {
  const candidates: TransitionCandidate[] = [];
  const entityMap = new Map(snapshot.entities.map(e => [e.cgId, e]));

  // Method 1: Look for explicit TRANSITIONS_TO statements
  for (const stmt of snapshot.statements) {
    if (stmt.predicate === 'TRANSITIONS_TO' && stmt.objectCgId) {
      const fromState = entityMap.get(stmt.subjectCgId);
      const toState = entityMap.get(stmt.objectCgId);
      
      if (fromState && toState && stmt.confidence >= minConfidence) {
        const resource = extractResourceFromState(fromState.cgId);
        candidates.push({
          fromState,
          toState,
          resource,
          confidence: stmt.confidence,
          evidence: stmt.evidence,
          discoverySource: 'explicit'
        });
      }
    }
  }

  // Method 2: Infer transitions from HAS_STATE patterns
  const statesByResource = groupStatesByResource(snapshot);
  for (const [resource, states] of statesByResource.entries()) {
    if (states.length >= 2) {
      const inferredTransitions = inferTransitionsFromStates(states);
      for (const inferred of inferredTransitions) {
        const exists = candidates.some(c =>
          c.fromState.cgId === inferred.fromState.cgId &&
          c.toState.cgId === inferred.toState.cgId
        );
        if (!exists) {
          candidates.push({
            ...inferred,
            resource,
            discoverySource: 'heuristic'
          });
        }
      }
    }
  }

  return candidates;
}

/**
 * Group state entities by their resource scope
 */
export function groupStatesByResource(snapshot: StagingSnapshot): Map<string, Entity[]> {
  const groups = new Map<string, Entity[]>();
  
  for (const entity of snapshot.entities) {
    if (entity.type === 'state' || isStateEntity(entity)) {
      const resource = extractResourceFromState(entity.cgId);
      if (resource) {
        const existing = groups.get(resource) || [];
        existing.push(entity);
        groups.set(resource, existing);
      }
    }
  }
  
  return groups;
}

/**
 * Check if entity appears to be a state
 */
export function isStateEntity(entity: Entity): boolean {
  if (entity.type === 'state') return true;
  if (entity.cgId.includes('/state/') || entity.cgId.includes('|state/')) {
    return true;
  }
  return false;
}

/**
 * Extract resource name from state cgId
 */
export function extractResourceFromState(cgId: string): string | undefined {
  const parts = cgId.split('|');
  const lastPart = parts[parts.length - 1];
  const segments = lastPart.split('/');
  
  if (segments.length >= 3 && segments[0] === 'state') {
    return segments[1];
  }
  
  if (segments.length >= 2) {
    return segments[0];
  }
  
  return undefined;
}

/**
 * Infer transitions from a list of states
 */
export function inferTransitionsFromStates(
  states: Entity[]
): Omit<TransitionCandidate, 'resource' | 'discoverySource'>[] {
  const transitions: Omit<TransitionCandidate, 'resource' | 'discoverySource'>[] = [];
  
  // Sort states by evidence order
  const sortedStates = [...states].sort((a, b) => {
    const aIndex = getFirstEvidenceIndex(a);
    const bIndex = getFirstEvidenceIndex(b);
    return aIndex - bIndex;
  });
  
  // Create transitions between consecutive states
  for (let i = 0; i < sortedStates.length - 1; i++) {
    const fromState = sortedStates[i];
    const toState = sortedStates[i + 1];
    
    transitions.push({
      fromState,
      toState,
      confidence: DEFAULT_CONFIDENCE,
      evidence: mergeEvidence(fromState.evidence, toState.evidence)
    });
  }
  
  return transitions;
}

/**
 * Get the earliest evidence turn index for an entity
 */
export function getFirstEvidenceIndex(entity: Entity): number {
  if (!entity.evidence || entity.evidence.length === 0) {
    return Infinity;
  }
  return Math.min(...entity.evidence.map(e => e.turnIndex ?? Infinity));
}

/**
 * Merge evidence from multiple sources
 */
export function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const merged: Evidence[] = [];
  
  for (const ev of [...a, ...b]) {
    const key = `${ev.turnIndex}:${ev.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ev);
    }
  }
  
  return merged;
}

// ============================================================================
// Reification
// ============================================================================

interface ReifiedTransition {
  transitionEntity: Entity;
  statements: Statement[];
}

/**
 * Reify a transition candidate into an entity and statements
 */
export function reifyTransition(candidate: TransitionCandidate): ReifiedTransition {
  const { fromState, toState, resource, confidence, evidence, discoverySource } = candidate;
  
  const fromStateName = extractStateName(fromState.cgId, fromState.name);
  const toStateName = extractStateName(toState.cgId, toState.name);
  
  const resourcePart = resource || 'unknown';
  const transitionCgId = buildCgId('transition', resourcePart, `${fromStateName}->${toStateName}`);

  const transitionEntity: Entity = {
    cgId: transitionCgId,
    type: 'transition',
    name: `${fromStateName} → ${toStateName}`,
    labels: ['Staging'],
    evidence,
    confidence,
    source: 'heuristic',
    origin: 'heuristic' as Origin,
    state: 'new',
    props: {
      mx_rule: 'MX:standalone',
      mx_discovered: discoverySource,
      resource: resourcePart,
      fromStateName,
      toStateName
    }
  };

  // Canonical semantics:
  // source_state --FROM_STATE--> Transition --TO_STATE--> target_state
  const statements: Statement[] = [
    {
      subjectCgId: fromState.cgId,     // Source state is subject
      predicate: 'FROM_STATE',
      objectCgId: transitionCgId,      // Transition is object
      confidence,
      evidence,
      labels: ['Staging'],
      state: 'new',
      origin: 'heuristic' as Origin
    },
    {
      subjectCgId: transitionCgId,     // Transition is subject
      predicate: 'TO_STATE',
      objectCgId: toState.cgId,        // State is object
      confidence,
      evidence,
      labels: ['Staging'],
      state: 'new',
      origin: 'heuristic' as Origin
    }
  ];

  return { transitionEntity, statements };
}

/**
 * Extract state name from cgId or entity name
 */
export function extractStateName(cgId: string, fallbackName: string): string {
  const parts = cgId.split('|');
  const lastPart = parts[parts.length - 1];
  const segments = lastPart.split('/');
  
  if (segments.length >= 1) {
    return segments[segments.length - 1];
  }
  
  return fallbackName;
}

// ============================================================================
// Action Binding
// ============================================================================

/**
 * Bind actions to transitions based on naming heuristics
 */
export function bindActionsToTransitions(snapshot: StagingSnapshot): Statement[] {
  const bindings: Statement[] = [];
  
  const transitions = snapshot.entities.filter(e => 
    e.type === 'transition' || e.cgId.includes('/transition/')
  );
  
  const actions = snapshot.entities.filter(e =>
    e.type === 'action' || isActionEntity(e)
  );
  
  for (const transition of transitions) {
    const toStateName = transition.props?.toStateName as string || 
                        extractToStateFromTransition(transition);
    
    if (!toStateName) continue;
    
    for (const action of actions) {
      const actionName = action.name.toLowerCase();
      
      if (actionNameMatchesState(actionName, toStateName)) {
        bindings.push({
          subjectCgId: action.cgId,
          predicate: 'TRIGGERS',
          objectCgId: transition.cgId,
          confidence: DEFAULT_CONFIDENCE,
          evidence: mergeEvidence(action.evidence, transition.evidence),
          labels: ['Staging'],
          state: 'new',
          origin: 'heuristic' as Origin
        });
      }
    }
  }
  
  return bindings;
}

/**
 * Check if entity appears to be an action
 */
export function isActionEntity(entity: Entity): boolean {
  if (entity.type === 'action') return true;
  
  const name = entity.name.toLowerCase();
  return TRANSITION_ACTION_VERBS.some(verb => name.includes(verb));
}

/**
 * Extract target state from transition name
 */
export function extractToStateFromTransition(transition: Entity): string | undefined {
  const match = transition.name.match(/→\s*(.+)$/);
  if (match) {
    return match[1].toLowerCase().trim();
  }
  return undefined;
}

/**
 * Check if action name matches a target state
 */
export function actionNameMatchesState(actionName: string, stateName: string): boolean {
  const normalizedAction = actionName.toLowerCase();
  const normalizedState = stateName.toLowerCase();
  
  if (normalizedAction.includes(normalizedState.replace(/d$/, ''))) {
    return true;
  }
  
  const verbRoot = normalizedAction.replace(/(e|ed|ing|s)$/, '');
  if (normalizedState.startsWith(verbRoot)) {
    return true;
  }
  
  return false;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate the MX layer
 */
export function validateMxLayer(snapshot: StagingSnapshot): string[] {
  const warnings: string[] = [];
  const entityMap = new Map(snapshot.entities.map(e => [e.cgId, e]));
  
  const transitions = snapshot.entities.filter(e => 
    e.type === 'transition' || e.cgId.includes('/transition/')
  );
  
  for (const transition of transitions) {
    // Canonical: source_state --FROM_STATE--> transition --TO_STATE--> target_state
    const hasFromState = snapshot.statements.some(s =>
      s.predicate === 'FROM_STATE' && s.objectCgId === transition.cgId
    );
    const hasToState = snapshot.statements.some(s =>
      s.predicate === 'TO_STATE' && s.subjectCgId === transition.cgId
    );
    
    if (!hasFromState) {
      warnings.push(`Transition ${transition.cgId} has no FROM_STATE`);
    }
    if (!hasToState) {
      warnings.push(`Transition ${transition.cgId} has no TO_STATE`);
    }
  }
  
  for (const stmt of snapshot.statements) {
    if (stmt.predicate === 'FROM_STATE' || stmt.predicate === 'TO_STATE') {
      // FROM_STATE: subject=state, object=transition
      // TO_STATE: subject=transition, object=state
      if (stmt.predicate === 'FROM_STATE') {
        if (stmt.objectCgId && !entityMap.has(stmt.objectCgId)) {
          warnings.push(`FROM_STATE references non-existent transition: ${stmt.objectCgId}`);
        }
        if (!entityMap.has(stmt.subjectCgId)) {
          warnings.push(`FROM_STATE references non-existent state: ${stmt.subjectCgId}`);
        }
      } else {
        if (!entityMap.has(stmt.subjectCgId)) {
          warnings.push(`TO_STATE references non-existent transition: ${stmt.subjectCgId}`);
        }
        if (stmt.objectCgId && !entityMap.has(stmt.objectCgId)) {
          warnings.push(`TO_STATE references non-existent state: ${stmt.objectCgId}`);
        }
      }
    }
  }
  
  return warnings;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a statement already exists
 */
export function statementExists(statements: Statement[], stmt: Statement): boolean {
  return statements.some(s =>
    s.subjectCgId === stmt.subjectCgId &&
    s.predicate === stmt.predicate &&
    s.objectCgId === stmt.objectCgId
  );
}
