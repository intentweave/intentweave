// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CLAIMS_EXIT_CODE, claimsExitCode } from "../claims/exitCode.js";
import type { ClaimsExitInput } from "../claims/types.js";

const base: ClaimsExitInput = {
  ruleStatuses: [],
  assessmentStatuses: [],
  reviewRequired: false,
};

describe("claimsExitCode", () => {
  it("pins the public v1 exit-code table", () => {
    expect(CLAIMS_EXIT_CODE).toEqual({
      success: 0,
      failed: 1,
      inconclusive: 2,
      notApplicable: 3,
      reviewRequired: 4,
      invalidInput: 64,
    });
  });

  it("uses the specified priority order", () => {
    expect(
      claimsExitCode({
        ...base,
        invalidInput: true,
        ruleStatuses: ["failed"],
        assessmentStatuses: ["inconclusive"],
        reviewRequired: true,
      }),
    ).toBe(CLAIMS_EXIT_CODE.invalidInput);
    expect(
      claimsExitCode({
        ...base,
        assessmentStatuses: ["refuted"],
        reviewRequired: true,
      }),
    ).toBe(CLAIMS_EXIT_CODE.failed);
    expect(
      claimsExitCode({
        ...base,
        assessmentStatuses: ["inconclusive"],
        reviewRequired: true,
      }),
    ).toBe(CLAIMS_EXIT_CODE.inconclusive);
    expect(claimsExitCode({ ...base, reviewRequired: true })).toBe(
      CLAIMS_EXIT_CODE.reviewRequired,
    );
    expect(claimsExitCode({ ...base, ruleStatuses: ["not_applicable"] })).toBe(
      CLAIMS_EXIT_CODE.notApplicable,
    );
    expect(claimsExitCode(base)).toBe(CLAIMS_EXIT_CODE.success);
  });
});
