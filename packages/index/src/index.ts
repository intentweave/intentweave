// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/index — Code-Aware Retrieval Index (CARI)
 *
 * Lightweight SQLite-based index for agents, CI, and editors.
 * Zero-infrastructure alternative to the full Neo4j knowledge graph.
 */

// Phase 1: Core index
export { initSchema } from "./schema.js";
export { buildIndex } from "./writer.js";
export { annotate, toSlug, tokenize } from "./annotator.js";
export type { AnnotateOptions } from "./annotator.js";
export { computeIdf } from "./idf.js";

// Phase 4: Incremental updates
export { detectChanges, applyChanges, hashFile } from "./incremental.js";
export type {
  IncrementalUpdateOptions,
  IncrementalUpdateResult,
  FileChange,
} from "./incremental.js";

// Phase 2: Predefined queries
export {
  retrieve,
  retrieveFromDb,
  connections,
  connectionsFromDb,
  check,
  checkFromDb,
  formatCheck,
  report,
  reportFromDb,
  openIndex,
} from "./queries/index.js";

export type {
  // Core types
  Annotation,
  MatchType,
  IndexSymbol,
  IndexCoOccurrence,
  CoOccurrenceSource,
  IndexCoChange,
  IndexFile,
  IndexBuildOptions,
  IndexBuildResult,
  IdfScores,
  // Query types
  RetrieveParams,
  RetrieveResult,
  ConnectionsParams,
  ConnectionsResult,
  Connection,
  ConnectionGap,
  ConnectionSourceType,
  ConnectionSource,
  CheckParams,
  CheckResult,
  CheckFinding,
  ReportResult,
} from "./types.js";
