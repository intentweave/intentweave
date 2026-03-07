// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports Module Tests
 * 
 * Unit tests for the reporting system:
 * - Issue fingerprinting
 * - Issue ID registry
 * - Severity computation
 * - Report generation
 * - Markdown formatters
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  computeFingerprintHash,
  createContradictionFingerprint,
  createOpenEndFingerprint,
  createNeedsReviewFingerprint,
  createErrorFingerprint,
} from '../reports/fingerprint.js';
import {
  loadIssueRegistry,
  saveIssueRegistry,
  getOrAllocateIssueId,
  markUnseenAsResolved,
  EMPTY_ISSUE_REGISTRY,
} from '../reports/registry.js';
import {
  computeSeverity,
  computeActionScore,
  rankActions,
} from '../reports/severity.js';
import {
  formatProblemsReport,
} from '../reports/formatters/problems-md.js';
import {
  formatFullReport,
} from '../reports/formatters/full-md.js';
import type {
  IssueFingerprint,
  ContradictionFingerprint,
  OpenEndFingerprint,
  NeedsReviewFingerprint,
  ErrorFingerprint,
  RunReport,
  Issue,
  SuggestedAction,
  ReportPolicy,
  IssueRegistry,
} from '../reports/types.js';
import { DEFAULT_REPORT_POLICY } from '../reports/types.js';

// =============================================================================
// Fingerprint Tests
// =============================================================================

describe('Issue Fingerprinting', () => {
  describe('computeFingerprintHash', () => {
    it('produces consistent hashes for same input', () => {
      const fp: ContradictionFingerprint = {
        kind: 'contradiction',
        specClaimSourceKey: 'spec:abc:m:1',
        implObservationSourceKey: 'impl:xyz:m:42',
        predicate: 'has_status',
        entityName: 'Order',
      };
      
      const hash1 = computeFingerprintHash(fp);
      const hash2 = computeFingerprintHash(fp);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{16}$/); // 16 hex chars
    });
    
    it('produces different hashes for different inputs', () => {
      const fp1: ContradictionFingerprint = {
        kind: 'contradiction',
        specClaimSourceKey: 'spec:abc:m:1',
        implObservationSourceKey: 'impl:xyz:m:42',
        predicate: 'has_status',
        entityName: 'Order',
      };
      
      const fp2: ContradictionFingerprint = {
        kind: 'contradiction',
        specClaimSourceKey: 'spec:abc:m:1',
        implObservationSourceKey: 'impl:xyz:m:42',
        predicate: 'has_priority', // Different predicate
        entityName: 'Order',
      };
      
      const hash1 = computeFingerprintHash(fp1);
      const hash2 = computeFingerprintHash(fp2);
      
      expect(hash1).not.toBe(hash2);
    });
    
    it('is order-independent for sorted fields', () => {
      const fp1: ContradictionFingerprint = {
        kind: 'contradiction',
        specClaimSourceKey: 'spec:abc:m:1',
        implObservationSourceKey: 'impl:xyz:m:42',
        predicate: 'has_status',
        entityName: 'Order',
      };
      
      const fp2: ContradictionFingerprint = {
        entityName: 'Order',
        predicate: 'has_status',
        implObservationSourceKey: 'impl:xyz:m:42',
        specClaimSourceKey: 'spec:abc:m:1',
        kind: 'contradiction',
      };
      
      const hash1 = computeFingerprintHash(fp1);
      const hash2 = computeFingerprintHash(fp2);
      
      expect(hash1).toBe(hash2);
    });
  });
  
  describe('createContradictionFingerprint', () => {
    it('creates fingerprint with required fields', () => {
      const fp = createContradictionFingerprint(
        'spec:session:m:1',
        'impl:session:m:5',
        'has_timeout',
        'APIClient'
      );
      
      expect(fp.kind).toBe('contradiction');
      expect(fp.specClaimSourceKey).toBe('spec:session:m:1');
      expect(fp.implObservationSourceKey).toBe('impl:session:m:5');
      expect(fp.predicate).toBe('has_timeout');
      expect(fp.entityName).toBe('APIClient');
    });
  });
  
  describe('createOpenEndFingerprint', () => {
    it('creates fingerprint for missing link', () => {
      const fp = createOpenEndFingerprint('intent', 'spec', 'User', 'requires');
      
      expect(fp.kind).toBe('open_end');
      expect(fp.fromRole).toBe('intent');
      expect(fp.toRole).toBe('spec');
      expect(fp.entityName).toBe('User');
      expect(fp.predicate).toBe('requires');
    });
  });
  
  describe('createNeedsReviewFingerprint', () => {
    it('creates fingerprint for ambiguity', () => {
      const fp = createNeedsReviewFingerprint('duration_vs_calendar', 'DeliveryDate');
      
      expect(fp.kind).toBe('needs_review');
      expect(fp.ambiguityType).toBe('duration_vs_calendar');
      expect(fp.entityName).toBe('DeliveryDate');
    });
  });
  
  describe('createErrorFingerprint', () => {
    it('creates fingerprint for error', () => {
      const fp = createErrorFingerprint('PARSER_MALFORMED_HEADER', 'specstory', 'IN');
      
      expect(fp.kind).toBe('error');
      expect(fp.errorCode).toBe('PARSER_MALFORMED_HEADER');
      expect(fp.adapterName).toBe('specstory');
      expect(fp.stage).toBe('IN');
    });
  });
});

// =============================================================================
// Issue Registry Tests
// =============================================================================

describe('Issue Registry', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-registry-test-'));
  });
  
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  
  describe('loadIssueRegistry', () => {
    it('returns empty registry for non-existent file', async () => {
      const registry = await loadIssueRegistry(tempDir, 'test-session');
      
      expect(registry.fingerprints).toEqual({});
      expect(registry.nextId).toEqual({ C: 1, O: 1, N: 1, E: 1 });
    });
    
    it('loads existing registry', async () => {
      const issuesDir = path.join(tempDir, 'issues');
      await fs.mkdir(issuesDir, { recursive: true });
      
      const registryData = {
        fingerprints: {
          'sha256:abc123': { id: 'C-1', firstSeen: '2026-01-31T12:00:00Z', lastSeen: '2026-01-31T12:00:00Z' },
        },
        nextId: { C: 2, O: 1, N: 1, E: 1 },
      };
      
      await fs.writeFile(
        path.join(issuesDir, 'test-session.json'),
        JSON.stringify(registryData)
      );
      
      const registry = await loadIssueRegistry(tempDir, 'test-session');
      
      expect(registry.fingerprints['sha256:abc123']).toBeDefined();
      expect(registry.fingerprints['sha256:abc123'].id).toBe('C-1');
      expect(registry.nextId.C).toBe(2);
    });
  });
  
  describe('getOrAllocateIssueId', () => {
    it('allocates new ID for new fingerprint', () => {
      const registry: IssueRegistry = {
        fingerprints: {},
        nextId: { C: 1, O: 1, N: 1, E: 1 },
      };
      const fingerprint: ContradictionFingerprint = {
        kind: 'contradiction',
        specClaimSourceKey: 'spec:test:m:1',
        implObservationSourceKey: 'impl:test:m:2',
        predicate: 'has_value',
        entityName: 'TestEntity',
      };
      
      const result = getOrAllocateIssueId(registry, 'test-session', 'run-001', fingerprint);
      
      expect(result.id).toBe('C-1');
      expect(result.isNew).toBe(true);
      expect(result.issueKey).toBe('test-session#C-1');
      expect(registry.nextId.C).toBe(2);
    });
    
    it('reuses existing ID for known fingerprint', () => {
      const fingerprint: ContradictionFingerprint = {
        kind: 'contradiction',
        specClaimSourceKey: 'spec:test:m:1',
        implObservationSourceKey: 'impl:test:m:2',
        predicate: 'has_value',
        entityName: 'TestEntity',
      };
      const hash = computeFingerprintHash(fingerprint);
      const firstSeen = '2026-01-30T12:00:00Z';
      
      const registry = {
        fingerprints: {
          [hash]: { id: 'C-5', firstSeen, lastSeen: firstSeen },
        },
        nextId: { C: 6, O: 1, N: 1, E: 1 },
      };
      
      const result = getOrAllocateIssueId(registry, 'test-session', 'run-002', fingerprint);
      
      expect(result.id).toBe('C-5');
      expect(result.isNew).toBe(false);
      expect(registry.nextId.C).toBe(6); // Unchanged
    });
    
    it('allocates correct prefix for each kind', () => {
      const registry: IssueRegistry = {
        fingerprints: {},
        nextId: { C: 1, O: 1, N: 1, E: 1 },
      };
      
      const cFp: ContradictionFingerprint = { kind: 'contradiction', specClaimSourceKey: 's1', implObservationSourceKey: 'i1' };
      const oFp: OpenEndFingerprint = { kind: 'open_end', fromRole: 'intent', toRole: 'spec' };
      const nFp: NeedsReviewFingerprint = { kind: 'needs_review', ambiguityType: 'test' };
      const eFp: ErrorFingerprint = { kind: 'error', errorCode: 'E001', adapterName: 'test', stage: 'IN' };
      
      const cResult = getOrAllocateIssueId(registry, 'sess', 'run', cFp);
      const oResult = getOrAllocateIssueId(registry, 'sess', 'run', oFp);
      const nResult = getOrAllocateIssueId(registry, 'sess', 'run', nFp);
      const eResult = getOrAllocateIssueId(registry, 'sess', 'run', eFp);
      
      expect(cResult.id).toBe('C-1');
      expect(oResult.id).toBe('O-1');
      expect(nResult.id).toBe('N-1');
      expect(eResult.id).toBe('E-1');
    });
  });
  
  describe('markUnseenAsResolved', () => {
    it('marks issues not seen in current run as resolved', () => {
      const now = new Date().toISOString();
      const registry = {
        fingerprints: {
          'sha256:seen': { id: 'C-1', firstSeen: now, lastSeen: now },
          'sha256:unseen': { id: 'C-2', firstSeen: '2026-01-30', lastSeen: '2026-01-30' },
        },
        nextId: { C: 3, O: 1, N: 1, E: 1 },
      };
      
      const seenFingerprints = new Set(['sha256:seen']);
      markUnseenAsResolved(registry, seenFingerprints, now);
      
      expect(registry.fingerprints['sha256:seen'].resolved).toBeUndefined();
      expect(registry.fingerprints['sha256:unseen'].resolved).toBe(now);
    });
  });
});

// =============================================================================
// Severity Computation Tests
// =============================================================================

describe('Severity Computation', () => {
  describe('computeSeverity', () => {
    const policy: ReportPolicy = {
      ...DEFAULT_REPORT_POLICY,
      blockerConfidence: 0.75,
      warningConfidence: 0.6,
    };
    
    it('returns blocker for stageBreaking errors', () => {
      const severity = computeSeverity('error', 0.5, policy, { stageBreaking: true });
      expect(severity).toBe('blocker');
    });
    
    it('returns blocker for high confidence contradictions', () => {
      const severity = computeSeverity('contradiction', 0.8, policy);
      expect(severity).toBe('blocker');
    });
    
    it('returns blocker for mustHave open_end with high confidence', () => {
      const severity = computeSeverity('open_end', 0.9, policy, { mustHave: true });
      expect(severity).toBe('blocker');
    });
    
    it('returns warning for medium confidence', () => {
      const severity = computeSeverity('needs_review', 0.65, policy);
      expect(severity).toBe('warning');
    });
    
    it('returns info for low confidence', () => {
      const severity = computeSeverity('needs_review', 0.55, policy);
      expect(severity).toBe('info');
    });
  });
  
  describe('computeActionScore', () => {
    it('computes score based on severity, confidence, impact, effort', () => {
      const action: Pick<SuggestedAction, 'estimatedEffort'> = {
        estimatedEffort: '2h', // effort weight = 1
      };
      
      const issue: Pick<Issue, 'severity' | 'confidence' | 'kind'> = {
        severity: 'blocker',  // weight = 3
        confidence: 0.9,
        kind: 'contradiction', // impact = 3
      };
      
      const score = computeActionScore(action, issue);
      
      // score = (3 × 0.9 × 3) / 1 = 8.1
      expect(score).toBeCloseTo(8.1);
    });
    
    it('handles missing effort (defaults to weight=2)', () => {
      const action: Pick<SuggestedAction, 'estimatedEffort'> = {};
      
      const issue: Pick<Issue, 'severity' | 'confidence' | 'kind'> = {
        severity: 'warning',  // weight = 2
        confidence: 0.7,
        kind: 'needs_review', // impact = 1
      };
      
      const score = computeActionScore(action, issue);
      
      // score = (2 × 0.7 × 1) / 2 = 0.7
      expect(score).toBeCloseTo(0.7);
    });
  });
  
  describe('rankActions', () => {
    it('sorts actions by score descending and assigns ranks', () => {
      const issues: Issue[] = [
        { id: 'C-1', severity: 'blocker', confidence: 0.9, kind: 'contradiction' } as Issue,
        { id: 'C-2', severity: 'warning', confidence: 0.7, kind: 'contradiction' } as Issue,
        { id: 'C-3', severity: 'info', confidence: 0.5, kind: 'needs_review' } as Issue,
      ];
      
      const actions: SuggestedAction[] = [
        { rank: 0, type: 'code_change', description: 'Low priority', issueId: 'C-3' },
        { rank: 0, type: 'code_change', description: 'High priority', issueId: 'C-1' },
        { rank: 0, type: 'code_change', description: 'Medium priority', issueId: 'C-2' },
      ];
      
      const ranked = rankActions(actions, issues);
      
      expect(ranked[0].description).toBe('High priority');
      expect(ranked[0].rank).toBe(1);
      expect(ranked[1].description).toBe('Medium priority');
      expect(ranked[1].rank).toBe(2);
      expect(ranked[2].description).toBe('Low priority');
      expect(ranked[2].rank).toBe(3);
    });
  });
});

// =============================================================================
// Markdown Formatter Tests
// =============================================================================

describe('Markdown Formatters', () => {
  const createMockReport = (issues: Issue[] = []): RunReport => ({
    $schema: 'intentweave://schemas/report/v1',
    schemaVersion: '0.1',
    run: {
      id: 'run-2026-01-31_12-00-00-abc123',
      ts: '2026-01-31T12:00:00.000Z',
      mode: 'full',
      durationMs: 5000,
    },
    inputs: {
      artifacts: [
        { id: 'chat:specstory:test-session', type: 'chat', source: 'specstory' },
      ],
      profile: 'standard',
      configHash: 'abc123',
      reportPolicy: DEFAULT_REPORT_POLICY,
    },
    summary: {
      totalMessages: 100,
      totalEntities: 50,
      totalStatements: 25,
      roleDistribution: { user: 40, assistant: 60 },
      intentToSpecCoverage: 0.8,
      specToImplCoverage: 0.6,
      contradictions: issues.filter(i => i.kind === 'contradiction').length,
      openEnds: issues.filter(i => i.kind === 'open_end').length,
      needsReview: issues.filter(i => i.kind === 'needs_review').length,
      errors: issues.filter(i => i.kind === 'error').length,
    },
    issues,
    actions: [],
    timings: { total: 5000 },
    generator: {
      version: 'iw@0.6.0',
      heuristicsVersion: '1.0',
      adapterVersions: { specstory: '0.1.0' },
    },
  });
  
  describe('formatProblemsReport', () => {
    it('includes assistant instruction block', () => {
      const report = createMockReport();
      const md = formatProblemsReport(report);
      
      expect(md).toContain('<!-- iw:assistant-instructions');
      expect(md).toContain('Read sections 2–5 only');
      expect(md).toContain('-->');
    });
    
    it('shows no issues message when empty', () => {
      const report = createMockReport();
      const md = formatProblemsReport(report);
      
      expect(md).toContain('No issues found');
    });
    
    it('includes run metadata', () => {
      const report = createMockReport();
      const md = formatProblemsReport(report);
      
      expect(md).toContain('Run: 2026-01-31T12:00:00.000Z');
      expect(md).toContain('Mode: full');
    });
    
    it('includes quick commands appendix', () => {
      const report = createMockReport();
      const md = formatProblemsReport(report);
      
      expect(md).toContain('## Appendix: Quick Commands');
      expect(md).toContain('iw run');
      expect(md).toContain('iw report');
    });
  });
  
  describe('formatFullReport', () => {
    it('includes run ID and timestamp', () => {
      const report = createMockReport();
      const md = formatFullReport(report);
      
      expect(md).toContain('Run ID: `run-2026-01-31_12-00-00-abc123`');
      expect(md).toContain('Timestamp: 2026-01-31T12:00:00.000Z');
    });
    
    it('includes artifacts section', () => {
      const report = createMockReport();
      const md = formatFullReport(report);
      
      expect(md).toContain('### Artifacts');
      expect(md).toContain('chat:specstory:test-session');
    });
    
    it('includes coverage metrics', () => {
      const report = createMockReport();
      const md = formatFullReport(report);
      
      expect(md).toContain('Coverage Metrics');
      expect(md).toContain('Intent → Spec: 80%');
      expect(md).toContain('Spec → Implementation: 60%');
    });
    
    it('includes issue summary table', () => {
      const report = createMockReport();
      const md = formatFullReport(report);
      
      expect(md).toContain('## 5) Issue Summary');
      expect(md).toContain('| Kind | Count |');
      expect(md).toContain('| Contradictions | 0 |');
    });
  });
});
