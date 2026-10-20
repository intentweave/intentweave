// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ClaimsPortableStateError,
  emptyPortableClaimsState,
  parsePortableClaimsState,
  portableRecommendationBasisKey,
  type PortableClaimsState,
} from "../claims/portableState.js";

const fingerprint = (character: string): string => character.repeat(64);

function validState(): PortableClaimsState {
  return {
    schemaVersion: "1",
    policies: {
      "r1-continuous-auto-promote": {
        version: "1",
        enabled: false,
        configuration: { claimTypes: ["CLM-LITERAL", "CLM-DEFAULT"] },
      },
    },
    candidateDecisions: {
      "candidate:endpoint-admin-users": {
        decision: "promote",
        candidateFingerprint: fingerprint("a"),
        actor: { kind: "human", id: "benjamin" },
        decidedAt: "2026-08-20T10:00:00Z",
        rationale: "Security-relevant endpoint",
      },
    },
    subjectBindings: {
      "binding:endpoint-admin-users": {
        subjectIdentity: "endpoint:http:POST:/admin/users",
        subjectRole: "endpoint",
        evidenceIdentity: "evidence:route:admin-users",
        confidence: "certain",
        basis: "explicit",
        actor: { kind: "human", id: "benjamin" },
        boundAt: "2026-08-20T10:01:00Z",
        rationale: "Explicit route binding",
      },
    },
    assessmentReviews: {
      "claim:endpoint-admin-users-authenticated": {
        decision: "accepted",
        assessmentFingerprint: fingerprint("b"),
        assessmentPolicyId: "endpoint-auth",
        assessmentPolicyVersion: "1",
        actor: { kind: "human", id: "benjamin" },
        decidedAt: "2026-08-20T10:02:00Z",
        rationale: "Guard evidence verified",
      },
    },
    baselineAcceptances: {
      "baseline:initial": {
        repositoryRevision: "0123456789abcdef",
        claims: {
          "claim:session-timeout": fingerprint("c"),
        },
        actor: { kind: "human", id: "benjamin" },
        acceptedAt: "2026-08-20T10:03:00Z",
        rationale: "Initial reviewed baseline",
      },
    },
    claimOrigins: {
      "claim:endpoint-admin-users-authenticated": [
        {
          contractVersion: "1",
          kind: "declared",
          source: "adr",
          sourceIdentity: "docs/ADR-017.md#admin-users",
          sourceVersion: "adr-017@1",
          provenance: { section: "Security" },
        },
      ],
    },
  };
}

describe("Claims portable state", () => {
  it("validates and sorts effective state maps", () => {
    const state = validState();
    state.policies = {
      zebra: { version: "1", enabled: true, configuration: {} },
      alpha: { version: "1", enabled: false, configuration: {} },
    };

    expect(Object.keys(parsePortableClaimsState(state).policies)).toEqual([
      "alpha",
      "zebra",
    ]);
    expect(emptyPortableClaimsState()).toEqual({
      schemaVersion: "6",
      policies: {},
      candidateDecisions: {},
      subjectBindings: {},
      assessmentReviews: {},
      baselineAcceptances: {},
      claimOrigins: {},
      intentAnchors: {},
      conflictDecisions: {},
      claimRelations: {},
    });
  });

  it("fails closed for unsupported versions and unknown fields", () => {
    expect(() =>
      parsePortableClaimsState({ ...validState(), schemaVersion: "7" }),
    ).toThrow("must be one of: 1, 2, 3, 4, 5, 6");
    expect(() =>
      parsePortableClaimsState({ ...validState(), providerPayloads: {} }),
    ).toThrow("providerPayloads is not supported");
  });

  it("requires complete policy and inference provenance", () => {
    const policyDecision = validState();
    policyDecision.candidateDecisions["candidate:endpoint-admin-users"] = {
      ...policyDecision.candidateDecisions["candidate:endpoint-admin-users"],
      actor: { kind: "policy", id: "security-endpoints" },
    };
    expect(() => parsePortableClaimsState(policyDecision)).toThrow(
      "actor.version is required for a policy actor",
    );

    const inferenceBinding = validState();
    inferenceBinding.subjectBindings["binding:endpoint-admin-users"] = {
      ...inferenceBinding.subjectBindings["binding:endpoint-admin-users"],
      basis: "inference",
    };
    expect(() => parsePortableClaimsState(inferenceBinding)).toThrow(
      "inferenceFingerprint is required for inference basis",
    );
  });

  it("validates and preserves a canonical v2 recommendation basis", () => {
    const basisWithoutKey = {
      contractVersion: "candidate-triage-recommendation@1" as const,
      candidateObservationFingerprint: fingerprint("d"),
      contextFingerprint: fingerprint("e"),
      inferenceFingerprint: fingerprint("f"),
      adapterId: "candidate-triage",
      adapterContractVersion: "1",
      promptVersion: "prompt-1",
      providerId: "openai",
      requestedModelId: "gpt-test",
      effectiveModelId: "gpt-test-2026",
      outputFingerprint: fingerprint("a"),
      recommendation: "promote" as const,
      priority: "high" as const,
    };
    const state = validState();
    state.schemaVersion = "2";
    state.candidateDecisions["candidate:endpoint-admin-users"] = {
      ...state.candidateDecisions["candidate:endpoint-admin-users"],
      recommendationBasis: {
        ...basisWithoutKey,
        recommendationKey: portableRecommendationBasisKey(basisWithoutKey),
      },
    };

    const parsed = parsePortableClaimsState(state);
    expect(parsed.schemaVersion).toBe("6");
    expect(
      parsed.candidateDecisions["candidate:endpoint-admin-users"]
        .recommendationBasis,
    ).toEqual({
      ...basisWithoutKey,
      recommendationKey: portableRecommendationBasisKey(basisWithoutKey),
    });
  });

  it("rejects recommendation basis data in legacy schema v1", () => {
    const state = validState();
    state.schemaVersion = "1";
    const basisWithoutKey = {
      contractVersion: "candidate-triage-recommendation@1" as const,
      candidateObservationFingerprint: fingerprint("d"),
      contextFingerprint: fingerprint("e"),
      inferenceFingerprint: fingerprint("f"),
      adapterId: "candidate-triage",
      adapterContractVersion: "1",
      promptVersion: "prompt-1",
      providerId: "openai",
      requestedModelId: "gpt-test",
      effectiveModelId: "gpt-test-2026",
      outputFingerprint: fingerprint("a"),
      recommendation: "promote" as const,
      priority: "high" as const,
    };
    state.candidateDecisions["candidate:endpoint-admin-users"] = {
      ...state.candidateDecisions["candidate:endpoint-admin-users"],
      recommendationBasis: {
        ...basisWithoutKey,
        recommendationKey: portableRecommendationBasisKey(basisWithoutKey),
      },
    };

    expect(() => parsePortableClaimsState(state)).toThrow(
      "recommendationBasis requires schemaVersion 2 or later",
    );
  });

  it("rejects conflicting effective bindings and baseline decisions", () => {
    const bindingConflict = validState();
    bindingConflict.subjectBindings["binding:conflict"] = {
      ...bindingConflict.subjectBindings["binding:endpoint-admin-users"],
      subjectIdentity: "endpoint:http:POST:/different",
    };
    expect(() => parsePortableClaimsState(bindingConflict)).toThrow(
      "for the same evidence identity and role",
    );

    const baselineConflict = validState();
    baselineConflict.baselineAcceptances["baseline:second"] = {
      ...baselineConflict.baselineAcceptances["baseline:initial"],
      claims: { "claim:session-timeout": fingerprint("d") },
    };
    expect(() => parsePortableClaimsState(baselineConflict)).toThrow(
      "for claim claim:session-timeout",
    );
  });

  it("rejects non-canonical fingerprints", () => {
    const state = validState();
    state.assessmentReviews[
      "claim:endpoint-admin-users-authenticated"
    ].assessmentFingerprint = "local-row-id";
    expect(() => parsePortableClaimsState(state)).toThrow(
      ClaimsPortableStateError,
    );
  });

  it("rejects normalized-looking but invalid calendar timestamps", () => {
    const state = validState();
    state.candidateDecisions["candidate:endpoint-admin-users"].decidedAt =
      "2026-02-30T10:00:00Z";
    expect(() => parsePortableClaimsState(state)).toThrow(
      "must be an RFC 3339 UTC timestamp",
    );
  });

  describe("G5.4 sections are gated by the version that introduced them", () => {
    const anchor = {
      claimIdentityId: "claim:timeout",
      scope: "claim",
      statementFingerprint: "a".repeat(64),
      mode: "protect",
      authority: "human",
      source: "review",
      status: "active",
      actor: { kind: "human", id: "reviewer" },
      decidedAt: "2026-10-20T00:00:00.000Z",
    };

    it("reads a version 4 state with intent anchors and conflict decisions", () => {
      const parsed = parsePortableClaimsState({
        ...validState(),
        schemaVersion: "4",
        intentAnchors: { "anchor:one": anchor },
        conflictDecisions: {},
      });
      expect(parsed.schemaVersion).toBe("6");
      expect(Object.keys(parsed.intentAnchors)).toEqual(["anchor:one"]);
    });

    it("rejects intent anchors in a version 2 state", () => {
      expect(() =>
        parsePortableClaimsState({
          ...validState(),
          schemaVersion: "2",
          intentAnchors: { "anchor:one": anchor },
        }),
      ).toThrow(/intentAnchors require schemaVersion 3/);
    });

    it("rejects conflict decisions in a version 3 state", () => {
      expect(() =>
        parsePortableClaimsState({
          ...validState(),
          schemaVersion: "3",
          conflictDecisions: {},
        }),
      ).toThrow(/conflictDecisions require schemaVersion 4/);
    });

    it("rejects an ai-proposed anchor in a version 4 state, and accepts it in version 5", () => {
      const proposed = { ...anchor, authority: "ai-proposed" };
      expect(() =>
        parsePortableClaimsState({
          ...validState(),
          schemaVersion: "4",
          intentAnchors: { "anchor:one": proposed },
        }),
      ).toThrow(/ai-proposed requires schemaVersion 5/);
      expect(
        parsePortableClaimsState({
          ...validState(),
          schemaVersion: "5",
          intentAnchors: { "anchor:one": proposed },
        }).intentAnchors["anchor:one"]?.authority,
      ).toBe("ai-proposed");
    });
  });
  it("gates claim relations to schema version 6", () => {
    const relation = {
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      status: "active",
      actor: { kind: "human", id: "reviewer" },
      createdAt: "2026-10-20T00:00:00.000Z",
    };
    expect(() =>
      parsePortableClaimsState({
        ...validState(),
        schemaVersion: "5",
        claimRelations: { "relation:one": relation },
      }),
    ).toThrow(/claimRelations require schemaVersion 6/);
    expect(
      parsePortableClaimsState({
        ...validState(),
        schemaVersion: "6",
        claimRelations: { "relation:one": relation },
      }).claimRelations["relation:one"]?.relation,
    ).toBe("realizes");
  });
});
