// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Incremental Pipeline Cache
 * 
 * Content-addressed cache with dependency graph and invalidation cascade.
 * Provides Bazel-like incremental behavior without external build tools.
 * 
 * @packageDocumentation
 */

// Types
export * from './types.js';

// Artifact Registry
export {
  ArtifactRegistry,
  canonicalizeContent,
  hashContent,
  computeContentHash,
  discoverFileArtifacts,
  discoverChatArtifacts,
  discoverTranscriptArtifacts,
} from './registry.js';

// Cache
export {
  IncrementalCache,
  computeStageConfigHash,
  computeGlobalConfigHash,
  checkCacheValidity,
  computePxSetHash,
  type CachedStageOutput,
  type CachedGlobalOutput,
  type CacheLookupResult,
} from './cache.js';

// Planner
export {
  generateRunPlan,
  formatRunPlan,
  formatRunPlanJson,
  type PlanOptions,
} from './planner.js';

// Executor
export {
  IncrementalExecutor,
  createDefaultPipelineConfig,
  type IncrementalExecutorOptions,
  type IncrementalResult,
  type RunManifest,
} from './executor.js';

// Open Track Cache
export {
  OpenTrackCache,
  type OpenTrackStageId,
  type OpenTrackArtifactMeta,
  type OpenTrackCacheCheck,
} from './openTrackCache.js';
