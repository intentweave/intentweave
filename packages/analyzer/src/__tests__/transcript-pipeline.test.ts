// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Tests for Transcript Pipeline
 *
 * Tests the full pipeline flow for chat transcripts:
 * - Transcript discovery from .iw/transcripts/
 * - Per-message chunking in IN stage
 * - Fingerprint versioning (rolesHash, heuristicsVersion, adapterVersion)
 * - Incremental caching across runs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  discoverTranscriptArtifacts,
  type TranscriptDiscoveryOptions,
} from "../cache/registry.js";
import { runInStage, type InStageInput } from "../stages/in.js";
import { createPipelineContext } from "../pipeline/context.js";

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a minimal transcript JSONL for testing
 */
function createTestTranscript(sessionId: string, messageCount = 3): string {
  const messages = [];
  for (let i = 0; i < messageCount; i++) {
    const speaker = i % 2 === 0 ? "user" : "assistant";
    const role = i % 2 === 0 ? "intent" : "spec";
    messages.push(
      JSON.stringify({
        sourceKey: `specstory:${sessionId}:m:${i}`,
        id: `specstory:${sessionId}:m:${i}`,
        contentHash: `sha256:test${i}${"0".repeat(58)}`,
        source: "specstory",
        sourceSessionId: sessionId,
        seq: i,
        speaker,
        messageRole: role,
        text: `Test message ${i} from ${speaker}`,
        parserVersion: "specstory-parser@0.1.0",
      }),
    );
  }
  return messages.join("\n");
}

// =============================================================================
// Test Suite
// =============================================================================

describe("Transcript Pipeline Integration", () => {
  let tmpDir: string;
  let transcriptDir: string;

  beforeEach(async () => {
    // Create temp directory for test fixtures
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "iw-test-"));
    transcriptDir = path.join(tmpDir, ".iw", "transcripts", "specstory");
    await fs.mkdir(transcriptDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("Transcript Discovery", () => {
    it("discovers transcript artifacts from .iw/transcripts", async () => {
      // Create test transcript
      const sessionId = "test-session-001";
      await fs.writeFile(
        path.join(transcriptDir, `${sessionId}.jsonl`),
        createTestTranscript(sessionId, 5),
      );

      // Discover
      const artifacts = await discoverTranscriptArtifacts(tmpDir);

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].key).toEqual({
        type: "chat",
        key: "specstory:test-session-001",
      });
      expect(artifacts[0].format).toBe("transcript");
      expect(artifacts[0].role).toBe("chat");
      expect(artifacts[0].metadata?.messageCount).toBe(5);
    });

    it("respects sessionIds filter", async () => {
      // Create multiple transcripts
      await fs.writeFile(
        path.join(transcriptDir, "session-a.jsonl"),
        createTestTranscript("session-a", 3),
      );
      await fs.writeFile(
        path.join(transcriptDir, "session-b.jsonl"),
        createTestTranscript("session-b", 3),
      );

      // Discover with filter
      const artifacts = await discoverTranscriptArtifacts(tmpDir, {
        sessionIds: ["session-a"],
      });

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].key.key).toBe("specstory:session-a");
    });

    it("respects limit option and sorts by content length", async () => {
      // Create transcripts of different sizes
      await fs.writeFile(
        path.join(transcriptDir, "large.jsonl"),
        createTestTranscript("large", 10), // larger
      );
      await fs.writeFile(
        path.join(transcriptDir, "small.jsonl"),
        createTestTranscript("small", 2), // smaller
      );

      // Discover with limit
      const artifacts = await discoverTranscriptArtifacts(tmpDir, { limit: 1 });

      expect(artifacts).toHaveLength(1);
      // Should return the smaller one first (sorted by content length)
      expect(artifacts[0].key.key).toBe("specstory:small");
    });

    it("includes version metadata in artifact metadata", async () => {
      await fs.writeFile(
        path.join(transcriptDir, "test.jsonl"),
        createTestTranscript("test", 3),
      );

      const artifacts = await discoverTranscriptArtifacts(tmpDir);

      expect(artifacts[0].metadata).toMatchObject({
        source: "specstory",
        sessionId: "test",
        messageCount: 3,
        heuristicsVersion: expect.any(String),
        adapterVersion: expect.any(String),
        rolesHash: expect.any(String),
      });
    });
  });

  describe("Per-Message Chunking", () => {
    it("creates one chunk per message with stable IDs", async () => {
      // Create transcript
      const sessionId = "chunk-test";
      await fs.writeFile(
        path.join(transcriptDir, `${sessionId}.jsonl`),
        createTestTranscript(sessionId, 4),
      );

      // Discover
      const artifacts = await discoverTranscriptArtifacts(tmpDir);
      const artifact = artifacts[0];

      // Run IN stage
      const ctx = createPipelineContext({ basePath: tmpDir });
      const inInput: InStageInput = {
        artifactId: artifact.keyString,
        filePath: artifact.filePath!,
        content: artifact.content,
        artifactFormat: "transcript",
        artifactRole: "chat",
      };

      const inOutput = await runInStage(inInput, ctx);

      // Should have 4 chunks (one per message)
      expect(inOutput.chunks).toHaveLength(4);

      // Check chunk IDs are stable and message-based
      expect(inOutput.chunks[0].id).toMatch(/chat:specstory:chunk-test:m:0$/);
      expect(inOutput.chunks[1].id).toMatch(/chat:specstory:chunk-test:m:1$/);
      expect(inOutput.chunks[2].id).toMatch(/chat:specstory:chunk-test:m:2$/);
      expect(inOutput.chunks[3].id).toMatch(/chat:specstory:chunk-test:m:3$/);

      // Each chunk should have speaker/role in title
      expect(inOutput.chunks[0].title).toBe("[user/intent]");
      expect(inOutput.chunks[1].title).toBe("[assistant/spec]");
    });

    it("preserves chunk IDs across reimports", async () => {
      const sessionId = "stability-test";

      // First import
      await fs.writeFile(
        path.join(transcriptDir, `${sessionId}.jsonl`),
        createTestTranscript(sessionId, 3),
      );
      const artifacts1 = await discoverTranscriptArtifacts(tmpDir);
      const ctx = createPipelineContext({ basePath: tmpDir });
      const inOutput1 = await runInStage(
        {
          artifactId: artifacts1[0].keyString,
          filePath: artifacts1[0].filePath!,
          content: artifacts1[0].content,
          artifactFormat: "transcript",
        },
        ctx,
      );

      // Second import (same content)
      const artifacts2 = await discoverTranscriptArtifacts(tmpDir);
      const inOutput2 = await runInStage(
        {
          artifactId: artifacts2[0].keyString,
          filePath: artifacts2[0].filePath!,
          content: artifacts2[0].content,
          artifactFormat: "transcript",
        },
        ctx,
      );

      // Chunk IDs should be identical
      expect(inOutput1.chunks.map((c) => c.id)).toEqual(
        inOutput2.chunks.map((c) => c.id),
      );
    });
  });

  describe("Fingerprint Versioning", () => {
    it("content hash changes when message content changes", async () => {
      const sessionId = "fingerprint-test";

      // Version 1
      await fs.writeFile(
        path.join(transcriptDir, `${sessionId}.jsonl`),
        createTestTranscript(sessionId, 3),
      );
      const artifacts1 = await discoverTranscriptArtifacts(tmpDir);
      const hash1 = artifacts1[0].contentHash;

      // Version 2 (different message count)
      await fs.writeFile(
        path.join(transcriptDir, `${sessionId}.jsonl`),
        createTestTranscript(sessionId, 4),
      );
      const artifacts2 = await discoverTranscriptArtifacts(tmpDir);
      const hash2 = artifacts2[0].contentHash;

      // Hash should change
      expect(hash2).not.toBe(hash1);
    });

    it("content hash is stable for identical content", async () => {
      const sessionId = "stable-hash-test";

      // Write same content twice
      const content = createTestTranscript(sessionId, 3);
      await fs.writeFile(
        path.join(transcriptDir, `${sessionId}.jsonl`),
        content,
      );
      const artifacts1 = await discoverTranscriptArtifacts(tmpDir);

      await fs.writeFile(
        path.join(transcriptDir, `${sessionId}.jsonl`),
        content,
      );
      const artifacts2 = await discoverTranscriptArtifacts(tmpDir);

      // Hash should be identical
      expect(artifacts2[0].contentHash).toBe(artifacts1[0].contentHash);
    });
  });
});
