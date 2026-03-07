/**
 * cgId Tests - Phase 1.6.2
 * 
 * Unit tests for cgId utilities (build, parse, validate)
 */

import { describe, it, expect } from 'vitest';
import {
  buildCgId,
  parseCgId,
  toCanonical,
  toAlias,
  isValidCgId,
  generateWorkspaceId,
  isStableWorkspaceId,
  buildWorkspaceCgId,
  extractWorkspaceId,
  cgIdBelongsToWorkspace,
  hasStableWorkspaceRoot,
  hasLegacyRoot,
  migrateCgIdToWorkspace,
  slugifySegment,
  DEFAULT_CGID_ROOT,
  LEGACY_CGID_ROOT,
} from '../cgId/index.js';

describe('cgId utilities', () => {
  describe('parseCgId', () => {
    it('parses canonical format with pipe separator', () => {
      const parsed = parseCgId('ws_0000|model|kg|state/user/active');
      expect(parsed).toEqual({
        root: 'ws_0000',
        kind: 'model',
        lang: 'kg',
        signature: 'state/user/active',
      });
    });

    it('parses alias format with colon separator', () => {
      const parsed = parseCgId('ws_8f3a:model:kg:role/admin');
      expect(parsed).toEqual({
        root: 'ws_8f3a',
        kind: 'model',
        lang: 'kg',
        signature: 'role/admin',
      });
    });

    it('parses legacy root format', () => {
      const parsed = parseCgId('cgchat|model|kg|resource/document');
      expect(parsed).toEqual({
        root: 'cgchat',
        kind: 'model',
        lang: 'kg',
        signature: 'resource/document',
      });
    });

    it('parses cgId with version', () => {
      const parsed = parseCgId('ws_0000|model|kg|entity/user@v1');
      expect(parsed).toEqual({
        root: 'ws_0000',
        kind: 'model',
        lang: 'kg',
        signature: 'entity/user',
        version: 'v1',
      });
    });

    it('throws on invalid cgId format', () => {
      expect(() => parseCgId('invalid')).toThrow();
      expect(() => parseCgId('')).toThrow();
    });
  });

  describe('buildCgId', () => {
    it('builds canonical cgId from entity type and segments', () => {
      const cgId = buildCgId('role', 'Admin');
      expect(cgId).toMatch(/^ws_0000\|model\|kg\|role\/admin$/);
    });

    it('builds cgId with multiple segments', () => {
      const cgId = buildCgId('state', 'User', 'LoggedIn');
      expect(cgId).toBe('ws_0000|model|kg|state/user/loggedin');
    });

    it('builds cgId with custom root', () => {
      const cgId = buildCgId('action', 'Login', { root: 'ws_abcd' });
      expect(cgId).toBe('ws_abcd|model|kg|action/login');
    });

    it('builds cgId with version', () => {
      const cgId = buildCgId('entity', 'User', { version: 'v2' });
      expect(cgId).toBe('ws_0000|model|kg|entity/user@v2');
    });
  });

  describe('buildWorkspaceCgId', () => {
    it('builds cgId with explicit workspace ID', () => {
      const cgId = buildWorkspaceCgId('ws_1234', 'role', 'Manager');
      expect(cgId).toBe('ws_1234|model|kg|role/manager');
    });

    it('validates workspace ID format', () => {
      const cgId = buildWorkspaceCgId('my-project', 'entity', 'User');
      expect(cgId).toMatch(/^my-project\|model\|kg\|entity\/user$/);
    });
  });

  describe('toCanonical / toAlias', () => {
    it('converts CgId object to canonical string', () => {
      const canonical = toCanonical({
        root: 'ws_0000',
        kind: 'model',
        lang: 'kg',
        signature: 'role/user',
      });
      expect(canonical).toBe('ws_0000|model|kg|role/user');
    });

    it('converts CgId object to alias string', () => {
      const alias = toAlias({
        root: 'ws_0000',
        kind: 'model',
        lang: 'kg',
        signature: 'role/user',
      });
      expect(alias).toBe('ws_0000:model:kg:role/user');
    });
  });

  describe('isValidCgId', () => {
    it('returns true for valid cgIds', () => {
      expect(isValidCgId('ws_0000|model|kg|entity/user')).toBe(true);
      expect(isValidCgId('cgchat|model|kg|role/admin')).toBe(true);
      expect(isValidCgId('ws_abcd:model:kg:state/active')).toBe(true);
    });

    it('returns false for invalid cgIds', () => {
      expect(isValidCgId('invalid')).toBe(false);
      expect(isValidCgId('')).toBe(false);
      expect(isValidCgId('only|two|parts')).toBe(false);
    });
  });

  describe('Workspace ID functions', () => {
    describe('generateWorkspaceId', () => {
      it('generates valid workspace ID', () => {
        const wsId = generateWorkspaceId();
        expect(wsId).toMatch(/^ws_[a-f0-9]{4}$/i);
        expect(isStableWorkspaceId(wsId)).toBe(true);
      });

      it('generates unique IDs', () => {
        const ids = new Set(Array.from({ length: 100 }, generateWorkspaceId));
        expect(ids.size).toBeGreaterThan(90); // Should be mostly unique
      });
    });

    describe('isStableWorkspaceId', () => {
      it('returns true for valid stable workspace IDs', () => {
        expect(isStableWorkspaceId('ws_0000')).toBe(true);
        expect(isStableWorkspaceId('ws_abcd')).toBe(true);
        expect(isStableWorkspaceId('ws_12345678')).toBe(true);
      });

      it('returns false for invalid formats', () => {
        expect(isStableWorkspaceId('0000')).toBe(false);
        expect(isStableWorkspaceId('ws_')).toBe(false);
        expect(isStableWorkspaceId('ws_12')).toBe(false); // Too short
        expect(isStableWorkspaceId('ws_123456789')).toBe(false); // Too long
        expect(isStableWorkspaceId('workspace_0000')).toBe(false);
      });
    });

    describe('extractWorkspaceId', () => {
      it('extracts workspace ID from cgId', () => {
        expect(extractWorkspaceId('ws_1234|model|kg|entity/user')).toBe('ws_1234');
        expect(extractWorkspaceId('cgchat|model|kg|role/admin')).toBe('cgchat');
      });

      it('returns default for invalid cgId', () => {
        expect(extractWorkspaceId('invalid')).toBe(DEFAULT_CGID_ROOT);
      });
    });

    describe('cgIdBelongsToWorkspace', () => {
      it('returns true when cgId belongs to workspace', () => {
        expect(cgIdBelongsToWorkspace('ws_1234|model|kg|entity/user', 'ws_1234')).toBe(true);
      });

      it('returns false when cgId belongs to different workspace', () => {
        expect(cgIdBelongsToWorkspace('ws_1234|model|kg|entity/user', 'ws_5678')).toBe(false);
      });
    });

    describe('hasStableWorkspaceRoot', () => {
      it('returns true for stable workspace roots', () => {
        expect(hasStableWorkspaceRoot('ws_1234|model|kg|entity/user')).toBe(true);
      });

      it('returns false for legacy roots', () => {
        expect(hasStableWorkspaceRoot('cgchat|model|kg|entity/user')).toBe(false);
      });
    });

    describe('hasLegacyRoot', () => {
      it('returns true for legacy cgchat root', () => {
        expect(hasLegacyRoot('cgchat|model|kg|entity/user')).toBe(true);
      });

      it('returns false for stable workspace roots', () => {
        expect(hasLegacyRoot('ws_1234|model|kg|entity/user')).toBe(false);
      });
    });

    describe('migrateCgIdToWorkspace', () => {
      it('migrates cgId to new workspace', () => {
        const migrated = migrateCgIdToWorkspace('cgchat|model|kg|entity/user', 'ws_abcd');
        expect(migrated).toBe('ws_abcd|model|kg|entity/user');
      });
    });
  });

  describe('slugifySegment', () => {
    it('converts to lowercase', () => {
      expect(slugifySegment('UserAdmin')).toBe('useradmin');
    });

    it('replaces spaces with hyphens', () => {
      expect(slugifySegment('User Admin')).toBe('user-admin');
    });

    it('removes special characters', () => {
      expect(slugifySegment('User@Admin!')).toBe('useradmin');
    });

    it('throws on empty result', () => {
      expect(() => slugifySegment('')).toThrow();
      expect(() => slugifySegment('!!!')).toThrow();
    });
  });

  describe('Constants', () => {
    it('exports DEFAULT_CGID_ROOT', () => {
      expect(DEFAULT_CGID_ROOT).toBe('ws_0000');
    });

    it('exports LEGACY_CGID_ROOT', () => {
      expect(LEGACY_CGID_ROOT).toBe('cgchat');
    });
  });
});
