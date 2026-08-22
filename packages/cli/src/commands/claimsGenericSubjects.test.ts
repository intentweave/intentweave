// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import { ClaimsStore, initSchema } from "@intentweave/index";
import {
  persistPortableAssessmentReview,
  projectPortableAssessmentReviews,
} from "../claims/portableReviewProjection.js";
import { loadPortableClaimsState } from "../claims/portableState.js";
import { runClaimsExplain } from "./claims.js";

describe("iw claims explain — generic Subjects (G1b)", () => {
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

  it("explains a generic multi-Subject claim without a Parameter identity", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    const assessment = new ClaimsStore(database).persistGenericClaimAssessment({
      subjects: [
        {
          kind: "module",
          identityKey: "module:workspace:@intentweave/ui",
          role: "source",
        },
        {
          kind: "module",
          identityKey: "module:workspace:@intentweave/persistence",
          role: "target",
        },
      ],
      claimType: "CLM-DEPENDENCY-CONFORMANCE",
      identityContract: { id: "dependency-claim-identity", version: "1" },
      materialityContract: {
        id: "dependency-claim-materiality",
        version: "1",
      },
      normalizedStatement: {
        source: "module:workspace:@intentweave/ui",
        target: "module:workspace:@intentweave/persistence",
        rule: "no-ui-to-persistence",
      },
      assessmentPolicyId: "dependency-conformance",
      assessmentPolicyVersion: "1",
      repositoryRevision: "rev:1",
      status: "supported",
      dependencies: [],
    });
    database.close();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsExplain({
      claim: assessment.claimIdentityId,
      format: "json",
    });

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject([
      {
        claimIdentityId: assessment.claimIdentityId,
        parameterKey: null,
        claimType: "CLM-DEPENDENCY-CONFORMANCE",
        status: "supported",
        identityContract: { id: "dependency-claim-identity", version: "1" },
        materialityContract: {
          id: "dependency-claim-materiality",
          version: "1",
        },
        subjects: [
          {
            role: "source",
            kind: "module",
            identityKey: "module:workspace:@intentweave/ui",
          },
          {
            role: "target",
            kind: "module",
            identityKey: "module:workspace:@intentweave/persistence",
          },
        ],
      },
    ]);

    log.mockClear();
    await runClaimsExplain({
      claim: assessment.claimIdentityId,
      format: "text",
    });
    expect(process.exitCode).toBe(0);
    const lines = log.mock.calls.map(([message]) => String(message));
    expect(lines).toEqual(
      expect.arrayContaining([
        "CLM-DEPENDENCY-CONFORMANCE: supported",
        "  Subject: source=module:workspace:@intentweave/ui (module)",
        "  Subject: target=module:workspace:@intentweave/persistence (module)",
        "  Identity contract: dependency-claim-identity@1",
        "  Materiality contract: dependency-claim-materiality@1",
      ]),
    );
    expect(lines.some((line) => line.includes("Parameter:"))).toBe(false);
  });

  it("lists generic claims alongside Parameter claims in the full explain view", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    const store = new ClaimsStore(database);
    const parameterAssessment = store.persistClaimAssessment({
      parameterKey: "session.timeout",
      claimType: "CLM-DEFAULT",
      normalizedStatement: { value: 1800 },
      assessmentPolicyId: "default-contract",
      assessmentPolicyVersion: "1",
      repositoryRevision: "rev:1",
      status: "supported",
      dependencies: [],
    });
    const genericAssessment = store.persistGenericClaimAssessment({
      subjects: [
        {
          kind: "symbol",
          identityKey: "symbol:typescript:parseConfig",
          role: "subject",
        },
      ],
      claimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
      identityContract: { id: "symbol-doc-identity", version: "1" },
      materialityContract: { id: "symbol-doc-materiality", version: "1" },
      normalizedStatement: { documented: true },
      assessmentPolicyId: "symbol-documentation",
      assessmentPolicyVersion: "1",
      repositoryRevision: "rev:1",
      status: "inconclusive",
      dependencies: [],
    });
    database.close();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsExplain({ format: "json" });

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(String(log.mock.calls[0][0])) as Array<{
      claimIdentityId: string;
      parameterKey: string | null;
      subjects: Array<{ role: string; identityKey: string }>;
    }>;
    const byId = new Map(output.map((entry) => [entry.claimIdentityId, entry]));
    expect(byId.get(parameterAssessment.claimIdentityId)).toMatchObject({
      parameterKey: "session.timeout",
      subjects: [{ role: "subject", identityKey: "parameter:session.timeout" }],
    });
    expect(byId.get(genericAssessment.claimIdentityId)).toMatchObject({
      parameterKey: null,
      subjects: [
        { role: "subject", identityKey: "symbol:typescript:parseConfig" },
      ],
    });
  });

  it("rejects a portable generic review after materiality-contract drift", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    const store = new ClaimsStore(database);
    const input = {
      subjects: [
        {
          kind: "module" as const,
          identityKey: "module:workspace:@intentweave/ui",
          role: "subject",
        },
      ],
      claimType: "CLM-MODULE-CONFORMANCE",
      identityContract: { id: "module-claim-identity", version: "1" },
      materialityContract: { id: "module-claim-materiality", version: "1" },
      normalizedStatement: { compliant: true },
      assessmentPolicyId: "module-conformance",
      assessmentPolicyVersion: "1",
      repositoryRevision: "rev:1",
      status: "supported" as const,
      dependencies: [],
    };
    const initial = store.persistGenericClaimAssessment(input);
    persistPortableAssessmentReview(workspace, database, {
      claimIdentityId: initial.claimIdentityId,
      basisAssessmentId: initial.id,
      decision: "accepted",
      actor: "reviewer",
      rationale: "Initial contract accepted",
      decidedAt: "2026-08-21T00:00:00.000Z",
    });
    const portable = loadPortableClaimsState(workspace)!;

    store.persistGenericClaimAssessment({
      ...input,
      materialityContract: { id: "module-claim-materiality", version: "2" },
      repositoryRevision: "rev:2",
    });
    const projection = projectPortableAssessmentReviews(database, portable);

    expect(projection.imported).toBe(0);
    expect(projection.issues).toEqual([
      expect.objectContaining({
        claimIdentityId: initial.claimIdentityId,
        kind: "stale_assessment",
      }),
    ]);
    database.close();
  });
});
