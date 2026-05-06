// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

export { renderArchReportHtml } from "./htmlReport.js";
export {
  renderPrescriptiveReportHtml,
  type PrescriptiveReportData,
  type PrescriptiveLayerNode,
  type PrescriptiveEdge,
  type PrescriptiveRuleSummary,
  type PrescriptiveElementNode,
  type PrescriptiveViolation,
  type PrescriptiveCariOverlay,
  type PrescriptiveLayerCoverage,
} from "./prescriptiveReport.js";
export { renderInsightsBookHtml } from "./insightsBook.js";
export {
  type InsightsBookData,
  type InsightsCodeHealth,
  type InsightsHotspots,
  type InsightsDocumentation,
  type InsightsLivingScore,
} from "./prescriptiveReport.js";
export {
  renderFocusReportHtml,
  renderFocusDot,
  analyzeFocusInsights,
} from "./focusReport.js";
