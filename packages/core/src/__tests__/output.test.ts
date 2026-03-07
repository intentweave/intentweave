// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Canonical Output Utilities
 */

import { describe, it, expect } from 'vitest';
import {
  createCanonicalHeader,
  toCanonicalJson,
  toCanonicalJsonWithHeader,
  withCanonicalHeader,
  sortKeys,
  SCHEMA_URIS,
  RUN_META_FIELD_ORDER,
  STAGE_OUTPUT_FIELD_ORDER,
} from '../output/index.js';

describe('Canonical Output Utilities', () => {
  describe('SCHEMA_URIS', () => {
    it('should have all stage schemas', () => {
      expect(SCHEMA_URIS.in).toBe('intentweave://schemas/in-graph/v1');
      expect(SCHEMA_URIS.rx).toBe('intentweave://schemas/rx-graph/v1');
      expect(SCHEMA_URIS.cx).toBe('intentweave://schemas/cx-graph/v1');
      expect(SCHEMA_URIS.mx).toBe('intentweave://schemas/mx-graph/v1');
      expect(SCHEMA_URIS.px).toBe('intentweave://schemas/px-graph/v1');
      expect(SCHEMA_URIS.lx).toBe('intentweave://schemas/lx-proposals/v1');
      expect(SCHEMA_URIS.coverage).toBe('intentweave://schemas/coverage/v1');
      expect(SCHEMA_URIS.findings).toBe('intentweave://schemas/findings/v1');
      expect(SCHEMA_URIS.runMeta).toBe('intentweave://schemas/run-meta/v1');
    });
  });

  describe('createCanonicalHeader', () => {
    it('should create header with correct schema URI', () => {
      const header = createCanonicalHeader('px');
      expect(header.$schema).toBe('intentweave://schemas/px-graph/v1');
      expect(header.schemaVersion).toBe('0.1');
      expect(header.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should use provided timestamp', () => {
      const timestamp = '2026-01-14T12:00:00.000Z';
      const header = createCanonicalHeader('runMeta', timestamp);
      expect(header.processedAt).toBe(timestamp);
    });

    it('should work for all schema types', () => {
      const types = ['in', 'rx', 'cx', 'mx', 'px', 'lx', 'coverage', 'findings', 'runMeta'] as const;
      for (const type of types) {
        const header = createCanonicalHeader(type);
        expect(header.$schema).toContain('intentweave://schemas/');
        expect(header.schemaVersion).toBe('0.1');
      }
    });
  });

  describe('toCanonicalJson', () => {
    it('should produce JSON with header fields first', () => {
      const data = { stage: 'PX', artifactId: 'test' };
      const json = toCanonicalJson('px', data);
      const parsed = JSON.parse(json);
      
      // Check order by getting keys
      const keys = Object.keys(parsed);
      expect(keys[0]).toBe('$schema');
      expect(keys[1]).toBe('schemaVersion');
      expect(keys[2]).toBe('processedAt');
    });

    it('should include all data fields', () => {
      const data = {
        stage: 'PX',
        artifactId: 'test',
        entities: [{ cgId: 'test|model|kg|entity' }],
      };
      const json = toCanonicalJson('px', data);
      const parsed = JSON.parse(json);
      
      expect(parsed.stage).toBe('PX');
      expect(parsed.artifactId).toBe('test');
      expect(parsed.entities).toEqual([{ cgId: 'test|model|kg|entity' }]);
    });

    it('should add trailing newline by default', () => {
      const json = toCanonicalJson('px', { stage: 'PX' });
      expect(json.endsWith('\n')).toBe(true);
    });

    it('should respect trailingNewline option', () => {
      const json = toCanonicalJson('px', { stage: 'PX' }, { trailingNewline: false });
      expect(json.endsWith('\n')).toBe(false);
    });

    it('should respect indent option', () => {
      const json4 = toCanonicalJson('px', { stage: 'PX' }, { indent: 4 });
      expect(json4).toContain('    '); // 4 spaces
      
      const json0 = toCanonicalJson('px', { stage: 'PX' }, { indent: 0 });
      expect(json0).not.toContain('\n  '); // No indentation in body
    });
  });

  describe('toCanonicalJsonWithHeader', () => {
    it('should preserve existing header fields', () => {
      const data = {
        $schema: 'intentweave://schemas/px-graph/v1',
        schemaVersion: '0.1' as const,
        processedAt: '2026-01-01T00:00:00.000Z',
        stage: 'PX',
        artifactId: 'test',
      };
      const json = toCanonicalJsonWithHeader(data);
      const parsed = JSON.parse(json);
      
      expect(parsed.processedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(parsed.stage).toBe('PX');
    });
  });

  describe('withCanonicalHeader', () => {
    it('should add header fields to object', () => {
      const data = { stage: 'PX', artifactId: 'test' };
      const result = withCanonicalHeader('px', data);
      
      expect(result.$schema).toBe('intentweave://schemas/px-graph/v1');
      expect(result.schemaVersion).toBe('0.1');
      expect(result.processedAt).toBeDefined();
      expect(result.stage).toBe('PX');
      expect(result.artifactId).toBe('test');
    });
  });

  describe('sortKeys', () => {
    it('should sort keys according to preferred order', () => {
      const obj = {
        error: 'test',
        runId: 'run-1',
        $schema: 'test://schema',
        status: 'completed',
      };
      
      const sorted = sortKeys(obj, RUN_META_FIELD_ORDER);
      const keys = Object.keys(sorted);
      
      expect(keys.indexOf('$schema')).toBeLessThan(keys.indexOf('runId'));
      expect(keys.indexOf('runId')).toBeLessThan(keys.indexOf('status'));
      expect(keys.indexOf('status')).toBeLessThan(keys.indexOf('error'));
    });

    it('should preserve keys not in preferred order', () => {
      const obj = {
        customField: 'value',
        $schema: 'test://schema',
        anotherCustom: 123,
      };
      
      const sorted = sortKeys(obj, RUN_META_FIELD_ORDER);
      expect(sorted.customField).toBe('value');
      expect(sorted.anotherCustom).toBe(123);
    });
  });

  describe('field order constants', () => {
    it('RUN_META_FIELD_ORDER should start with header fields', () => {
      expect(RUN_META_FIELD_ORDER[0]).toBe('$schema');
      expect(RUN_META_FIELD_ORDER[1]).toBe('schemaVersion');
      expect(RUN_META_FIELD_ORDER[2]).toBe('processedAt');
    });

    it('STAGE_OUTPUT_FIELD_ORDER should start with header fields', () => {
      expect(STAGE_OUTPUT_FIELD_ORDER[0]).toBe('$schema');
      expect(STAGE_OUTPUT_FIELD_ORDER[1]).toBe('schemaVersion');
      expect(STAGE_OUTPUT_FIELD_ORDER[2]).toBe('processedAt');
    });
  });
});
