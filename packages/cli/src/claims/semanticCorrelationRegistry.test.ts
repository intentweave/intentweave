// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateInferenceStore,
  CandidateStore,
  ClaimsStore,
  fingerprint,
  initSchema,
} from "@intentweave/index";
import {
  applyGroundedCorrelation,
  SemanticCorrelationRegistry,
  SemanticCorrelationRegistryError,
  groundCorrelationProposal,
  resolveGroundedCorrelationProposals,
  type SemanticCorrelationAdapterV1,
} from "./semanticCorrelationRegistry.js";

function adapter(id: string, priority: number): SemanticCorrelationAdapterV1 {
  return {
    definition: {
      id,
      contractVersion: "1",
      mode: "model",
      inputSchemaVersion: "1",
      outputSchemaVersion: "1",
      supportedClaimTypes: ["CLM-PUBLIC-SYMBOL-DOCUMENTED"],
      supportedCandidateKinds: ["public-symbol-documentation-correlation"],
      supportedSubjectRoles: { subject: ["symbol"] },
      priority,
      promptVersion: "1",
    },
    select: () => [],
    buildContext: () => {
      throw new Error("fixture adapter does not build context");
    },
    outputSchema: { type: "object" },
    ground: (item, output) => groundCorrelationProposal(item, output),
  };
}

const workItem = {
  key: "work-item:parse-config",
  candidateIdentityKeys: ["candidate:parse-config"],
  candidateObservationFingerprints: ["observation:parse-config"],
  evidenceVersionIds: ["evidence:parse-config"],
  allowedClaimTypes: ["CLM-PUBLIC-SYMBOL-DOCUMENTED"],
  allowedSubjectBindings: [
    {
      identityKey: "symbol:parse-config",
      kind: "symbol" as const,
      roles: ["subject"],
    },
  ],
  requiredSubjectRoles: ["subject"],
  contextFingerprint: "context:parse-config",
};

const groundedOutput = {
  contractVersion: "grounded-correlation@1" as const,
  candidateIdentityKey: "candidate:parse-config",
  candidateObservationFingerprint: "observation:parse-config",
  evidenceVersionIds: ["evidence:parse-config"],
  proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
  subjectBindings: [
    {
      subjectIdentityKey: "symbol:parse-config",
      role: "subject",
      confidence: "probable" as const,
    },
  ],
  confidence: "probable",
  rationale: "The documentation and symbol evidence agree.",
};

describe("SemanticCorrelationRegistry", () => {
  it("validates adapters and orders them deterministically", () => {
    const registry = new SemanticCorrelationRegistry([
      adapter("zeta", 2),
      adapter("alpha", 2),
      adapter("first", 1),
    ]);

    expect(registry.list().map((item) => item.definition.id)).toEqual([
      "first",
      "alpha",
      "zeta",
    ]);
    expect(
      () =>
        new SemanticCorrelationRegistry([
          adapter("same", 1),
          adapter("same", 2),
        ]),
    ).toThrow(SemanticCorrelationRegistryError);
  });

  it("grounds probable proposals and rejects invented identities or roles", () => {
    expect(groundCorrelationProposal(workItem, groundedOutput)).toMatchObject({
      contractVersion: "grounded-correlation@1",
      confidence: "probable",
      candidateIdentityKey: "candidate:parse-config",
    });
    expect(() =>
      groundCorrelationProposal(workItem, {
        ...groundedOutput,
        evidenceVersionIds: ["evidence:invented"],
      }),
    ).toThrow(/ungrounded EvidenceVersion/);
    expect(() =>
      groundCorrelationProposal(workItem, {
        ...groundedOutput,
        subjectBindings: [
          { subjectIdentityKey: "symbol:parse-config", role: "handler" },
        ],
      }),
    ).toThrow(/not grounded/);
  });

  it("keeps incomplete probable bindings from becoming effective", () => {
    expect(() =>
      groundCorrelationProposal(workItem, {
        ...groundedOutput,
        subjectBindings: [],
      }),
    ).toThrow(/missing required Subject role/);
  });

  it("coalesces identical proposals and leaves conflicts ambiguous", () => {
    expect(
      resolveGroundedCorrelationProposals([groundedOutput, groundedOutput]),
    ).toMatchObject({ status: "applied", proposal: groundedOutput });
    const alternate = {
      ...groundedOutput,
      rationale: "z-different rationale is harmless",
    };
    expect(
      resolveGroundedCorrelationProposals([groundedOutput, alternate]),
    ).toMatchObject({ status: "applied", proposal: groundedOutput });
    expect(
      resolveGroundedCorrelationProposals([alternate, groundedOutput]),
    ).toMatchObject({ status: "applied", proposal: groundedOutput });
    expect(
      resolveGroundedCorrelationProposals([
        groundedOutput,
        { ...groundedOutput, proposedClaimType: "CLM-OTHER" },
      ]),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("applies a probable grounded proposal only to the current Candidate", () => {
    const database = new Database(":memory:");
    initSchema(database);
    const subject = {
      kind: "symbol" as const,
      identityKey: "symbol:parse-config",
      displayName: "parseConfig",
      role: "subject",
      basis: "fixture",
      confidence: "probable" as const,
    };
    const evidence = new ClaimsStore(database).persistGenericEvidence({
      subjects: [subject],
      sourceKind: "documentation-reference",
      identityKey: "evidence:parse-config",
      fingerprint: fingerprint({ parseConfig: true }),
      materialFingerprint: fingerprint({ parseConfig: true }),
      normalizedValue: { parseConfig: true },
      semanticLocation: "docs/parse-config.md:1",
      provenance: { fixture: true },
    });
    const candidate = new CandidateStore(database).persist({
      identityKey: "candidate:parse-config",
      candidateKind: "public-symbol-documentation-correlation",
      proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
      discoveryMode: "deterministic",
      discoveryAdapterId: "fixture",
      discoveryContractVersion: "1",
      confidence: "probable",
      normalizedStatement: { symbolName: "parseConfig" },
      provenance: { fixture: true },
      evidence: [
        {
          evidenceKey: "evidence:parse-config",
          evidenceVersionId: evidence.id,
          sourceKind: "documentation-reference",
          provenance: {},
        },
      ],
      subjects: [subject],
    });
    const inference = new CandidateInferenceStore(database).persist({
      identityKey: candidate.identityKey,
      adapterId: "fixture-adapter",
      contractVersion: "1",
      providerId: "fixture",
      modelId: "fixture-model",
      promptVersion: "1",
      inputFingerprint: "fixture-context",
      normalizedOutput: { grounded: true },
      evidenceVersionIds: [evidence.id],
      proposedSubjectBindings: [
        { kind: "symbol", identityKey: subject.identityKey, role: "subject" },
      ],
      confidence: "probable",
      rationale: "Grounded fixture",
      provenance: { fixture: true },
    });
    const application = {
      database,
      candidate: new CandidateStore(database).details(candidate.id)!,
      inferenceId: inference.id,
      adapterId: "fixture-adapter",
      adapterContractVersion: "1",
      proposal: {
        ...groundedOutput,
        candidateIdentityKey: candidate.identityKey,
        candidateObservationFingerprint: candidate.observationFingerprint,
        evidenceVersionIds: [evidence.id],
      },
      provenance: { fixture: true },
    };

    expect(() =>
      applyGroundedCorrelation({
        ...application,
        proposal: {
          ...application.proposal,
          evidenceVersionIds: ["evidence:invented"],
        },
      }),
    ).toThrow(/EvidenceVersion does not belong/);
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM claim_candidates`).get(),
    ).toEqual({ count: 1 });

    const applied = applyGroundedCorrelation(application);

    expect(applied).toMatchObject({ state: "correlated", created: true });
    expect(new CandidateStore(database).details(applied.id)).toMatchObject({
      inferenceId: inference.id,
      state: "correlated",
    });
    expect(() => applyGroundedCorrelation(application)).toThrow(/not current/);
    database.close();
  });
});
