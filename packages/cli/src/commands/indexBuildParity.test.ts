// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "@intentweave/sqlite-compat";
import { initSchema } from "@intentweave/index";

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
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  writeFileSync(
    path.join(workspace, "docs", "session.md"),
    `The default application timeout is 1800 seconds.
`,
  );
  writeFileSync(
    path.join(workspace, "src", "session.ts"),
    `export const SESSION_TIMEOUT = 1800;

export function sessionTimeout(): number {
  return SESSION_TIMEOUT;
}
`,
  );
  writeFileSync(
    path.join(workspace, "src", "server.ts"),
    `import { sessionTimeout } from "./session";

export function startServer(): number {
  return sessionTimeout();
}
`,
  );
  git(workspace, "init");
  git(workspace, "config", "user.email", "claims@example.test");
  git(workspace, "config", "user.name", "Claims Test");
  git(workspace, "add", ".");
  git(workspace, "commit", "-m", "fixture baseline");
}

function runIndexBuild(
  workspace: string,
  useNative: boolean,
  env: NodeJS.ProcessEnv = {},
): { stdout: string; durationMs: number } {
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
      ...env,
      IW_SESSION: useNative ? "parity-native" : "parity-ts",
    },
  });
  return { stdout, durationMs: performance.now() - start };
}

function summarizeIndex(
  dbPath: string,
): Record<string, { count: number; values?: string[] }> {
  const db = new Database(dbPath);
  try {
    const tables = {
      symbols: `SELECT id FROM symbols ORDER BY id`,
      exportedFunctions: `SELECT file_path || ':' || name AS value
              FROM symbols
                          WHERE kind = 'function' AND (export = 1 OR export = 'exported')
              ORDER BY file_path, name`,
      annotations: `SELECT id FROM annotations ORDER BY id`,
      imports: `SELECT id FROM imports ORDER BY id`,
      files: `SELECT path FROM files ORDER BY path`,
      coOccurrences: `SELECT rowid FROM co_occurrences ORDER BY rowid`,
      coChanges: `SELECT rowid FROM co_changes ORDER BY rowid`,
    } as const;
    const summary: Record<string, { count: number; values?: string[] }> = {};
    for (const [name, query] of Object.entries(tables)) {
      const rows = db.prepare(query).all() as Array<Record<string, unknown>>;
      summary[name] =
        name === "files" || name === "symbols" || name === "exportedFunctions"
          ? {
              count: rows.length,
              values: rows.map((row) =>
                String(
                  name === "files"
                    ? row.path
                    : name === "exportedFunctions"
                      ? row.value
                      : row.id,
                ),
              ),
            }
          : { count: rows.length };
    }
    return summary;
  } finally {
    db.close();
  }
}

describe("index build native vs ts parity", () => {
  it("agrees on indexed files and exported functions for native and TypeScript builds", () => {
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
    expect(nativeSummary.exportedFunctions).toEqual(tsSummary.exportedFunctions);
    expect(nativeSummary.exportedFunctions.values).toEqual([
      "src/server.ts:startServer",
      "src/session.ts:sessionTimeout",
    ]);
    // Native extraction also materializes the exported scalar constant.
    expect(nativeSummary.symbols.count).toBeGreaterThanOrEqual(tsSummary.symbols.count);
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

  it("preserves Claims history when the native build fails and TypeScript fallback succeeds", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-native-fallback-"));
    workspaces.push(workspace);
    writeFixture(workspace);
    const outputDb = path.join(workspace, ".iw", "native.db");
    mkdirSync(path.join(workspace, ".iw"), { recursive: true });
    const existing = new Database(outputDb);
    initSchema(existing);
    existing
      .prepare(
        `INSERT INTO parameter_identities (id, canonical_key, created_at)
         VALUES ('parameter:timeout', 'session.timeout', 1)`,
      )
      .run();
    existing.close();
    const failingNative = path.join(workspace, "failing-native.sh");
    writeFileSync(failingNative, "#!/bin/sh\nexit 17\n");
    execFileSync("chmod", ["+x", failingNative]);

    const result = runIndexBuild(workspace, true, {
      CARI_BUILD_PATH: failingNative,
    });

    expect(result.stdout).toContain("native build failed");
    expect(result.stdout).toContain("Index built");
    const preserved = new Database(outputDb);
    try {
      expect(
        preserved.prepare(`SELECT canonical_key FROM parameter_identities`).get(),
      ).toEqual({ canonical_key: "session.timeout" });
      expect(
        preserved.prepare(`SELECT COUNT(*) AS count FROM symbols`).get(),
      ).toEqual({ count: 2 });
    } finally {
      preserved.close();
    }
  });
});
