/**
 * End-to-End Integration Test - Phase 1.7
 * 
 * Validates the full Phase 1 promise:
 * Input → Extraction → Artifact Store → Run Meta
 * 
 * Task 1.7.1: Create end-to-end test with MockLLMProvider
 * Task 1.7.2: Create optional OpenAI integration test (skippable)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  Analyzer,
  createMemoryStore,
  createFileStore,
  createMockLLMProvider,
  createDefaultExtractionProvider,
  createChunksFromContent,
  type MemoryStore,
  type FileStore,
  type MockLLMProvider,
  type DefaultExtractionProvider,
} from '../index.js';
import type { Entity, Statement, Evidence } from '@intentweave/core';

/**
 * Sample markdown content for extraction tests
 */
const SAMPLE_MARKDOWN = `# User Authentication System

## Overview
The authentication system allows users to login and access their accounts.

## Roles
- **Admin**: Can manage all users and settings
- **Customer**: Can view and edit their own profile
- **Guest**: Limited read-only access

## States
- pending_verification: User registered but email not confirmed
- active: User can access all features
- suspended: User temporarily blocked
- archived: User account deleted

## Actions
- login: Authenticate with email/password
- logout: End the current session
- reset_password: Request password reset link
- verify_email: Confirm email address

## Transitions
- pending_verification → active (when email verified)
- active → suspended (by admin action)
- suspended → active (by admin reinstatement)
- active → archived (by user deletion)
`;

/**
 * Mock fixture responses for deterministic extraction
 */
const MOCK_EXTRACTION_RESPONSE = {
  entities: [
    { name: 'Admin', kind: 'role', description: 'Can manage all users', confidence: 0.95 },
    { name: 'Customer', kind: 'role', description: 'Regular user', confidence: 0.92 },
    { name: 'Guest', kind: 'role', description: 'Limited access', confidence: 0.88 },
    { name: 'active', kind: 'state', description: 'User can access all features', confidence: 0.9 },
    { name: 'suspended', kind: 'state', description: 'User blocked', confidence: 0.9 },
    { name: 'pending_verification', kind: 'state', description: 'Email not confirmed', confidence: 0.85 },
    { name: 'login', kind: 'action', description: 'Authenticate user', confidence: 0.95 },
    { name: 'logout', kind: 'action', description: 'End session', confidence: 0.9 },
  ],
  statements: [
    { subject: 'pending_verification', predicate: 'TRANSITIONS_TO', object: 'active', confidence: 0.92 },
    { subject: 'active', predicate: 'TRANSITIONS_TO', object: 'suspended', confidence: 0.88 },
    { subject: 'Admin', predicate: 'ROLE_CAN', object: 'login', confidence: 0.95 },
  ],
};

describe('Phase 1 E2E Integration Tests', () => {
  describe('Task 1.7.1: MockLLMProvider E2E Flow', () => {
    let tempDir: string;
    let mockProvider: MockLLMProvider;
    let extractionProvider: DefaultExtractionProvider;
    let memoryStore: MemoryStore;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-e2e-'));
      
      // Setup MockLLMProvider with deterministic response
      mockProvider = createMockLLMProvider({
        defaultParsed: MOCK_EXTRACTION_RESPONSE,
        defaultResponse: JSON.stringify(MOCK_EXTRACTION_RESPONSE),
        captureRequests: true,
      });
      
      // Setup ExtractionProvider using MockLLMProvider
      extractionProvider = createDefaultExtractionProvider(mockProvider, {
        enableConfidence: true,
        enableEvidenceSpans: true,
      });
      
      // Setup MemoryStore
      memoryStore = createMemoryStore({
        workspaceKey: 'e2e-test-workspace',
        runId: `run-${Date.now()}`,
      });
      await memoryStore.init();
    });

    afterEach(async () => {
      await memoryStore.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should extract entities from markdown via ExtractionProvider', async () => {
      // Create chunks from sample content
      const chunks = createChunksFromContent(SAMPLE_MARKDOWN, 'auth-system.md', {
        maxChunkSize: 2000,
      });
      
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toContain('User Authentication');
      
      // Run extraction
      const result = await extractionProvider.extract(
        chunks,
        { kinds: ['role', 'state', 'action'], predicates: ['TRANSITIONS_TO', 'ROLE_CAN'] },
        { name: 'e2e-test', artifactRole: 'spec' }
      );
      
      // Verify entities extracted
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.statements.length).toBeGreaterThan(0);
      
      // Verify entity structure
      const adminEntity = result.entities.find(e => e.name === 'Admin');
      expect(adminEntity).toBeDefined();
      expect(adminEntity?.type).toBe('role');
      expect(adminEntity?.confidence).toBeGreaterThan(0.8);
      expect(adminEntity?.source).toBe('llm');
      expect(adminEntity?.state).toBe('new');
      expect(adminEntity?.labels).toContain('Staging');
      expect(adminEntity?.evidence).toHaveLength(1);
      
      // Verify statement structure
      const transitionStmt = result.statements.find(
        s => s.predicate === 'TRANSITIONS_TO'
      );
      expect(transitionStmt).toBeDefined();
      expect(transitionStmt?.confidence).toBeGreaterThan(0.8);
      expect(transitionStmt?.state).toBe('new');
      expect(transitionStmt?.labels).toContain('Staging');
      
      // Verify metadata
      expect(result.meta.provider).toBe('default');
      expect(result.meta.llmProvider).toBe('mock');
      expect(result.meta.chunksProcessed).toBe(chunks.length);
    });

    it('should capture LLM requests for debugging', async () => {
      const chunks = createChunksFromContent(SAMPLE_MARKDOWN, 'test.md');
      
      await extractionProvider.extract(
        chunks,
        { kinds: ['role'], predicates: [] },
        { name: 'test' }
      );
      
      // Verify requests were captured
      const requests = mockProvider.getCapturedRequests();
      expect(requests.length).toBeGreaterThan(0);
      
      // Verify request structure
      const request = requests[0];
      expect(request.system).toBeDefined();
      expect(request.messages).toBeDefined();
      expect(request.messages.length).toBeGreaterThan(0);
    });

    it('should store extracted entities in MemoryStore', async () => {
      const chunks = createChunksFromContent(SAMPLE_MARKDOWN, 'auth.md');
      
      const result = await extractionProvider.extract(
        chunks,
        { kinds: ['role', 'state', 'action'], predicates: ['TRANSITIONS_TO'] },
        { name: 'store-test' }
      );
      
      // Store as staging snapshot at RX stage
      const snapshot = {
        entities: result.entities,
        statements: result.statements,
        timestamp: new Date().toISOString(),
      };
      
      await memoryStore.writeSnapshot('auth-artifact', 'RX', snapshot);
      
      // Read back and verify
      const readSnapshot = await memoryStore.readSnapshot('auth-artifact', 'RX');
      expect(readSnapshot).toBeDefined();
      expect(readSnapshot?.entities.length).toBe(result.entities.length);
      expect(readSnapshot?.statements.length).toBe(result.statements.length);
    });

    it('should write run metadata correctly', async () => {
      const runMeta = {
        runId: memoryStore.getRunId(),
        workspaceKey: memoryStore.getWorkspaceKey(),
        schemaVersion: '1.0.0',
        startedAt: new Date().toISOString(),
        stages: ['RX'] as const,
      };
      
      await memoryStore.saveRunMeta(runMeta);
      
      const readMeta = await memoryStore.getRunMeta(memoryStore.getRunId());
      expect(readMeta).toBeDefined();
      expect(readMeta?.workspaceKey).toBe('e2e-test-workspace');
      expect(readMeta?.schemaVersion).toBe('1.0.0');
    });

    it('should produce deterministic output under MockLLMProvider', async () => {
      const chunks = createChunksFromContent(SAMPLE_MARKDOWN, 'test.md');
      const schema = { kinds: ['role', 'state'], predicates: ['TRANSITIONS_TO'] };
      const profile = { name: 'determinism-test' };
      
      // Run extraction twice
      const result1 = await extractionProvider.extract(chunks, schema, profile);
      
      // Reset mock to clear captured requests
      mockProvider.reset();
      
      const result2 = await extractionProvider.extract(chunks, schema, profile);
      
      // Compare results (should be identical)
      expect(result1.entities.length).toBe(result2.entities.length);
      expect(result1.statements.length).toBe(result2.statements.length);
      
      // Compare entity names
      const names1 = result1.entities.map(e => e.name).sort();
      const names2 = result2.entities.map(e => e.name).sort();
      expect(names1).toEqual(names2);
    });
  });

  describe('Task 1.7.1: FileStore E2E Flow', () => {
    let tempDir: string;
    let mockProvider: MockLLMProvider;
    let extractionProvider: DefaultExtractionProvider;
    let fileStore: FileStore;
    let testRunId: string;
    const testWorkspaceKey = 'file-e2e-workspace';

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-file-e2e-'));
      testRunId = `run-${Date.now()}`;
      
      mockProvider = createMockLLMProvider({
        defaultParsed: MOCK_EXTRACTION_RESPONSE,
        defaultResponse: JSON.stringify(MOCK_EXTRACTION_RESPONSE),
      });
      
      extractionProvider = createDefaultExtractionProvider(mockProvider);
      
      fileStore = createFileStore({
        rootDir: tempDir,
        workspaceKey: testWorkspaceKey,
        runId: testRunId,
      });
      await fileStore.init();
    });

    afterEach(async () => {
      await fileStore.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should write artifacts to expected file structure', async () => {
      const chunks = createChunksFromContent(SAMPLE_MARKDOWN, 'spec/auth.md');
      
      const result = await extractionProvider.extract(
        chunks,
        { kinds: ['role', 'state'], predicates: [] },
        { name: 'file-test' }
      );
      
      // Write RX stage output
      await fileStore.writeSnapshot('spec-auth', 'RX', {
        entities: result.entities,
        statements: result.statements,
        timestamp: new Date().toISOString(),
      });
      
      // Verify file exists
      const rxPath = path.join(
        tempDir,
        'workspaces',
        testWorkspaceKey,
        'runs',
        testRunId,
        'artifacts',
        'spec-auth',
        'rx.json'
      );
      
      const exists = await fs.stat(rxPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      
      // Verify content
      const content = await fs.readFile(rxPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.entities.length).toBe(result.entities.length);
    });

    it('should write run.meta.json with workspaceKey and schemaVersion', async () => {
      const runMeta = {
        runId: testRunId,
        workspaceKey: testWorkspaceKey,
        schemaVersion: '1.0.0',
        startedAt: new Date().toISOString(),
        stages: ['RX'] as const,
      };
      
      await fileStore.saveRunMeta(runMeta);
      
      // Verify file exists
      const metaPath = path.join(
        tempDir,
        'workspaces',
        testWorkspaceKey,
        'runs',
        testRunId,
        'run.meta.json'
      );
      
      const content = await fs.readFile(metaPath, 'utf-8');
      const parsed = JSON.parse(content);
      
      expect(parsed.workspaceKey).toBe(testWorkspaceKey);
      expect(parsed.schemaVersion).toBe('1.0.0');
      expect(parsed.runId).toBe(testRunId);
    });
  });

  describe('Task 1.7.2: OpenAI Integration Test (Optional)', () => {
    const hasApiKey = !!process.env.OPENAI_API_KEY;

    it.skipIf(!hasApiKey)('should extract entities using OpenAI (requires OPENAI_API_KEY)', async () => {
      // This test only runs when OPENAI_API_KEY is set
      const { createOpenAILLMProvider } = await import('../providers/llm/openai.js');
      
      const openaiProvider = createOpenAILLMProvider({
        model: 'gpt-4o-mini',
      });
      
      const extractionProvider = createDefaultExtractionProvider(openaiProvider, {
        temperature: 0.1,
        enableConfidence: true,
      });
      
      // Use a smaller sample for cost efficiency
      const smallSample = `# Simple Test
## Roles
- Admin: manages system
- User: uses the system

## States
- active: working
- inactive: not working
`;
      
      const chunks = createChunksFromContent(smallSample, 'test.md');
      
      const result = await extractionProvider.extract(
        chunks,
        { kinds: ['role', 'state'], predicates: [] },
        { name: 'openai-test' }
      );
      
      // Verify extraction worked
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.meta.llmProvider).toBe('openai');
      
      // Verify at least some expected entities
      const entityNames = result.entities.map(e => e.name.toLowerCase());
      expect(entityNames.some(n => n.includes('admin') || n.includes('user'))).toBe(true);
    });
  });
});
