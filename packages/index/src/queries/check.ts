// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: check
 *
 * CI drift detection. Given a list of changed files (from PR diff),
 * finds annotations referencing symbols in those files, compares
 * modification dates, and identifies co-change partners not in the PR.
 *
 * Output formats: text, JSON, GitHub Actions annotations.
 */

import type Database from "@intentweave/sqlite-compat";
import type { CheckParams, CheckResult, CheckFinding } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Check changed files for documentation drift.
 */
export function check(dbPath: string, params: CheckParams): CheckResult {
  const db = openIndex(dbPath);
  try {
    return checkFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core check logic against an open database.
 */
export function checkFromDb(
  db: Database.Database,
  params: CheckParams,
): CheckResult {
  const minSeverity = params.severity ?? "info";
  const changed = params.changed.map((f) => f.replace(/^\.\//, ""));
  if (changed.length === 0) return { findings: [], exitCode: 0 };

  const findings: CheckFinding[] = [];

  // ── 1. Stale doc annotations ───────────────────────────────
  // Find docs that reference symbols in the changed code files
  for (const changedFile of changed) {
    // Skip doc files — we're looking for code→doc drift
    if (isDocFile(changedFile)) continue;

    const staleAnnotations = db
      .prepare(
        `
        SELECT a.doc_path, a.line, a.text, a.confidence, a.symbol_id,
               f_doc.last_modified AS doc_modified,
               f_code.last_modified AS code_modified
        FROM annotations a
        JOIN symbols s ON s.id = a.symbol_id
        LEFT JOIN files f_doc ON f_doc.path = a.doc_path
        LEFT JOIN files f_code ON f_code.path = s.file_path
        WHERE s.file_path = ?
          AND a.confidence >= 0.5
        ORDER BY a.confidence DESC
      `,
      )
      .all(changedFile) as Array<{
      doc_path: string;
      line: number;
      text: string;
      confidence: number;
      symbol_id: string;
      doc_modified: string | null;
      code_modified: string | null;
    }>;

    for (const ann of staleAnnotations) {
      const daysBehind = computeDaysBehind(ann.doc_modified, ann.code_modified);

      if (daysBehind !== null && daysBehind > 7) {
        const severity: CheckFinding["severity"] =
          daysBehind > 90 && ann.confidence >= 0.8
            ? "critical"
            : daysBehind > 30
              ? "warning"
              : "info";

        findings.push({
          severity,
          message:
            `${ann.doc_path} references "${ann.text}" (line ${ann.line}, confidence ${ann.confidence.toFixed(2)}) ` +
            `but was last modified ${daysBehind} days before ${changedFile}`,
          file: ann.doc_path,
          line: ann.line,
          related: [changedFile],
        });
      } else {
        // No date data available — without a timestamp comparison we cannot
        // determine whether the doc is actually stale, so cap at "info".
        // This avoids false-positive CI failures when code that docs reference
        // is touched but its API (and the doc) didn't change.
        findings.push({
          severity: "info",
          message:
            `${ann.doc_path} references "${ann.text}" (line ${ann.line}, confidence ${ann.confidence.toFixed(2)}) ` +
            `— verify after changes to ${changedFile}`,
          file: ann.doc_path,
          line: ann.line,
          related: [changedFile],
        });
      }
    }
  }

  // ── 2. Co-change partners missing from PR ──────────────────
  const changedSet = new Set(changed);

  for (const changedFile of changed) {
    const cochangePartners = db
      .prepare(
        `
        SELECT file_a, file_b, count, jaccard
        FROM co_changes
        WHERE (file_a = ? OR file_b = ?)
          AND jaccard >= 0.3
        ORDER BY jaccard DESC
        LIMIT 10
      `,
      )
      .all(changedFile, changedFile) as Array<{
      file_a: string;
      file_b: string;
      count: number;
      jaccard: number;
    }>;

    for (const partner of cochangePartners) {
      const otherFile =
        partner.file_a === changedFile ? partner.file_b : partner.file_a;

      if (!changedSet.has(otherFile)) {
        findings.push({
          // Co-change analysis is advisory — it never has enough context to
          // determine whether the absence of a partner file is a mistake.
          // Keep it as "info" so it surfaces in PR comments but does not
          // block CI.
          severity: "info",
          message:
            `${changedFile} co-changes with ${otherFile} ` +
            `(jaccard=${partner.jaccard.toFixed(2)}, ${partner.count} commits) ` +
            `but ${otherFile} is not in this PR — intentional?`,
          file: changedFile,
          related: [otherFile],
        });
      }
    }
  }

  // ── 3. Changed doc files — check if referenced code also changed ──
  for (const changedFile of changed) {
    if (!isDocFile(changedFile)) continue;

    const referencedCode = db
      .prepare(
        `
        SELECT DISTINCT s.file_path, s.name, a.confidence
        FROM annotations a
        JOIN symbols s ON s.id = a.symbol_id
        WHERE a.doc_path = ?
          AND a.confidence >= 0.5
        ORDER BY a.confidence DESC
        LIMIT 20
      `,
      )
      .all(changedFile) as Array<{
      file_path: string;
      name: string;
      confidence: number;
    }>;

    for (const ref of referencedCode) {
      if (!changedSet.has(ref.file_path)) {
        // Only flag if the code file is a hotspot (likely to need updates)
        const fileInfo = db
          .prepare(`SELECT is_hotspot FROM files WHERE path = ?`)
          .get(ref.file_path) as { is_hotspot: number } | undefined;

        if (fileInfo?.is_hotspot) {
          findings.push({
            severity: "info",
            message:
              `Doc ${changedFile} references ${ref.name} in ${ref.file_path} (hotspot) ` +
              `— but code file is not in this PR`,
            file: changedFile,
            related: [ref.file_path],
          });
        }
      }
    }
  }

  // Apply severity filter
  const severityOrder = { info: 0, warning: 1, critical: 2 };
  const minLevel = severityOrder[minSeverity];
  const filtered = findings.filter(
    (f) => severityOrder[f.severity] >= minLevel,
  );

  // Determine exit code
  const hasWarning = filtered.some((f) => f.severity === "warning");
  const hasCritical = filtered.some((f) => f.severity === "critical");
  const exitCode = hasCritical ? 2 : hasWarning ? 1 : 0;

  return { findings: filtered, exitCode };
}

/**
 * Format check results for different outputs.
 */
export function formatCheck(
  result: CheckResult,
  format: "text" | "json" | "github",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  if (format === "github") {
    return result.findings
      .map((f) => {
        const level =
          f.severity === "critical"
            ? "error"
            : f.severity === "warning"
              ? "warning"
              : "notice";
        const lineArg = f.line ? `,line=${f.line}` : "";
        return `::${level} file=${f.file}${lineArg}::${f.message}`;
      })
      .join("\n");
  }

  // text format
  const icons = { info: "ℹ", warning: "⚠", critical: "✗" };
  return result.findings
    .map(
      (f) =>
        `${icons[f.severity]} ${f.message}` +
        (f.related.length > 0 ? `\n   related: ${f.related.join(", ")}` : ""),
    )
    .join("\n\n");
}

// =============================================================================
// Helpers
// =============================================================================

function isDocFile(filePath: string): boolean {
  return /\.(md|mdx|rst|txt|adoc)$/i.test(filePath);
}

function computeDaysBehind(
  docModified: string | null,
  codeModified: string | null,
): number | null {
  if (!docModified || !codeModified) return null;
  const docDate = new Date(docModified).getTime();
  const codeDate = new Date(codeModified).getTime();
  if (isNaN(docDate) || isNaN(codeDate)) return null;
  const diffMs = codeDate - docDate;
  return diffMs > 0 ? Math.round(diffMs / (1000 * 60 * 60 * 24)) : null;
}
