// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ClaimsPortableStateError,
  emptyPortableClaimsState,
  parsePortableClaimsState,
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
      schemaVersion: "1",
      policies: {},
      candidateDecisions: {},
      subjectBindings: {},
      assessmentReviews: {},
      baselineAcceptances: {},
    });
  });

  it("fails closed for unsupported versions and unknown fields", () => {
    expect(() =>
      parsePortableClaimsState({ ...validState(), schemaVersion: "2" }),
    ).toThrow("schemaVersion must be 1");
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
});
