// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Store Tests - Phase 1.6.4
 *
 * Unit tests for ArtifactStore (file and memory implementations)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  MemoryStore,
  createMemoryStore,
  FileStore,
  createFileStore,
  type Artifact,
  type Chunk,
  type Stage,
  STAGES,
} from "../stores/index.js";
import type { StagingSnapshot } from "@intentweave/core";

describe("Store implementations", () => {
  describe("MemoryStore", () => {
    let store: MemoryStore;

    beforeEach(async () => {
      store = createMemoryStore({
        workspaceKey: "test-workspace",
        runId: "test-run-001",
      });
      await store.init();
    });

    afterEach(async () => {
      await store.close();
    });

    describe("workspace methods", () => {
      it("gets and sets workspace key", () => {
        expect(store.getWorkspaceKey()).toBe("test-workspace");
        store.setWorkspaceKey("new-workspace");
        expect(store.getWorkspaceKey()).toBe("new-workspace");
      });

      it("gets and sets run ID", () => {
        expect(store.getRunId()).toBe("test-run-001");
        store.setRunId("test-run-002");
        expect(store.getRunId()).toBe("test-run-002");
      });
    });

    describe("artifact operations", () => {
      const testArtifact: Artifact = {
        id: "artifact-001",
        path: "test/prompt.md",
        content: "# Test Prompt\n\nThis is a test.",
        meta: {
          path: "test/prompt.md",
          format: "markdown",
          role: "intent",
        },
      };

      it("writes and reads artifact", async () => {
        await store.writeArtifact(testArtifact);
        const read = await store.readArtifact("artifact-001");

        expect(read).toEqual(testArtifact);
      });

      it("returns null for non-existent artifact", async () => {
        const read = await store.readArtifact("non-existent");
        expect(read).toBeNull();
      });

      it("lists artifacts", async () => {
        await store.writeArtifact(testArtifact);
        await store.writeArtifact({ ...testArtifact, id: "artifact-002" });

        const list = await store.listArtifacts();
        expect(list).toContain("artifact-001");
        expect(list).toContain("artifact-002");
        expect(list.length).toBe(2);
      });
    });

    describe("chunk operations", () => {
      const testChunks: Chunk[] = [
        {
          id: "chunk-1",
          artifactId: "art-1",
          content: "First chunk",
          start: 0,
          end: 100,
          index: 0,
        },
        {
          id: "chunk-2",
          artifactId: "art-1",
          content: "Second chunk",
          start: 101,
          end: 200,
          index: 1,
        },
      ];

      it("writes and reads chunks", async () => {
        await store.writeChunks("art-1", testChunks);
        const read = await store.readChunks("art-1");

        expect(read).toEqual(testChunks);
      });

      it("returns empty array for non-existent chunks", async () => {
        const read = await store.readChunks("non-existent");
        expect(read).toEqual([]);
      });
    });

    describe("snapshot operations", () => {
      const testSnapshot: StagingSnapshot = {
        timestamp: "2026-01-10T12:00:00Z",
        entities: [
          {
            cgId: "ws_0000|model|kg|role/admin",
            name: "Admin",
            type: "role",
            origin: "test",
            reviewStatus: "pending",
          },
        ],
        statements: [],
        runId: "test-run-001",
      };

      it("writes and reads stage snapshot", async () => {
        await store.writeSnapshot("art-1", "RX", testSnapshot);
        const read = await store.readSnapshot("art-1", "RX");

        expect(read).toEqual(testSnapshot);
      });

      it("returns null for non-existent snapshot", async () => {
        const read = await store.readSnapshot("art-1", "CX");
        expect(read).toBeNull();
      });

      // Note: listCompletedStages is a future enhancement
    });

    describe("run operations", () => {
      it("saves and retrieves run meta", async () => {
        const meta = {
          runId: "test-run-001",
          workspaceId: "ws_test",
          startedAt: "2026-01-10T12:00:00Z",
          status: "running" as const,
        };

        await store.saveRunMeta(meta);
        const read = await store.getRunMeta("test-run-001");

        expect(read).toEqual(meta);
      });

      it("lists runs", async () => {
        await store.saveRunMeta({
          runId: "run-1",
          workspaceId: "ws",
          startedAt: "",
          status: "completed",
        });
        await store.saveRunMeta({
          runId: "run-2",
          workspaceId: "ws",
          startedAt: "",
          status: "running",
        });

        const runs = await store.listRuns();
        expect(runs).toContain("run-1");
        expect(runs).toContain("run-2");
      });

      it("deletes run", async () => {
        await store.saveRunMeta({
          runId: "to-delete",
          workspaceId: "ws",
          startedAt: "",
          status: "completed",
        });
        await store.deleteRun("to-delete");

        const meta = await store.getRunMeta("to-delete");
        expect(meta).toBeNull();
      });
    });

    describe("aggregate operations", () => {
      it("saves and retrieves aggregates", async () => {
        await store.saveAggregates("test-run-001", {
          linkProposals: [{ id: "link-1" }] as any,
          coverage: { total: 10, linked: 5 } as any,
        });

        const agg = await store.getAggregates("test-run-001");
        expect(agg.linkProposals).toHaveLength(1);
        expect(agg.coverage).toBeDefined();
      });

      it("merges aggregates on update", async () => {
        await store.saveAggregates("test-run-001", {
          linkProposals: [{ id: "link-1" }] as any,
        });
        await store.saveAggregates("test-run-001", {
          coverage: { total: 10 } as any,
        });

        const agg = await store.getAggregates("test-run-001");
        expect(agg.linkProposals).toBeDefined();
        expect(agg.coverage).toBeDefined();
      });
    });
  });

  describe("FileStore", () => {
    let store: FileStore;
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "iw-store-test-"));
      store = createFileStore({
        rootDir: tempDir,
        workspaceKey: "test-workspace",
        runId: "test-run-001",
      });
      await store.init();
    });

    afterEach(async () => {
      await store.close();
      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe("workspace scoping", () => {
      it("creates workspace-scoped directory structure", async () => {
        const workspaceDir = path.join(tempDir, "workspaces", "test-workspace");
        const runsDir = path.join(workspaceDir, "runs");

        const stats = await fs.stat(runsDir);
        expect(stats.isDirectory()).toBe(true);
      });

      it("sets and gets workspace key", () => {
        expect(store.getWorkspaceKey()).toBe("test-workspace");
        store.setWorkspaceKey("other-workspace");
        expect(store.getWorkspaceKey()).toBe("other-workspace");
      });
    });

    describe("artifact operations", () => {
      const testArtifact: Artifact = {
        id: "artifact-001",
        path: "test/prompt.md",
        content: "# Test Prompt",
        meta: {
          path: "test/prompt.md",
          format: "markdown",
          role: "intent",
        },
      };

      it("persists artifact to disk", async () => {
        await store.writeArtifact(testArtifact);

        const artifactPath = path.join(
          tempDir,
          "workspaces",
          "test-workspace",
          "runs",
          "test-run-001",
          "artifacts",
          "artifact-001",
          "artifact.json",
        );

        const content = await fs.readFile(artifactPath, "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.id).toBe("artifact-001");
      });

      it("reads artifact from disk", async () => {
        await store.writeArtifact(testArtifact);
        const read = await store.readArtifact("artifact-001");

        expect(read).toEqual(testArtifact);
      });
    });

    describe("snapshot persistence", () => {
      const testSnapshot: StagingSnapshot = {
        timestamp: "2026-01-10T12:00:00Z",
        entities: [],
        statements: [],
        runId: "test-run-001",
      };

      it("writes snapshot to correct file", async () => {
        await store.writeSnapshot("art-1", "RX", testSnapshot);

        const snapshotPath = path.join(
          tempDir,
          "workspaces",
          "test-workspace",
          "runs",
          "test-run-001",
          "artifacts",
          "art-1",
          "rx.json",
        );

        const exists = await fs
          .stat(snapshotPath)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(true);
      });

      it("reads snapshot from file", async () => {
        await store.writeSnapshot("art-1", "CX", testSnapshot);
        const read = await store.readSnapshot("art-1", "CX");

        expect(read).toEqual(testSnapshot);
      });
    });

    describe("run meta persistence", () => {
      it("persists run meta to run.meta.json", async () => {
        const meta = {
          runId: "test-run-001",
          workspaceId: "ws_test",
          startedAt: "2026-01-10T12:00:00Z",
          status: "running" as const,
        };

        await store.saveRunMeta(meta);

        const metaPath = path.join(
          tempDir,
          "workspaces",
          "test-workspace",
          "runs",
          "test-run-001",
          "run.meta.json",
        );

        const content = await fs.readFile(metaPath, "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.runId).toBe("test-run-001");
      });
    });

    describe("aggregate persistence", () => {
      it("persists aggregates to aggregate directory", async () => {
        await store.saveAggregates("test-run-001", {
          linkProposals: [{ id: "link-1", confidence: 0.9 }] as any,
        });

        const aggPath = path.join(
          tempDir,
          "workspaces",
          "test-workspace",
          "runs",
          "test-run-001",
          "aggregate",
          "lx.proposals.json",
        );

        const exists = await fs
          .stat(aggPath)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(true);
      });
    });
  });

  describe("STAGES constant", () => {
    it("contains all pipeline stages in order", () => {
      expect(STAGES).toEqual(["IN", "RX", "CX", "MX", "PX", "LX"]);
    });
  });
});
