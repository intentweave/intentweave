// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assessmentKey,
  canonicalJson,
  materialFingerprint,
  ruleResultFingerprint,
} from "../claims/canonical.js";

describe("claims canonicalization", () => {
  it("sorts object keys while preserving explicit null", () => {
    expect(canonicalJson({ beta: null, alpha: [true, 1] })).toBe(
      '{"alpha":[true,1],"beta":null}',
    );
  });

  it("rejects undefined instead of conflating it with null", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("undefined");
  });

  it("ignores reason and evidence ordering in rule-result fingerprints", () => {
    const first = ruleResultFingerprint({
      applicability: "applicable",
      normalizedStatus: "passed",
      normalizedOutput: { value: 5400, scope: "eu-prod" },
      normalizedReasons: ["config-present", "scope-applicable"],
      evidenceVersionIds: ["evidence:config", "evidence:scope"],
      ruleContractVersion: "r3-v1",
      implementationFingerprint: "impl-v1",
    });
    const second = ruleResultFingerprint({
      applicability: "applicable",
      normalizedStatus: "passed",
      normalizedOutput: { scope: "eu-prod", value: 5400 },
      normalizedReasons: ["scope-applicable", "config-present"],
      evidenceVersionIds: ["evidence:scope", "evidence:config"],
      ruleContractVersion: "r3-v1",
      implementationFingerprint: "impl-v1",
    });

    expect(second).toBe(first);
  });

  it("sorts assessment dependencies and keeps warrant null explicit", () => {
    const first = assessmentKey("claim:v1", [
      {
        dependencyKind: "rule_result_version",
        dependencyVersionId: "rule:r3:v1",
        epistemicRole: "warrant",
        warrantPolarity: "supports",
        assessmentEffect: "supports",
      },
      {
        dependencyKind: "evidence_version",
        dependencyVersionId: "evidence:code:v1",
        epistemicRole: "assertion",
        warrantPolarity: null,
        assessmentEffect: "supports",
      },
    ]);
    const second = assessmentKey("claim:v1", [
      {
        dependencyKind: "evidence_version",
        dependencyVersionId: "evidence:code:v1",
        epistemicRole: "assertion",
        warrantPolarity: null,
        assessmentEffect: "supports",
      },
      {
        dependencyKind: "rule_result_version",
        dependencyVersionId: "rule:r3:v1",
        epistemicRole: "warrant",
        warrantPolarity: "supports",
        assessmentEffect: "supports",
      },
    ]);

    expect(second).toBe(first);
    expect(
      assessmentKey("claim:v1", [
        {
          dependencyKind: "evidence_version",
          dependencyVersionId: "evidence:code:v1",
          epistemicRole: "assertion",
          warrantPolarity: null,
          assessmentEffect: "supports",
        },
      ]),
    ).not.toBe(first);
  });

  it("excludes source paths and symbols from materiality", () => {
    const fingerprint = materialFingerprint({
      parameterIdentity: "session.timeout",
      semanticLocation: "session.timeout",
      normalizedValue: 1800,
    });

    expect(
      materialFingerprint({
        parameterIdentity: "session.timeout",
        semanticLocation: "session.timeout",
        normalizedValue: 1800,
      }),
    ).toBe(fingerprint);
  });
});
