// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

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
  runClaimsExplain,
  runClaimsReview,
} from "./claims.js";
import { runIntentCheck } from "./intentCheck.js";

describe("G5 Architecture Dependency Git slice", () => {
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
        env: { ...process.env, IW_SESSION: "g5-architecture-slice" },
      },
    );
  }

  function rulesYaml(
    input: { except?: string; include?: boolean } = {},
  ): string {
    if (input.include === false) return "version: 1\nrules: []\n";
    return `version: 1
rules:
  - id: no-ui-to-persistence
    description: UI modules must not access persistence directly.
    severity: high
    domain: structural
    mode: error
    forbidden:
      - type: import_pattern
        in: "src/ui/**"
        pattern: "../persistence/**"${
          input.except
            ? `
        except: "${input.except}"`
            : ""
        }
`;
  }

  function writeArchitecturePolicy(workspace: string, enabled: boolean): void {
    mkdirSync(path.join(workspace, ".iw", "claims"), { recursive: true });
    writeFileSync(
      path.join(workspace, ".iw", "claims", "state.yaml"),
      `schemaVersion: "1"
policies:
  explicit-architecture-rule:
    version: "1"
    enabled: ${enabled}
    configuration: {}
candidateDecisions: {}
subjectBindings: {}
assessmentReviews: {}
baselineAcceptances: {}
`,
    );
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
  ): {
    normalized_status: string;
    normalized_output_json: string;
    normalized_reasons_json: string;
  } {
    return database
      .prepare(
        `SELECT rule.normalized_status, rule.normalized_output_json,
                rule.normalized_reasons_json
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
      normalized_output_json: string;
      normalized_reasons_json: string;
    };
  }

  async function promoteArchitectureCandidate(
    log: ReturnType<typeof vi.spyOn>,
  ): Promise<{ candidateId: string; claimIdentityId: string }> {
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsDiscover({ all: true, format: "json" });
    const discovery = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{
        id: string;
        proposedClaimType: string;
        sourceKinds: string[];
      }>;
    };
    const candidate = discovery.candidates.find(
      (item) => item.proposedClaimType === "CLM-DEPENDENCY-CONFORMANCE",
    );
    expect(candidate).toMatchObject({
      sourceKinds: [
        "architecture-import-inventory",
        "architecture-rule-check",
        "architecture-rule-definition",
      ],
    });
    await runClaimsCandidatesTriage({
      candidate: candidate!.id,
      format: "json",
    });
    const triage = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string }>;
    };
    await runClaimsCandidateReview({
      candidate: triage.candidates[0]!.id,
      actor: "g5-reviewer",
      decision: "promote",
      rationale: "The UI-to-persistence boundary is repository policy",
      format: "json",
    });
    const promotion = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      assessment: { claimIdentityId: string };
      review: { candidate: { id: string } };
    };
    return {
      candidateId: promotion.review.candidate.id,
      claimIdentityId: promotion.assessment.claimIdentityId,
    };
  }

  async function acceptClaim(claimIdentityId: string): Promise<void> {
    process.exitCode = undefined;
    await runClaimsReview({
      claim: claimIdentityId,
      actor: "g5-reviewer",
      decision: "accepted",
      rationale: "Accepted by the deterministic G5 fixture",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
  }

  async function intentCheck(
    input: {
      rulesOnly?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    process.exitCode = undefined;
    await runIntentCheck({
      config: ".iw/rules.yaml",
      severity: "low",
      limit: "100",
      format: "json",
      ...input,
    });
    const serialized = vi.mocked(console.log).mock.calls.at(-1)?.[0];
    if (serialized === undefined) {
      throw new Error(
        `Intent check produced no output: ${String(vi.mocked(console.error).mock.calls.at(-1)?.[0])}`,
      );
    }
    return JSON.parse(String(serialized)) as Record<string, unknown>;
  }

  it("runs A0-A5 through rulesCheck Evidence, lifecycle, --since, and Explain", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-g5-architecture-git-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"), { recursive: true });
    mkdirSync(path.join(workspace, "src/ui"), { recursive: true });
    mkdirSync(path.join(workspace, "src/service"), { recursive: true });
    mkdirSync(path.join(workspace, "src/persistence"), { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), ".iw/index.db*\n");
    writeFileSync(
      path.join(workspace, "README.md"),
      "# G5 Architecture Fixture\n",
    );
    writeFileSync(path.join(workspace, ".iw/rules.yaml"), rulesYaml());
    writeFileSync(
      path.join(workspace, "src/service/api.ts"),
      "export const fetchUsers = (): string[] => [];\n",
    );
    writeFileSync(
      path.join(workspace, "src/persistence/db.ts"),
      "export const loadUsers = (): string[] => [];\n",
    );
    writeFileSync(
      path.join(workspace, "src/ui/view.ts"),
      'import { fetchUsers } from "../service/api";\nexport const render = fetchUsers;\n',
    );
    writeFileSync(
      path.join(workspace, "src/ui/empty.ts"),
      "// This current source file has no imports or symbols.\n",
    );
    git(workspace, "init");
    git(workspace, "config", "user.email", "claims@example.test");
    git(workspace, "config", "user.name", "Claims Test");
    const a0 = commit(workspace, "A0 conformant architecture");
    buildIndex(workspace);

    process.chdir(workspace);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a0Intent = (await intentCheck()) as {
      claims: { gateStatus: string };
      rules: { result: { totalViolations: number } };
      summary: { exitCode: number };
    };
    expect(a0Intent).toMatchObject({
      claims: { gateStatus: "not_evaluated" },
      rules: { result: { totalViolations: 0 } },
      summary: { exitCode: 0 },
    });
    const promoted = await promoteArchitectureCandidate(log);
    let database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      currentAssessment(database, promoted.claimIdentityId).epistemic_status,
    ).toBe("supported");
    const supportedRule = currentRule(database, promoted.claimIdentityId);
    expect(supportedRule).toMatchObject({
      normalized_status: "passed",
      normalized_reasons_json: JSON.stringify(["dependency-policy-conformant"]),
    });
    expect(JSON.parse(supportedRule.normalized_output_json)).toMatchObject({
      complete: true,
      scopeFileCount: 2,
      violationCount: 0,
    });
    expect(
      database
        .prepare(
          `SELECT link.subject_role, subject.kind, subject.display_name
           FROM claim_subjects link
           JOIN subject_identities subject ON subject.id = link.subject_identity_id
           WHERE link.claim_identity_id = ? ORDER BY link.subject_role`,
        )
        .all(promoted.claimIdentityId),
    ).toEqual([
      { subject_role: "source", kind: "module", display_name: "src/ui/**" },
      {
        subject_role: "target",
        kind: "module",
        display_name: "../persistence/**",
      },
    ]);
    database.close();
    await acceptClaim(promoted.claimIdentityId);

    renameSync(
      path.join(workspace, "src/ui/view.ts"),
      path.join(workspace, "src/ui/dashboard.ts"),
    );
    const a1 = commit(workspace, "A1 source file rename only");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: a0, format: "json" });
    expect(process.exitCode).toBe(0);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM review_decision_reopens
           WHERE claim_identity_id = ? AND status = 'open'`,
        )
        .get(promoted.claimIdentityId),
    ).toEqual({ count: 0 });
    database.close();

    writeFileSync(
      path.join(workspace, "src/ui/dashboard.ts"),
      'import { loadUsers } from "../persistence/db";\nexport const render = loadUsers;\n',
    );
    const a2 = commit(workspace, "A2 forbidden dependency introduced");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: a1, format: "json" });
    expect(process.exitCode).toBe(1);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      currentAssessment(database, promoted.claimIdentityId).epistemic_status,
    ).toBe("refuted");
    const failedRule = currentRule(database, promoted.claimIdentityId);
    expect(failedRule).toMatchObject({
      normalized_status: "failed",
      normalized_reasons_json: JSON.stringify([
        "forbidden-dependency-detected",
      ]),
    });
    expect(JSON.parse(failedRule.normalized_output_json)).toMatchObject({
      architectureRuleId: "no-ui-to-persistence",
      source: "src/ui/**",
      target: "../persistence/**",
      violationCount: 1,
      violations: [
        expect.objectContaining({
          filePath: "src/ui/dashboard.ts",
          detail: expect.stringContaining("../persistence/db"),
        }),
      ],
    });
    expect(
      database
        .prepare(
          `SELECT reason, status FROM review_decision_reopens
           WHERE claim_identity_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(promoted.claimIdentityId),
    ).toEqual({ reason: "warrant-changed", status: "open" });
    database.close();

    log.mockClear();
    const rawA2 = (await intentCheck({ rulesOnly: true })) as {
      rules: { result: { totalViolations: number } };
      claims: { gateStatus: string };
    };
    expect(rawA2).toMatchObject({
      rules: { result: { totalViolations: 1 } },
      claims: { gateStatus: "not_evaluated" },
    });
    log.mockClear();
    const unifiedA2 = (await intentCheck()) as {
      rules: {
        result: { totalViolations: number };
        suppressedDuplicateViolations: number;
      };
      claims: {
        governedArchitectureViolations: Array<{
          claimIdentityId: string;
          violation: { detail: string };
        }>;
      };
      summary: { exitCode: number };
    };
    expect(unifiedA2).toMatchObject({
      rules: {
        result: { totalViolations: 0 },
        suppressedDuplicateViolations: 1,
      },
      claims: {
        governedArchitectureViolations: [
          {
            claimIdentityId: promoted.claimIdentityId,
            violation: {
              detail: expect.stringContaining("../persistence/db"),
            },
          },
        ],
      },
      summary: { exitCode: 1 },
    });

    log.mockClear();
    process.exitCode = undefined;
    await runIntentCheck({
      config: ".iw/rules.yaml",
      severity: "low",
      limit: "100",
      format: "text",
    });
    const unifiedText = String(log.mock.calls.at(-1)?.[0]);
    const violationDetail = "import of `../persistence/db`";
    expect(unifiedText.split(violationDetail)).toHaveLength(2);
    expect(unifiedText).toContain("Rules gate: passed");
    expect(unifiedText).toContain("Claims gate: failed");
    expect(unifiedText).toContain(`Claim: ${promoted.claimIdentityId}`);

    log.mockClear();
    await runClaimsExplain({ claim: promoted.candidateId, format: "json" });
    const explanation = JSON.parse(
      String(log.mock.calls.at(-1)?.[0]),
    ) as Array<{
      claimIdentityId: string;
      dependencies: Array<{
        rule_status: string;
        rule_output: { violationCount: number };
        rule_reasons: string[];
      }>;
    }>;
    expect(explanation[0]).toMatchObject({
      claimIdentityId: promoted.claimIdentityId,
      dependencies: [
        {
          rule_status: "failed",
          rule_output: { violationCount: 1 },
          rule_reasons: ["forbidden-dependency-detected"],
        },
      ],
    });
    await acceptClaim(promoted.claimIdentityId);

    writeFileSync(
      path.join(workspace, "src/ui/dashboard.ts"),
      'import { fetchUsers } from "../service/api";\nexport const render = fetchUsers;\n',
    );
    const a3 = commit(workspace, "A3 forbidden dependency removed");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: a2, format: "json" });
    expect(process.exitCode).toBe(4);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      currentAssessment(database, promoted.claimIdentityId).epistemic_status,
    ).toBe("supported");
    expect(
      currentRule(database, promoted.claimIdentityId).normalized_status,
    ).toBe("passed");
    database.close();
    await acceptClaim(promoted.claimIdentityId);

    writeFileSync(
      path.join(workspace, ".iw/rules.yaml"),
      rulesYaml({ except: "src/ui/**" }),
    );
    const a4 = commit(workspace, "A4 architecture scope excludes all files");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: a3, format: "json" });
    expect(process.exitCode).toBe(2);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      currentAssessment(database, promoted.claimIdentityId).epistemic_status,
    ).toBe("inconclusive");
    expect(currentRule(database, promoted.claimIdentityId)).toMatchObject({
      normalized_status: "inconclusive",
      normalized_reasons_json: JSON.stringify([
        "architecture-rule-scope-not-applicable",
      ]),
    });
    database.close();

    writeFileSync(
      path.join(workspace, ".iw/rules.yaml"),
      rulesYaml({ include: false }),
    );
    commit(workspace, "A5 architecture policy removed");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: a4, format: "json" });
    expect(process.exitCode).toBe(2);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      currentAssessment(database, promoted.claimIdentityId).epistemic_status,
    ).toBe("inconclusive");
    expect(currentRule(database, promoted.claimIdentityId)).toMatchObject({
      normalized_status: "not_applicable",
      normalized_reasons_json: JSON.stringify([
        "architecture-policy-no-longer-present",
      ]),
    });
    expect(
      database
        .prepare(
          `SELECT status FROM review_decision_reopens
           WHERE claim_identity_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(promoted.claimIdentityId),
    ).toEqual({ status: "open" });
    database.close();
  }, 120_000);

  it("applies explicit-architecture-rule@1 only when enabled and remains idempotent", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-g5-architecture-policy-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"), { recursive: true });
    mkdirSync(path.join(workspace, "src/ui"), { recursive: true });
    writeFileSync(path.join(workspace, ".iw/rules.yaml"), rulesYaml());
    writeFileSync(path.join(workspace, "README.md"), "# Policy fixture\n");
    writeFileSync(
      path.join(workspace, "src/ui/view.ts"),
      "export const render = (): string => 'ok';\n",
    );
    git(workspace, "init");
    git(workspace, "config", "user.email", "claims@example.test");
    git(workspace, "config", "user.name", "Claims Test");
    commit(workspace, "P0 static architecture rule");
    buildIndex(workspace);
    process.chdir(workspace);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    writeArchitecturePolicy(workspace, false);
    await runClaimsDiscover({ all: true, format: "json" });
    let database = new Database(path.join(workspace, ".iw/index.db"));
    expect(
      database
        .prepare(
          `SELECT state FROM claim_candidates
           WHERE candidate_kind = 'architecture-dependency-conformance'
           ORDER BY version_ordinal DESC LIMIT 1`,
        )
        .get(),
    ).toEqual({ state: "correlated" });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM claim_identities`).get(),
    ).toEqual({ count: 0 });
    database.close();

    writeArchitecturePolicy(workspace, true);
    log.mockClear();
    await runClaimsDiscover({ all: true, format: "json" });
    await runClaimsDiscover({ all: true, format: "json" });
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    const decision = database
      .prepare(
        `SELECT decision.policy_id, decision.policy_version,
                decision.promoted_claim_identity_id, decision.provenance_json,
                candidate.observation_fingerprint
         FROM candidate_policy_decisions decision
         JOIN claim_candidates candidate ON candidate.id = decision.candidate_id
         WHERE decision.policy_id = 'explicit-architecture-rule'`,
      )
      .get() as {
      policy_id: string;
      policy_version: string;
      promoted_claim_identity_id: string;
      provenance_json: string;
      observation_fingerprint: string;
    };
    expect(decision).toMatchObject({
      policy_id: "explicit-architecture-rule",
      policy_version: "1",
      promoted_claim_identity_id: expect.stringMatching(/^claim:/),
    });
    expect(JSON.parse(decision.provenance_json)).toMatchObject({
      architectureRuleId: "no-ui-to-persistence",
      candidateFingerprint: decision.observation_fingerprint,
      ruleContract: {
        adapterId: "cari-architecture-dependency-conformance",
        version: "1",
      },
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM candidate_policy_decisions
           WHERE policy_id = 'explicit-architecture-rule'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  }, 120_000);
});
