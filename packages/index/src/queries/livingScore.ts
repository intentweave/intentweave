// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: Living Documentation Score (12.3)
 *
 * Composite score combining two dimensions:
 *   1. Documentation freshness    — % of doc files not stale (from report)
 *   2. Architecture conformance   — % of layer import edges without violations
 *
 * A dimension whose data is unavailable (for example, no layer config) is skipped;
 * the final score is the average of the available dimensions. The knowledge-graph
 * dimensions (spec coverage, constraint consistency) were removed with the KG tables.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "@intentweave/sqlite-compat";
import type {
  LivingScoreParams,
  LivingScoreResult,
  LivingScoreDimension,
  LayerConfig,
} from "../types.js";
import { openIndex, buildImportGraph } from "./shared.js";
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
  const allowSkipLayer = params?.allowSkipLayer ?? false;
  const t0 = Date.now();
  const dim = (label: string) =>
    process.stderr.write(
      `    [living] ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`,
    );

  // ── Dimension 1: Documentation freshness ──────────────────────────────────
  dim("doc freshness…");
  const docFreshness = computeDocFreshness(db);

  // ── Dimension 2: Architecture conformance ─────────────────────────────────
  dim("arch conformance…");
  const archConformance = computeArchConformance(db, allowSkipLayer);
  dim("done");

  // ── Composite score ────────────────────────────────────────────────────────
  const available = [docFreshness, archConformance].filter((d) => d.available);

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
    docFreshness,
    archConformance,
  };
}

// =============================================================================
// Dimension helpers
// =============================================================================

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

  // Fast path: count annotations. If the table is very large the 4-way join
  // inside computeStaleness becomes too slow for interactive scoring.
  const annotationCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM annotations WHERE confidence >= 0.5`)
      .get() as { n: number }
  ).n;

  if (annotationCount > 100_000) {
    return unavailable(
      "Doc Freshness",
      `Annotation set too large (${annotationCount.toLocaleString()}) for inline freshness scoring — run \`iw index report\` separately`,
    );
  }

  // Direct stale-doc count — avoids the full reportFromDb() overhead
  // (which also runs hidden-coupling N-loop queries we don't need here).
  const staleDocs = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT a.doc_path) AS cnt
         FROM annotations a
         JOIN symbols s ON s.id = a.symbol_id
         JOIN files f_doc ON f_doc.path = a.doc_path
         JOIN files f_code ON f_code.path = s.file_path
         WHERE a.confidence >= 0.5
           AND f_doc.last_modified IS NOT NULL
           AND f_code.last_modified IS NOT NULL
           AND f_code.last_modified > f_doc.last_modified`,
      )
      .get() as { cnt: number }
  ).cnt;

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
  // Fast count check BEFORE loading the full graph — buildImportGraph is expensive
  // on large codebases (50 k+ edges) because it loads and resolves every import row.
  const { cnt: importCount } = db
    .prepare(`SELECT COUNT(*) AS cnt FROM imports WHERE is_relative = 1`)
    .get() as { cnt: number };

  if (importCount === 0) {
    return unavailable(
      "Architecture Conformance",
      "No resolved import edges — run `iw index build` first",
    );
  }

  // For very large import graphs this analysis is too slow for interactive use.
  // Above ~20 k edges, skip here and run `iw index layers-check` separately.
  if (importCount > 20_000) {
    return unavailable(
      "Architecture Conformance",
      `Import graph too large (${importCount.toLocaleString()} edges) — run \`iw index layers-check\` separately`,
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
  const clean = Math.max(0, importCount - violations);
  const score = Math.round((clean / importCount) * 100);

  const source = fs.existsSync(layersYamlPath) ? ".iw/layers.yaml" : "inferred";
  return {
    label: "Architecture Conformance",
    score,
    numerator: clean,
    denominator: importCount,
    detail: `${violations} layer violation${violations !== 1 ? "s" : ""} across ${importCount.toLocaleString()} import edges [${source}] (${checkResult.byType.reverse} reverse, ${checkResult.byType.skipLayer} skip-layer)`,

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
