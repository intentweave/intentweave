// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ambiguousPublicSymbolPredecessors,
  type HistoricalSymbol,
  type PublicSymbolObservation,
} from "./publicSymbolContinuity.js";

const currentSymbol: PublicSymbolObservation = {
  id: "current-symbol",
  name: "loadConfig",
  kind: "function",
  signature: "(source: string): string",
  structureHash: "structure-load-config",
  filePath: "src/config.ts",
};

function historical(
  candidateIdentityKey: string,
  filePath: string,
  overrides: Partial<HistoricalSymbol> = {},
): HistoricalSymbol {
  return {
    candidate_identity_key: candidateIdentityKey,
    subject_identity_key: `symbol:${filePath}:loadConfig`,
    subject_display_name: "loadConfig",
    file_path: filePath,
    normalized_value: JSON.stringify({
      name: "loadConfig",
      kind: "function",
      signature: "(source: string): string",
      structureHash: "structure-load-config",
    }),
    ...overrides,
  };
}

describe("public Symbol continuity alternatives", () => {
  it("returns multiple structurally grounded predecessors in stable order", () => {
    const alternatives = ambiguousPublicSymbolPredecessors(
      [
        historical("public-symbol-doc:z", "src/z-config.ts"),
        historical("public-symbol-doc:a", "src/a-config.ts"),
        historical("public-symbol-doc:class", "src/class.ts", {
          normalized_value: JSON.stringify({
            name: "loadConfig",
            kind: "class",
            signature: null,
            structureHash: "structure-load-config",
          }),
        }),
      ],
      currentSymbol,
    );

    expect(alternatives).toMatchObject([
      {
        candidateIdentityKey: "public-symbol-doc:a",
        subjectIdentityKey: "symbol:src/a-config.ts:loadConfig",
        filePath: "src/a-config.ts",
        normalizedValue: { name: "loadConfig", kind: "function" },
      },
      {
        candidateIdentityKey: "public-symbol-doc:z",
        subjectIdentityKey: "symbol:src/z-config.ts:loadConfig",
        filePath: "src/z-config.ts",
      },
    ]);
  });

  it("does not produce a continuity alternative for a unique or incompatible match", () => {
    expect(
      ambiguousPublicSymbolPredecessors(
        [historical("public-symbol-doc:only", "src/config.ts")],
        currentSymbol,
      ),
    ).toEqual([]);
    expect(
      ambiguousPublicSymbolPredecessors(
        [
          historical("public-symbol-doc:class-a", "src/a.ts", {
            normalized_value: JSON.stringify({
              name: "loadConfig",
              kind: "class",
              signature: null,
              structureHash: "structure-load-config",
            }),
          }),
          historical("public-symbol-doc:class-b", "src/b.ts", {
            normalized_value: JSON.stringify({
              name: "loadConfig",
              kind: "class",
              signature: null,
              structureHash: "structure-load-config",
            }),
          }),
        ],
        currentSymbol,
      ),
    ).toEqual([]);
  });
});
