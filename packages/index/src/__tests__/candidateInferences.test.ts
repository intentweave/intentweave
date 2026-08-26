// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { CandidateInferenceStore } from "../claims/inferences.js";
import { ClaimsStore } from "../claims/store.js";
import { fingerprint } from "../claims/canonical.js";
import { initSchema } from "../schema.js";

describe("CandidateInferenceStore", () => {
  let db: Database.Database;
  let store: CandidateInferenceStore;
  let evidenceVersionId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new CandidateInferenceStore(db);
    evidenceVersionId = new ClaimsStore(db).persistGenericEvidence({
      subjects: [
        {
          kind: "symbol",
          identityKey: "symbol:parseConfig",
          displayName: "parseConfig",
          role: "subject",
          basis: "test",
          confidence: "certain",
        },
      ],
      sourceKind: "documentation-reference",
      identityKey: "docs/api.md:parseConfig",
      fingerprint: fingerprint({ text: "parseConfig validates input" }),
      materialFingerprint: fingerprint({ text: "parseConfig validates input" }),
      normalizedValue: { text: "parseConfig validates input" },
      semanticLocation: "docs/api.md:1",
      provenance: { fixture: true },
      filePath: "docs/api.md",
      spanStartLine: 1,
      spanEndLine: 1,
    }).id;
  });

  afterEach(() => db.close());

  const input = (inputFingerprint: string, selected: string) => ({
    identityKey: "semantic-symbol-doc:docs/api.md:1",
    adapterId: "semantic-symbol-documentation-correlation",
    contractVersion: "1",
    providerId: "fixture-v2",
    modelId: "fixture-model",
    promptVersion: "1",
    inputFingerprint,
    normalizedOutput: { selectedCandidateId: selected },
    evidenceVersionIds: [evidenceVersionId],
    proposedSubjectBindings: [
      { role: "subject", identityKey: `symbol:${selected}` },
    ],
    confidence: "probable" as const,
    rationale: `Documentation refers to ${selected}`,
    provenance: { requestId: `request-${inputFingerprint}` },
  });

  it("reuses an exact input and appends changed or returning observations", () => {
    const first = store.persist(input("input-a", "parseConfig-a"));
    const repeated = store.persist(input("input-a", "parseConfig-a"));
    const changed = store.persist(input("input-b", "parseConfig-b"));
    const returning = store.persist(input("input-a", "parseConfig-a"));

    expect(first).toMatchObject({ ordinal: 1, created: true });
    expect(repeated).toEqual({ ...first, created: false });
    expect(changed).toMatchObject({ ordinal: 2, created: true });
    expect(returning).toMatchObject({ ordinal: 3, created: true });
    expect(store.findReusable(input("input-a", "ignored"))).toMatchObject({
      id: returning.id,
      ordinal: 3,
    });
    expect(store.list(first.identityKey).map((item) => item.ordinal)).toEqual([
      3, 2, 1,
    ]);
  });

  it("requires grounded Evidence and Subject proposals for probable results", () => {
    expect(() =>
      store.persist({
        ...input("input-a", "parseConfig-a"),
        evidenceVersionIds: [],
      }),
    ).toThrow("requires EvidenceVersion IDs");
    expect(() =>
      store.persist({
        ...input("input-a", "parseConfig-a"),
        evidenceVersionIds: ["missing-evidence@1"],
      }),
    ).toThrow("does not exist");
  });
});
