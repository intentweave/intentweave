// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Linking Module Exports
 */

export {
  runLxCore,
  pxOutputsToLxInputs,
  createEmptyLxOutput,
  type LxArtifactInput,
  type LxCoreOptions,
} from './lxCore.js';

export {
  generateCoverageReport,
  createEmptyCoverageReport,
  summarizeCoverageReport,
  type CoverageReport,
  type CoverageReportInput,
  type CoverageReportOptions,
  type RoleTransitionCoverage,
  type InconsistencyFinding,
  type IncompletenessFinding,
} from './coverageReport.js';
