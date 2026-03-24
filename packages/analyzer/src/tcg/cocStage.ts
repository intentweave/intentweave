// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * COC Stage — Co-change Analysis
 *
 * Computes co-change edges between files based on commit co-occurrence.
 * Uses Jaccard similarity on commit sets.
 *
 * Commits with >50 files are skipped (mass infrastructure changes produce
 * noise edges, not meaningful co-evolution signals).
 *
 * @see PHASE-B-SPEC.md §5
 * @version 0.1
 */

import type {
  CocStageInput,
  CocStageOutput,
  CoChangeEdge,
} from "@intentweave/core";
import { TCG_SCHEMAS } from "@intentweave/core";

// =============================================================================
// Constants
// =============================================================================

/** Max files per commit — larger commits are skipped (noise from mass renames etc.) */
const MAX_FILES_PER_COMMIT = 50;

/** Default minimum co-change count threshold */
const DEFAULT_MIN_CO_CHANGES = 3;

/** Default minimum Jaccard score threshold */
const DEFAULT_MIN_JACCARD = 0.1;

// =============================================================================
// runCocStage
// =============================================================================

export function runCocStage(input: CocStageInput): CocStageOutput {
  const startMs = Date.now();
  const {
    tcxOutput,
    minCoChanges = DEFAULT_MIN_CO_CHANGES,
    minJaccard = DEFAULT_MIN_JACCARD,
    log,
  } = input;

  // ── Build file → commit-set index ──────────────────────────────────
  // Map<filePath, Set<commitHash>>
  const fileCommits = new Map<string, Set<string>>();

  // Map<"fileA\0fileB", string[]> — pair → commit hashes
  const pairCommits = new Map<string, string[]>();

  let skippedCommits = 0;

  for (const commit of tcxOutput.commits) {
    const filePaths = commit.files.map((f) => f.filePath);

    // Skip mass-change commits
    if (filePaths.length > MAX_FILES_PER_COMMIT) {
      skippedCommits++;
      continue;
    }

    // Record which commits touch each file
    for (const fp of filePaths) {
      let s = fileCommits.get(fp);
      if (!s) {
        s = new Set();
        fileCommits.set(fp, s);
      }
      s.add(commit.hash);
    }

    // Record pair co-occurrences
    const sorted = [...filePaths].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\0${sorted[j]}`;
        let list = pairCommits.get(key);
        if (!list) {
          list = [];
          pairCommits.set(key, list);
        }
        list.push(commit.hash);
      }
    }
  }

  log?.(
    `COC: ${fileCommits.size} files, ${pairCommits.size} pairs considered, ${skippedCommits} large commits skipped`,
  );

  // ── Compute Jaccard + filter ───────────────────────────────────────
  const edges: CoChangeEdge[] = [];

  for (const [key, hashes] of pairCommits) {
    if (hashes.length < minCoChanges) continue;

    const [fileA, fileB] = key.split("\0");
    const commitsA = fileCommits.get(fileA)!;
    const commitsB = fileCommits.get(fileB)!;

    // Jaccard = |intersection| / |union|
    // intersection = hashes.length (they co-occurred in exactly these commits)
    // union = |commitsA| + |commitsB| - |intersection|
    const intersection = hashes.length;
    const union = commitsA.size + commitsB.size - intersection;
    const jaccardScore = union > 0 ? intersection / union : 0;

    if (jaccardScore < minJaccard) continue;

    edges.push({
      fileA,
      fileB,
      coChangeCount: hashes.length,
      jaccardScore: Math.round(jaccardScore * 1000) / 1000, // 3dp
      commitHashes: hashes,
    });
  }

  // Sort by co-change count descending
  edges.sort((a, b) => b.coChangeCount - a.coChangeCount);

  const durationMs = Date.now() - startMs;

  return {
    $schema: TCG_SCHEMAS.coc,
    stage: "COC",
    edges,
    meta: {
      edgeCount: edges.length,
      pairsConsidered: pairCommits.size,
      minCoChangeThreshold: minCoChanges,
      minJaccardThreshold: minJaccard,
      processingTimeMs: durationMs,
    },
  };
}
