// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Intent Anchors (G5.4 slice 1) through the real CLI. A protected Claim keeps its
 * statement. A changed statement is an intent_conflict, which fails the check only in
 * gate mode. Mode off leaves the check output untouched.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runClaimsConflictResolve,
  runClaimsCandidateReview,
  runClaimsCandidatesTriage,
  runClaimsCheck,
  runClaimsDiscover,
  runClaimsReview,
} from "./claims.js";

const SOURCE = `/**
 * Parses configuration.
 * @returns the normalized configuration
 */
export function parseConfig(source: string): string {
  return source.trim();
}
`;

describe("Intent Anchors through claims check", () => {
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

  function git(workspace: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
  }

  function buildIndex(workspace: string): void {
    const cli = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/cli/src/cli.ts",
    );
    execFileSync(
      "tsx",
      [cli, "index", "build", "--depth", "structured", "--no-native", "."],
      {
        cwd: workspace,
        encoding: "utf-8",
        env: { ...process.env, IW_SESSION: "intent-anchors" },
      },
    );
  }

  /** Promote and accept the documented symbol, then protect it. */
  async function protectedWorkspace(): Promise<{
    workspace: string;
    claimIdentityId: string;
    log: ReturnType<typeof vi.spyOn>;
  }> {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-anchor-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), ".iw/\n");
    writeFileSync(path.join(workspace, "README.md"), "# Anchors\n");
    writeFileSync(path.join(workspace, "src/config.ts"), SOURCE);
    git(workspace, "init");
    git(workspace, "config", "user.email", "claims@example.test");
    git(workspace, "config", "user.name", "Claims Test");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-m", "S0 documented public symbol");
    buildIndex(workspace);

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
      actor: "intent-anchors",
      decision: "promote",
      rationale: "Public API documentation is a repository contract",
      format: "json",
    });
    const promotion = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      assessment: { claimIdentityId: string };
    };
    const claimIdentityId = promotion.assessment.claimIdentityId;
    await runClaimsReview({
      claim: claimIdentityId,
      actor: "intent-anchors",
      decision: "accepted",
      purpose: "protect",
      rationale: "Protected intent",
      format: "json",
    });
    return { workspace, claimIdentityId, log };
  }

  /**
   * Remove the documentation of the protected symbol, which is what its Claim asserts
   * ("the public symbol is documented"), and rebuild the index.
   */
  function changeStatement(workspace: string): void {
    writeFileSync(
      path.join(workspace, "src/config.ts"),
      SOURCE.replace(/\/\*\*[\s\S]*?\*\/\n/, ""),
    );
    git(workspace, "add", "-A");
    git(workspace, "commit", "-m", "S1 change to the protected symbol");
    buildIndex(workspace);
  }

  function setIntentMode(
    workspace: string,
    mode: "off" | "report" | "gate",
  ): void {
    mkdirSync(path.join(workspace, ".iw/claims"), { recursive: true });
    writeFileSync(
      path.join(workspace, ".iw/claims/intent.yaml"),
      `schemaVersion: "1"\nmode: ${mode}\n`,
    );
  }

  it("protects the Claim and reports satisfied while the statement is unchanged", async () => {
    const { workspace, log } = await protectedWorkspace();
    setIntentMode(workspace, "report");
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      intentAnchors?: Array<{ outcome: string }>;
    };
    expect(output.intentAnchors?.map((anchor) => anchor.outcome)).toEqual([
      "satisfied",
    ]);
  });

  it("reports intent_conflict in report mode without failing the check", async () => {
    const { workspace, log } = await protectedWorkspace();
    changeStatement(workspace);
    setIntentMode(workspace, "report");
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      intentAnchors?: Array<{ outcome: string }>;
    };
    expect(output.intentAnchors?.map((anchor) => anchor.outcome)).toContain(
      "intent_conflict",
    );
  });

  it("fails the check with intent_conflict in gate mode", async () => {
    const { workspace, log } = await protectedWorkspace();
    changeStatement(workspace);
    setIntentMode(workspace, "gate");
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      intentAnchors?: Array<{ outcome: string }>;
    };
    expect(output.intentAnchors?.map((anchor) => anchor.outcome)).toContain(
      "intent_conflict",
    );
    expect(process.exitCode).toBe(1);
  });

  it("omits anchor output entirely when the mode is off", async () => {
    const { workspace, log } = await protectedWorkspace();
    changeStatement(workspace);
    setIntentMode(workspace, "off");
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      intentAnchors?: unknown;
      intentMode?: unknown;
    };
    expect(output.intentAnchors).toBeUndefined();
    expect(output.intentMode).toBeUndefined();
  });

  it("refuses an unknown conflict decision", async () => {
    const { claimIdentityId } = await protectedWorkspace();
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runClaimsConflictResolve({
      claim: claimIdentityId,
      decision: "forget_it",
      actor: "intent-anchors",
      format: "json",
    });
    expect(process.exitCode).toBe(64);
    expect(String(errors.mock.calls[0]?.[0])).toContain("reject_change");
  });

  it("does not authorize a declared follow-up without a change set", async () => {
    const { workspace, claimIdentityId, log } = await protectedWorkspace();
    changeStatement(workspace);
    setIntentMode(workspace, "gate");
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    const judged = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      intentAnchors?: Array<{ currentStatementFingerprint?: string }>;
    };
    const fingerprintNow =
      judged.intentAnchors?.[0]?.currentStatementFingerprint;
    mkdirSync(path.join(workspace, ".iw/claims"), { recursive: true });
    writeFileSync(
      path.join(workspace, ".iw/claims/intent.yaml"),
      `schemaVersion: "1"\nmode: gate\nfollowUps:\n  - claimIdentityId: ${claimIdentityId}\n    statementFingerprint: ${fingerprintNow}\n`,
    );
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      intentFollowUpBasis?: string;
      intentFollowUpNote?: string;
      intentAnchors?: Array<{ outcome: string }>;
    };
    expect(output.intentFollowUpBasis).toBe("unavailable");
    expect(output.intentFollowUpNote).toContain("--since");
    expect(output.intentAnchors?.map((anchor) => anchor.outcome)).toEqual([
      "intent_conflict",
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a second protect without recording a review or replacing the anchor", async () => {
    const { workspace, claimIdentityId, log } = await protectedWorkspace();
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runClaimsReview({
      claim: claimIdentityId,
      actor: "automation",
      decision: "accepted",
      purpose: "protect",
      rationale: "second protection attempt",
      format: "json",
    });
    expect(process.exitCode).toBe(64);
    expect(String(errors.mock.calls[0]?.[0])).toContain("already protected");
    // The original anchor still protects the Claim: an unchanged statement is satisfied.
    setIntentMode(workspace, "report");
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      intentAnchors?: Array<{ outcome: string }>;
    };
    expect(output.intentAnchors?.map((anchor) => anchor.outcome)).toEqual([
      "satisfied",
    ]);
  });

  it("refuses to amend a Claim whose current assessment is not supported", async () => {
    const { workspace, claimIdentityId } = await protectedWorkspace();
    changeStatement(workspace);
    // Only a check re-evaluates the Claim, so run it before deciding on an amendment.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runClaimsConflictResolve({
      claim: claimIdentityId,
      decision: "accept_amendment",
      actor: "intent-anchors",
      format: "json",
    });
    expect(process.exitCode).toBe(64);
    expect(String(errors.mock.calls[0]?.[0])).toContain(
      "amend only a supported Claim",
    );
  });
});
