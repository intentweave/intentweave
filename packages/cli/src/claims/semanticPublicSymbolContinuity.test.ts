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
  ClaimsStore,
  fingerprint,
  initSchema,
} from "@intentweave/index";
import { runSemanticPublicSymbolContinuity } from "./semanticPublicSymbolContinuity.js";

const CAPABILITIES: LLMProviderCapabilities = {
  maxInputTokens: 32_000,
  supportsJsonSchema: true,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsEmbeddings: false,
  structuredOutputModes: ["strict"],
};

class FixtureProvider implements LLMProviderV2 {
  readonly name = "symbol-continuity-fixture-v2";
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
      tokensUsed: { prompt: 60, completion: 14 },
      latencyMs: 5,
      model: "symbol-continuity-fixture-model",
      requestId: `symbol-continuity-fixture-request-${this.calls}`,
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
    return "symbol-continuity-fixture-model";
  }
}

const CURRENT_CANDIDATE = "public-symbol-doc:current-symbol";
const PREDECESSOR_A = "public-symbol-doc:predecessor-a";
const PREDECESSOR_B = "public-symbol-doc:predecessor-b";
const CURRENT_SUBJECT = "symbol:current-symbol";
const PREDECESSOR_SUBJECT_A = "symbol:predecessor-a";
const PREDECESSOR_SUBJECT_B = "symbol:predecessor-b";

function continuityAlternative(
  candidateIdentityKey: string,
  subjectIdentityKey: string,
  filePath: string,
) {
  return {
    candidateIdentityKey,
    subjectIdentityKey,
    subjectDisplayName: "loadConfig",
    filePath,
    normalizedValue: {
      name: "loadConfig",
      kind: "function",
      signature: "(source: string): string",
      structureHash: "load-config-shape",
    },
  };
}

describe("semantic public Symbol continuity", () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(":memory:");
    initSchema(database);
    const claims = new ClaimsStore(database);
    const candidates = new CandidateStore(database);
    const currentSubject = {
      kind: "symbol" as const,
      identityKey: CURRENT_SUBJECT,
      displayName: "loadConfig",
      role: "subject",
      basis: "current-symbol",
      confidence: "certain" as const,
    };
    const predecessorA = {
      kind: "symbol" as const,
      identityKey: PREDECESSOR_SUBJECT_A,
      displayName: "loadConfig",
      role: "predecessor",
      basis: "historical-symbol",
      confidence: "ambiguous" as const,
    };
    const predecessorB = {
      kind: "symbol" as const,
      identityKey: PREDECESSOR_SUBJECT_B,
      displayName: "loadConfig",
      role: "predecessor",
      basis: "historical-symbol",
      confidence: "ambiguous" as const,
    };
    const alternatives = [
      continuityAlternative(
        PREDECESSOR_A,
        PREDECESSOR_SUBJECT_A,
        "src/a-config.ts",
      ),
      continuityAlternative(
        PREDECESSOR_B,
        PREDECESSOR_SUBJECT_B,
        "src/b-config.ts",
      ),
    ];
    const evidence = [
      {
        key: "definition",
        sourceKind: "code-symbol",
        role: "definition",
        value: {
          name: "loadConfig",
          kind: "function",
          signature: "(source: string): string",
          structureHash: "load-config-shape",
        },
        subjects: [currentSubject],
      },
      {
        key: "documentation",
        sourceKind: "code-documentation",
        role: "documentation",
        value: { present: true, summary: "Loads configuration." },
        subjects: [currentSubject],
      },
      {
        key: "continuity",
        sourceKind: "subject-continuity-candidate",
        role: "continuity",
        value: {
          observedSubjectIdentityKey: CURRENT_SUBJECT,
          alternatives,
        },
        subjects: [currentSubject, predecessorA, predecessorB],
      },
    ];
    const evidenceVersionIds = evidence.map(
      (item) =>
        claims.persistGenericEvidence({
          subjects: item.subjects,
          sourceKind: item.sourceKind,
          identityKey: `${CURRENT_CANDIDATE}:${item.key}`,
          fingerprint: fingerprint(item.value),
          materialFingerprint: fingerprint(item.value),
          normalizedValue: item.value,
          semanticLocation: `${CURRENT_SUBJECT}:${item.role}`,
          provenance: { fixture: true },
        }).id,
    );
    candidates.persist({
      identityKey: CURRENT_CANDIDATE,
      candidateKind: "public-symbol-documentation",
      proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
      discoveryMode: "deterministic",
      discoveryAdapterId: "cari-public-symbol-documentation",
      discoveryContractVersion: "2",
      confidence: "certain",
      normalizedStatement: {
        symbolName: "loadConfig",
        symbolKind: "function",
        requirement: "public-symbol-is-documented",
      },
      provenance: {
        fixture: true,
        continuityAlternatives: alternatives,
      },
      evidence: evidence.map((item, index) => ({
        evidenceKey: `${CURRENT_CANDIDATE}:${item.key}`,
        evidenceVersionId: evidenceVersionIds[index],
        sourceKind: item.sourceKind,
        role: item.role,
        provenance: { fixture: true },
      })),
      subjects: [currentSubject],
    });
  });

  afterEach(() => database.close());

  function selectedOutput(
    request: LLMRequest,
    confidence: "probable" | "ambiguous",
    predecessorCandidateIdentityKey = PREDECESSOR_A,
    predecessorSubjectIdentityKey = PREDECESSOR_SUBJECT_A,
  ) {
    const context = JSON.parse(request.messages[0]!.content) as {
      workItem: { candidateIdentityKeys: string[] };
      evidence: Array<{ id: string }>;
    };
    return {
      selectedPredecessorCandidateIdentityKey: predecessorCandidateIdentityKey,
      selectedPredecessorSubjectIdentityKey: predecessorSubjectIdentityKey,
      evidenceVersionIds: context.evidence.map((evidence) => evidence.id),
      confidence,
      rationale:
        confidence === "probable"
          ? "The current definition and continuity evidence identify predecessor A."
          : "Both historical definitions remain plausible.",
    };
  }

  it("applies probable continuity atomically across alias, Subject continuity, and Candidate state", async () => {
    const provider = new FixtureProvider((request) =>
      selectedOutput(request, "probable"),
    );

    const result = await runSemanticPublicSymbolContinuity({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "evaluated",
      groups: 1,
      providerCalls: 1,
      correlatedCandidateIds: [expect.any(String)],
      ambiguousCandidateIds: [],
      continuityIds: [expect.any(String)],
      supersededCandidateIds: [expect.any(String)],
      failures: [],
    });
    const current = new CandidateStore(database).current(CURRENT_CANDIDATE)!;
    expect(current.state).toBe("superseded");
    expect(
      database
        .prepare(
          `SELECT subject.identity_key
           FROM subject_aliases alias
           JOIN subject_identities subject
             ON subject.id = alias.subject_identity_id
           WHERE alias.alias_kind = 'cari-symbol-id'
             AND alias.alias_key = ?`,
        )
        .get("current-symbol"),
    ).toEqual({ identity_key: PREDECESSOR_SUBJECT_A });
    expect(
      database
        .prepare(
          `SELECT basis, confidence
           FROM subject_continuity
           WHERE from_subject_identity_id = ?
             AND to_subject_identity_id = ?`,
        )
        .get(
          "subject:" + fingerprint(PREDECESSOR_SUBJECT_A),
          "subject:" + fingerprint(CURRENT_SUBJECT),
        ),
    ).toEqual({
      basis: "semantic-public-symbol-continuity",
      confidence: "probable",
    });
  });

  it("keeps ambiguous predecessor selection Candidate-only", async () => {
    const provider = new FixtureProvider((request) =>
      selectedOutput(request, "ambiguous"),
    );

    const result = await runSemanticPublicSymbolContinuity({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "evaluated",
      groups: 1,
      providerCalls: 1,
      correlatedCandidateIds: [],
      ambiguousCandidateIds: [expect.any(String)],
      continuityIds: [],
      supersededCandidateIds: [],
      failures: [],
    });
    expect(new CandidateStore(database).current(CURRENT_CANDIDATE)!.state).toBe(
      "discovered",
    );
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM subject_aliases`).get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM subject_continuity`)
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rejects an invented predecessor without mutating continuity", async () => {
    const provider = new FixtureProvider((request) =>
      selectedOutput(
        request,
        "probable",
        "public-symbol-doc:invented",
        "symbol:invented",
      ),
    );

    const result = await runSemanticPublicSymbolContinuity({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "failed",
      providerCalls: 1,
      correlatedCandidateIds: [],
      continuityIds: [],
      failures: [{ kind: "ungrounded_output" }],
    });
    expect(new CandidateStore(database).current(CURRENT_CANDIDATE)!.state).toBe(
      "discovered",
    );
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM subject_continuity`)
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rejects probable continuity that omits current Symbol Evidence", async () => {
    const provider = new FixtureProvider((request) => {
      const context = JSON.parse(request.messages[0]!.content) as {
        evidence: Array<{ id: string }>;
      };
      return {
        selectedPredecessorCandidateIdentityKey: PREDECESSOR_A,
        selectedPredecessorSubjectIdentityKey: PREDECESSOR_SUBJECT_A,
        evidenceVersionIds: [context.evidence[0]!.id],
        confidence: "probable",
        rationale: "Only one EvidenceVersion was supplied.",
      };
    });

    const result = await runSemanticPublicSymbolContinuity({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "failed",
      correlatedCandidateIds: [],
      failures: [{ kind: "ungrounded_output" }],
    });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM subject_continuity`)
        .get(),
    ).toEqual({ count: 0 });
  });
});
