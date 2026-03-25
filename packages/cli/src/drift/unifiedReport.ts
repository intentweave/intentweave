// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified Drift Report
 *
 * Merges output from all four drift detectors into a single
 * UnifiedDriftReport. Used by both CLI rendering and Neo4j persistence.
 *
 * @see PHASE-C-SPEC.md §8
 * @version 0.1
 */

import type {
  DriftSignal,
  DriftSeverity,
  UnifiedDriftReport,
  DetectorStats,
  DRIFT_SCHEMAS,
} from "@intentweave/core";

// =============================================================================
// Report Assembly
// =============================================================================

const SEVERITY_ORDER: Record<DriftSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Assemble a unified drift report from all detector outputs.
 */
export function assembleUnifiedReport(
  session: string,
  workspaceRoot: string,
  docCodeSignals: DriftSignal[],
  temporalSignals: DriftSignal[],
  depsSignals: DriftSignal[],
  docDocSignals: DriftSignal[],
  detectorStats: UnifiedDriftReport["detectorStats"],
): UnifiedDriftReport {
  const signals = [
    ...docCodeSignals,
    ...temporalSignals,
    ...depsSignals,
    ...docDocSignals,
  ];

  // Sort: critical first, then warning, then info; within severity by file path
  signals.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return (a.files[0] ?? "").localeCompare(b.files[0] ?? "");
  });

  return {
    $schema: "intentweave://schemas/drift-report/v1",
    session,
    workspaceRoot,
    analyzedAt: new Date().toISOString(),
    signals,
    detectorStats,
    stats: {
      totalSignals: signals.length,
      criticalCount: signals.filter((s) => s.severity === "critical").length,
      warningCount: signals.filter((s) => s.severity === "warning").length,
      infoCount: signals.filter((s) => s.severity === "info").length,
      totalDurationMs: Object.values(detectorStats).reduce(
        (sum, d) => sum + d.durationMs,
        0,
      ),
    },
  };
}

// =============================================================================
// CLI Renderer
// =============================================================================

/**
 * Render the unified drift report as formatted text for CLI output.
 */
export function renderUnifiedReport(report: UnifiedDriftReport): string {
  const lines: string[] = [];
  const { signals, stats, detectorStats } = report;

  const enabledCount = Object.values(detectorStats).filter(
    (d) => d.enabled,
  ).length;

  lines.push(
    `  Doc Health Report — session: ${report.session}  │  ${enabledCount} detector${enabledCount === 1 ? "" : "s"}  │  ${stats.totalSignals} signals`,
  );
  lines.push("");

  // ── Doc ↔ Code ───────────────────────────────────────────────────────
  if (detectorStats.docCode.enabled) {
    lines.push(
      "  ── Doc ↔ Code ─────────────────────────────────────────────────",
    );
    const dcSignals = signals.filter((s) => s.detector === "doc-code");
    if (dcSignals.length === 0) {
      lines.push("    ✓ No doc-code drift detected");
    } else {
      renderDetectorSection(lines, dcSignals);
    }
    lines.push("");
  }

  // ── Temporal Drift ───────────────────────────────────────────────────
  if (detectorStats.temporal.enabled) {
    lines.push(
      "  ── Temporal Drift ─────────────────────────────────────────────",
    );
    const tSignals = signals.filter((s) => s.detector === "temporal");
    if (tSignals.length === 0) {
      lines.push("    ✓ No temporal drift detected");
    } else {
      renderDetectorSection(lines, tSignals);
    }
    lines.push("");
  }

  // ── Dependencies ─────────────────────────────────────────────────────
  if (detectorStats.deps.enabled) {
    lines.push(
      "  ── Dependencies ───────────────────────────────────────────────",
    );
    const depSignals = signals.filter((s) => s.detector === "deps");
    if (depSignals.length === 0) {
      lines.push("    ✓ No dependency drift detected");
    } else {
      renderDetectorSection(lines, depSignals);
    }
    lines.push("");
  }

  // ── Doc ↔ Doc ────────────────────────────────────────────────────────
  if (detectorStats.docDoc.enabled) {
    lines.push(
      "  ── Doc ↔ Doc ──────────────────────────────────────────────────",
    );
    const ddSignals = signals.filter((s) => s.detector === "doc-doc");
    if (ddSignals.length === 0) {
      lines.push("    ✓ No doc-doc drift detected");
    } else {
      renderDetectorSection(lines, ddSignals);
    }
    lines.push("");
  }

  // ── Footer ───────────────────────────────────────────────────────────
  lines.push(
    "  ─────────────────────────────────────────────────────────────────",
  );
  lines.push(
    `  ✓ ${stats.totalSignals} drift signals  │  ${stats.criticalCount} critical  │  ${stats.warningCount} warnings  │  ${stats.infoCount} info  │  ${(stats.totalDurationMs / 1000).toFixed(1)}s  │  $0.00`,
  );

  return lines.join("\n");
}

// =============================================================================
// Helper: Render signals for one detector section
// =============================================================================

const CATEGORY_ICONS: Record<string, string> = {
  ungrounded: "⚠",
  undocumented: "📄",
  "signature-mismatch": "✗",
  "temporal-stale": "⚠",
  "temporal-volatile": "⟳",
  "abandoned-code": "☠",
  "dep-unused": "📦",
  "dep-undeclared": "⚠",
  "dep-version-drift": "↕",
  "doc-doc-diverged": "↔",
  "doc-doc-contradicts": "✗",
};

const SEVERITY_ICONS: Record<DriftSeverity, string> = {
  critical: "✗",
  warning: "⚠",
  info: "ℹ",
};

function renderDetectorSection(lines: string[], signals: DriftSignal[]): void {
  // Group by category
  const byCategory = new Map<string, DriftSignal[]>();
  for (const s of signals) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category)!.push(s);
  }

  for (const [category, categorySignals] of byCategory) {
    const icon = CATEGORY_ICONS[category] ?? "•";
    const count = categorySignals.length;
    const firstSeverity = categorySignals[0].severity;
    const sevIcon = SEVERITY_ICONS[firstSeverity];

    lines.push(`    ${sevIcon}  ${count} ${formatCategory(category)}`);

    // Show top 5 signals for each category
    for (const s of categorySignals.slice(0, 5)) {
      lines.push(`       ${icon} ${s.name} — ${s.message}`);
    }
    if (count > 5) {
      lines.push(`       ... and ${count - 5} more`);
    }
  }
}

function formatCategory(category: string): string {
  const labels: Record<string, string> = {
    ungrounded: "ungrounded mention(s)",
    undocumented: "undocumented code entit(ies)",
    "signature-mismatch": "signature mismatch(es)",
    "temporal-stale": "stale document(s)",
    "temporal-volatile": "volatile decision(s)",
    "abandoned-code": "abandoned code reference(s)",
    "dep-unused": "unused dependenc(ies)",
    "dep-undeclared": "undeclared dependenc(ies)",
    "dep-version-drift": "version drift(s)",
    "doc-doc-diverged": "diverged doc pair(s)",
    "doc-doc-contradicts": "qualifier contradiction(s)",
  };
  return labels[category] ?? category;
}

// =============================================================================
// Disabled detector stats helper
// =============================================================================

export function disabledDetectorStats(): DetectorStats {
  return {
    enabled: false,
    signalCount: 0,
    durationMs: 0,
    metrics: {},
  };
}
