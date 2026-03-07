/**
 * Predicates - Relationship types in the knowledge graph
 * 
 * This is the SINGLE SOURCE OF TRUTH for all predicates.
 * extractionSchema and shapes import from here.
 * 
 * @version 2.0.0 - Unified schema (no serverInteractive/coreRich split)
 */

// ============================================================================
// Predicate Definitions - SINGLE SOURCE OF TRUTH
// ============================================================================

/**
 * All supported predicates for IntentWeave extraction.
 * 
 * Categories:
 * - State Machine: HAS_STATE, TRANSITIONS_TO, FROM_STATE, TO_STATE, TRIGGERED_BY, ABSENCE_OF, WITHIN
 * - Domain Rules: ABOUT_RESOURCE, REQUIRES, CONTAINS, IMPLEMENTS
 * - Authorization: ROLE_CAN, REQUIRES_ROLE
 * - Service Architecture: DEPENDS_ON, EXPOSES_ENDPOINT, CALLS, CONSUMES_ENDPOINT, PRODUCES_EVENT, SUBSCRIBES_EVENT
 * - Data Layer: STORES_IN, READS_FROM, WRITES_TO, PUBLISHES_TO, SUBSCRIBES_TO, CACHES_IN
 * - Legacy/Decision: SUPPORTS, CONTRADICTS, HAS_OPTION, SELECTS, IN_SCOPE, OUT_OF_SCOPE, DUE_DATE, REJECTS, DEFERS
 */
export const PREDICATES = [
  // State machine predicates
  'HAS_STATE',        // resource → state
  'TRANSITIONS_TO',   // state → state
  'FROM_STATE',       // transition → state
  'TO_STATE',         // transition → state
  'TRIGGERED_BY',     // transition → action/event
  'TRIGGERS',         // action|event → transition (canonical inverse of TRIGGERED_BY)
  'ABSENCE_OF',       // condition → action
  'WITHIN',           // condition scope
  
  // Domain/rule predicates
  'ABOUT_RESOURCE',   // rule → resource
  'REQUIRES',         // Generic requirement
  'CONTAINS',         // Containment
  'IMPLEMENTS',       // Implementation
  
  // Authorization predicates
  'ROLE_CAN',         // role → action/endpoint/page
  'REQUIRES_ROLE',    // endpoint/page → role
  
  // Service architecture predicates
  'DEPENDS_ON',       // service → service/database
  'EXPOSES_ENDPOINT', // service → endpoint
  'CALLS',            // service/frontend → endpoint
  'CONSUMES_ENDPOINT',// service/frontend → endpoint
  'PRODUCES_EVENT',   // service → event
  'SUBSCRIBES_EVENT', // service → event
  
  // Data layer predicates
  'STORES_IN',        // → database
  'READS_FROM',       // → database
  'WRITES_TO',        // → database
  'PUBLISHES_TO',     // → queue
  'SUBSCRIBES_TO',    // → queue
  'CACHES_IN',        // → cache
  
  // Legacy/decision predicates (backward compatibility)
  'SUPPORTS',         // page/service → question/concept
  'CONTRADICTS',      // Legacy
  'HAS_OPTION',       // question → state
  'SELECTS',          // Legacy
  'IN_SCOPE',         // Legacy
  'OUT_OF_SCOPE',     // Legacy
  'DUE_DATE',         // Legacy
  'REJECTS',          // Legacy
  'DEFERS',           // Legacy
] as const;

export type Predicate = typeof PREDICATES[number];

/**
 * Object form for convenient access (P.HAS_STATE instead of 'HAS_STATE')
 */
export const Predicates = Object.fromEntries(
  PREDICATES.map(p => [p, p])
) as { [K in Predicate]: K };

/**
 * @deprecated Use Predicate type directly
 */
export type PredicateType = Predicate;

/**
 * Get all predicate names
 */
export function getAllPredicates(): Predicate[] {
  return [...PREDICATES];
}

/**
 * Check if a string is a valid predicate
 */
export function isValidPredicate(predicate: string): predicate is Predicate {
  return PREDICATES.includes(predicate as Predicate);
}

/**
 * Predicate categories for grouping and UI display
 */
export const PredicateCategories = {
  stateMachine: ['HAS_STATE', 'TRANSITIONS_TO', 'FROM_STATE', 'TO_STATE', 'TRIGGERED_BY', 'ABSENCE_OF', 'WITHIN'] as const,
  domainRules: ['ABOUT_RESOURCE', 'REQUIRES', 'CONTAINS', 'IMPLEMENTS'] as const,
  authorization: ['ROLE_CAN', 'REQUIRES_ROLE'] as const,
  serviceArchitecture: ['DEPENDS_ON', 'EXPOSES_ENDPOINT', 'CALLS', 'CONSUMES_ENDPOINT', 'PRODUCES_EVENT', 'SUBSCRIBES_EVENT'] as const,
  dataLayer: ['STORES_IN', 'READS_FROM', 'WRITES_TO', 'PUBLISHES_TO', 'SUBSCRIBES_TO', 'CACHES_IN'] as const,
  legacy: ['SUPPORTS', 'CONTRADICTS', 'HAS_OPTION', 'SELECTS', 'IN_SCOPE', 'OUT_OF_SCOPE', 'DUE_DATE', 'REJECTS', 'DEFERS'] as const,
} as const;

/**
 * Behaviour-related predicates (for backward compatibility)
 */
export const BEHAVIOUR_PREDICATES = [
  'HAS_STATE',
  'HAS_OPTION',
  'TRANSITIONS_TO',
  'TRIGGERED_BY',
  'ABSENCE_OF',
  'WITHIN',
] as const;

export type BehaviourPredicate = typeof BEHAVIOUR_PREDICATES[number];

// ============================================================================
// Canonical Semantics Constants
// ============================================================================

/**
 * Canonical predicates - ALWAYS produced after MX stage.
 * These represent the final graph structure regardless of what was extracted.
 * 
 * @see docs/STATE-MACHINE-CANONICAL-SEMANTICS.md
 */
export const CANONICAL_PREDICATES = {
  // State machine core (canonical directions)
  FROM_STATE: 'FROM_STATE',   // state → transition
  TO_STATE: 'TO_STATE',       // transition → state
  TRIGGERS: 'TRIGGERS',       // action|event → transition
  HAS_STATE: 'HAS_STATE',     // resource → state
  
  // Role-based
  ROLE_CAN: 'ROLE_CAN',             // role → action/endpoint
  REQUIRES_ROLE: 'REQUIRES_ROLE',   // endpoint → role
  
  // Domain
  REQUIRES: 'REQUIRES',       // Generic requirement
  CONTAINS: 'CONTAINS',       // Containment
  IMPLEMENTS: 'IMPLEMENTS',   // Implementation
  DEPENDS_ON: 'DEPENDS_ON',   // Dependency
} as const;

export type CanonicalPredicate = typeof CANONICAL_PREDICATES[keyof typeof CANONICAL_PREDICATES];

/**
 * Extracted predicates - produced by LLM, LOWERED by MX stage.
 * These should NOT appear in post-MX output.
 * 
 * @see docs/STATE-MACHINE-CANONICAL-SEMANTICS.md
 */
export const EXTRACTED_PREDICATES = {
  /** Lowered to: FROM_STATE + TO_STATE (creates transition entity) */
  TRANSITIONS_TO: 'TRANSITIONS_TO',
  /** Inverted to: TRIGGERS (direction flip) */
  TRIGGERED_BY: 'TRIGGERED_BY',
} as const;

export type ExtractedPredicate = typeof EXTRACTED_PREDICATES[keyof typeof EXTRACTED_PREDICATES];

/**
 * Projection types - synthesized by MX for convenience.
 * Must be marked with _projection metadata.
 * 
 * @see docs/STATE-MACHINE-CANONICAL-SEMANTICS.md
 */
export const PROJECTION_TYPES = {
  /** Entry point: initial pseudo-state → first real state */
  ENTRY_TRANSITION: 'entry-transition',
  /** Exit point: last state → final pseudo-state */
  EXIT_TRANSITION: 'exit-transition',
  /** Inverse view for query convenience (deprecated) */
  INVERSE_VIEW: 'inverse-view',
} as const;

export type ProjectionType = typeof PROJECTION_TYPES[keyof typeof PROJECTION_TYPES];

/**
 * Check if a predicate is canonical (should appear in post-MX output)
 */
export function isCanonicalPredicate(predicate: string): predicate is CanonicalPredicate {
  return Object.values(CANONICAL_PREDICATES).includes(predicate as CanonicalPredicate);
}

/**
 * Check if a predicate is extracted (should NOT appear in post-MX output)
 */
export function isExtractedPredicate(predicate: string): predicate is ExtractedPredicate {
  return Object.values(EXTRACTED_PREDICATES).includes(predicate as ExtractedPredicate);
}
