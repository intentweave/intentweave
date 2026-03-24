// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * HOT Stage — Hotspot Detection
 *
 * Identifies files with disproportionately high change frequency,
 * weighted by recency. Uses z-scores to find statistical outliers.
 *
 * @see PHASE-B-SPEC.md §6
 * @version 0.1
 */

import type {
  HotStageInput,
  HotStageOutput,
  HotspotSignal,
} from "@intentweave/core";
import { TCG_SCHEMAS } from "@intentweave/core";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_Z_THRESHOLD = 2.0;

// =============================================================================
// runHotStage
// =============================================================================

export function runHotStage(input: HotStageInput): HotStageOutput {
  const startMs = Date.now();
  const { tcxOutput, zScoreThreshold = DEFAULT_Z_THRESHOLD, log } = input;

  // ── Aggregate per-file stats ───────────────────────────────────────
  const now = Date.now();

  interface FileStats {
    commitCount: number;
    churn: number;
    recencyScore: number;
    lastModified: string;
    authors: Set<string>;
  }

  const fileStats = new Map<string, FileStats>();

  for (const commit of tcxOutput.commits) {
    const commitDate = new Date(commit.date).getTime();
    const daysSinceCommit = Math.max(
      0,
      (now - commitDate) / (1000 * 60 * 60 * 24),
    );
    // Exponential decay: recent commits weigh more
    const recencyWeight = 1 / (1 + daysSinceCommit);

    for (const file of commit.files) {
      let stats = fileStats.get(file.filePath);
      if (!stats) {
        stats = {
          commitCount: 0,
          churn: 0,
          recencyScore: 0,
          lastModified: "",
          authors: new Set(),
        };
        fileStats.set(file.filePath, stats);
      }
      stats.commitCount++;
      stats.churn += file.linesAdded + file.linesRemoved;
      stats.recencyScore += recencyWeight;
      stats.authors.add(commit.authorName);

      if (!stats.lastModified || commit.date > stats.lastModified) {
        stats.lastModified = commit.date;
      }
    }
  }

  // ── Compute mean and stddev of commitCount ─────────────────────────
  const allCounts = Array.from(fileStats.values()).map((s) => s.commitCount);
  const n = allCounts.length;

  if (n === 0) {
    return {
      $schema: TCG_SCHEMAS.hot,
      stage: "HOT",
      hotspots: [],
      repoStats: {
        meanCommitsPerFile: 0,
        stdDevCommitsPerFile: 0,
        meanChurnPerFile: 0,
      },
      meta: {
        hotspotCount: 0,
        totalFilesAnalyzed: 0,
        zScoreThreshold,
        processingTimeMs: Date.now() - startMs,
      },
    };
  }

  const mean = allCounts.reduce((a, b) => a + b, 0) / n;
  const variance =
    allCounts.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  const allChurn = Array.from(fileStats.values()).map((s) => s.churn);
  const meanChurn = allChurn.reduce((a, b) => a + b, 0) / n;

  // ── Find hotspots (z-score > threshold) ────────────────────────────
  const hotspots: HotspotSignal[] = [];

  for (const [filePath, stats] of fileStats) {
    const zScore = stdDev > 0 ? (stats.commitCount - mean) / stdDev : 0;

    if (zScore >= zScoreThreshold) {
      hotspots.push({
        filePath,
        commitCount: stats.commitCount,
        churn: stats.churn,
        recencyScore: Math.round(stats.recencyScore * 1000) / 1000,
        zScore: Math.round(zScore * 100) / 100,
        lastModified: stats.lastModified,
        authors: Array.from(stats.authors),
      });
    }
  }

  // Sort by recencyScore descending (most actively hot first)
  hotspots.sort((a, b) => b.recencyScore - a.recencyScore);

  log?.(
    `HOT: ${hotspots.length} hotspots found (z > ${zScoreThreshold}) out of ${n} files`,
  );

  const durationMs = Date.now() - startMs;

  return {
    $schema: TCG_SCHEMAS.hot,
    stage: "HOT",
    hotspots,
    repoStats: {
      meanCommitsPerFile: Math.round(mean * 100) / 100,
      stdDevCommitsPerFile: Math.round(stdDev * 100) / 100,
      meanChurnPerFile: Math.round(meanChurn * 100) / 100,
    },
    meta: {
      hotspotCount: hotspots.length,
      totalFilesAnalyzed: n,
      zScoreThreshold,
      processingTimeMs: durationMs,
    },
  };
}
