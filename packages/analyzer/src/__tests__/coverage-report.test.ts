/**
 * Tests for Coverage Report Generation
 */

import { describe, it, expect } from 'vitest';
import {
  generateCoverageReport,
  createEmptyCoverageReport,
  summarizeCoverageReport,
  type CoverageReportInput,
  type CoverageReportOptions,
} from '../linking/coverageReport.js';
import type { Entity, LinkProposal, ArtifactRole, Statement } from '@intentweave/core';

// =============================================================================
// Test Fixtures
// =============================================================================

function createEntity(
  cgId: string,
  name: string,
  type: string,
  artifactId: string,
  artifactRole: ArtifactRole
): Entity & { artifactId: string; artifactRole: ArtifactRole } {
  return {
    cgId,
    name,
    type,
    confidence: 0.9,
    mentions: [],
    meta: {},
    artifactId,
    artifactRole,
  };
}

function createLink(
  sourceCgId: string,
  targetCgId: string,
  sourceArtifact: string,
  targetArtifact: string,
  predicate: 'REFINES' | 'IMPLEMENTS' | 'MAPS_TO' | 'DERIVED_FROM' | 'DESCRIBES',
  confidence: number
): LinkProposal {
  return {
    id: `link-${sourceCgId}-${targetCgId}`,
    sourceCgId,
    targetCgId,
    sourceArtifact,
    targetArtifact,
    predicate,
    confidence,
    matchMethod: 'name',
    evidence: [],
  };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('Coverage Report Generation', () => {
  describe('generateCoverageReport', () => {
    it('generates empty report for empty input', () => {
      const input: CoverageReportInput = {
        entities: [],
        statements: [],
        linkProposals: [],
        artifacts: [],
      };

      const options: CoverageReportOptions = {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      };

      const report = generateCoverageReport(input, options);

      expect(report.$schema).toBe('intentweave://schemas/coverage-report/v1');
      expect(report.schemaVersion).toBe('0.1');
      expect(report.summary.totalEntities).toBe(0);
      expect(report.summary.totalLinks).toBe(0);
      expect(report.summary.traceabilityScore).toBe(100);
    });

    it('calculates linked entity count and percentage', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('e1', 'Entity1', 'concept', 'spec-artifact', 'spec'),
          createEntity('e2', 'Entity2', 'concept', 'code-artifact', 'code'),
          createEntity('e3', 'Entity3', 'concept', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('e1', 'e2', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.9),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      expect(report.summary.totalEntities).toBe(3);
      expect(report.summary.linkedEntityCount).toBe(2); // e1 and e2 are linked
      expect(report.summary.linkedEntityPercent).toBe(67); // 2/3 = 66.67% rounded
    });

    it('calculates role transition coverage', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature1', 'requirement', 'spec-artifact', 'spec'),
          createEntity('spec2', 'Feature2', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'Feature1Impl', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.9),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      const specToImpl = report.roleTransitions.find(
        t => t.sourceRole === 'spec' && t.targetRole === 'code'
      );

      expect(specToImpl).toBeDefined();
      expect(specToImpl!.sourceCount).toBe(2);
      expect(specToImpl!.linkedCount).toBe(1);
      expect(specToImpl!.coveragePercent).toBe(50);
      expect(specToImpl!.unlinkedEntities).toContain('spec2');
    });

    it('respects minLinkConfidence threshold', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature1', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'Feature1Impl', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.3),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
        minLinkConfidence: 0.5, // Link has 0.3, below threshold
      });

      expect(report.summary.totalLinks).toBe(0); // Link filtered out
      expect(report.summary.linkedEntityCount).toBe(0);
    });
  });

  describe('Incompleteness Detection', () => {
    it('detects missing implementations', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature1', 'requirement', 'spec-artifact', 'spec'),
          createEntity('spec2', 'Feature2', 'requirement', 'spec-artifact', 'spec'),
        ],
        statements: [],
        linkProposals: [], // No implementations
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
        detectIncompletenesses: true,
      });

      const missingImpls = report.incompletenesses.filter(
        f => f.type === 'missing-implementation'
      );

      expect(missingImpls.length).toBe(2);
      expect(missingImpls[0].entityName).toBe('Feature1');
      expect(missingImpls[0].expectedRole).toBe('code');
    });

    it('detects missing specs for intents', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('prompt1', 'UserGoal', 'goal', 'prompt-artifact', 'intent'),
        ],
        statements: [],
        linkProposals: [],
        artifacts: [
          { artifactId: 'prompt-artifact', artifactRole: 'intent' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      const missingSpecs = report.incompletenesses.filter(
        f => f.type === 'missing-spec'
      );

      expect(missingSpecs.length).toBe(1);
      expect(missingSpecs[0].entityName).toBe('UserGoal');
    });

    it('detects orphan implementations', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('impl1', 'HelperClass', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [],
        artifacts: [
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      const orphans = report.incompletenesses.filter(
        f => f.type === 'orphan-impl'
      );

      expect(orphans.length).toBe(1);
      expect(orphans[0].entityName).toBe('HelperClass');
    });

    it('skips incompleteness detection when disabled', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature1', 'requirement', 'spec-artifact', 'spec'),
        ],
        statements: [],
        linkProposals: [],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
        detectIncompletenesses: false,
      });

      expect(report.incompletenesses.length).toBe(0);
    });
  });

  describe('Inconsistency Detection', () => {
    it('detects semantic drift between linked entities', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'Feature', 'function', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.95),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
        detectInconsistencies: true,
      });

      const driftFindings = report.inconsistencies.filter(
        f => f.type === 'semantic-drift'
      );

      expect(driftFindings.length).toBe(1);
      expect(driftFindings[0].message).toContain('different types');
    });

    it('detects stale links with low confidence', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'FeatureImpl', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.55),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      const staleFindings = report.inconsistencies.filter(
        f => f.type === 'stale-link'
      );

      expect(staleFindings.length).toBe(1);
      expect(staleFindings[0].message).toContain('low confidence');
    });

    it('detects conflicting definitions', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'UserAuth', 'concept', 'spec-artifact', 'spec'),
          createEntity('impl1', 'UserAuth', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [], // Not linked
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      const conflictFindings = report.inconsistencies.filter(
        f => f.type === 'conflicting-definition'
      );

      expect(conflictFindings.length).toBe(1);
      expect(conflictFindings[0].message).toContain('Multiple definitions');
    });

    it('skips inconsistency detection when disabled', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'Feature', 'function', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.95),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
        detectInconsistencies: false,
      });

      expect(report.inconsistencies.length).toBe(0);
    });
  });

  describe('Artifact Metrics', () => {
    it('calculates per-artifact metrics correctly', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature1', 'requirement', 'spec-artifact', 'spec'),
          createEntity('spec2', 'Feature2', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'Feature1Impl', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.9),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      const specArtifact = report.artifacts.find(a => a.artifactId === 'spec-artifact');
      const implArtifact = report.artifacts.find(a => a.artifactId === 'code-artifact');

      expect(specArtifact).toBeDefined();
      expect(specArtifact!.entityCount).toBe(2);
      expect(specArtifact!.linkedCount).toBe(1);
      expect(specArtifact!.outgoingLinks).toBe(1);
      expect(specArtifact!.incomingLinks).toBe(0);

      expect(implArtifact).toBeDefined();
      expect(implArtifact!.entityCount).toBe(1);
      expect(implArtifact!.linkedCount).toBe(1);
      expect(implArtifact!.outgoingLinks).toBe(0);
      expect(implArtifact!.incomingLinks).toBe(1);
    });
  });

  describe('Traceability Score', () => {
    it('returns high score for fully linked project', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature1', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'Feature1Impl', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.9),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      // Score should be high (> 50) when all entities are linked
      // Note: Score < 100 because spec→doc and spec→test transitions have 0% coverage
      expect(report.summary.traceabilityScore).toBeGreaterThan(50);
      expect(report.summary.linkedEntityPercent).toBe(100);
    });

    it('returns lower score for partial coverage', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature1', 'requirement', 'spec-artifact', 'spec'),
          createEntity('spec2', 'Feature2', 'requirement', 'spec-artifact', 'spec'),
          createEntity('spec3', 'Feature3', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'Feature1Impl', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.9),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      expect(report.summary.traceabilityScore).toBeLessThan(100);
      expect(report.summary.traceabilityScore).toBeGreaterThan(0);
    });
  });

  describe('Utility Functions', () => {
    it('createEmptyCoverageReport creates valid empty report', () => {
      const report = createEmptyCoverageReport('run-123', 'workspace-abc');

      expect(report.$schema).toBe('intentweave://schemas/coverage-report/v1');
      expect(report.runId).toBe('run-123');
      expect(report.workspaceKey).toBe('workspace-abc');
      expect(report.summary.totalEntities).toBe(0);
      expect(report.roleTransitions).toEqual([]);
      expect(report.inconsistencies).toEqual([]);
      expect(report.incompletenesses).toEqual([]);
    });

    it('summarizeCoverageReport produces readable output', () => {
      const input: CoverageReportInput = {
        entities: [
          createEntity('spec1', 'Feature1', 'requirement', 'spec-artifact', 'spec'),
          createEntity('impl1', 'Feature1Impl', 'class', 'code-artifact', 'code'),
        ],
        statements: [],
        linkProposals: [
          createLink('spec1', 'impl1', 'spec-artifact', 'code-artifact', 'IMPLEMENTS', 0.9),
        ],
        artifacts: [
          { artifactId: 'spec-artifact', artifactRole: 'spec' },
          { artifactId: 'code-artifact', artifactRole: 'code' },
        ],
      };

      const report = generateCoverageReport(input, {
        runId: 'test-run',
        workspaceKey: 'test-workspace',
      });

      const summary = summarizeCoverageReport(report);

      expect(summary).toContain('Coverage Report');
      expect(summary).toContain('traceability');
      expect(summary).toContain('Entities');
      expect(summary).toContain('Links');
    });
  });
});
