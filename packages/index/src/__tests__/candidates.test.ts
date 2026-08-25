// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { CandidateStore } from "../claims/candidates.js";
import { CandidateInferenceStore } from "../claims/inferences.js";
import { ClaimsStore } from "../claims/store.js";
import { fingerprint } from "../claims/canonical.js";
import { initSchema } from "../schema.js";

describe("CandidateStore", () => {
  let db: Database.Database;
  let store: CandidateStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new CandidateStore(db);
  });

  afterEach(() => db.close());

  const input = (value: number) => ({
    identityKey: "r1:code:variable:timeout:CLM-DEFAULT",
    candidateKind: "r1-code-value",
    proposedClaimType: "CLM-DEFAULT",
    discoveryMode: "deterministic" as const,
    discoveryAdapterId: "r1-code-values",
    discoveryContractVersion: "1",
    confidence: "probable" as const,
    normalizedStatement: {
      subject: "code:variable:timeout",
      relation: "defaults-to",
      value,
    },
    provenance: { repositoryRevision: "working-tree" },
    evidence: [
      {
        evidenceKey: "code:variable:timeout:literal",
        sourceKind: "code-default",
        provenance: { filePath: "src/session.ts", line: 1, value },
      },
    ],
    subjects: [
      {
        kind: "parameter" as const,
        identityKey: "parameter:code:variable:timeout",
        displayName: "code:variable:timeout",
        role: "subject",
        basis: "r1-discovery",
        confidence: "probable" as const,
      },
    ],
  });

  it("deduplicates unchanged discovery and appends changed observations", () => {
    const first = store.persist(input(1800));
    const repeated = store.persist(input(1800));
    const changed = store.persist(input(2400));
    const returning = store.persist(input(1800));

    expect(first).toMatchObject({ ordinal: 1, created: true });
    expect(repeated).toEqual({ ...first, created: false });
    expect(changed).toMatchObject({ ordinal: 2, created: true });
    expect(returning).toMatchObject({ ordinal: 3, created: true });
    expect(returning.id).not.toBe(first.id);
    expect(
      db
        .prepare(
          `SELECT version_ordinal, state FROM claim_candidates
           ORDER BY version_ordinal`,
        )
        .all(),
    ).toEqual([
      { version_ordinal: 1, state: "discovered" },
      { version_ordinal: 2, state: "discovered" },
      { version_ordinal: 3, state: "discovered" },
    ]);
  });

  it("persists Evidence and Subject grounding for every Candidate version", () => {
    const discovered = store.persist(input(1800));
    const correlated = store.transition(discovered.id, "correlated", {
      basis: "deterministic-subject",
    });

    expect(
      db
        .prepare(
          `SELECT source_kind, evidence_role FROM candidate_evidence
           WHERE candidate_id = ?`,
        )
        .get(correlated.id),
    ).toEqual({ source_kind: "code-default", evidence_role: "source" });
    expect(
      db
        .prepare(
          `SELECT subject.kind, link.subject_role, link.basis
           FROM candidate_subjects link
           JOIN subject_identities subject ON subject.id = link.subject_identity_id
           WHERE link.candidate_id = ?`,
        )
        .get(correlated.id),
    ).toEqual({
      kind: "parameter",
      subject_role: "subject",
      basis: "r1-discovery",
    });
  });

  it("attaches a grounded Inference without deterministic rescan oscillation", () => {
    const evidenceVersionId = new ClaimsStore(db).persistGenericEvidence({
      subjects: [
        {
          kind: "parameter",
          identityKey: "parameter:code:variable:timeout",
          role: "subject",
          basis: "test",
          confidence: "probable",
        },
      ],
      sourceKind: "code-default",
      identityKey: "code:variable:timeout:literal",
      fingerprint: fingerprint({ value: 1800 }),
      materialFingerprint: fingerprint({ value: 1800 }),
      normalizedValue: 1800,
      semanticLocation: "timeout",
      provenance: { fixture: true },
    }).id;
    const inference = new CandidateInferenceStore(db).persist({
      identityKey: "semantic-timeout-correlation",
      adapterId: "semantic-correlation",
      contractVersion: "1",
      providerId: "fixture",
      modelId: "fixture-model",
      promptVersion: "1",
      inputFingerprint: "input-a",
      normalizedOutput: { selected: true },
      evidenceVersionIds: [evidenceVersionId],
      proposedSubjectBindings: [
        {
          role: "subject",
          identityKey: "parameter:code:variable:timeout",
        },
      ],
      confidence: "probable",
      rationale: "The Evidence identifies the timeout Parameter",
      provenance: { fixture: true },
    });
    const discovered = store.persist(input(1800));
    const correlated = store.attachInference(discovered.id, {
      inferenceId: inference.id,
      confidence: "probable",
      basis: "semantic-correlation",
      provenance: { fixture: true },
    });
    const rescanned = store.persist(input(1800));
    const repeated = store.attachInference(rescanned.id, {
      inferenceId: inference.id,
      confidence: "probable",
      basis: "semantic-correlation",
      provenance: { fixture: true },
    });

    expect(correlated).toMatchObject({ state: "correlated", ordinal: 2 });
    expect(rescanned).toEqual({ ...correlated, created: false });
    expect(repeated).toEqual({ ...correlated, created: false });
    expect(store.details(correlated.id)).toMatchObject({
      inferenceId: inference.id,
      confidence: "probable",
      subjects: [
        expect.objectContaining({
          basis: "semantic-correlation",
          confidence: "probable",
        }),
      ],
    });
  });

  it("applies effective Reviews only after deterministic triage", () => {
    const discovered = store.persist(input(1800));
    const correlated = store.transition(discovered.id, "correlated", {});
    const triaged = store.transition(correlated.id, "triaged", {});
    const recommendation = store.review({
      candidateId: triaged.id,
      actorKind: "ai",
      actorId: "triage-model",
      decision: "promote",
      effect: "recommendation",
      rationale: "Strong default convention",
      provenance: { model: "test" },
    });
    const deferred = store.review({
      candidateId: triaged.id,
      actorKind: "human",
      actorId: "reviewer",
      decision: "defer",
      effect: "effective",
      rationale: "Needs another source",
      provenance: {},
    });
    const rejected = store.review({
      candidateId: triaged.id,
      actorKind: "human",
      actorId: "reviewer",
      decision: "reject",
      effect: "effective",
      rationale: "Not a repository contract",
      provenance: {},
    });

    expect(recommendation.candidate.state).toBe("triaged");
    expect(deferred.candidate.state).toBe("triaged");
    expect(rejected.candidate).toMatchObject({ state: "rejected", ordinal: 4 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM candidate_reviews`).get(),
    ).toEqual({ count: 3 });
  });

  it("retains a rejected unchanged Candidate instead of recreating work", () => {
    const discovered = store.persist(input(1800));
    const correlated = store.transition(discovered.id, "correlated", {});
    const triaged = store.transition(correlated.id, "triaged", {});
    const rejected = store.review({
      candidateId: triaged.id,
      actorKind: "human",
      actorId: "reviewer",
      decision: "reject",
      effect: "effective",
      rationale: "Implementation detail, not a governed statement",
      provenance: {},
    });

    const rescanned = store.persist(input(1800));

    expect(rejected.candidate.state).toBe("rejected");
    expect(rescanned).toEqual({ ...rejected.candidate, created: false });
  });

  it("materializes versioned Policy decisions with effective provenance", () => {
    const discovered = store.persist(input(1800));
    const triaged = store.triage(discovered.id, {
      basis: "deterministic-correlation",
    });

    const decision = store.applyPolicyDecision({
      candidateId: triaged.id,
      policyId: "suppress-internal-defaults",
      policyVersion: "1",
      decision: "suppress",
      rationale: "Internal defaults are outside governance scope",
      provenance: { configurationFingerprint: "policy-config-v1" },
    });
    const repeated = store.applyPolicyDecision({
      candidateId: triaged.id,
      policyId: "suppress-internal-defaults",
      policyVersion: "1",
      decision: "suppress",
      rationale: "Internal defaults are outside governance scope",
      provenance: { configurationFingerprint: "policy-config-v1" },
    });

    expect(decision.candidate.state).toBe("suppressed");
    expect(repeated).toMatchObject({ id: decision.id, created: false });
    expect(
      db
        .prepare(
          `SELECT policy_id, policy_version, decision
           FROM candidate_policy_decisions`,
        )
        .get(),
    ).toEqual({
      policy_id: "suppress-internal-defaults",
      policy_version: "1",
      decision: "suppress",
    });
    expect(
      db
        .prepare(`SELECT actor_kind, actor_id, effect FROM candidate_reviews`)
        .get(),
    ).toEqual({
      actor_kind: "policy",
      actor_id: "suppress-internal-defaults",
      effect: "effective",
    });
  });

  it("rejects skipped lifecycle states", () => {
    const discovered = store.persist(input(1800));

    expect(() => store.transition(discovered.id, "promoted", {})).toThrow(
      "discovered -> promoted is not allowed",
    );
  });
});
