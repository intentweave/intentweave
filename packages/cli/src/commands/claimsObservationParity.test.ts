// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tracer parity check (Phase O-T). The generic ChangeSet predicts Claim impact
 * from observed identities. The existing lifecycle decides the actual impact.
 * This test asserts that both agree on a move (carry-forward) and on a
 * signature change (reopen), using the same real commits as the G3 fixture.
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runClaimsCandidateReview,
  runClaimsCandidatesTriage,
  runClaimsCheck,
  runClaimsDiscover,
  runClaimsReview,
} from "./claims.js";
import { persistPublicSymbolCandidates } from "../claims/publicSymbolDiscovery.js";
import {
  buildChangeSet,
  captureSymbolRun,
  gitRenames,
  openSpikeStore,
  predictImpact,
} from "../observation/symbolSpike.js";

describe("tracer parity: observed ChangeSet predicts Claim impact", () => {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const workspaces: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  function repoRoot(): string {
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../",
    );
  }

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
        path.join(repoRoot(), "packages", "cli", "src", "cli.ts"),
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
        env: { ...process.env, IW_SESSION: "tracer-parity" },
      },
    );
  }

  function parseConfigSource(parameters: string): string {
    return `/**
 * Parses configuration.
 * @returns the normalized configuration
 */
export function parseConfig(${parameters}): string {
  const normalized = source.trim();
  if (normalized.length === 0) {
    return source;
  }
  return normalized;
}
`;
  }

  async function acceptClaim(claimIdentityId: string): Promise<void> {
    await runClaimsReview({
      claim: claimIdentityId,
      actor: "tracer-reviewer",
      decision: "accepted",
      rationale: "Tracer parity baseline",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
  }

  function reopenReasons(workspace: string, claimIdentityId: string): string[] {
    const database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    try {
      return (
        database
          .prepare(
            `SELECT reason FROM review_decision_reopens
             WHERE claim_identity_id = ? AND status = 'open'`,
          )
          .all(claimIdentityId) as Array<{ reason: string }>
      ).map((row) => row.reason);
    } finally {
      database.close();
    }
  }

  it("predicts carry-forward for a move and reopen for a signature change, as the lifecycle does", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-tracer-parity-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), ".iw/\n");
    writeFileSync(path.join(workspace, "README.md"), "# Tracer parity\n");
    writeFileSync(
      path.join(workspace, "src/config.ts"),
      parseConfigSource("source: string"),
    );
    git(workspace, "init");
    git(workspace, "config", "user.email", "claims@example.test");
    git(workspace, "config", "user.name", "Claims Test");
    const revS0 = commit(workspace, "S0 documented public symbol");
    buildIndex(workspace);

    const store = openSpikeStore(
      path.join(workspace, ".iw/observation-spike.db"),
    );
    const runS0 = captureSymbolRun(
      store,
      path.join(workspace, ".iw/index.db"),
      revS0,
      true,
    );

    process.chdir(workspace);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runClaimsDiscover({ all: true, format: "json" });
    const discovered = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{
        id: string;
        proposedClaimType: string;
        confidence: string;
      }>;
    };
    const candidate = discovered.candidates.find(
      (item) =>
        item.proposedClaimType === "CLM-PUBLIC-SYMBOL-DOCUMENTED" &&
        item.confidence === "certain",
    );
    expect(candidate).toBeDefined();
    await runClaimsCandidatesTriage({
      candidate: candidate!.id,
      format: "json",
    });
    const triaged = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string }>;
    };
    await runClaimsCandidateReview({
      candidate: triaged.candidates[0]!.id,
      actor: "tracer-reviewer",
      decision: "promote",
      rationale: "Public API documentation is a repository contract",
      format: "json",
    });
    const promotion = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      assessment: { claimIdentityId: string };
    };
    const claimIdentityId = promotion.assessment.claimIdentityId;
    await acceptClaim(claimIdentityId);
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    expect(process.exitCode).toBe(0);

    // Claim Subject: the documented symbol at S0, as observed in the spike.
    const claimSubjects = (runId: string): Set<string> => {
      const observed = store
        .prepare(
          `SELECT identity_key FROM spike_observations
           WHERE run_id = ? AND name = 'parseConfig'`,
        )
        .all(runId) as Array<{ identity_key: string }>;
      return new Set(observed.map((row) => row.identity_key));
    };

    // S1: move only. Predicted carry-forward, actual: accepted Review stays.
    mkdirSync(path.join(workspace, "src/settings"), { recursive: true });
    renameSync(
      path.join(workspace, "src/config.ts"),
      path.join(workspace, "src/settings/config.ts"),
    );
    const revS1 = commit(workspace, "S1 move only");
    buildIndex(workspace);
    const runS1 = captureSymbolRun(
      store,
      path.join(workspace, ".iw/index.db"),
      revS1,
      true,
    );
    const moveItems = buildChangeSet(
      store,
      runS0,
      runS1,
      gitRenames(workspace, revS0, revS1),
    );
    const movePrediction = predictImpact(moveItems, claimSubjects(runS0));
    // Same protocol as the G3 Git fixture: discovery at S1, then check since S0.
    const afterMove = new Database(path.join(workspace, ".iw/index.db"));
    persistPublicSymbolCandidates(afterMove, revS1);
    afterMove.close();
    process.exitCode = undefined;
    await runClaimsCheck({ since: revS0, format: "json" });
    expect(movePrediction.reopen).toEqual([]);
    expect(movePrediction.carryForward).toHaveLength(1);
    expect(process.exitCode).toBe(0);
    expect(reopenReasons(workspace, claimIdentityId)).toEqual([]);

    // S2: signature change. Predicted reopen, actual: warrant-changed reopen.
    writeFileSync(
      path.join(workspace, "src/settings/config.ts"),
      parseConfigSource("source: string, strict: boolean"),
    );
    const revS2 = commit(workspace, "S2 signature changed");
    buildIndex(workspace);
    const runS2 = captureSymbolRun(
      store,
      path.join(workspace, ".iw/index.db"),
      revS2,
      true,
    );
    const signatureItems = buildChangeSet(
      store,
      runS1,
      runS2,
      gitRenames(workspace, revS1, revS2),
    );
    const signaturePrediction = predictImpact(
      signatureItems,
      claimSubjects(runS1),
    );
    process.exitCode = undefined;
    await runClaimsCheck({ since: revS1, format: "json" });
    expect(signaturePrediction.reopen).toHaveLength(1);
    expect(signaturePrediction.carryForward).toEqual([]);
    expect(process.exitCode).toBe(4);
    expect(reopenReasons(workspace, claimIdentityId)).toEqual([
      "warrant-changed",
    ]);
  });
});
