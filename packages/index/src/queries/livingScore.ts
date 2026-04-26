// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: Living Documentation Score (12.3)
 *
 * Composite score combining four dimensions:
 *   1. Spec coverage (12.1)       — % of KG entities grounded in code
 *   2. Constraint consistency (12.2) — % of constraints without contradictions
 *   3. Documentation freshness    — % of doc files not stale (from report)
 *   4. Architecture conformance   — % of layer import edges without violations
 *
 * Dimensions where the underlying data is unavailable (e.g. no KG entities
 * because enrichment hasn't run) are skipped; the final score is the average
 * of the available dimensions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type {
  LivingScoreParams,
  LivingScoreResult,
  LivingScoreDimension,
  LayerConfig,
} from "../types.js";
import { openIndex, buildImportGraph } from "./shared.js";
import { verifyFromDb } from "./verify.js";
import { consistencyFromDb } from "./consistency.js";
import { reportFromDb } from "./report.js";
import { layersInferFromDb } from "./layersInfer.js";
import { layersCheckFromDb } from "./layersCheck.js";

// =============================================================================
// Public API — dual signature
// =============================================================================

/**
 * Compute the composite living documentation score.
 * Opens and closes the database.
 */
export function livingScore(
  dbPath: string,
  params?: LivingScoreParams,
): LivingScoreResult {
  const db = openIndex(dbPath);
  try {
    return livingScoreFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core logic against an open database.
 */
export function livingScoreFromDb(
  db: Database.Database,
  params?: LivingScoreParams,
): LivingScoreResult {
  const minConfidence = params?.minConfidence ?? 0.5;
  const allowSkipLayer = params?.allowSkipLayer ?? false;

  // ── Dimension 1: Spec coverage (12.1) ─────────────────────────────────────
  const specCoverage = computeSpecCoverage(db, minConfidence);

  // ── Dimension 2: Constraint consistency (12.2) ────────────────────────────
  const constraintConsistency = computeConstraintConsistency(db, minConfidence);

  // ── Dimension 3: Documentation freshness ──────────────────────────────────
  const docFreshness = computeDocFreshness(db);

  // ── Dimension 4: Architecture conformance ─────────────────────────────────
  const archConformance = computeArchConformance(db, allowSkipLayer);

  // ── Composite score ────────────────────────────────────────────────────────
  const available = [
    specCoverage,
    constraintConsistency,
    docFreshness,
    archConformance,
  ].filter((d) => d.available);

  const score =
    available.length === 0
      ? 0
      : Math.round(
          available.reduce((sum, d) => sum + d.score, 0) / available.length,
        );

  const grade = scoreToGrade(score);

  return {
    score,
    grade,
    specCoverage,
    constraintConsistency,
    docFreshness,
    archConformance,
  };
}

// =============================================================================
// Dimension helpers
// =============================================================================

function computeSpecCoverage(
  db: Database.Database,
  minConfidence: number,
): LivingScoreDimension {
  // Check if kg_entities table exists
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'`,
    )
    .get();

  if (!tableExists) {
    return unavailable(
      "Spec Coverage",
      "No KG entities — run `iw index enrich` first",
    );
  }

  const result = verifyFromDb(db, { minConfidence, checkTests: false });

  if (result.summary.total === 0) {
    return unavailable(
      "Spec Coverage",
      "No KG entities — run `iw index enrich` first",
    );
  }

  const { total, grounded, ungrounded, partial } = result.summary;
  const score = result.summary.coveragePercent;
  return {
    label: "Spec Coverage",
    score,
    numerator: grounded,
    denominator: total,
    detail: `${grounded}/${total} entities grounded (${ungrounded} ungrounded, ${partial} partial)`,
    available: true,
  };
}

function computeConstraintConsistency(
  db: Database.Database,
  minConfidence: number,
): LivingScoreDimension {
  // Check if kg_relationships table exists
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kg_relationships'`,
    )
    .get();

  if (!tableExists) {
    return unavailable(
      "Constraint Consistency",
      "No KG relationships — run `iw index enrich` first",
    );
  }

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM kg_relationships WHERE confidence >= ?`,
      )
      .get(minConfidence) as { n: number }
  ).n;

  if (total === 0) {
    return unavailable(
      "Constraint Consistency",
      "No KG relationships — run `iw index enrich` first",
    );
  }

  const result = consistencyFromDb(db, { minConfidence });
  const consistent =
    result.summary.totalRelationships - result.summary.totalConflicts;
  const score = result.summary.consistencyPercent;

  return {
    label: "Constraint Consistency",
    score,
    numerator: consistent,
    denominator: result.summary.totalRelationships,
    detail: `${result.summary.errors} errors, ${result.summary.warnings} warnings across ${result.summary.totalRelationships} relationships`,
    available: true,
  };
}

function computeDocFreshness(db: Database.Database): LivingScoreDimension {
  // Count total doc files
  const totalDocs = (
    db.prepare(`SELECT COUNT(*) AS n FROM files WHERE is_doc = 1`).get() as {
      n: number;
    }
  ).n;

  if (totalDocs === 0) {
    return unavailable("Doc Freshness", "No documentation files in index");
  }

  const rpt = reportFromDb(db);

  const staleDocs = rpt.staleness.staleDocCount;
  const freshDocs = Math.max(0, totalDocs - staleDocs);
  const score = Math.round((freshDocs / totalDocs) * 100);

  return {
    label: "Doc Freshness",
    score,
    numerator: freshDocs,
    denominator: totalDocs,
    detail: `${staleDocs} stale doc${staleDocs !== 1 ? "s" : ""} out of ${totalDocs} total`,
    available: true,
  };
}

function computeArchConformance(
  db: Database.Database,
  allowSkipLayer: boolean,
): LivingScoreDimension {
  // Count resolved import edges (same graph layersCheck uses)
  const { forward } = buildImportGraph(db);
  let totalImports = 0;
  for (const deps of forward.values()) {
    totalImports += deps.size;
  }

  if (totalImports === 0) {
    return unavailable(
      "Architecture Conformance",
      "No resolved import edges — run `iw index build` first",
    );
  }

  // Prefer .iw/layers.yaml (user's committed architecture) over auto-inference
  let layerConfig: LayerConfig | null = null;
  let effectiveAllowSkipLayer = allowSkipLayer;
  const layersYamlPath = path.join(process.cwd(), ".iw", "layers.yaml");

  if (fs.existsSync(layersYamlPath)) {
    try {
      const content = fs.readFileSync(layersYamlPath, "utf-8");
      layerConfig = parseLayersYaml(content);
    } catch {
      // malformed YAML — fall through to auto-infer
    }
  }

  if (!layerConfig) {
    // Auto-infer from import graph depth
    const inferResult = layersInferFromDb(db);
    if (inferResult.layers.length === 0) {
      return unavailable(
        "Architecture Conformance",
        "Could not infer architectural layers",
      );
    }
    // Convert InferredLayer[] → LayerConfig (exact file paths as patterns)
    layerConfig = {
      layers: inferResult.layers.map((layer) => ({
        name: layer.label,
        patterns: layer.files,
      })),
    };
    // Skip-layer is normal in depth-based monorepo layering — only flag reverse imports
    effectiveAllowSkipLayer = true;
  }

  const checkResult = layersCheckFromDb(db, {
    ...layerConfig,
    allowSkipLayer: effectiveAllowSkipLayer,
  });

  const violations = checkResult.totalViolations;
  const clean = Math.max(0, totalImports - violations);
  const score = Math.round((clean / totalImports) * 100);

  const source = fs.existsSync(layersYamlPath) ? ".iw/layers.yaml" : "inferred";
  return {
    label: "Architecture Conformance",
    score,
    numerator: clean,
    denominator: totalImports,
    detail: `${violations} layer violation${violations !== 1 ? "s" : ""} across ${totalImports} import edges [${source}] (${checkResult.byType.reverse} reverse, ${checkResult.byType.skipLayer} skip-layer)`,
    available: true,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Minimal hand-rolled parser for .iw/layers.yaml.
 * Mirrors the implementation in packages/cli (avoids cross-package dependency).
 */
function parseLayersYaml(content: string): LayerConfig {
  const layers: LayerConfig["layers"] = [];
  let currentLayer: { name: string; patterns: string[] } | null = null;
  let inPatterns = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const nameMatch = line.match(/^-\s*name:\s*["']?([^"'\n]+?)["']?\s*$/);
    if (nameMatch) {
      if (currentLayer) layers.push(currentLayer);
      currentLayer = { name: nameMatch[1], patterns: [] };
      inPatterns = false;
      continue;
    }

    if (line === "patterns:" || line === "patterns: []") {
      inPatterns = true;
      continue;
    }

    if (inPatterns && currentLayer && line.startsWith("-")) {
      const pattern = line
        .replace(/^-\s*/, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      if (pattern) currentLayer.patterns.push(pattern);
    }
  }

  if (currentLayer) layers.push(currentLayer);
  if (layers.length === 0) throw new Error("No layers found in layers.yaml");
  return { layers };
}

function unavailable(label: string, detail: string): LivingScoreDimension {
  return {
    label,
    score: 0,
    numerator: 0,
    denominator: 0,
    detail,
    available: false,
  };
}

function scoreToGrade(score: number): LivingScoreResult["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}
