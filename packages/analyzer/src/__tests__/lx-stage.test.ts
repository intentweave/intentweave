/**
 * LX Stage Tests - Phase 1.8
 * 
 * Tests for the LX stage placeholder (cross-artifact linking).
 */

import { describe, it, expect } from 'vitest';
import { runLxCore, createEmptyLxOutput } from '../agg/lx.js';
import type { LxStageInput, LxStageOptions } from '../agg/lx.js';

describe('LX Stage (Phase 1 Placeholder)', () => {
  const defaultOptions: LxStageOptions = {
    workspaceKey: 'test-workspace',
    runId: 'run-123',
  };

  describe('runLxCore', () => {
    it('returns empty proposals (Phase 1 placeholder)', async () => {
      const input: LxStageInput = {
        artifacts: [
          {
            id: 'artifact-1',
            filePath: 'spec/auth.md',
            entities: [
              { cgId: 'cg:test:entity:admin', name: 'Admin', type: 'role' },
              { cgId: 'cg:test:entity:user', name: 'User', type: 'role' },
            ],
          },
          {
            id: 'artifact-2',
            filePath: 'impl/auth.ts',
            entities: [
              { cgId: 'cg:test:entity:admin-impl', name: 'AdminService', type: 'service' },
            ],
          },
        ],
      };

      const result = await runLxCore(input, defaultOptions);

      expect(result.schemaVersion).toBe('0.1');
      expect(result.stage).toBe('LX');
      expect(result.runId).toBe('run-123');
      expect(result.workspaceKey).toBe('test-workspace');
      expect(result.proposals).toEqual([]);
      expect(result.meta.entitiesAnalyzed).toBe(3);
      expect(result.meta.proposalsGenerated).toBe(0);
      expect(result.meta.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('handles empty artifact list', async () => {
      const input: LxStageInput = { artifacts: [] };

      const result = await runLxCore(input, defaultOptions);

      expect(result.proposals).toEqual([]);
      expect(result.meta.entitiesAnalyzed).toBe(0);
    });

    it('includes generatedAt timestamp', async () => {
      const input: LxStageInput = { artifacts: [] };

      const result = await runLxCore(input, defaultOptions);

      expect(result.generatedAt).toBeDefined();
      expect(new Date(result.generatedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('createEmptyLxOutput', () => {
    it('creates valid empty LX output', () => {
      const result = createEmptyLxOutput('run-456', 'my-workspace');

      expect(result.schemaVersion).toBe('0.1');
      expect(result.stage).toBe('LX');
      expect(result.runId).toBe('run-456');
      expect(result.workspaceKey).toBe('my-workspace');
      expect(result.proposals).toEqual([]);
      expect(result.meta.entitiesAnalyzed).toBe(0);
      expect(result.meta.proposalsGenerated).toBe(0);
      expect(result.meta.processingTimeMs).toBe(0);
    });

    it('can be serialized to JSON (for lx.json)', () => {
      const result = createEmptyLxOutput('run-789', 'test-ws');

      const json = JSON.stringify(result, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.schemaVersion).toBe('0.1');
      expect(parsed.stage).toBe('LX');
      expect(parsed.runId).toBe('run-789');
      expect(parsed.workspaceKey).toBe('test-ws');
      expect(parsed.proposals).toEqual([]);
    });
  });

  describe('lx.json IO contract', () => {
    it('LX output matches expected lx.json schema', () => {
      const output = createEmptyLxOutput('run-test', 'test-ws');

      // Verify all required fields are present
      expect(output).toHaveProperty('schemaVersion');
      expect(output).toHaveProperty('stage');
      expect(output).toHaveProperty('runId');
      expect(output).toHaveProperty('workspaceKey');
      expect(output).toHaveProperty('generatedAt');
      expect(output).toHaveProperty('proposals');
      expect(output).toHaveProperty('meta');
      expect(output.meta).toHaveProperty('entitiesAnalyzed');
      expect(output.meta).toHaveProperty('proposalsGenerated');
      expect(output.meta).toHaveProperty('processingTimeMs');
    });
  });
});
