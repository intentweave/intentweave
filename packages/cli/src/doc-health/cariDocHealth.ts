// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI-backed doc health analysis.
 *
 * Reads the SQLite index (.iw/index.db) via @intentweave/index queries
 * to produce a UnifiedDriftReport without requiring Neo4j.
 *
 * Delegates to the existing `report()` query for coverage, staleness,
 * hidden couplings, and undocumented deps — then maps results into
 * DriftSignal[] for unified output.
 *
 * This is the default mode for `iw doc-health`. Use `--neo4j` to
 * enable the richer KG-based analysis (decision predicates, etc.).
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { report as cariReport, type ReportResult } from "@intentweave/index";
import type {
  DriftSignal,
  DriftSeverity,
  DetectorStats,
  UnifiedDriftReport,
} from "@intentweave/core";
import {
  assembleUnifiedReport,
  disabledDetectorStats,
} from "../drift/unifiedReport.js";

// =============================================================================
// Public API
// =============================================================================

export interface CariHealthOptions {
  /** Path to index.db (default: .iw/index.db under cwd) */
  dbPath?: string;
  /** Show progress */
  log?: (msg: string) => void;
}

export interface CariHealthResult {
  report: UnifiedDriftReport;
  dbPath: string;
}

/**
 * Run doc-health analysis from the CARI SQLite index.
 * No Neo4j, no LLM, instant results.
 */
export function analyzeFromCari(options: CariHealthOptions): CariHealthResult {
  const cwd = process.cwd();
  const dbPath = options.dbPath ?? path.join(cwd, ".iw", "index.db");
  const log = options.log ?? (() => {});

  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `CARI index not found at ${dbPath}.\n` +
        "Run `iw index build` first to create the index.",
    );
  }

  const t0 = performance.now();
  log("Running CARI health analysis...");

  const rpt = cariReport(dbPath);
  const totalMs = performance.now() - t0;

  // Map CARI report → DriftSignal arrays for each detector
  const docCodeSignals = mapDocCodeSignals(rpt);
  const temporalSignals = mapTemporalSignals(rpt);
  const docDocSignals = mapDocDocSignals(rpt);

  log(
    `CARI analysis complete in ${(totalMs / 1000).toFixed(1)}s ` +
      `(${docCodeSignals.length + temporalSignals.length + docDocSignals.length} signals)`,
  );

  const report = assembleUnifiedReport(
    "cari",
    cwd,
    docCodeSignals,
    temporalSignals,
    [], // deps: depsDrift reads package.json directly, not needed from CARI
    docDocSignals,
    {
      docCode: makeStats("doc-code", docCodeSignals, totalMs),
      temporal: makeStats("temporal", temporalSignals, totalMs),
      deps: disabledDetectorStats(),
      docDoc: makeStats("doc-doc", docDocSignals, totalMs),
    },
  );

  return { report, dbPath };
}

// =============================================================================
// Signal mappers
// =============================================================================

function mapDocCodeSignals(rpt: ReportResult): DriftSignal[] {
  const signals: DriftSignal[] = [];
  const { coverage } = rpt;

  for (const sym of coverage.topUndocumented) {
    signals.push({
      category: "undocumented",
      severity: "info",
      detector: "doc-code",
      name: sym.name,
      message: `${sym.kind} "${sym.name}" is exported but not referenced in any documentation`,
      files: [sym.filePath],
      evidence: {},
    });
  }

  return signals;
}

function mapTemporalSignals(rpt: ReportResult): DriftSignal[] {
  const signals: DriftSignal[] = [];

  for (const stale of rpt.staleness.topStale) {
    if (stale.daysBehind <= 7) continue;

    const severity: DriftSeverity =
      stale.daysBehind > 90
        ? "critical"
        : stale.daysBehind > 30
          ? "warning"
          : "info";

    signals.push({
      category: "temporal-stale",
      severity,
      detector: "temporal",
      name: path.basename(stale.docPath),
      message: `${stale.docPath} is ${stale.daysBehind} days behind ${stale.newerCodeFile}`,
      files: [stale.docPath, stale.newerCodeFile],
      evidence: {
        docStalenessDays: stale.daysBehind,
      },
    });
  }

  return signals;
}

function mapDocDocSignals(rpt: ReportResult): DriftSignal[] {
  const signals: DriftSignal[] = [];

  for (const coupling of rpt.hiddenCouplings) {
    if (coupling.hasCodeDependency) continue;

    signals.push({
      category: "doc-doc-diverged",
      severity: coupling.docCoocScore >= 0.6 ? "warning" : "info",
      detector: "doc-doc",
      name: `${coupling.entityA} ↔ ${coupling.entityB}`,
      message:
        `"${coupling.entityA}" and "${coupling.entityB}" are co-mentioned in docs ` +
        `(score ${coupling.docCoocScore.toFixed(2)}) but have no code-level dependency`,
      files: [],
      evidence: {
        footprintSimilarity: coupling.docCoocScore,
      },
    });
  }

  return signals;
}

// =============================================================================
// Helpers
// =============================================================================

function makeStats(
  detector: string,
  signals: DriftSignal[],
  totalMs: number,
): DetectorStats {
  return {
    enabled: true,
    signalCount: signals.length,
    durationMs: totalMs,
    metrics: {},
  };
}
