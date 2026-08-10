// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ClaimsBindingError,
  extractBoundCodeEvidence,
  extractDocumentationAssertions,
  parseClaimsBindings,
} from "./discovery.js";

const bindings = parseClaimsBindings({
  parameters: {
    "session.timeout": {
      configKeys: ["session.timeout"],
      codeDefaults: [{ file: "src/session.ts", export: "SESSION_TIMEOUT" }],
      documentation: [
        {
          file: "docs/session-timeout.md",
          assertions: [
            {
              id: "default-doc",
              target: "default",
              pattern: "^The default timeout is (?<value>\\d+) seconds\\.$",
            },
            {
              id: "eu-prod-doc",
              target: "effective",
              scope: "eu-prod",
              pattern: "^The eu-prod override is (?<value>\\d+) seconds\\.$",
            },
          ],
        },
      ],
    },
  },
});

describe("Claims documentation discovery", () => {
  it("extracts only explicitly bound single-line assertions", () => {
    const observations = extractDocumentationAssertions(bindings, (file) => {
      expect(file).toBe("docs/session-timeout.md");
      return [
        "The default timeout is 1800 seconds.",
        "The eu-prod override is 3600 seconds.",
        "An unrelated timeout is 7200 seconds.",
      ].join("\n");
    });

    expect(observations).toMatchObject([
      {
        kind: "evidence",
        identityKey: "session.timeout:documentation:default-doc",
        semanticLocation: "session.timeout.default",
        normalizedValue: 1800,
      },
      {
        kind: "evidence",
        semanticLocation: "session.timeout.override[eu-prod]",
        normalizedValue: 3600,
      },
    ]);
  });

  it("extracts only explicitly bound code defaults and their direct annotations", () => {
    const observations = extractBoundCodeEvidence(bindings, (file) => {
      expect(file).toBe("src/session.ts");
      return `/**\n * @default 1800\n * @example SESSION_TIMEOUT = 7200\n */\nexport const SESSION_TIMEOUT = 1800;\nconst UNRELATED_TIMEOUT = 9000;`;
    });

    expect(observations).toMatchObject([
      {
        sourceKind: "code-default",
        normalizedValue: 1800,
        semanticLocation: "session.timeout",
      },
      {
        sourceKind: "code-annotation",
        normalizedValue: 1800,
        semanticLocation: "session.timeout.default",
      },
    ]);
  });

  it("normalizes missing and ambiguous assertions to inconclusive", () => {
    const observations = extractDocumentationAssertions(bindings, () =>
      [
        "The default timeout is 1800 seconds.",
        "The default timeout is 1800 seconds.",
      ].join("\n"),
    );

    expect(observations).toMatchObject([
      { kind: "inconclusive", reason: "documentation-assertion-ambiguous" },
      { kind: "inconclusive", reason: "documentation-assertion-missing" },
    ]);
  });

  it("rejects malformed and duplicate assertion bindings", () => {
    expect(() =>
      parseClaimsBindings({
        parameters: {
          "session.timeout": {
            documentation: [
              {
                file: "docs/a.md",
                assertions: [
                  { id: "same", target: "default", pattern: "^value$" },
                  { id: "same", target: "effective", scope: "eu", pattern: "(?<value>1)" },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow(ClaimsBindingError);
  });
});