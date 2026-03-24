// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * TCX Stage — Commit Extraction
 *
 * First stage of the TCG pipeline: parse git log into structured commit
 * data, deduplicate authors, collect unique file paths.
 *
 * @see PHASE-B-SPEC.md §4
 * @version 0.1
 */

import type { TcxStageInput, TcxStageOutput } from "@intentweave/core";
import { TCG_SCHEMAS } from "@intentweave/core";
import { parseGitLog } from "./gitLogParser.js";

// =============================================================================
// runTcxStage
// =============================================================================

export async function runTcxStage(
  input: TcxStageInput,
): Promise<TcxStageOutput> {
  const startMs = Date.now();
  const { workspaceRoot, depth, since, pathFilter, log } = input;

  // ── Parse git log ──────────────────────────────────────────────────
  const commits = await parseGitLog({
    repoRoot: workspaceRoot,
    depth,
    since,
    pathFilter,
    log,
  });

  // ── Deduplicate authors (by email, keep most recent name) ──────────
  const authorMap = new Map<
    string,
    { name: string; email: string; commitCount: number; lastDate: string }
  >();

  for (const commit of commits) {
    const existing = authorMap.get(commit.authorEmail);
    if (existing) {
      existing.commitCount++;
      // Keep the most recent name (in case they changed display name)
      if (commit.date > existing.lastDate) {
        existing.name = commit.authorName;
        existing.lastDate = commit.date;
      }
    } else {
      authorMap.set(commit.authorEmail, {
        name: commit.authorName,
        email: commit.authorEmail,
        commitCount: 1,
        lastDate: commit.date,
      });
    }
  }

  const authors = Array.from(authorMap.values())
    .map(({ name, email, commitCount }) => ({ name, email, commitCount }))
    .sort((a, b) => b.commitCount - a.commitCount);

  // ── Collect unique file paths ──────────────────────────────────────
  const fileSet = new Set<string>();
  for (const commit of commits) {
    for (const file of commit.files) {
      fileSet.add(file.filePath);
    }
  }
  const filePaths = Array.from(fileSet).sort();

  // ── Time range ─────────────────────────────────────────────────────
  let timeRangeStart = "";
  let timeRangeEnd = "";
  if (commits.length > 0) {
    // Commits come newest-first from git log
    timeRangeEnd = commits[0].date;
    timeRangeStart = commits[commits.length - 1].date;
  }

  const durationMs = Date.now() - startMs;

  return {
    $schema: TCG_SCHEMAS.tcx,
    stage: "TCX",
    commits,
    authors,
    filePaths,
    meta: {
      commitCount: commits.length,
      authorCount: authors.length,
      fileCount: filePaths.length,
      timeRangeStart,
      timeRangeEnd,
      processingTimeMs: durationMs,
    },
  };
}
