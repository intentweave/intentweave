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
export {
  mentionsOf,
  mentionsOfFromDb,
  annotationsForFile,
  annotationsForFileFromDb,
} from "./entityBridge.js";
export { openIndex } from "./shared.js";
