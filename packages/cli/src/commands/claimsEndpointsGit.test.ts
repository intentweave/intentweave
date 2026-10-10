// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  runClaimsExplain,
  runClaimsReview,
} from "./claims.js";

describe("G4 NestJS Endpoint Git slice", () => {
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
        env: { ...process.env, IW_SESSION: "g4-endpoint-slice" },
      },
    );
  }

  function primaryRoute(input: {
    handler?: string;
    guard?: boolean;
    auth?: "required" | "public";
  }): string {
    const auth = input.auth ?? "required";
    const guard = input.guard === false ? "" : "  @UseGuards(AuthGuard)\n";
    return `  /**
   * Creates an administrator.
   * @auth ${auth}
   */
  @Post("users")
${guard}  ${input.handler ?? "createUser"}(): void {}
`;
  }

  function controllerSource(input: {
    primary?: string;
    dynamic?: boolean;
    publicHealth?: boolean;
  }): string {
    const dynamic = input.dynamic
      ? `  /** @auth required */
  @Post(ADMIN_ROUTE)
  @UseGuards(AuthGuard)
  dynamicAdmin(): void {}
`
      : "";
    const publicHealth = input.publicHealth
      ? `  @Get("health")
  @Public()
  health(): void {}
`
      : "";
    return `import {
  Controller,
  Get,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { Public } from "./public.decorator";

const ADMIN_ROUTE = "dynamic";

@Controller("admin")
export class AdminController {
${input.primary ?? ""}${dynamic}${publicHealth}}
`;
  }

  function currentAssessment(
    database: Database.Database,
    claimIdentityId: string,
  ): { id: string; epistemic_status: string } {
    return database
      .prepare(
        `SELECT assessment.id, assessment.epistemic_status
         FROM claim_assessments assessment
         JOIN claim_versions version ON version.id = assessment.claim_version_id
         WHERE version.claim_identity_id = ? AND assessment.is_current = 1`,
      )
      .get(claimIdentityId) as { id: string; epistemic_status: string };
  }

  function currentRule(
    database: Database.Database,
    claimIdentityId: string,
  ): { normalized_status: string; normalized_reasons_json: string } {
    return database
      .prepare(
        `SELECT rule.normalized_status, rule.normalized_reasons_json
         FROM claim_assessments assessment
         JOIN claim_versions version ON version.id = assessment.claim_version_id
         JOIN claim_assessment_dependencies dependency
           ON dependency.claim_assessment_id = assessment.id
         JOIN rule_result_versions rule ON rule.id = dependency.dependency_version_id
         WHERE version.claim_identity_id = ? AND assessment.is_current = 1
           AND dependency.dependency_kind = 'rule_result_version'`,
      )
      .get(claimIdentityId) as {
      normalized_status: string;
      normalized_reasons_json: string;
    };
  }

  async function promoteCandidate(
    log: ReturnType<typeof vi.spyOn>,
    identityIncludes: string,
  ): Promise<{ candidateId: string; claimIdentityId: string; status: string }> {
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsDiscover({ all: true, format: "json" });
    const discovery = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{
        id: string;
        identityKey: string;
        proposedClaimType: string;
      }>;
    };
    const candidate = discovery.candidates.find(
      (item) =>
        item.proposedClaimType === "CLM-ENDPOINT-AUTHENTICATED" &&
        item.identityKey.includes(identityIncludes),
    );
    expect(candidate).toBeDefined();
    await runClaimsCandidatesTriage({
      candidate: candidate!.id,
      format: "json",
    });
    const triage = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string }>;
    };
    await runClaimsCandidateReview({
      candidate: triage.candidates[0]!.id,
      actor: "g4-reviewer",
      decision: "promote",
      rationale: "Endpoint authentication is an explicit repository contract",
      format: "json",
    });
    const promotion = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      assessment: {
        claimIdentityId: string;
      };
      review: { candidate: { id: string } };
    };
    const database = new Database(path.join(process.cwd(), ".iw/index.db"), {
      readonly: true,
    });
    const status = currentAssessment(
      database,
      promotion.assessment.claimIdentityId,
    ).epistemic_status;
    database.close();
    return {
      candidateId: promotion.review.candidate.id,
      claimIdentityId: promotion.assessment.claimIdentityId,
      status,
    };
  }

  async function acceptClaim(claimIdentityId: string): Promise<void> {
    process.exitCode = undefined;
    await runClaimsReview({
      claim: claimIdentityId,
      actor: "g4-reviewer",
      decision: "accepted",
      rationale: "Accepted by the deterministic G4 fixture",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
  }

  it("runs E0-E6 through NestJS discovery, lifecycle, --since, and Explain", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-g4-endpoint-git-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), ".iw/\n");
    writeFileSync(path.join(workspace, "README.md"), "# G4 Endpoint Fixture\n");
    writeFileSync(
      path.join(workspace, "src/auth.guard.ts"),
      "export class AuthGuard {}\n",
    );
    writeFileSync(
      path.join(workspace, "src/admin.controller.ts"),
      controllerSource({ primary: primaryRoute({}) }),
    );
    git(workspace, "init");
    git(workspace, "config", "user.email", "claims@example.test");
    git(workspace, "config", "user.name", "Claims Test");
    const e0 = commit(workspace, "E0 protected endpoint");
    buildIndex(workspace);

    process.chdir(workspace);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const primary = await promoteCandidate(log, "POST:/admin/users");
    expect(primary.status).toBe("supported");
    await acceptClaim(primary.claimIdentityId);
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    expect(process.exitCode).toBe(0);

    writeFileSync(
      path.join(workspace, "src/admin.controller.ts"),
      controllerSource({
        primary: primaryRoute({ handler: "registerUser" }),
      }),
    );
    const e1 = commit(workspace, "E1 handler rename only");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: e0, format: "json" });
    expect(process.exitCode).toBe(0);
    let database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM claim_identities
           WHERE claim_type = 'CLM-ENDPOINT-AUTHENTICATED'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT carried_forward_from_decision_id
           FROM review_decisions
           WHERE claim_identity_id = ? AND is_current = 1`,
        )
        .get(primary.claimIdentityId),
    ).toEqual({
      carried_forward_from_decision_id: expect.stringMatching(/^review:/),
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM evidence_identities
           WHERE source_kind = 'framework-configuration'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT basis, confidence FROM subject_continuity
           WHERE basis = 'stable-nestjs-endpoint-route'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(),
    ).toEqual({
      basis: "stable-nestjs-endpoint-route",
      confidence: "certain",
    });
    database.close();

    writeFileSync(
      path.join(workspace, "src/admin.controller.ts"),
      controllerSource({
        primary: primaryRoute({ handler: "registerUser", guard: false }),
      }),
    );
    const e2 = commit(workspace, "E2 authentication Guard removed");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: e1, format: "json" });
    expect(process.exitCode).toBe(1);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      currentAssessment(database, primary.claimIdentityId).epistemic_status,
    ).toBe("refuted");
    expect(currentRule(database, primary.claimIdentityId)).toMatchObject({
      normalized_status: "failed",
      normalized_reasons_json: JSON.stringify([
        "required-endpoint-authentication-guard-missing",
      ]),
    });
    expect(
      database
        .prepare(
          `SELECT reason, status FROM review_decision_reopens
           WHERE claim_identity_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(primary.claimIdentityId),
    ).toEqual({ reason: "warrant-changed", status: "open" });
    database.close();
    await acceptClaim(primary.claimIdentityId);

    writeFileSync(
      path.join(workspace, "src/admin.controller.ts"),
      controllerSource({
        primary: primaryRoute({ handler: "registerUser", guard: false }),
        dynamic: true,
      }),
    );
    commit(workspace, "E3 dynamic route path");
    buildIndex(workspace);
    const dynamic = await promoteCandidate(
      log,
      "POST:/unknown/AdminController.dynamicAdmin",
    );
    expect(dynamic.status).toBe("inconclusive");
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      currentRule(database, dynamic.claimIdentityId).normalized_status,
    ).toBe("inconclusive");
    database.close();

    writeFileSync(
      path.join(workspace, "src/admin.controller.ts"),
      controllerSource({
        primary: primaryRoute({ handler: "registerUser", guard: false }),
        dynamic: true,
        publicHealth: true,
      }),
    );
    commit(workspace, "E4 explicitly public route");
    buildIndex(workspace);
    const publicRoute = await promoteCandidate(log, "GET:/admin/health");
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      currentRule(database, publicRoute.claimIdentityId).normalized_status,
    ).toBe("not_applicable");
    database.close();

    writeFileSync(
      path.join(workspace, "src/admin.controller.ts"),
      controllerSource({
        primary: primaryRoute({ handler: "registerUser", auth: "public" }),
        dynamic: true,
        publicHealth: true,
      }),
    );
    const e5 = commit(workspace, "E5 documentation contradicts Guard");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: e2, format: "json" });
    expect(process.exitCode).toBe(1);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(currentRule(database, primary.claimIdentityId)).toMatchObject({
      normalized_status: "failed",
      normalized_reasons_json: JSON.stringify([
        "endpoint-security-contract-contradiction",
      ]),
    });
    database.close();

    log.mockClear();
    await runClaimsExplain({ claim: primary.candidateId, format: "json" });
    const explanation = JSON.parse(
      String(log.mock.calls.at(-1)?.[0]),
    ) as Array<{
      claimIdentityId: string;
      dependencies: Array<{
        rule_status: string;
        rule_output: {
          method: string;
          path: string;
          handler: string;
          guards: string[];
          documentationRequirement: string;
        };
        rule_reasons: string[];
      }>;
      reopens: Array<{ reason: string; status: string }>;
    }>;
    expect(explanation[0]).toMatchObject({
      claimIdentityId: primary.claimIdentityId,
      dependencies: [
        {
          rule_status: "failed",
          rule_output: {
            method: "POST",
            path: "/admin/users",
            handler: "registerUser",
            guards: ["AuthGuard"],
            documentationRequirement: "public",
          },
          rule_reasons: ["endpoint-security-contract-contradiction"],
        },
      ],
      reopens: expect.arrayContaining([
        expect.objectContaining({ reason: "warrant-changed", status: "open" }),
      ]),
    });

    writeFileSync(
      path.join(workspace, "src/admin.controller.ts"),
      controllerSource({ dynamic: true, publicHealth: true }),
    );
    commit(workspace, "E6 route deleted");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: e5, format: "json" });
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(currentRule(database, primary.claimIdentityId)).toMatchObject({
      normalized_status: "not_applicable",
      normalized_reasons_json: JSON.stringify([
        "endpoint-route-no-longer-present",
      ]),
    });
    expect(
      database
        .prepare(
          `SELECT status FROM review_decision_reopens
           WHERE claim_identity_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(primary.claimIdentityId),
    ).toEqual({ status: "open" });
    database.close();
  }, 120_000);
});
