// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file AST Extractor Tests
 */

import { describe, it, expect } from 'vitest';
import { AstExtractor, createExtractor, getExportedFunctions, getClasses } from '../src/index.js';

describe('AstExtractor', () => {
  const extractor = createExtractor(process.cwd());

  describe('extractFromString', () => {
    it('should extract function declarations', () => {
      const code = `
        export function greet(name: string): string {
          return \`Hello, \${name}!\`;
        }
        
        function privateHelper() {
          console.log('helper');
        }
      `;

      const result = extractor.extractFromString(code, 'test.ts', 'typescript');

      // Should have at least 2 function symbols (may have more from parameters)
      const functions = result.symbols.filter(s => s.kind === 'function');
      expect(functions).toHaveLength(2);
      
      const greet = result.symbols.find(s => s.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet?.kind).toBe('function');
      expect(greet?.isExported).toBe(true);
      expect(greet?.parameters).toContain('name');

      const helper = result.symbols.find(s => s.name === 'privateHelper');
      expect(helper).toBeDefined();
      expect(helper?.isExported).toBe(false);
    });

    it('should extract class declarations with members', () => {
      const code = `
        export class UserService {
          private users: User[] = [];
          
          constructor(private db: Database) {}
          
          async getUser(id: string): Promise<User> {
            return this.db.find(id);
          }
          
          static getInstance(): UserService {
            return instance;
          }
        }
      `;

      const result = extractor.extractFromString(code, 'service.ts', 'typescript');

      const classSymbol = result.symbols.find(s => s.name === 'UserService');
      expect(classSymbol).toBeDefined();
      expect(classSymbol?.kind).toBe('class');
      expect(classSymbol?.isExported).toBe(true);

      const constructor = result.symbols.find(s => s.kind === 'constructor');
      expect(constructor).toBeDefined();
      expect(constructor?.parent).toBe('UserService');

      const getUser = result.symbols.find(s => s.name === 'getUser');
      expect(getUser).toBeDefined();
      expect(getUser?.kind).toBe('method');
      expect(getUser?.isAsync).toBe(true);
      expect(getUser?.parent).toBe('UserService');

      const getInstance = result.symbols.find(s => s.name === 'getInstance');
      expect(getInstance).toBeDefined();
      expect(getInstance?.isStatic).toBe(true);
    });

    it('should extract interface declarations', () => {
      const code = `
        export interface User {
          id: string;
          name: string;
          email?: string;
          getDisplayName(): string;
        }
      `;

      const result = extractor.extractFromString(code, 'types.ts', 'typescript');

      const iface = result.symbols.find(s => s.name === 'User');
      expect(iface).toBeDefined();
      expect(iface?.kind).toBe('interface');

      // Check interface members
      const idProp = result.symbols.find(s => s.name === 'id' && s.parent === 'User');
      expect(idProp).toBeDefined();
      expect(idProp?.kind).toBe('property');

      const getDisplayName = result.symbols.find(s => s.name === 'getDisplayName' && s.parent === 'User');
      expect(getDisplayName).toBeDefined();
      expect(getDisplayName?.kind).toBe('method');
    });

    it('should extract type aliases and enums', () => {
      const code = `
        export type UserId = string;
        
        export enum Status {
          Active = 'active',
          Inactive = 'inactive',
        }
      `;

      const result = extractor.extractFromString(code, 'types.ts', 'typescript');

      const typeAlias = result.symbols.find(s => s.name === 'UserId');
      expect(typeAlias).toBeDefined();
      expect(typeAlias?.kind).toBe('type');

      const enumSymbol = result.symbols.find(s => s.name === 'Status');
      expect(enumSymbol).toBeDefined();
      expect(enumSymbol?.kind).toBe('enum');
    });

    it('should extract arrow functions assigned to variables', () => {
      const code = `
        export const add = (a: number, b: number) => a + b;
        
        const multiply = async (a: number, b: number) => {
          return a * b;
        };
      `;

      const result = extractor.extractFromString(code, 'utils.ts', 'typescript');

      const add = result.symbols.find(s => s.name === 'add');
      expect(add).toBeDefined();
      expect(add?.kind).toBe('function');

      const multiply = result.symbols.find(s => s.name === 'multiply');
      expect(multiply).toBeDefined();
      expect(multiply?.kind).toBe('function');
      expect(multiply?.isAsync).toBe(true);
    });

    it('should extract import statements', () => {
      const code = `
        import { User, type UserRole } from './types';
        import * as utils from '../utils';
        import defaultExport from 'lodash';
        import { pick as lodashPick } from 'lodash';
      `;

      const result = extractor.extractFromString(code, 'index.ts', 'typescript');

      expect(result.imports).toHaveLength(4);

      const typesImport = result.imports.find(i => i.moduleSpecifier === './types');
      expect(typesImport).toBeDefined();
      expect(typesImport?.isRelative).toBe(true);
      expect(typesImport?.imports.find(i => i.name === 'User')).toBeDefined();

      const namespaceImport = result.imports.find(i => i.moduleSpecifier === '../utils');
      expect(namespaceImport).toBeDefined();
      expect(namespaceImport?.imports.find(i => i.isNamespace)).toBeDefined();

      const defaultImport = result.imports.find(i => i.moduleSpecifier === 'lodash' && i.imports.some(x => x.isDefault));
      expect(defaultImport).toBeDefined();

      const aliasedImport = result.imports.find(i => i.imports.some(x => x.name === 'pick' && x.alias === 'lodashPick'));
      expect(aliasedImport).toBeDefined();
    });

    it('should extract export statements', () => {
      const code = `
        export { User, UserRole } from './types';
        export * from './utils';
        export default class MyClass {}
      `;

      const result = extractor.extractFromString(code, 'index.ts', 'typescript');

      // Re-exports
      const reExport = result.exports.find(e => e.name === 'User');
      expect(reExport).toBeDefined();
      expect(reExport?.kind).toBe('re-export');
      expect(reExport?.sourceModule).toBe('./types');
    });

    it('should handle JSDoc comments', () => {
      const code = `
        /**
         * Calculates the sum of two numbers.
         * @param a First number
         * @param b Second number
         */
        export function sum(a: number, b: number): number {
          return a + b;
        }
      `;

      const result = extractor.extractFromString(code, 'math.ts', 'typescript');

      const sum = result.symbols.find(s => s.name === 'sum');
      expect(sum?.docSummary).toBe('Calculates the sum of two numbers.');
    });
  });

  describe('utility functions', () => {
    it('getExportedFunctions should filter correctly', () => {
      const code = `
        export function publicFn() {}
        function privateFn() {}
        
        export class MyClass {
          method() {}
        }
      `;

      const result = extractor.extractFromString(code, 'test.ts', 'typescript');
      const exported = getExportedFunctions(result);

      expect(exported).toHaveLength(1);
      expect(exported[0].name).toBe('publicFn');
    });

    it('getClasses should return all classes', () => {
      const code = `
        export class A {}
        class B {}
      `;

      const result = extractor.extractFromString(code, 'test.ts', 'typescript');
      const classes = getClasses(result);

      expect(classes.length).toBeGreaterThanOrEqual(2);
      expect(classes.filter(c => c.name === 'A' || c.name === 'B')).toHaveLength(2);
    });
  });
});
