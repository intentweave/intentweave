/**
 * Ledger Writer Interface Tests
 * 
 * Tests for the LedgerWriter interface and NoopLedgerWriter implementation.
 */

import { describe, it, expect } from 'vitest';
import { NoopLedgerWriter, type LedgerWriteContext, type StagingSnapshot } from '../index.js';

describe('NoopLedgerWriter', () => {
  const writer = new NoopLedgerWriter();
  
  const testSnapshot: StagingSnapshot = {
    entities: [
      {
        cgId: 'resource.user',
        type: 'resource',
        name: 'User',
        labels: ['Staging'],
        evidence: [],
        confidence: 0.9,
        source: 'llm',
        state: 'new',
      },
    ],
    statements: [
      {
        subjectCgId: 'state.idle',
        predicate: 'FROM_STATE',
        objectCgId: 'transition.login',
        confidence: 0.85,
        evidence: [],
        labels: ['Staging'],
        state: 'new',
      },
    ],
  };
  
  const testContext: LedgerWriteContext = {
    turnId: 'turn-001',
    sessionId: 'session-001',
    workspaceId: 'ws-001',
    stage: 'RX',
    profileIds: ['workflow-fsm'],
  };
  
  describe('name', () => {
    it('should be "noop"', () => {
      expect(writer.name).toBe('noop');
    });
  });
  
  describe('writeSnapshot', () => {
    it('should return empty result', async () => {
      const result = await writer.writeSnapshot(testSnapshot, testContext);
      
      expect(result.edgesWritten).toBe(0);
      expect(result.edgesTouched).toBe(0);
      expect(result.nodesWritten).toBe(0);
      expect(result.nodesTouched).toBe(0);
      expect(result.durationMs).toBe(0);
    });
    
    it('should not throw on empty snapshot', async () => {
      const emptySnapshot: StagingSnapshot = { entities: [], statements: [] };
      await expect(writer.writeSnapshot(emptySnapshot, testContext)).resolves.toBeDefined();
    });
  });
  
  describe('touchAssertions', () => {
    it('should not throw', async () => {
      await expect(writer.touchAssertions(['lineage-1', 'lineage-2'], 'turn-001')).resolves.toBeUndefined();
    });
    
    it('should handle empty array', async () => {
      await expect(writer.touchAssertions([], 'turn-001')).resolves.toBeUndefined();
    });
  });
  
  describe('neutralizeAssertions', () => {
    it('should not throw', async () => {
      await expect(
        writer.neutralizeAssertions(['lineage-1'], 'Superseded by new extraction', 'turn-002')
      ).resolves.toBeUndefined();
    });
    
    it('should handle empty array', async () => {
      await expect(
        writer.neutralizeAssertions([], 'No reason', 'turn-001')
      ).resolves.toBeUndefined();
    });
  });
  
  describe('isAvailable', () => {
    it('should always return true', async () => {
      expect(await writer.isAvailable()).toBe(true);
    });
  });
});

describe('LedgerWriter interface contract', () => {
  it('should define all required methods', () => {
    const writer = new NoopLedgerWriter();
    
    // Type-level checks (these would fail to compile if interface changed)
    expect(typeof writer.name).toBe('string');
    expect(typeof writer.writeSnapshot).toBe('function');
    expect(typeof writer.touchAssertions).toBe('function');
    expect(typeof writer.neutralizeAssertions).toBe('function');
    expect(typeof writer.isAvailable).toBe('function');
  });
  
  it('should support all LedgerStage values', () => {
    const stages: LedgerWriteContext['stage'][] = ['IN', 'RX', 'CX', 'PX', 'MX', 'LX', 'CURATED'];
    
    stages.forEach(stage => {
      const context: LedgerWriteContext = {
        turnId: 'turn-001',
        sessionId: 'session-001',
        workspaceId: 'ws-001',
        stage,
        profileIds: [],
      };
      
      expect(context.stage).toBe(stage);
    });
  });
});
