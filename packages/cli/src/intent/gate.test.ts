// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { RulesCheckResult, RulesViolation } from "@intentweave/index";
import {
  aggregateIntentExitCode,
  partitionGovernedRuleViolations,
  ruleViolationSignature,
} from "./gate.js";

function violation(
  input: {
    ruleId?: string;
    filePath?: string;
    detail?: string;
  } = {},
): RulesViolation {
  return {
    ruleId: input.ruleId ?? "no-ui-to-persistence",
    ruleDescription: "UI must not import persistence",
    ruleSeverity: "high",
    ruleDomain: "structural",
    ruleMode: "error",
    filePath: input.filePath ?? "src/ui/view.ts",
    line: 1,
    detail:
      input.detail ?? "Import ../persistence/db matches forbidden pattern",
  };
}

describe("Unified Intent gate", () => {
  it("moves exact governed Architecture violations out of the raw Rules gate", () => {
    const governedViolation = violation();
    const independentViolation = violation({
      ruleId: "no-api-to-storage",
      filePath: "src/api/users.ts",
      detail: "Import ../storage/db matches forbidden pattern",
    });
    const result: RulesCheckResult = {
      violations: [governedViolation, independentViolation],
      totalViolations: 2,
      bySeverity: { high: 2, medium: 0, low: 0 },
      byRule: { "no-ui-to-persistence": 1, "no-api-to-storage": 1 },
      rulesChecked: 2,
    };
    const partition = partitionGovernedRuleViolations(
      result,
      new Map([
        [ruleViolationSignature(governedViolation), "claim:architecture"],
      ]),
    );
    expect(partition.rules).toMatchObject({
      totalViolations: 1,
      bySeverity: { high: 1, medium: 0, low: 0 },
      byRule: { "no-api-to-storage": 1 },
    });
    expect(partition.governed).toEqual([
      {
        claimIdentityId: "claim:architecture",
        violation: governedViolation,
      },
    ]);
  });

  it("uses the established aggregate exit priority", () => {
    expect(aggregateIntentExitCode(0, 4)).toBe(4);
    expect(aggregateIntentExitCode(1, 2, 4)).toBe(1);
    expect(aggregateIntentExitCode(64, 1)).toBe(64);
  });
});
