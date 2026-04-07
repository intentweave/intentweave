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
export { buildIndex, registerExternalEntities } from "./writer.js";
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

// Facade: CariIndex class + buildFromPaths orchestration
export { CariIndex, buildFromPaths } from "./facade.js";
export type { CariConfig, CariStageProgress } from "./facade.js";

// Facade: file discovery utilities (also used by CLI)
export {
  DEFAULT_EXCLUDES,
  loadIwIgnore,
  buildExcludeList,
  discoverFiles,
  isExcluded,
} from "./facade.js";

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
  clones,
  clonesFromDb,
  structuralClones,
  structuralClonesFromDb,
  circularImports,
  circularImportsFromDb,
  unusedExports,
  unusedExportsFromDb,
  hotspotPriority,
  hotspotPriorityFromDb,
  todos,
  todosFromDb,
  moduleCoverage,
  moduleCoverageFromDb,
  orphanedSections,
  orphanedSectionsFromDb,
  docCompleteness,
  docCompletenessFromDb,
  crossGroupDrift,
  crossGroupDriftFromDb,
  testCoverage,
  testCoverageFromDb,
  mentionsOf,
  mentionsOfFromDb,
  annotationsForFile,
  annotationsForFileFromDb,
  openIndex,
} from "./queries/index.js";

export type { ReportOptions } from "./queries/index.js";

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
  ClonesResult,
  CircularImportsResult,
  UnusedExportsResult,
  HotspotPriorityResult,
  TodosResult,
  ModuleCoverageResult,
  OrphanedSectionsResult,
  DocCompletenessResult,
  StructuralClonesResult,
  CrossGroupDriftResult,
  TestCoverageParams,
  TestCoverageResult,
  TestMapping,
  ExternalEntity,
  MentionsOfParams,
  MentionsOfResult,
  AnnotationsForFileParams,
  AnnotationsForFileResult,
} from "./types.js";
