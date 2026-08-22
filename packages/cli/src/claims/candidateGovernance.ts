// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsEngine,
  ClaimsStore,
  emptyPortableClaimsState,
  fingerprint,
  materialFingerprint,
  type CandidateDetails,
  type CandidatePolicyDecisionInput,
  type CandidateReviewDecision,
  type ClaimsContractVersions,
  type ClaimScalar,
  type PersistedAssessment,
  type PersistedCandidateReview,
  type PortableClaimsActor,
} from "@intentweave/index";
import {
  loadPortableClaimsState,
  writePortableClaimsState,
} from "./portableState.js";

export interface CandidateGovernanceResult {
  review: PersistedCandidateReview;
  assessment?: PersistedAssessment;
}

function claimScalar(value: unknown): ClaimScalar {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  ) {
    return value;
  }
  throw new Error("R1 Candidate value is not a supported Claim scalar");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function promoteR1Candidate(
  database: Database.Database,
  candidate: CandidateDetails,
  contracts: ClaimsContractVersions,
): PersistedAssessment {
  if (candidate.discoveryAdapterId !== "r1-code-values") {
    throw new Error(
      `Candidate adapter ${candidate.discoveryAdapterId} has no promotion evaluator`,
    );
  }
  const statement = record(
    candidate.normalizedStatement,
    "R1 Candidate statement",
  );
  const parameterKey = optionalString(statement.subject);
  if (!parameterKey) {
    throw new Error("R1 Candidate statement is missing its Parameter subject");
  }
  const value = claimScalar(statement.value);
  const discovery = record(candidate.provenance, "R1 Candidate provenance");
  const repositoryRevision =
    optionalString(discovery.repositoryRevision) ?? "working-tree";
  const store = new ClaimsStore(database);
  const persisted = candidate.evidence.map((evidence) => {
    const provenance = record(
      evidence.provenance,
      `Candidate Evidence ${evidence.evidenceKey}`,
    );
    const evidenceValue = claimScalar(provenance.normalizedValue);
    const semanticLocation =
      optionalString(provenance.semanticLocation) ?? parameterKey;
    const filePath = optionalString(provenance.filePath);
    const symbolId = optionalString(provenance.symbolId);
    const line = optionalNumber(provenance.line);
    return {
      sourceKind: evidence.sourceKind,
      value: evidenceValue,
      version: store.persistEvidence({
        parameterKey,
        sourceKind: evidence.sourceKind,
        identityKey: evidence.evidenceKey,
        fingerprint: fingerprint({
          sourceKind: evidence.sourceKind,
          value: evidenceValue,
          semanticLocation,
          filePath: filePath ?? null,
          symbolId: symbolId ?? null,
          line: line ?? null,
        }),
        materialFingerprint: materialFingerprint({
          parameterIdentity: parameterKey,
          semanticLocation,
          normalizedValue: evidenceValue,
        }),
        normalizedValue: evidenceValue,
        semanticLocation,
        provenance: {
          filePath: filePath ?? null,
          symbolId: symbolId ?? null,
          line: line ?? null,
          repositoryRevision,
          candidateId: candidate.id,
        },
        filePath,
        symbolId,
        spanStartLine: line,
        spanEndLine: line,
        repositoryRevision,
        bindingBasis: optionalString(provenance.bindingBasis),
        bindingConfidence: optionalString(provenance.bindingConfidence),
      }),
    };
  });
  const codeDefault = persisted.find(
    (evidence) => evidence.sourceKind === "code-default",
  );
  if (!codeDefault) {
    throw new Error("R1 Candidate cannot be promoted without code-default Evidence");
  }
  const annotation = persisted.find(
    (evidence) => evidence.sourceKind === "code-annotation",
  );
  const result = new ClaimsEngine(store).evaluateDefault({
    parameterKey,
    claimType:
      candidate.proposedClaimType === "CLM-LITERAL"
        ? "CLM-LITERAL"
        : "CLM-DEFAULT",
    repositoryRevision,
    codeDefault: {
      versionId: codeDefault.version.id,
      value: codeDefault.value,
    },
    codeAnnotation: annotation
      ? { versionId: annotation.version.id, value: annotation.value }
      : undefined,
    contracts,
  });
  return result.assessments[0]!;
}

export function reviewCandidate(
  database: Database.Database,
  input: {
    candidateId: string;
    actor: string;
    decision: CandidateReviewDecision;
    rationale: string;
    provenance: unknown;
    contracts: ClaimsContractVersions;
  },
): CandidateGovernanceResult {
  const apply = database.transaction(() => {
    const candidates = new CandidateStore(database);
    const candidate = candidates.details(input.candidateId);
    if (!candidate) throw new Error(`Candidate ${input.candidateId} does not exist`);
    const assessment =
      input.decision === "promote"
        ? promoteR1Candidate(database, candidate, input.contracts)
        : undefined;
    const review = candidates.review({
      candidateId: input.candidateId,
      actorKind: "human",
      actorId: input.actor,
      decision: input.decision,
      effect: "effective",
      rationale: input.rationale,
      provenance: input.provenance,
      promotedClaimIdentityId: assessment?.claimIdentityId,
    });
    return { review, ...(assessment ? { assessment } : {}) };
  });
  return apply();
}

export function applyCandidatePolicy(
  database: Database.Database,
  input: CandidatePolicyDecisionInput & { contracts: ClaimsContractVersions },
): CandidateGovernanceResult {
  const apply = database.transaction(() => {
    const candidates = new CandidateStore(database);
    const candidate = candidates.details(input.candidateId);
    if (!candidate) throw new Error(`Candidate ${input.candidateId} does not exist`);
    const assessment =
      input.decision === "promote"
        ? promoteR1Candidate(database, candidate, input.contracts)
        : undefined;
    const review = candidates.applyPolicyDecision({
      ...input,
      promotedClaimIdentityId: assessment?.claimIdentityId,
    });
    return { review, ...(assessment ? { assessment } : {}) };
  });
  return apply();
}

export function persistPortableCandidateDecision(
  workspaceRoot: string,
  candidate: CandidateDetails,
  input: {
    decision: Exclude<CandidateReviewDecision, "defer">;
    actor: PortableClaimsActor;
    rationale: string;
    decidedAt: string;
  },
): string {
  const state =
    loadPortableClaimsState(workspaceRoot) ?? emptyPortableClaimsState();
  state.candidateDecisions[candidate.identityKey] = {
    decision: input.decision,
    candidateFingerprint: candidate.observationFingerprint,
    actor: input.actor,
    decidedAt: input.decidedAt,
    rationale: input.rationale,
  };
  return writePortableClaimsState(workspaceRoot, state);
}
