// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assessClaimPolicy, assessRuleResults } from "../claims/policies.js";

describe("claims assessment policy", () => {
  it("supports a claim only with positive applicable results", () => {
    const assessment = assessRuleResults([
      {
        ruleResultVersionId: "r1@1",
        epistemicRole: "assertion",
        status: "passed",
      },
      {
        ruleResultVersionId: "r3@1",
        epistemicRole: "warrant",
        status: "passed",
      },
    ]);

    expect(assessment.status).toBe("supported");
    expect(assessment.dependencies).toContainEqual({
      dependencyKind: "rule_result_version",
      dependencyVersionId: "r3@1",
      epistemicRole: "warrant",
      warrantPolarity: "supports",
      assessmentEffect: "supports",
    });
  });

  it("does not treat silence or not-applicable results as support", () => {
    expect(assessRuleResults([]).status).toBe("inconclusive");
    expect(
      assessRuleResults([
        {
          ruleResultVersionId: "r3@1",
          epistemicRole: "warrant",
          status: "not_applicable",
        },
      ]).status,
    ).toBe("inconclusive");
  });

  it("keeps incomplete evidence inconclusive", () => {
    expect(
      assessRuleResults([
        {
          ruleResultVersionId: "r1@1",
          epistemicRole: "assertion",
          status: "passed",
        },
        {
          ruleResultVersionId: "r3@1",
          epistemicRole: "warrant",
          status: "inconclusive",
        },
      ]).status,
    ).toBe("inconclusive");
  });

  it("distinguishes refuted and contested claims", () => {
    expect(
      assessRuleResults([
        {
          ruleResultVersionId: "r3@1",
          epistemicRole: "warrant",
          status: "failed",
        },
      ]).status,
    ).toBe("refuted");
    expect(
      assessRuleResults([
        {
          ruleResultVersionId: "r1@1",
          epistemicRole: "assertion",
          status: "passed",
        },
        {
          ruleResultVersionId: "r3@1",
          epistemicRole: "warrant",
          status: "failed",
        },
      ]).status,
    ).toBe("contested");
  });

  it("does not let descriptive documentation overturn an authoritative warrant", () => {
    const assessment = assessClaimPolicy([
      {
        dependencyKind: "rule_result_version",
        dependencyVersionId: "r3-effective@1",
        epistemicRole: "warrant",
        authoritative: true,
        ruleStatus: "passed",
      },
      {
        dependencyKind: "evidence_version",
        dependencyVersionId: "doc@1",
        epistemicRole: "assertion",
        authoritative: false,
        assertionValue: 3600,
        claimValue: 5400,
      },
    ]);

    expect(assessment.status).toBe("supported");
    expect(assessment.dependencies[1].assessmentEffect).toBe("contradicts");
  });

  it("marks equal-authority contradictory assertions as contested", () => {
    expect(
      assessClaimPolicy([
        {
          dependencyKind: "evidence_version",
          dependencyVersionId: "literal@1",
          epistemicRole: "assertion",
          authoritative: true,
          assertionValue: 1800,
          claimValue: 1800,
        },
        {
          dependencyKind: "evidence_version",
          dependencyVersionId: "annotation@1",
          epistemicRole: "assertion",
          authoritative: true,
          assertionValue: 3600,
          claimValue: 1800,
        },
      ]).status,
    ).toBe("contested");
  });
});
