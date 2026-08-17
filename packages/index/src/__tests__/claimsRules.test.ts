// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  r1LiteralBinding,
  r3ConfigResolution,
  r3DocumentationConformance,
  r7ScopeOverride,
} from "../claims/rules.js";

describe("Claims rule adapters", () => {
  it("does not treat a missing literal binding as a passing R1 result", () => {
    expect(r1LiteralBinding(undefined)).toMatchObject({
      applicability: "applicable",
      status: "inconclusive",
      reasons: ["literal-binding-missing"],
    });
    expect(r1LiteralBinding(1800)).toMatchObject({ status: "passed" });
  });

  it("distinguishes R7 not-applicable from evidence insufficiency", () => {
    expect(r7ScopeOverride(["static-preview"], undefined)).toMatchObject({
      applicability: "not_applicable",
      status: "not_applicable",
    });
    expect(r7ScopeOverride(["session-runtime"], undefined)).toMatchObject({
      applicability: "applicable",
      status: "inconclusive",
    });
    expect(r7ScopeOverride(["session-runtime"], 3600)).toMatchObject({
      status: "passed",
      output: { value: 3600 },
    });
  });

  it("prefers the scope override but allows a complete default fallback", () => {
    expect(r3ConfigResolution(1800, 3600)).toMatchObject({
      status: "passed",
      output: { value: 3600, source: "scope-override" },
    });
    expect(r3ConfigResolution(1800, undefined)).toMatchObject({
      status: "passed",
      output: { value: 1800, source: "code-default" },
    });
    expect(r3ConfigResolution(undefined, undefined)).toMatchObject({
      status: "inconclusive",
    });
  });

  it("turns same-scope documentation drift into a failed R3 result", () => {
    expect(r3DocumentationConformance(3600, 3600)).toMatchObject({
      status: "passed",
    });
    expect(r3DocumentationConformance(3600, 5400)).toMatchObject({
      status: "failed",
      reasons: ["documentation-drift"],
    });
    expect(r3DocumentationConformance(undefined, 5400)).toMatchObject({
      status: "inconclusive",
    });
  });
});
