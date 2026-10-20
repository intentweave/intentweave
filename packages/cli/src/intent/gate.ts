// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import type { RulesCheckResult, RulesViolation } from "@intentweave/index";

interface ArchitectureRuleOutput {
  architectureRuleId?: unknown;
  violations?: unknown;
}

interface ArchitectureViolation {
  filePath?: unknown;
  line?: unknown;
  detail?: unknown;
}

export interface GovernedArchitectureViolation {
  claimIdentityId: string;
  violation: RulesViolation;
}

export function ruleViolationSignature(
  violation: Pick<RulesViolation, "ruleId" | "filePath" | "line" | "detail">,
): string {
  return JSON.stringify([
    violation.ruleId,
    violation.filePath,
    violation.line ?? null,
    violation.detail,
  ]);
}

export function governedArchitectureViolationClaims(
  database: Database.Database,
): Map<string, string> {
  const rows = database
    .prepare(
      `SELECT identity.id AS claim_identity_id, rule.normalized_output_json
       FROM claim_assessments assessment
       JOIN claim_versions version ON version.id = assessment.claim_version_id
       JOIN claim_identities identity ON identity.id = version.claim_identity_id
       JOIN claim_assessment_dependencies dependency
         ON dependency.claim_assessment_id = assessment.id
        AND dependency.dependency_kind = 'rule_result_version'
       JOIN rule_result_versions rule ON rule.id = dependency.dependency_version_id
       JOIN rule_result_identities rule_identity
         ON rule_identity.id = rule.rule_result_identity_id
       WHERE assessment.is_current = 1
         AND identity.claim_type = 'CLM-DEPENDENCY-CONFORMANCE'
         AND rule_identity.rule_id = 'R.dependency-conformance'`,
    )
    .all() as Array<{
    claim_identity_id: string;
    normalized_output_json: string;
  }>;
  const governed = new Map<string, string>();
  for (const row of rows) {
    const output = JSON.parse(
      row.normalized_output_json,
    ) as ArchitectureRuleOutput;
    if (
      typeof output.architectureRuleId !== "string" ||
      !Array.isArray(output.violations)
    ) {
      continue;
    }
    for (const value of output.violations) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const violation = value as ArchitectureViolation;
      if (
        typeof violation.filePath !== "string" ||
        typeof violation.detail !== "string"
      ) {
        continue;
      }
      governed.set(
        ruleViolationSignature({
          ruleId: output.architectureRuleId,
          filePath: violation.filePath,
          line: typeof violation.line === "number" ? violation.line : null,
          detail: violation.detail,
        }),
        row.claim_identity_id,
      );
    }
  }
  return governed;
}

export function partitionGovernedRuleViolations(
  result: RulesCheckResult,
  governedClaims: ReadonlyMap<string, string>,
): {
  rules: RulesCheckResult;
  governed: GovernedArchitectureViolation[];
} {
  const governed: GovernedArchitectureViolation[] = [];
  const remaining = result.violations.filter((violation) => {
    const claimIdentityId = governedClaims.get(
      ruleViolationSignature(violation),
    );
    if (!claimIdentityId) return true;
    governed.push({ claimIdentityId, violation });
    return false;
  });
  const bySeverity: RulesCheckResult["bySeverity"] = {
    high: 0,
    medium: 0,
    low: 0,
  };
  const byRule: RulesCheckResult["byRule"] = {};
  for (const violation of remaining) {
    bySeverity[violation.ruleSeverity] += 1;
    byRule[violation.ruleId] = (byRule[violation.ruleId] ?? 0) + 1;
  }
  return {
    rules: {
      ...result,
      violations: remaining,
      totalViolations: remaining.length,
      bySeverity,
      byRule,
    },
    governed,
  };
}

const EXIT_PRIORITY = new Map([
  [64, 6],
  [1, 5],
  [2, 4],
  [4, 3],
  [3, 2],
  [0, 1],
]);

export function aggregateIntentExitCode(...exitCodes: number[]): number {
  return exitCodes.reduce(
    (selected, candidate) =>
      (EXIT_PRIORITY.get(candidate) ?? 0) > (EXIT_PRIORITY.get(selected) ?? 0)
        ? candidate
        : selected,
    0,
  );
}
