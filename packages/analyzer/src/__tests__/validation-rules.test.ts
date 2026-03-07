// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Core Validation Rules
 */

import { describe, it, expect } from 'vitest';
import {
  runValidation,
  createEmptyValidationOutput,
  type ValidationInput,
} from '../validation/coreRules.js';
import type { Entity, Statement, LinkProposal, ArtifactRole } from '@intentweave/core';
import { createEmptyProfilePack, type ProfilePack, type RuleDefinition } from '@intentweave/profiles';

// =============================================================================
// Test Helpers
// =============================================================================

function createEntity(
  cgId: string,
  name: string,
  type: string,
  artifactRole: ArtifactRole = 'spec'
): Entity & { artifactId: string; artifactRole: ArtifactRole } {
  return {
    cgId,
    name,
    type,
    confidence: 0.9,
    mentions: [],
    meta: {},
    artifactId: 'test-artifact',
    artifactRole,
  };
}

function createStatement(
  subjectCgId: string,
  predicate: string,
  objectCgId: string
): Statement & { artifactId: string; artifactRole: ArtifactRole } {
  return {
    subjectCgId,
    predicate,
    objectCgId,
    confidence: 0.9,
    evidence: [],
    labels: [],
    state: 'new',
    artifactId: 'test-artifact',
    artifactRole: 'spec',
  };
}

function createTestPack(
  rules: RuleDefinition[],
  shapes: ProfilePack['shapes'] = []
): ProfilePack {
  const pack = createEmptyProfilePack('test-pack');
  pack.rules = rules;
  pack.shapes = shapes;
  return pack;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Core Validation Rules', () => {
  describe('runValidation', () => {
    it('returns empty output for empty input', () => {
      const input: ValidationInput = {
        entities: [],
        statements: [],
        linkProposals: [],
        profilePack: createEmptyProfilePack('empty'),
      };

      const output = runValidation(input);

      expect(output.findings).toEqual([]);
      expect(output.summary.total).toBe(0);
      expect(output.rulesExecuted).toBe(0);
    });

    it('skips disabled rules', () => {
      const input: ValidationInput = {
        entities: [createEntity('e1', 'Entity1', 'resource')],
        statements: [],
        linkProposals: [],
        profilePack: createTestPack([
          {
            id: 'test-rule',
            name: 'Test Rule',
            description: 'Test',
            type: 'missing-edge',
            severity: 'warning',
            condition: { subject: 'resource', predicate: 'HAS_STATE', required: true },
            message: 'Missing edge',
            enabled: false,
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.rulesExecuted).toBe(0);
      expect(output.findings).toEqual([]);
    });
  });

  describe('missing-edge rule', () => {
    it('detects missing required edge', () => {
      const input: ValidationInput = {
        entities: [createEntity('e1', 'Order', 'resource')],
        statements: [],
        linkProposals: [],
        profilePack: createTestPack([
          {
            id: 'missing-001',
            name: 'Resource needs state',
            description: 'Resources must have states',
            type: 'missing-edge',
            severity: 'warning',
            condition: { subject: 'resource', predicate: 'HAS_STATE', required: true },
            message: "Resource '{{entity.name}}' has no state",
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(1);
      expect(output.findings[0].ruleId).toBe('missing-001');
      expect(output.findings[0].message).toContain('Order');
    });

    it('passes when edge exists', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('e1', 'Order', 'resource'),
          createEntity('e2', 'Pending', 'state'),
        ],
        statements: [createStatement('e1', 'HAS_STATE', 'e2')],
        linkProposals: [],
        profilePack: createTestPack([
          {
            id: 'missing-001',
            name: 'Resource needs state',
            description: 'Resources must have states',
            type: 'missing-edge',
            severity: 'warning',
            condition: { subject: 'resource', predicate: 'HAS_STATE', required: true },
            message: "Resource '{{entity.name}}' has no state",
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(0);
    });

    it('checks cardinality minimum', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('t1', 'OrderTransition', 'transition'),
          createEntity('s1', 'Pending', 'state'),
        ],
        statements: [createStatement('t1', 'FROM_STATE', 's1')],
        linkProposals: [],
        profilePack: createTestPack([
          {
            id: 'missing-002',
            name: 'Transition needs two states',
            description: 'Transitions need from and to',
            type: 'missing-edge',
            severity: 'error',
            condition: { subject: 'transition', predicate: 'TO_STATE', minCard: 1 },
            message: "Transition '{{entity.name}}' missing TO_STATE",
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(1);
      expect(output.findings[0].severity).toBe('error');
    });
  });

  describe('shape-violation rule', () => {
    it('detects invalid predicate for entity type', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('e1', 'Admin', 'role'),
          createEntity('e2', 'Pending', 'state'),
        ],
        statements: [createStatement('e1', 'HAS_STATE', 'e2')],
        linkProposals: [],
        profilePack: createTestPack(
          [
            {
              id: 'shape-001',
              name: 'Invalid predicate',
              description: 'Check predicates against shapes',
              type: 'shape-violation',
              severity: 'warning',
              condition: {},
              message: 'Shape violation',
            },
          ],
          [
            {
              subject: 'role',
              predicates: [{ name: 'CAN', targets: ['action'] }],
            },
          ]
        ),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(1);
      expect(output.findings[0].message).toContain('HAS_STATE');
    });

    it('detects invalid target type', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('e1', 'Admin', 'role'),
          createEntity('e2', 'Pending', 'state'), // Should be 'action'
        ],
        statements: [createStatement('e1', 'CAN', 'e2')],
        linkProposals: [],
        profilePack: createTestPack(
          [
            {
              id: 'shape-001',
              name: 'Invalid target',
              description: 'Check target types',
              type: 'shape-violation',
              severity: 'warning',
              condition: {},
              message: 'Invalid target type',
            },
          ],
          [
            {
              subject: 'role',
              predicates: [{ name: 'CAN', targets: ['action'] }],
            },
          ]
        ),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(1);
      expect(output.findings[0].message).toContain('state');
      expect(output.findings[0].message).toContain('not allowed');
    });
  });

  describe('coverage-target rule', () => {
    it('detects low coverage', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('s1', 'Spec1', 'requirement', 'spec'),
          createEntity('s2', 'Spec2', 'requirement', 'spec'),
          createEntity('s3', 'Spec3', 'requirement', 'spec'),
          createEntity('c1', 'Impl1', 'class', 'code'),
        ],
        statements: [],
        linkProposals: [
          {
            id: 'link1',
            sourceCgId: 's1',
            targetCgId: 'c1',
            sourceArtifact: 'spec',
            targetArtifact: 'code',
            predicate: 'IMPLEMENTS',
            confidence: 0.9,
            matchMethod: 'name',
            evidence: [],
          },
        ],
        profilePack: createTestPack([
          {
            id: 'coverage-001',
            name: 'Low spec coverage',
            description: 'Check spec to code coverage',
            type: 'coverage-target',
            severity: 'warning',
            condition: { sourceRole: 'spec', targetRole: 'code', minCoverage: 0.8 },
            message: 'Coverage is only {{coverage}}%',
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(1);
      expect(output.findings[0].message).toContain('33'); // 1/3 = 33%
    });

    it('passes when coverage target met', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('s1', 'Spec1', 'requirement', 'spec'),
          createEntity('c1', 'Impl1', 'class', 'code'),
        ],
        statements: [],
        linkProposals: [
          {
            id: 'link1',
            sourceCgId: 's1',
            targetCgId: 'c1',
            sourceArtifact: 'spec',
            targetArtifact: 'code',
            predicate: 'IMPLEMENTS',
            confidence: 0.9,
            matchMethod: 'name',
            evidence: [],
          },
        ],
        profilePack: createTestPack([
          {
            id: 'coverage-001',
            name: 'Check coverage',
            description: 'Check spec to code coverage',
            type: 'coverage-target',
            severity: 'warning',
            condition: { sourceRole: 'spec', targetRole: 'code', minCoverage: 0.8 },
            message: 'Low coverage',
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(0);
    });
  });

  describe('forbidden-kind rule', () => {
    it('detects forbidden entity kind', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('e1', 'DebugHelper', 'debug-util', 'code'),
        ],
        statements: [],
        linkProposals: [],
        profilePack: createTestPack([
          {
            id: 'forbidden-001',
            name: 'No debug utils in production',
            description: 'Debug utilities not allowed',
            type: 'forbidden-kind',
            severity: 'error',
            condition: { forbiddenKinds: ['debug-util'], inRole: 'code' },
            message: 'Debug utility not allowed',
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(1);
      expect(output.findings[0].severity).toBe('error');
      expect(output.findings[0].entityName).toBe('DebugHelper');
    });

    it('allows non-forbidden kinds', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('e1', 'UserService', 'service', 'code'),
        ],
        statements: [],
        linkProposals: [],
        profilePack: createTestPack([
          {
            id: 'forbidden-001',
            name: 'No debug utils',
            description: 'Debug utilities not allowed',
            type: 'forbidden-kind',
            severity: 'error',
            condition: { forbiddenKinds: ['debug-util'], inRole: 'code' },
            message: 'Debug utility not allowed',
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.findings.length).toBe(0);
    });
  });

  describe('createEmptyValidationOutput', () => {
    it('returns valid empty output', () => {
      const output = createEmptyValidationOutput();

      expect(output.findings).toEqual([]);
      expect(output.summary.errors).toBe(0);
      expect(output.summary.warnings).toBe(0);
      expect(output.summary.info).toBe(0);
      expect(output.summary.total).toBe(0);
      expect(output.rulesExecuted).toBe(0);
    });
  });

  describe('validation summary', () => {
    it('correctly categorizes findings by severity', () => {
      const input: ValidationInput = {
        entities: [
          createEntity('e1', 'Entity1', 'resource'),
          createEntity('e2', 'Entity2', 'service'),
          createEntity('e3', 'Entity3', 'debug-util'),
        ],
        statements: [],
        linkProposals: [],
        profilePack: createTestPack([
          {
            id: 'error-rule',
            name: 'Error Rule',
            description: 'Test',
            type: 'forbidden-kind',
            severity: 'error',
            condition: { forbiddenKinds: ['debug-util'] },
            message: 'Error',
          },
          {
            id: 'warning-rule',
            name: 'Warning Rule',
            description: 'Test',
            type: 'missing-edge',
            severity: 'warning',
            condition: { subject: 'resource', predicate: 'HAS_STATE', required: true },
            message: 'Warning',
          },
          {
            id: 'info-rule',
            name: 'Info Rule',
            description: 'Test',
            type: 'missing-edge',
            severity: 'info',
            condition: { subject: 'service', predicate: 'PROVIDES', required: true },
            message: 'Info',
          },
        ]),
      };

      const output = runValidation(input);

      expect(output.summary.errors).toBe(1);
      expect(output.summary.warnings).toBe(1);
      expect(output.summary.info).toBe(1);
      expect(output.summary.total).toBe(3);
    });
  });
});
