// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { assessRuleResults } from "../claims/policies.js";

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
});