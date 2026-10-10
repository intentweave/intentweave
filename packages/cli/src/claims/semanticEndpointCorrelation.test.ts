// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
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
import { runSemanticEndpointCorrelation } from "./semanticEndpointCorrelation.js";

const CAPABILITIES: LLMProviderCapabilities = {
  maxInputTokens: 32_000,
  supportsJsonSchema: true,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsEmbeddings: false,
  structuredOutputModes: ["strict"],
};

class FixtureProvider implements LLMProviderV2 {
  readonly name = "endpoint-fixture-v2";
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
      tokensUsed: { prompt: 50, completion: 12 },
      latencyMs: 5,
      model: "endpoint-fixture-model",
      requestId: `endpoint-fixture-request-${this.calls}`,
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
    return "endpoint-fixture-model";
  }
}

describe("semantic Endpoint authentication correlation", () => {
  let database: Database.Database;
  let candidateIdentityKey: string;
  let evidenceVersionIds: string[];
  let subjectBindings: Array<{
    subjectIdentityKey: string;
    role: string;
  }>;

  beforeEach(() => {
    database = new Database(":memory:");
    initSchema(database);
    const claims = new ClaimsStore(database);
    const endpoint = {
      kind: "endpoint" as const,
      identityKey: "endpoint:generic:GET:/admin/users",
      displayName: "GET /admin/users",
      role: "endpoint",
      basis: "fixture-route",
      confidence: "ambiguous" as const,
    };
    const handler = {
      kind: "symbol" as const,
      identityKey: "symbol:generic:AdminController.createUser",
      displayName: "AdminController.createUser",
      role: "handler",
      basis: "fixture-handler",
      confidence: "ambiguous" as const,
    };
    const guard = {
      kind: "symbol" as const,
      identityKey: "symbol:generic:requireAdmin",
      displayName: "requireAdmin",
      role: "guard",
      basis: "fixture-protection",
      confidence: "ambiguous" as const,
    };
    const subjects = [endpoint, handler, guard];
    const evidence = [
      {
        key: "route",
        sourceKind: "framework-route",
        value: {
          method: "GET",
          path: "/admin/users",
          pathKnown: true,
        },
        role: "route",
      },
      {
        key: "handler",
        sourceKind: "route-handler",
        value: {
          handler: "AdminController.createUser",
          callGraph: "router -> createUser",
        },
        role: "handler",
      },
      {
        key: "guard",
        sourceKind: "authentication-guard",
        value: {
          mechanism: "requireAdmin",
          order: "before-handler",
        },
        role: "guard",
      },
    ];
    evidenceVersionIds = evidence.map(
      (item) =>
        claims.persistGenericEvidence({
          subjects,
          sourceKind: item.sourceKind,
          identityKey: `fixture-endpoint:${item.key}`,
          fingerprint: fingerprint(item.value),
          materialFingerprint: fingerprint(item.value),
          normalizedValue: item.value,
          semanticLocation: `GET /admin/users:${item.role}`,
          provenance: { fixture: true },
        }).id,
    );
    candidateIdentityKey =
      "endpoint-auth:generic:GET:/admin/users:requireAdmin";
    new CandidateStore(database).persist({
      identityKey: candidateIdentityKey,
      candidateKind: "endpoint-authentication",
      proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
      discoveryMode: "deterministic",
      discoveryAdapterId: "fixture-generic-endpoint",
      discoveryContractVersion: "1",
      confidence: "ambiguous",
      normalizedStatement: {
        method: "GET",
        path: "/admin/users",
        requirement: "endpoint-is-authenticated",
      },
      provenance: { fixture: true },
      evidence: evidence.map((item, index) => ({
        evidenceKey: `fixture-endpoint:${item.key}`,
        evidenceVersionId: evidenceVersionIds[index],
        sourceKind: item.sourceKind,
        role: item.role,
        provenance: { fixture: true },
      })),
      subjects,
    });
    subjectBindings = subjects.map((subject) => ({
      subjectIdentityKey: subject.identityKey,
      role: subject.role,
    }));
  });

  it("correlates an unresolved endpoint from grounded route, handler, and protection evidence", async () => {
    const provider = new FixtureProvider((request) => {
      const context = JSON.parse(request.messages[0]!.content) as {
        workItem: { candidateIdentityKeys: string[] };
        evidence: Array<{ id: string }>;
      };
      return {
        selectedCandidateIdentityKey: context.workItem.candidateIdentityKeys[0],
        evidenceVersionIds: context.evidence.map((evidence) => evidence.id),
        subjectBindings,
        confidence: "probable",
        rationale:
          "The route invokes the handler after the requireAdmin protection helper.",
      };
    });

    const result = await runSemanticEndpointCorrelation({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "evaluated",
      groups: 1,
      providerCalls: 1,
      correlatedCandidateIds: [expect.any(String)],
      ambiguousCandidateIds: [],
      failures: [],
    });
    expect(provider.calls).toBe(1);
    expect(
      new CandidateStore(database).details(
        new CandidateStore(database).current(candidateIdentityKey)!.id,
      ),
    ).toMatchObject({
      state: "correlated",
      confidence: "probable",
      inferenceId: result.inferenceIds[0],
    });
  });

  it("keeps a plausible but ambiguous protection binding unbound", async () => {
    const provider = new FixtureProvider((request) => {
      const context = JSON.parse(request.messages[0]!.content) as {
        workItem: { candidateIdentityKeys: string[] };
        evidence: Array<{ id: string }>;
      };
      return {
        selectedCandidateIdentityKey: context.workItem.candidateIdentityKeys[0],
        evidenceVersionIds: context.evidence.map((evidence) => evidence.id),
        subjectBindings,
        confidence: "ambiguous",
        rationale:
          "The helper is present, but ordering relative to the router remains uncertain.",
      };
    });

    const result = await runSemanticEndpointCorrelation({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "evaluated",
      groups: 1,
      providerCalls: 1,
      correlatedCandidateIds: [],
      ambiguousCandidateIds: [expect.any(String)],
      failures: [],
    });
    expect(
      new CandidateStore(database).details(
        new CandidateStore(database).current(candidateIdentityKey)!.id,
      ),
    ).toMatchObject({
      state: "discovered",
      confidence: "ambiguous",
      inferenceId: result.inferenceIds[0],
    });
  });

  it("rejects output that omits the required protection Evidence", async () => {
    const provider = new FixtureProvider((request) => {
      const context = JSON.parse(request.messages[0]!.content) as {
        workItem: { candidateIdentityKeys: string[] };
      };
      return {
        selectedCandidateIdentityKey: context.workItem.candidateIdentityKeys[0],
        evidenceVersionIds: evidenceVersionIds.slice(0, 2),
        subjectBindings,
        confidence: "probable",
        rationale: "The route and handler look related.",
      };
    });

    const result = await runSemanticEndpointCorrelation({
      database,
      provider,
    });

    expect(result).toMatchObject({
      status: "failed",
      providerCalls: 1,
      correlatedCandidateIds: [],
      failures: [{ kind: "schema_mismatch" }],
    });
    expect(
      new CandidateStore(database).details(
        new CandidateStore(database).current(candidateIdentityKey)!.id,
      ),
    ).toMatchObject({ state: "discovered", confidence: "ambiguous" });
  });
});
