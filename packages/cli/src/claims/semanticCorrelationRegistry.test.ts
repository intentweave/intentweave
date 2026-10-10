// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  SemanticCorrelationRegistry,
  SemanticCorrelationRegistryError,
  groundCorrelationProposal,
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
  candidateIdentityKey: "candidate:parse-config",
  candidateObservationFingerprint: "observation:parse-config",
  evidenceVersionIds: ["evidence:parse-config"],
  proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
  subjectBindings: [
    { subjectIdentityKey: "symbol:parse-config", role: "subject" },
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
});
