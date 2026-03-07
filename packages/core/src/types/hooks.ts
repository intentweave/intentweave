// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Extraction Hooks Types
 * 
 * The hooks system provides optional enrichment for the extraction pipeline.
 * CLI uses empty hooks ({}), server injects context, events, budget, etc.
 * 
 * DISCIPLINE RULE: Hooks are ADVISORY.
 * Stages must be deterministic given (input + hooks).
 * Hooks provide optional enrichment, not hidden control flow.
 */

import type { Entity, Statement, StagingSnapshot, Evidence } from './index.js';
import type { 
  EntitySchema, 
  ExtractionProfile, 
  Chunk,
  ExtractionResult,
} from '../interfaces.js';

// Re-export these types for consumers who import from hooks.ts
export type { Chunk, EntitySchema, ExtractionProfile, ExtractionResult };

// ============================================================================
// Context Provider Types
// ============================================================================

/**
 * Conversation history item for chat context
 */
export interface ConversationHistoryItem {
  role: 'user' | 'assistant';
  text: string;
  turnId?: string;
  timestamp?: string;
}

/**
 * Recall snippet from prior extractions
 */
export interface RecallSnippet {
  /** Quote from previous turn */
  quote: string;
  /** Entity/statement it relates to */
  relatedCgId?: string;
  /** Source turn */
  sourceTurnId?: string;
}

/**
 * Context bundle returned by ContextProvider
 * Contains everything RX might need for context-aware extraction
 */
export interface ContextBundle {
  /** Previous conversation messages (for chat context) */
  previousMessages?: ConversationHistoryItem[];
  
  /** Recall snippets from prior extractions */
  recallSnippets?: RecallSnippet[];
  
  /** Curated graph snapshot for consolidation */
  priorSnapshot?: StagingSnapshot;
  
  /** Heuristics-derived entities (pre-LLM) */
  heuristicsEntities?: Entity[];
  
  /** Profile constraints/shapes */
  constraints?: {
    requiredPredicates?: string[];
    requiredEntityKinds?: string[];
    expectedShapes?: Array<[string, string, string]>;
  };
}

/**
 * Context provider interface
 * 
 * Returns a ContextBundle with all available context for an artifact.
 * Server implements with session/Neo4j access; CLI returns empty bundle.
 */
export interface ContextProvider {
  /** Get context bundle for an artifact */
  getContext(artifactId: string, meta?: Record<string, unknown>): Promise<ContextBundle>;
}

// ============================================================================
// Event Sink Types
// ============================================================================

/**
 * Event sink interface (generic, no server-specific event names)
 * 
 * Fire-and-forget event publishing. Server implements with EventBus;
 * CLI can omit or use a no-op sink.
 */
export interface EventSink {
  /** Emit a pipeline event */
  emit(event: string, payload: Record<string, unknown>): void;
}

// ============================================================================
// Budget Policy Types
// ============================================================================

/**
 * Budget/retry policy interface
 * 
 * Advises RX stage on retry behavior for truncation/timeout errors.
 * RX decides whether to use it.
 */
export interface BudgetPolicy {
  /** Initial max output tokens */
  maxOutputTokens: number;
  
  /** Get expanded budget after truncation */
  getRetryBudget(attempt: number, prevBudget: number): number;
  
  /** Whether to retry on this error */
  shouldRetry(error: Error, attempt: number): boolean;
  
  /** Max retry attempts */
  maxRetries: number;
}

/**
 * Default budget policy (no retries)
 */
export const DEFAULT_BUDGET: BudgetPolicy = {
  maxOutputTokens: 4000,
  getRetryBudget: () => 0,
  shouldRetry: () => false,
  maxRetries: 0,
};

// ============================================================================
// Trace Sink Types
// ============================================================================

/**
 * Trace event for debugging
 */
export interface TraceEvent {
  stage: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Trace sink for debugging (writes JSONL)
 */
export interface TraceSink {
  /** Write a trace event */
  write(event: TraceEvent): void;
  
  /** Flush and close */
  close(): Promise<void>;
}

// ============================================================================
// Extraction Strategy Types
// ============================================================================

/**
 * Strategy options passed to extract()
 */
export interface StrategyOptions {
  /** Maximum output tokens for LLM */
  maxOutputTokens?: number;
  
  /** Temperature for LLM */
  temperature?: number;
}

/**
 * Extraction strategy interface
 * 
 * Encapsulates different extraction approaches:
 * - SinglePassStrategy: One LLM call (default for CLI)
 * - TwoPassStrategy: Entities then statements
 * - MultiTempStrategy: Multiple temperatures
 * 
 * Strategy only handles LLM calls—NOT chunking or coverage evaluation.
 */
export interface ExtractionStrategy {
  /** Strategy name */
  readonly name: string;
  
  /**
   * Extract from chunks (already chunked by IN stage)
   * @param chunks - Pre-chunked content from IN stage
   * @param schema - Entity schema
   * @param profile - Extraction profile
   * @param context - Context bundle (may be empty)
   * @param options - Strategy options (maxOutputTokens, etc.)
   */
  extract(
    chunks: Chunk[],
    schema: EntitySchema,
    profile: ExtractionProfile,
    context: ContextBundle,
    options?: StrategyOptions
  ): Promise<ExtractionResult>;
}

// ============================================================================
// The Single Hooks Object
// ============================================================================

/**
 * THE SINGLE HOOKS OBJECT
 * 
 * CLI: Pass {} (empty)
 * Server: Pass { context, events, budget, trace }
 * 
 * DISCIPLINE RULE: Hooks are ADVISORY.
 * Stages must be deterministic given (input + hooks).
 * Hooks provide optional enrichment, not hidden control flow.
 * 
 * - context: Enriches prompts with prior knowledge (advisory)
 * - events: Notifies external systems (fire-and-forget)
 * - budget: Advises retry/expansion policy (RX decides)
 * - trace: Records debug info (no behavior change)
 * - strategy: Selects LLM calling pattern (explicit)
 */
export interface ExtractionHooks {
  /** Context provider for session-aware extraction */
  context?: ContextProvider;
  
  /** Event sink for real-time updates */
  events?: EventSink;
  
  /** Budget/retry policy (used by RX for truncation retries) */
  budget?: BudgetPolicy;
  
  /** Trace sink for debugging */
  trace?: TraceSink;
  
  /** Extraction strategy (defaults to TwoPassStrategy) */
  strategy?: ExtractionStrategy;
}

/**
 * Default hooks (empty, for CLI)
 */
export const DEFAULT_HOOKS: ExtractionHooks = {};
