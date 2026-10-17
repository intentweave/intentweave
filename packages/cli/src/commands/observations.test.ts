// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end observation check on a Git fixture (Phase O2): capture runs, derive a
 * move, derive an ambiguous rename, and apply the continuity gate in both modes.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "@intentweave/sqlite-compat";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureObservationRun,
  checkObservations,
} from "../observation/observationCommands.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const workspaces: string[] = [];

afterAll(() => {
  for (const workspace of workspaces)
    rmSync(workspace, { recursive: true, force: true });
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

function buildIndex(workspace: string): void {
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
      env: { ...process.env, IW_SESSION: "observation-e2e" },
    },
  );
}

const BILLING = `/** Charges the amount. */
export function charge(amount: number): void {
  void amount;
}

/** Refunds an identifier. */
export function refund(id: string): void {
  void id;
}
`;

describe("observation capture and continuity check", () => {
  it("derives a move, then gates an ambiguous rename on a bridged Claim Subject", () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-observation-e2e-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    mkdirSync(path.join(workspace, ".iw", "claims"), { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), ".iw/\n");
    writeFileSync(path.join(workspace, "README.md"), "# Observation fixture\n");
    writeFileSync(path.join(workspace, "src/a.ts"), BILLING);
    git(workspace, "init");
    git(workspace, "config", "user.email", "observation@example.test");
    git(workspace, "config", "user.name", "Observation Test");
    const revA = commit(workspace, "A baseline");
    buildIndex(workspace);

    // A Claim Subject for `charge`, as a promoted symbol Claim would hold it.
    const index = new Database(path.join(workspace, ".iw/index.db"));
    const charge = index
      .prepare(
        "SELECT id FROM symbols WHERE name = 'charge' AND export IN ('exported', 1)",
      )
      .get() as { id: string };
    index
      .prepare(
        `INSERT INTO subject_identities (id, kind, identity_key, display_name, lifecycle_state, contract_version, created_at)
       VALUES ('subject-charge', 'symbol', ?, 'charge', 'active', '1', 0)`,
      )
      .run(`symbol:${charge.id}`);
    index
      .prepare(
        `INSERT INTO claim_identities (id, parameter_identity_id, claim_type, scope, identity_key, created_at)
       VALUES ('claim-charge', NULL, 'CLM-PUBLIC-SYMBOL-DOCUMENTED', NULL, 'claim-charge', 0)`,
      )
      .run();
    index
      .prepare(
        `INSERT INTO claim_subjects (claim_identity_id, subject_identity_id, subject_role, created_at)
       VALUES ('claim-charge', 'subject-charge', 'subject', 0)`,
      )
      .run();
    index.close();

    const captured = captureObservationRun(workspace);
    expect(captured.bridgedSubjects).toBe(1);
    expect(captured.coverage.symbol).toMatchObject({ status: "complete" });

    // Move: the file is renamed, the content is unchanged.
    renameSync(
      path.join(workspace, "src/a.ts"),
      path.join(workspace, "src/b.ts"),
    );
    commit(workspace, "B move");
    buildIndex(workspace);
    const moved = checkObservations(workspace, revA);
    // The file, its module, and both symbols move together.
    expect(moved.counts).toMatchObject({ moved: 4 });
    expect(moved.exitCode).toBe(0);
    expect(moved.followedBridges).toBe(1);

    // Ambiguous rename: the file is renamed and gains a second `charge` declaration,
    // so the moved symbol has two candidates and cannot be matched.
    renameSync(
      path.join(workspace, "src/b.ts"),
      path.join(workspace, "src/c.ts"),
    );
    writeFileSync(
      path.join(workspace, "src/c.ts"),
      `${BILLING}
/** Charges again. */
export function charge(amount: number, currency: string): void {
  void amount;
  void currency;
}
`,
    );
    const revC = commit(workspace, "C ambiguous rename");
    buildIndex(workspace);

    // Gate mode: the bridged Claim Subject's unresolved continuity fails the run.
    writeFileSync(
      path.join(workspace, ".iw/claims/observations.yaml"),
      'schemaVersion: "1"\ncontinuity:\n  mode: gate\n  scopes: [claim-subjects]\n',
    );
    const gated = checkObservations(workspace, revA);

    expect(gated.counts).toMatchObject({
      "continuity-unclear": expect.any(Number),
    });
    expect(gated.gate.gated.length).toBeGreaterThan(0);
    expect(gated.exitCode).toBe(1);

    // Report mode: the same unresolved continuity is listed but does not block.
    writeFileSync(
      path.join(workspace, ".iw/claims/observations.yaml"),
      'schemaVersion: "1"\ncontinuity:\n  mode: report\n  scopes: [claim-subjects]\n',
    );
    const reported = checkObservations(workspace, revA);
    expect(reported.gate.gated).toEqual([]);
    expect(reported.gate.reported.length).toBeGreaterThan(0);
    expect(reported.exitCode).toBe(0);
    expect(revC).not.toBe(revA);
  });
});
