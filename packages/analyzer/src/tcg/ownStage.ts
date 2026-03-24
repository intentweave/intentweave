// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * OWN Stage — Ownership Mapping
 *
 * Determines who "owns" each file based on git commit history.
 * Uses Gini coefficient to measure ownership clarity.
 *
 * @see PHASE-B-SPEC.md §7
 * @version 0.1
 */

import type {
  OwnStageInput,
  OwnStageOutput,
  OwnershipRecord,
  AuthorContribution,
} from "@intentweave/core";
import { TCG_SCHEMAS } from "@intentweave/core";

// =============================================================================
// runOwnStage
// =============================================================================

export function runOwnStage(input: OwnStageInput): OwnStageOutput {
  const startMs = Date.now();
  const { tcxOutput, minCommits = 1, log } = input;

  // ── Aggregate author contributions per file ────────────────────────
  // Map<filePath, Map<authorEmail, { name, email, commitCount, lastTouch }>>
  const fileAuthors = new Map<
    string,
    Map<string, { name: string; email: string; commitCount: number; lastTouch: string }>
  >();

  for (const commit of tcxOutput.commits) {
    for (const file of commit.files) {
      let authors = fileAuthors.get(file.filePath);
      if (!authors) {
        authors = new Map();
        fileAuthors.set(file.filePath, authors);
      }

      const existing = authors.get(commit.authorEmail);
      if (existing) {
        existing.commitCount++;
        if (commit.date > existing.lastTouch) {
          existing.lastTouch = commit.date;
          existing.name = commit.authorName; // most recent name
        }
      } else {
        authors.set(commit.authorEmail, {
          name: commit.authorName,
          email: commit.authorEmail,
          commitCount: 1,
          lastTouch: commit.date,
        });
      }
    }
  }

  // ── Build ownership records ────────────────────────────────────────
  const ownership: OwnershipRecord[] = [];
  const vacuums: string[] = [];

  for (const [filePath, authorMap] of fileAuthors) {
    // Filter by minCommits
    const qualified = Array.from(authorMap.values()).filter(
      (a) => a.commitCount >= minCommits,
    );

    if (qualified.length === 0) continue;

    const totalCommits = qualified.reduce((s, a) => s + a.commitCount, 0);

    const authors: AuthorContribution[] = qualified
      .map((a) => ({
        name: a.name,
        email: a.email,
        commitCount: a.commitCount,
        percentage: Math.round((a.commitCount / totalCommits) * 10000) / 100,
        lastTouch: a.lastTouch,
      }))
      .sort((a, b) => b.commitCount - a.commitCount);

    // ── Gini coefficient ─────────────────────────────────────────────
    const ownershipClarity = computeGini(
      authors.map((a) => a.commitCount),
    );
    const hasClearOwner = authors[0].percentage > 50;

    const record: OwnershipRecord = {
      filePath,
      authors,
      ownershipClarity: Math.round(ownershipClarity * 1000) / 1000,
      hasClearOwner,
    };

    if (hasClearOwner) {
      record.primaryOwner = authors[0].name;
    }

    if (ownershipClarity < 0.3 && authors.length > 1) {
      vacuums.push(filePath);
    }

    ownership.push(record);
  }

  // Sort by filePath for determinism
  ownership.sort((a, b) => a.filePath.localeCompare(b.filePath));
  vacuums.sort();

  log?.(
    `OWN: ${ownership.length} files analyzed, ${vacuums.length} ownership vacuums`,
  );

  const durationMs = Date.now() - startMs;

  return {
    $schema: TCG_SCHEMAS.own,
    stage: "OWN",
    ownership,
    ownershipVacuums: vacuums,
    meta: {
      filesAnalyzed: ownership.length,
      vacuumCount: vacuums.length,
      processingTimeMs: durationMs,
    },
  };
}

// =============================================================================
// Gini Coefficient
// =============================================================================

/**
 * Compute the Gini coefficient of a distribution.
 *
 * 0.0 = perfectly equal (all authors have same commit count)
 * 1.0 = perfectly unequal (one author has all commits)
 *
 * Uses the formula:
 *   G = (2 * sum_i( i * x_i )) / (n * sum(x)) - (n + 1) / n
 * where x is sorted ascending and i is 1-indexed.
 */
function computeGini(values: number[]): number {
  if (values.length <= 1) return 1.0; // single author = clear ownership

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);

  if (sum === 0) return 0;

  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i + 1) * sorted[i];
  }

  return (2 * numerator) / (n * sum) - (n + 1) / n;
}
