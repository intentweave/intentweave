/**
 * Incremental Pipeline Cache
 * 
 * Content-addressed cache for pipeline stage outputs.
 * Provides hermetic caching with proper invalidation.
 * 
 * Directory layout:
 * .iw/
 *   cache/
 *     artifacts/
 *       <artifactKey>/
 *         IN.json
 *         RX.json
 *         CX.json
 *         MX.json
 *         PX.json
 *         meta.json
 *     agg/
 *       <aggKey>/
 *         AGG.json
 *         LX.json
 *         meta.json
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  PerArtifactStage,
  GlobalStage,
  StageMeta,
  GlobalStageMeta,
  StageStats,
  PipelineConfig,
} from './types.js';
import { PIPELINE_STAGES } from './types.js';
import { hashContent } from './registry.js';

// =============================================================================
// Cache Directory Helpers
// =============================================================================

/**
 * Sanitize artifact key for filesystem use
 */
function sanitizeKey(key: string): string {
  return key
    .replace(/:/g, '__')   // Replace colons with double underscore
    .replace(/\//g, '_')    // Replace slashes with underscore
    .replace(/[<>"|?*]/g, '_'); // Replace other invalid chars
}

// =============================================================================
// Configuration Hashing
// =============================================================================

/**
 * Compute config hash for a specific stage
 */
export function computeStageConfigHash(
  stage: PerArtifactStage,
  config: PipelineConfig
): string {
  const stageConfig = config.stages[stage] ?? {};
  const globalConfig = config.global ?? {};
  
  // Include pipeline version + stage-specific config + relevant global config
  const hashInput = JSON.stringify({
    pipelineVersion: config.pipelineVersion,
    stage,
    stageConfig,
    profilePackHash: globalConfig.profilePackHash,
  });
  
  return hashContent(hashInput);
}

/**
 * Compute config hash for global stages (AGG/LX)
 */
export function computeGlobalConfigHash(
  stage: GlobalStage,
  config: PipelineConfig
): string {
  const globalConfig = config.global ?? {};
  
  const hashInput = JSON.stringify({
    pipelineVersion: config.pipelineVersion,
    stage,
    profilePackHash: globalConfig.profilePackHash,
  });
  
  return hashContent(hashInput);
}

// =============================================================================
// Cache Store Interface
// =============================================================================

/**
 * Cached stage output with metadata
 */
export interface CachedStageOutput<T = unknown> {
  /** The stage output data */
  data: T;
  /** Stage metadata */
  meta: StageMeta;
}

/**
 * Cached global stage output with metadata
 */
export interface CachedGlobalOutput<T = unknown> {
  /** The stage output data */
  data: T;
  /** Global stage metadata */
  meta: GlobalStageMeta;
}

/**
 * Cache lookup result
 */
export interface CacheLookupResult<T = unknown> {
  /** Whether cache hit occurred */
  hit: boolean;
  /** Cached data if hit */
  cached?: CachedStageOutput<T>;
  /** Reason for miss (if miss) */
  missReason?: 'not-found' | 'content-mismatch' | 'config-mismatch' | 'upstream-mismatch';
}

// =============================================================================
// File-Based Cache Implementation
// =============================================================================

/**
 * File-based incremental cache
 */
export class IncrementalCache {
  private cacheDir: string;
  private artifactsDir: string;
  private aggDir: string;
  
  constructor(baseDir: string) {
    this.cacheDir = path.join(baseDir, '.iw', 'cache');
    this.artifactsDir = path.join(this.cacheDir, 'artifacts');
    this.aggDir = path.join(this.cacheDir, 'agg');
  }
  
  // ===========================================================================
  // Lifecycle
  // ===========================================================================
  
  /**
   * Initialize cache directories
   */
  async init(): Promise<void> {
    await fs.mkdir(this.artifactsDir, { recursive: true });
    await fs.mkdir(this.aggDir, { recursive: true });
  }
  
  /**
   * Get cache directory path (for debugging)
   */
  getCacheDir(): string {
    return this.cacheDir;
  }
  
  // ===========================================================================
  // Path Helpers
  // ===========================================================================
  
  private artifactCacheDir(artifactKey: string): string {
    return path.join(this.artifactsDir, sanitizeKey(artifactKey));
  }
  
  private stageFilePath(artifactKey: string, stage: PerArtifactStage): string {
    return path.join(this.artifactCacheDir(artifactKey), `${stage}.json`);
  }
  
  private artifactMetaPath(artifactKey: string): string {
    return path.join(this.artifactCacheDir(artifactKey), 'meta.json');
  }
  
  private globalCacheDir(aggKey: string): string {
    return path.join(this.aggDir, sanitizeKey(aggKey));
  }
  
  private globalStageFilePath(aggKey: string, stage: GlobalStage): string {
    return path.join(this.globalCacheDir(aggKey), `${stage}.json`);
  }
  
  private globalMetaPath(aggKey: string): string {
    return path.join(this.globalCacheDir(aggKey), 'meta.json');
  }
  
  // ===========================================================================
  // Read Helpers
  // ===========================================================================
  
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
  
  // ===========================================================================
  // Per-Artifact Stage Cache
  // ===========================================================================
  
  /**
   * Get cached stage output
   */
  async getStage<T = unknown>(
    artifactKey: string,
    stage: PerArtifactStage
  ): Promise<CachedStageOutput<T> | null> {
    const dataPath = this.stageFilePath(artifactKey, stage);
    const metaPath = this.artifactMetaPath(artifactKey);
    
    const data = await this.readJson<T>(dataPath);
    if (!data) return null;
    
    const allMeta = await this.readJson<Record<PerArtifactStage, StageMeta>>(metaPath);
    if (!allMeta || !allMeta[stage]) return null;
    
    return {
      data,
      meta: allMeta[stage],
    };
  }
  
  /**
   * Get stage metadata only (without loading full output)
   */
  async getStageMeta(
    artifactKey: string,
    stage: PerArtifactStage
  ): Promise<StageMeta | null> {
    const metaPath = this.artifactMetaPath(artifactKey);
    const allMeta = await this.readJson<Record<PerArtifactStage, StageMeta>>(metaPath);
    if (!allMeta || !allMeta[stage]) return null;
    return allMeta[stage];
  }
  
  /**
   * Get all stage metadata for an artifact
   */
  async getAllStageMeta(
    artifactKey: string
  ): Promise<Partial<Record<PerArtifactStage, StageMeta>> | null> {
    const metaPath = this.artifactMetaPath(artifactKey);
    return await this.readJson<Record<PerArtifactStage, StageMeta>>(metaPath);
  }
  
  /**
   * Check if a stage output exists
   */
  async hasStage(artifactKey: string, stage: PerArtifactStage): Promise<boolean> {
    const dataPath = this.stageFilePath(artifactKey, stage);
    try {
      await fs.access(dataPath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Put a stage output with metadata
   */
  async putStage<T = unknown>(
    artifactKey: string,
    stage: PerArtifactStage,
    data: T,
    meta: StageMeta
  ): Promise<void> {
    // Write stage data
    const dataPath = this.stageFilePath(artifactKey, stage);
    await this.writeJson(dataPath, data);
    
    // Update metadata file (merge with existing)
    const metaPath = this.artifactMetaPath(artifactKey);
    const allMeta = await this.readJson<Partial<Record<PerArtifactStage, StageMeta>>>(metaPath) ?? {};
    allMeta[stage] = meta;
    await this.writeJson(metaPath, allMeta);
  }
  
  /**
   * Delete cached outputs for an artifact from a specific stage onward
   */
  async invalidateFrom(artifactKey: string, fromStage: PerArtifactStage): Promise<void> {
    const fromIndex = PIPELINE_STAGES.indexOf(fromStage);
    
    for (let i = fromIndex; i < PIPELINE_STAGES.length; i++) {
      const stage = PIPELINE_STAGES[i];
      const dataPath = this.stageFilePath(artifactKey, stage);
      
      try {
        await fs.unlink(dataPath);
      } catch {
        // Ignore if doesn't exist
      }
    }
    
    // Update metadata to remove invalidated stages
    const metaPath = this.artifactMetaPath(artifactKey);
    const allMeta = await this.readJson<Record<PerArtifactStage, StageMeta>>(metaPath);
    if (allMeta) {
      for (let i = fromIndex; i < PIPELINE_STAGES.length; i++) {
        delete allMeta[PIPELINE_STAGES[i]];
      }
      await this.writeJson(metaPath, allMeta);
    }
  }
  
  /**
   * Delete all cached outputs for an artifact
   */
  async deleteArtifact(artifactKey: string): Promise<void> {
    const dir = this.artifactCacheDir(artifactKey);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  }
  
  // ===========================================================================
  // Global Stage Cache (AGG/LX)
  // ===========================================================================
  
  /**
   * Get cached global stage output
   */
  async getGlobalStage<T = unknown>(
    aggKey: string,
    stage: GlobalStage
  ): Promise<CachedGlobalOutput<T> | null> {
    const dataPath = this.globalStageFilePath(aggKey, stage);
    const metaPath = this.globalMetaPath(aggKey);
    
    const data = await this.readJson<T>(dataPath);
    if (!data) return null;
    
    const allMeta = await this.readJson<Record<GlobalStage, GlobalStageMeta>>(metaPath);
    if (!allMeta || !allMeta[stage]) return null;
    
    return {
      data,
      meta: allMeta[stage],
    };
  }
  
  /**
   * Get global stage metadata only
   */
  async getGlobalMeta(
    aggKey: string,
    stage: GlobalStage
  ): Promise<GlobalStageMeta | null> {
    const metaPath = this.globalMetaPath(aggKey);
    const allMeta = await this.readJson<Record<GlobalStage, GlobalStageMeta>>(metaPath);
    if (!allMeta || !allMeta[stage]) return null;
    return allMeta[stage];
  }
  
  /**
   * Put a global stage output with metadata
   */
  async putGlobalStage<T = unknown>(
    aggKey: string,
    stage: GlobalStage,
    data: T,
    meta: GlobalStageMeta
  ): Promise<void> {
    // Write stage data
    const dataPath = this.globalStageFilePath(aggKey, stage);
    await this.writeJson(dataPath, data);
    
    // Update metadata file (merge with existing)
    const metaPath = this.globalMetaPath(aggKey);
    const allMeta = await this.readJson<Partial<Record<GlobalStage, GlobalStageMeta>>>(metaPath) ?? {};
    allMeta[stage] = meta;
    await this.writeJson(metaPath, allMeta);
  }
  
  /**
   * Delete cached global outputs
   */
  async deleteGlobal(aggKey: string): Promise<void> {
    const dir = this.globalCacheDir(aggKey);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  }
  
  // ===========================================================================
  // Bulk Operations
  // ===========================================================================
  
  /**
   * List all cached artifact keys
   */
  async listArtifacts(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.artifactsDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name.replace(/__/g, ':').replace(/_/g, '/'));
    } catch {
      return [];
    }
  }
  
  /**
   * Clear all cached data
   */
  async clearAll(): Promise<void> {
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
      await this.init();
    } catch {
      // Ignore errors
    }
  }
  
  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    artifactCount: number;
    totalSizeBytes: number;
    stageBreakdown: Record<PerArtifactStage | GlobalStage, number>;
  }> {
    const artifacts = await this.listArtifacts();
    const stageBreakdown: Record<string, number> = {};
    let totalSize = 0;
    
    // Initialize stage counts
    for (const stage of [...PIPELINE_STAGES, 'AGG', 'LX']) {
      stageBreakdown[stage] = 0;
    }
    
    // Count artifacts with each stage
    for (const artifactKey of artifacts) {
      for (const stage of PIPELINE_STAGES) {
        if (await this.hasStage(artifactKey, stage)) {
          stageBreakdown[stage]++;
        }
      }
    }
    
    // Calculate size (simplified - just count files)
    const walkDir = async (dir: string): Promise<number> => {
      let size = 0;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            size += await walkDir(fullPath);
          } else {
            const stat = await fs.stat(fullPath);
            size += stat.size;
          }
        }
      } catch {
        // Directory doesn't exist
      }
      return size;
    };
    
    totalSize = await walkDir(this.cacheDir);
    
    return {
      artifactCount: artifacts.length,
      totalSizeBytes: totalSize,
      stageBreakdown: stageBreakdown as Record<PerArtifactStage | GlobalStage, number>,
    };
  }
}

// =============================================================================
// Cache Validity Checking
// =============================================================================

/**
 * Check if a cached stage output is valid given current inputs
 */
export function checkCacheValidity(
  cached: StageMeta,
  currentContentHash: string,
  currentConfigHash: string,
  currentUpstreamHash?: string
): {
  valid: boolean;
  reason?: 'content-mismatch' | 'config-mismatch' | 'upstream-mismatch';
} {
  if (cached.contentHash !== currentContentHash) {
    return { valid: false, reason: 'content-mismatch' };
  }
  
  if (cached.configHash !== currentConfigHash) {
    return { valid: false, reason: 'config-mismatch' };
  }
  
  // For IN stage, there's no upstream
  if (currentUpstreamHash !== undefined) {
    const cachedUpstreamHash = Object.values(cached.inputDeps)[0];
    if (cachedUpstreamHash !== currentUpstreamHash) {
      return { valid: false, reason: 'upstream-mismatch' };
    }
  }
  
  return { valid: true };
}

/**
 * Compute PX set hash for global stage invalidation
 */
export function computePxSetHash(
  pxOutputs: Array<{ artifactKey: string; outputHash: string }>
): string {
  // Sort by artifact key for stability
  const sorted = [...pxOutputs].sort((a, b) => a.artifactKey.localeCompare(b.artifactKey));
  const hashInput = JSON.stringify(sorted);
  return hashContent(hashInput);
}
