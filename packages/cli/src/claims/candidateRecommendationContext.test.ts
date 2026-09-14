// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  initSchema,
} from "@intentweave/index";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCandidateRecommendationPreview,
  CandidateInferenceConfigError,
  parseCandidateInferenceConfig,
  type CandidateInferenceConfig,
} from "./candidateRecommendationContext.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function config(): CandidateInferenceConfig {
  return parseCandidateInferenceConfig({
    schemaVersion: "1",
    providers: { allow: ["openai"] },
    sensitivePaths: ["secrets/**"],
    budgets: {
      maxCandidates: 10,
      maxEvidencePerCandidate: 4,
      maxExcerptChars: 500,
      maxTokensPerCandidate: 2_000,
      maxTotalTokens: 5_000,
      maxEstimatedCostUsd: 0.5,
      maxConcurrency: 1,
    },
  });
}

function workspace(): { root: string; database: Database.Database } {
  const root = mkdtempSync(path.join(tmpdir(), "iw-g6a-context-"));
  workspaces.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "secrets"), { recursive: true });
  mkdirSync(path.join(root, "fixtures"), { recursive: true });
  const database = new Database(":memory:");
  initSchema(database);
  return { root, database };
}

function persistCandidate(
  database: Database.Database,
  input: {
    identityKey: string;
    claimType: string;
    candidateKind: string;
    confidence: "certain" | "probable";
    sourceKind: string;
    filePath: string;
    normalizedValue: unknown;
    statement: unknown;
  },
): string {
  const subject = {
    kind: "endpoint" as const,
    identityKey: `endpoint:${input.identityKey}`,
    displayName: input.identityKey,
    role: "subject",
    basis: "fixture-grounding",
    confidence: input.confidence,
  };
  const evidence = new ClaimsStore(database).persistGenericEvidence({
    subjects: [subject],
    sourceKind: input.sourceKind,
    identityKey: `evidence:${input.identityKey}`,
    fingerprint: fingerprint(input.normalizedValue),
    materialFingerprint: fingerprint(input.normalizedValue),
    normalizedValue: input.normalizedValue,
    semanticLocation: input.identityKey,
    provenance: { adapter: "g6a-test" },
    filePath: input.filePath,
    spanStartLine: 1,
    spanEndLine: 1,
  });
  const evidenceVersion = database
    .prepare(
      `SELECT id FROM evidence_versions
       WHERE semantic_location = ? ORDER BY version_ordinal DESC LIMIT 1`,
    )
    .get(input.identityKey) as { id: string };
  return new CandidateStore(database).persist({
    identityKey: input.identityKey,
    candidateKind: input.candidateKind,
    proposedClaimType: input.claimType,
    discoveryMode: "deterministic",
    discoveryAdapterId: "g6a-test",
    discoveryContractVersion: "1",
    confidence: input.confidence,
    normalizedStatement: input.statement,
    provenance: { repositoryRevision: "g6a-test" },
    evidence: [
      {
        evidenceKey: `evidence:${input.identityKey}`,
        evidenceVersionId: evidenceVersion.id,
        sourceKind: input.sourceKind,
        role: "source",
        provenance: {},
      },
    ],
    subjects: [subject],
  }).id;
}

describe("G6a Candidate recommendation context", () => {
  it("requires an explicit provider allowlist and rejects unknown config", () => {
    expect(() =>
      parseCandidateInferenceConfig({
        schemaVersion: "1",
        providers: { allow: [] },
      }),
    ).toThrow("must explicitly allow at least one provider");
    expect(() =>
      parseCandidateInferenceConfig({
        schemaVersion: "1",
        providers: { allow: ["openai"] },
        providerPayloads: {},
      }),
    ).toThrow("providerPayloads is not supported");
    expect(() =>
      parseCandidateInferenceConfig({
        schemaVersion: "1",
        providers: { allow: ["openai"] },
        budgets: { maxExcerptChars: 10 },
      }),
    ).toThrow("budgets.maxExcerptChars must be at least 64");
  });

  it("builds a bounded exact preview and excludes or redacts unsafe context", () => {
    const fixture = workspace();
    const outside = mkdtempSync(path.join(tmpdir(), "iw-g6a-outside-"));
    workspaces.push(outside);
    writeFileSync(
      path.join(fixture.root, "src", "admin.ts"),
      'export const token = "sk-live-abcdefghijklmnop";\n',
    );
    writeFileSync(
      path.join(fixture.root, "secrets", "admin.ts"),
      "export const secretAdmin = true;\n",
    );
    writeFileSync(
      path.join(fixture.root, "fixtures", "admin.test.ts"),
      "export const fixtureAdmin = true;\n",
    );
    writeFileSync(
      path.join(outside, "outside.ts"),
      'export const outsideSecret = "must-not-leave-workspace";\n',
    );
    symlinkSync(
      path.join(outside, "outside.ts"),
      path.join(fixture.root, "src", "linked.ts"),
    );
    persistCandidate(fixture.database, {
      identityKey: "endpoint:admin-users",
      claimType: "CLM-ENDPOINT-AUTHENTICATED",
      candidateKind: "endpoint-authentication",
      confidence: "certain",
      sourceKind: "endpoint-handler",
      filePath: "src/admin.ts",
      normalizedValue: {
        method: "POST",
        path: "/admin/users",
        apiKey: "sk-live-abcdefghijklmnop",
      },
      statement: {
        method: "POST",
        path: "/admin/users",
        requirement: "endpoint-is-authenticated",
      },
    });
    persistCandidate(fixture.database, {
      identityKey: "literal:page-size",
      claimType: "CLM-LITERAL",
      candidateKind: "r1-code-value",
      confidence: "probable",
      sourceKind: "code-default",
      filePath: "src/admin.ts",
      normalizedValue: 25,
      statement: { subject: "PAGE_SIZE", value: 25 },
    });
    persistCandidate(fixture.database, {
      identityKey: "endpoint:sensitive-admin",
      claimType: "CLM-ENDPOINT-AUTHENTICATED",
      candidateKind: "endpoint-authentication",
      confidence: "certain",
      sourceKind: "endpoint-handler",
      filePath: "secrets/admin.ts",
      normalizedValue: { method: "DELETE", path: "/admin/all" },
      statement: { method: "DELETE", path: "/admin/all" },
    });
    persistCandidate(fixture.database, {
      identityKey: "endpoint:fixture-admin",
      claimType: "CLM-ENDPOINT-AUTHENTICATED",
      candidateKind: "endpoint-authentication",
      confidence: "certain",
      sourceKind: "endpoint-handler",
      filePath: "fixtures/admin.test.ts",
      normalizedValue: { method: "POST", path: "/fixture" },
      statement: { method: "POST", path: "/fixture" },
    });
    persistCandidate(fixture.database, {
      identityKey: "endpoint:linked-admin",
      claimType: "CLM-ENDPOINT-AUTHENTICATED",
      candidateKind: "endpoint-authentication",
      confidence: "certain",
      sourceKind: "endpoint-handler",
      filePath: "src/linked.ts",
      normalizedValue: { method: "GET", path: "/linked" },
      statement: { method: "GET", path: "/linked" },
    });

    const preview = buildCandidateRecommendationPreview({
      database: fixture.database,
      workspaceRoot: fixture.root,
      provider: "openai",
      config: config(),
      enabledPolicyIds: ["endpoint-security"],
    });

    expect(preview).toMatchObject({
      mode: "preview",
      networkCallPerformed: false,
      summary: {
        observedCandidates: 5,
        eligibleCandidates: 2,
        includedCandidates: 2,
        excludedCandidates: 3,
        precision: null,
        recall: null,
        qualityMeasurement: "requires-labeled-evaluation",
      },
    });
    expect(preview.eligibility).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: expect.stringContaining("candidate:"),
          eligible: false,
          reasons: ["low-value-literal"],
        }),
        expect.objectContaining({
          eligible: false,
          reasons: ["sensitive-only-evidence"],
        }),
        expect.objectContaining({
          eligible: false,
          reasons: ["fixture-or-example-artifact"],
        }),
      ]),
    );
    const adminContext = preview.contexts.find(
      (context) =>
        (context.candidate.statement as { path?: string }).path ===
        "/admin/users",
    );
    expect(adminContext).toMatchObject({
      repositoryPolicies: ["endpoint-security"],
      security: {
        repositoryContentIsUntrusted: true,
        toolExecutionAllowed: false,
        contentBoundary: "repository-data-only",
        redactionCount: 2,
        omittedSensitiveEvidence: 0,
      },
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("sk-live-abcdefghijklmnop");
    expect(serialized).not.toContain("must-not-leave-workspace");
    expect(serialized).toContain("REDACTED_OPENAI_KEY");
    const linkedContext = preview.contexts.find(
      (context) =>
        (context.candidate.statement as { path?: string }).path === "/linked",
    );
    expect(linkedContext?.evidence[0]).not.toHaveProperty("sourceExcerpt");
    fixture.database.close();
  });

  it("fails closed when the selected provider is not allowed", () => {
    const fixture = workspace();
    expect(() =>
      buildCandidateRecommendationPreview({
        database: fixture.database,
        workspaceRoot: fixture.root,
        provider: "local-model",
        config: config(),
      }),
    ).toThrow(CandidateInferenceConfigError);
    fixture.database.close();
  });

  it("processes only Candidate versions without an existing AI recommendation", () => {
    const fixture = workspace();
    writeFileSync(
      path.join(fixture.root, "src", "admin.ts"),
      "export const admin = true;\n",
    );
    const candidateId = persistCandidate(fixture.database, {
      identityKey: "endpoint:recommended-admin",
      claimType: "CLM-ENDPOINT-AUTHENTICATED",
      candidateKind: "endpoint-authentication",
      confidence: "certain",
      sourceKind: "endpoint-handler",
      filePath: "src/admin.ts",
      normalizedValue: { method: "POST", path: "/admin" },
      statement: { method: "POST", path: "/admin" },
    });
    fixture.database
      .prepare(
        `INSERT INTO candidate_reviews (
           id, candidate_id, promoted_claim_identity_id, actor_kind, actor_id,
           decision, effect, rationale, provenance_json, created_at
         ) VALUES (?, ?, NULL, 'ai', 'fixture-model', 'promote',
                   'recommendation', 'Relevant endpoint', '{}', ?)`,
      )
      .run("candidate-review:existing-recommendation", candidateId, Date.now());

    const preview = buildCandidateRecommendationPreview({
      database: fixture.database,
      workspaceRoot: fixture.root,
      provider: "openai",
      config: config(),
    });

    expect(preview.contexts).toEqual([]);
    expect(preview.eligibility).toEqual([
      expect.objectContaining({
        candidateId,
        eligible: false,
        reasons: ["already-recommended"],
      }),
    ]);
    fixture.database.close();
  });
});
