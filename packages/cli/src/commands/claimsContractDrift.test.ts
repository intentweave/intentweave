// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import { initSchema } from "@intentweave/index";
import type { ClaimsContractVersions } from "@intentweave/index";
import { runClaimsCheck, runClaimsReview } from "./claims.js";

const workspaces: string[] = [];
const originalCwd = process.cwd();
const originalExitCode = process.exitCode;

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

function writeC0Files(workspace: string): void {
  mkdirSync(path.join(workspace, "config"));
  mkdirSync(path.join(workspace, "docs"));
  mkdirSync(path.join(workspace, "src"));
  writeFileSync(
    path.join(workspace, "intentweave.bindings.yaml"),
    `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/session.ts
        export: SESSION_TIMEOUT
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: default-doc
            target: default
            pattern: '^The default application timeout is (?<value>\\d+) seconds\\.$'
          - id: eu-prod-override-doc
            target: effective
            scope: eu-prod
            pattern: '^The eu-prod override is (?<value>\\d+) seconds\\.$'
`,
  );
  writeFileSync(
    path.join(workspace, "config", "environments.yaml"),
    "environments:\n  - name: dev\n    capabilities: [session-runtime]\n  - name: eu-prod\n    capabilities: [session-runtime]\n",
  );
  writeFileSync(
    path.join(workspace, "config", "dev.yaml"),
    "session:\n  timeout: 1800\n",
  );
  writeFileSync(
    path.join(workspace, "config", "eu-prod.yaml"),
    "session:\n  timeout: 3600\n",
  );
  writeFileSync(
    path.join(workspace, "src", "session.ts"),
    "/**\n * @default 1800\n * @example SESSION_TIMEOUT = 7200\n */\nexport const SESSION_TIMEOUT = 1800;\n",
  );
  writeFileSync(
    path.join(workspace, "docs", "session-timeout.md"),
    "The default application timeout is 1800 seconds.\nThe eu-prod override is 3600 seconds.\n",
  );
}

async function reviewAllCurrentClaims(workspace: string): Promise<void> {
  const index = new Database(path.join(workspace, ".iw", "index.db"));
  const claims = index
    .prepare(
      `SELECT ci.id
       FROM claim_identities ci
       JOIN claim_versions cv ON cv.claim_identity_id = ci.id
       JOIN claim_assessments ca ON ca.claim_version_id = cv.id
       WHERE ca.is_current = 1
       ORDER BY ci.claim_type, ci.scope`,
    )
    .all() as Array<{ id: string }>;
  index.close();
  for (const claim of claims) {
    await runClaimsReview({
      claim: claim.id,
      actor: "reviewer",
      decision: "accepted",
      format: "json",
    });
  }
}

async function createC2Baseline(): Promise<{
  workspace: string;
  c2Revision: string;
}> {
  const workspace = mkdtempSync(
    path.join(tmpdir(), "intentweave-claims-contracts-"),
  );
  workspaces.push(workspace);
  writeC0Files(workspace);
  git(workspace, "init");
  git(workspace, "config", "user.email", "claims@example.test");
  git(workspace, "config", "user.name", "Claims Test");
  git(workspace, "add", ".");
  git(workspace, "commit", "-m", "c0 baseline");

  mkdirSync(path.join(workspace, ".iw"));
  const database = new Database(path.join(workspace, ".iw", "index.db"));
  initSchema(database);
  database.close();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  process.chdir(workspace);
  process.exitCode = undefined;

  await runClaimsCheck({ format: "json" });
  expect(process.exitCode).toBe(4);
  await reviewAllCurrentClaims(workspace);
  process.exitCode = undefined;
  await runClaimsCheck({ format: "json" });
  expect(process.exitCode).toBe(0);

  writeFileSync(path.join(workspace, "README.md"), "unrelated\n");
  writeFileSync(
    path.join(workspace, "src", "metrics.ts"),
    "export function metric(): number {\n  const metric = 1;\n  return metric;\n}\n",
  );
  git(workspace, "add", "README.md", "src/metrics.ts");
  git(workspace, "commit", "-m", "c1 unrelated");

  writeFileSync(
    path.join(workspace, "config", "eu-prod.yaml"),
    "session:\n  timeout: 5400\n",
  );
  writeFileSync(
    path.join(workspace, "docs", "session-timeout.md"),
    "The default application timeout is 1800 seconds.\nThe eu-prod override is 5400 seconds.\n",
  );
  git(workspace, "add", "config/eu-prod.yaml", "docs/session-timeout.md");
  git(workspace, "commit", "-m", "c2 consistent timeout change");
  const c2Revision = git(workspace, "rev-parse", "HEAD");
  process.exitCode = undefined;

  await runClaimsCheck({ since: "HEAD~1", format: "json" });
  expect(process.exitCode).toBe(2);
  await reviewAllCurrentClaims(workspace);
  process.exitCode = undefined;
  await runClaimsCheck({ format: "json" });
  expect(process.exitCode).toBe(0);
  return { workspace, c2Revision };
}

function evidenceVersionCount(workspace: string): number {
  const index = new Database(path.join(workspace, ".iw", "index.db"));
  const row = index
    .prepare(`SELECT COUNT(*) AS count FROM evidence_versions`)
    .get() as { count: number };
  index.close();
  return row.count;
}

function currentClaims(workspace: string): Array<{
  claim_type: string;
  scope: string | null;
  epistemic_status: string;
  statement: unknown;
  assessment_policy_id: string;
  assessment_policy_version: string;
}> {
  const index = new Database(path.join(workspace, ".iw", "index.db"));
  const rows = index
    .prepare(
      `SELECT ci.claim_type, ci.scope, ca.epistemic_status,
              cv.normalized_statement_json, cv.assessment_policy_id,
              cv.assessment_policy_version
       FROM claim_assessments ca
       JOIN claim_versions cv ON cv.id = ca.claim_version_id
       JOIN claim_identities ci ON ci.id = cv.claim_identity_id
       WHERE ca.is_current = 1
       ORDER BY ci.claim_type, ci.scope`,
    )
    .all() as Array<{
    claim_type: string;
    scope: string | null;
    epistemic_status: string;
    normalized_statement_json: string;
    assessment_policy_id: string;
    assessment_policy_version: string;
  }>;
  index.close();
  return rows.map((row) => ({
    claim_type: row.claim_type,
    scope: row.scope,
    epistemic_status: row.epistemic_status,
    statement: JSON.parse(row.normalized_statement_json),
    assessment_policy_id: row.assessment_policy_id,
    assessment_policy_version: row.assessment_policy_version,
  }));
}

function reviewState(workspace: string): {
  currentReviews: number;
  currentReviewClaims: Array<{
    claim_type: string;
    scope: string | null;
    decision_origin: string;
  }>;
  decisionOrigins: Array<{ decision_origin: string; count: number }>;
  reopens: Array<{
    claim_type: string;
    scope: string | null;
    reason: string;
    status: string;
  }>;
} {
  const index = new Database(path.join(workspace, ".iw", "index.db"));
  const currentReviews = index
    .prepare(
      `SELECT COUNT(*) AS count FROM review_decisions WHERE is_current = 1`,
    )
    .get() as { count: number };
  const currentReviewClaims = index
    .prepare(
      `SELECT ci.claim_type, ci.scope, review.decision_origin
       FROM review_decisions review
       JOIN claim_identities ci ON ci.id = review.claim_identity_id
       WHERE review.is_current = 1
       ORDER BY ci.claim_type, ci.scope`,
    )
    .all() as Array<{
    claim_type: string;
    scope: string | null;
    decision_origin: string;
  }>;
  const decisionOrigins = index
    .prepare(
      `SELECT decision_origin, COUNT(*) AS count
       FROM review_decisions
       WHERE is_current = 1
       GROUP BY decision_origin
       ORDER BY decision_origin`,
    )
    .all() as Array<{ decision_origin: string; count: number }>;
  const reopens = index
    .prepare(
      `SELECT ci.claim_type, ci.scope, reopen.reason, reopen.status
       FROM review_decision_reopens reopen
       JOIN claim_identities ci ON ci.id = reopen.claim_identity_id
       WHERE reopen.status = 'open'
       ORDER BY ci.claim_type, ci.scope, reopen.reason`,
    )
    .all() as Array<{
    claim_type: string;
    scope: string | null;
    reason: string;
    status: string;
  }>;
  index.close();
  return {
    currentReviews: currentReviews.count,
    currentReviewClaims,
    decisionOrigins,
    reopens,
  };
}

function currentRuleContracts(workspace: string): Array<{
  rule_id: string;
  scope: string | null;
  rule_contract_version: string;
  implementation_fingerprint: string;
}> {
  const index = new Database(path.join(workspace, ".iw", "index.db"));
  const rows = index
    .prepare(
      `SELECT identity.rule_id, identity.scope, result.rule_contract_version,
              result.implementation_fingerprint
       FROM rule_result_identities identity
       JOIN rule_result_versions result
         ON result.rule_result_identity_id = identity.id
       WHERE result.version_ordinal = (
         SELECT MAX(version_ordinal)
         FROM rule_result_versions
         WHERE rule_result_identity_id = identity.id
       )
       ORDER BY identity.rule_id, identity.scope`,
    )
    .all() as Array<{
    rule_id: string;
    scope: string | null;
    rule_contract_version: string;
    implementation_fingerprint: string;
  }>;
  index.close();
  return rows;
}

function expectC10OpenReviews(workspace: string): void {
  const state = reviewState(workspace);
  expect(state.currentReviews).toBe(1);
  expect(state.currentReviewClaims).toEqual([
    { claim_type: "CLM-DEFAULT", scope: null, decision_origin: "manual" },
  ]);
  expect(state.reopens).toEqual([
    {
      claim_type: "CLM-DOC-CONFORMANCE",
      scope: null,
      reason: "warrant-changed",
      status: "open",
    },
    {
      claim_type: "CLM-DOC-CONFORMANCE",
      scope: "eu-prod",
      reason: "warrant-changed",
      status: "open",
    },
    {
      claim_type: "CLM-EFFECTIVE",
      scope: "dev",
      reason: "warrant-changed",
      status: "open",
    },
    {
      claim_type: "CLM-EFFECTIVE",
      scope: "eu-prod",
      reason: "warrant-changed",
      status: "open",
    },
  ]);
}

describe("claims contract drift (C9/C10)", () => {
  it.each(["regular-first", "since-first"] as const)(
    "carries reviews forward for an R3 implementation-only change in %s order (C9)",
    async (order) => {
      const { workspace, c2Revision } = await createC2Baseline();
      const evidenceBefore = evidenceVersionCount(workspace);
      const contracts: Partial<ClaimsContractVersions> = {
        r3ImplementationFingerprint: "claims-engine-r3-v2",
      };
      process.exitCode = undefined;

      if (order === "regular-first") {
        await runClaimsCheck({ format: "json", contracts });
        expect(process.exitCode).toBe(0);
        process.exitCode = undefined;
        await runClaimsCheck({ since: c2Revision, format: "json", contracts });
      } else {
        await runClaimsCheck({ since: c2Revision, format: "json", contracts });
        expect(process.exitCode).toBe(0);
        process.exitCode = undefined;
        await runClaimsCheck({ format: "json", contracts });
      }

      expect(process.exitCode).toBe(0);
      expect(evidenceVersionCount(workspace)).toBe(evidenceBefore);
      expect(currentClaims(workspace)).toEqual([
        {
          claim_type: "CLM-DEFAULT",
          scope: null,
          epistemic_status: "supported",
          statement: { value: 1800 },
          assessment_policy_id: "default-contract",
          assessment_policy_version: "default-contract-v1",
        },
        {
          claim_type: "CLM-DOC-CONFORMANCE",
          scope: null,
          epistemic_status: "supported",
          statement: { documentedValue: 1800, effectiveValue: 1800 },
          assessment_policy_id: "documentation-conformance",
          assessment_policy_version: "documentation-conformance-v1",
        },
        {
          claim_type: "CLM-DOC-CONFORMANCE",
          scope: "eu-prod",
          epistemic_status: "supported",
          statement: { documentedValue: 5400, effectiveValue: 5400 },
          assessment_policy_id: "documentation-conformance",
          assessment_policy_version: "documentation-conformance-v1",
        },
        {
          claim_type: "CLM-EFFECTIVE",
          scope: "dev",
          epistemic_status: "supported",
          statement: { value: 1800 },
          assessment_policy_id: "runtime-resolution",
          assessment_policy_version: "runtime-resolution-v1",
        },
        {
          claim_type: "CLM-EFFECTIVE",
          scope: "eu-prod",
          epistemic_status: "supported",
          statement: { value: 5400 },
          assessment_policy_id: "runtime-resolution",
          assessment_policy_version: "runtime-resolution-v1",
        },
      ]);
      expect(reviewState(workspace)).toEqual({
        currentReviews: 5,
        currentReviewClaims: [
          { claim_type: "CLM-DEFAULT", scope: null, decision_origin: "manual" },
          {
            claim_type: "CLM-DOC-CONFORMANCE",
            scope: null,
            decision_origin: "carry-forward",
          },
          {
            claim_type: "CLM-DOC-CONFORMANCE",
            scope: "eu-prod",
            decision_origin: "carry-forward",
          },
          {
            claim_type: "CLM-EFFECTIVE",
            scope: "dev",
            decision_origin: "carry-forward",
          },
          {
            claim_type: "CLM-EFFECTIVE",
            scope: "eu-prod",
            decision_origin: "carry-forward",
          },
        ],
        decisionOrigins: [
          { decision_origin: "carry-forward", count: 4 },
          { decision_origin: "manual", count: 1 },
        ],
        reopens: [],
      });
      const ruleContracts = currentRuleContracts(workspace);
      expect(
        ruleContracts
          .filter((rule) => rule.rule_id.startsWith("R3."))
          .every(
            (rule) => rule.implementation_fingerprint === "claims-engine-r3-v2",
          ),
      ).toBe(true);
      expect(
        ruleContracts
          .filter((rule) => !rule.rule_id.startsWith("R3."))
          .every(
            (rule) => rule.implementation_fingerprint === "claims-engine-v1",
          ),
      ).toBe(true);
    },
  );

  it.each(["regular-first", "since-first"] as const)(
    "reopens semantic R3 and runtime-policy drift in %s order (C10)",
    async (order) => {
      const { workspace, c2Revision } = await createC2Baseline();
      const evidenceBefore = evidenceVersionCount(workspace);
      const contracts: Partial<ClaimsContractVersions> = {
        r3RuleContractVersion: "r3-v2",
        runtimePolicyId: "runtime-resolution-v2",
        runtimePolicyVersion: "runtime-resolution-v2",
        r3ResolutionPrecedence: "default-first",
      };
      process.exitCode = undefined;

      if (order === "regular-first") {
        await runClaimsCheck({ format: "json", contracts });
        expect(process.exitCode).toBe(1);
        expectC10OpenReviews(workspace);
        process.exitCode = undefined;
        await runClaimsCheck({ since: c2Revision, format: "json", contracts });
      } else {
        await runClaimsCheck({ since: c2Revision, format: "json", contracts });
        expect(process.exitCode).toBe(1);
        expectC10OpenReviews(workspace);
        process.exitCode = undefined;
        await runClaimsCheck({ format: "json", contracts });
      }

      expect(process.exitCode).toBe(1);
      expectC10OpenReviews(workspace);
      expect(evidenceVersionCount(workspace)).toBe(evidenceBefore);
      expect(currentClaims(workspace)).toEqual([
        {
          claim_type: "CLM-DEFAULT",
          scope: null,
          epistemic_status: "supported",
          statement: { value: 1800 },
          assessment_policy_id: "default-contract",
          assessment_policy_version: "default-contract-v1",
        },
        {
          claim_type: "CLM-DOC-CONFORMANCE",
          scope: null,
          epistemic_status: "supported",
          statement: { documentedValue: 1800, effectiveValue: 1800 },
          assessment_policy_id: "documentation-conformance",
          assessment_policy_version: "documentation-conformance-v1",
        },
        {
          claim_type: "CLM-DOC-CONFORMANCE",
          scope: "eu-prod",
          epistemic_status: "refuted",
          statement: { documentedValue: 5400, effectiveValue: 1800 },
          assessment_policy_id: "documentation-conformance",
          assessment_policy_version: "documentation-conformance-v1",
        },
        {
          claim_type: "CLM-EFFECTIVE",
          scope: "dev",
          epistemic_status: "supported",
          statement: { value: 1800 },
          assessment_policy_id: "runtime-resolution-v2",
          assessment_policy_version: "runtime-resolution-v2",
        },
        {
          claim_type: "CLM-EFFECTIVE",
          scope: "eu-prod",
          epistemic_status: "supported",
          statement: { value: 1800 },
          assessment_policy_id: "runtime-resolution-v2",
          assessment_policy_version: "runtime-resolution-v2",
        },
      ]);
      expect(reviewState(workspace)).toEqual({
        currentReviews: 1,
        currentReviewClaims: [
          { claim_type: "CLM-DEFAULT", scope: null, decision_origin: "manual" },
        ],
        decisionOrigins: [{ decision_origin: "manual", count: 1 }],
        reopens: [
          {
            claim_type: "CLM-DOC-CONFORMANCE",
            scope: null,
            reason: "warrant-changed",
            status: "open",
          },
          {
            claim_type: "CLM-DOC-CONFORMANCE",
            scope: "eu-prod",
            reason: "warrant-changed",
            status: "open",
          },
          {
            claim_type: "CLM-EFFECTIVE",
            scope: "dev",
            reason: "warrant-changed",
            status: "open",
          },
          {
            claim_type: "CLM-EFFECTIVE",
            scope: "eu-prod",
            reason: "warrant-changed",
            status: "open",
          },
        ],
      });
      const ruleContracts = currentRuleContracts(workspace);
      expect(
        ruleContracts
          .filter((rule) => rule.rule_id.startsWith("R3."))
          .every((rule) => rule.rule_contract_version === "r3-v2"),
      ).toBe(true);
      expect(
        ruleContracts
          .filter((rule) => !rule.rule_id.startsWith("R3."))
          .every((rule) => rule.rule_contract_version !== "r3-v2"),
      ).toBe(true);
    },
  );
});
