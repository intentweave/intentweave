// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { CandidateStore } from "../claims/candidates.js";
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
    const promoted = store.review({
      candidateId: triaged.id,
      actorKind: "human",
      actorId: "reviewer",
      decision: "promote",
      effect: "effective",
      rationale: "Repository contract",
      provenance: {},
    });

    expect(recommendation.candidate.state).toBe("triaged");
    expect(deferred.candidate.state).toBe("triaged");
    expect(promoted.candidate).toMatchObject({ state: "promoted", ordinal: 4 });
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

  it("rejects skipped lifecycle states", () => {
    const discovered = store.persist(input(1800));

    expect(() => store.transition(discovered.id, "promoted", {})).toThrow(
      "discovered -> promoted is not allowed",
    );
  });
});
