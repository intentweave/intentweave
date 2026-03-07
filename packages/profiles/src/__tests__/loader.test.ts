// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Profile Pack Loader
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadProfilePack,
  validateProfilePack,
  discoverProfilePacks,
  createEmptyProfilePack,
  getDefaultProfilePack,
  type ProfilePack,
} from '../loader.js';

// =============================================================================
// Test Helpers
// =============================================================================

let tempDir: string;

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-pack-test-'));
  return dir;
}

async function writeTempFile(dir: string, filename: string, content: string): Promise<void> {
  const filePath = path.join(dir, filename);
  const parentDir = path.dirname(filePath);
  await fs.mkdir(parentDir, { recursive: true });
  await fs.writeFile(filePath, content);
}

async function createTestPack(
  name: string,
  config: {
    kinds?: Array<{ id: string; label: string; extends?: string }>;
    shapes?: Array<{ subject: string; predicates: Array<{ name: string; targets: string[] }> }>;
    rules?: Array<{ id: string; name: string; type: string; message: string }>;
    linking?: Array<{ sourceRole: string; targetRole: string; predicate: string }>;
  } = {}
): Promise<string> {
  const packDir = path.join(tempDir, name);
  await fs.mkdir(packDir, { recursive: true });

  // Write profile.yaml
  const profileYaml = `
name: ${name}
version: "1.0.0"
description: Test profile pack
${config.kinds ? `kinds:\n${config.kinds.map(k => `  - id: ${k.id}\n    label: ${k.label}${k.extends ? `\n    extends: ${k.extends}` : ''}`).join('\n')}` : ''}
${config.linking ? `linking:\n${config.linking.map(l => `  - sourceRole: ${l.sourceRole}\n    targetRole: ${l.targetRole}\n    predicate: ${l.predicate}`).join('\n')}` : ''}
`;
  await writeTempFile(packDir, 'profile.yaml', profileYaml);

  // Write shapes.yaml if provided
  if (config.shapes) {
    const shapesYaml = `
shapes:
${config.shapes.map(s => `  - subject: ${s.subject}\n    predicates:\n${s.predicates.map(p => `      - name: ${p.name}\n        targets:\n${p.targets.map(t => `          - ${t}`).join('\n')}`).join('\n')}`).join('\n')}
`;
    await writeTempFile(packDir, 'shapes.yaml', shapesYaml);
  }

  // Write rules if provided
  if (config.rules) {
    const rulesYaml = `
rules:
${config.rules.map(r => `  - id: ${r.id}\n    name: ${r.name}\n    description: Test rule\n    type: ${r.type}\n    condition: {}\n    message: ${r.message}`).join('\n')}
`;
    await fs.mkdir(path.join(packDir, 'rules'), { recursive: true });
    await writeTempFile(packDir, 'rules/test-rules.yaml', rulesYaml);
  }

  return packDir;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('Profile Pack Loader', () => {
  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('loadProfilePack', () => {
    it('loads a minimal profile pack', async () => {
      const packPath = await createTestPack('minimal');

      const pack = await loadProfilePack(packPath, { validate: false });

      expect(pack.meta.name).toBe('minimal');
      expect(pack.meta.version).toBe('1.0.0');
      expect(pack.packPath).toBe(packPath);
    });

    it('loads kinds from profile.yaml', async () => {
      const packPath = await createTestPack('with-kinds', {
        kinds: [
          { id: 'resource', label: 'Resource' },
          { id: 'action', label: 'Action' },
        ],
      });

      const pack = await loadProfilePack(packPath, { validate: false });

      expect(pack.kinds).toHaveLength(2);
      expect(pack.kinds[0].id).toBe('resource');
      expect(pack.kinds[1].id).toBe('action');
    });

    it('loads shapes from shapes.yaml', async () => {
      const packPath = await createTestPack('with-shapes', {
        kinds: [
          { id: 'resource', label: 'Resource' },
          { id: 'state', label: 'State' },
        ],
        shapes: [
          {
            subject: 'resource',
            predicates: [{ name: 'HAS_STATE', targets: ['state'] }],
          },
        ],
      });

      const pack = await loadProfilePack(packPath, { validate: false });

      expect(pack.shapes).toHaveLength(1);
      expect(pack.shapes[0].subject).toBe('resource');
      expect(pack.shapes[0].predicates[0].name).toBe('HAS_STATE');
    });

    it('loads rules from rules directory', async () => {
      const packPath = await createTestPack('with-rules', {
        rules: [
          { id: 'rule-1', name: 'Test Rule', type: 'missing-edge', message: 'Test message' },
        ],
      });

      const pack = await loadProfilePack(packPath, { validate: false });

      expect(pack.rules).toHaveLength(1);
      expect(pack.rules[0].id).toBe('rule-1');
      expect(pack.rules[0].type).toBe('missing-edge');
    });

    it('loads linking rules', async () => {
      const packPath = await createTestPack('with-linking', {
        linking: [
          { sourceRole: 'spec', targetRole: 'code', predicate: 'IMPLEMENTS' },
        ],
      });

      const pack = await loadProfilePack(packPath, { validate: false });

      expect(pack.linkingRules).toHaveLength(1);
      expect(pack.linkingRules[0].sourceRole).toBe('spec');
      expect(pack.linkingRules[0].predicate).toBe('IMPLEMENTS');
    });

    it('throws error if profile.yaml is missing', async () => {
      const packPath = path.join(tempDir, 'empty-pack');
      await fs.mkdir(packPath);

      await expect(loadProfilePack(packPath)).rejects.toThrow('Required file not found');
    });

    it('throws error if path is not a directory', async () => {
      const filePath = path.join(tempDir, 'not-a-dir.txt');
      await fs.writeFile(filePath, 'test');

      await expect(loadProfilePack(filePath)).rejects.toThrow('not a directory');
    });
  });

  describe('validateProfilePack', () => {
    it('passes for valid pack', () => {
      const pack = getDefaultProfilePack();
      
      expect(() => validateProfilePack(pack)).not.toThrow();
    });

    it('fails if name is missing', () => {
      const pack = createEmptyProfilePack('');
      
      expect(() => validateProfilePack(pack)).toThrow('must have a name');
    });

    it('fails if version is missing', () => {
      const pack = createEmptyProfilePack('test', '');
      
      expect(() => validateProfilePack(pack)).toThrow('must have a version');
    });

    it('fails for duplicate kind ids', () => {
      const pack = createEmptyProfilePack('test');
      pack.kinds = [
        { id: 'resource', label: 'Resource' },
        { id: 'resource', label: 'Resource 2' },
      ];
      
      expect(() => validateProfilePack(pack)).toThrow('Duplicate kind id');
    });

    it('fails if shape references undefined kind', () => {
      const pack = createEmptyProfilePack('test');
      pack.kinds = [{ id: 'resource', label: 'Resource' }];
      pack.shapes = [
        {
          subject: 'undefined-kind',
          predicates: [{ name: 'TEST', targets: ['resource'] }],
        },
      ];
      
      expect(() => validateProfilePack(pack)).toThrow('not a defined kind');
    });

    it('fails for duplicate rule ids', () => {
      const pack = createEmptyProfilePack('test');
      pack.rules = [
        { id: 'rule-1', name: 'Rule 1', description: '', type: 'custom', severity: 'warning', condition: {}, message: '' },
        { id: 'rule-1', name: 'Rule 2', description: '', type: 'custom', severity: 'warning', condition: {}, message: '' },
      ];
      
      expect(() => validateProfilePack(pack)).toThrow('Duplicate rule id');
    });
  });

  describe('discoverProfilePacks', () => {
    it('finds profile packs in a directory', async () => {
      await createTestPack('pack-1');
      await createTestPack('pack-2');
      // Create a non-pack directory
      await fs.mkdir(path.join(tempDir, 'not-a-pack'));

      const packs = await discoverProfilePacks(tempDir);

      expect(packs).toHaveLength(2);
      expect(packs.some(p => p.includes('pack-1'))).toBe(true);
      expect(packs.some(p => p.includes('pack-2'))).toBe(true);
    });

    it('returns empty array for non-existent directory', async () => {
      const packs = await discoverProfilePacks(path.join(tempDir, 'non-existent'));
      
      expect(packs).toEqual([]);
    });
  });

  describe('createEmptyProfilePack', () => {
    it('creates empty pack with name and version', () => {
      const pack = createEmptyProfilePack('my-pack', '2.0.0');

      expect(pack.meta.name).toBe('my-pack');
      expect(pack.meta.version).toBe('2.0.0');
      expect(pack.kinds).toEqual([]);
      expect(pack.shapes).toEqual([]);
      expect(pack.rules).toEqual([]);
      expect(pack.linkingRules).toEqual([]);
    });
  });

  describe('getDefaultProfilePack', () => {
    it('returns valid default pack', () => {
      const pack = getDefaultProfilePack();

      expect(pack.meta.name).toBe('default');
      expect(pack.kinds.length).toBeGreaterThan(0);
      expect(pack.shapes.length).toBeGreaterThan(0);
      expect(pack.linkingRules.length).toBeGreaterThan(0);
    });

    it('default pack passes validation', () => {
      const pack = getDefaultProfilePack();
      
      expect(() => validateProfilePack(pack)).not.toThrow();
    });
  });

  describe('pack inheritance (extends)', () => {
    it('merges base pack with overlay', async () => {
      // Create base pack
      await createTestPack('base', {
        kinds: [
          { id: 'resource', label: 'Resource' },
        ],
      });

      // Create extending pack
      const extendingDir = path.join(tempDir, 'extending');
      await fs.mkdir(extendingDir);
      await writeTempFile(extendingDir, 'profile.yaml', `
name: extending
version: "1.0.0"
extends: base
kinds:
  - id: action
    label: Action
`);

      const pack = await loadProfilePack(extendingDir, {
        validate: false,
        resolveExtends: true,
        baseDir: tempDir,
      });

      expect(pack.kinds).toHaveLength(2);
      expect(pack.kinds.some(k => k.id === 'resource')).toBe(true);
      expect(pack.kinds.some(k => k.id === 'action')).toBe(true);
    });

    it('overlay kinds override base kinds', async () => {
      // Create base pack
      await createTestPack('base', {
        kinds: [
          { id: 'resource', label: 'Base Resource' },
        ],
      });

      // Create extending pack with same kind
      const extendingDir = path.join(tempDir, 'extending');
      await fs.mkdir(extendingDir);
      await writeTempFile(extendingDir, 'profile.yaml', `
name: extending
version: "1.0.0"
extends: base
kinds:
  - id: resource
    label: Overridden Resource
`);

      const pack = await loadProfilePack(extendingDir, {
        validate: false,
        resolveExtends: true,
        baseDir: tempDir,
      });

      expect(pack.kinds).toHaveLength(1);
      expect(pack.kinds[0].label).toBe('Overridden Resource');
    });
  });
});
