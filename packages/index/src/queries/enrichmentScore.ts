// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: enrichmentScore
 *
 * Combines multiple CARI signals into a composite impact score per file,
 * ranking files by how much they would benefit from LLM semantic enrichment.
 *
 * Impact formula:
 *   score = w₁·hotspot_rank + w₂·orphan_ratio + w₃·hub_degree
 *         + w₄·(1 − module_coverage) + w₅·drift_severity
 *
 * Default weights bias toward orphaned sections and hotspots — files where
 * understanding is most needed and most likely stale.
 */

import type Database from "better-sqlite3";
import type {
  EnrichmentCandidate,
  EnrichmentScoreResult,
  EnrichmentWeights,
} from "../types.js";
import { openIndex } from "./shared.js";
import { hotspotPriorityFromDb } from "./hotspotPriority.js";
import { orphanedSectionsFromDb } from "./orphanedSections.js";
import { hubsFromDb } from "./hubs.js";
import { moduleCoverageFromDb } from "./moduleCoverage.js";
import { crossGroupDriftFromDb } from "./crossGroupDrift.js";

/** Default weights — orphans and hotspots get the most weight. */
const DEFAULT_WEIGHTS: EnrichmentWeights = {
  hotspot: 0.25,
  orphan: 0.30,
  hub: 0.15,
  coverage: 0.20,
  drift: 0.10,
};

export interface EnrichmentScoreOptions {
  /** Restrict to files under this directory prefix. */
  focus?: string;
  /** Custom weights. */
  weights?: Partial<EnrichmentWeights>;
  /** Skip files already enriched (check enrichment_meta). */
  incremental?: boolean;
}

/**
 * Score all workspace files for enrichment candidacy.
 * Opens and closes its own DB handle.
 */
export function enrichmentScore(
  dbPath: string,
  opts?: EnrichmentScoreOptions,
): EnrichmentScoreResult {
  const db = openIndex(dbPath);
  try {
    return enrichmentScoreFromDb(db, opts);
  } finally {
    db.close();
  }
}

/**
 * Core scoring logic against an open database.
 */
export function enrichmentScoreFromDb(
  db: Database.Database,
  opts?: EnrichmentScoreOptions,
): EnrichmentScoreResult {
  const w: EnrichmentWeights = { ...DEFAULT_WEIGHTS, ...opts?.weights };
  const focus = opts?.focus;

  // Collect enrichment_meta for incremental checks
  const enrichedFiles = new Map<string, string>();
  try {
    const rows = db
      .prepare(`SELECT file_path, content_hash FROM enrichment_meta`)
      .all() as Array<{ file_path: string; content_hash: string }>;
    for (const r of rows) enrichedFiles.set(r.file_path, r.content_hash);
  } catch {
    // Table may not exist yet on older schemas — treat as empty
  }

  // Collect current content hashes from files table
  const fileHashes = new Map<string, string>();
  const fileRows = db
    .prepare(`SELECT path, content_hash FROM files WHERE content_hash IS NOT NULL`)
    .all() as Array<{ path: string; content_hash: string }>;
  for (const r of fileRows) fileHashes.set(r.path, r.content_hash);

  // ── Signal 1: Hotspot priority (normalized rank) ──────────────
  const hotspots = hotspotPriorityFromDb(db);
  const hotspotMap = new Map<string, number>();
  const maxHotspot = hotspots.priorities.length;
  hotspots.priorities.forEach((h, i) => {
    // Rank-based: top file = 1.0, bottom = 0.0
    hotspotMap.set(h.filePath, maxHotspot > 1 ? 1 - i / (maxHotspot - 1) : 1);
  });

  // ── Signal 2: Orphan ratio (per doc file) ─────────────────────
  const orphans = orphanedSectionsFromDb(db);
  const orphanMap = new Map<string, number>();
  // Count total sections per doc for ratio
  const sectionCounts = new Map<string, number>();
  const orphanCounts = new Map<string, number>();
  for (const s of orphans.sections) {
    orphanCounts.set(s.docPath, (orphanCounts.get(s.docPath) ?? 0) + 1);
    sectionCounts.set(s.docPath, (sectionCounts.get(s.docPath) ?? 0) + 1);
  }
  // Also count non-orphaned sections from annotations
  const docSections = db
    .prepare(
      `SELECT DISTINCT doc_path, COUNT(DISTINCT line) as sections
       FROM annotations GROUP BY doc_path`,
    )
    .all() as Array<{ doc_path: string; sections: number }>;
  for (const d of docSections) {
    const existing = sectionCounts.get(d.doc_path) ?? 0;
    sectionCounts.set(d.doc_path, Math.max(existing, d.sections));
  }
  for (const [docPath, orphanCount] of orphanCounts) {
    const total = sectionCounts.get(docPath) ?? orphanCount;
    orphanMap.set(docPath, total > 0 ? orphanCount / total : 0);
  }

  // ── Signal 3: Hub degree (normalized) ─────────────────────────
  const hubs = hubsFromDb(db);
  const hubMap = new Map<string, number>();
  const maxDegree = hubs.hubs.length > 0
    ? Math.max(...hubs.hubs.map((h) => h.totalDegree))
    : 1;
  for (const h of hubs.hubs) {
    hubMap.set(h.filePath, h.totalDegree / maxDegree);
  }

  // ── Signal 4: Module coverage gap (1 - coverage%) ─────────────
  const coverage = moduleCoverageFromDb(db);
  const coverageMap = new Map<string, number>();
  for (const m of coverage.modules) {
    coverageMap.set(m.module, 1 - m.coveragePercent / 100);
  }

  // ── Signal 5: Drift severity ──────────────────────────────────
  const drift = crossGroupDriftFromDb(db);
  const driftMap = new Map<string, number>();
  // Associate drift severity with all doc files in the drift groups
  for (const d of drift.drifts) {
    const severity = d.groups.length / Math.max(drift.totalDrifts, 1);
    for (const g of d.groups) {
      for (const docPath of g.docPaths) {
        driftMap.set(
          docPath,
          Math.max(driftMap.get(docPath) ?? 0, severity),
        );
      }
    }
  }

  // ── Collect all unique files ──────────────────────────────────
  const allFiles = new Set<string>();
  // Include both code and doc files
  const allFileRows = db
    .prepare(`SELECT path FROM files`)
    .all() as Array<{ path: string }>;
  for (const f of allFileRows) allFiles.add(f.path);

  // ── Score each file ───────────────────────────────────────────
  const candidates: EnrichmentCandidate[] = [];

  for (const filePath of allFiles) {
    // Focus filter
    if (focus && !filePath.startsWith(focus)) continue;

    // Find the module this file belongs to (for coverage signal)
    const parts = filePath.split("/");
    let coverageGap = 0;
    for (let i = parts.length - 1; i >= 1; i--) {
      const module = parts.slice(0, i).join("/");
      if (coverageMap.has(module)) {
        coverageGap = coverageMap.get(module)!;
        break;
      }
    }

    const signals = {
      hotspotRank: hotspotMap.get(filePath) ?? 0,
      orphanRatio: orphanMap.get(filePath) ?? 0,
      hubDegree: hubMap.get(filePath) ?? 0,
      coverageGap,
      driftSeverity: driftMap.get(filePath) ?? 0,
    };

    const impactScore =
      w.hotspot * signals.hotspotRank +
      w.orphan * signals.orphanRatio +
      w.hub * signals.hubDegree +
      w.coverage * signals.coverageGap +
      w.drift * signals.driftSeverity;

    // Check if already enriched with same content
    let alreadyEnriched = false;
    if (opts?.incremental && enrichedFiles.has(filePath)) {
      const currentHash = fileHashes.get(filePath);
      if (currentHash && currentHash === enrichedFiles.get(filePath)) {
        alreadyEnriched = true;
      }
    }

    candidates.push({
      filePath,
      impactScore: Math.round(impactScore * 1000) / 1000,
      signals,
      alreadyEnriched,
    });
  }

  // Sort by impact score descending
  candidates.sort((a, b) => b.impactScore - a.impactScore);

  return {
    candidates,
    totalEvaluated: candidates.length,
  };
}
