// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  candidateDisplayLines,
  candidateInboxLines,
  describeClaim,
  humanizeReason,
  shortCandidateReference,
} from "./presentation.js";

describe("Claims text presentation", () => {
  it("renders repository claim families as readable statements", () => {
    expect(
      describeClaim("CLM-DEPENDENCY-CONFORMANCE", {
        source: "packages/cli/src/**",
        target: "@intentweave/index",
      }),
    ).toBe("packages/cli/src/** must not import @intentweave/index");
    expect(
      describeClaim("CLM-ENDPOINT-AUTHENTICATED", {
        method: "POST",
        path: "/admin/users",
      }),
    ).toBe("POST /admin/users must be authenticated");
    expect(
      describeClaim("CLM-PUBLIC-SYMBOL-DOCUMENTED", {
        symbolKind: "function",
        symbolName: "parseConfig",
      }),
    ).toBe("Public function parseConfig must be documented");
  });

  function architectureCandidate(
    input: {
      id?: string;
      target?: string;
      ruleId?: string;
    } = {},
  ) {
    return {
      id:
        input.id ??
        "candidate:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890@2",
      identityKey: "dependency:abc",
      ordinal: 2,
      state: "triaged",
      fingerprint: "fingerprint",
      observationFingerprint: "observation",
      created: false,
      candidateKind: "architecture-dependency-conformance",
      proposedClaimType: "CLM-DEPENDENCY-CONFORMANCE",
      discoveryMode: "deterministic",
      discoveryAdapterId: "architecture",
      discoveryContractVersion: "1",
      confidence: "certain",
      normalizedStatement: {
        source: "packages/cli/src/**",
        target: input.target ?? "@intentweave/index",
        ruleId: input.ruleId ?? "no-cli-to-index",
      },
      provenance: {},
      evidence: [],
      subjects: [
        {
          kind: "module",
          identityKey: "module:architecture-scope:hash",
          displayName: "packages/cli/src/**",
          role: "source",
          basis: "rules-yaml-import-scope",
          confidence: "certain",
        },
      ],
    } as const;
  }

  it("uses short copyable references in compact output and full IDs in verbose output", () => {
    const candidate = architectureCandidate();
    expect(candidateDisplayLines(candidate)).toEqual([
      "packages/cli/src/** must not import @intentweave/index",
      "  triaged, confidence certain",
      "  Ref: candidate:abcdef1234@2",
    ]);
    expect(candidateDisplayLines(candidate, { verbose: true })).toEqual([
      "packages/cli/src/** must not import @intentweave/index",
      "  Status: triaged",
      "  Type: Architecture dependency (CLM-DEPENDENCY-CONFORMANCE)",
      "  Confidence: certain",
      "  Subjects: source=packages/cli/src/**",
      "  Rule: no-cli-to-index",
      "  Candidate ID: candidate:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890@2",
    ]);
    expect(shortCandidateReference(candidate.id)).toBe(
      "candidate:abcdef1234@2",
    );
  });

  it("groups architecture Candidates by Rule in the compact inbox", () => {
    expect(
      candidateInboxLines([
        architectureCandidate(),
        architectureCandidate({
          id: "candidate:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef@2",
          target: "@intentweave/core",
        }),
      ]),
    ).toEqual([
      "Rule no-cli-to-index (2 Candidates)",
      "  packages/cli/src/** must not import @intentweave/index",
      "    triaged, confidence certain | candidate:abcdef1234@2",
      "  packages/cli/src/** must not import @intentweave/core",
      "    triaged, confidence certain | candidate:1234567890@2",
    ]);
  });

  it("keeps reason codes searchable next to readable explanations", () => {
    expect(humanizeReason("forbidden-dependency-detected")).toBe(
      "A forbidden dependency was detected.",
    );
    expect(humanizeReason("custom-policy-result")).toBe(
      "Custom policy result.",
    );
  });
});
