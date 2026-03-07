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
