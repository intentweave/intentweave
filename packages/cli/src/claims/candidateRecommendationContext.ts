// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type Database from "@intentweave/sqlite-compat";
import { sanitizeExcerpt } from "@intentweave/core";
import {
  CandidateStore,
  canonicalJson,
  fingerprint,
  type CandidateDetails,
} from "@intentweave/index";
import { JSON_SCHEMA, load as yamlLoad } from "js-yaml";
import { minimatch } from "minimatch";

export const CANDIDATE_RECOMMENDATION_CONTEXT_CONTRACT =
  "candidate-recommendation-context@1";
export const CANDIDATE_RECOMMENDATION_ELIGIBILITY_CONTRACT =
  "candidate-recommendation-eligibility@1";
export const CLAIMS_INFERENCE_CONFIG_RELATIVE_PATH =
  ".iw/claims/inference.yaml";

export interface CandidateInferenceBudgets {
  maxCandidates: number;
  maxEvidencePerCandidate: number;
  maxExcerptChars: number;
  maxTokensPerCandidate: number;
  maxTotalTokens: number;
  maxEstimatedCostUsd: number;
  maxConcurrency: number;
}

export interface CandidateInferenceConfig {
  schemaVersion: "1";
  providers: { allow: string[] };
  sensitivePaths: string[];
  budgets: CandidateInferenceBudgets;
}

export type CandidateEligibilityReason =
  | "already-recommended"
  | "closed-candidate"
  | "explicit-declaration-use-policy"
  | "fixture-or-example-artifact"
  | "generated-artifact"
  | "low-value-literal"
  | "no-versioned-evidence"
  | "sensitive-only-evidence";

export interface CandidateRecommendationEligibility {
  candidateId: string;
  candidateFingerprint: string;
  claimType: string;
  state: string;
  confidence: string;
  eligible: boolean;
  reasons: CandidateEligibilityReason[];
}

export interface CandidateRecommendationContext {
  contract: typeof CANDIDATE_RECOMMENDATION_CONTEXT_CONTRACT;
  candidate: {
    id: string;
    fingerprint: string;
    kind: string;
    claimType: string;
    state: string;
    confidence: string;
    statement: unknown;
  };
  subjects: Array<{
    role: string;
    kind: string;
    identityKey: string;
    displayName: string;
    basis: string;
    confidence: string;
  }>;
  evidence: Array<{
    id: string;
    role: string;
    sourceKind: string;
    semanticLocation: string;
    filePath?: string;
    span?: { startLine: number; endLine: number };
    normalizedValue: unknown;
    sourceExcerpt?: string;
  }>;
  repositoryPolicies: string[];
  security: {
    repositoryContentIsUntrusted: true;
    toolExecutionAllowed: false;
    contentBoundary: "repository-data-only";
    redactionCount: number;
    omittedSensitiveEvidence: number;
  };
  estimatedTokens: number;
  contextFingerprint: string;
}

export interface CandidateRecommendationPreview {
  contract: "candidate-recommendation-preview@1";
  mode: "preview";
  semantic: true;
  eligibilityContract: typeof CANDIDATE_RECOMMENDATION_ELIGIBILITY_CONTRACT;
  provider: string;
  networkCallPerformed: false;
  budgets: CandidateInferenceBudgets;
  summary: {
    observedCandidates: number;
    eligibleCandidates: number;
    includedCandidates: number;
    excludedCandidates: number;
    deferredByBudget: number;
    estimatedInputTokens: number;
    duplicateGroups: number;
    firstScreenCandidates: number;
    firstScreenPolicyExcluded: number;
    byState: Record<string, number>;
    byClaimType: Record<string, number>;
    exclusionsByReason: Record<string, number>;
    precision: null;
    recall: null;
    qualityMeasurement: "requires-labeled-evaluation";
  };
  eligibility: CandidateRecommendationEligibility[];
  contexts: CandidateRecommendationContext[];
}

export class CandidateInferenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateInferenceConfigError";
  }
}

interface EvidenceRow {
  id: string;
  source_kind: string;
  normalized_value: string;
  semantic_location: string;
  file_path: string | null;
  span_start_line: number | null;
  span_end_line: number | null;
}

const DEFAULT_BUDGETS: CandidateInferenceBudgets = {
  maxCandidates: 20,
  maxEvidencePerCandidate: 8,
  maxExcerptChars: 1_200,
  maxTokensPerCandidate: 2_000,
  maxTotalTokens: 10_000,
  maxEstimatedCostUsd: 1,
  maxConcurrency: 2,
};
const DEFAULT_SENSITIVE_PATHS = [
  "**/.env*",
  "**/*.key",
  "**/*.pem",
  "secrets/**",
];

const GENERATED_PATH_PATTERNS = [
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/generated/**",
  "**/*.generated.*",
  "**/*.min.js",
];
const FIXTURE_PATH_PATTERNS = [
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/fixture/**",
  "**/fixtures/**",
  "**/example/**",
  "**/examples/**",
  "**/*.test.*",
  "**/*.spec.*",
];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CandidateInferenceConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new CandidateInferenceConfigError(
        `${label}.${key} is not supported`,
      );
    }
  }
}

function positiveInteger(
  value: unknown,
  label: string,
  fallback: number,
): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || Number(parsed) <= 0) {
    throw new CandidateInferenceConfigError(
      `${label} must be a positive integer`,
    );
  }
  return Number(parsed);
}

function integerAtLeast(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
): number {
  const parsed = positiveInteger(value, label, fallback);
  if (parsed < minimum) {
    throw new CandidateInferenceConfigError(
      `${label} must be at least ${minimum}`,
    );
  }
  return parsed;
}

function positiveNumber(
  value: unknown,
  label: string,
  fallback: number,
): number {
  const parsed = value ?? fallback;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    throw new CandidateInferenceConfigError(
      `${label} must be a positive number`,
    );
  }
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new CandidateInferenceConfigError(
      `${label} must be an array of non-empty strings`,
    );
  }
  return [...new Set(value)].sort();
}

export function parseCandidateInferenceConfig(
  value: unknown,
): CandidateInferenceConfig {
  const config = record(value, "Claims inference config");
  onlyKeys(config, "Claims inference config", [
    "schemaVersion",
    "providers",
    "sensitivePaths",
    "budgets",
  ]);
  if (config.schemaVersion !== "1") {
    throw new CandidateInferenceConfigError(
      "Claims inference config schemaVersion must be 1",
    );
  }
  const providers = record(config.providers, "providers");
  onlyKeys(providers, "providers", ["allow"]);
  const allow = stringArray(providers.allow, "providers.allow");
  if (allow.length === 0) {
    throw new CandidateInferenceConfigError(
      "providers.allow must explicitly allow at least one provider",
    );
  }
  const budgets = config.budgets ? record(config.budgets, "budgets") : {};
  onlyKeys(budgets, "budgets", Object.keys(DEFAULT_BUDGETS));
  return {
    schemaVersion: "1",
    providers: { allow },
    sensitivePaths: [
      ...new Set([
        ...DEFAULT_SENSITIVE_PATHS,
        ...(config.sensitivePaths === undefined
          ? []
          : stringArray(config.sensitivePaths, "sensitivePaths")),
      ]),
    ].sort(),
    budgets: {
      maxCandidates: positiveInteger(
        budgets.maxCandidates,
        "budgets.maxCandidates",
        DEFAULT_BUDGETS.maxCandidates,
      ),
      maxEvidencePerCandidate: positiveInteger(
        budgets.maxEvidencePerCandidate,
        "budgets.maxEvidencePerCandidate",
        DEFAULT_BUDGETS.maxEvidencePerCandidate,
      ),
      maxExcerptChars: integerAtLeast(
        budgets.maxExcerptChars,
        "budgets.maxExcerptChars",
        DEFAULT_BUDGETS.maxExcerptChars,
        64,
      ),
      maxTokensPerCandidate: integerAtLeast(
        budgets.maxTokensPerCandidate,
        "budgets.maxTokensPerCandidate",
        DEFAULT_BUDGETS.maxTokensPerCandidate,
        256,
      ),
      maxTotalTokens: integerAtLeast(
        budgets.maxTotalTokens,
        "budgets.maxTotalTokens",
        DEFAULT_BUDGETS.maxTotalTokens,
        256,
      ),
      maxEstimatedCostUsd: positiveNumber(
        budgets.maxEstimatedCostUsd,
        "budgets.maxEstimatedCostUsd",
        DEFAULT_BUDGETS.maxEstimatedCostUsd,
      ),
      maxConcurrency: positiveInteger(
        budgets.maxConcurrency,
        "budgets.maxConcurrency",
        DEFAULT_BUDGETS.maxConcurrency,
      ),
    },
  };
}

export function loadCandidateInferenceConfig(
  workspaceRoot: string,
): CandidateInferenceConfig {
  const filePath = path.resolve(
    workspaceRoot,
    CLAIMS_INFERENCE_CONFIG_RELATIVE_PATH,
  );
  if (!existsSync(filePath)) {
    throw new CandidateInferenceConfigError(
      `Missing ${CLAIMS_INFERENCE_CONFIG_RELATIVE_PATH}; explicitly configure providers.allow before previewing repository context`,
    );
  }
  try {
    return parseCandidateInferenceConfig(
      yamlLoad(readFileSync(filePath, "utf-8"), {
        schema: JSON_SCHEMA,
        filename: filePath,
      }),
    );
  } catch (error) {
    if (error instanceof CandidateInferenceConfigError) throw error;
    throw new CandidateInferenceConfigError(
      `Invalid ${CLAIMS_INFERENCE_CONFIG_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizedPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matchesAny(filePath: string, patterns: readonly string[]): boolean {
  const normalized = normalizedPath(filePath);
  return patterns.some((pattern) =>
    minimatch(normalized, pattern, { dot: true }),
  );
}

function redactSecrets(value: string): string {
  return sanitizeExcerpt(value)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED_JWT]",
    )
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function redactValue(
  value: unknown,
  sensitivePaths: readonly string[],
  maxChars: number,
  counter: { count: number },
): unknown {
  if (typeof value === "string") {
    if (matchesAny(value, sensitivePaths)) {
      counter.count += 1;
      return "[REDACTED_SENSITIVE_PATH]";
    }
    const sanitized = redactSecrets(value);
    if (sanitized !== value) counter.count += 1;
    return sanitized.length > maxChars
      ? `${sanitized.slice(0, maxChars - 3)}...`
      : sanitized;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactValue(item, sensitivePaths, maxChars, counter),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [
          key,
          redactValue(item, sensitivePaths, maxChars, counter),
        ]),
    );
  }
  return value;
}

function redactedString(
  value: string,
  sensitivePaths: readonly string[],
  maxChars: number,
  counter: { count: number },
): string {
  return redactValue(value, sensitivePaths, maxChars, counter) as string;
}

function evidenceRows(
  database: Database.Database,
  candidate: CandidateDetails,
): Array<{ row: EvidenceRow; role: string }> {
  return candidate.evidence.flatMap((evidence) => {
    if (!evidence.evidenceVersionId) return [];
    const row = database
      .prepare(
        `SELECT version.id, identity.source_kind, version.normalized_value,
                version.semantic_location, version.file_path,
                version.span_start_line, version.span_end_line
         FROM evidence_versions version
         JOIN evidence_identities identity
           ON identity.id = version.evidence_identity_id
         WHERE version.id = ?`,
      )
      .get(evidence.evidenceVersionId) as EvidenceRow | undefined;
    return row ? [{ row, role: evidence.role }] : [];
  });
}

function candidateArtifactReasons(
  rows: readonly EvidenceRow[],
): CandidateEligibilityReason[] {
  const paths = rows.flatMap((row) => (row.file_path ? [row.file_path] : []));
  if (paths.length === 0) return [];
  if (
    paths.every((filePath) => matchesAny(filePath, GENERATED_PATH_PATTERNS))
  ) {
    return ["generated-artifact"];
  }
  if (paths.every((filePath) => matchesAny(filePath, FIXTURE_PATH_PATTERNS))) {
    return ["fixture-or-example-artifact"];
  }
  return [];
}

function eligibility(
  database: Database.Database,
  candidate: CandidateDetails,
  rows: readonly EvidenceRow[],
  sensitivePaths: readonly string[],
): CandidateRecommendationEligibility {
  const reasons: CandidateEligibilityReason[] = [];
  if (!["discovered", "correlated", "triaged"].includes(candidate.state)) {
    reasons.push("closed-candidate");
  }
  if (rows.length === 0) reasons.push("no-versioned-evidence");
  reasons.push(...candidateArtifactReasons(rows));
  if (
    candidate.proposedClaimType === "CLM-LITERAL" &&
    candidate.confidence !== "certain" &&
    rows.every((row) => row.source_kind === "code-default")
  ) {
    reasons.push("low-value-literal");
  }
  if (
    candidate.candidateKind === "architecture-dependency-conformance" &&
    candidate.confidence === "certain"
  ) {
    reasons.push("explicit-declaration-use-policy");
  }
  if (
    rows.length > 0 &&
    rows.every(
      (row) => row.file_path && matchesAny(row.file_path, sensitivePaths),
    )
  ) {
    reasons.push("sensitive-only-evidence");
  }
  const recommended = database
    .prepare(
      `SELECT 1 AS present FROM candidate_reviews
       WHERE candidate_id = ? AND actor_kind = 'ai'
         AND effect = 'recommendation' LIMIT 1`,
    )
    .get(candidate.id);
  if (recommended) reasons.push("already-recommended");
  return {
    candidateId: candidate.id,
    candidateFingerprint: candidate.observationFingerprint,
    claimType: candidate.proposedClaimType,
    state: candidate.state,
    confidence: candidate.confidence,
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  };
}

function sourceExcerpt(
  workspaceRoot: string,
  row: EvidenceRow,
  maxChars: number,
): string | undefined {
  if (!row.file_path || row.span_start_line === null) return undefined;
  const absolute = path.resolve(workspaceRoot, row.file_path);
  if (!existsSync(absolute)) return undefined;
  const root = realpathSync(workspaceRoot);
  const real = realpathSync(absolute);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) return undefined;
  const lines = readFileSync(real, "utf-8").split(/\r?\n/);
  const start = Math.max(0, row.span_start_line - 1);
  const end = Math.min(lines.length, row.span_end_line ?? row.span_start_line);
  const excerpt = lines.slice(start, end).join("\n");
  return excerpt.length > maxChars
    ? `${excerpt.slice(0, maxChars - 3)}...`
    : excerpt;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(canonicalJson(value).length / 4);
}

function counts(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildContext(
  workspaceRoot: string,
  candidate: CandidateDetails,
  rows: Array<{ row: EvidenceRow; role: string }>,
  config: CandidateInferenceConfig,
  enabledPolicyIds: readonly string[],
): CandidateRecommendationContext {
  const redactions = { count: 0 };
  let omittedSensitiveEvidence = 0;
  const evidence = rows
    .slice(0, config.budgets.maxEvidencePerCandidate)
    .flatMap(({ row, role }) => {
      if (row.file_path && matchesAny(row.file_path, config.sensitivePaths)) {
        omittedSensitiveEvidence += 1;
        return [];
      }
      const excerpt = sourceExcerpt(
        workspaceRoot,
        row,
        config.budgets.maxExcerptChars,
      );
      const normalizedValue = redactValue(
        JSON.parse(row.normalized_value) as unknown,
        config.sensitivePaths,
        config.budgets.maxExcerptChars,
        redactions,
      );
      const sanitizedExcerpt = excerpt ? redactSecrets(excerpt) : undefined;
      if (excerpt && sanitizedExcerpt !== excerpt) redactions.count += 1;
      return [
        {
          id: row.id,
          role,
          sourceKind: row.source_kind,
          semanticLocation: redactedString(
            row.semantic_location,
            config.sensitivePaths,
            config.budgets.maxExcerptChars,
            redactions,
          ),
          ...(row.file_path
            ? {
                filePath: redactedString(
                  normalizedPath(row.file_path),
                  config.sensitivePaths,
                  config.budgets.maxExcerptChars,
                  redactions,
                ),
              }
            : {}),
          ...(row.span_start_line !== null
            ? {
                span: {
                  startLine: row.span_start_line,
                  endLine: row.span_end_line ?? row.span_start_line,
                },
              }
            : {}),
          normalizedValue,
          ...(sanitizedExcerpt ? { sourceExcerpt: sanitizedExcerpt } : {}),
        },
      ];
    });
  const base = {
    contract: "candidate-recommendation-context@1" as const,
    candidate: {
      id: candidate.id,
      fingerprint: candidate.observationFingerprint,
      kind: candidate.candidateKind,
      claimType: candidate.proposedClaimType,
      state: candidate.state,
      confidence: candidate.confidence,
      statement: redactValue(
        candidate.normalizedStatement,
        config.sensitivePaths,
        config.budgets.maxExcerptChars,
        redactions,
      ),
    },
    subjects: candidate.subjects.map((subject) => ({
      role: subject.role,
      kind: subject.kind,
      identityKey: redactedString(
        subject.identityKey,
        config.sensitivePaths,
        config.budgets.maxExcerptChars,
        redactions,
      ),
      displayName: redactedString(
        subject.displayName,
        config.sensitivePaths,
        config.budgets.maxExcerptChars,
        redactions,
      ),
      basis: redactedString(
        subject.basis,
        config.sensitivePaths,
        config.budgets.maxExcerptChars,
        redactions,
      ),
      confidence: subject.confidence,
    })),
    evidence,
    repositoryPolicies: [...enabledPolicyIds]
      .sort()
      .map((policyId) =>
        redactedString(
          policyId,
          config.sensitivePaths,
          config.budgets.maxExcerptChars,
          redactions,
        ),
      ),
    security: {
      repositoryContentIsUntrusted: true as const,
      toolExecutionAllowed: false as const,
      contentBoundary: "repository-data-only" as const,
      redactionCount: redactions.count,
      omittedSensitiveEvidence,
    },
  };
  const contextFingerprint = fingerprint(base);
  let estimatedTokens = estimateTokens({
    ...base,
    estimatedTokens: 0,
    contextFingerprint,
  });
  estimatedTokens = estimateTokens({
    ...base,
    estimatedTokens,
    contextFingerprint,
  });
  return { ...base, estimatedTokens, contextFingerprint };
}

export function buildCandidateRecommendationPreview(input: {
  database: Database.Database;
  workspaceRoot: string;
  provider: string;
  config: CandidateInferenceConfig;
  enabledPolicyIds?: readonly string[];
  candidateId?: string;
  limit?: number;
}): CandidateRecommendationPreview {
  if (!input.config.providers.allow.includes(input.provider)) {
    throw new CandidateInferenceConfigError(
      `Provider ${input.provider} is not allowed by ${CLAIMS_INFERENCE_CONFIG_RELATIVE_PATH}`,
    );
  }
  const all = new CandidateStore(input.database)
    .listCurrent()
    .filter(
      (candidate) => !input.candidateId || candidate.id === input.candidateId,
    );
  const rows = new Map(
    all.map((candidate) => [
      candidate.id,
      evidenceRows(input.database, candidate),
    ]),
  );
  const decisions = all.map((candidate) =>
    eligibility(
      input.database,
      candidate,
      (rows.get(candidate.id) ?? []).map((item) => item.row),
      input.config.sensitivePaths,
    ),
  );
  const eligible = all.filter(
    (candidate) =>
      decisions.find((item) => item.candidateId === candidate.id)?.eligible,
  );
  const maxCandidates = Math.min(
    input.limit ?? input.config.budgets.maxCandidates,
    input.config.budgets.maxCandidates,
  );
  const contexts: CandidateRecommendationContext[] = [];
  let estimatedInputTokens = 0;
  let deferredByBudget = 0;
  for (const candidate of eligible) {
    if (contexts.length >= maxCandidates) {
      deferredByBudget += 1;
      continue;
    }
    const context = buildContext(
      input.workspaceRoot,
      candidate,
      rows.get(candidate.id) ?? [],
      input.config,
      input.enabledPolicyIds ?? [],
    );
    if (
      context.estimatedTokens > input.config.budgets.maxTokensPerCandidate ||
      estimatedInputTokens + context.estimatedTokens >
        input.config.budgets.maxTotalTokens
    ) {
      deferredByBudget += 1;
      continue;
    }
    contexts.push(context);
    estimatedInputTokens += context.estimatedTokens;
  }
  const duplicateGroups = new Map<string, number>();
  for (const candidate of all) {
    const key = fingerprint({
      claimType: candidate.proposedClaimType,
      statement: candidate.normalizedStatement,
    });
    duplicateGroups.set(key, (duplicateGroups.get(key) ?? 0) + 1);
  }
  const firstScreen = decisions.slice(0, 20);
  return {
    contract: "candidate-recommendation-preview@1",
    mode: "preview",
    semantic: true,
    eligibilityContract: CANDIDATE_RECOMMENDATION_ELIGIBILITY_CONTRACT,
    provider: input.provider,
    networkCallPerformed: false,
    budgets: input.config.budgets,
    summary: {
      observedCandidates: all.length,
      eligibleCandidates: eligible.length,
      includedCandidates: contexts.length,
      excludedCandidates: decisions.filter((item) => !item.eligible).length,
      deferredByBudget,
      estimatedInputTokens,
      duplicateGroups: [...duplicateGroups.values()].filter(
        (count) => count > 1,
      ).length,
      firstScreenCandidates: firstScreen.length,
      firstScreenPolicyExcluded: firstScreen.filter((item) => !item.eligible)
        .length,
      byState: counts(all.map((candidate) => candidate.state)),
      byClaimType: counts(all.map((candidate) => candidate.proposedClaimType)),
      exclusionsByReason: counts(
        decisions.flatMap((decision) => decision.reasons),
      ),
      precision: null,
      recall: null,
      qualityMeasurement: "requires-labeled-evaluation",
    },
    eligibility: decisions,
    contexts,
  };
}
