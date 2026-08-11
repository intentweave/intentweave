// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ClaimsBindingError,
  extractBoundCodeEvidence,
  extractDiscoveredCodeEvidence,
  extractDocumentationAssertions,
  extractScopeConfigEvidence,
  extractScopeRegistryEvidence,
  loadClaimsBindings,
  loadOptionalClaimsBindings,
  parseClaimsBindings,
  parseScopeRegistry,
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
  it("treats a missing bindings manifest as automatic-discovery mode", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    try {
      expect(loadOptionalClaimsBindings(workspace)).toBeUndefined();
      expect(() => loadClaimsBindings(workspace)).toThrow("Claims bindings not found");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("discovers provisional code claims and lets explicit bindings win", () => {
    const observations = extractDiscoveredCodeEvidence(
      ["src/options.ts", "src/session.ts"],
      (file) =>
        file === "src/options.ts"
          ? "/**\n * @default 25\n */\nexport const PAGE_SIZE = 25;"
          : "export const SESSION_TIMEOUT = 1800;",
      bindings,
    );

    expect(observations).toHaveLength(2);
    expect(observations).toMatchObject([
      {
        parameterKey: expect.stringContaining("src/options.ts#PAGE_SIZE"),
        claimType: "CLM-DEFAULT",
        sourceKind: "code-default",
        normalizedValue: 25,
        bindingBasis: "r1-discovery",
      },
      {
        parameterKey: expect.stringContaining("src/options.ts#PAGE_SIZE"),
        claimType: "CLM-DEFAULT",
        sourceKind: "code-annotation",
        normalizedValue: 25,
        bindingBasis: "r1-discovery",
      },
    ]);
    expect(
      observations.some((observation) =>
        observation.symbolId.includes("SESSION_TIMEOUT"),
      ),
    ).toBe(false);
  });

  it("does not materialize ordinary local literals as claims", () => {
    const observations = extractDiscoveredCodeEvidence(
      ["src/calculate.ts"],
      () =>
        `export function calculate() {
          let total = 0;
          for (let i = 0; i < 10; i += 1) total += i;
          return total;
        }`,
    );

    expect(observations).toEqual([]);
  });

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

  it("creates one scope observation per declared scope with sorted capabilities", () => {
    const scopes = parseScopeRegistry({
      environments: [
        { name: "eu-prod", capabilities: ["session-runtime", "metrics"] },
        { name: "dev", capabilities: ["session-runtime"] },
      ],
    });

    expect(extractScopeRegistryEvidence(scopes)).toEqual([
      {
        sourceKind: "scope-registry",
        identityKey: "scope-registry:eu-prod",
        semanticLocation: "eu-prod",
        normalizedValue: ["metrics", "session-runtime"],
        scope: "eu-prod",
      },
      {
        sourceKind: "scope-registry",
        identityKey: "scope-registry:dev",
        semanticLocation: "dev",
        normalizedValue: ["session-runtime"],
        scope: "dev",
      },
    ]);
  });

  it("reads registered config key paths and preserves missing values as inconclusive", () => {
    const scopes = parseScopeRegistry({
      environments: [
        { name: "eu-prod", capabilities: ["session-runtime"] },
        { name: "staging", capabilities: ["session-runtime"] },
      ],
    });
    const observations = extractScopeConfigEvidence(
      bindings,
      scopes,
      (scope) => (scope === "eu-prod" ? "session:\n  timeout: 3600\n" : undefined),
    );

    expect(observations).toEqual([
      {
        kind: "evidence",
        parameterKey: "session.timeout",
        sourceKind: "config",
        identityKey: "session.timeout:config:eu-prod:session.timeout",
        semanticLocation: "session.timeout",
        normalizedValue: 3600,
        scope: "eu-prod",
        filePath: "config/eu-prod.yaml",
      },
      {
        kind: "inconclusive",
        parameterKey: "session.timeout",
        sourceKind: "config",
        scope: "staging",
        reason: "config-value-missing",
      },
    ]);
  });

  it("rejects an unknown requested scope", () => {
    const scopes = parseScopeRegistry({
      environments: [{ name: "eu-prod", capabilities: ["session-runtime"] }],
    });

    expect(() =>
      extractScopeConfigEvidence(bindings, scopes, () => undefined, "does-not-exist"),
    ).toThrow("Unknown scope does-not-exist");
  });
});
