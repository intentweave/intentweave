// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import type { LLMProvider } from "@intentweave/core";
import {
  CANDIDATE_TRIAGE_RECOMMENDATION_ADAPTER_CONTRACT_VERSION,
  CANDIDATE_TRIAGE_RECOMMENDATION_ADAPTER_ID,
  CANDIDATE_TRIAGE_RECOMMENDATION_PROMPT_VERSION,
  CandidateStore,
  type CandidateDetails,
} from "@intentweave/index";
import {
  buildCandidateRecommendationPreview,
  CandidateInferenceConfigError,
  resolveCandidateModelPrice,
  type CandidateInferenceConfig,
  type CandidateModelPrice,
  type CandidateRecommendationContext,
} from "./candidateRecommendationContext.js";
import {
  executeCandidateRecommendation,
  type CandidateRecommendationExecutionResult,
} from "./candidateRecommendationExecution.js";

export type CandidateBatchItemStatus =
  | "created"
  | "cached"
  | "failed"
  | "cancelled"
  | "budget-deferred"
  | "ineligible";

export interface CandidateBatchItem {
  candidateId: string;
  candidateIdentityKey: string;
  claimType: string;
  status: CandidateBatchItemStatus;
  priority?: "critical" | "high" | "medium" | "low";
  reservedTokens: number;
  reservedCostUsd?: number;
  actualCostUsd?: number | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  } | null;
  costUnknown?: boolean;
  recommendationId?: string;
  inferenceId?: string;
  failure?: { kind: string; message: string; retryable: boolean };
  reason?: string;
}

export interface CandidateRecommendationBatchResult {
  contract: "candidate-recommendation-batch@1";
  providerId: string;
  requestedModelId: string;
  price: CandidateModelPrice | null;
  items: CandidateBatchItem[];
  summary: {
    selected: number;
    processed: number;
    created: number;
    cached: number;
    failed: number;
    cancelled: number;
    budgetDeferred: number;
    ineligible: number;
    reservedTokens: number;
    actualUsage: {
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      cachedInputTokens: number;
    };
    usageUnknown: boolean;
    reservedCostUsd: number | null;
    actualCostUsd: number | null;
    costUnknown: boolean;
  };
}

export interface CandidateRecommendationBatchInput {
  database: Database.Database;
  workspaceRoot: string;
  config: CandidateInferenceConfig;
  enabledPolicyIds: readonly string[];
  provider: LLMProvider;
  requestedModelId: string;
  refresh: boolean;
  limit?: number;
  signal?: AbortSignal;
}

interface PlannedCandidate {
  candidate: CandidateDetails;
  context: CandidateRecommendationContext;
  cached: boolean;
  reservedTokens: number;
  reservedCostUsd?: number;
}

const PRIORITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
} as const;

function roundedUsd(value: number): number {
  return Number(value.toFixed(8));
}

export function estimateCandidateRecommendationCost(
  price: CandidateModelPrice,
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  },
): number {
  const cachedInput = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  const regularInput = Math.max(0, usage.inputTokens - cachedInput);
  const reasoning = Math.min(usage.outputTokens, usage.reasoningTokens ?? 0);
  const regularOutput = Math.max(0, usage.outputTokens - reasoning);
  return roundedUsd(
    (regularInput * price.inputPerMillionUsd +
      cachedInput * price.cachedInputPerMillionUsd +
      regularOutput * price.outputPerMillionUsd +
      reasoning * price.reasoningPerMillionUsd) /
      1_000_000,
  );
}

function reservedCost(
  price: CandidateModelPrice,
  context: CandidateRecommendationContext,
  config: CandidateInferenceConfig,
): number {
  return estimateCandidateRecommendationCost(price, {
    inputTokens: context.estimatedTokens,
    outputTokens:
      config.budgets.maxOutputTokensPerCandidate +
      config.budgets.maxReasoningTokensPerCandidate,
    reasoningTokens: config.budgets.maxReasoningTokensPerCandidate,
  });
}

function isCurrentRecommendation(
  database: Database.Database,
  candidate: CandidateDetails,
  context: CandidateRecommendationContext,
  providerId: string,
  requestedModelId: string,
): boolean {
  return (
    new CandidateStore(database).recommendationStatus({
      identityKey: candidate.identityKey,
      observationFingerprint: candidate.observationFingerprint,
      contextFingerprint: context.contextFingerprint,
      adapterId: CANDIDATE_TRIAGE_RECOMMENDATION_ADAPTER_ID,
      adapterContractVersion:
        CANDIDATE_TRIAGE_RECOMMENDATION_ADAPTER_CONTRACT_VERSION,
      promptVersion: CANDIDATE_TRIAGE_RECOMMENDATION_PROMPT_VERSION,
      providerId,
      requestedModelId,
    }).currentRecommendationIds.length > 0
  );
}

function resultItem(
  planned: PlannedCandidate,
  result: CandidateRecommendationExecutionResult,
  price: CandidateModelPrice | undefined,
): CandidateBatchItem {
  const providerMeta = result.providerMeta;
  const usage = providerMeta
    ? providerMeta.usageReported
      ? providerMeta.usage
      : null
    : undefined;
  const breakdownUnknown =
    providerMeta !== undefined &&
    providerMeta.usageReported &&
    (((price?.cachedInputPerMillionUsd ?? 0) > 0 &&
      providerMeta.usage.cachedInputTokens === undefined) ||
      ((price?.reasoningPerMillionUsd ?? 0) > 0 &&
        providerMeta.usage.reasoningTokens === undefined));
  const costUnknown =
    providerMeta !== undefined &&
    (!providerMeta.usageReported || breakdownUnknown);
  const actualCostUsd =
    price && usage && !costUnknown
      ? estimateCandidateRecommendationCost(price, usage)
      : providerMeta
        ? null
        : undefined;
  if (result.status === "failed") {
    const cancelled = result.failure.kind === "cancelled";
    return {
      candidateId: planned.candidate.id,
      candidateIdentityKey: planned.candidate.identityKey,
      claimType: planned.candidate.proposedClaimType,
      status: cancelled ? "cancelled" : "failed",
      reservedTokens: planned.reservedTokens,
      ...(planned.reservedCostUsd === undefined
        ? {}
        : { reservedCostUsd: planned.reservedCostUsd }),
      ...(providerMeta ? { usage } : {}),
      ...(providerMeta ? { actualCostUsd, costUnknown } : {}),
      failure: result.failure,
    };
  }
  return {
    candidateId: planned.candidate.id,
    candidateIdentityKey: planned.candidate.identityKey,
    claimType: planned.candidate.proposedClaimType,
    status: result.status,
    priority: result.recommendation.priority,
    reservedTokens: planned.reservedTokens,
    ...(planned.reservedCostUsd === undefined
      ? {}
      : { reservedCostUsd: planned.reservedCostUsd }),
    ...(providerMeta ? { usage } : {}),
    ...(providerMeta ? { actualCostUsd, costUnknown } : {}),
    recommendationId: result.review.id,
    inferenceId: result.recommendation.inferenceId,
  };
}

function sortItems(items: CandidateBatchItem[]): CandidateBatchItem[] {
  return [...items].sort((left, right) => {
    const leftPriority = left.priority
      ? PRIORITY_ORDER[left.priority]
      : Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority
      ? PRIORITY_ORDER[right.priority]
      : Number.MAX_SAFE_INTEGER;
    return (
      leftPriority - rightPriority ||
      left.claimType.localeCompare(right.claimType) ||
      left.candidateIdentityKey.localeCompare(right.candidateIdentityKey)
    );
  });
}

export async function executeCandidateRecommendationBatch(
  input: CandidateRecommendationBatchInput,
): Promise<CandidateRecommendationBatchResult> {
  if (input.config.schemaVersion !== "2") {
    throw new CandidateInferenceConfigError(
      "Batch recommendation execution requires .iw/claims/inference.yaml schemaVersion 2",
    );
  }
  const capabilities = input.provider.capabilitiesFor?.(input.requestedModelId);
  if (!capabilities?.enforcesCompletionTokenLimit) {
    throw new CandidateInferenceConfigError(
      `Provider ${input.provider.name}/${input.requestedModelId} cannot enforce the configured completion-token budget`,
    );
  }
  const price = resolveCandidateModelPrice(
    input.config,
    input.provider.name,
    input.requestedModelId,
    input.provider.priceQuoteFor?.(input.requestedModelId),
  );
  if (input.config.budgets.maxEstimatedCostUsd > 0 && !price) {
    throw new CandidateInferenceConfigError(
      `No versioned price is available for ${input.provider.name}/${input.requestedModelId}; batch execution cannot enforce maxEstimatedCostUsd`,
    );
  }

  const preview = buildCandidateRecommendationPreview({
    database: input.database,
    workspaceRoot: input.workspaceRoot,
    provider: input.provider.name,
    requestedModelId: input.requestedModelId,
    refresh: input.refresh,
    includeCachedForBatch: true,
    config: input.config,
    enabledPolicyIds: input.enabledPolicyIds,
    limit: input.limit,
  });
  const store = new CandidateStore(input.database);
  const candidates = new Map(
    store.listCurrent().map((candidate) => [candidate.id, candidate]),
  );
  const includedIds = new Set(
    preview.contexts.map((context) => context.candidate.id),
  );
  const items: CandidateBatchItem[] = [];

  for (const eligibility of preview.eligibility) {
    if (includedIds.has(eligibility.candidateId)) continue;
    const candidate = candidates.get(eligibility.candidateId);
    if (!candidate) continue;
    items.push({
      candidateId: candidate.id,
      candidateIdentityKey: candidate.identityKey,
      claimType: candidate.proposedClaimType,
      status: eligibility.eligible ? "budget-deferred" : "ineligible",
      reservedTokens: 0,
      reason: eligibility.eligible
        ? "candidate, input-token, or configured batch limit"
        : eligibility.reasons.join(", "),
    });
  }

  let totalReservedTokens = 0;
  let totalReservedCost = 0;
  const planned: PlannedCandidate[] = [];
  for (const context of preview.contexts) {
    const candidate = candidates.get(context.candidate.id);
    if (!candidate) continue;
    const cached =
      !input.refresh &&
      isCurrentRecommendation(
        input.database,
        candidate,
        context,
        input.provider.name,
        input.requestedModelId,
      );
    const candidateReservedTokens = cached
      ? 0
      : context.estimatedTokens +
        input.config.budgets.maxOutputTokensPerCandidate +
        input.config.budgets.maxReasoningTokensPerCandidate;
    const candidateReservedCost =
      cached || !price ? 0 : reservedCost(price, context, input.config);
    if (!cached && input.config.budgets.maxEstimatedCostUsd === 0) {
      items.push({
        candidateId: candidate.id,
        candidateIdentityKey: candidate.identityKey,
        claimType: candidate.proposedClaimType,
        status: "budget-deferred",
        reservedTokens: 0,
        reason: "zero cost cap permits cache-only execution",
      });
      continue;
    }
    if (
      totalReservedTokens + candidateReservedTokens >
        input.config.budgets.maxTotalTokens ||
      totalReservedCost + candidateReservedCost >
        input.config.budgets.maxEstimatedCostUsd
    ) {
      items.push({
        candidateId: candidate.id,
        candidateIdentityKey: candidate.identityKey,
        claimType: candidate.proposedClaimType,
        status: "budget-deferred",
        reservedTokens: 0,
        reason: "total token or estimated-cost budget",
      });
      continue;
    }
    totalReservedTokens += candidateReservedTokens;
    totalReservedCost += candidateReservedCost;
    planned.push({
      candidate,
      context,
      cached,
      reservedTokens: candidateReservedTokens,
      ...(price ? { reservedCostUsd: candidateReservedCost } : {}),
    });
  }

  let cursor = 0;
  const workers = Array.from(
    {
      length: Math.min(
        input.config.budgets.maxConcurrency,
        Math.max(1, planned.length),
      ),
    },
    async () => {
      while (cursor < planned.length) {
        if (input.signal?.aborted) return;
        const current = planned[cursor++];
        if (!current) return;
        const result = await executeCandidateRecommendation({
          database: input.database,
          workspaceRoot: input.workspaceRoot,
          candidate: current.candidate,
          config: input.config,
          enabledPolicyIds: input.enabledPolicyIds,
          provider: input.provider,
          requestedModelId: input.requestedModelId,
          refresh: input.refresh,
          maxCompletionTokens:
            input.config.budgets.maxOutputTokensPerCandidate +
            input.config.budgets.maxReasoningTokensPerCandidate,
          signal: input.signal,
        });
        items.push(resultItem(current, result, price));
      }
    },
  );
  await Promise.all(workers);

  for (; cursor < planned.length; cursor += 1) {
    const current = planned[cursor]!;
    items.push({
      candidateId: current.candidate.id,
      candidateIdentityKey: current.candidate.identityKey,
      claimType: current.candidate.proposedClaimType,
      status: "cancelled",
      reservedTokens: current.reservedTokens,
      ...(current.reservedCostUsd === undefined
        ? {}
        : { reservedCostUsd: current.reservedCostUsd }),
      reason: "batch cancelled before scheduling",
    });
  }

  const sorted = sortItems(items);
  const actualUsage = sorted.reduce(
    (total, item) => ({
      inputTokens: total.inputTokens + (item.usage?.inputTokens ?? 0),
      outputTokens: total.outputTokens + (item.usage?.outputTokens ?? 0),
      reasoningTokens:
        total.reasoningTokens + (item.usage?.reasoningTokens ?? 0),
      cachedInputTokens:
        total.cachedInputTokens + (item.usage?.cachedInputTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  );
  return {
    contract: "candidate-recommendation-batch@1",
    providerId: input.provider.name,
    requestedModelId: input.requestedModelId,
    price: price ?? null,
    items: sorted,
    summary: {
      selected: sorted.length,
      processed: sorted.filter((item) =>
        ["created", "cached", "failed"].includes(item.status),
      ).length,
      created: sorted.filter((item) => item.status === "created").length,
      cached: sorted.filter((item) => item.status === "cached").length,
      failed: sorted.filter((item) => item.status === "failed").length,
      cancelled: sorted.filter((item) => item.status === "cancelled").length,
      budgetDeferred: sorted.filter((item) => item.status === "budget-deferred")
        .length,
      ineligible: sorted.filter((item) => item.status === "ineligible").length,
      reservedTokens: totalReservedTokens,
      actualUsage,
      usageUnknown: sorted.some((item) => item.usage === null),
      reservedCostUsd: price ? roundedUsd(totalReservedCost) : null,
      actualCostUsd:
        price && !sorted.some((item) => item.costUnknown)
          ? roundedUsd(
              sorted.reduce(
                (total, item) => total + (item.actualCostUsd ?? 0),
                0,
              ),
            )
          : null,
      costUnknown: sorted.some((item) => item.costUnknown),
    },
  };
}
