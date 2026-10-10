// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCandidateRecommendationBatch } from "./candidateRecommendationBatch.js";
import { parseCandidateInferenceConfig } from "./candidateRecommendationContext.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function seed(
  database: Database.Database,
  root: string,
  identityKey: string,
): void {
  const filePath = `src/${identityKey}.ts`;
  writeFileSync(
    path.join(root, filePath),
    `/** ${identityKey} */\nexport function ${identityKey}() {}\n`,
  );
  const subject = {
    kind: "symbol" as const,
    identityKey: `symbol:${identityKey}`,
    displayName: identityKey,
    role: "subject",
    basis: "fixture",
    confidence: "certain" as const,
  };
  const evidence = new ClaimsStore(database).persistGenericEvidence({
    subjects: [subject],
    sourceKind: "code-symbol",
    identityKey: `evidence:${identityKey}`,
    fingerprint: fingerprint(identityKey),
    materialFingerprint: fingerprint(identityKey),
    normalizedValue: { identityKey },
    semanticLocation: `symbol:${identityKey}`,
    provenance: { fixture: true },
    filePath,
    spanStartLine: 2,
    spanEndLine: 2,
  });
  new CandidateStore(database).persist({
    identityKey: `candidate:${identityKey}`,
    candidateKind: "public-symbol-documentation",
    proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
    discoveryMode: "deterministic",
    discoveryAdapterId: "batch-test",
    discoveryContractVersion: "1",
    confidence: "certain",
    normalizedStatement: { identityKey },
    provenance: { fixture: true },
    evidence: [
      {
        evidenceKey: `evidence:${identityKey}`,
        evidenceVersionId: evidence.id,
        sourceKind: "code-symbol",
        role: "source",
        provenance: {},
      },
    ],
    subjects: [subject],
  });
}

function config(maxTotalTokens = 10_000, maxEstimatedCostUsd = 1) {
  return parseCandidateInferenceConfig({
    schemaVersion: "2",
    providers: { allow: ["fixture"] },
    budgets: {
      maxCandidates: 10,
      maxEvidencePerCandidate: 4,
      maxExcerptChars: 500,
      maxTokensPerCandidate: 2_000,
      maxTotalTokens,
      maxEstimatedCostUsd,
      maxConcurrency: 2,
      maxOutputTokensPerCandidate: 20,
      maxReasoningTokensPerCandidate: 10,
    },
    prices: [
      {
        providerId: "fixture",
        requestedModelId: "fixture-model",
        version: "fixture-v1",
        effectiveDate: "2026-10-10",
        inputPerMillionUsd: 1,
        cachedInputPerMillionUsd: 0.1,
        outputPerMillionUsd: 2,
        reasoningPerMillionUsd: 3,
      },
    ],
  });
}

const capabilities: LLMProviderCapabilities = {
  maxInputTokens: 100_000,
  supportsJsonSchema: true,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsEmbeddings: false,
  structuredOutputModes: ["strict"],
  enforcesCompletionTokenLimit: true,
};

class BatchProvider implements LLMProviderV2 {
  readonly name = "fixture";
  readonly contractVersion = 2 as const;
  readonly capabilities = capabilities;
  active = 0;
  maximumActive = 0;
  readonly complete = vi.fn(
    async (request: LLMRequest): Promise<LLMResponse> => {
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      const serialized = request.messages.at(-1)!.content;
      const context = JSON.parse(
        serialized.match(
          /<repository-context>\n([\s\S]+)\n<\/repository-context>/,
        )![1]!,
      ) as {
        candidate: { statement: { identityKey: string }; claimType: string };
        evidence: Array<{ id: string }>;
        subjects: Array<{ kind: "symbol"; identityKey: string; role: string }>;
      };
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.active -= 1;
      if (context.candidate.statement.identityKey === "beta") {
        return {
          content: "",
          tokensUsed: { prompt: 11, completion: 0 },
          latencyMs: 5,
          model: "fixture-model",
          finishReason: "error",
          errorKind: "provider",
          error: "fixture failure",
        };
      }
      const output = {
        recommendation: "promote",
        rationale: "Grounded fixture recommendation",
        evidenceVersionIds: context.evidence.map((item) => item.id),
        confidence: "probable",
        priority:
          context.candidate.statement.identityKey === "alpha" ? "high" : "low",
        proposedClaimType: context.candidate.claimType,
        proposedSubjectBindings: context.subjects.map((subject) => ({
          kind: subject.kind,
          identityKey: subject.identityKey,
          role: subject.role,
        })),
      };
      return {
        content: JSON.stringify(output),
        parsed: output,
        tokensUsed: {
          prompt: 11,
          completion: 7,
          reasoning: 2,
          cachedPrompt: 1,
        },
        latencyMs: 5,
        model: "fixture-model",
        finishReason: "stop",
      };
    },
  );

  async isAvailable(): Promise<boolean> {
    return true;
  }

  capabilitiesFor(): LLMProviderCapabilities {
    return capabilities;
  }

  getModelName(): string {
    return "fixture-model";
  }
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "iw-g6b3-batch-"));
  workspaces.push(root);
  mkdirSync(path.join(root, "src"));
  const database = new Database(":memory:");
  initSchema(database);
  for (const identity of ["alpha", "beta", "gamma"]) {
    seed(database, root, identity);
  }
  return { root, database };
}

describe("G6b.3 Candidate recommendation batch", () => {
  it("bounds concurrency, preserves partial results, and reports cost", async () => {
    const { root, database } = fixture();
    const provider = new BatchProvider();
    const result = await executeCandidateRecommendationBatch({
      database,
      workspaceRoot: root,
      config: config(),
      enabledPolicyIds: [],
      provider,
      requestedModelId: "fixture-model",
      refresh: false,
    });

    expect(result.summary).toMatchObject({
      created: 2,
      failed: 1,
      cached: 0,
      cancelled: 0,
      budgetDeferred: 0,
      ineligible: 0,
      actualCostUsd: null,
      costUnknown: true,
      usageUnknown: true,
    });
    expect(provider.maximumActive).toBe(2);
    expect(result.items.map((item) => item.status)).toEqual([
      "created",
      "created",
      "failed",
    ]);
    expect(result.items.at(-1)).toMatchObject({
      usage: null,
      costUnknown: true,
      actualCostUsd: null,
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM candidate_inferences")
        .get(),
    ).toEqual({ count: 2 });
    database.close();
  });

  it("defers work before calls when token budgets are exhausted", async () => {
    const { root, database } = fixture();
    const provider = new BatchProvider();
    const result = await executeCandidateRecommendationBatch({
      database,
      workspaceRoot: root,
      config: config(256),
      enabledPolicyIds: [],
      provider,
      requestedModelId: "fixture-model",
      refresh: false,
    });

    expect(result.summary.budgetDeferred).toBeGreaterThan(0);
    expect(provider.complete.mock.calls.length).toBeLessThan(3);
    database.close();
  });

  it("does not schedule provider calls after cancellation", async () => {
    const { root, database } = fixture();
    const provider = new BatchProvider();
    const controller = new AbortController();
    controller.abort();
    const result = await executeCandidateRecommendationBatch({
      database,
      workspaceRoot: root,
      config: config(),
      enabledPolicyIds: [],
      provider,
      requestedModelId: "fixture-model",
      refresh: false,
      signal: controller.signal,
    });

    expect(result.summary.cancelled).toBe(3);
    expect(provider.complete).not.toHaveBeenCalled();
    database.close();
  });

  it("treats a zero cost cap as cache-only execution", async () => {
    const { root, database } = fixture();
    const provider = new BatchProvider();
    const result = await executeCandidateRecommendationBatch({
      database,
      workspaceRoot: root,
      config: config(10_000, 0),
      enabledPolicyIds: [],
      provider,
      requestedModelId: "fixture-model",
      refresh: false,
    });

    expect(result.summary.budgetDeferred).toBe(3);
    expect(provider.complete).not.toHaveBeenCalled();
    database.close();
  });

  it("lets cache hits bypass the uncached candidate and token budgets", async () => {
    const { root, database } = fixture();
    const provider = new BatchProvider();
    const initial = await executeCandidateRecommendationBatch({
      database,
      workspaceRoot: root,
      config: config(),
      enabledPolicyIds: [],
      provider,
      requestedModelId: "fixture-model",
      refresh: false,
    });
    expect(initial.summary.created).toBe(2);
    const callsAfterInitial = provider.complete.mock.calls.length;

    const constrained = await executeCandidateRecommendationBatch({
      database,
      workspaceRoot: root,
      config: config(256),
      enabledPolicyIds: [],
      provider,
      requestedModelId: "fixture-model",
      refresh: false,
    });

    expect(constrained.summary.cached).toBe(2);
    expect(constrained.summary.budgetDeferred).toBe(1);
    expect(provider.complete.mock.calls.length).toBe(callsAfterInitial);
    database.close();
  });

  it("reports closed Candidates as ineligible instead of budget-deferred", async () => {
    const { root, database } = fixture();
    const store = new CandidateStore(database);
    const closed = store.current("candidate:gamma")!;
    const triaged = store.transition(closed.id, "triaged", {
      basis: "batch-test",
    });
    store.review({
      candidateId: triaged.id,
      actorKind: "human",
      actorId: "fixture",
      decision: "reject",
      effect: "effective",
      rationale: "Closed for batch eligibility test",
      provenance: {},
    });
    const result = await executeCandidateRecommendationBatch({
      database,
      workspaceRoot: root,
      config: config(),
      enabledPolicyIds: [],
      provider: new BatchProvider(),
      requestedModelId: "fixture-model",
      refresh: false,
    });

    expect(result.summary.ineligible).toBe(1);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateIdentityKey: "candidate:gamma",
          status: "ineligible",
        }),
      ]),
    );
    database.close();
  });
});
