// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Core Types for IntentWeave
 *
 * These types are the foundation of the knowledge graph model.
 * This is the SINGLE SOURCE OF TRUTH for entity types.
 *
 * @version 2.0.0 - Unified schema (no serverInteractive/coreRich split)
 */

// Stage output types
export * from "./stages.js";

// Extraction hooks types
export * from "./hooks.js";

// Profile runtime types (boundary contract for core stages)
export * from "./profile.js";

// ============================================================================
// Entity Type Definitions - SINGLE SOURCE OF TRUTH
// ============================================================================

/**
 * All supported entity types for IntentWeave extraction.
 *
 * This is the canonical list - extractionSchema and shapes import from here.
 *
 * Categories:
 * - Domain/Behavioral: resource, state, action, role, transition, event, condition, rule
 * - Technical/Architectural: service, frontend, endpoint, page, queue, database, component, module
 * - Code-level: interface, function, class
 * - Legacy: concept, question
 */
export const ENTITY_TYPES = [
  // Domain/Behavioral entities
  "resource", // Domain resource (User, Order, Document, etc.)
  "state", // State of a resource
  "action", // Action that can be performed
  "role", // Actor/role that performs actions
  "transition", // State transition (from → to)
  "event", // Domain event
  "condition", // Guard condition
  "rule", // Business rule

  // Technical/Architectural entities
  "service", // Service/microservice
  "frontend", // Frontend application
  "endpoint", // API endpoint
  "page", // UI page/view
  "queue", // Message queue
  "database", // Data store
  "component", // UI/domain component
  "module", // Code module

  // Code-level entities (for codebase analysis)
  "interface", // Interface/contract
  "function", // Function/method (standalone)
  "class", // Class definition
  "type", // Type alias
  "enum", // Enumeration
  "method", // Class/interface method
  "property", // Class/interface property

  // Legacy entities (backward compatibility)
  "concept", // Generic concept (legacy)
  "question", // User question (legacy)
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * @deprecated Use ENTITY_TYPES directly. Kept for backward compatibility.
 */
export const CORE_ENTITY_TYPES = ENTITY_TYPES;
export const LEGACY_ENTITY_TYPES = ["concept"] as const;
export type CoreEntityType = EntityType;
export type LegacyEntityType = (typeof LEGACY_ENTITY_TYPES)[number];
export type SupportedEntityType = EntityType;

/**
 * Helper to check if a string is a valid entity type
 */
export function isValidEntityType(type: string): type is EntityType {
  return ENTITY_TYPES.includes(type as EntityType);
}

// ============================================================================
// Origin & State Types
// ============================================================================

export type Origin = "llm" | "heuristic" | "human" | "scaffold";

export type ReviewStatus =
  | "needs_review"
  | "accepted"
  | "rejected"
  | "blocked"
  | "superseded";

export type ConflictPolicy =
  | "shadow"
  | "reject"
  | "soft-merge"
  | "needs_review_if_state_differs";

export type AnnotationSeverity = "info" | "warn" | "error";

// ============================================================================
// Annotation Types
// ============================================================================

export interface EntityAnnotation {
  rule: string;
  severity: AnnotationSeverity;
  message: string;
  tags: string[];
  phase?: "preMx" | "postMx";
  autoFixAvailable?: boolean;
  suggestion?: string;
}

// ============================================================================
// Evidence Types
// ============================================================================

export interface Evidence {
  turnIndex: number;
  text: string;
  start?: number;
  end?: number;

  // Provenance tracking fields
  turn_id?: string;
  doc_id?: string;
  chunk_id?: string;
  confidence?: number;
  source_stage?: "RX" | "CX" | "PX" | "MX";
  chunk_index?: number;

  // Allow additional properties for Zod passthrough compatibility
  [key: string]: unknown;
}

// ============================================================================
// Merge Conflict Types
// ============================================================================

export interface MergeConflictItem {
  cgId?: string;
  subjectCgId?: string;
  predicate?: string;
  objectCgId?: string | null;
  confidence?: number;
  state?: Entity["state"] | Statement["state"];
  origin?: Origin;
  source?: Entity["source"];
  rationale?: string | null;
}

export interface MergeConflictRecord {
  policy: ConflictPolicy;
  reason: string;
  items: MergeConflictItem[];
}

// ============================================================================
// Entity Types
// ============================================================================

export interface Entity {
  cgId: string;
  type: EntityType;
  name: string;
  canonical_key?: string;
  labels: ("Staging" | "Curated")[];
  evidence: Evidence[];
  confidence: number;
  source: "llm" | "heuristic" | "human";
  origin?: Origin;
  state: "new" | "merged" | "needs_review" | "rejected";
  props?: Record<string, unknown>;
  guardrail_passed?: boolean;
  reviewStatus?: ReviewStatus;
  confidenceLlm?: number;
  confidenceGuard?: number;
  sourcePriority?: number;
  contentHash?: string;
  retiredAt?: string | null;
  mergeConflicts?: MergeConflictRecord[];
  profiles?: string[];
  modes?: string[];
  stageStatus?: "kept" | "dropped" | "neutralized";
  annotations?: EntityAnnotation[];
  is_entry?: boolean;
  is_exit?: boolean;
  aliases?: string[];
}

// ============================================================================
// Statement Types
// ============================================================================

export interface Statement {
  id?: string;
  subjectCgId: string;
  predicate: string;
  objectCgId: string | null;
  objectValue?: string | null;
  qualifiers?: Record<string, string | number | boolean>;
  confidence: number;
  evidence: Evidence[];
  labels: ("Staging" | "Curated")[];
  state: "new" | "merged" | "needs_review" | "rejected";
  origin?: Origin;
  guardrail_passed?: boolean;
  reviewStatus?: ReviewStatus;
  confidenceLlm?: number;
  confidenceGuard?: number;
  sourcePriority?: number;
  contentHash?: string;
  retiredAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  mergeConflicts?: MergeConflictRecord[];
  profiles?: string[];
  modes?: string[];
  stageStatus?: "kept" | "dropped" | "neutralized";
  chunk_id?: string;
  chunk_hash?: string;
  chunk_index?: number;
  metadata?: Record<string, unknown>;
  annotations?: EntityAnnotation[];
  deprecated?: boolean;
  replaced_by?: string;
  phase?: "preMx" | "postMx";
  lineage_parent_id?: string;
}

// ============================================================================
// Snapshot Types
// ============================================================================

export interface StagingSnapshot {
  entities: Entity[];
  statements: Statement[];
}

export interface StatementCore {
  subjectCgId: string;
  predicate: string;
  objectCgId?: string | null;
  objectValue?: string | null;
  qualifiers?: Record<string, string | number | boolean>;
}

// ============================================================================
// Review Types
// ============================================================================

export interface ReviewDecision {
  id: string;
  statementId: string;
  status: Exclude<ReviewStatus, "needs_review">;
  rationale?: string;
  reviewed_by: string;
  reviewed_at: string;
  content_hash_at_review: string;
  evidence_refs?: string[];
}

// ============================================================================
// Artifact Types
// ============================================================================

export type ArtifactFormat =
  | "markdown"
  | "typescript"
  | "javascript"
  | "json"
  | "yaml"
  | "python"
  | "sql"
  | "cypher"
  | "mermaid"
  | "unknown";

export type ArtifactRole =
  | "intent"
  | "spec"
  | "code"
  | "test"
  | "doc"
  | "config";

export interface ArtifactMeta {
  path: string;
  format: ArtifactFormat;
  role: ArtifactRole;
  hash?: string;
  lastModified?: string;
}

// ============================================================================
// Run Types
// ============================================================================

/**
 * Extraction configuration - tracks requested vs effective settings
 * for parity evaluation and drift detection
 */
export interface ExtractionConfig {
  /** Requested settings (what was asked for) */
  requested: {
    /** LLM model name (snapshot preferred, e.g., gpt-4o-mini-2024-07-18) */
    model: string;
    /** Temperature setting */
    temperature: number;
    /** Max output tokens per request */
    maxOutputTokens: number;
    /** Extraction mode (single-pass, two-pass, multi-pass) */
    extractionMode: string;
    /** Provider name (openai, mock, smart-mock) */
    provider: string;
  };
  /** Effective settings (what the provider actually used) */
  effective?: {
    /** Model actually used by provider */
    model: string;
    /** Temperature actually used */
    temperature: number;
    /** Max tokens actually used (may be clamped by provider) */
    maxOutputTokens: number;
  };
  /** Hash of prompt templates used (for reproducibility) */
  promptVersionHash?: string;
}

/**
 * Run metadata - stored in run.meta.json
 *
 * This is the canonical contract type for .iw bundle interoperability.
 * Both CLI and server must produce identical structures for parity.
 */
export interface RunMeta {
  /** JSON Schema URI */
  $schema?: string;

  /** Schema version for forward compatibility */
  schemaVersion?: "0.1";

  /** Processing timestamp */
  processedAt?: string;

  /** Unique run identifier */
  runId: string;

  /** Stable workspace ID (used in cgIds) */
  workspaceId: string;

  /** Human-readable workspace key */
  workspaceKey?: string;

  /** Run start timestamp */
  startedAt: string;

  /** Run completion timestamp */
  completedAt?: string;

  /** Run duration in milliseconds */
  durationMs?: number;

  /** Current run status */
  status: "running" | "completed" | "failed";

  /** Profile used for this run */
  profile?: string;

  /** Stages completed in this run */
  stages?: string[];

  /** Artifacts processed in this run */
  artifacts?: string[];

  /** Summary statistics */
  summary?: {
    /** Total entity count */
    entityCount: number;
    /** Total statement count */
    statementCount: number;
    /** Artifact count */
    artifactCount: number;
  };

  /** Extraction configuration (for parity evaluation) */
  extractionConfig?: ExtractionConfig;

  /** Error message if failed */
  error?: string;
}
