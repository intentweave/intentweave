// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LLMProviderCapabilities,
  LLMProviderV2,
  LLMRequest,
  LLMResponse,
} from "@intentweave/core";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  initSchema,
} from "@intentweave/index";
import { runSemanticSymbolCorrelation } from "./semanticSymbolCorrelation.js";

const CAPABILITIES: LLMProviderCapabilities = {
  maxInputTokens: 32_000,
  supportsJsonSchema: true,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsEmbeddings: false,
  structuredOutputModes: ["strict"],
};

class FixtureProvider implements LLMProviderV2 {
  readonly name = "fixture-v2";
  readonly contractVersion = 2 as const;
  readonly capabilities = CAPABILITIES;
  readonly complete = vi.fn<(request: LLMRequest) => Promise<LLMResponse>>();

  constructor(
    private readonly select: (request: LLMRequest) => Record<string, unknown>,
  ) {
    this.complete.mockImplementation(async (request) => {
      const parsed = this.select(request);
      return {
        content: JSON.stringify(parsed),
        parsed,
        tokensUsed: { prompt: 50, completion: 12 },
        latencyMs: 5,
        model: "fixture-model",
        requestId: "fixture-request",
        finishReason: "stop",
      };
    });
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  capabilitiesFor(): LLMProviderCapabilities {
    return CAPABILITIES;
  }

  getModelName(): string {
    return "fixture-model";
  }
}

describe("semantic Symbol documentation correlation", () => {
  let database: Database.Database;
  let evidenceVersionId: string;
  const identityA = "public-symbol-doc-correlation:doc:parseConfig:symbol-a";
  const identityB = "public-symbol-doc-correlation:doc:parseConfig:symbol-b";

  beforeEach(() => {
    database = new Database(":memory:");
    initSchema(database);
    evidenceVersionId = new ClaimsStore(database).persistGenericEvidence({
      subjects: [
        {
          kind: "symbol",
          identityKey: "symbol:symbol-a",
          displayName: "parseConfig",
          role: "subject",
          basis: "ambiguous-documentation-name-match",
          confidence: "ambiguous",
        },
      ],
      sourceKind: "documentation-reference",
      identityKey: "documentation-reference:parse-config",
      fingerprint: fingerprint({
        text: "The CLI parseConfig validates command options.",
      }),
      materialFingerprint: fingerprint({
        text: "The CLI parseConfig validates command options.",
      }),
      normalizedValue: {
        text: "The CLI parseConfig validates command options.",
      },
      semanticLocation: "docs/cli.md:10",
      provenance: { fixture: true },
      filePath: "docs/cli.md",
      spanStartLine: 10,
      spanEndLine: 10,
    }).id;
    const candidates = new CandidateStore(database);
    for (const [identityKey, symbolId, filePath] of [
      [identityA, "symbol-a", "packages/cli/src/config.ts"],
      [identityB, "symbol-b", "packages/core/src/config.ts"],
    ]) {
      candidates.persist({
        identityKey,
        candidateKind: "public-symbol-documentation-correlation",
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
        discoveryMode: "deterministic",
        discoveryAdapterId: "cari-public-symbol-documentation",
        discoveryContractVersion: "1",
        confidence: "ambiguous",
        normalizedStatement: {
          symbolName: "parseConfig",
          symbolKind: "function",
          proposedDocumentationPath: "docs/cli.md",
          symbolFilePath: filePath,
        },
        provenance: { alternatives: ["symbol-a", "symbol-b"] },
        evidence: [
          {
            evidenceKey: "documentation-reference:parse-config",
            evidenceVersionId,
            sourceKind: "documentation-reference",
            role: "documentation",
            provenance: { filePath: "docs/cli.md", line: 10 },
          },
        ],
        subjects: [
          {
            kind: "symbol",
            identityKey: `symbol:${symbolId}`,
            displayName: "parseConfig",
            role: "subject",
            basis: "ambiguous-documentation-name-match",
            confidence: "ambiguous",
          },
        ],
      });
    }
  });

  afterEach(() => database.close());

  it("persists, applies, and reuses a grounded probable correlation", async () => {
    let selectedIdentity = identityA;
    const provider = new FixtureProvider((request) => {
      const prompt = JSON.parse(request.messages[0]!.content) as {
        evidence: { evidenceVersionId: string };
      };
      return {
        selectedCandidateIdentityKey: selectedIdentity,
        evidenceVersionIds: [prompt.evidence.evidenceVersionId],
        rationale: "The CLI path distinguishes the CLI parseConfig Symbol.",
      };
    });

    const first = await runSemanticSymbolCorrelation({ database, provider });
    const versionsAfterFirst = database
      .prepare(`SELECT COUNT(*) AS count FROM claim_candidates`)
      .get() as { count: number };
    const availability = vi
      .spyOn(provider, "isAvailable")
      .mockResolvedValue(false);
    const second = await runSemanticSymbolCorrelation({ database, provider });

    expect(first).toMatchObject({
      status: "evaluated",
      groups: 1,
      providerCalls: 1,
      cacheHits: 0,
      correlatedCandidateIds: [expect.any(String)],
      failures: [],
    });
    expect(second).toMatchObject({
      status: "evaluated",
      groups: 1,
      providerCalls: 0,
      cacheHits: 1,
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(availability).not.toHaveBeenCalled();
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM candidate_inferences`)
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM claim_candidates`).get(),
    ).toEqual(versionsAfterFirst);
    const candidates = new CandidateStore(database);
    expect(candidates.details(candidates.current(identityA)!.id)).toMatchObject(
      {
        state: "correlated",
        confidence: "probable",
        inferenceId: first.inferenceIds[0],
      },
    );
    expect(candidates.details(candidates.current(identityB)!.id)).toMatchObject(
      {
        state: "discovered",
        confidence: "ambiguous",
        inferenceId: first.inferenceIds[0],
      },
    );

    availability.mockRestore();
    selectedIdentity = identityB;
    const reclassified = await runSemanticSymbolCorrelation({
      database,
      provider,
      model: "fixture-model-v2",
    });
    expect(reclassified).toMatchObject({
      status: "evaluated",
      providerCalls: 1,
      cacheHits: 0,
    });
    expect(candidates.details(candidates.current(identityA)!.id)).toMatchObject(
      {
        state: "discovered",
        confidence: "ambiguous",
        inferenceId: reclassified.inferenceIds[0],
      },
    );
    expect(candidates.details(candidates.current(identityB)!.id)).toMatchObject(
      {
        state: "correlated",
        confidence: "probable",
        inferenceId: reclassified.inferenceIds[0],
      },
    );
  });

  it("persists ungrounded model output as ambiguous without correlating", async () => {
    const provider = new FixtureProvider(() => ({
      selectedCandidateIdentityKey: "fabricated-candidate",
      evidenceVersionIds: ["fabricated-evidence"],
      rationale: "Fabricated grounding",
    }));

    const result = await runSemanticSymbolCorrelation({ database, provider });

    expect(result).toMatchObject({
      status: "failed",
      providerCalls: 1,
      correlatedCandidateIds: [],
      failures: [{ kind: "ungrounded_output" }],
    });
    expect(
      database.prepare(`SELECT confidence FROM candidate_inferences`).get(),
    ).toEqual({ confidence: "ambiguous" });
    expect(
      new CandidateStore(database)
        .listCurrent()
        .filter((candidate) => candidate.inferenceId)
        .every(
          (candidate) =>
            candidate.state === "discovered" &&
            candidate.confidence === "ambiguous",
        ),
    ).toBe(true);
  });
});
