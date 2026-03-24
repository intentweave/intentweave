// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * STL Stage — Staleness Detection
 *
 * Identifies documentation files that are significantly older than
 * their related code files, using git commit dates (not filesystem mtime).
 *
 * Doc↔code matching:
 *   1. Same directory (sibling files)
 *   2. Path-like strings in the doc content
 *   3. KWG entity names matching file names (when available)
 *
 * @see PHASE-B-SPEC.md §8
 * @version 0.1
 */

import type {
  StlStageInput,
  StlStageOutput,
  StalenessSignal,
  TcxStageOutput,
} from "@intentweave/core";
import { TCG_SCHEMAS } from "@intentweave/core";
import * as path from "node:path";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MIN_STALENESS_DAYS = 14;

/** File extensions recognized as documentation */
const DOC_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".adoc",
  ".asciidoc",
]);

// =============================================================================
// runStlStage
// =============================================================================

export function runStlStage(input: StlStageInput): StlStageOutput {
  const startMs = Date.now();
  const {
    tcxOutput,
    kwgEntities,
    workspaceRoot,
    minStalenessDays = DEFAULT_MIN_STALENESS_DAYS,
    log,
  } = input;

  // ── Build file → lastModified index from git commits ───────────────
  const fileLastModified = buildFileLastModified(tcxOutput);

  // ── Classify files as doc or code ──────────────────────────────────
  const docFiles: string[] = [];
  const codeFiles: string[] = [];

  for (const fp of tcxOutput.filePaths) {
    if (isDocFile(fp)) {
      docFiles.push(fp);
    } else {
      codeFiles.push(fp);
    }
  }

  log?.(
    `STL: ${docFiles.length} doc files, ${codeFiles.length} code files tracked in git`,
  );

  // ── Build code-file lookup structures ──────────────────────────────
  // Directory → code files index
  const dirToCodeFiles = new Map<string, string[]>();
  for (const fp of codeFiles) {
    const dir = path.dirname(fp);
    let list = dirToCodeFiles.get(dir);
    if (!list) {
      list = [];
      dirToCodeFiles.set(dir, list);
    }
    list.push(fp);
  }

  // Base name → code file path (for entity name matching)
  const nameToCodeFile = new Map<string, string>();
  for (const fp of codeFiles) {
    const base = path.basename(fp).replace(/\.[^.]+$/, ""); // strip extension
    const lower = base.toLowerCase();
    // Only store first match (prefer shorter paths)
    if (!nameToCodeFile.has(lower)) {
      nameToCodeFile.set(lower, fp);
    }
  }

  // KWG entity → code file matches (slug-based)
  const entityToCodeFiles = new Map<string, string[]>();
  if (kwgEntities) {
    for (const entity of kwgEntities) {
      const slug = toSlug(entity);
      for (const [name, fp] of nameToCodeFile) {
        if (name === slug || name.includes(slug) || slug.includes(name)) {
          let list = entityToCodeFiles.get(entity);
          if (!list) {
            list = [];
            entityToCodeFiles.set(entity, list);
          }
          list.push(fp);
        }
      }
    }
  }

  // ── Compute staleness for each doc file ────────────────────────────
  const signals: StalenessSignal[] = [];
  const now = Date.now();

  for (const docFp of docFiles) {
    const docDate = fileLastModified.get(docFp);
    if (!docDate) continue;

    const docMs = new Date(docDate).getTime();
    const docDaysSince = (now - docMs) / (1000 * 60 * 60 * 24);

    // Find related code files
    const relatedCodeFiles = findRelatedCodeFiles(
      docFp,
      dirToCodeFiles,
      nameToCodeFile,
      entityToCodeFiles,
    );

    if (relatedCodeFiles.length === 0) continue;

    // Find fresher related files
    const fresherFiles: StalenessSignal["fresherRelatedFiles"] = [];

    for (const codeFp of relatedCodeFiles) {
      const codeDate = fileLastModified.get(codeFp);
      if (!codeDate) continue;

      const codeMs = new Date(codeDate).getTime();
      if (codeMs > docMs) {
        fresherFiles.push({
          filePath: codeFp,
          lastModified: codeDate,
          daysSinceModified:
            Math.round(((now - codeMs) / (1000 * 60 * 60 * 24)) * 10) / 10,
        });
      }
    }

    if (fresherFiles.length === 0) continue;

    // Staleness = max(code_mtime) - doc_mtime in days
    const freshestCodeMs = Math.max(
      ...fresherFiles.map((f) => new Date(f.lastModified).getTime()),
    );
    const stalenessScore =
      Math.round(
        ((freshestCodeMs - docMs) / (1000 * 60 * 60 * 24)) * 10,
      ) / 10;

    if (stalenessScore < minStalenessDays) continue;

    // Classify severity
    let severity: StalenessSignal["severity"];
    if (stalenessScore >= 90) {
      severity = "critical";
    } else if (stalenessScore >= 30) {
      severity = "warning";
    } else {
      severity = "info";
    }

    signals.push({
      filePath: docFp,
      lastModified: docDate,
      daysSinceModified: Math.round(docDaysSince * 10) / 10,
      fresherRelatedFiles: fresherFiles.sort(
        (a, b) => a.daysSinceModified - b.daysSinceModified,
      ),
      stalenessScore,
      severity,
    });
  }

  // Sort by staleness descending (most stale first)
  signals.sort((a, b) => b.stalenessScore - a.stalenessScore);

  log?.(
    `STL: ${signals.length} stale signals (${signals.filter((s) => s.severity === "critical").length} critical, ${signals.filter((s) => s.severity === "warning").length} warning)`,
  );

  const durationMs = Date.now() - startMs;

  return {
    $schema: TCG_SCHEMAS.stl,
    stage: "STL",
    signals,
    meta: {
      signalCount: signals.length,
      docsAnalyzed: docFiles.length,
      codeFilesAnalyzed: codeFiles.length,
      processingTimeMs: durationMs,
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build a map of filePath → lastModified date from commit data.
 */
function buildFileLastModified(
  tcx: TcxStageOutput,
): Map<string, string> {
  const result = new Map<string, string>();

  for (const commit of tcx.commits) {
    for (const file of commit.files) {
      const existing = result.get(file.filePath);
      if (!existing || commit.date > existing) {
        result.set(file.filePath, commit.date);
      }
    }
  }

  return result;
}

/**
 * Determine if a file is a documentation file by extension.
 */
function isDocFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return DOC_EXTENSIONS.has(ext);
}

/**
 * Find code files related to a given doc file.
 *
 * Strategies (OR — union of all matches):
 *   1. Same directory siblings
 *   2. Parent directory code files (e.g., `docs/README.md` → `src/...`)
 *   3. File name matching (e.g., `auth.md` → `auth.ts`)
 */
function findRelatedCodeFiles(
  docFp: string,
  dirToCodeFiles: Map<string, string[]>,
  nameToCodeFile: Map<string, string>,
  entityToCodeFiles: Map<string, string[]>,
): string[] {
  const related = new Set<string>();

  // Strategy 1: Same directory
  const dir = path.dirname(docFp);
  const siblings = dirToCodeFiles.get(dir);
  if (siblings) {
    for (const s of siblings) related.add(s);
  }

  // Strategy 2: Parent directory (common: `docs/` alongside `src/`)
  const parentDir = path.dirname(dir);
  if (parentDir !== dir) {
    // Look in sibling directories of parent
    for (const [d, files] of dirToCodeFiles) {
      if (d.startsWith(parentDir) && d !== dir) {
        for (const f of files) related.add(f);
      }
    }
  }

  // Strategy 3: doc file name → code file name
  const docBase = path
    .basename(docFp)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  if (docBase !== "readme" && docBase !== "changelog" && docBase !== "index") {
    const match = nameToCodeFile.get(docBase);
    if (match) related.add(match);
  }

  // Strategy 4: KWG entity matches (if available)
  for (const [_entity, files] of entityToCodeFiles) {
    for (const f of files) related.add(f);
  }

  return Array.from(related);
}

/**
 * Normalize a name to a slug (lowercase, strip special chars).
 */
function toSlug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2") // camelCase → camel-case
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/gi, "")
    .toLowerCase();
}
