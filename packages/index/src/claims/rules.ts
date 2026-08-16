// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { ClaimScalar, NormalizedRuleResult } from "./types.js";

export function r1LiteralBinding(
  literalValue: ClaimScalar | undefined,
): NormalizedRuleResult {
  if (literalValue === undefined) {
    return {
      applicability: "applicable",
      status: "inconclusive",
      output: null,
      reasons: ["literal-binding-missing"],
    };
  }
  return {
    applicability: "applicable",
    status: "passed",
    output: { value: literalValue },
    reasons: ["literal-binding-found"],
  };
}

/**
 * R7 determines whether a valid scope can host a session runtime before R3
 * attempts to resolve a value in it. Unknown scopes are rejected by the CLI.
 */
export function r7ScopeOverride(
  capabilities: string[],
  configValue: ClaimScalar | undefined,
  requiredCapability = "session-runtime",
): NormalizedRuleResult {
  if (!capabilities.includes(requiredCapability)) {
    return {
      applicability: "not_applicable",
      status: "not_applicable",
      output: null,
      reasons: ["scope-capability-missing"],
    };
  }
  if (configValue === undefined) {
    return {
      applicability: "applicable",
      status: "inconclusive",
      output: null,
      reasons: ["scope-config-missing"],
    };
  }
  return {
    applicability: "applicable",
    status: "passed",
    output: { value: configValue },
    reasons: ["scope-config-present"],
  };
}

/** Resolve an effective value: an explicit scope override outranks a code default. */
export function r3ConfigResolution(
  defaultValue: ClaimScalar | undefined,
  overrideValue: ClaimScalar | undefined,
  precedence: "override-first" | "default-first" = "override-first",
): NormalizedRuleResult {
  if (precedence === "default-first" && defaultValue !== undefined) {
    return {
      applicability: "applicable",
      status: "passed",
      output: { value: defaultValue, source: "code-default" },
      reasons: ["code-default-precedence"],
    };
  }
  if (overrideValue !== undefined) {
    return {
      applicability: "applicable",
      status: "passed",
      output: { value: overrideValue, source: "scope-override" },
      reasons: ["environment-override-precedence"],
    };
  }
  if (defaultValue !== undefined) {
    return {
      applicability: "applicable",
      status: "passed",
      output: { value: defaultValue, source: "code-default" },
      reasons: ["code-default-fallback"],
    };
  }
  return {
    applicability: "applicable",
    status: "inconclusive",
    output: null,
    reasons: ["config-resolution-evidence-missing"],
  };
}

/** R3's documentation-conformance variant is a direct same-scope comparison. */
export function r3DocumentationConformance(
  documentedValue: ClaimScalar | undefined,
  effectiveValue: ClaimScalar | undefined,
): NormalizedRuleResult {
  if (documentedValue === undefined || effectiveValue === undefined) {
    return {
      applicability: "applicable",
      status: "inconclusive",
      output: null,
      reasons: ["documentation-or-effective-value-missing"],
    };
  }
  if (documentedValue === effectiveValue) {
    return {
      applicability: "applicable",
      status: "passed",
      output: { documentedValue, effectiveValue },
      reasons: ["documentation-matches-effective-value"],
    };
  }
  return {
    applicability: "applicable",
    status: "failed",
    output: { documentedValue, effectiveValue },
    reasons: ["documentation-drift"],
  };
}