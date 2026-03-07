// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline Context
 * 
 * Provides a unified context object for all pipeline stages.
 * This avoids parameter explosion and ensures consistent access to:
 * - Workspace identity
 * - Artifact store
 * - Profile configuration
 * - Provider instances
 * - Logging and timing utilities
 */

import type { 
  LLMProvider, 
  ExtractionProvider,
  Chunk,
  ExtractionConfig,
} from '@intentweave/core';
import type { WorkspaceRef } from '@intentweave/core';
import type { ArtifactStore } from '../stores/types.js';

// =============================================================================
// Profile Types (minimal for Phase 2)
// =============================================================================

/**
 * Concept record for consolidated concepts
 */
export interface ConceptRecord {
  /** Concept ID */
  id: string;
  /** Concept name */
  name: string;
  /** Concept kind (state, event, action, guard, etc.) */
  kind: string;
  /** Description */
  description?: string;
  /** Aliases (alternative names) */
  aliases?: string[];
  /** Confidence score */
  confidence: number;
  /** Additional properties */
  properties?: Record<string, unknown>;
  /** Source provenance */
  provenance?: {
    filePath: string;
    startLine?: number;
    endLine?: number;
  };
  /** Sources this concept was extracted from */
  sources?: Array<{
    chunkId: string;
    confidence: number;
  }>;
}

/**
 * Shape definition for kind inference
 */
export interface ShapeRule {
  /** Predicate to check participation in */
  participatesIn: string[];
  /** Position in relationship (subject or object) */
  position?: 'subject' | 'object' | 'any';
  /** Resulting kind if rule matches */
  inferredKind: string;
}

/**
 * Artifact role mapping for LX
 */
export interface ArtifactMapping {
  /** Artifact role name */
  role: string;
  /** Entity kinds typically found in this role */
  kinds: string[];
  /** File patterns that match this role */
  patterns?: string[];
}

/**
 * Minimal Profile interface for Phase 2
 * Full profile loader in Phase 3
 */
export interface Profile {
  /** Profile name */
  name: string;
  /** Profile version */
  version: string;
  /** Entity kinds recognized by this profile */
  kinds: string[];
  /** Allowed predicates */
  predicates: string[];
  /** Shape rules for kind inference */
  shapes: ShapeRule[];
  /** Artifact role mappings */
  artifactMappings: ArtifactMapping[];
  /** Confidence threshold for filtering */
  confidenceThreshold?: number;
  /** PX stage filtering config */
  px?: {
    /** Kinds to include (if set, only these are included) */
    includeKinds?: string[];
    /** Kinds to exclude */
    excludeKinds?: string[];
    /** Artifact roles to include */
    includeRoles?: string[];
    /** Artifact roles to exclude */
    excludeRoles?: string[];
  };
}

// =============================================================================
// Logger Interface
// =============================================================================

/**
 * Logger interface for pipeline operations
 */
export interface PipelineLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Console-based logger implementation
 */
export class ConsoleLogger implements PipelineLogger {
  constructor(private prefix: string = '[Pipeline]') {}
  
  debug(message: string, meta?: Record<string, unknown>): void {
    console.debug(`${this.prefix} ${message}`, meta ?? '');
  }
  
  info(message: string, meta?: Record<string, unknown>): void {
    console.info(`${this.prefix} ${message}`, meta ?? '');
  }
  
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`${this.prefix} ${message}`, meta ?? '');
  }
  
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`${this.prefix} ${message}`, meta ?? '');
  }
}

/**
 * No-op logger for testing
 */
export class NoopLogger implements PipelineLogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

// =============================================================================
// Pipeline Context
// =============================================================================

/**
 * Provider configuration for pipeline
 */
export interface PipelineProviders {
  /** LLM provider for extraction */
  llm: LLMProvider;
  /** Extraction provider (uses LLM provider) */
  extraction: ExtractionProvider;
}

/**
 * Pipeline Context Options
 */
export interface PipelineContextOptions {
  /** Workspace reference */
  workspace: WorkspaceRef;
  /** Run ID */
  runId: string;
  /** Artifact store for reading/writing stage outputs */
  store: ArtifactStore;
  /** Active profile */
  profile: Profile;
  /** Provider instances */
  providers: PipelineProviders;
  /** Logger instance */
  logger?: PipelineLogger;
  /** Clock function for timestamps */
  clock?: () => Date;
}

/**
 * Pipeline Context
 * 
 * Immutable context object passed to all pipeline stages.
 * Contains everything needed to process artifacts.
 */
export interface PipelineContext {
  /** Workspace reference */
  readonly workspace: WorkspaceRef;
  /** Run ID */
  readonly runId: string;
  /** Artifact store */
  readonly store: ArtifactStore;
  /** Active profile */
  readonly profile: Profile;
  /** Provider instances */
  readonly providers: Readonly<PipelineProviders>;
  /** Logger instance */
  readonly logger: PipelineLogger;
  /** Get current timestamp */
  now(): Date;
  /** Get ISO timestamp string */
  timestamp(): string;
}

/**
 * Create a pipeline context from options
 */
export function createPipelineContext(options: PipelineContextOptions): PipelineContext {
  const {
    workspace,
    runId,
    store,
    profile,
    providers,
    logger = new ConsoleLogger(),
    clock = () => new Date(),
  } = options;
  
  return {
    workspace,
    runId,
    store,
    profile,
    providers,
    logger,
    now: clock,
    timestamp: () => clock().toISOString(),
  };
}

// =============================================================================
// Run Metadata Management
// =============================================================================

/**
 * Run metadata structure (stored in run.meta.json)
 * 
 * Uses ExtractionConfig from @intentweave/core for contract compatibility.
 */
export interface PipelineRunMeta {
  /** JSON Schema URI */
  $schema: string;
  /** Schema version */
  schemaVersion: '0.1';
  /** Processing timestamp */
  processedAt?: string;
  /** Run ID */
  runId: string;
  /** Workspace key */
  workspaceKey: string;
  /** Workspace ID (stable) */
  workspaceId: string;
  /** Run start timestamp */
  startedAt: string;
  /** Run completion timestamp */
  completedAt?: string;
  /** Run duration in ms */
  durationMs?: number;
  /** Run status */
  status: 'running' | 'completed' | 'failed';
  /** Profile used */
  profile: string;
  /** Stages completed */
  stages: string[];
  /** Artifacts processed */
  artifacts: string[];
  /** Summary statistics */
  summary?: {
    entityCount: number;
    statementCount: number;
    artifactCount: number;
  };
  /** Error message if failed */
  error?: string;
  /** Extraction configuration for parity evaluation (uses core type) */
  extractionConfig?: ExtractionConfig;
}

/**
 * Create initial run metadata (at run start)
 */
export function createRunMeta(ctx: PipelineContext): PipelineRunMeta {
  return {
    $schema: 'intentweave://schemas/run-meta/v1',
    schemaVersion: '0.1',
    runId: ctx.runId,
    workspaceKey: ctx.workspace.key,
    workspaceId: ctx.workspace.id,
    startedAt: ctx.timestamp(),
    status: 'running',
    profile: ctx.profile.name,
    stages: [],
    artifacts: [],
  };
}

/**
 * Update run metadata at completion
 */
export function completeRunMeta(
  meta: PipelineRunMeta, 
  summary: PipelineRunMeta['summary'],
  completedAt: string
): PipelineRunMeta {
  const startTime = new Date(meta.startedAt).getTime();
  const endTime = new Date(completedAt).getTime();
  
  return {
    ...meta,
    completedAt,
    durationMs: endTime - startTime,
    status: 'completed',
    summary,
  };
}

/**
 * Mark run as failed
 */
export function failRunMeta(
  meta: PipelineRunMeta, 
  error: string,
  failedAt: string
): PipelineRunMeta {
  const startTime = new Date(meta.startedAt).getTime();
  const endTime = new Date(failedAt).getTime();
  
  return {
    ...meta,
    completedAt: failedAt,
    durationMs: endTime - startTime,
    status: 'failed',
    error,
  };
}

// =============================================================================
// Default Profile
// =============================================================================

/**
 * Default starter profile (minimal for Phase 2)
 */
export const DEFAULT_PROFILE: Profile = {
  name: 'starter',
  version: '0.1.0',
  kinds: [
    'role',
    'action', 
    'resource',
    'state',
    'transition',
    'requirement',
    'component',
  ],
  predicates: [
    'ROLE_CAN',
    'HAS_STATE',
    'TRANSITIONS_TO',
    'REQUIRES',
    'CONTAINS',
    'IMPLEMENTS',
    'TRIGGERS',
    'GUARDS',
    'FROM_STATE',
    'TO_STATE',
  ],
  shapes: [
    {
      participatesIn: ['ROLE_CAN', 'REQUIRES_ROLE'],
      position: 'subject',
      inferredKind: 'role',
    },
    {
      participatesIn: ['HAS_STATE'],
      position: 'object',
      inferredKind: 'state',
    },
    {
      participatesIn: ['TRANSITIONS_TO'],
      position: 'any',
      inferredKind: 'state',
    },
    {
      participatesIn: ['TRIGGERS'],
      position: 'subject',
      inferredKind: 'action',
    },
  ],
  artifactMappings: [
    {
      role: 'prompt',
      kinds: ['requirement', 'concept', 'question'],
      patterns: ['**/prompt*.md', '**/intent*.md'],
    },
    {
      role: 'spec',
      kinds: ['requirement', 'component', 'role', 'action'],
      patterns: ['**/spec*.md', '**/design*.md'],
    },
    {
      role: 'impl',
      kinds: ['function', 'class', 'module', 'interface'],
      patterns: ['**/*.ts', '**/*.js', '**/*.py'],
    },
  ],
  confidenceThreshold: 0.5,
};
