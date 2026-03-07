// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for persist-neo4j helper functions.
 *
 * Focus areas:
 * - relKey: relationship fingerprint key
 * - rawKey: raw triple fingerprint key
 * - DeltaStats type structure
 * - Delta diff computation logic
 */

import { describe, it, expect } from 'vitest';

// =============================================================================
// relKey — reimplemented from persist-neo4j.ts
// =============================================================================

function relKey(subjectCanonId: string, predicate: string, objectCanonId: string): string {
  return `${subjectCanonId}|${predicate}|${objectCanonId}`;
}

describe('relKey', () => {
  it('formats as subj|pred|obj', () => {
    expect(relKey('react', 'USES', 'frontend')).toBe('react|USES|frontend');
  });

  it('preserves case', () => {
    expect(relKey('React', 'DECIDED_FOR', 'TypeScript')).toBe('React|DECIDED_FOR|TypeScript');
  });

  it('handles empty components', () => {
    expect(relKey('', 'REL', '')).toBe('|REL|');
  });

  it('produces unique keys for different triples', () => {
    const k1 = relKey('a', 'USES', 'b');
    const k2 = relKey('b', 'USES', 'a');
    const k3 = relKey('a', 'DEPENDS_ON', 'b');
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });
});

// =============================================================================
// rawKey — reimplemented from persist-neo4j.ts
// =============================================================================

function rawKey(subject: string, predicate: string, object: string): string {
  return `${subject.toLowerCase()}|${predicate.toLowerCase()}|${object.toLowerCase()}`;
}

describe('rawKey', () => {
  it('lowercases all components', () => {
    expect(rawKey('React', 'USES', 'Frontend')).toBe('react|uses|frontend');
  });

  it('deduplicates case variations', () => {
    const k1 = rawKey('react', 'uses', 'frontend');
    const k2 = rawKey('React', 'USES', 'Frontend');
    expect(k1).toBe(k2);
  });
});

// =============================================================================
// Delta diff computation logic
// =============================================================================

describe('delta diff computation', () => {
  interface Entity {
    canonId: string;
    name: string;
    type: string;
    confidence: number;
    aliases: string[];
  }

  function computeEntityDiff(
    incoming: Map<string, Entity>,
    existing: Map<string, { name: string; type: string; confidence: number; aliases: string[] }>,
  ) {
    const toAdd: Entity[] = [];
    const toUpdate: Entity[] = [];
    const toRemove: string[] = [];
    let unchanged = 0;

    for (const [canonId, entity] of incoming) {
      const ex = existing.get(canonId);
      if (!ex) {
        toAdd.push(entity);
      } else if (
        entity.confidence !== ex.confidence ||
        entity.name !== ex.name ||
        entity.type !== ex.type ||
        JSON.stringify([...entity.aliases].sort()) !== JSON.stringify([...ex.aliases].sort())
      ) {
        toUpdate.push(entity);
      } else {
        unchanged++;
      }
    }
    for (const canonId of existing.keys()) {
      if (!incoming.has(canonId)) {
        toRemove.push(canonId);
      }
    }

    return { toAdd, toUpdate, toRemove, unchanged };
  }

  it('detects new entities', () => {
    const incoming = new Map([
      ['react', { canonId: 'react', name: 'React', type: 'technology', confidence: 0.95, aliases: [] }],
    ]);
    const existing = new Map<string, any>();

    const diff = computeEntityDiff(incoming, existing);
    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toRemove).toHaveLength(0);
    expect(diff.unchanged).toBe(0);
  });

  it('detects unchanged entities', () => {
    const entity = { canonId: 'react', name: 'React', type: 'technology', confidence: 0.95, aliases: ['react.js'] };
    const incoming = new Map([['react', entity]]);
    const existing = new Map([['react', { name: 'React', type: 'technology', confidence: 0.95, aliases: ['react.js'] }]]);

    const diff = computeEntityDiff(incoming, existing);
    expect(diff.unchanged).toBe(1);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it('detects updated entities (confidence change)', () => {
    const entity = { canonId: 'react', name: 'React', type: 'technology', confidence: 0.99, aliases: [] };
    const incoming = new Map([['react', entity]]);
    const existing = new Map([['react', { name: 'React', type: 'technology', confidence: 0.85, aliases: [] }]]);

    const diff = computeEntityDiff(incoming, existing);
    expect(diff.toUpdate).toHaveLength(1);
  });

  it('detects updated entities (name change)', () => {
    const entity = { canonId: 'react', name: 'ReactJS', type: 'technology', confidence: 0.95, aliases: [] };
    const incoming = new Map([['react', entity]]);
    const existing = new Map([['react', { name: 'React', type: 'technology', confidence: 0.95, aliases: [] }]]);

    const diff = computeEntityDiff(incoming, existing);
    expect(diff.toUpdate).toHaveLength(1);
  });

  it('detects removed entities', () => {
    const incoming = new Map<string, Entity>();
    const existing = new Map([['react', { name: 'React', type: 'technology', confidence: 0.95, aliases: [] }]]);

    const diff = computeEntityDiff(incoming, existing);
    expect(diff.toRemove).toEqual(['react']);
  });

  it('handles mixed add/update/remove/unchanged', () => {
    const incoming = new Map([
      ['react', { canonId: 'react', name: 'React', type: 'technology', confidence: 0.95, aliases: [] }],
      ['vue', { canonId: 'vue', name: 'Vue.js', type: 'technology', confidence: 0.9, aliases: [] }], // updated name
      ['svelte', { canonId: 'svelte', name: 'Svelte', type: 'technology', confidence: 0.8, aliases: [] }], // new
    ]);
    const existing = new Map([
      ['react', { name: 'React', type: 'technology', confidence: 0.95, aliases: [] }], // unchanged
      ['vue', { name: 'Vue', type: 'technology', confidence: 0.9, aliases: [] }], // will be updated
      ['angular', { name: 'Angular', type: 'technology', confidence: 0.85, aliases: [] }], // will be removed
    ]);

    const diff = computeEntityDiff(incoming, existing);
    expect(diff.toAdd).toHaveLength(1);
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toRemove).toEqual(['angular']);
    expect(diff.unchanged).toBe(1);
  });

  it('treats alias order differences as unchanged', () => {
    const entity = { canonId: 'react', name: 'React', type: 'technology', confidence: 0.95, aliases: ['react.js', 'reactjs'] };
    const incoming = new Map([['react', entity]]);
    const existing = new Map([['react', { name: 'React', type: 'technology', confidence: 0.95, aliases: ['reactjs', 'react.js'] }]]);

    const diff = computeEntityDiff(incoming, existing);
    expect(diff.unchanged).toBe(1);
  });
});

// =============================================================================
// Relationship diff key-based matching
// =============================================================================

describe('relationship diff computation', () => {
  it('identifies new relationships not in existing', () => {
    const incoming = new Map([
      ['react|USES|jsx', { predicate: 'USES' }],
      ['react|DEPENDS_ON|node', { predicate: 'DEPENDS_ON' }],
    ]);
    const existing = new Map([
      ['react|USES|jsx', { predicate: 'USES', confidence: 0.9 }],
    ]);

    const toAdd = [];
    const unchanged = [];
    for (const [key, triple] of incoming) {
      if (!existing.has(key)) toAdd.push(key);
      else unchanged.push(key);
    }

    expect(toAdd).toEqual(['react|DEPENDS_ON|node']);
    expect(unchanged).toEqual(['react|USES|jsx']);
  });

  it('identifies stale relationships to remove', () => {
    const incoming = new Map([
      ['react|USES|jsx', { predicate: 'USES' }],
    ]);
    const existing = new Map([
      ['react|USES|jsx', { predicate: 'USES', confidence: 0.9 }],
      ['vue|USES|template', { predicate: 'USES', confidence: 0.8 }],
    ]);

    const toRemove = [];
    for (const key of existing.keys()) {
      if (!incoming.has(key)) toRemove.push(key);
    }

    expect(toRemove).toEqual(['vue|USES|template']);
  });
});

// =============================================================================
// Orphan relationship filtering
// =============================================================================

describe('orphan relationship filtering', () => {
  it('skips triples where subject entity does not exist', () => {
    const entities = new Map([['react', true]]);
    const triples = [
      { subjectCanonId: 'react', predicate: 'USES', objectCanonId: 'jsx' },
      { subjectCanonId: 'missing', predicate: 'USES', objectCanonId: 'react' },
    ];

    const valid = triples.filter(t => entities.has(t.subjectCanonId) && entities.has(t.objectCanonId));
    expect(valid).toHaveLength(0); // jsx doesn't exist either
  });

  it('skips triples where object entity does not exist', () => {
    const entities = new Map([['react', true], ['jsx', true]]);
    const triples = [
      { subjectCanonId: 'react', predicate: 'USES', objectCanonId: 'jsx' },
      { subjectCanonId: 'react', predicate: 'USES', objectCanonId: 'ghost' },
    ];

    const valid = triples.filter(t => entities.has(t.subjectCanonId) && entities.has(t.objectCanonId));
    expect(valid).toHaveLength(1);
    expect(valid[0].objectCanonId).toBe('jsx');
  });

  it('keeps all triples when all entities exist', () => {
    const entities = new Map([['a', true], ['b', true], ['c', true]]);
    const triples = [
      { subjectCanonId: 'a', predicate: 'USES', objectCanonId: 'b' },
      { subjectCanonId: 'b', predicate: 'DEPENDS_ON', objectCanonId: 'c' },
    ];

    const valid = triples.filter(t => entities.has(t.subjectCanonId) && entities.has(t.objectCanonId));
    expect(valid).toHaveLength(2);
  });
});
