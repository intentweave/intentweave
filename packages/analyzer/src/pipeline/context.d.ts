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
  ExtractionConfig,
} from "@intentweave/core";
import type { WorkspaceRef } from "@intentweave/core";
import type { ArtifactStore } from "../stores/types.js";
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
  position?: "subject" | "object" | "any";
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
export declare class ConsoleLogger implements PipelineLogger {
  private prefix;
  constructor(prefix?: string);
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
/**
 * No-op logger for testing
 */
export declare class NoopLogger implements PipelineLogger {
  debug(): void;
  info(): void;
  warn(): void;
  error(): void;
}
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
export declare function createPipelineContext(
  options: PipelineContextOptions,
): PipelineContext;
/**
 * Run metadata structure (stored in run.meta.json)
 *
 * Uses ExtractionConfig from @intentweave/core for contract compatibility.
 */
export interface PipelineRunMeta {
  /** JSON Schema URI */
  $schema: string;
  /** Schema version */
  schemaVersion: "0.1";
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
  status: "running" | "completed" | "failed";
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
export declare function createRunMeta(ctx: PipelineContext): PipelineRunMeta;
/**
 * Update run metadata at completion
 */
export declare function completeRunMeta(
  meta: PipelineRunMeta,
  summary: PipelineRunMeta["summary"],
  completedAt: string,
): PipelineRunMeta;
/**
 * Mark run as failed
 */
export declare function failRunMeta(
  meta: PipelineRunMeta,
  error: string,
  failedAt: string,
): PipelineRunMeta;
/**
 * Default starter profile (minimal for Phase 2)
 */
export declare const DEFAULT_PROFILE: Profile;
//# sourceMappingURL=context.d.ts.map
