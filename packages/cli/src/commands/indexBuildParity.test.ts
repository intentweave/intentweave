// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "@intentweave/sqlite-compat";

const workspaces: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
}

function cliEntry(): string {
  return path.join(repoRoot(), "packages", "cli", "src", "cli.ts");
}

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
}

function writeFixture(workspace: string): void {
  mkdirSync(path.join(workspace, "docs"), { recursive: true });
  writeFileSync(
    path.join(workspace, "docs", "session.md"),
    `The default application timeout is 1800 seconds.
`,
  );
  git(workspace, "init");
  git(workspace, "config", "user.email", "claims@example.test");
  git(workspace, "config", "user.name", "Claims Test");
  git(workspace, "add", ".");
  git(workspace, "commit", "-m", "fixture baseline");
}

function runIndexBuild(workspace: string, useNative: boolean): { stdout: string; durationMs: number } {
  const outputDb = path.join(workspace, ".iw", useNative ? "native.db" : "ts.db");
  mkdirSync(path.join(workspace, ".iw"), { recursive: true });
  const args = [
    cliEntry(),
    "index",
    "build",
    "--depth",
    "structured",
    "-o",
    outputDb,
    ...(useNative ? [] : ["--no-native"]),
    ".",
  ];
  const start = performance.now();
  const stdout = execFileSync("tsx", args, {
    cwd: workspace,
    encoding: "utf-8",
    env: {
      ...process.env,
      IW_SESSION: useNative ? "parity-native" : "parity-ts",
    },
  });
  return { stdout, durationMs: performance.now() - start };
}

function digestRows(rows: Array<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(JSON.stringify(rows))
    .digest("hex");
}

function summarizeIndex(
  dbPath: string,
): Record<string, { count: number; paths?: string[] }> {
  const db = new Database(dbPath);
  try {
    const tables = {
      symbols: `SELECT id FROM symbols ORDER BY id`,
      annotations: `SELECT id FROM annotations ORDER BY id`,
      imports: `SELECT id FROM imports ORDER BY id`,
      files: `SELECT path FROM files ORDER BY path`,
      coOccurrences: `SELECT rowid FROM co_occurrences ORDER BY rowid`,
      coChanges: `SELECT rowid FROM co_changes ORDER BY rowid`,
    } as const;
    const summary: Record<string, { count: number; paths?: string[] }> = {};
    for (const [name, query] of Object.entries(tables)) {
      const rows = db.prepare(query).all() as Array<Record<string, unknown>>;
      summary[name] =
        name === "files"
          ? { count: rows.length, paths: rows.map((row) => String(row.path)) }
          : { count: rows.length };
    }
    return summary;
  } finally {
    db.close();
  }
}

describe("index build native vs ts parity", () => {
  it("produces the same SQLite outputs for native and TypeScript builds", () => {
    const nativeWorkspace = mkdtempSync(path.join(tmpdir(), "intentweave-parity-native-"));
    const tsWorkspace = mkdtempSync(path.join(tmpdir(), "intentweave-parity-ts-"));
    workspaces.push(nativeWorkspace, tsWorkspace);
    writeFixture(nativeWorkspace);
    writeFixture(tsWorkspace);

    const native = runIndexBuild(nativeWorkspace, true);
    const ts = runIndexBuild(tsWorkspace, false);

    expect(native.stdout).toContain("native");
    expect(ts.stdout).toContain("Index built");
    expect(ts.stdout).not.toContain("(native)");

    const nativeSummary = summarizeIndex(path.join(nativeWorkspace, ".iw", "native.db"));
    const tsSummary = summarizeIndex(path.join(tsWorkspace, ".iw", "ts.db"));

    expect(nativeSummary.files).toEqual(tsSummary.files);
    expect(nativeSummary.symbols.count).toBe(tsSummary.symbols.count);
    expect(nativeSummary.annotations.count).toBe(tsSummary.annotations.count);
    expect(nativeSummary.imports.count).toBe(tsSummary.imports.count);
    expect(nativeSummary.coOccurrences.count).toBe(tsSummary.coOccurrences.count);
    expect(nativeSummary.coChanges.count).toBe(tsSummary.coChanges.count);
    expect(native.durationMs).toBeGreaterThan(0);
    expect(ts.durationMs).toBeGreaterThan(0);

    // Lightweight benchmark smoke signal for future regression tracking.
    console.log(
      JSON.stringify(
        {
          nativeMs: Math.round(native.durationMs),
          tsMs: Math.round(ts.durationMs),
          ratio: Number((native.durationMs / ts.durationMs).toFixed(2)),
        },
        null,
        2,
      ),
    );
  });
});
