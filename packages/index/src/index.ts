// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/index — Code-Aware Retrieval Index (CARI)
 *
 * Lightweight SQLite-based index for agents, CI, and editors.
 * Zero-infrastructure alternative to the full Neo4j knowledge graph.
 */

// Phase 1: Core index
export { initSchema, migrateSchema14To15 } from "./schema.js";
export {
  assessmentKey,
  canonicalJson,
  fingerprint,
  materialFingerprint,
  ruleResultFingerprint,
} from "./claims/canonical.js";
export { ClaimsStore } from "./claims/store.js";
export type {
  AssessmentEffect,
  ClaimAssessmentDependencyInput,
  ClaimAssessmentStatus,
  ClaimDependencyKind,
  ClaimScalar,
  EpistemicRole,
  MaterialFingerprintInput,
  PersistEvidenceInput,
  PersistedVersion,
  PersistRuleResultInput,
  RuleApplicability,
  RuleResultFingerprintInput,
  RuleResultStatus,
  WarrantPolarity,
} from "./claims/types.js";

// CypherLite CARI graph projection + query runner
export {
  runCypherQuery,
  runCypherQueryFromDb,
  injectCariGraphCtes,
  looksLikeSql,
  CARI_GRAPH_SCHEMA,
  CARI_QUERY_TEMPLATES,
} from "./queries/cypherGraph.js";
export type {
  CypherQueryResult,
  QueryTemplate,
} from "./queries/cypherGraph.js";
export {
  buildIndex,
  registerExternalEntities,
  snapshotConformance,
} from "./writer.js";
export { annotate, toSlug, tokenize } from "./annotator.js";
export type { AnnotateOptions } from "./annotator.js";
export { computeIdf } from "./idf.js";

// Opt-in local session log (.iw/sessions/) — never transmitted anywhere
export { logSessionEvent } from "./sessionLog.js";
export type { SessionLogEntry, LogSessionEventInput } from "./sessionLog.js";

// KG writer (Selective Semantic Enrichment — 11.8)
export { writeKgResults, bridgeKgEntities } from "./kgWriter.js";
export type { KgWriteInput, KgWriteResult } from "./kgWriter.js";

// Phase 4: Incremental updates
export { detectChanges, applyChanges, hashFile } from "./incremental.js";
export type {
  IncrementalUpdateOptions,
  IncrementalUpdateResult,
  FileChange,
} from "./incremental.js";

// Facade: CariIndex class + buildFromPaths orchestration
export { CariIndex, buildFromPaths } from "./facade.js";
export type { CariConfig, CariStageProgress, WorkspaceRoot } from "./facade.js";

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
  type ClonesOptions,
  type StructuralClonesOptions,
  type CloneLayerAnalysis,
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
  namingViolations,
  namingViolationsFromDb,
  commentCodeRatio,
  commentCodeRatioFromDb,
  skippedFiles,
  skippedFilesFromDb,
  rulesCheck,
  rulesCheckFromDb,
  deprecatedCallers,
  deprecatedCallersFromDb,
  internalViolations,
  internalViolationsFromDb,
  typeAssertions,
  typeAssertionsFromDb,
  layersFromDecorators,
  layersFromDecoratorsFromDb,
  rulesTrend,
  rulesTrendFromDb,
  testIntent,
  testIntentFromDb,
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
  hubs,
  hubsFromDb,
  communities,
  communitiesFromDb,
  communityLabelsFromDb,
  surprises,
  surprisesFromDb,
  rationale,
  rationaleFromDb,
  terminologyInconsistency,
  terminologyInconsistencyFromDb,
  dependencyDepth,
  dependencyDepthFromDb,
  boundaryViolations,
  boundaryViolationsFromDb,
  layersInfer,
  layersInferFromDb,
  layersCheck,
  layersCheckFromDb,
  layersCompare,
  layersCompareFromDb,
  interfaceConformance,
  interfaceConformanceFromDb,
  deadFeatures,
  deadFeaturesFromDb,
  nameLayers,
  slices,
  slicesFromDb,
  focus,
  focusFromDb,
  impact,
  impactFromDb,
  formatCariImpact,
  archReport,
  archReportFromDb,
  enrichmentScore,
  enrichmentScoreFromDb,
  verify,
  verifyFromDb,
  consistency,
  consistencyFromDb,
  archCheck,
  archCheckFromDb,
  parseArchitectureYaml,
  inferArchConfigFromKg,
  inferArchConfigFromKgDb,
  enrichArchConfigWithFiles,
  diagramEntityCheck,
  diagramEntityCheckFromDb,
  resolveComponent,
  resolveComponentFromDb,
  livingScore,
  livingScoreFromDb,
  documentaryCheckFromDb,
  openIndex,
  calls,
  callsFromDb,
  trace,
  traceFromDb,
  ruleCoverage,
  ruleCoverageFromDb,
  contextPack,
  contextPackFromDb,
} from "./queries/index.js";
export type {
  DiagramEntityCheckResult,
  EntityGrounding,
} from "./queries/diagramEntityCheck.js";
export type { DocumentaryCheckOptions } from "./queries/documentaryCheck.js";
export type {
  ResolvedComponent,
  ResolvedSymbol,
  ResolveComponentParams,
  ResolveComponentResult,
} from "./types.js";

export {
  renderArchReportHtml,
  renderPrescriptiveReportHtml,
  renderInsightsBookHtml,
  renderFocusReportHtml,
  renderFocusDot,
  analyzeFocusInsights,
} from "./export/index.js";

export type {
  InsightsBookData,
  InsightsCodeHealth,
  InsightsHotspots,
  InsightsDocumentation,
  InsightsLivingScore,
  InsightsDocMap,
} from "./export/index.js";

export type {
  ReportOptions,
  ArchReportOptions,
  DeadFeatureOptions,
  EnrichmentScoreOptions,
  RulesCheckOptions,
  DeprecatedCallersOptions,
  InternalViolationsOptions,
  TypeAssertionsOptions,
  LayersFromDecoratorsOptions,
  RulesTrendOptions,
  TestIntentOptions,
  CallEdge as CallEdgeQuery,
  RuleCoverageOptions as RuleCoverageQueryOptions,
  PackageCoverage as PackageCoverageQuery,
} from "./queries/index.js";

export type { NamingViolationsOptions } from "./queries/namingViolations.js";

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
  HubAnalysisResult,
  CommunityDetectionResult,
  Community,
  CommunityMember,
  CommunityOptions,
  CommunityMode,
  SurprisingConnectionsResult,
  SurprisingConnection,
  RationaleResult,
  TerminologyInconsistencyResult,
  TerminologyInconsistency,
  TerminologyVariant,
  DependencyDepthResult,
  DependencyDepthEntry,
  BoundaryViolationsResult,
  BoundaryViolation,
  LayersInferResult,
  InferredLayer,
  InferredSubLayer,
  LayersInferOptions,
  LayerConfig,
  LayersCheckResult,
  LayerViolation,
  LayersCompareResult,
  LayersCompareEntry,
  ConformanceViolation,
  InterfaceConformanceResult,
  DeadFeatureCandidate,
  DeadFeatureResult,
  ApiChange,
  ApiPackageSummary,
  ApiSurfaceResult,
  NamedLayer,
  NamedDirectory,
  LayerNamingResult,
  ArchReportData,
  ArchReportNode,
  ArchReportEdge,
  VerticalSlice,
  SlicesOptions,
  SlicesResult,
  FocusParams,
  FocusResult,
  FocusNode,
  FocusEdge,
  CariImpactParams,
  CariImpactResult,
  CariImpactFile,
  CariImpactDoc,
  // Enrichment types (11.8)
  EnrichmentWeights,
  EnrichmentCandidate,
  EnrichmentScoreResult,
  EnrichOptions,
  EnrichResult,
  // Verification types (12.1)
  GroundingStatus,
  VerifyEntityResult,
  VerifyParams,
  VerifyResult,
  // Consistency types (12.2)
  ConflictSeverity,
  ConstraintConflict,
  ConsistencyParams,
  ConsistencyResult,
  // Architecture check types (5.8)
  ArchComponent,
  ArchFlow,
  ArchConstraint,
  ArchConfig,
  FlowStatus,
  ArchFlowResult,
  UndocumentedFlow,
  ArchConstraintViolation,
  ArchCheckResult,
  // Living documentation score types (12.3)
  LivingScoreParams,
  LivingScoreDimension,
  LivingScoreResult,
  // Code quality types (6.x)
  NamingViolation,
  NamingViolationsResult,
  CommentCodeRatioEntry,
  CommentCodeRatioResult,
  SkippedFileEntry,
  SkippedFilesResult,
  // Semantic rule types (13.x + 17.2)
  RuleForbidden,
  RuleDefinition,
  RulesAllowedEntry,
  RulesConfig,
  IwConfig,
  RulesViolation,
  RulesCheckResult,
  // Signal layer types (14.x)
  DeprecatedCallerEntry,
  DeprecatedCallersResult,
  InternalViolation,
  InternalViolationsResult,
  TypeAssertionEntry,
  TypeAssertionsResult,
  DecoratorLayerAssignment,
  LayersFromDecoratorsResult,
  ConformanceSnapshot,
  RuleTrend,
  RulesTrendResult,
  TestDescriptionMatch,
  TestIntentResult,
  CallEdge,
  CallsOptions,
  CallsResult,
  TraceOptions,
  TraceResult,
  TraceNode,
  TraceEdge,
  RuleCoverageOptions,
  RuleCoverageResult,
  PackageCoverage,
  // Context pack types (cari_context_pack)
  ContextPackSection,
  ContextPackInput,
  ContextPackOutput,
  ContextPackFileEntry,
  ContextPackRuleEntry,
  ContextPackConnectionEntry,
  ContextPackRationaleEntry,
  ContextPackDriftEntry,
  // Semantic Capsule Layer (14.0)
  SemanticCapsule,
  CapsuleKind,
  CapsuleStatus,
} from "./types.js";

// Semantic Capsule Writer (14.0)
export {
  collectSymbolEvidence,
  generateSymbolSummary,
  generateCallSemantics,
  generatePathSummary,
  markStaleForChangedSymbols,
  listCapsules,
  getCapsule,
} from "./queries/capsuleWriter.js";
export type {
  SymbolEvidence,
  CapsuleWriteOptions,
  CapsuleLLM,
  CapsuleWriteResult,
} from "./queries/capsuleWriter.js";
