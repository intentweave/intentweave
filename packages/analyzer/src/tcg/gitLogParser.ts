// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Git Log Parser — Phase B TCG
 *
 * Shells out to `git log` with machine-readable flags and parses the output
 * into structured `CommitRecord[]`. No libgit2, no isomorphic-git — just
 * CLI parsing.
 *
 * @see PHASE-B-SPEC.md §3
 * @version 0.1
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommitRecord, CommitFileChange } from "@intentweave/core";

const execFileAsync = promisify(execFile);

// =============================================================================
// Options
// =============================================================================

export interface GitLogOptions {
  /** Repository root (cwd for git command) */
  repoRoot: string;

  /** How many commits to include. 'full' = all history, number = last N. */
  depth: "full" | number;

  /** Include commits since this date (ISO-8601). Overrides depth. */
  since?: string;

  /** Include commits until this date (ISO-8601). Default: now. */
  until?: string;

  /** Only include commits that touch these paths (optional filter). */
  pathFilter?: string[];

  /** Logging callback. */
  log?: (msg: string) => void;
}

// =============================================================================
// Delimiters for structured parsing
// =============================================================================

const COMMIT_START = "---COMMIT_START---";
const COMMIT_END = "---COMMIT_END---";

/**
 * Format string for git log.
 *
 * Fields (in order, newline-separated):
 *   1. full hash  (%H)
 *   2. short hash (%h)
 *   3. author name (%an)
 *   4. author email (%ae)
 *   5. author date ISO-8601 (%aI)
 *   6. subject line (%s)
 */
const GIT_FORMAT = [
  COMMIT_START,
  "%H",
  "%h",
  "%an",
  "%ae",
  "%aI",
  "%s",
  COMMIT_END,
].join("%n");

// =============================================================================
// parseGitLog
// =============================================================================

/**
 * Parse git log into structured commit records.
 *
 * @throws Error if git is not found, cwd is not a git repo, or git exits non-zero.
 * @returns CommitRecord[] — may be empty if no commits in range.
 */
export async function parseGitLog(
  options: GitLogOptions,
): Promise<CommitRecord[]> {
  const { repoRoot, depth, since, until, pathFilter, log } = options;

  // ── Build git command args ───────────────────────────────────────────
  const args: string[] = [
    "log",
    `--format=${GIT_FORMAT}`,
    "--numstat",
    "--diff-filter=ACDMR",
    "-M", // detect renames
  ];

  // Depth / since
  if (since) {
    args.push(`--since=${since}`);
  } else if (depth === "full") {
    // no limit
  } else if (typeof depth === "number") {
    args.push(`-n`, `${depth}`);
  } else {
    // Default: last 6 months
    args.push("--since=6 months ago");
  }

  if (until) {
    args.push(`--until=${until}`);
  }

  // Path filter
  if (pathFilter && pathFilter.length > 0) {
    args.push("--");
    args.push(...pathFilter);
  }

  log?.(`git ${args.join(" ")}`);

  // ── Execute git ──────────────────────────────────────────────────────
  let stdout: string;
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 100 * 1024 * 1024, // 100 MB — large repos
      encoding: "utf-8",
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("ENOENT")) {
      throw new Error("git CLI not found — TCG requires git to be installed");
    }
    if (
      msg.includes("not a git repository") ||
      msg.includes("fatal: not a git")
    ) {
      throw new Error(`Not a git repository: ${repoRoot}`);
    }
    // git log with no commits returns exit 0 with empty output on most systems,
    // but some configurations may error — treat as empty
    if (msg.includes("does not have any commits")) {
      return [];
    }
    throw new Error(`git log failed: ${msg}`);
  }

  if (!stdout.trim()) {
    return [];
  }

  // ── Parse structured output ──────────────────────────────────────────
  return parseGitLogOutput(stdout);
}

// =============================================================================
// Parser internals
// =============================================================================

/**
 * Parse the raw git log output into CommitRecord[].
 *
 * The output alternates between structured commit blocks (delimited by
 * COMMIT_START/COMMIT_END) and numstat lines.
 */
export function parseGitLogOutput(raw: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  const lines = raw.split("\n");

  let i = 0;
  while (i < lines.length) {
    // Find next COMMIT_START
    if (lines[i].trim() !== COMMIT_START) {
      i++;
      continue;
    }

    // Parse commit header fields (6 fields after COMMIT_START)
    const hash = lines[++i]?.trim() ?? "";
    const shortHash = lines[++i]?.trim() ?? "";
    const authorName = lines[++i]?.trim() ?? "";
    const authorEmail = lines[++i]?.trim() ?? "";
    const date = lines[++i]?.trim() ?? "";
    const message = lines[++i]?.trim() ?? "";

    // Skip COMMIT_END
    i++;
    if (lines[i]?.trim() === COMMIT_END) {
      i++;
    }

    // Collect numstat lines until next COMMIT_START or EOF
    const files: CommitFileChange[] = [];
    while (i < lines.length && lines[i]?.trim() !== COMMIT_START) {
      const line = lines[i].trim();
      i++;

      if (!line) continue;

      const parsed = parseNumstatLine(line);
      if (parsed) {
        files.push(parsed);
      }
    }

    if (hash) {
      commits.push({
        hash,
        shortHash,
        authorName,
        authorEmail,
        date,
        message,
        files,
      });
    }
  }

  return commits;
}

/**
 * Parse a single --numstat line.
 *
 * Formats:
 *   "12\t5\tpath/to/file"          — normal change
 *   "-\t-\tpath/to/binary"         — binary file
 *   "3\t1\t{old => new}/file"      — partial rename
 *   "3\t1\told/path => new/path"   — full rename (with -M)
 *   "10\t2\tpath/to/{old.ts => new.ts}" — file rename in same dir
 */
function parseNumstatLine(line: string): CommitFileChange | null {
  // Split on tab: added \t removed \t path
  const parts = line.split("\t");
  if (parts.length < 3) return null;

  const addedStr = parts[0];
  const removedStr = parts[1];
  const pathStr = parts.slice(2).join("\t"); // path may contain tabs (rare)

  // Binary file: - \t -
  const linesAdded = addedStr === "-" ? 0 : parseInt(addedStr, 10);
  const linesRemoved = removedStr === "-" ? 0 : parseInt(removedStr, 10);

  if (isNaN(linesAdded) || isNaN(linesRemoved)) return null;

  // Detect rename: "old/path => new/path" or "{old => new}/rest"
  const renameMatch = pathStr.match(/^(.+?)\s*=>\s*(.+)$/);
  if (renameMatch) {
    const oldPath = renameMatch[1].trim();
    const newPath = renameMatch[2].trim();
    return {
      filePath: resolveRenamePath(newPath, oldPath),
      changeType: "renamed",
      linesAdded,
      linesRemoved,
      previousPath: resolveRenamePath(oldPath, newPath),
    };
  }

  // Detect brace rename: "path/{old => new}/rest" or "path/{old.ts => new.ts}"
  const braceMatch = pathStr.match(/^(.*?)\{(.+?)\s*=>\s*(.+?)\}(.*)$/);
  if (braceMatch) {
    const prefix = braceMatch[1];
    const oldPart = braceMatch[2];
    const newPart = braceMatch[3];
    const suffix = braceMatch[4];
    return {
      filePath: `${prefix}${newPart}${suffix}`,
      changeType: "renamed",
      linesAdded,
      linesRemoved,
      previousPath: `${prefix}${oldPart}${suffix}`,
    };
  }

  // Normal file change — infer changeType from stats
  // (we can't reliably distinguish add from modify from numstat alone,
  //  but --diff-filter helps: if the file was added or deleted in this
  //  specific commit, git would show it. For numstat, we approximate.)
  return {
    filePath: pathStr,
    changeType: "modified", // default — precise detection requires --name-status
    linesAdded,
    linesRemoved,
  };
}

/**
 * Resolve a rename path that may have whitespace or path fragments.
 * Removes leading/trailing whitespace and normalizes.
 */
function resolveRenamePath(path: string, _other: string): string {
  return path.replace(/^\s+|\s+$/g, "");
}
