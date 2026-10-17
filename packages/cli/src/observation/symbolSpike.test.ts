// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "@intentweave/sqlite-compat";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildChangeSet,
  captureSymbolRun,
  gitRenames,
  openSpikeStore,
  predictImpact,
  symbolIdentityKey,
} from "./symbolSpike.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const workspaces: string[] = [];

afterAll(() => {
  for (const workspace of workspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf-8",
  }).trim();
}

function commit(workspace: string, message: string): string {
  git(workspace, "add", "-A");
  git(workspace, "commit", "-m", message);
  return git(workspace, "rev-parse", "HEAD");
}

function indexAt(workspace: string): string {
  execFileSync(
    "tsx",
    [
      path.join(repoRoot, "packages/cli/src/cli.ts"),
      "index",
      "build",
      "--depth",
      "structured",
      "--no-native",
      ".",
    ],
    {
      cwd: workspace,
      encoding: "utf-8",
      env: { ...process.env, IW_SESSION: "tracer-spike" },
    },
  );
  return path.join(workspace, ".iw/index.db");
}

/** A consistent copy of an index database, safe to read after the build moves on. */
function snapshot(indexFile: string, target: string): string {
  const database = new Database(indexFile);
  try {
    database.exec(`VACUUM INTO '${target}'`);
  } finally {
    database.close();
  }
  return target;
}

describe("tracer spike: generic ChangeSet over public symbols", () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), "intentweave-tracer-spike-"),
  );
  workspaces.push(workspace);
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  mkdirSync(path.join(workspace, ".iw"), { recursive: true });
  writeFileSync(path.join(workspace, ".gitignore"), ".iw/\n");
  writeFileSync(path.join(workspace, "README.md"), "# Tracer fixture\n");
  git(workspace, "init");
  git(workspace, "config", "user.email", "spike@example.test");
  git(workspace, "config", "user.name", "Spike Test");

  writeFileSync(
    path.join(workspace, "src/billing.ts"),
    `/** Charges the amount. */
export function charge(amount: number): void {
  void amount;
}

/** Refunds an identifier. */
export function refund(id: string): void {
  void id;
}

export function pick(value: string): string;
export function pick(value: number): number;
export function pick(value: string | number): string | number {
  return value;
}
`,
  );
  const revA = commit(workspace, "A: baseline");
  const storePath = path.join(workspace, ".iw/spike.db");
  const store = openSpikeStore(storePath);
  const indexA = indexAt(workspace);
  const snapA = snapshot(indexA, path.join(workspace, ".iw/snap-a.db"));
  const runA = captureSymbolRun(store, indexA, revA, true);

  writeFileSync(
    path.join(workspace, "src/billing.ts"),
    `/** Charges the amount. */
export function charge(amount: number, currency: string): void {
  void amount;
  void currency;
}

/** Refunds an identifier. */
export function refund(id: string): void {
  void id;
}

export function pick(value: string): string;
export function pick(value: number): number;
export function pick(value: string | number): string | number {
  return value;
}
`,
  );
  const revB = commit(workspace, "B: signature change");
  const indexB = indexAt(workspace);
  const snapB = snapshot(indexB, path.join(workspace, ".iw/snap-b.db"));
  const runB = captureSymbolRun(store, indexB, revB, true);

  git(workspace, "mv", "src/billing.ts", "src/payments-billing.ts");
  const revC = commit(workspace, "C: move file");
  const indexC = indexAt(workspace);
  const snapC = snapshot(indexC, path.join(workspace, ".iw/snap-c.db"));
  const runC = captureSymbolRun(store, indexC, revC, true);

  writeFileSync(
    path.join(workspace, "src/payments-billing.ts"),
    `/** Charges the amount. */
export function charge(amount: number, currency: string): void {
  void amount;
  void currency;
}
`,
  );
  const revD = commit(workspace, "D: remove refund and overloads");
  const indexD = indexAt(workspace);
  const runD = captureSymbolRun(store, indexD, revD, true);
  const runDPartial = captureSymbolRun(store, indexD, revD, false);

  it("captures every public symbol under a unique identity, even with overloads", () => {
    const keys = (
      store
        .prepare(
          `SELECT identity_key FROM spike_observations
           WHERE run_id = ? AND name = 'pick'`,
        )
        .all(runA) as Array<{ identity_key: string }>
    ).map((row) => row.identity_key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports a signature change as property-changed on the same identity", () => {
    const items = buildChangeSet(
      store,
      runA,
      runB,
      gitRenames(workspace, revA, revB),
    );
    const signature = items.filter((item) => item.kind === "property-changed");
    expect(signature).toEqual([
      expect.objectContaining({
        kind: "property-changed",
        identityKey: symbolIdentityKey("function", "src/billing.ts", "charge"),
        changedProperties: ["signature"],
      }),
    ]);
  });

  it("reports a file move as moved with the successor identity, not as removed and added", () => {
    const items = buildChangeSet(
      store,
      runB,
      runC,
      gitRenames(workspace, revB, revC),
    );
    const moved = items.filter((item) => item.kind === "moved");
    expect(moved.map((item) => item.identityKey)).toEqual(
      expect.arrayContaining([
        symbolIdentityKey("function", "src/billing.ts", "charge"),
        symbolIdentityKey("function", "src/billing.ts", "refund"),
      ]),
    );
    expect(moved.every((item) => item.successorIdentityKey !== undefined)).toBe(
      true,
    );
    expect(
      items.some((item) => item.kind === "added" || item.kind === "removed"),
    ).toBe(false);
  });

  it("reports a removal only for complete coverage", () => {
    const complete = buildChangeSet(
      store,
      runC,
      runD,
      gitRenames(workspace, revC, revD),
    );
    expect(complete).toContainEqual(
      expect.objectContaining({
        kind: "removed",
        identityKey: symbolIdentityKey(
          "function",
          "src/payments-billing.ts",
          "refund",
        ),
        basis: "complete-coverage",
      }),
    );
    const partial = buildChangeSet(
      store,
      runC,
      runDPartial,
      gitRenames(workspace, revC, revD),
    );
    expect(partial.some((item) => item.kind === "removed")).toBe(false);
    expect(partial.some((item) => item.kind === "not_comparable")).toBe(true);
  });

  it("produces the same ChangeSet whichever store captured the runs, in reverse capture order", () => {
    const reversePath = path.join(workspace, ".iw/spike-reverse.db");
    const reverse = openSpikeStore(reversePath);
    // Capture the same index snapshots in the opposite order.
    const runC2 = captureSymbolRun(reverse, snapC, revC, true);
    const runB2 = captureSymbolRun(reverse, snapB, revB, true);
    const renames = gitRenames(workspace, revB, revC);
    const forward = buildChangeSet(store, runB, runC, renames);
    const backward = buildChangeSet(reverse, runB2, runC2, renames);
    expect(backward).toEqual(forward);
    expect(runB2).toBe(runB);
    expect(runC2).toBe(runC);
    expect(snapA).toBeTruthy();
  });

  it("reports ambiguous rename matches as continuity-unclear, never as moved", () => {
    const ambiguousStore = openSpikeStore(
      path.join(workspace, ".iw/spike-ambiguous.db"),
    );
    const insert = ambiguousStore.prepare(
      `INSERT INTO spike_observations
         (run_id, identity_key, cari_id, name, kind, file_path, line, payload_json, payload_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ambiguousStore
      .prepare(
        "INSERT INTO spike_runs (id, revision, complete, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("base", "r1", 1, 0);
    ambiguousStore
      .prepare(
        "INSERT INTO spike_runs (id, revision, complete, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("head", "r2", 1, 0);
    const payload = JSON.stringify({ duplicateOf: 2 });
    for (const ordinal of [1, 2]) {
      insert.run(
        "base",
        `symbol:function:a.ts#f~${ordinal}`,
        `cari-${ordinal}`,
        "f",
        "function",
        "a.ts",
        ordinal,
        payload,
        "fp",
      );
    }
    for (const ordinal of [1, 2]) {
      insert.run(
        "head",
        `symbol:function:b.ts#f~${ordinal}`,
        `cari-h${ordinal}`,
        "f",
        "function",
        "b.ts",
        ordinal,
        payload,
        "fp",
      );
    }
    const items = buildChangeSet(
      ambiguousStore,
      "base",
      "head",
      new Map([["a.ts", "b.ts"]]),
    );
    expect(items.map((item) => item.kind)).toEqual([
      "continuity-unclear",
      "continuity-unclear",
      "continuity-unclear",
      "continuity-unclear",
    ]);
    expect(items.some((item) => item.kind === "moved")).toBe(false);
  });

  it("predicts reopen for a signature change on a Claim Subject and carry-forward for a move", () => {
    const signature = buildChangeSet(
      store,
      runA,
      runB,
      gitRenames(workspace, revA, revB),
    );
    const charge = symbolIdentityKey("function", "src/billing.ts", "charge");
    expect(predictImpact(signature, new Set([charge])).reopen).toEqual([
      charge,
    ]);

    const moved = buildChangeSet(
      store,
      runB,
      runC,
      gitRenames(workspace, revB, revC),
    );
    const prediction = predictImpact(moved, new Set([charge]));
    expect(prediction.reopen).toEqual([]);
    expect(prediction.carryForward).toEqual([charge]);
  });
});
