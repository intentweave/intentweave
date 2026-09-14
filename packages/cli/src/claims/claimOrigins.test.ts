// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  initSchema,
  type ClaimOrigin,
  type ClaimsContractVersions,
} from "@intentweave/index";
import { reviewCandidate } from "./candidateGovernance.js";
import { projectClaimOrigins } from "./origins.js";
import { runClaimsExplain } from "../commands/claims.js";

const contracts: ClaimsContractVersions = {
  r1RuleContractVersion: "r1-v1",
  r3RuleContractVersion: "r3-v1",
  r7RuleContractVersion: "r7-v1",
  implementationFingerprint: "claims-engine-v1",
  literalPolicyVersion: "literal-binding-v1",
  defaultPolicyVersion: "default-contract-v1",
  runtimePolicyVersion: "runtime-resolution-v1",
  documentationPolicyVersion: "documentation-conformance-v1",
};

const declaredOrigin: ClaimOrigin = {
  contractVersion: "1",
  kind: "declared",
  source: "adr",
  sourceIdentity: "docs/ADR-017.md#parse-config",
  sourceVersion: "adr-017@1",
  provenance: { section: "Error contract" },
};

describe("G5.2a ClaimOrigin projection", () => {
  const workspaces: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  function persistCandidate(
    database: Database.Database,
    identityKey: string,
    provenance: Record<string, unknown>,
    evidence: Array<{
      evidenceKey: string;
      evidenceVersionId?: string;
      sourceKind: string;
      role: string;
      provenance: unknown;
    }> = [],
  ) {
    const store = new CandidateStore(database);
    const candidate = store.persist({
      identityKey,
      candidateKind: "test-symbol-contract",
      proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
      discoveryMode: provenance.origin ? "manual" : "deterministic",
      discoveryAdapterId: provenance.origin
        ? "test-declaration"
        : "test-reconstruction",
      discoveryContractVersion: "1",
      confidence: "certain",
      normalizedStatement: {
        subject: "symbol:typescript:parseConfig",
        predicate: "documents-error-cases",
      },
      provenance,
      evidence,
      subjects: [
        {
          kind: "symbol",
          identityKey: "symbol:typescript:parseConfig",
          displayName: "parseConfig",
          role: "subject",
          basis: "test-anchor",
          confidence: "certain",
        },
      ],
    });
    const triaged = store.triage(candidate.id, { basis: "test-triage" });
    return reviewCandidate(database, {
      candidateId: triaged.id,
      actor: "test",
      decision: "promote",
      rationale: "G5.2a test promotion",
      provenance: { test: true },
      contracts,
    }).assessment!;
  }

  it("combines reconstructed and declared Origins without a duplicate ClaimVersion", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-origin-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);

    const reconstructed = persistCandidate(database, "test:reconstructed", {
      repositoryRevision: "rev:1",
    });
    const declared = persistCandidate(database, "test:declared", {
      repositoryRevision: "rev:1",
      origin: declaredOrigin,
    });

    expect(declared.claimIdentityId).toBe(reconstructed.claimIdentityId);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM claim_versions
           WHERE claim_identity_id = ?`,
        )
        .get(reconstructed.claimIdentityId),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT epistemic_status FROM claim_assessments
           WHERE id = ?`,
        )
        .get(reconstructed.id),
    ).toEqual({ epistemic_status: "inconclusive" });

    const origins = projectClaimOrigins(
      database,
      reconstructed.claimIdentityId,
    );
    expect(origins.map((origin) => origin.kind)).toEqual([
      "declared",
      "reconstructed",
    ]);
    expect(origins).toContainEqual(declaredOrigin);
    database.close();
  });

  it("adds Evidence later through the existing assessment path", () => {
    const database = new Database(":memory:");
    initSchema(database);
    const store = new ClaimsStore(database);
    persistCandidate(database, "test:without-evidence", {
      repositoryRevision: "rev:1",
    });

    const definition = store.persistGenericEvidence({
      subjects: [
        {
          kind: "symbol",
          identityKey: "symbol:typescript:parseConfig",
          role: "subject",
          basis: "test-anchor",
          confidence: "certain",
        },
      ],
      sourceKind: "code-definition",
      identityKey: "test:parse-config:definition",
      fingerprint: fingerprint({ exported: true, name: "parseConfig" }),
      materialFingerprint: fingerprint({ exported: true, name: "parseConfig" }),
      normalizedValue: {
        exported: true,
        name: "parseConfig",
        signature: "(input: string) => Config",
      },
      semanticLocation: "symbol:typescript:parseConfig.definition",
      provenance: { test: true },
      repositoryRevision: "rev:2",
    });
    const documentation = store.persistGenericEvidence({
      subjects: [
        {
          kind: "symbol",
          identityKey: "symbol:typescript:parseConfig",
          role: "subject",
          basis: "test-anchor",
          confidence: "certain",
        },
      ],
      sourceKind: "documentation",
      identityKey: "test:parse-config:documentation",
      fingerprint: fingerprint({ present: true }),
      materialFingerprint: fingerprint({ present: true }),
      normalizedValue: { present: true, summary: "Documents error cases" },
      semanticLocation: "symbol:typescript:parseConfig.documentation",
      provenance: { test: true },
      repositoryRevision: "rev:2",
    });
    const assessment = persistCandidate(
      database,
      "test:with-evidence",
      { repositoryRevision: "rev:2" },
      [
        {
          evidenceKey: "test:parse-config:definition",
          evidenceVersionId: definition.id,
          sourceKind: "code-definition",
          role: "definition",
          provenance: { test: true },
        },
        {
          evidenceKey: "test:parse-config:documentation",
          evidenceVersionId: documentation.id,
          sourceKind: "documentation",
          role: "documentation",
          provenance: { test: true },
        },
      ],
    );

    expect(
      database
        .prepare(`SELECT epistemic_status FROM claim_assessments WHERE id = ?`)
        .get(assessment.id),
    ).toEqual({ epistemic_status: "supported" });
    database.close();
  });

  it("renders Origin separately from the Assessment basis", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-origin-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    const assessment = persistCandidate(database, "test:declared-explain", {
      repositoryRevision: "rev:1",
      origin: declaredOrigin,
    });
    const claimId = assessment.claimIdentityId;
    database.close();
    process.chdir(workspace);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runClaimsExplain({ claim: claimId, format: "json" });

    const explained = JSON.parse(String(log.mock.calls[0][0])) as Array<{
      origins: ClaimOrigin[];
      dependencies: unknown[];
      status: string;
    }>;
    expect(explained[0]).toMatchObject({
      status: "inconclusive",
      dependencies: expect.any(Array),
      origins: [declaredOrigin],
    });
  });
});
