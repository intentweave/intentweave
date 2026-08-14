// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

export class ClaimsGitError extends Error {}

export interface GitRename {
  fromPath: string;
  toPath: string;
  similarity: number;
}

function git(workspaceRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new ClaimsGitError(`git ${args.join(" ")} failed: ${message}`);
  }
}

/** Immutable Git anchors and content reads for Claims continuity evaluation. */
export class ClaimsGit {
  constructor(private readonly workspaceRoot: string) {}

  resolveCommit(revision: string): string {
    return git(this.workspaceRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
  }

  head(): string {
    return this.resolveCommit("HEAD");
  }

  mergeBase(reference: string): string {
    return git(this.workspaceRoot, ["merge-base", "HEAD", reference]);
  }

  changedPaths(fromRevision: string, toRevision: string): string[] {
    const output = git(this.workspaceRoot, [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      fromRevision,
      toRevision,
    ]);
    return output ? output.split("\n").filter(Boolean).sort() : [];
  }

  renames(fromRevision: string, toRevision: string): GitRename[] {
    const output = git(this.workspaceRoot, [
      "diff",
      "--name-status",
      "-M",
      fromRevision,
      toRevision,
    ]);
    return output
      .split("\n")
      .flatMap((line) => {
        const [status, fromPath, toPath] = line.split("\t");
        const match = status?.match(/^R(\d+)$/);
        if (!match || !fromPath || !toPath) return [];
        return [{ fromPath, toPath, similarity: Number(match[1]) }];
      })
      .sort((left, right) => left.toPath.localeCompare(right.toPath));
  }

  listFiles(revision: string): string[] {
    const output = git(this.workspaceRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      revision,
    ]);
    return output ? output.split("\n").filter(Boolean).sort() : [];
  }

  show(revision: string, filePath: string): string | undefined {
    try {
      return git(this.workspaceRoot, ["show", `${revision}:${filePath}`]);
    } catch (error) {
      if (
        error instanceof ClaimsGitError &&
        (error.message.includes("does not exist") || error.message.includes("exists on disk"))
      ) {
        return undefined;
      }
      throw error;
    }
  }
}
