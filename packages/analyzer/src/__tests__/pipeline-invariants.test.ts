// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline Invariant Tests
 * 
 * These tests protect MX/REF semantics from regressions.
 * They run against pipeline output and assert structural invariants
 * that must hold regardless of input content.
 * 
 * Invariants:
 * - INV-1: No orphan statements (all refs resolve to entities)
 * - INV-2: State machine transitions reference state entities
 * - INV-3: No excessive duplicates (canonical key dedup works)
 * - INV-4: REF resolution complete (no unresolved markers)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Entity, Statement, StagingSnapshot } from '@intentweave/core';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Normalize a name to canonical key form
 * - lowercase
 * - split camelCase
 * - normalize whitespace/dashes/underscores to single dash
 */
function canonicalKey(name: string, type: string): string {
  const normalized = name
    .replace(/([a-z])([A-Z])/g, '$1-$2')  // Split camelCase
    .toLowerCase()
    .replace(/[\s_]+/g, '-')              // Normalize separators
    .replace(/-+/g, '-')                   // Collapse multiple dashes
    .replace(/^-+|-+$/g, '');              // Trim
  
  return `${type}:${normalized}`;
}

/**
 * Check if a cgId looks like an unresolved reference
 */
function isUnresolvedCgId(cgId: string | undefined | null): boolean {
  if (!cgId) return true;
  return cgId.includes('unresolved') || 
         cgId.includes('unknown') || 
         cgId.startsWith('_');
}

// =============================================================================
// Test Fixtures - Minimal snapshots for invariant testing
// =============================================================================

/**
 * Valid snapshot - all invariants should pass
 */
const VALID_SNAPSHOT: StagingSnapshot = {
  entities: [
    {
      cgId: 'ws|model|kg|state/requested',
      name: 'requested',
      type: 'state',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
    {
      cgId: 'ws|model|kg|state/approved',
      name: 'approved',
      type: 'state',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
    {
      cgId: 'ws|model|kg|role/admin',
      name: 'admin',
      type: 'role',
      confidence: 0.85,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
  ],
  statements: [
    {
      subjectCgId: 'ws|model|kg|state/requested',
      predicate: 'TRANSITIONS_TO',
      objectCgId: 'ws|model|kg|state/approved',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      origin: 'test',
      state: 'committed',
    },
  ],
};

/**
 * Snapshot with orphan statement (subject doesn't exist)
 */
const ORPHAN_SUBJECT_SNAPSHOT: StagingSnapshot = {
  entities: [
    {
      cgId: 'ws|model|kg|state/approved',
      name: 'approved',
      type: 'state',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
  ],
  statements: [
    {
      subjectCgId: 'ws|model|kg|state/nonexistent',  // No matching entity!
      predicate: 'TRANSITIONS_TO',
      objectCgId: 'ws|model|kg|state/approved',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      origin: 'test',
      state: 'committed',
    },
  ],
};

/**
 * Snapshot with orphan statement (object doesn't exist)
 */
const ORPHAN_OBJECT_SNAPSHOT: StagingSnapshot = {
  entities: [
    {
      cgId: 'ws|model|kg|state/requested',
      name: 'requested',
      type: 'state',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
  ],
  statements: [
    {
      subjectCgId: 'ws|model|kg|state/requested',
      predicate: 'TRANSITIONS_TO',
      objectCgId: 'ws|model|kg|state/missing',  // No matching entity!
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      origin: 'test',
      state: 'committed',
    },
  ],
};

/**
 * Snapshot with unresolved reference marker
 */
const UNRESOLVED_REF_SNAPSHOT: StagingSnapshot = {
  entities: [
    {
      cgId: 'ws|model|kg|state/active',
      name: 'active',
      type: 'state',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
  ],
  statements: [
    {
      subjectCgId: 'ws|model|kg|state/active',
      predicate: 'TRANSITIONS_TO',
      objectCgId: '_unresolved:inactive',  // Unresolved marker!
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      origin: 'test',
      state: 'committed',
    } as Statement,  // Cast needed for the invalid cgId
  ],
};

/**
 * Snapshot with duplicate entities
 */
const DUPLICATE_ENTITIES_SNAPSHOT: StagingSnapshot = {
  entities: [
    {
      cgId: 'ws|model|kg|state/active',
      name: 'active',
      type: 'state',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
    {
      cgId: 'ws|model|kg|state/active-2',
      name: 'Active',  // Same as above, different casing
      type: 'state',
      confidence: 0.85,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
    {
      cgId: 'ws|model|kg|state/pending',
      name: 'pending',
      type: 'state',
      confidence: 0.9,
      labels: ['Test'],
      evidence: [],
      source: 'test',
      origin: 'test',
      state: 'committed',
    },
  ],
  statements: [],
};

// =============================================================================
// Invariant Check Functions
// =============================================================================

/**
 * INV-1: Check for orphan statements (refs that don't resolve to entities)
 * Returns list of orphan statement descriptions
 */
function checkOrphanStatements(snapshot: StagingSnapshot): string[] {
  const entityIds = new Set(snapshot.entities.map(e => e.cgId));
  const orphans: string[] = [];
  
  for (const stmt of snapshot.statements) {
    if (!entityIds.has(stmt.subjectCgId)) {
      orphans.push(`Subject not found: ${stmt.subjectCgId} (predicate: ${stmt.predicate})`);
    }
    if (stmt.objectCgId && !entityIds.has(stmt.objectCgId)) {
      orphans.push(`Object not found: ${stmt.objectCgId} (predicate: ${stmt.predicate})`);
    }
  }
  
  return orphans;
}

/**
 * INV-2: Check state machine invariants
 * TRANSITIONS_TO subject and object must be state entities
 */
function checkStateMachineInvariants(snapshot: StagingSnapshot): string[] {
  const stateEntityIds = new Set(
    snapshot.entities
      .filter(e => e.type === 'state')
      .map(e => e.cgId)
  );
  const violations: string[] = [];
  
  for (const stmt of snapshot.statements) {
    if (stmt.predicate === 'TRANSITIONS_TO') {
      if (!stateEntityIds.has(stmt.subjectCgId)) {
        violations.push(`TRANSITIONS_TO subject is not a state: ${stmt.subjectCgId}`);
      }
      if (stmt.objectCgId && !stateEntityIds.has(stmt.objectCgId)) {
        violations.push(`TRANSITIONS_TO object is not a state: ${stmt.objectCgId}`);
      }
    }
  }
  
  return violations;
}

/**
 * INV-3: Check duplicate rate
 * Returns the duplicate rate (0.0 - 1.0) and list of duplicates
 */
function checkDuplicates(snapshot: StagingSnapshot): { rate: number; duplicates: string[] } {
  const canonicalKeys = snapshot.entities.map(e => canonicalKey(e.name, e.type));
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  
  for (let i = 0; i < canonicalKeys.length; i++) {
    const key = canonicalKeys[i];
    const prevIndex = seen.get(key);
    if (prevIndex !== undefined) {
      duplicates.push(`${key} (entities ${prevIndex} and ${i})`);
    }
    seen.set(key, i);
  }
  
  const rate = canonicalKeys.length > 0 
    ? duplicates.length / canonicalKeys.length 
    : 0;
  
  return { rate, duplicates };
}

/**
 * INV-4: Check for unresolved reference markers
 * Returns list of statements with unresolved refs
 */
function checkUnresolvedRefs(snapshot: StagingSnapshot): string[] {
  const unresolved: string[] = [];
  
  for (const stmt of snapshot.statements) {
    if (isUnresolvedCgId(stmt.subjectCgId)) {
      unresolved.push(`Unresolved subject: ${stmt.subjectCgId} (predicate: ${stmt.predicate})`);
    }
    if (isUnresolvedCgId(stmt.objectCgId)) {
      unresolved.push(`Unresolved object: ${stmt.objectCgId} (predicate: ${stmt.predicate})`);
    }
    // Check for internal resolution marker
    if ((stmt as Record<string, unknown>)._unresolvedRef) {
      unresolved.push(`_unresolvedRef marker present (predicate: ${stmt.predicate})`);
    }
  }
  
  return unresolved;
}

// =============================================================================
// Tests
// =============================================================================

describe('Pipeline Invariants', () => {
  
  describe('INV-1: No Orphan Statements', () => {
    
    it('passes for valid snapshot with all refs resolved', () => {
      const orphans = checkOrphanStatements(VALID_SNAPSHOT);
      expect(orphans).toEqual([]);
    });
    
    it('detects orphan subject reference', () => {
      const orphans = checkOrphanStatements(ORPHAN_SUBJECT_SNAPSHOT);
      expect(orphans.length).toBeGreaterThan(0);
      expect(orphans[0]).toContain('Subject not found');
      expect(orphans[0]).toContain('nonexistent');
    });
    
    it('detects orphan object reference', () => {
      const orphans = checkOrphanStatements(ORPHAN_OBJECT_SNAPSHOT);
      expect(orphans.length).toBeGreaterThan(0);
      expect(orphans[0]).toContain('Object not found');
      expect(orphans[0]).toContain('missing');
    });
    
  });
  
  describe('INV-2: State Machine Invariants', () => {
    
    it('passes when TRANSITIONS_TO connects state entities', () => {
      const violations = checkStateMachineInvariants(VALID_SNAPSHOT);
      expect(violations).toEqual([]);
    });
    
    it('detects TRANSITIONS_TO with non-state subject', () => {
      const badSnapshot: StagingSnapshot = {
        entities: [
          {
            cgId: 'ws|model|kg|role/admin',
            name: 'admin',
            type: 'role',  // Not a state!
            confidence: 0.9,
            labels: ['Test'],
            evidence: [],
            source: 'test',
            origin: 'test',
            state: 'committed',
          },
          {
            cgId: 'ws|model|kg|state/approved',
            name: 'approved',
            type: 'state',
            confidence: 0.9,
            labels: ['Test'],
            evidence: [],
            source: 'test',
            origin: 'test',
            state: 'committed',
          },
        ],
        statements: [
          {
            subjectCgId: 'ws|model|kg|role/admin',  // Role, not state!
            predicate: 'TRANSITIONS_TO',
            objectCgId: 'ws|model|kg|state/approved',
            confidence: 0.9,
            labels: ['Test'],
            evidence: [],
            origin: 'test',
            state: 'committed',
          },
        ],
      };
      
      const violations = checkStateMachineInvariants(badSnapshot);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain('subject is not a state');
    });
    
  });
  
  describe('INV-3: No Excessive Duplicates', () => {
    
    it('passes for snapshot without duplicates', () => {
      const { rate, duplicates } = checkDuplicates(VALID_SNAPSHOT);
      expect(rate).toBe(0);
      expect(duplicates).toEqual([]);
    });
    
    it('detects duplicate entities by canonical key', () => {
      const { rate, duplicates } = checkDuplicates(DUPLICATE_ENTITIES_SNAPSHOT);
      expect(duplicates.length).toBeGreaterThan(0);
      expect(duplicates[0]).toContain('state:active');
    });
    
    it('duplicate rate calculation is correct', () => {
      // 3 entities, 1 duplicate = 1/3 = ~0.33
      const { rate } = checkDuplicates(DUPLICATE_ENTITIES_SNAPSHOT);
      expect(rate).toBeCloseTo(1/3, 2);
    });
    
  });
  
  describe('INV-4: REF Resolution Complete', () => {
    
    it('passes for snapshot with all refs resolved', () => {
      const unresolved = checkUnresolvedRefs(VALID_SNAPSHOT);
      expect(unresolved).toEqual([]);
    });
    
    it('detects unresolved reference markers in cgId', () => {
      const unresolved = checkUnresolvedRefs(UNRESOLVED_REF_SNAPSHOT);
      expect(unresolved.length).toBeGreaterThan(0);
      expect(unresolved[0]).toContain('Unresolved');
    });
    
  });
  
});

// =============================================================================
// Export invariant checkers for use in pipeline validation
// =============================================================================

export {
  checkOrphanStatements,
  checkStateMachineInvariants,
  checkDuplicates,
  checkUnresolvedRefs,
  canonicalKey,
  isUnresolvedCgId,
};
