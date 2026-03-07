/**
 * File-based Store Implementation
 * 
 * Persistent file-based store using JSON files.
 * Directory structure (workspace-scoped):
 * 
 * .iw/
 * └── workspaces/<workspaceKey>/
 *     └── runs/<runId>/
 *         ├── artifacts/<artifactId>/
 *         │   ├── artifact.json
 *         │   ├── chunks.json
 *         │   ├── in.json
 *         │   ├── rx.json
 *         │   ├── cx.json
 *         │   ├── mx.json
 *         │   ├── px.json
 *         │   └── lx.json
 *         ├── aggregate/
 *         │   ├── lx.proposals.json
 *         │   ├── coverage.json
 *         │   └── findings.json
 *         └── run.meta.json
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { StagingSnapshot } from '@intentweave/core';
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
} from './types.js';
import { STAGES } from './types.js';

/**
 * Options for creating a FileStore
 */
export interface FileStoreOptions {
  /** Root directory for storage (defaults to .iw) */
  rootDir?: string;
  /** Workspace key (required for workspace-scoped storage) */
  workspaceKey?: string;
  /** Current run ID (required for write operations) */
  runId?: string;
}

/**
 * File-based implementation of the Store interface
 */
export class FileStore implements Store {
  private rootDir: string;
  private workspaceKey: string | null;
  private runId: string | null;

  constructor(options: FileStoreOptions = {}) {
    this.rootDir = options.rootDir ?? '.iw';
    this.workspaceKey = options.workspaceKey ?? null;
    this.runId = options.runId ?? null;
  }

  // ============================================================================
  // Path Helpers
  // ============================================================================

  /**
   * Get the workspace directory path
   * If workspaceKey is set, uses workspace-scoped path
   */
  private workspaceDir(): string {
    if (this.workspaceKey) {
      return path.join(this.rootDir, 'workspaces', this.workspaceKey);
    }
    // Legacy: direct under rootDir (backwards compatible)
    return this.rootDir;
  }

  private runsDir(): string {
    return path.join(this.workspaceDir(), 'runs');
  }

  private runDir(runId: string): string {
    return path.join(this.runsDir(), runId);
  }

  private artifactsDir(runId: string): string {
    return path.join(this.runDir(runId), 'artifacts');
  }

  private artifactDir(runId: string, artifactId: string): string {
    // Sanitize artifact ID for filesystem
    const safeId = artifactId.replace(/[/\\:*?"<>|]/g, '_');
    return path.join(this.artifactsDir(runId), safeId);
  }

  private aggregateDir(runId: string): string {
    return path.join(this.runDir(runId), 'aggregate');
  }

  private getCurrentRunId(): string {
    if (!this.runId) {
      throw new Error('No run ID set. Call setRunId() or pass runId to constructor.');
    }
    return this.runId;
  }

  // ============================================================================
  // Workspace Methods
  // ============================================================================

  /**
   * Set the workspace key for workspace-scoped storage
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

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Set the current run ID for write operations
   */
  setRunId(runId: string): void {
    this.runId = runId;
  }

  async init(): Promise<void> {
    // Create root directory structure
    await fs.mkdir(this.runsDir(), { recursive: true });
    
    if (this.runId) {
      await fs.mkdir(this.artifactsDir(this.runId), { recursive: true });
      await fs.mkdir(this.aggregateDir(this.runId), { recursive: true });
    }
  }

  async close(): Promise<void> {
    // No cleanup needed for file store
  }

  // ============================================================================
  // File I/O Helpers
  // ============================================================================

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async writeJson<T>(filePath: string, data: T): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async listDirs(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  // ============================================================================
  // ArtifactStore
  // ============================================================================

  async readArtifact(artifactId: string): Promise<Artifact | null> {
    const runId = this.getCurrentRunId();
    const filePath = path.join(this.artifactDir(runId, artifactId), 'artifact.json');
    return this.readJson<Artifact>(filePath);
  }

  async writeArtifact(artifact: Artifact): Promise<void> {
    const runId = this.getCurrentRunId();
    const filePath = path.join(this.artifactDir(runId, artifact.id), 'artifact.json');
    await this.writeJson(filePath, artifact);
  }

  async listArtifacts(): Promise<string[]> {
    const runId = this.getCurrentRunId();
    const artifactsPath = this.artifactsDir(runId);
    const dirs = await this.listDirs(artifactsPath);
    
    // Return artifact IDs (read from artifact.json to get original ID)
    const ids: string[] = [];
    for (const dir of dirs) {
      const artifact = await this.readJson<Artifact>(
        path.join(artifactsPath, dir, 'artifact.json')
      );
      if (artifact) {
        ids.push(artifact.id);
      }
    }
    return ids;
  }

  async readChunks(artifactId: string): Promise<Chunk[]> {
    const runId = this.getCurrentRunId();
    const filePath = path.join(this.artifactDir(runId, artifactId), 'chunks.json');
    return (await this.readJson<Chunk[]>(filePath)) ?? [];
  }

  async writeChunks(artifactId: string, chunks: Chunk[]): Promise<void> {
    const runId = this.getCurrentRunId();
    const filePath = path.join(this.artifactDir(runId, artifactId), 'chunks.json');
    await this.writeJson(filePath, chunks);
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    const runId = this.getCurrentRunId();
    const dir = this.artifactDir(runId, artifactId);
    try {
      await fs.rm(dir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async writeStageOutput(artifactId: string, stage: Stage, output: unknown): Promise<void> {
    const runId = this.getCurrentRunId();
    const filePath = path.join(
      this.artifactDir(runId, artifactId),
      this.stageFileName(stage)
    );
    await this.writeJson(filePath, output);
  }

  async readStageOutput<T = unknown>(artifactId: string, stage: Stage): Promise<T | null> {
    const runId = this.getCurrentRunId();
    const filePath = path.join(
      this.artifactDir(runId, artifactId),
      this.stageFileName(stage)
    );
    return this.readJson<T>(filePath);
  }

  async writeRunMeta(runId: string, meta: RunMeta): Promise<void> {
    const filePath = path.join(this.runDir(runId), 'run.meta.json');
    await this.writeJson(filePath, meta);
  }

  async readRunMeta(runId: string): Promise<RunMeta | null> {
    const filePath = path.join(this.runDir(runId), 'run.meta.json');
    return this.readJson<RunMeta>(filePath);
  }

  // ============================================================================
  // GraphStore
  // ============================================================================

  private stageFileName(stage: Stage): string {
    return `${stage.toLowerCase()}.json`;
  }

  async readSnapshot(artifactId: string, stage: Stage): Promise<StagingSnapshot | null> {
    const runId = this.getCurrentRunId();
    const filePath = path.join(
      this.artifactDir(runId, artifactId),
      this.stageFileName(stage)
    );
    return this.readJson<StagingSnapshot>(filePath);
  }

  async writeSnapshot(artifactId: string, stage: Stage, snapshot: StagingSnapshot): Promise<void> {
    const runId = this.getCurrentRunId();
    const filePath = path.join(
      this.artifactDir(runId, artifactId),
      this.stageFileName(stage)
    );
    await this.writeJson(filePath, snapshot);
  }

  async getStages(artifactId: string): Promise<Stage[]> {
    const runId = this.getCurrentRunId();
    const dir = this.artifactDir(runId, artifactId);
    const stages: Stage[] = [];
    
    for (const stage of STAGES) {
      const filePath = path.join(dir, this.stageFileName(stage));
      if (await this.exists(filePath)) {
        stages.push(stage);
      }
    }
    
    return stages;
  }

  // ============================================================================
  // RunStore
  // ============================================================================

  async getRunMeta(runId: string): Promise<RunMeta | null> {
    const filePath = path.join(this.runDir(runId), 'run.meta.json');
    return this.readJson<RunMeta>(filePath);
  }

  async saveRunMeta(meta: RunMeta): Promise<void> {
    const filePath = path.join(this.runDir(meta.runId), 'run.meta.json');
    await this.writeJson(filePath, meta);
  }

  async listRuns(): Promise<string[]> {
    return this.listDirs(this.runsDir());
  }

  async getAggregates(runId: string): Promise<RunAggregates> {
    const aggDir = this.aggregateDir(runId);
    
    const [linkProposals, coverage, findings] = await Promise.all([
      this.readJson<LinkProposal[]>(path.join(aggDir, 'lx.proposals.json')),
      this.readJson<CoverageReport>(path.join(aggDir, 'coverage.json')),
      this.readJson<FindingsReport>(path.join(aggDir, 'findings.json')),
    ]);

    const result: RunAggregates = {};
    if (linkProposals) result.linkProposals = linkProposals;
    if (coverage) result.coverage = coverage;
    if (findings) result.findings = findings;
    
    return result;
  }

  async saveAggregates(runId: string, aggregates: Partial<RunAggregates>): Promise<void> {
    const aggDir = this.aggregateDir(runId);
    
    const writes: Promise<void>[] = [];
    
    if (aggregates.linkProposals) {
      // Wrap link proposals with schema
      const lxFile = {
        $schema: 'intentweave://schemas/lx-proposals/v1',
        schemaVersion: '0.1',
        proposals: aggregates.linkProposals,
        meta: {
          proposalCount: aggregates.linkProposals.length,
          sameEntityCount: aggregates.linkProposals.filter(p => p.confidence >= 0.95).length,
          relatedEntityCount: aggregates.linkProposals.filter(p => p.confidence < 0.95).length,
        },
      };
      writes.push(this.writeJson(
        path.join(aggDir, 'lx.proposals.json'),
        lxFile
      ));
    }
    
    if (aggregates.coverage) {
      // Add schema to simple coverage
      const coverageFile = {
        $schema: 'intentweave://schemas/coverage/v1',
        ...aggregates.coverage,
      };
      writes.push(this.writeJson(
        path.join(aggDir, 'coverage.json'),
        coverageFile
      ));
    }
    
    if (aggregates.findings) {
      // Add schema to simple findings
      const findingsFile = {
        $schema: 'intentweave://schemas/findings/v1',
        ...aggregates.findings,
      };
      writes.push(this.writeJson(
        path.join(aggDir, 'findings.json'),
        findingsFile
      ));
    }
    
    // Write rich coverage report if available (already has $schema)
    if (aggregates.richCoverage) {
      writes.push(this.writeJson(
        path.join(aggDir, 'coverage-report.json'),
        aggregates.richCoverage
      ));
    }
    
    // Write rich validation output if available
    if (aggregates.richValidation) {
      const validationFile = {
        $schema: 'intentweave://schemas/validation/v1',
        schemaVersion: '0.1',
        ...(aggregates.richValidation as object),
      };
      writes.push(this.writeJson(
        path.join(aggDir, 'validation.json'),
        validationFile
      ));
    }
    
    await Promise.all(writes);
  }

  async deleteRun(runId: string): Promise<void> {
    const dir = this.runDir(runId);
    try {
      await fs.rm(dir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

/**
 * Create a new file-based store
 */
export function createFileStore(options: FileStoreOptions = {}): FileStore {
  return new FileStore(options);
}
