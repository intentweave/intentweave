// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
function seedCandidate(database: Database.Database): string {
  const subject = {
    kind: "symbol" as const,
    identityKey: "symbol:parse-config",
    displayName: "parseConfig",
    role: "subject",
    basis: "cari-symbol",
    confidence: "certain" as const,
  };
  const evidence = new ClaimsStore(database).persistGenericEvidence({
    subjects: [subject],
    sourceKind: "code-symbol",
    identityKey: "code-symbol:parse-config",
    fingerprint: fingerprint({ signature: "parseConfig()" }),
    materialFingerprint: fingerprint({ signature: "parseConfig()" }),
    normalizedValue: { signature: "parseConfig()" },
    semanticLocation: "symbol:parse-config",
    provenance: { adapter: "g6a-cli-test" },
    filePath: "src/api.ts",
    spanStartLine: 2,
    spanEndLine: 2,
  });
  return new CandidateStore(database).persist({
    identityKey: "public-symbol-doc:parse-config",
    candidateKind: "public-symbol-documentation",
    proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
    discoveryMode: "deterministic",
    discoveryAdapterId: "g6a-cli-test",
    discoveryContractVersion: "1",
    confidence: "certain",
    normalizedStatement: {
      symbolName: "parseConfig",
      symbolKind: "function",
      requirement: "public-symbol-is-documented",
    },
    provenance: { repositoryRevision: "g6a-cli-test" },
    evidence: [
      {
        evidenceKey: "code-symbol:parse-config",
        evidenceVersionId: evidence.id,
        sourceKind: "code-symbol",
        role: "symbol",
        provenance: {},
      },
    ],
    subjects: [subject],
  }).id;
}

import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  initSchema,
} from "@intentweave/index";
import {
  parsePortableClaimsStateYaml,
  writePortableClaimsState,
} from "../claims/portableState.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shortCandidateReference } from "../claims/presentation.js";
import {
  runClaimsCandidateReview,
  runClaimsCandidatesList,
  runClaimsCandidatesRecommend,
  runClaimsCandidatesTriage,
  runClaimsExplain,
} from "./claims.js";

describe("iw claims candidates recommend", () => {
  const originalCwd = process.cwd();
  const workspaces: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  function workspace(withConfig = true): string {
    const root = mkdtempSync(path.join(tmpdir(), "iw-g6a-recommend-"));
    workspaces.push(root);
    mkdirSync(path.join(root, ".iw", "claims"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    if (withConfig) {
      writeFileSync(
        path.join(root, ".iw", "claims", "inference.yaml"),
        `schemaVersion: "1"
providers:
  allow: ["openai"]
sensitivePaths: ["secrets/**"]
budgets:
  maxCandidates: 5
  maxEvidencePerCandidate: 4
  maxExcerptChars: 500
  maxTokensPerCandidate: 2000
  maxTotalTokens: 5000
  maxEstimatedCostUsd: 0.5
  maxConcurrency: 1
`,
      );
    }
    writeFileSync(
      path.join(root, "src", "api.ts"),
      "/** Parse repository configuration. */\nexport function parseConfig() {}\n",
    );
    const database = new Database(path.join(root, ".iw", "index.db"));
    initSchema(database);
    seedCandidate(database);
    database.close();
    return root;
  }

  it("prints the exact preview without invoking a model", async () => {
    const root = workspace();
    process.chdir(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runClaimsCandidatesRecommend({
      semantic: true,
      preview: true,
      provider: "openai",
      format: "json",
    });

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      networkCallPerformed: boolean;
      summary: { includedCandidates: number };
      contexts: Array<{
        candidate: { claimType: string };
        security: { toolExecutionAllowed: boolean };
      }>;
    };
    expect(output).toMatchObject({
      networkCallPerformed: false,
      summary: { includedCandidates: 1 },
      contexts: [
        {
          candidate: { claimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED" },
          security: { toolExecutionAllowed: false },
        },
      ],
    });
  });

  it("runs an explicit batch and reuses cached work on the next run", async () => {
    const root = workspace();
    process.chdir(root);
    writeFileSync(
      path.join(root, ".iw", "claims", "inference.yaml"),
      `schemaVersion: "2"
providers:
  allow: ["openai"]
sensitivePaths: ["secrets/**"]
budgets:
  maxCandidates: 5
  maxEvidencePerCandidate: 4
  maxExcerptChars: 500
  maxTokensPerCandidate: 2000
  maxTotalTokens: 5000
  maxEstimatedCostUsd: 1
  maxConcurrency: 1
  maxOutputTokensPerCandidate: 100
  maxReasoningTokensPerCandidate: 50
prices:
  - providerId: openai
    requestedModelId: gpt-4o
    version: fixture-v1
    effectiveDate: 2026-10-10
    inputPerMillionUsd: 1
    cachedInputPerMillionUsd: 0.1
    outputPerMillionUsd: 2
    reasoningPerMillionUsd: 3
`,
    );
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    const database = new Database(path.join(root, ".iw", "index.db"));
    const candidate = new CandidateStore(database).listCurrent()[0]!;
    const details = new CandidateStore(database).details(candidate.id)!;
    const evidenceVersionId = details.evidence[0]!.evidenceVersionId!;
    database.close();
    const output = {
      recommendation: "promote",
      rationale: "The batch fixture is grounded.",
      evidenceVersionIds: [evidenceVersionId],
      confidence: "probable",
      priority: "high",
      proposedClaimType: details.proposedClaimType,
      proposedSubjectBindings: details.subjects.map((subject) => ({
        kind: subject.kind,
        identityKey: subject.identityKey,
        role: subject.role,
      })),
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-batch",
            model: "gpt-4o",
            choices: [
              {
                message: { content: JSON.stringify(output) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 90, completion_tokens: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const command = {
      semantic: true,
      batch: true,
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    };
    await runClaimsCandidatesRecommend(command);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      summary: { created: 1, cached: 0, failed: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    log.mockClear();
    await runClaimsCandidatesRecommend(command);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      summary: { created: 0, cached: 1, failed: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses recommendation execution before G6b", async () => {
    const root = workspace();
    process.chdir(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runClaimsCandidatesRecommend({
      semantic: true,
      preview: false,
      provider: "openai",
      format: "json",
    });

    expect(process.exitCode).toBe(64);
    expect(error.mock.calls.at(-1)?.[0]).toContain("requires --candidate");
  });

  it("executes one Candidate, reuses the cache, and refreshes append-only history", async () => {
    const root = workspace();
    process.chdir(root);
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    const database = new Database(path.join(root, ".iw", "index.db"));
    const candidate = new CandidateStore(database).listCurrent()[0]!;
    const details = new CandidateStore(database).details(candidate.id)!;
    const evidenceVersionId = details.evidence[0]!.evidenceVersionId!;
    database.close();
    const response = {
      recommendation: "promote",
      rationale: "The public symbol has grounded documentation Evidence.",
      evidenceVersionIds: [evidenceVersionId],
      confidence: "probable",
      priority: "high",
      proposedClaimType: details.proposedClaimType,
      proposedSubjectBindings: details.subjects.map((subject) => ({
        kind: subject.kind,
        identityKey: subject.identityKey,
        role: subject.role,
      })),
    };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-g6b2",
            model: "gpt-4o",
            choices: [
              {
                message: { content: JSON.stringify(response) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 40 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const commandInput = {
      semantic: true,
      candidate: shortCandidateReference(candidate.id),
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    };
    await runClaimsCandidatesRecommend(commandInput);
    const first = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      status: string;
      recommendation: { inferenceId: string };
      providerMeta: { finishReason: string };
    };
    expect(first).toMatchObject({
      status: "created",
      recommendation: { recommendation: "promote" },
      providerMeta: { finishReason: "stop" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    log.mockClear();
    await runClaimsCandidatesList({
      all: true,
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      candidates: [
        {
          recommendations: [
            expect.objectContaining({
              status: "current",
              decision: "promote",
              priority: "high",
            }),
          ],
        },
      ],
    });

    log.mockClear();
    await runClaimsExplain({
      claim: shortCandidateReference(candidate.id),
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      recommendations: [
        expect.objectContaining({ status: "current", decision: "promote" }),
      ],
    });

    log.mockClear();
    await runClaimsCandidatesRecommend(commandInput);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "cached",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    log.mockClear();
    await runClaimsCandidatesRecommend({ ...commandInput, refresh: true });
    const refreshed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      status: string;
      failure?: unknown;
    };
    expect(refreshed).toMatchObject({ status: "created" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const drifted = new Database(path.join(root, ".iw", "index.db"));
    drifted
      .prepare(
        `UPDATE candidate_inferences
         SET adapter_id = 'historical-adapter', prompt_version = 'historical-prompt'`,
      )
      .run();
    drifted.close();
    log.mockClear();
    await runClaimsCandidatesList({
      all: true,
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      candidates: [
        {
          recommendations: [
            expect.objectContaining({ status: "stale" }),
            expect.objectContaining({ status: "stale" }),
          ],
        },
      ],
    });
    log.mockClear();
    await runClaimsExplain({
      claim: shortCandidateReference(candidate.id),
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      recommendations: [
        expect.objectContaining({ status: "stale" }),
        expect.objectContaining({ status: "stale" }),
      ],
    });

    const persisted = new Database(path.join(root, ".iw", "index.db"), {
      readonly: true,
    });
    expect(
      persisted
        .prepare(
          `SELECT COUNT(*) AS count FROM candidate_inferences WHERE inference_identity_key = ?`,
        )
        .get(details.identityKey),
    ).toEqual({ count: 2 });
    expect(
      persisted
        .prepare(
          `SELECT COUNT(*) AS count FROM candidate_reviews WHERE actor_kind = 'ai' AND effect = 'recommendation'`,
        )
        .get(),
    ).toEqual({ count: 2 });
    persisted.close();
  });

  it("returns typed provider failures without persisting an Inference or Review", async () => {
    const root = workspace();
    process.chdir(root);
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    const database = new Database(path.join(root, ".iw", "index.db"));
    const candidate = new CandidateStore(database).listCurrent()[0]!;
    database.close();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "chatcmpl-filtered",
            model: "gpt-4o",
            choices: [
              {
                message: { content: "" },
                finish_reason: "content_filter",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runClaimsCandidatesRecommend({
      semantic: true,
      candidate: shortCandidateReference(candidate.id),
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    });

    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "failed",
      failure: { kind: "content_filter" },
    });
    const persisted = new Database(path.join(root, ".iw", "index.db"), {
      readonly: true,
    });
    expect(
      persisted
        .prepare(`SELECT COUNT(*) AS count FROM candidate_inferences`)
        .get(),
    ).toEqual({
      count: 0,
    });
    expect(
      persisted
        .prepare(`SELECT COUNT(*) AS count FROM candidate_reviews`)
        .get(),
    ).toEqual({
      count: 0,
    });
    persisted.close();
    expect(process.exitCode).toBe(1);
  });

  it("links a human decision and explains its portable basis after a fresh import", async () => {
    const root = workspace();
    process.chdir(root);
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    const initial = new Database(path.join(root, ".iw", "index.db"));
    const initialCandidate = new CandidateStore(initial).listCurrent()[0]!;
    const details = new CandidateStore(initial).details(initialCandidate.id)!;
    const evidenceVersionId = details.evidence[0]!.evidenceVersionId!;
    initial.close();
    const response = {
      recommendation: "promote",
      rationale: "The public symbol has grounded documentation Evidence.",
      evidenceVersionIds: [evidenceVersionId],
      confidence: "probable",
      priority: "high",
      proposedClaimType: details.proposedClaimType,
      proposedSubjectBindings: details.subjects.map((subject) => ({
        kind: subject.kind,
        identityKey: subject.identityKey,
        role: subject.role,
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-portable",
              model: "gpt-4o",
              choices: [
                {
                  message: { content: JSON.stringify(response) },
                  finish_reason: "stop",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runClaimsCandidatesRecommend({
      semantic: true,
      candidate: shortCandidateReference(initialCandidate.id),
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    });
    const recommendationOutput = JSON.parse(
      String(log.mock.calls.at(-1)?.[0]),
    ) as { review: { id: string } };
    const recommendationId = recommendationOutput.review.id;

    log.mockClear();
    await runClaimsCandidatesTriage({
      candidate: shortCandidateReference(initialCandidate.id),
      format: "json",
    });
    const triaged = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string }>;
    };

    writePortableClaimsState(root, {
      schemaVersion: "2",
      policies: {
        "changed-context": {
          version: "1",
          enabled: true,
          configuration: {},
        },
      },
      candidateDecisions: {},
      subjectBindings: {},
      assessmentReviews: {},
      baselineAcceptances: {},
      claimOrigins: {},
    });
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsCandidateReview({
      candidate: shortCandidateReference(triaged.candidates[0]!.id),
      actor: "benjamin",
      decision: "reject",
      rationale: "This must not accept a stale context.",
      basedOnRecommendation: recommendationId,
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    });
    expect(process.exitCode).toBe(64);
    const afterStaleReview = new Database(path.join(root, ".iw", "index.db"), {
      readonly: true,
    });
    expect(
      afterStaleReview
        .prepare(
          `SELECT COUNT(*) AS count FROM candidate_reviews WHERE effect = 'effective'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    afterStaleReview.close();

    writePortableClaimsState(root, {
      schemaVersion: "2",
      policies: {},
      candidateDecisions: {},
      subjectBindings: {},
      assessmentReviews: {},
      baselineAcceptances: {},
      claimOrigins: {},
    });
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsCandidateReview({
      candidate: shortCandidateReference(triaged.candidates[0]!.id),
      actor: "benjamin",
      decision: "reject",
      rationale: "The human reviewer disagrees with the recommendation.",
      basedOnRecommendation: recommendationId,
      provider: "openai",
      model: "gpt-4o",
      format: "json",
    });
    const reviewOutput = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      basedOnRecommendationId: string;
      portableStatePath: string;
    };
    expect(reviewOutput.basedOnRecommendationId).toBe(recommendationId);
    const portable = parsePortableClaimsStateYaml(
      readFileSync(reviewOutput.portableStatePath, "utf-8"),
    );
    const decision = portable.candidateDecisions[details.identityKey]!;
    expect(decision.recommendationBasis).toMatchObject({
      recommendation: "promote",
      priority: "high",
      requestedModelId: "gpt-4o",
    });

    rmSync(path.join(root, ".iw", "index.db"));
    const freshDatabase = new Database(path.join(root, ".iw", "index.db"));
    initSchema(freshDatabase);
    const freshCandidateId = seedCandidate(freshDatabase);
    freshDatabase.close();
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsExplain({
      claim: shortCandidateReference(freshCandidateId),
      format: "json",
    });
    const explanation = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      recommendations: Array<{
        status: string;
        recommendationBasis?: { recommendationKey: string };
      }>;
    };
    expect(explanation.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "portable",
          recommendationBasis: expect.objectContaining({
            recommendationKey: decision.recommendationBasis?.recommendationKey,
          }),
        }),
      ]),
    );
  });

  it("requires repository-level provider approval even for preview", async () => {
    const root = workspace(false);
    process.chdir(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runClaimsCandidatesRecommend({
      semantic: true,
      preview: true,
      provider: "openai",
      format: "json",
    });

    expect(process.exitCode).toBe(64);
    expect(error.mock.calls.at(-1)?.[0]).toContain(
      "Missing .iw/claims/inference.yaml",
    );
  });
});
