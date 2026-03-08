// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports Module
 *
 * Types and utilities for IntentWeave reporting.
 */

// Types
export * from "./types.js";

// Fingerprint utilities
export {
  computeFingerprintHash,
  getIssuePrefix,
  createContradictionFingerprint,
  createOpenEndFingerprint,
  createNeedsReviewFingerprint,
  createErrorFingerprint,
} from "./fingerprint.js";

// Issue registry
export {
  getIssueRegistryPath,
  loadIssueRegistry,
  saveIssueRegistry,
  getOrAllocateIssueId,
  markUnseenAsResolved,
  computeIssueTrend,
  type IssueIdResult,
  type IssueTrendResult,
} from "./registry.js";

// Severity and scoring
export {
  computeSeverity,
  parseEffort,
  computeActionScore,
  rankActions,
} from "./severity.js";

// Generator
export {
  generateReport,
  saveReport,
  loadLatestReport,
  extractProblemsReport,
  findLatestRunId,
  type ReportGeneratorOptions,
  type RunMetadata,
  type Finding,
  type FindingsFile,
  type CoverageFile,
} from "./generator.js";

// Formatters
export { formatProblemsReport, formatFullReport } from "./formatters/index.js";
