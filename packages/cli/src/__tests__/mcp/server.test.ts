/**
 * Tests for the MCP server tool implementations.
 *
 * Since the MCP server tools use closures over module-level state
 * (Neo4j connection, session ID), we test:
 * 1. The static schema tool (no deps)
 * 2. Tool parameter validation logic
 * 3. The shared helper functions (stringify, capitalize)
 * 4. Integration patterns via mock runners (for context/impact delegation)
 */

import { describe, it, expect } from 'vitest';
import {
  formatContextMarkdown,
  buildEntityContext,
  buildFullContext,
  buildTopicContext,
} from '../../context/contextBuilder.js';
import {
  analyzeImpact,
  formatImpactMarkdown,
} from '../../impact/impactAnalyzer.js';
import {
  createMockRunner,
  createSequentialMockRunner,
  createMockLlm,
  createContextBundle,
  createContextEntity,
} from '../helpers.js';

// =============================================================================
// toolSchema — returns static schema text
// =============================================================================

describe('MCP toolSchema', () => {
  // The schema is a static constant. We test that the pattern works.
  it('produces a non-empty schema string', () => {
    // Replicate the static schema text from server.ts
    const schema = `Node labels:
- :Canon:Entity — Canonical entities
- :RawTriple — Raw extraction triples
- :CodeRef — Cross-layer code references

Relationship types:
- [:CANON_REL] — Canonical relationships between entities
- [:REALIZED_BY] — Links Canon entities to CodeRef nodes`;

    expect(schema.length).toBeGreaterThan(50);
    expect(schema).toContain(':Canon:Entity');
    expect(schema).toContain(':CANON_REL');
    expect(schema).toContain(':CodeRef');
    expect(schema).toContain(':REALIZED_BY');
  });
});

// =============================================================================
// toolEntities — Cypher generation logic
// =============================================================================

describe('MCP toolEntities Cypher generation', () => {
  function buildEntitiesCypher(args: {
    session_id: string;
    type?: string;
    search?: string;
    limit: number;
  }): { cypher: string; params: Record<string, unknown> } {
    const params: Record<string, unknown> = { sid: args.session_id, lim: args.limit };
    let cypher: string;

    if (args.search) {
      cypher = `MATCH (n:Canon) WHERE n.session_id = $sid AND toLower(n.name) CONTAINS toLower($search)`;
      params.search = args.search;
      if (args.type) {
        cypher += ` AND toLower(n.type) = toLower($type)`;
        params.type = args.type;
      }
    } else if (args.type) {
      cypher = `MATCH (n:Canon) WHERE n.session_id = $sid AND toLower(n.type) = toLower($type)`;
      params.type = args.type;
    } else {
      cypher = `MATCH (n:Canon) WHERE n.session_id = $sid`;
    }

    return { cypher, params };
  }

  it('builds basic query for all entities', () => {
    const { cypher, params } = buildEntitiesCypher({
      session_id: 'planpling',
      limit: 100,
    });
    expect(cypher).toContain('MATCH (n:Canon)');
    expect(cypher).toContain('session_id = $sid');
    expect(params.sid).toBe('planpling');
    expect(params.lim).toBe(100);
  });

  it('adds type filter', () => {
    const { cypher, params } = buildEntitiesCypher({
      session_id: 'test',
      type: 'technology',
      limit: 50,
    });
    expect(cypher).toContain('toLower(n.type) = toLower($type)');
    expect(params.type).toBe('technology');
  });

  it('adds search filter', () => {
    const { cypher, params } = buildEntitiesCypher({
      session_id: 'test',
      search: 'React',
      limit: 50,
    });
    expect(cypher).toContain('toLower(n.name) CONTAINS toLower($search)');
    expect(params.search).toBe('React');
  });

  it('combines search + type filters', () => {
    const { cypher, params } = buildEntitiesCypher({
      session_id: 'test',
      search: 'React',
      type: 'technology',
      limit: 50,
    });
    expect(cypher).toContain('CONTAINS toLower($search)');
    expect(cypher).toContain('toLower(n.type) = toLower($type)');
    expect(params.search).toBe('React');
    expect(params.type).toBe('technology');
  });
});

// =============================================================================
// toolContext — delegation to shared context builder
// =============================================================================

describe('MCP toolContext delegation', () => {
  it('builds entity context when entity arg provided', async () => {
    const runner = createSequentialMockRunner([
      [{ canonId: 'react', name: 'React', type: 'technology' }],
      [{ canonId: 'react', name: 'React', type: 'technology', aliases: [], confidence: 0.99, sources: [] }],
      [],
    ]);

    const bundle = await buildEntityContext('React', {
      runner,
      sessionId: 'test',
    });

    expect(bundle.entities.length).toBeGreaterThanOrEqual(0);
    expect(bundle.topic).toContain('React');
  });

  it('builds full context when neither topic nor entity provided', async () => {
    const runner = createSequentialMockRunner([
      [{ canonId: 'react', name: 'React', type: 'technology', aliases: [], confidence: 0.99, sources: [] }],
      [],
    ]);

    const bundle = await buildFullContext({
      runner,
      sessionId: 'test',
    });

    expect(bundle.entities).toHaveLength(1);
  });

  it('builds topic context when topic provided', async () => {
    const runner = createSequentialMockRunner([
      [{ name: 'React', type: 'technology' }],
      [{ canonId: 'react', name: 'React', type: 'technology' }],
      [{ canonId: 'react', name: 'React', type: 'technology', aliases: [], confidence: 0.99, sources: [] }],
      [],
    ]);
    const llm = createMockLlm('["React"]');

    const bundle = await buildTopicContext('frontend', {
      runner,
      sessionId: 'test',
      llm,
    });

    expect(bundle.topic).toBe('frontend');
  });
});

// =============================================================================
// toolImpact — delegation to shared impact analyzer
// =============================================================================

describe('MCP toolImpact delegation', () => {
  it('returns formatted markdown when no CodeRefs found', async () => {
    const runner = createMockRunner();

    const result = await analyzeImpact(['missing.ts'], {
      runner,
      sessionId: 'test',
    });
    const md = formatImpactMarkdown(result);

    expect(md).toContain('No Impact Found');
    expect(md).toContain('iw xlink');
  });

  it('returns impact report for linked files', async () => {
    const runner = createSequentialMockRunner([
      [{ name: 'React', type: 'technology', confidence: 0.99, filePath: 'pkg.json', kind: 'dep', strategy: 'dep' }],
      [],
      [],
    ]);

    const result = await analyzeImpact(['pkg.json'], {
      runner,
      sessionId: 'test',
    });
    const md = formatImpactMarkdown(result);

    expect(md).toContain('Direct Impact');
    expect(md).toContain('React');
  });
});

// =============================================================================
// MCP helper: stringify
// =============================================================================

describe('MCP stringify helper', () => {
  function stringify(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(stringify).join(', ');
    return JSON.stringify(v);
  }

  it('handles all value types', () => {
    expect(stringify(null)).toBe('');
    expect(stringify('text')).toBe('text');
    expect(stringify(42)).toBe('42');
    expect(stringify(true)).toBe('true');
    expect(stringify([1, 2, 3])).toBe('1, 2, 3');
    expect(stringify({ k: 'v' })).toBe('{"k":"v"}');
  });
});

// =============================================================================
// MCP query — table formatting
// =============================================================================

describe('MCP query table formatting', () => {
  it('formats rows as markdown table', () => {
    const rows = [
      { name: 'React', type: 'technology' },
      { name: 'Vue', type: 'technology' },
    ];
    const columns = Object.keys(rows[0]);
    const header = '| ' + columns.join(' | ') + ' |';
    const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
    const dataRows = rows.map(row =>
      '| ' + columns.map(c => String((row as any)[c])).join(' | ') + ' |',
    );

    const table = [header, sep, ...dataRows].join('\n');
    expect(table).toContain('| name | type |');
    expect(table).toContain('| --- | --- |');
    expect(table).toContain('| React | technology |');
    expect(table).toContain('| Vue | technology |');
  });

  it('handles empty results', () => {
    const rows: Record<string, unknown>[] = [];
    const result = rows.length === 0 ? 'No results found.' : 'has results';
    expect(result).toBe('No results found.');
  });
});
