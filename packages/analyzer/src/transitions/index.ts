/**
 * Transition Extraction - Detect state transitions from evidence
 * 
 * Migrated from src/services/transitionExtractor.ts
 * 
 * This module provides functions to extract and reify behavioral transitions
 * from chat evidence or other textual sources.
 */

import type { Entity, Statement, Evidence, StagingSnapshot, Origin } from '@intentweave/core';

// ============================================================================
// Types
// ============================================================================

/**
 * A detected transition hit from text analysis
 */
export interface TransitionHit {
  /** Source state name */
  from: string;
  /** Target state name */
  to: string;
  /** Confidence level (0-1) */
  confidence: number;
  /** Evidence supporting this transition */
  evidence: Evidence[];
  /** Resource/context identifier */
  resource?: string;
  /** Absence negation pattern */
  negated?: boolean;
  /** Duration if detected */
  duration?: {
    iso: string;
    unit?: DurationUnit;
    value?: number;
  };
}

/**
 * Transition definition (for Mermaid parsing)
 */
export interface Transition {
  /** Source state name */
  from: string;
  
  /** Target state name */
  to: string;
  
  /** Event/action that triggers the transition */
  trigger?: string;
  
  /** Guard condition */
  guard?: string;
  
  /** Action performed during transition */
  action?: string;
  
  /** Source line number */
  sourceLine?: number;
}

/**
 * State machine definition
 */
export interface StateMachine {
  /** Resource name this state machine belongs to */
  resource: string;
  
  /** All states in the machine */
  states: string[];
  
  /** Initial state */
  initialState?: string;
  
  /** Final states */
  finalStates: string[];
  
  /** All transitions */
  transitions: Transition[];
}

/**
 * Transition extraction options
 */
export interface TransitionExtractionOptions {
  /** Minimum confidence to include */
  minConfidence?: number;
  /** Maximum hits to return */
  maxHits?: number;
  /** Resource filter */
  resourceFilter?: string;
  /** Known state names to boost detection */
  knownStates?: string[];
  /** Namespace for generated cgIds */
  namespace?: string;
  /** File path for evidence */
  filePath?: string;
  /** Infer initial state from first mentioned */
  inferInitialState?: boolean;
}

export type DurationUnit = 'years' | 'months' | 'weeks' | 'days' | 'hours';

// ============================================================================
// Constants
// ============================================================================

/** Default state names to look for */
export const DEFAULT_STATE_NAMES = [
  'active', 'inactive', 'pending', 'approved', 'rejected', 'deleted',
  'suspended', 'enabled', 'disabled', 'locked', 'unlocked',
  'dormant', 'deactivated', 'archived', 'published', 'draft',
  'open', 'closed', 'in_progress', 'completed', 'cancelled',
  'verified', 'unverified', 'expired', 'valid', 'invalid'
];

/** Absence patterns that indicate negation */
export const ABSENCE_PATTERNS: Array<{ regex: RegExp; negated?: boolean }> = [
  { regex: /no\s+(?<action>\w+)\s+in\s+the\s+last/i, negated: true },
  { regex: /hasn't\s+(?<action>\w+)\s+in/i, negated: true },
  { regex: /haven't\s+(?<action>\w+)\s+in/i, negated: true },
  { regex: /hasn't\s+(?<action>\w+)\s+for/i, negated: true },
  { regex: /haven't\s+(?<action>\w+)\s+for/i, negated: true },
  { regex: /without\s+(?<action>\w+)\s+for/i, negated: true },
  { regex: /no\s+recent\s+(?<action>\w+)/i, negated: true },
  { regex: /hasn't\s+been\s+(?<action>\w+)/i, negated: true },
  { regex: /inactive\s+for/i, negated: true },
  { regex: /dormant\s+for/i, negated: true },
];

/** Duration unit mappings */
export const UNIT_MAP: Record<string, DurationUnit> = {
  year: 'years', years: 'years', yr: 'years', yrs: 'years', y: 'years',
  month: 'months', months: 'months', mo: 'months', mos: 'months',
  week: 'weeks', weeks: 'weeks', wk: 'weeks', wks: 'weeks', w: 'weeks',
  day: 'days', days: 'days', d: 'days',
  hour: 'hours', hours: 'hours', hr: 'hours', hrs: 'hours', h: 'hours',
};

/** Number words to values */
export const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12
};

/** ISO duration pattern */
export const ISO_DURATION_PATTERN = /P(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(\d+H)?(\d+M)?(\d+S)?)?/gi;

/** Number + unit pattern */
export const NUMBER_UNIT_PATTERN = /(\d+)\s*(year|years|month|months|week|weeks|day|days|hour|hours|yr|yrs|mo|mos|wk|wks|hr|hrs)/gi;

/** Default extraction options */
export const defaultExtractionOptions: TransitionExtractionOptions = {
  minConfidence: 0.5,
  maxHits: 100,
};

// ============================================================================
// Main Export
// ============================================================================

/**
 * Extract transition hits from a snapshot's evidence
 * 
 * @param snapshot - Staging snapshot with entities and statements
 * @param options - Extraction options
 * @returns Array of detected transition hits
 */
export function extractTransitions(
  snapshot: StagingSnapshot,
  options: TransitionExtractionOptions = {}
): TransitionHit[] {
  const opts = { ...defaultExtractionOptions, ...options };
  const hits: TransitionHit[] = [];
  
  // Build state dictionary from snapshot entities
  const dictionary = buildStateDictionary(snapshot, opts.knownStates);
  
  // Gather all evidence from entities
  const evidenceList = gatherEvidence(snapshot);
  
  for (const ev of evidenceList) {
    if (!ev.text) continue;
    
    // Parse each piece of evidence
    const parsed = parseEvidence(ev.text, dictionary);
    
    if (parsed) {
      const features = {
        hasExplicitFromTo: Boolean(parsed.from && parsed.to),
        hasAbsence: Boolean(parsed.absence),
        hasDuration: Boolean(parsed.duration),
        hasNegation: Boolean(parsed.absence?.negated),
        isIsoDuration: Boolean(parsed.duration?.iso?.startsWith('P'))
      };
      
      const confidence = computeConfidence(features);
      
      if (confidence >= (opts.minConfidence || 0.5)) {
        const hit: TransitionHit = {
          from: parsed.from || 'unknown',
          to: parsed.to || parsed.absence?.action || 'unknown',
          confidence,
          evidence: [cloneEvidence(ev)],
          negated: parsed.absence?.negated,
          duration: parsed.duration
        };
        
        // Merge with existing hit if same transition
        const existingIdx = hits.findIndex(h => h.from === hit.from && h.to === hit.to);
        if (existingIdx >= 0) {
          hits[existingIdx].evidence = mergeEvidenceLists(hits[existingIdx].evidence, hit.evidence);
          hits[existingIdx].confidence = Math.max(hits[existingIdx].confidence, hit.confidence);
        } else {
          hits.push(hit);
        }
      }
    }
  }
  
  // Also look for explicit TRANSITIONS_TO statements
  for (const statement of snapshot.statements) {
    if (statement.predicate === 'TRANSITIONS_TO') {
      const fromEntity = snapshot.entities.find(e => e.cgId === statement.subjectCgId);
      const toEntity = statement.objectCgId 
        ? snapshot.entities.find(e => e.cgId === statement.objectCgId)
        : undefined;
      
      if (fromEntity && toEntity && statement.confidence >= (opts.minConfidence || 0)) {
        const existingIdx = hits.findIndex(h => h.from === fromEntity.name && h.to === toEntity.name);
        if (existingIdx >= 0) {
          hits[existingIdx].evidence = mergeEvidenceLists(hits[existingIdx].evidence, statement.evidence);
          hits[existingIdx].confidence = Math.max(hits[existingIdx].confidence, statement.confidence);
        } else {
          hits.push({
            from: fromEntity.name,
            to: toEntity.name,
            confidence: statement.confidence,
            evidence: statement.evidence,
          });
        }
      }
    }
  }
  
  return hits.slice(0, opts.maxHits);
}

/**
 * Extract state machines from markdown content (Mermaid diagrams)
 */
export function extractTransitionsFromMarkdown(
  content: string,
  options: TransitionExtractionOptions = {}
): { stateMachines: StateMachine[]; entities: Entity[]; statements: Statement[]; warnings: string[] } {
  const result = {
    stateMachines: [] as StateMachine[],
    entities: [] as Entity[],
    statements: [] as Statement[],
    warnings: [] as string[],
  };
  
  const machine = parseMermaidStateDiagram(content);
  if (machine) {
    result.stateMachines.push(machine);
    const graph = stateMachineToGraph(machine, options.namespace || 'spec');
    result.entities = graph.entities;
    result.statements = graph.statements;
  }
  
  return result;
}

// ============================================================================
// State Dictionary
// ============================================================================

/**
 * Build a dictionary mapping state name variants to canonical names
 */
export function buildStateDictionary(
  snapshot: StagingSnapshot,
  knownStates?: string[]
): Map<string, string> {
  const dictionary = new Map<string, string>();
  
  // Add known states
  for (const state of (knownStates || DEFAULT_STATE_NAMES)) {
    const normalized = normalizeStateName(state);
    dictionary.set(normalized, state);
    // Add variant without underscores/hyphens
    dictionary.set(state.replace(/[_-]/g, ''), state);
  }
  
  // Add states from entities
  for (const entity of snapshot.entities) {
    if (entity.type === 'state' || entity.cgId.includes('/state/')) {
      const normalized = normalizeStateName(entity.name);
      dictionary.set(normalized, entity.name);
    }
  }
  
  return dictionary;
}

/**
 * Gather all evidence from snapshot entities
 */
export function gatherEvidence(snapshot: StagingSnapshot): Evidence[] {
  const evidenceList: Evidence[] = [];
  const seen = new Set<string>();
  
  for (const entity of snapshot.entities) {
    for (const ev of entity.evidence) {
      const key = evidenceKey(ev);
      if (!seen.has(key)) {
        seen.add(key);
        evidenceList.push(ev);
      }
    }
  }
  
  // Sort by turn index
  evidenceList.sort((a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0));
  
  return evidenceList;
}

// ============================================================================
// Evidence Parsing
// ============================================================================

interface ParsedEvidence {
  from?: string;
  to?: string;
  absence?: { action: string; negated: boolean };
  duration?: { iso: string; unit?: DurationUnit; value?: number };
}

/**
 * Parse a piece of evidence text for transition patterns
 */
export function parseEvidence(text: string, dictionary: Map<string, string>): ParsedEvidence | null {
  const result: ParsedEvidence = {};
  
  // Check for explicit from->to patterns
  const explicitTransition = findExplicitTransitions(text, dictionary);
  if (explicitTransition) {
    result.from = explicitTransition.from;
    result.to = explicitTransition.to;
  }
  
  // Check for absence patterns
  const absence = detectAbsence(text);
  if (absence) {
    result.absence = absence;
    // Infer from state if we have absence
    if (!result.from && result.to) {
      result.from = inferDefaultFromState(result.to, dictionary) || undefined;
    }
  }
  
  // Check for duration
  const duration = detectDuration(text);
  if (duration) {
    result.duration = duration;
  }
  
  // Only return if we found something
  if (result.from || result.to || result.absence) {
    return result;
  }
  
  // Fall back to state mention detection
  const mentions = findStateMentions(text, dictionary);
  if (mentions.length >= 2) {
    result.from = mentions[0];
    result.to = mentions[1];
    return result;
  }
  
  return null;
}

/**
 * Find explicit transition patterns like "from X to Y" or "X -> Y"
 */
export function findExplicitTransitions(
  text: string,
  dictionary: Map<string, string>
): { from: string; to: string } | null {
  const alternation = stateAlternation(dictionary);
  if (!alternation) return null;
  
  // Pattern: "from <state> to <state>"
  const fromToPattern = new RegExp(
    `from\\s+(${alternation})\\s+to\\s+(${alternation})`,
    'i'
  );
  let match = fromToPattern.exec(text);
  if (match) {
    return {
      from: normalizeStateName(match[1]),
      to: normalizeStateName(match[2])
    };
  }
  
  // Pattern: "<state> -> <state>" or "<state> → <state>"
  const arrowPattern = new RegExp(
    `(${alternation})\\s*(?:->|→|to)\\s*(${alternation})`,
    'i'
  );
  match = arrowPattern.exec(text);
  if (match) {
    return {
      from: normalizeStateName(match[1]),
      to: normalizeStateName(match[2])
    };
  }
  
  // Pattern: "becomes <state>"
  const becomesPattern = new RegExp(`becomes?\\s+(${alternation})`, 'i');
  match = becomesPattern.exec(text);
  if (match) {
    return {
      from: 'unknown',
      to: normalizeStateName(match[1])
    };
  }
  
  return null;
}

/**
 * Find state mentions in text
 */
export function findStateMentions(text: string, dictionary: Map<string, string>): string[] {
  const mentions: string[] = [];
  const lowerText = text.toLowerCase();
  
  for (const [variant, canonical] of dictionary) {
    if (lowerText.includes(variant.toLowerCase())) {
      if (!mentions.includes(canonical)) {
        mentions.push(canonical);
      }
    }
  }
  
  return mentions;
}

// ============================================================================
// Pattern Detection
// ============================================================================

/**
 * Detect absence patterns in text
 */
export function detectAbsence(text: string): { action: string; negated: boolean } | null {
  for (const { regex, negated } of ABSENCE_PATTERNS) {
    const match = regex.exec(text);
    if (match?.groups?.action) {
      return {
        action: normalizeActionName(match.groups.action),
        negated: Boolean(negated)
      };
    }
  }
  return null;
}

/**
 * Detect duration patterns in text
 */
export function detectDuration(text: string): { iso: string; unit?: DurationUnit; value?: number } | null {
  ISO_DURATION_PATTERN.lastIndex = 0;
  NUMBER_UNIT_PATTERN.lastIndex = 0;
  
  const isoMatch = ISO_DURATION_PATTERN.exec(text);
  if (isoMatch) {
    const iso = isoMatch[0].toUpperCase();
    const parsed = parseIsoComponents(iso);
    if (parsed) {
      return parsed;
    }
  }

  let match: RegExpExecArray | null;
  while ((match = NUMBER_UNIT_PATTERN.exec(text)) !== null) {
    const rawValue = match[1];
    const unitKey = match[2].toLowerCase() as keyof typeof UNIT_MAP;
    const unit = UNIT_MAP[unitKey];
    if (!unit) continue;
    const value = Number(rawValue);
    if (Number.isNaN(value)) continue;
    const iso = toIsoString(value, unit);
    return { iso, unit, value };
  }

  return null;
}

/**
 * Parse ISO duration components
 */
export function parseIsoComponents(iso: string): { iso: string; unit?: DurationUnit; value?: number } | null {
  const pattern = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;
  const match = pattern.exec(iso);
  if (!match) return null;

  const [_, years, months, weeks, days, hours] = match;
  if (years && !months && !weeks && !days && !hours) {
    return { iso, unit: 'years', value: Number(years) };
  }
  if (months && !years && !weeks && !days && !hours) {
    return { iso, unit: 'months', value: Number(months) };
  }
  if (weeks && !years && !months && !days && !hours) {
    return { iso, unit: 'weeks', value: Number(weeks) };
  }
  if (days && !years && !months && !weeks && !hours) {
    return { iso, unit: 'days', value: Number(days) };
  }
  if (hours && !years && !months && !weeks && !days) {
    return { iso, unit: 'hours', value: Number(hours) };
  }

  return { iso };
}

// ============================================================================
// Mermaid Parsing (for markdown state diagrams)
// ============================================================================

/**
 * Parse a Mermaid state diagram
 */
export function parseMermaidStateDiagram(content: string): StateMachine | null {
  const lines = content.split('\n');
  const states = new Set<string>();
  const transitions: Transition[] = [];
  let resource = 'Unknown';
  
  for (const line of lines) {
    // Parse state definitions
    const stateMatch = line.match(/^\s*state\s+"?([^"]+)"?\s+as\s+(\w+)/);
    if (stateMatch) {
      states.add(stateMatch[2]);
      continue;
    }
    
    // Parse transitions: state1 --> state2 : label
    const transMatch = line.match(/^\s*(\w+)\s*-->\s*(\w+)\s*(?::\s*(.+))?/);
    if (transMatch) {
      states.add(transMatch[1]);
      states.add(transMatch[2]);
      transitions.push({
        from: transMatch[1],
        to: transMatch[2],
        trigger: transMatch[3]?.trim(),
      });
    }
    
    // Parse initial state: [*] --> state
    const initMatch = line.match(/^\s*\[\*\]\s*-->\s*(\w+)/);
    if (initMatch) {
      states.add(initMatch[1]);
    }
  }
  
  if (states.size === 0) {
    return null;
  }
  
  return {
    resource,
    states: Array.from(states),
    transitions,
    finalStates: [],
  };
}

/**
 * Convert a state machine to entities and statements
 */
export function stateMachineToGraph(
  machine: StateMachine,
  namespace: string
): { entities: Entity[]; statements: Statement[] } {
  const entities: Entity[] = [];
  const statements: Statement[] = [];
  
  // Create state entities
  for (const state of machine.states) {
    entities.push({
      cgId: `spec.state.${namespace}.${machine.resource}.${state}`,
      type: 'state',
      name: state,
      source: 'heuristic',
      confidence: 1.0,
      state: 'new',
      evidence: [],
      labels: ['Staging'],
    });
  }
  
  // Create transition statements
  for (const transition of machine.transitions) {
    statements.push({
      subjectCgId: `spec.state.${namespace}.${machine.resource}.${transition.from}`,
      predicate: 'TRANSITIONS_TO',
      objectCgId: `spec.state.${namespace}.${machine.resource}.${transition.to}`,
      confidence: 1.0,
      state: 'new',
      evidence: [],
      labels: ['Staging'],
      metadata: {
        trigger: transition.trigger,
        guard: transition.guard,
        action: transition.action,
      },
    });
  }
  
  return { entities, statements };
}

// ============================================================================
// Reification
// ============================================================================

/**
 * Reify transition hits into entities and statements
 * 
 * @param hits - Transition hits to reify
 * @param namespace - Namespace for generated cgIds
 * @returns Object containing entities and statements
 */
export function reifyTransitions(
  hits: TransitionHit[],
  namespace: string = 'transition'
): { entities: Entity[]; statements: Statement[] } {
  const entities: Entity[] = [];
  const statements: Statement[] = [];
  
  for (const hit of hits) {
    const transitionCgId = `${namespace}|${hit.from}->${hit.to}`;
    
    // Create transition entity
    const transitionEntity: Entity = {
      cgId: transitionCgId,
      type: 'transition',
      name: `${hit.from} → ${hit.to}`,
      labels: ['Staging'],
      evidence: hit.evidence,
      confidence: hit.confidence,
      source: 'heuristic',
      origin: 'heuristic' as Origin,
      state: 'new',
      props: {
        fromState: hit.from,
        toState: hit.to,
        resource: hit.resource,
        negated: hit.negated,
        duration: hit.duration?.iso,
      },
    };
    entities.push(transitionEntity);
    
    // Create FROM_STATE statement (source_state → transition)
    statements.push({
      subjectCgId: `state|${hit.from}`,
      predicate: 'FROM_STATE',
      objectCgId: transitionCgId,
      confidence: hit.confidence,
      evidence: hit.evidence,
      labels: ['Staging'],
      state: 'new',
      origin: 'heuristic' as Origin,
    });
    
    // Create TO_STATE statement (transition → target_state)
    statements.push({
      subjectCgId: transitionCgId,
      predicate: 'TO_STATE',
      objectCgId: `state|${hit.to}`,
      confidence: hit.confidence,
      evidence: hit.evidence,
      labels: ['Staging'],
      state: 'new',
      origin: 'heuristic' as Origin,
    });
  }
  
  return { entities, statements };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute confidence from detected features
 */
function computeConfidence(features: {
  hasExplicitFromTo: boolean;
  hasAbsence: boolean;
  hasDuration: boolean;
  hasNegation: boolean;
  isIsoDuration: boolean;
}): number {
  let confidence = 0.55;
  if (features.hasExplicitFromTo) confidence += 0.2;
  if (features.hasAbsence) confidence += 0.1;
  if (features.hasDuration) confidence += 0.08;
  if (features.hasNegation) confidence += 0.05;
  if (features.isIsoDuration) confidence += 0.05;
  return clampConfidence(confidence);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.6;
  return Math.max(0.5, Math.min(0.96, value));
}

function mergeEvidenceLists(base: Evidence[], additions: Evidence[]): Evidence[] {
  const map = new Map<string, Evidence>();
  for (const item of base) {
    map.set(evidenceKey(item), item);
  }
  for (const item of additions) {
    map.set(evidenceKey(item), item);
  }
  return Array.from(map.values()).slice(0, 5);
}

function cloneEvidence(ev: Evidence): Evidence {
  return { ...ev };
}

function evidenceKey(ev: Evidence): string {
  const start = ev.start ?? -1;
  const end = ev.end ?? -1;
  return `${ev.turnIndex ?? 0}|${start}|${end}|${ev.text}`;
}

function normalizeStateName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function variantRegex(variant: string): string {
  const parts = variant.split(/\s+/).map(escapeRegex);
  return parts.join('[-\\s]*');
}

function stateAlternation(dictionary: Map<string, string>): string | null {
  if (!dictionary.size) return null;
  return Array.from(dictionary.keys())
    .filter(Boolean)
    .map((variant) => variantRegex(variant))
    .sort((a, b) => b.length - a.length)
    .join('|');
}

function normalizeActionName(action: string): string {
  const normalized = action.replace(/[^a-z\s]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return 'action';
  if (normalized.includes('log')) return 'login';
  if (normalized.includes('sign')) return 'login';
  if (normalized.includes('activity')) return 'activity';
  return normalized;
}

function inferDefaultFromState(to: string, dictionary: Map<string, string>): string | null {
  if (to === 'inactive' || to === 'dormant' || to === 'deactivated') {
    return 'active';
  }
  if (to === 'active' && dictionary.has('inactive')) {
    return 'inactive';
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toIsoString(value: number, unit: DurationUnit): string {
  switch (unit) {
    case 'years':
      return `P${value}Y`;
    case 'months':
      return `P${value}M`;
    case 'weeks':
      return `P${value}W`;
    case 'days':
      return `P${value}D`;
    case 'hours':
      return value === 0 ? 'PT0H' : `PT${value}H`;
    default:
      return `P${value}D`;
  }
}
