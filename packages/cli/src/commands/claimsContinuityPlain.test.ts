// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision C negative cases for a plain `claims check` (no --since, no prior
 * discovery run). An unresolvable base revision must stay inconclusive, and a
 * symbol that was really removed must stay not_applicable.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
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

const FAKE_REVISION = "0123456789abcdef0123456789abcdef01234567";

describe("Decision C: plain claims check continuity", () => {
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
        env: { ...process.env, IW_SESSION: "decision-c" },
      },
    );
  }

  const SOURCE = `/**
 * Parses configuration.
 * @returns the normalized configuration
 */
export function parseConfig(source: string): string {
  return source.trim();
}
`;

  /** Create a workspace at S0, promote the documented symbol, and accept it. */
  async function promotedWorkspace(): Promise<{
    workspace: string;
    claimIdentityId: string;
    log: ReturnType<typeof vi.spyOn>;
  }> {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-decision-c-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), ".iw/\n");
    writeFileSync(path.join(workspace, "README.md"), "# Decision C\n");
    writeFileSync(path.join(workspace, "src/config.ts"), SOURCE);
    git(workspace, "init");
    git(workspace, "config", "user.email", "claims@example.test");
    git(workspace, "config", "user.name", "Claims Test");
    commit(workspace, "S0 documented public symbol");
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
      actor: "decision-c",
      decision: "promote",
      rationale: "Public API documentation is a repository contract",
      format: "json",
    });
    const promotion = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      assessment: { claimIdentityId: string };
    };
    await runClaimsReview({
      claim: promotion.assessment.claimIdentityId,
      actor: "decision-c",
      decision: "accepted",
      rationale: "Baseline",
      format: "json",
    });
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    expect(process.exitCode).toBe(0);
    return {
      workspace,
      claimIdentityId: promotion.assessment.claimIdentityId,
      log,
    };
  }

  function currentRuleStatuses(
    workspace: string,
    claimIdentityId: string,
  ): string[] {
    const database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    try {
      return (
        database
          .prepare(
            `SELECT rule.normalized_status AS status
             FROM claim_assessments assessment
             JOIN claim_versions version ON version.id = assessment.claim_version_id
             JOIN claim_assessment_dependencies dependency
               ON dependency.claim_assessment_id = assessment.id
             JOIN rule_result_versions rule ON rule.id = dependency.dependency_version_id
             WHERE version.claim_identity_id = ? AND assessment.is_current = 1
               AND dependency.dependency_kind = 'rule_result_version'`,
          )
          .all(claimIdentityId) as Array<{ status: string }>
      ).map((row) => row.status);
    } finally {
      database.close();
    }
  }

  it("keeps a Subject with an unresolvable base revision inconclusive, never not_applicable", async () => {
    const { workspace, claimIdentityId } = await promotedWorkspace();
    // Simulate a shallow or rewritten history: the decided revision is unknown to Git.
    const database = new Database(path.join(workspace, ".iw/index.db"));
    const rows = database
      .prepare(
        `SELECT id, provenance_json FROM claim_candidates
         WHERE discovery_adapter_id = 'cari-public-symbol-documentation'`,
      )
      .all() as Array<{ id: string; provenance_json: string }>;
    for (const row of rows) {
      const provenance = JSON.parse(row.provenance_json) as Record<
        string,
        unknown
      >;
      provenance.repositoryRevision = FAKE_REVISION;
      database
        .prepare("UPDATE claim_candidates SET provenance_json = ? WHERE id = ?")
        .run(JSON.stringify(provenance), row.id);
    }
    database.close();

    writeFileSync(
      path.join(workspace, "src/config.ts"),
      SOURCE.replace(
        "parseConfig(source: string)",
        "parseConfig(source: string, strict: boolean)",
      ),
    );
    commit(workspace, "S1 change without resolvable history");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });

    const statuses = currentRuleStatuses(workspace, claimIdentityId);
    expect(statuses).toEqual(["inconclusive"]);
    expect(process.exitCode).toBe(2);
  });

  it("keeps a really removed Subject not_applicable", async () => {
    const { workspace, claimIdentityId } = await promotedWorkspace();
    unlinkSync(path.join(workspace, "src/config.ts"));
    commit(workspace, "S1 remove the documented symbol");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });

    expect(currentRuleStatuses(workspace, claimIdentityId)).toEqual([
      "not_applicable",
    ]);
  });
});
