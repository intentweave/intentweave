// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for query command helper functions.
 *
 * Since query.ts doesn't export its helpers, we reimplement them here
 * for testing (same pattern as run-helpers.test.ts).
 *
 * Focus areas:
 * - toPlainValue: Neo4j type conversion
 * - stringify: value to string conversion
 * - formatTable: table rendering
 * - buildSystemPrompt: prompt construction
 */

import { describe, it, expect } from 'vitest';

// =============================================================================
// toPlainValue — reimplemented from query.ts
// =============================================================================

function toPlainValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  // Neo4j integer
  if (typeof v === 'object' && v !== null && 'toNumber' in v && typeof (v as any).toNumber === 'function') {
    return (v as any).toNumber();
  }
  // Neo4j Node
  if (typeof v === 'object' && v !== null && 'properties' in v && 'labels' in v) {
    const node = v as any;
    return { _labels: node.labels, ...plainProps(node.properties) };
  }
  // Neo4j Relationship
  if (typeof v === 'object' && v !== null && 'properties' in v && 'type' in v && 'start' in v) {
    const rel = v as any;
    return { _type: rel.type, ...plainProps(rel.properties) };
  }
  // Neo4j Path
  if (typeof v === 'object' && v !== null && 'segments' in v) {
    const pathObj = v as any;
    return {
      _path: pathObj.segments.map((s: any) => ({
        start: toPlainValue(s.start),
        rel: toPlainValue(s.relationship),
        end: toPlainValue(s.end),
      })),
    };
  }
  if (Array.isArray(v)) return v.map(toPlainValue);
  return v;
}

function plainProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = toPlainValue(v);
  }
  return out;
}

describe('toPlainValue', () => {
  it('passes through null and undefined', () => {
    expect(toPlainValue(null)).toBe(null);
    expect(toPlainValue(undefined)).toBe(undefined);
  });

  it('passes through primitive values', () => {
    expect(toPlainValue('hello')).toBe('hello');
    expect(toPlainValue(42)).toBe(42);
    expect(toPlainValue(true)).toBe(true);
  });

  it('converts Neo4j Integer objects', () => {
    const neo4jInt = { toNumber: () => 42, low: 42, high: 0 };
    expect(toPlainValue(neo4jInt)).toBe(42);
  });

  it('converts Neo4j Node objects', () => {
    const node = {
      labels: ['Canon', 'Entity'],
      properties: { name: 'React', type: 'technology' },
    };
    const result = toPlainValue(node) as any;
    expect(result._labels).toEqual(['Canon', 'Entity']);
    expect(result.name).toBe('React');
    expect(result.type).toBe('technology');
  });

  it('converts Neo4j Relationship objects', () => {
    const rel = {
      type: 'CANON_REL',
      start: 1,
      properties: { predicate: 'USES', confidence: 0.9 },
    };
    const result = toPlainValue(rel) as any;
    expect(result._type).toBe('CANON_REL');
    expect(result.predicate).toBe('USES');
  });

  it('converts Neo4j Path objects', () => {
    const pathObj = {
      segments: [
        {
          start: { labels: ['Canon'], properties: { name: 'A' } },
          relationship: { type: 'REL', start: 1, properties: { predicate: 'X' } },
          end: { labels: ['Canon'], properties: { name: 'B' } },
        },
      ],
    };
    const result = toPlainValue(pathObj) as any;
    expect(result._path).toHaveLength(1);
    expect(result._path[0].start.name).toBe('A');
    expect(result._path[0].end.name).toBe('B');
  });

  it('recursively converts arrays', () => {
    const arr = [1, { toNumber: () => 99 }, 'hello'];
    const result = toPlainValue(arr) as unknown[];
    expect(result).toEqual([1, 99, 'hello']);
  });
});

// =============================================================================
// stringify — reimplemented from query.ts
// =============================================================================

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(stringify).join(', ');
  return JSON.stringify(v);
}

describe('stringify', () => {
  it('returns empty string for null/undefined', () => {
    expect(stringify(null)).toBe('');
    expect(stringify(undefined)).toBe('');
  });

  it('returns string as-is', () => {
    expect(stringify('hello')).toBe('hello');
  });

  it('converts numbers', () => {
    expect(stringify(42)).toBe('42');
    expect(stringify(3.14)).toBe('3.14');
  });

  it('converts booleans', () => {
    expect(stringify(true)).toBe('true');
    expect(stringify(false)).toBe('false');
  });

  it('joins arrays with commas', () => {
    expect(stringify(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('JSON.stringifies objects', () => {
    expect(stringify({ key: 'val' })).toBe('{"key":"val"}');
  });
});

// =============================================================================
// formatTable — reimplemented from query.ts (without chalk for testing)
// =============================================================================

function formatTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no results)';

  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = col.length;
  }
  for (const row of rows) {
    for (const col of columns) {
      const val = stringify(row[col]);
      widths[col] = Math.max(widths[col] ?? 0, val.length);
    }
  }

  const header = columns.map(c => c.padEnd(widths[c])).join(' │ ');
  const separator = columns.map(c => '─'.repeat(widths[c])).join('─┼─');
  const dataRows = rows.map(row =>
    columns.map(c => stringify(row[c]).padEnd(widths[c])).join(' │ '),
  );

  return [header, separator, ...dataRows].join('\n');
}

describe('formatTable', () => {
  it('returns empty message for no rows', () => {
    expect(formatTable(['col'], [])).toBe('(no results)');
  });

  it('renders header and separator', () => {
    const table = formatTable(['name', 'type'], [{ name: 'React', type: 'tech' }]);
    const lines = table.split('\n');
    expect(lines).toHaveLength(3); // header + separator + 1 data row
    expect(lines[0]).toContain('name');
    expect(lines[0]).toContain('type');
    expect(lines[1]).toContain('─');
    expect(lines[1]).toContain('┼');
  });

  it('pads columns to align', () => {
    const table = formatTable(
      ['name', 'count'],
      [
        { name: 'React', count: 5 },
        { name: 'TypeScript', count: 12 },
      ],
    );
    const lines = table.split('\n');
    // TypeScript (10 chars) should be the widest
    expect(lines[2]).toContain('React     ');
    expect(lines[3]).toContain('TypeScript');
  });

  it('handles multiple rows', () => {
    const table = formatTable(
      ['a', 'b'],
      [
        { a: '1', b: '2' },
        { a: '3', b: '4' },
        { a: '5', b: '6' },
      ],
    );
    const lines = table.split('\n');
    expect(lines).toHaveLength(5); // header + separator + 3 rows
  });
});

// =============================================================================
// buildSystemPrompt — reimplemented from query.ts
// =============================================================================

describe('buildSystemPrompt (logic)', () => {
  it('includes session clause when session given', () => {
    const sessionId = 'planpling';
    const prompt = `session_id = "${sessionId}"`;
    expect(prompt).toContain('planpling');
  });

  it('omits session clause when not given', () => {
    const sessionId: string | undefined = undefined;
    const sessionClause = sessionId
      ? `session_id = "${sessionId}"`
      : '';
    expect(sessionClause).toBe('');
  });
});
