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
        exported: true,
        topLevel: true,
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

  it("extracts a Commander option default only as explicitly bindable evidence", () => {
    const evidence = extractClaimEvidence(
      `build.option("--depth <depth>", "Annotation depth", "full");`,
      "src/cli.ts",
    );

    expect(evidence.literalBindings).toMatchObject([
      {
        kind: "option-default",
        name: "--depth <depth>",
        normalizedValue: "full",
      },
    ]);
  });

  it("extracts claims from source files larger than the direct parser limit", () => {
    const evidence = extractClaimEvidence(
      `${"// padding\n".repeat(4_000)}export const LARGE_FILE_DEFAULT = 42;`,
      "src/large.ts",
    );

    expect(evidence.literalBindings).toMatchObject([
      { name: "LARGE_FILE_DEFAULT", normalizedValue: 42 },
    ]);
  });
});
