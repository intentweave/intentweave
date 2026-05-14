// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Rule Coverage (Phase 4)
 *
 * Flags packages/directories that have zero behavioral rules covering them.
 * A behavioral rule "covers" a package if the rule's Mermaid diagram mentions
 * a participant that resolves to a file in that package.
 *
 * This is the "rule coverage monitoring" deliverable from Phase 4.
 */

import Database from "better-sqlite3";
import { openIndex } from "./shared.js";
import type { RulesConfig } from "../types.js";

// =============================================================================
// Types
// =============================================================================

export interface RuleCoverageOptions {
  /** rules.yaml config — provides behavioral rule definitions. */
  rulesConfig: RulesConfig;
  /**
   * Minimum depth of directory grouping (default: 2).
   * E.g. depth 2 gives "packages/foo", depth 3 gives "packages/foo/src".
   */
  groupDepth?: number;
}

export interface PackageCoverage {
  /** Directory path (partial, grouped). */
  dir: string;
  /** Number of code files in this directory. */
  fileCount: number;
  /** Number of behavioral rules that mention symbols/files in this dir. */
  behavioralRuleCount: number;
  /** Rule IDs covering this package. */
  coveredByRules: string[];
}

export interface RuleCoverageResult {
  /** Total behavioral rules in config. */
  totalBehavioralRules: number;
  /** Packages with at least one behavioral rule. */
  covered: PackageCoverage[];
  /** Packages with no behavioral rules (the coverage gap). */
  uncovered: PackageCoverage[];
  /** Packages without behavioral rules, sorted by file count descending. */
  topUncovered: PackageCoverage[];
}

// =============================================================================
// Implementation
// =============================================================================

export function ruleCoverageFromDb(
  db: Database.Database,
  opts: RuleCoverageOptions,
): RuleCoverageResult {
  const groupDepth = opts.groupDepth ?? 2;
  const rulesConfig = opts.rulesConfig;

  const behavioralRules = rulesConfig.rules.filter(
    (r) => r.domain === "behavioral",
  );

  // ── Get all packages (code files grouped by directory depth) ─────────────
  const codeFiles = db
    .prepare<[], { path: string }>(
      `SELECT DISTINCT path FROM files WHERE is_doc = 0 OR is_doc IS NULL ORDER BY path`,
    )
    .all() as Array<{ path: string }>;

  const dirFileCounts = new Map<string, number>();
  for (const row of codeFiles) {
    const dir = dirAtDepth(row.path, groupDepth);
    if (!dir) continue;
    dirFileCounts.set(dir, (dirFileCounts.get(dir) ?? 0) + 1);
  }

  // ── Map each behavioral rule to the directories it covers ────────────────
  const ruleToDirs = new Map<string, Set<string>>();
  const dirToRules = new Map<string, string[]>();

  for (const rule of behavioralRules) {
    const coveredDirs = new Set<string>();

    // Extract participant names from mermaid diagram (inline or file source)
    const participants = extractParticipantsFromRule(rule);

    for (const participant of participants) {
      // Resolve participant → file paths in DB
      const matchedFiles = db
        .prepare<{ slug: string }, { path: string; file_path: string }>(
          `SELECT DISTINCT f.path FROM files f
           WHERE LOWER(f.path) LIKE '%' || LOWER(:slug) || '%'
           UNION
           SELECT DISTINCT s.file_path as path FROM symbols s
           WHERE LOWER(s.name) LIKE '%' || LOWER(:slug) || '%'`,
        )
        .all({ slug: participant.toLowerCase() }) as Array<{ path: string }>;

      for (const mf of matchedFiles) {
        const dir = dirAtDepth(mf.path, groupDepth);
        if (dir) coveredDirs.add(dir);
      }
    }

    ruleToDirs.set(rule.id, coveredDirs);
    for (const dir of coveredDirs) {
      if (!dirToRules.has(dir)) dirToRules.set(dir, []);
      dirToRules.get(dir)!.push(rule.id);
    }
  }

  // ── Build coverage result ────────────────────────────────────────────────
  const covered: PackageCoverage[] = [];
  const uncovered: PackageCoverage[] = [];

  for (const [dir, fileCount] of dirFileCounts) {
    const rules = dirToRules.get(dir) ?? [];
    const entry: PackageCoverage = {
      dir,
      fileCount,
      behavioralRuleCount: rules.length,
      coveredByRules: rules,
    };
    if (rules.length > 0) {
      covered.push(entry);
    } else {
      uncovered.push(entry);
    }
  }

  uncovered.sort((a, b) => b.fileCount - a.fileCount);

  return {
    totalBehavioralRules: behavioralRules.length,
    covered,
    uncovered,
    topUncovered: uncovered.slice(0, 10),
  };
}

export function ruleCoverage(
  dbPath: string,
  opts: RuleCoverageOptions,
): RuleCoverageResult {
  const db = openIndex(dbPath);
  try {
    return ruleCoverageFromDb(db, opts);
  } finally {
    db.close();
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Truncate a file path to the first `depth` path segments. */
function dirAtDepth(filePath: string, depth: number): string | null {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) return null; // skip root-level files
  return parts.slice(0, depth).join("/");
}

/**
 * Extract participant names from a rule's mermaid diagram text.
 * Uses a simple regex — does not need full parsing.
 */
function extractParticipantsFromRule(rule: {
  mermaid?: string;
  source?: { type?: string; file?: string };
}): string[] {
  const diagram = rule.mermaid;
  if (!diagram) return [];

  const participants = new Set<string>();

  // sequenceDiagram participants: "participant X" or "actor X" or message arrows
  for (const m of diagram.matchAll(/^(?:participant|actor)\s+(\S+)/gm)) {
    participants.add(m[1]);
  }
  // Arrow participants: "A->>B:" or "A->B:"
  for (const m of diagram.matchAll(
    /^(\w[\w.]*)\s*(?:-+>>?|==>|-\.->|-->>?)\s*([\w.]+)/gm,
  )) {
    participants.add(m[1]);
    participants.add(m[2]);
  }
  // stateDiagram: state names from transitions "A --> B"
  for (const m of diagram.matchAll(/^(\w[\w.]*)\s*-->\s*([\w.]+)/gm)) {
    if (m[1] !== "[*]" && m[2] !== "[*]") {
      participants.add(m[1]);
      participants.add(m[2]);
    }
  }
  // flowchart: node labels "A[text]" or plain node names
  for (const m of diagram.matchAll(/\b(\w[\w.]*)\s*[\[({>]/gm)) {
    participants.add(m[1]);
  }

  return [...participants];
}
