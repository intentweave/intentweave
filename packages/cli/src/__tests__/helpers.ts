// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared test helpers for CLI package tests.
 *
 * Provides mock implementations of Neo4jRunner, LLMCompleter,
 * and factory functions for building test data.
 */

import type { Neo4jRunner, LLMCompleter, ContextEntity, ContextRelationship, ContextBundle } from '../context/contextBuilder.js';
import type { ImpactResult, ImpactEntity, ImpactRelationship } from '../impact/impactAnalyzer.js';
import type { CrossLink, XLinkResult, CodeRef } from '../linker/crossLayerLinker.js';

// =============================================================================
// Mock Neo4j Runner
// =============================================================================

/**
 * A mock Neo4j runner that returns canned responses keyed by a matcher.
 *
 * Usage:
 *   const runner = createMockRunner([
 *     { match: /MATCH.*Canon/, rows: [{ name: 'React', type: 'technology' }] },
 *     { match: /CodeRef/, rows: [] },
 *   ]);
 *
 * If no pattern matches, returns an empty array.
 */
export interface CypherMock {
  /** Regex or string to match against the Cypher query */
  match: RegExp | string;
  /** Rows to return */
  rows: Record<string, unknown>[];
}

export function createMockRunner(mocks: CypherMock[] = []): Neo4jRunner & { calls: Array<{ cypher: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ cypher: string; params?: Record<string, unknown> }> = [];

  return {
    calls,
    async run(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
      calls.push({ cypher, params });
      for (const mock of mocks) {
        const pattern = typeof mock.match === 'string' ? new RegExp(mock.match) : mock.match;
        if (pattern.test(cypher)) {
          return mock.rows;
        }
      }
      return [];
    },
  };
}

/**
 * Create sequential mock runner — returns rows from an array in order of calls.
 */
export function createSequentialMockRunner(responses: Array<Record<string, unknown>[]>): Neo4jRunner & { calls: Array<{ cypher: string; params?: Record<string, unknown> }> } {
  let callIndex = 0;
  const calls: Array<{ cypher: string; params?: Record<string, unknown> }> = [];

  return {
    calls,
    async run(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
      calls.push({ cypher, params });
      const rows = responses[callIndex] ?? [];
      callIndex++;
      return rows;
    },
  };
}

// =============================================================================
// Mock LLM Completer
// =============================================================================

export function createMockLlm(response: string): LLMCompleter {
  return async () => response;
}

export function createMockLlmSequential(responses: string[]): LLMCompleter {
  let callIndex = 0;
  return async () => {
    const resp = responses[callIndex] ?? '';
    callIndex++;
    return resp;
  };
}

// =============================================================================
// Factory Functions
// =============================================================================

export function createContextEntity(overrides: Partial<ContextEntity> = {}): ContextEntity {
  return {
    canonId: 'test-entity',
    name: 'Test Entity',
    type: 'concept',
    aliases: [],
    confidence: 0.95,
    sources: [],
    ...overrides,
  };
}

export function createContextRelationship(overrides: Partial<ContextRelationship> = {}): ContextRelationship {
  return {
    sourceName: 'Source Entity',
    sourceType: 'concept',
    predicate: 'DEPENDS_ON',
    targetName: 'Target Entity',
    targetType: 'technology',
    confidence: 0.9,
    ...overrides,
  };
}

export function createContextBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    topic: 'test topic',
    sessionId: 'test-session',
    entities: [],
    relationships: [],
    stats: {
      totalEntities: 0,
      totalRelationships: 0,
      entityTypes: {},
      predicateCounts: {},
    },
    ...overrides,
  };
}

export function createImpactEntity(overrides: Partial<ImpactEntity> = {}): ImpactEntity {
  return {
    name: 'Test Entity',
    type: 'concept',
    confidence: 0.95,
    via: 'direct',
    depth: 0,
    ...overrides,
  };
}

export function createImpactRelationship(overrides: Partial<ImpactRelationship> = {}): ImpactRelationship {
  return {
    sourceName: 'Source',
    sourceType: 'concept',
    predicate: 'DEPENDS_ON',
    targetName: 'Target',
    targetType: 'technology',
    confidence: 0.9,
    ...overrides,
  };
}

export function createImpactResult(overrides: Partial<ImpactResult> = {}): ImpactResult {
  return {
    files: ['test.ts'],
    sessionId: 'test-session',
    directEntities: [],
    rippleEntities: [],
    relationships: [],
    decisions: [],
    risks: [],
    stats: {
      filesAnalyzed: 1,
      directCount: 0,
      rippleCount: 0,
      totalRelationships: 0,
      decisionCount: 0,
      riskCount: 0,
    },
    ...overrides,
  };
}

export function createCrossLink(overrides: Partial<CrossLink> = {}): CrossLink {
  return {
    canonName: 'React',
    canonType: 'technology',
    canonId: 'react',
    codeRef: {
      filePath: 'package.json',
      name: 'react',
      kind: 'package-dep',
    },
    strategy: 'dep',
    confidence: 0.99,
    detail: 'Found react in package.json dependencies',
    ...overrides,
  };
}

export function createXLinkResult(overrides: Partial<XLinkResult> = {}): XLinkResult {
  return {
    links: [],
    stats: {
      totalCanonEntities: 0,
      linkedEntities: 0,
      unlinkedEntities: 0,
      totalCodeRefs: 0,
      byStrategy: { dep: 0, import: 0, name: 0, path: 0 },
      byEntityType: {},
    },
    unlinked: [],
    ...overrides,
  };
}
