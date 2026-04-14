// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * API Surface Changelog (Backlog 5.4)
 *
 * Compares exported symbols between a git baseline ref and the current
 * CARI index to detect additions, removals, and signature changes.
 *
 * Uses git to retrieve old file content and ast-extractor to parse
 * historical symbols, then compares against the current SQLite index.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createExtractor } from "@intentweave/ast-extractor";
import { openIndex } from "@intentweave/index";
import type Database from "better-sqlite3";
import type {
  ApiSurfaceResult,
  ApiChange,
  ApiPackageSummary,
} from "@intentweave/index";

const execFileAsync = promisify(execFile);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/** Options for API surface analysis. */
export interface ApiSurfaceOptions {
  /** Git ref to compare against. Default: latest tag or HEAD~1. */
  baseline?: string;
  /** Path to index.db. */
  dbPath: string;
  /** Workspace root (for git operations). Default: cwd. */
  workspaceRoot?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function languageForExt(
  ext: string,
): "typescript" | "javascript" | "tsx" | "jsx" | null {
  switch (ext) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
      return "javascript";
    case ".jsx":
      return "jsx";
    default:
      return null;
  }
}

function inferPackage(filePath: string): string {
  const pkgMatch = filePath.match(/^packages\/([^/]+)\//);
  if (pkgMatch) return `packages/${pkgMatch[1]}`;
  const appMatch = filePath.match(/^apps\/([^/]+)\//);
  if (appMatch) return `apps/${appMatch[1]}`;
  const firstDir = filePath.split("/")[0];
  return firstDir || "(root)";
}

// ─── Git operations ──────────────────────────────────────────────────────────

async function findBaseline(cwd: string, requested?: string): Promise<string> {
  if (requested) return requested;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["describe", "--tags", "--abbrev=0"],
      { cwd },
    );
    return stdout.trim();
  } catch {
    // No tags found — fall back to previous commit
    return "HEAD~1";
  }
}

interface ChangedFiles {
  added: string[];
  deleted: string[];
  modified: string[];
}

async function getChangedFiles(
  cwd: string,
  baseline: string,
): Promise<ChangedFiles> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-status", "--diff-filter=ACDMR", baseline, "HEAD"],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );

  const added: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];

  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0];
    // For renames (R100), the new file is parts[2]
    const file = status?.startsWith("R") ? parts[2] : parts[1];
    if (!file) continue;
    const ext = path.extname(file);
    if (!CODE_EXTENSIONS.has(ext)) continue;

    switch (status?.[0]) {
      case "A":
        added.push(file);
        break;
      case "D":
        deleted.push(file);
        break;
      case "M":
      case "C":
      case "R":
        modified.push(file);
        break;
    }
  }

  return { added, deleted, modified };
}

async function getOldContent(
  cwd: string,
  baseline: string,
  filePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${baseline}:${filePath}`],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

// ─── Symbol extraction ───────────────────────────────────────────────────────

interface SymbolInfo {
  kind: string;
  signature?: string;
  line: number;
}

function extractExportedSymbols(
  extractor: ReturnType<typeof createExtractor>,
  content: string,
  filePath: string,
): Map<string, SymbolInfo> {
  const ext = path.extname(filePath);
  const language = languageForExt(ext);
  if (!language) return new Map();

  try {
    const result = extractor.extractFromString(content, filePath, language, {
      includeMembers: true,
    });

    const symbols = new Map<string, SymbolInfo>();
    for (const sym of result.symbols) {
      if (sym.isExported) {
        symbols.set(`${sym.kind}:${sym.name}`, {
          kind: sym.kind,
          signature: sym.signature,
          line: sym.range.startLine,
        });
      }
    }
    return symbols;
  } catch {
    // Skip files that fail to parse (generated code, encoding issues, etc.)
    return new Map();
  }
}

function getCurrentExportedSymbols(
  db: Database.Database,
  filePath: string,
): Map<string, SymbolInfo> {
  const rows = db
    .prepare(
      `SELECT name, kind, signature, line
       FROM symbols
       WHERE file_path = ? AND export = 'exported'`,
    )
    .all(filePath) as Array<{
    name: string;
    kind: string;
    signature: string | null;
    line: number;
  }>;

  const symbols = new Map<string, SymbolInfo>();
  for (const row of rows) {
    symbols.set(`${row.kind}:${row.name}`, {
      kind: row.kind,
      signature: row.signature ?? undefined,
      line: row.line,
    });
  }
  return symbols;
}

// ─── Main analysis ───────────────────────────────────────────────────────────

/**
 * Analyse API surface changes between a git baseline and the current index.
 */
export async function analyzeApiSurface(
  options: ApiSurfaceOptions,
): Promise<ApiSurfaceResult> {
  const cwd = options.workspaceRoot ?? process.cwd();
  const baseline = await findBaseline(cwd, options.baseline);
  const { added, deleted, modified } = await getChangedFiles(cwd, baseline);

  const extractor = createExtractor(cwd);
  const db = openIndex(options.dbPath);

  try {
    const changes: ApiChange[] = [];

    // ── Added files: every export is new ────────────────────────────────
    for (const file of added) {
      const current = getCurrentExportedSymbols(db, file);
      for (const [key, sym] of current) {
        changes.push({
          name: key.split(":").slice(1).join(":"),
          kind: sym.kind,
          filePath: file,
          changeType: "added",
          newSignature: sym.signature,
          line: sym.line,
        });
      }
    }

    // ── Deleted files: every old export is removed ──────────────────────
    for (const file of deleted) {
      const oldContent = await getOldContent(cwd, baseline, file);
      if (!oldContent) continue;
      const oldSymbols = extractExportedSymbols(extractor, oldContent, file);
      for (const [key, sym] of oldSymbols) {
        changes.push({
          name: key.split(":").slice(1).join(":"),
          kind: sym.kind,
          filePath: file,
          changeType: "removed",
          oldSignature: sym.signature,
        });
      }
    }

    // ── Modified files: compare old vs. current ────────────────────────
    for (const file of modified) {
      const oldContent = await getOldContent(cwd, baseline, file);
      if (!oldContent) continue;

      const oldSymbols = extractExportedSymbols(extractor, oldContent, file);
      const newSymbols = getCurrentExportedSymbols(db, file);

      // New exports
      for (const [key, sym] of newSymbols) {
        if (!oldSymbols.has(key)) {
          changes.push({
            name: key.split(":").slice(1).join(":"),
            kind: sym.kind,
            filePath: file,
            changeType: "added",
            newSignature: sym.signature,
            line: sym.line,
          });
        }
      }

      // Removed exports
      for (const [key, sym] of oldSymbols) {
        if (!newSymbols.has(key)) {
          changes.push({
            name: key.split(":").slice(1).join(":"),
            kind: sym.kind,
            filePath: file,
            changeType: "removed",
            oldSignature: sym.signature,
          });
        }
      }

      // Signature changes
      for (const [key, oldSym] of oldSymbols) {
        const newSym = newSymbols.get(key);
        if (!newSym) continue;
        if (
          oldSym.signature &&
          newSym.signature &&
          oldSym.signature !== newSym.signature
        ) {
          changes.push({
            name: key.split(":").slice(1).join(":"),
            kind: newSym.kind,
            filePath: file,
            changeType: "signature-changed",
            oldSignature: oldSym.signature,
            newSignature: newSym.signature,
            line: newSym.line,
          });
        }
      }
    }

    // Sort: removed → signature-changed → added, then name
    const typeOrder: Record<string, number> = {
      removed: 0,
      "signature-changed": 1,
      added: 2,
    };
    changes.sort(
      (a, b) =>
        typeOrder[a.changeType] - typeOrder[b.changeType] ||
        a.name.localeCompare(b.name),
    );

    // Build per-package summary
    const byPackage: Record<string, ApiPackageSummary> = {};
    for (const change of changes) {
      const pkg = inferPackage(change.filePath);
      if (!byPackage[pkg])
        byPackage[pkg] = { added: 0, removed: 0, changed: 0 };
      switch (change.changeType) {
        case "added":
          byPackage[pkg].added++;
          break;
        case "removed":
          byPackage[pkg].removed++;
          break;
        case "signature-changed":
          byPackage[pkg].changed++;
          break;
      }
    }

    const summary: ApiPackageSummary = {
      added: changes.filter((c) => c.changeType === "added").length,
      removed: changes.filter((c) => c.changeType === "removed").length,
      changed: changes.filter((c) => c.changeType === "signature-changed")
        .length,
    };

    return {
      baseline,
      changes,
      summary,
      byPackage,
      filesAnalyzed: added.length + deleted.length + modified.length,
    };
  } finally {
    db.close();
  }
}
