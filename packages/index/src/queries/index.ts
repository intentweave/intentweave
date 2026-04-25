// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

export { retrieve, retrieveFromDb } from "./retrieve.js";
export { connections, connectionsFromDb } from "./connections.js";
export { check, checkFromDb, formatCheck } from "./check.js";
export { report, reportFromDb } from "./report.js";
export type { ReportOptions } from "./report.js";
export { clones, clonesFromDb } from "./clones.js";
export { structuralClones, structuralClonesFromDb } from "./clones.js";
export {
  circularImports,
  circularImportsFromDb,
  unusedExports,
  unusedExportsFromDb,
} from "./imports.js";
export { hotspotPriority, hotspotPriorityFromDb } from "./hotspotPriority.js";
export { todos, todosFromDb } from "./todos.js";
export { moduleCoverage, moduleCoverageFromDb } from "./moduleCoverage.js";
export {
  orphanedSections,
  orphanedSectionsFromDb,
} from "./orphanedSections.js";
export { docCompleteness, docCompletenessFromDb } from "./docCompleteness.js";
export { crossGroupDrift, crossGroupDriftFromDb } from "./crossGroupDrift.js";
export { testCoverage, testCoverageFromDb } from "./testCoverage.js";
export {
  mentionsOf,
  mentionsOfFromDb,
  annotationsForFile,
  annotationsForFileFromDb,
} from "./entityBridge.js";
export { hubs, hubsFromDb } from "./hubs.js";
export {
  communities,
  communitiesFromDb,
  communityLabelsFromDb,
} from "./communities.js";
export { surprises, surprisesFromDb } from "./surprises.js";
export { rationale, rationaleFromDb } from "./rationale.js";
export {
  terminologyInconsistency,
  terminologyInconsistencyFromDb,
} from "./terminologyInconsistency.js";
export { dependencyDepth, dependencyDepthFromDb } from "./dependencyDepth.js";
export {
  boundaryViolations,
  boundaryViolationsFromDb,
} from "./boundaryViolations.js";
export { layersInfer, layersInferFromDb } from "./layersInfer.js";
export { layersCheck, layersCheckFromDb } from "./layersCheck.js";
export { layersCompare, layersCompareFromDb } from "./layersCompare.js";
export {
  interfaceConformance,
  interfaceConformanceFromDb,
} from "./interfaceConformance.js";
export { deadFeatures, deadFeaturesFromDb } from "./deadFeatures.js";
export type { DeadFeatureOptions } from "./deadFeatures.js";
export { nameLayers } from "./layerNaming.js";
export { slices, slicesFromDb } from "./slices.js";
export { focus, focusFromDb } from "./focus.js";
export { impact, impactFromDb, formatCariImpact } from "./impact.js";
export { archReport, archReportFromDb } from "./archReport.js";
export type { ArchReportOptions } from "./archReport.js";
export { enrichmentScore, enrichmentScoreFromDb } from "./enrichmentScore.js";
export type { EnrichmentScoreOptions } from "./enrichmentScore.js";
export { verify, verifyFromDb } from "./verify.js";
export { consistency, consistencyFromDb } from "./consistency.js";
export {
  archCheck,
  archCheckFromDb,
  parseArchitectureYaml,
  inferArchConfigFromKg,
  inferArchConfigFromKgDb,
  enrichArchConfigWithFiles,
} from "./archCheck.js";
export {
  diagramEntityCheck,
  diagramEntityCheckFromDb,
} from "./diagramEntityCheck.js";
export type {
  DiagramEntityCheckResult,
  EntityGrounding,
} from "./diagramEntityCheck.js";
export {
  resolveComponent,
  resolveComponentFromDb,
} from "./resolveComponent.js";
export { openIndex } from "./shared.js";
