// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { ClaimsExitInput } from "./types.js";

export const CLAIMS_EXIT_CODE = {
  success: 0,
  failed: 1,
  inconclusive: 2,
  notApplicable: 3,
  reviewRequired: 4,
  invalidInput: 64,
} as const;

/** Apply the public Claims CLI exit priority from V1.1 section 8. */
export function claimsExitCode(input: ClaimsExitInput): number {
  if (input.invalidInput) return CLAIMS_EXIT_CODE.invalidInput;
  if (
    input.ruleStatuses.includes("failed") ||
    input.assessmentStatuses.includes("refuted") ||
    input.assessmentStatuses.includes("contested")
  ) {
    return CLAIMS_EXIT_CODE.failed;
  }
  if (
    input.discoveryEmpty ||
    input.ruleStatuses.includes("inconclusive") ||
    input.assessmentStatuses.includes("inconclusive")
  ) {
    return CLAIMS_EXIT_CODE.inconclusive;
  }
  if (input.reviewRequired) return CLAIMS_EXIT_CODE.reviewRequired;
  if (input.ruleStatuses.includes("not_applicable")) {
    return CLAIMS_EXIT_CODE.notApplicable;
  }
  return CLAIMS_EXIT_CODE.success;
}