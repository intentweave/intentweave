// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: impact
 *
 * Local (no Neo4j) impact analysis. Given changed files, finds:
 *   1. Downstream dependents (files that import the changed files, N-hop BFS)
 *   2. Upstream dependencies (files imported by the changed files)
 *   3. Co-change partners (files historically changed together)
 *   4. Affected documentation (docs referencing symbols in changed files)
 *
 * $0 / no LLM / no Neo4j — pure SQLite queries on CARI index.
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  CariImpactParams,
  CariImpactResult,
  CariImpactFile,
  CariImpactDoc,
} from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Analyze impact from a database file path.
 */
export function impact(
  dbPath: string,
  params: CariImpactParams,
): CariImpactResult {
  const db = openIndex(dbPath);
  try {
    return impactFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core CARI impact analysis against an open database.
 */
export function impactFromDb(
  db: Database.Database,
  params: CariImpactParams,
): CariImpactResult {
  const hops = params.hops ?? 2;
  const limit = params.limit ?? 50;
  const changed = params.changed.map((f) => f.replace(/^\.\//, ""));

  if (changed.length === 0) {
    return emptyResult([]);
  }

  const changedSet = new Set(changed);

  // ── 1. Downstream dependents (files that import the changed files) ──
  // BFS expansion through reverse import graph
  const dependents = findDependents(db, changedSet, hops, limit);

  // ── 2. Upstream dependencies (files imported by the changed files) ──
  const dependencies = findDependencies(db, changedSet, limit);

  // ── 3. Co-change partners ──
  const coChangePartners = findCoChangePartners(db, changedSet, limit);

  // ── 4. Affected documentation ──
  const affectedDocs = findAffectedDocs(db, changedSet, limit);

  return {
    files: changed,
    dependents,
    dependencies,
    coChangePartners,
    affectedDocs,
    stats: {
      filesAnalyzed: changed.length,
      dependentCount: dependents.length,
      dependencyCount: dependencies.length,
      coChangeCount: coChangePartners.length,
      affectedDocCount: affectedDocs.length,
    },
  };
}

// ─── Downstream dependents (BFS through reverse imports) ───────────────────

function findDependents(
  db: Database.Database,
  changedSet: Set<string>,
  maxHops: number,
  limit: number,
): CariImpactFile[] {
  // Build reverse import edges: target_file → source_files (who imports it)
  const stmt = db.prepare(
    `SELECT source_file, target_file FROM imports
     WHERE source_file IS NOT NULL AND target_file IS NOT NULL`,
  );
  const rows = stmt.all() as Array<{
    source_file: string;
    target_file: string;
  }>;

  const reverseImports = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!reverseImports.has(row.target_file)) {
      reverseImports.set(row.target_file, new Set());
    }
    reverseImports.get(row.target_file)!.add(row.source_file);
  }

  // BFS from changed files
  const visited = new Map<string, number>(); // file → depth
  let frontier = new Set(changedSet);

  for (let hop = 1; hop <= maxHops; hop++) {
    const nextFrontier = new Set<string>();
    for (const f of frontier) {
      const importers = reverseImports.get(f);
      if (!importers) continue;
      for (const importer of importers) {
        if (changedSet.has(importer)) continue;
        if (visited.has(importer)) continue;
        visited.set(importer, hop);
        nextFrontier.add(importer);
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  return [...visited.entries()]
    .sort(([, a], [, b]) => a - b)
    .slice(0, limit)
    .map(([filePath, depth]) => ({
      filePath,
      via: "reverse-import" as const,
      depth,
      score: 1 / depth, // closer = higher score
    }));
}

// ─── Upstream dependencies ─────────────────────────────────────────────────

function findDependencies(
  db: Database.Database,
  changedSet: Set<string>,
  limit: number,
): CariImpactFile[] {
  const placeholders = [...changedSet].map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT target_file, source_file
       FROM imports
       WHERE source_file IN (${placeholders})
         AND target_file IS NOT NULL
       ORDER BY target_file`,
    )
    .all(...changedSet) as Array<{
    target_file: string;
    source_file: string;
  }>;

  // Deduplicate
  const deps = new Map<string, CariImpactFile>();
  for (const row of rows) {
    if (changedSet.has(row.target_file)) continue;
    if (!deps.has(row.target_file)) {
      deps.set(row.target_file, {
        filePath: row.target_file,
        via: "import",
        depth: 1,
        score: 1,
      });
    }
  }

  return [...deps.values()].slice(0, limit);
}

// ─── Co-change partners ────────────────────────────────────────────────────

function findCoChangePartners(
  db: Database.Database,
  changedSet: Set<string>,
  limit: number,
): CariImpactFile[] {
  const results = new Map<string, CariImpactFile>();

  for (const changedFile of changedSet) {
    const rows = db
      .prepare(
        `SELECT file_a, file_b, count, jaccard
         FROM co_changes
         WHERE (file_a = ? OR file_b = ?)
           AND jaccard >= 0.2
         ORDER BY jaccard DESC
         LIMIT ?`,
      )
      .all(changedFile, changedFile, limit) as Array<{
      file_a: string;
      file_b: string;
      count: number;
      jaccard: number;
    }>;

    for (const row of rows) {
      const other = row.file_a === changedFile ? row.file_b : row.file_a;
      if (changedSet.has(other)) continue;
      const existing = results.get(other);
      if (!existing || row.jaccard > existing.score) {
        results.set(other, {
          filePath: other,
          via: "co-change",
          depth: 0,
          score: row.jaccard,
        });
      }
    }
  }

  return [...results.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── Affected documentation ────────────────────────────────────────────────

function findAffectedDocs(
  db: Database.Database,
  changedSet: Set<string>,
  limit: number,
): CariImpactDoc[] {
  const placeholders = [...changedSet].map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.doc_path, a.confidence, s.name AS symbol_name
       FROM annotations a
       JOIN symbols s ON s.id = a.symbol_id
       WHERE s.file_path IN (${placeholders})
         AND a.confidence >= 0.4
       ORDER BY a.confidence DESC`,
    )
    .all(...changedSet) as Array<{
    doc_path: string;
    confidence: number;
    symbol_name: string;
  }>;

  // Group by doc_path
  const docMap = new Map<
    string,
    { count: number; maxConf: number; symbols: Set<string> }
  >();
  for (const row of rows) {
    const existing = docMap.get(row.doc_path);
    if (existing) {
      existing.count++;
      existing.maxConf = Math.max(existing.maxConf, row.confidence);
      existing.symbols.add(row.symbol_name);
    } else {
      docMap.set(row.doc_path, {
        count: 1,
        maxConf: row.confidence,
        symbols: new Set([row.symbol_name]),
      });
    }
  }

  return [...docMap.entries()]
    .map(([docPath, data]) => ({
      docPath,
      mentionCount: data.count,
      maxConfidence: data.maxConf,
      symbols: [...data.symbols],
    }))
    .sort((a, b) => b.maxConfidence - a.maxConfidence)
    .slice(0, limit);
}

// ─── Formatting ────────────────────────────────────────────────────────────

/**
 * Format CARI impact results as markdown.
 */
export function formatCariImpact(result: CariImpactResult): string {
  const lines: string[] = [];

  lines.push(`## Impact Analysis: ${result.files.join(", ")}\n`);
  lines.push(
    `Analyzed ${result.stats.filesAnalyzed} file(s) — ` +
      `${result.stats.dependentCount} dependents, ` +
      `${result.stats.dependencyCount} dependencies, ` +
      `${result.stats.coChangeCount} co-change partners, ` +
      `${result.stats.affectedDocCount} affected docs\n`,
  );

  if (result.dependents.length > 0) {
    lines.push("### Downstream Dependents (files that import changed code)\n");
    for (const d of result.dependents) {
      lines.push(
        `- \`${d.filePath}\` — ${d.depth} hop${d.depth > 1 ? "s" : ""} away`,
      );
    }
    lines.push("");
  }

  if (result.dependencies.length > 0) {
    lines.push("### Upstream Dependencies (files imported by changed code)\n");
    for (const d of result.dependencies) {
      lines.push(`- \`${d.filePath}\``);
    }
    lines.push("");
  }

  if (result.coChangePartners.length > 0) {
    lines.push("### Co-Change Partners (historically changed together)\n");
    for (const c of result.coChangePartners) {
      lines.push(`- \`${c.filePath}\` — jaccard=${c.score.toFixed(2)}`);
    }
    lines.push("");
  }

  if (result.affectedDocs.length > 0) {
    lines.push("### Affected Documentation\n");
    for (const doc of result.affectedDocs) {
      lines.push(
        `- \`${doc.docPath}\` — ${doc.mentionCount} mention(s), ` +
          `confidence=${doc.maxConfidence.toFixed(2)}, ` +
          `symbols: ${doc.symbols.join(", ")}`,
      );
    }
    lines.push("");
  }

  if (
    result.dependents.length === 0 &&
    result.dependencies.length === 0 &&
    result.coChangePartners.length === 0 &&
    result.affectedDocs.length === 0
  ) {
    lines.push(
      "_No impact data found. Ensure `iw index build` has been run._\n",
    );
  }

  return lines.join("\n");
}

function emptyResult(files: string[]): CariImpactResult {
  return {
    files,
    dependents: [],
    dependencies: [],
    coChangePartners: [],
    affectedDocs: [],
    stats: {
      filesAnalyzed: files.length,
      dependentCount: 0,
      dependencyCount: 0,
      coChangeCount: 0,
      affectedDocCount: 0,
    },
  };
}
