// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  LLMProviderCapabilities,
  LLMProviderV2,
  LLMRequest,
  LLMResponse,
} from "@intentweave/core";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  CandidateInferenceStore,
  ClaimsStore,
  fingerprint,
  initSchema,
} from "@intentweave/index";
import { runSemanticCrossArtifactCorrelation } from "./semanticCrossArtifactCorrelation.js";

const CAPABILITIES: LLMProviderCapabilities = {
  maxInputTokens: 32_000,
  supportsJsonSchema: true,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsEmbeddings: false,
  structuredOutputModes: ["strict"],
};

class FixtureProvider implements LLMProviderV2 {
  readonly name = "cross-artifact-fixture-v2";
  readonly contractVersion = 2 as const;
  readonly capabilities = CAPABILITIES;
  calls = 0;

  constructor(
    private readonly select: (request: LLMRequest) => Record<string, unknown>,
  ) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    const parsed = this.select(request);
    return {
      content: JSON.stringify(parsed),
      parsed,
      tokensUsed: { prompt: 70, completion: 16 },
      latencyMs: 5,
      model: "cross-artifact-fixture-model",
      requestId: `cross-artifact-fixture-request-${this.calls}`,
      finishReason: "stop",
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  capabilitiesFor(): LLMProviderCapabilities {
    return CAPABILITIES;
  }

  getModelName(): string {
    return "cross-artifact-fixture-model";
  }
}

function sharedSubject() {
  return {
    kind: "module" as const,
    identityKey: "module:feature:auth",
    displayName: "Auth module",
    role: "subject",
    basis: "fixture-shared-subject",
    confidence: "ambiguous" as const,
  };
}

describe("semantic cross-artifact correlation", () => {
  let database: Database.Database;
  let candidateKeys: string[];
  let evidenceByCandidate: Map<string, string[]>;
  const subjectBinding = {
    subjectIdentityKey: "module:feature:auth",
    role: "subject",
  };

  beforeEach(() => {
    database = new Database(":memory:");
    initSchema(database);
    const claims = new ClaimsStore(database);
    const candidates = new CandidateStore(database);
    const subject = sharedSubject();
    const fixtures = [
      {
        candidateKey: "candidate:code-auth",
        candidateKind: "r1-code-value",
        claimType: "CLM-DEFAULT",
        adapterId: "fixture-code",
        sources: ["code-symbol", "code-documentation"],
        statement: { value: "auth" },
      },
      {
        candidateKey: "candidate:architecture-auth",
        candidateKind: "architecture-dependency-conformance",
        claimType: "CLM-DEPENDENCY-CONFORMANCE",
        adapterId: "fixture-architecture",
        sources: ["architecture-rule-definition", "architecture-rule-check"],
        statement: { rule: "auth-boundary" },
      },
    ];
    candidateKeys = fixtures.map((fixture) => fixture.candidateKey);
    evidenceByCandidate = new Map();
    for (const fixture of fixtures) {
      const evidenceVersionIds = fixture.sources.map(
        (sourceKind, index) =>
          claims.persistGenericEvidence({
            subjects: [subject],
            sourceKind,
            identityKey: `${fixture.candidateKey}:evidence:${index}`,
            fingerprint: fingerprint({
              candidate: fixture.candidateKey,
              sourceKind,
              index,
            }),
            materialFingerprint: fingerprint({ sourceKind, index }),
            normalizedValue: {
              candidate: fixture.candidateKey,
              sourceKind,
              index,
            },
            semanticLocation: `${subject.identityKey}:${sourceKind}`,
            provenance: { fixture: true },
          }).id,
      );
      evidenceByCandidate.set(fixture.candidateKey, evidenceVersionIds);
      candidates.persist({
        identityKey: fixture.candidateKey,
        candidateKind: fixture.candidateKind,
        proposedClaimType: fixture.claimType,
        discoveryMode: "deterministic",
        discoveryAdapterId: fixture.adapterId,
        discoveryContractVersion: "1",
        confidence: "ambiguous",
        normalizedStatement: fixture.statement,
        provenance: { fixture: true },
        evidence: fixture.sources.map((sourceKind, index) => ({
          evidenceKey: `${fixture.candidateKey}:evidence:${index}`,
          evidenceVersionId: evidenceVersionIds[index],
          sourceKind,
          role: "source",
          provenance: { fixture: true },
        })),
        subjects: [subject],
      });
    }
  });

  afterEach(() => database.close());

  function groundedOutput(
    request: LLMRequest,
    confidence: "probable" | "ambiguous",
  ) {
    const context = JSON.parse(request.messages[0]!.content) as {
      workItem: { candidateIdentityKeys: string[] };
      evidence: Array<{ id: string }>;
    };
    return {
      selectedCandidateIdentityKey: context.workItem.candidateIdentityKeys[0],
      evidenceVersionIds: context.evidence.map((evidence) => evidence.id),
      subjectBindings: [subjectBinding],
      confidence,
      rationale:
        confidence === "probable"
          ? "The shared module Subject is supported by code and architecture Evidence."
          : "The shared module is plausible, but the artifact relationship remains uncertain.",
    };
  }

  it("applies grounded cross-artifact proposals to each unresolved Candidate", async () => {
    const provider = new FixtureProvider((request) =>
      groundedOutput(request, "probable"),
    );

    const result = await runSemanticCrossArtifactCorrelation({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "evaluated",
      groups: 2,
      providerCalls: 2,
      correlatedCandidateIds: [expect.any(String), expect.any(String)],
      ambiguousCandidateIds: [],
      failures: [],
    });
    expect(provider.calls).toBe(2);
    const candidates = new CandidateStore(database);
    for (const candidateKey of candidateKeys) {
      const current = candidates.current(candidateKey)!;
      expect(candidates.details(current.id)).toMatchObject({
        state: "correlated",
        confidence: "probable",
        inferenceId: expect.any(String),
      });
    }
    const inference = new CandidateInferenceStore(database).details(
      result.inferenceIds[0]!,
    );
    expect(
      (inference?.provenance as { crossArtifactEvidenceVersionIds?: string[] })
        .crossArtifactEvidenceVersionIds,
    ).toEqual(
      expect.arrayContaining(evidenceByCandidate.get(candidateKeys[1]!)!),
    );
  });

  it("keeps uncertain cross-artifact proposals ambiguous", async () => {
    const provider = new FixtureProvider((request) =>
      groundedOutput(request, "ambiguous"),
    );

    const result = await runSemanticCrossArtifactCorrelation({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "evaluated",
      groups: 2,
      providerCalls: 2,
      correlatedCandidateIds: [],
      ambiguousCandidateIds: [expect.any(String), expect.any(String)],
      failures: [],
    });
    const candidates = new CandidateStore(database);
    for (const candidateKey of candidateKeys) {
      expect(
        candidates.details(candidates.current(candidateKey)!.id),
      ).toMatchObject({ state: "discovered", confidence: "ambiguous" });
    }
  });

  it("rejects a proposal that cites only the selected Candidate Evidence", async () => {
    const provider = new FixtureProvider((request) => {
      const context = JSON.parse(request.messages[0]!.content) as {
        workItem: { candidateIdentityKeys: string[] };
      };
      const selectedIdentityKey = context.workItem.candidateIdentityKeys[0]!;
      return {
        selectedCandidateIdentityKey: selectedIdentityKey,
        evidenceVersionIds: evidenceByCandidate.get(selectedIdentityKey)!,
        subjectBindings: [subjectBinding],
        confidence: "probable",
        rationale: "The selected Candidate is internally coherent.",
      };
    });

    const result = await runSemanticCrossArtifactCorrelation({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "failed",
      providerCalls: 2,
      correlatedCandidateIds: [],
      failures: [{ kind: "ungrounded_output" }, { kind: "ungrounded_output" }],
    });
    const candidates = new CandidateStore(database);
    for (const candidateKey of candidateKeys) {
      expect(
        candidates.details(candidates.current(candidateKey)!.id),
      ).toMatchObject({ state: "discovered", confidence: "ambiguous" });
    }
  });
});
