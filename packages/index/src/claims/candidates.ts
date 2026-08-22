// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import { canonicalJson, fingerprint } from "./canonical.js";
import { subjectIdentity, type SubjectKind } from "./subjects.js";

export type CandidateDiscoveryMode = "deterministic" | "semantic" | "manual";
export type CandidateConfidence = "certain" | "probable" | "ambiguous";
export type CandidateState =
  | "discovered"
  | "correlated"
  | "triaged"
  | "promoted"
  | "rejected"
  | "suppressed"
  | "superseded";
export type CandidateReviewDecision =
  | "promote"
  | "reject"
  | "suppress"
  | "defer";
export type CandidateReviewEffect = "recommendation" | "effective";

export interface CandidateEvidenceInput {
  evidenceKey: string;
  evidenceVersionId?: string;
  sourceKind: string;
  role?: string;
  provenance: unknown;
}

export interface CandidateSubjectInput {
  kind: SubjectKind;
  identityKey: string;
  displayName?: string;
  role: string;
  basis: string;
  confidence: CandidateConfidence;
}

export interface PersistClaimCandidateInput {
  identityKey: string;
  candidateKind: string;
  proposedClaimType: string;
  discoveryMode: CandidateDiscoveryMode;
  discoveryAdapterId: string;
  discoveryContractVersion: string;
  inferenceId?: string;
  confidence: CandidateConfidence;
  normalizedStatement: unknown;
  provenance: unknown;
  evidence: CandidateEvidenceInput[];
  subjects: CandidateSubjectInput[];
}

export interface PersistedCandidate {
  id: string;
  identityKey: string;
  ordinal: number;
  state: CandidateState;
  fingerprint: string;
  observationFingerprint: string;
  created: boolean;
}

export interface CandidateReviewInput {
  candidateId: string;
  actorKind: "human" | "ai" | "policy";
  actorId: string;
  decision: CandidateReviewDecision;
  effect: CandidateReviewEffect;
  rationale: string;
  provenance: unknown;
  promotedClaimIdentityId?: string;
}

export interface PersistedCandidateReview {
  id: string;
  created: boolean;
  candidate: PersistedCandidate;
}

export interface CandidatePolicyDecisionInput {
  candidateId: string;
  policyId: string;
  policyVersion: string;
  decision: CandidateReviewDecision;
  rationale: string;
  provenance: unknown;
  promotedClaimIdentityId?: string;
}

export interface CandidateEvidence {
  evidenceKey: string;
  evidenceVersionId?: string;
  sourceKind: string;
  role: string;
  provenance: unknown;
}

export interface CandidateSubject {
  kind: SubjectKind;
  identityKey: string;
  displayName: string;
  role: string;
  basis: string;
  confidence: CandidateConfidence;
}

export interface CandidateDetails extends PersistedCandidate {
  candidateKind: string;
  proposedClaimType: string;
  discoveryMode: CandidateDiscoveryMode;
  discoveryAdapterId: string;
  discoveryContractVersion: string;
  inferenceId?: string;
  confidence: CandidateConfidence;
  normalizedStatement: unknown;
  provenance: unknown;
  evidence: CandidateEvidence[];
  subjects: CandidateSubject[];
}

export interface CandidateListFilter {
  state?: CandidateState;
  subjectKind?: SubjectKind;
}

interface CandidateRow {
  id: string;
  identity_key: string;
  version_ordinal: number;
  state: CandidateState;
  fingerprint: string;
  observation_fingerprint: string;
}

interface CandidateDetailRow extends CandidateRow {
  candidate_kind: string;
  proposed_claim_type: string;
  discovery_mode: CandidateDiscoveryMode;
  discovery_adapter_id: string;
  discovery_contract_version: string;
  inference_id: string | null;
  confidence: CandidateConfidence;
  normalized_statement_json: string;
  provenance_json: string;
}

const REOBSERVED_MARKER = "#reobserved:";

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function logicalFingerprint(value: string): string {
  return value.split(REOBSERVED_MARKER, 1)[0] ?? value;
}

function persistedCandidate(
  row: CandidateRow,
  created: boolean,
): PersistedCandidate {
  return {
    id: row.id,
    identityKey: row.identity_key,
    ordinal: row.version_ordinal,
    state: row.state,
    fingerprint: row.fingerprint,
    observationFingerprint: row.observation_fingerprint,
    created,
  };
}

function sortedCanonical<T>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

export class CandidateStore {
  constructor(private readonly db: Database.Database) {}

  persist(input: PersistClaimCandidateInput): PersistedCandidate {
    const persist = this.db.transaction(() => {
      this.validateCandidateInput(input);
      const now = Date.now();
      const evidence = sortedCanonical(
        input.evidence.map((item) => ({
          evidenceKey: item.evidenceKey,
          evidenceVersionId: item.evidenceVersionId ?? null,
          sourceKind: item.sourceKind,
          role: item.role ?? "source",
          provenance: item.provenance,
        })),
      );
      const subjects = sortedCanonical(
        input.subjects.map((item) => ({
          kind: item.kind,
          identityKey: item.identityKey,
          displayName: item.displayName ?? item.identityKey,
          role: item.role,
          basis: item.basis,
          confidence: item.confidence,
        })),
      );
      const observationFingerprint = fingerprint({
        candidateKind: input.candidateKind,
        proposedClaimType: input.proposedClaimType,
        discoveryMode: input.discoveryMode,
        discoveryAdapterId: input.discoveryAdapterId,
        discoveryContractVersion: input.discoveryContractVersion,
        inferenceId: input.inferenceId ?? null,
        confidence: input.confidence,
        normalizedStatement: input.normalizedStatement,
        evidence,
        subjects,
      });
      const versions = this.rowsForIdentity(input.identityKey);
      const current = versions[0];
      if (
        current &&
        logicalFingerprint(current.observation_fingerprint) ===
          observationFingerprint
      ) {
        return persistedCandidate(current, false);
      }

      const ordinal = (current?.version_ordinal ?? 0) + 1;
      const baseVersionFingerprint = fingerprint({
        observationFingerprint,
        state: "discovered",
      });
      const returning = versions.some(
        (version) =>
          logicalFingerprint(version.fingerprint) === baseVersionFingerprint,
      );
      const versionFingerprint = returning
        ? `${baseVersionFingerprint}${REOBSERVED_MARKER}${ordinal}`
        : baseVersionFingerprint;
      const candidateId = `candidate:${fingerprint(input.identityKey)}@${ordinal}`;

      this.db
        .prepare(
          `INSERT INTO claim_candidates (
             id, identity_key, version_ordinal, candidate_kind,
             proposed_claim_type, discovery_mode, discovery_adapter_id,
             discovery_contract_version, inference_id, confidence, state,
             fingerprint, observation_fingerprint, normalized_statement_json,
             provenance_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?)`,
        )
        .run(
          candidateId,
          input.identityKey,
          ordinal,
          input.candidateKind,
          input.proposedClaimType,
          input.discoveryMode,
          input.discoveryAdapterId,
          input.discoveryContractVersion,
          input.inferenceId ?? null,
          input.confidence,
          versionFingerprint,
          observationFingerprint,
          canonicalJson(input.normalizedStatement),
          canonicalJson(input.provenance),
          now,
        );

      for (const item of evidence) {
        this.db
          .prepare(
            `INSERT INTO candidate_evidence (
               candidate_id, evidence_key, evidence_version_id, source_kind,
               evidence_role, provenance_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            candidateId,
            item.evidenceKey,
            item.evidenceVersionId,
            item.sourceKind,
            item.role,
            canonicalJson(item.provenance),
            now,
          );
      }
      for (const item of subjects) {
        const subject = subjectIdentity(
          item.kind,
          item.identityKey,
          item.displayName,
        );
        this.db
          .prepare(
            `INSERT OR IGNORE INTO subject_identities (
               id, kind, identity_key, display_name, lifecycle_state,
               contract_version, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            subject.id,
            subject.kind,
            subject.identityKey,
            subject.displayName,
            subject.lifecycleState,
            subject.contractVersion,
            now,
          );
        this.db
          .prepare(
            `INSERT INTO candidate_subjects (
               candidate_id, subject_identity_id, subject_role,
               basis, confidence, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            candidateId,
            subject.id,
            item.role,
            item.basis,
            item.confidence,
            now,
          );
      }

      return {
        id: candidateId,
        identityKey: input.identityKey,
        ordinal,
        state: "discovered" as const,
        fingerprint: versionFingerprint,
        observationFingerprint,
        created: true,
      };
    });
    return persist();
  }

  transition(
    candidateId: string,
    targetState: CandidateState,
    provenance: unknown,
  ): PersistedCandidate {
    const transition = this.db.transaction(() => {
      const basis = this.rowById(candidateId);
      if (!basis) throw new Error(`Candidate ${candidateId} does not exist`);
      const current = this.rowsForIdentity(basis.identity_key)[0];
      if (!current || current.id !== candidateId) {
        throw new Error(`Candidate ${candidateId} is not the current version`);
      }
      if (targetState === current.state) {
        return persistedCandidate(current, false);
      }
      if (!this.transitionAllowed(current.state, targetState)) {
        throw new Error(
          `Candidate transition ${current.state} -> ${targetState} is not allowed`,
        );
      }
      return this.appendTransition(current, targetState, provenance);
    });
    return transition();
  }

  triage(candidateId: string, provenance: unknown): PersistedCandidate {
    let current = this.details(candidateId);
    if (!current) throw new Error(`Candidate ${candidateId} does not exist`);
    if (current.state === "discovered") {
      current = this.details(
        this.transition(current.id, "correlated", provenance).id,
      )!;
    }
    if (current.state === "correlated") {
      return this.transition(current.id, "triaged", provenance);
    }
    if (current.state === "triaged") {
      return { ...current, created: false };
    }
    throw new Error(`Candidate ${current.id} cannot be triaged from ${current.state}`);
  }

  review(input: CandidateReviewInput): PersistedCandidateReview {
    const review = this.db.transaction(() => {
      requireNonEmpty(input.actorId, "Candidate Review actor");
      requireNonEmpty(input.rationale, "Candidate Review rationale");
      const reviewId = `candidate-review:${fingerprint({
        candidateId: input.candidateId,
        actorKind: input.actorKind,
        actorId: input.actorId,
        decision: input.decision,
        effect: input.effect,
        rationale: input.rationale,
        provenance: input.provenance,
        promotedClaimIdentityId: input.promotedClaimIdentityId ?? null,
      })}`;
      const existing = this.db
        .prepare(`SELECT id FROM candidate_reviews WHERE id = ?`)
        .get(reviewId) as { id: string } | undefined;
      const basis = this.rowById(input.candidateId);
      if (!basis) {
        throw new Error(`Candidate ${input.candidateId} does not exist`);
      }
      if (existing) {
        const current = this.rowsForIdentity(basis.identity_key)[0];
        return {
          id: existing.id,
          created: false,
          candidate: persistedCandidate(current, false),
        };
      }
      const current = this.rowsForIdentity(basis.identity_key)[0];
      if (!current || current.id !== input.candidateId) {
        throw new Error(`Candidate ${input.candidateId} is not the current version`);
      }
      if (current.state !== "triaged") {
        throw new Error(
          `Candidate ${input.candidateId} must be triaged before Review`,
        );
      }
      const requiresPromotedClaim =
        input.effect === "effective" && input.decision === "promote";
      if (requiresPromotedClaim !== Boolean(input.promotedClaimIdentityId)) {
        throw new Error(
          "A promoted Claim identity is required only for promote decisions",
        );
      }
      this.db
        .prepare(
          `INSERT INTO candidate_reviews (
             id, candidate_id, promoted_claim_identity_id, actor_kind,
             actor_id, decision, effect, rationale, provenance_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reviewId,
          input.candidateId,
          input.promotedClaimIdentityId ?? null,
          input.actorKind,
          input.actorId,
          input.decision,
          input.effect,
          input.rationale,
          canonicalJson(input.provenance),
          Date.now(),
        );

      let candidate = persistedCandidate(current, false);
      if (input.effect === "effective" && input.decision !== "defer") {
        const targetState: CandidateState =
          input.decision === "promote"
            ? "promoted"
            : input.decision === "reject"
              ? "rejected"
              : "suppressed";
        candidate = this.appendTransition(current, targetState, {
          candidateReviewId: reviewId,
        });
      }
      return { id: reviewId, created: true, candidate };
    });
    return review();
  }

  applyPolicyDecision(
    input: CandidatePolicyDecisionInput,
  ): PersistedCandidateReview {
    requireNonEmpty(input.policyId, "Candidate Policy ID");
    requireNonEmpty(input.policyVersion, "Candidate Policy version");
    const apply = this.db.transaction(() => {
      const policyDecisionId = `candidate-policy-decision:${fingerprint({
        candidateId: input.candidateId,
        policyId: input.policyId,
        policyVersion: input.policyVersion,
        decision: input.decision,
        rationale: input.rationale,
        provenance: input.provenance,
        promotedClaimIdentityId: input.promotedClaimIdentityId ?? null,
      })}`;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO candidate_policy_decisions (
             id, candidate_id, promoted_claim_identity_id, policy_id,
             policy_version, decision, rationale, provenance_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          policyDecisionId,
          input.candidateId,
          input.promotedClaimIdentityId ?? null,
          input.policyId,
          input.policyVersion,
          input.decision,
          input.rationale,
          canonicalJson(input.provenance),
          Date.now(),
        );
      return this.review({
        candidateId: input.candidateId,
        actorKind: "policy",
        actorId: input.policyId,
        decision: input.decision,
        effect: "effective",
        rationale: input.rationale,
        provenance: {
          policyDecisionId,
          policyVersion: input.policyVersion,
          input: input.provenance,
        },
        promotedClaimIdentityId: input.promotedClaimIdentityId,
      });
    });
    return apply();
  }

  current(identityKey: string): PersistedCandidate | undefined {
    const row = this.rowsForIdentity(identityKey)[0];
    return row ? persistedCandidate(row, false) : undefined;
  }

  listCurrent(filter: CandidateListFilter = {}): CandidateDetails[] {
    const rows = this.db
      .prepare(
        `WITH latest AS (
           SELECT identity_key, MAX(version_ordinal) AS version_ordinal
           FROM claim_candidates GROUP BY identity_key
         )
         SELECT candidate.*
         FROM claim_candidates candidate
         JOIN latest
           ON latest.identity_key = candidate.identity_key
          AND latest.version_ordinal = candidate.version_ordinal
         WHERE (? IS NULL OR candidate.state = ?)
           AND (
             ? IS NULL OR EXISTS (
               SELECT 1 FROM candidate_subjects link
               JOIN subject_identities subject
                 ON subject.id = link.subject_identity_id
               WHERE link.candidate_id = candidate.id AND subject.kind = ?
             )
           )
         ORDER BY candidate.created_at, candidate.id`,
      )
      .all(
        filter.state ?? null,
        filter.state ?? null,
        filter.subjectKind ?? null,
        filter.subjectKind ?? null,
      ) as CandidateDetailRow[];
    return rows.map((row) => this.detailsFromRow(row));
  }

  details(candidateId: string): CandidateDetails | undefined {
    const row = this.db
      .prepare(`SELECT * FROM claim_candidates WHERE id = ?`)
      .get(candidateId) as CandidateDetailRow | undefined;
    return row ? this.detailsFromRow(row) : undefined;
  }

  private detailsFromRow(row: CandidateDetailRow): CandidateDetails {
    const discovery = this.db
      .prepare(
        `SELECT provenance_json FROM claim_candidates
         WHERE identity_key = ? AND observation_fingerprint = ?
           AND state = 'discovered'
         ORDER BY version_ordinal DESC LIMIT 1`,
      )
      .get(row.identity_key, row.observation_fingerprint) as
      | { provenance_json: string }
      | undefined;
    const evidence = (
      this.db
        .prepare(
          `SELECT evidence_key, evidence_version_id, source_kind,
                  evidence_role, provenance_json
           FROM candidate_evidence WHERE candidate_id = ?
           ORDER BY source_kind, evidence_key, evidence_role`,
        )
        .all(row.id) as Array<{
        evidence_key: string;
        evidence_version_id: string | null;
        source_kind: string;
        evidence_role: string;
        provenance_json: string;
      }>
    ).map((item) => ({
      evidenceKey: item.evidence_key,
      ...(item.evidence_version_id
        ? { evidenceVersionId: item.evidence_version_id }
        : {}),
      sourceKind: item.source_kind,
      role: item.evidence_role,
      provenance: JSON.parse(item.provenance_json) as unknown,
    }));
    const subjects = (
      this.db
        .prepare(
          `SELECT subject.kind, subject.identity_key, subject.display_name,
                  link.subject_role, link.basis, link.confidence
           FROM candidate_subjects link
           JOIN subject_identities subject ON subject.id = link.subject_identity_id
           WHERE link.candidate_id = ?
           ORDER BY link.subject_role, subject.identity_key`,
        )
        .all(row.id) as Array<{
        kind: SubjectKind;
        identity_key: string;
        display_name: string;
        subject_role: string;
        basis: string;
        confidence: CandidateConfidence;
      }>
    ).map((item) => ({
      kind: item.kind,
      identityKey: item.identity_key,
      displayName: item.display_name,
      role: item.subject_role,
      basis: item.basis,
      confidence: item.confidence,
    }));
    return {
      ...persistedCandidate(row, false),
      candidateKind: row.candidate_kind,
      proposedClaimType: row.proposed_claim_type,
      discoveryMode: row.discovery_mode,
      discoveryAdapterId: row.discovery_adapter_id,
      discoveryContractVersion: row.discovery_contract_version,
      ...(row.inference_id ? { inferenceId: row.inference_id } : {}),
      confidence: row.confidence,
      normalizedStatement: JSON.parse(row.normalized_statement_json) as unknown,
      provenance: JSON.parse(
        discovery?.provenance_json ?? row.provenance_json,
      ) as unknown,
      evidence,
      subjects,
    };
  }

  private appendTransition(
    current: CandidateRow,
    targetState: CandidateState,
    provenance: unknown,
  ): PersistedCandidate {
    const ordinal = current.version_ordinal + 1;
    const candidateId = `candidate:${fingerprint(current.identity_key)}@${ordinal}`;
    const baseFingerprint = fingerprint({
      observationFingerprint: logicalFingerprint(
        current.observation_fingerprint,
      ),
      state: targetState,
    });
    const returning = this.rowsForIdentity(current.identity_key).some(
      (version) => logicalFingerprint(version.fingerprint) === baseFingerprint,
    );
    const versionFingerprint = returning
      ? `${baseFingerprint}${REOBSERVED_MARKER}${ordinal}`
      : baseFingerprint;
    const source = this.db
      .prepare(`SELECT * FROM claim_candidates WHERE id = ?`)
      .get(current.id) as Record<string, unknown>;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO claim_candidates (
           id, identity_key, version_ordinal, candidate_kind,
           proposed_claim_type, discovery_mode, discovery_adapter_id,
           discovery_contract_version, inference_id, confidence, state,
           fingerprint, observation_fingerprint, normalized_statement_json,
           provenance_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidateId,
        source.identity_key,
        ordinal,
        source.candidate_kind,
        source.proposed_claim_type,
        source.discovery_mode,
        source.discovery_adapter_id,
        source.discovery_contract_version,
        source.inference_id,
        source.confidence,
        targetState,
        versionFingerprint,
        source.observation_fingerprint,
        source.normalized_statement_json,
        canonicalJson({ transition: provenance }),
        now,
      );
    this.db
      .prepare(
        `INSERT INTO candidate_evidence (
           candidate_id, evidence_key, evidence_version_id, source_kind,
           evidence_role, provenance_json, created_at
         )
         SELECT ?, evidence_key, evidence_version_id, source_kind,
                evidence_role, provenance_json, ?
         FROM candidate_evidence WHERE candidate_id = ?`,
      )
      .run(candidateId, now, current.id);
    this.db
      .prepare(
        `INSERT INTO candidate_subjects (
           candidate_id, subject_identity_id, subject_role,
           basis, confidence, created_at
         )
         SELECT ?, subject_identity_id, subject_role, basis, confidence, ?
         FROM candidate_subjects WHERE candidate_id = ?`,
      )
      .run(candidateId, now, current.id);
    return {
      id: candidateId,
      identityKey: current.identity_key,
      ordinal,
      state: targetState,
      fingerprint: versionFingerprint,
      observationFingerprint: current.observation_fingerprint,
      created: true,
    };
  }

  private rowsForIdentity(identityKey: string): CandidateRow[] {
    return this.db
      .prepare(
        `SELECT id, identity_key, version_ordinal, state, fingerprint,
                observation_fingerprint
         FROM claim_candidates WHERE identity_key = ?
         ORDER BY version_ordinal DESC`,
      )
      .all(identityKey) as CandidateRow[];
  }

  private rowById(candidateId: string): CandidateRow | undefined {
    return this.db
      .prepare(
        `SELECT id, identity_key, version_ordinal, state, fingerprint,
                observation_fingerprint
         FROM claim_candidates WHERE id = ?`,
      )
      .get(candidateId) as CandidateRow | undefined;
  }

  private transitionAllowed(
    from: CandidateState,
    to: CandidateState,
  ): boolean {
    if (to === "superseded") return true;
    return (
      (from === "discovered" && to === "correlated") ||
      (from === "correlated" && to === "triaged") ||
      (from === "triaged" &&
        (to === "promoted" || to === "rejected" || to === "suppressed"))
    );
  }

  private validateCandidateInput(input: PersistClaimCandidateInput): void {
    requireNonEmpty(input.identityKey, "Candidate identity key");
    requireNonEmpty(input.candidateKind, "Candidate kind");
    requireNonEmpty(input.proposedClaimType, "Proposed Claim type");
    requireNonEmpty(input.discoveryAdapterId, "Discovery adapter ID");
    requireNonEmpty(
      input.discoveryContractVersion,
      "Discovery contract version",
    );
    if (input.subjects.length === 0) {
      throw new Error("A Candidate requires at least one Subject");
    }
    const evidenceKeys = new Set<string>();
    for (const item of input.evidence) {
      requireNonEmpty(item.evidenceKey, "Candidate Evidence key");
      requireNonEmpty(item.sourceKind, "Candidate Evidence source kind");
      const key = canonicalJson([item.evidenceKey, item.role ?? "source"]);
      if (evidenceKeys.has(key)) {
        throw new Error(`Duplicate Candidate Evidence ${item.evidenceKey}`);
      }
      evidenceKeys.add(key);
    }
    const subjectKeys = new Set<string>();
    for (const item of input.subjects) {
      requireNonEmpty(item.role, "Candidate Subject role");
      const key = canonicalJson([item.identityKey, item.role]);
      if (subjectKeys.has(key)) {
        throw new Error(`Duplicate Candidate Subject ${item.identityKey}`);
      }
      subjectKeys.add(key);
    }
  }
}
