// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { extractClaimEvidence } from "./claimEvidence.js";

describe("extractClaimEvidence", () => {
  it("extracts a bound literal and its immediate JSDoc default", () => {
    const evidence = extractClaimEvidence(
      `/**\n * @default 1800\n * @example SESSION_TIMEOUT = 7200\n */\nexport const SESSION_TIMEOUT = 1800;`,
      "src/session.ts",
    );

    expect(evidence.literalBindings).toMatchObject([
      {
        kind: "variable",
        name: "SESSION_TIMEOUT",
        normalizedValue: 1800,
      },
    ]);
    expect(evidence.codeAnnotations).toMatchObject([
      { tag: "default", normalizedValue: 1800 },
    ]);
  });

  it("does not turn values inside an example block into defaults", () => {
    const evidence = extractClaimEvidence(
      `/**\n * @example\n * @default 7200\n */\nconst SESSION_TIMEOUT = 1800;`,
      "src/session.ts",
    );

    expect(evidence.codeAnnotations).toEqual([]);
  });

  it("extracts destructuring and parameter defaults as distinct R1 bindings", () => {
    const evidence = extractClaimEvidence(
      `const { timeout = 1800 } = config;\nfunction start(retries = 3) {}`,
      "src/session.ts",
    );

    expect(evidence.literalBindings).toMatchObject([
      { kind: "destructuring-default", name: "timeout", normalizedValue: 1800 },
      { kind: "parameter-default", name: "retries", normalizedValue: 3 },
    ]);
  });
});