// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory-based Store Implementation
 *
 * In-memory store for testing and ephemeral use cases.
 * Data is lost when the process exits.
 */

import type { StagingSnapshot } from "@intentweave/core";
import type {
  Store,
  Artifact,
  Chunk,
  Stage,
  RunMeta,
  RunAggregates,
  LinkProposal,
  CoverageReport,
  FindingsReport,
} from "./types.js";

/**
 * Options for creating a MemoryStore
 */
export interface MemoryStoreOptions {
  /** Workspace key for scoping (optional, used for metadata) */
  workspaceKey?: string;
  /** Current run ID */
  runId?: string;
}

/**
 * In-memory implementation of the Store interface
 */
export class MemoryStore implements Store {
  private artifacts = new Map<string, Artifact>();
  private chunks = new Map<string, Chunk[]>();
  private snapshots = new Map<string, StagingSnapshot>();
  private runs = new Map<string, RunMeta>();
  private aggregates = new Map<string, RunAggregates>();

  private workspaceKey: string | null;
  private runId: string | null;

  constructor(options: MemoryStoreOptions = {}) {
    this.workspaceKey = options.workspaceKey ?? null;
    this.runId = options.runId ?? null;
  }

  // ============================================================================
  // Workspace Methods
  // ============================================================================

  /**
   * Set the workspace key
   */
  setWorkspaceKey(workspaceKey: string): void {
    this.workspaceKey = workspaceKey;
  }

  /**
   * Get the current workspace key
   */
  getWorkspaceKey(): string | null {
    return this.workspaceKey;
  }

  /**
   * Set the current run ID
   */
  setRunId(runId: string): void {
    this.runId = runId;
  }

  /**
   * Get the current run ID
   */
  getRunId(): string | null {
    return this.runId;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async init(): Promise<void> {
    // No-op for memory store
  }

  async close(): Promise<void> {
    // Clear all data
    this.artifacts.clear();
    this.chunks.clear();
    this.snapshots.clear();
    this.runs.clear();
    this.aggregates.clear();
  }

  // ============================================================================
  // ArtifactStore
  // ============================================================================

  async readArtifact(artifactId: string): Promise<Artifact | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async writeArtifact(artifact: Artifact): Promise<void> {
    this.artifacts.set(artifact.id, artifact);
  }

  async listArtifacts(): Promise<string[]> {
    return Array.from(this.artifacts.keys());
  }

  async readChunks(artifactId: string): Promise<Chunk[]> {
    return this.chunks.get(artifactId) ?? [];
  }

  async writeChunks(artifactId: string, chunks: Chunk[]): Promise<void> {
    this.chunks.set(artifactId, chunks);
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    this.artifacts.delete(artifactId);
    this.chunks.delete(artifactId);
    // Also delete all snapshots for this artifact
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(`${artifactId}:`)) {
        this.snapshots.delete(key);
      }
    }
  }

  async writeStageOutput(
    artifactId: string,
    stage: Stage,
    output: unknown,
  ): Promise<void> {
    // Store stage output using the same key pattern as snapshots
    this.snapshots.set(
      this.snapshotKey(artifactId, stage),
      output as StagingSnapshot,
    );
  }

  async readStageOutput<T = unknown>(
    artifactId: string,
    stage: Stage,
  ): Promise<T | null> {
    const data = this.snapshots.get(this.snapshotKey(artifactId, stage));
    return (data as T) ?? null;
  }

  async writeRunMeta(runId: string, meta: RunMeta): Promise<void> {
    this.runs.set(runId, meta);
  }

  async readRunMeta(runId: string): Promise<RunMeta | null> {
    return this.runs.get(runId) ?? null;
  }

  // ============================================================================
  // GraphStore
  // ============================================================================

  private snapshotKey(artifactId: string, stage: Stage): string {
    return `${artifactId}:${stage}`;
  }

  async readSnapshot(
    artifactId: string,
    stage: Stage,
  ): Promise<StagingSnapshot | null> {
    return this.snapshots.get(this.snapshotKey(artifactId, stage)) ?? null;
  }

  async writeSnapshot(
    artifactId: string,
    stage: Stage,
    snapshot: StagingSnapshot,
  ): Promise<void> {
    this.snapshots.set(this.snapshotKey(artifactId, stage), snapshot);
  }

  async getStages(artifactId: string): Promise<Stage[]> {
    const stages: Stage[] = [];
    for (const key of this.snapshots.keys()) {
      if (key.startsWith(`${artifactId}:`)) {
        const stage = key.split(":")[1] as Stage;
        stages.push(stage);
      }
    }
    return stages;
  }

  // ============================================================================
  // RunStore
  // ============================================================================

  async getRunMeta(runId: string): Promise<RunMeta | null> {
    return this.runs.get(runId) ?? null;
  }

  async saveRunMeta(meta: RunMeta): Promise<void> {
    this.runs.set(meta.runId, meta);
  }

  async listRuns(): Promise<string[]> {
    return Array.from(this.runs.keys());
  }

  async getAggregates(runId: string): Promise<RunAggregates> {
    return this.aggregates.get(runId) ?? {};
  }

  async saveAggregates(
    runId: string,
    aggregates: Partial<RunAggregates>,
  ): Promise<void> {
    const existing = this.aggregates.get(runId) ?? {};
    this.aggregates.set(runId, { ...existing, ...aggregates });
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    this.aggregates.delete(runId);
  }
}

/**
 * Create a new in-memory store
 */
export function createMemoryStore(
  options: MemoryStoreOptions = {},
): MemoryStore {
  return new MemoryStore(options);
}
