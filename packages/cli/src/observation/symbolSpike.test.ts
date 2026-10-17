// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildChangeSet,
  captureSymbolRun,
  gitRenames,
  openSpikeStore,
  predictImpact,
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

describe("tracer spike: generic ChangeSet over public symbols", () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), "intentweave-tracer-spike-"),
  );
  workspaces.push(workspace);
  mkdirSync(path.join(workspace, "src"), { recursive: true });
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
`,
  );
  const revA = commit(workspace, "A: baseline");
  const storePath = path.join(workspace, "spike.db");
  const store = openSpikeStore(storePath);
  const runA = captureSymbolRun(store, indexAt(workspace), revA, true);

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
`,
  );
  const revB = commit(workspace, "B: signature change");
  const runB = captureSymbolRun(store, indexAt(workspace), revB, true);

  git(workspace, "mv", "src/billing.ts", "src/payments-billing.ts");
  const revC = commit(workspace, "C: move file");
  const runC = captureSymbolRun(store, indexAt(workspace), revC, true);

  writeFileSync(
    path.join(workspace, "src/payments-billing.ts"),
    `/** Charges the amount. */
export function charge(amount: number, currency: string): void {
  void amount;
  void currency;
}
`,
  );
  const revD = commit(workspace, "D: remove refund");
  const runD = captureSymbolRun(store, indexAt(workspace), revD, true);
  const runDPartial = captureSymbolRun(store, indexAt(workspace), revD, false);

  it("reports a signature change as property-changed on the same identity", () => {
    const items = buildChangeSet(
      store,
      runA,
      runB,
      gitRenames(workspace, revA, revB),
    );
    expect(items).toEqual([
      expect.objectContaining({
        kind: "property-changed",
        identityKey: expect.stringContaining("symbol:"),
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
    expect(items.map((item) => item.kind)).toEqual(["moved", "moved"]);
    expect(items.every((item) => item.successorIdentityKey !== undefined)).toBe(
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
    expect(complete).toEqual([
      expect.objectContaining({ kind: "removed", basis: "complete-coverage" }),
    ]);
    const partial = buildChangeSet(
      store,
      runC,
      runDPartial,
      gitRenames(workspace, revC, revD),
    );
    expect(partial.map((item) => item.kind)).toEqual(["not_comparable"]);
  });

  it("produces the same ChangeSet regardless of which run was captured first", () => {
    const renames = gitRenames(workspace, revB, revC);
    const first = buildChangeSet(store, runB, runC, renames);
    const second = buildChangeSet(store, runB, runC, renames);
    expect(second).toEqual(first);
  });

  it("predicts reopen for a signature change on a Claim Subject and carry-forward for a move", () => {
    const signature = buildChangeSet(
      store,
      runA,
      runB,
      gitRenames(workspace, revA, revB),
    );
    const subjectKeys = new Set(signature.map((item) => item.identityKey));
    expect(predictImpact(signature, subjectKeys).reopen).toHaveLength(1);

    const moved = buildChangeSet(
      store,
      runB,
      runC,
      gitRenames(workspace, revB, revC),
    );
    const movedKeys = new Set(moved.map((item) => item.identityKey));
    const prediction = predictImpact(moved, movedKeys);
    expect(prediction.reopen).toEqual([]);
    expect(prediction.carryForward).toHaveLength(2);
  });
});
