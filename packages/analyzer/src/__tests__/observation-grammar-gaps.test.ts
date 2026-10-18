// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Grammar-gap rewrites (O4 finding, decision 2b). The rewrites keep offsets and line
 * numbers, leave index signatures alone, and apply only to files that fail to parse.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTypeScriptAdapter } from "../stages/ax.js";
import { normalizeGrammarGaps } from "../stages/observation/typescriptObservation.js";
import { LanguageRegistry } from "../stages/languageRegistry.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspaceWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "intentweave-gaps-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
  return root;
}

describe("normalizeGrammarGaps", () => {
  it("keeps the length and the line count of the source", () => {
    const source = [
      "export interface S {",
      "  shapes: [subject: string, predicate: string][];",
      '  chunks: import("./stages.js").SemanticChunk[];',
      "}",
      "",
    ].join("\n");
    const rewritten = normalizeGrammarGaps(source);
    expect(rewritten.length).toBe(source.length);
    expect(rewritten.split("\n").length).toBe(source.split("\n").length);
    expect(rewritten).not.toContain("subject:");
    expect(rewritten).not.toContain("import(");
    expect(rewritten).toContain("SemanticChunk[]");
  });

  it("leaves index signatures untouched", () => {
    const source = "export interface Map2 {\n  [key: string]: number;\n}\n";
    expect(normalizeGrammarGaps(source)).toBe(source);
  });

  it("leaves a dynamic import call untouched", () => {
    const source = 'const m = await import("node:fs");\n';
    expect(normalizeGrammarGaps(source)).toBe(source);
  });
});

describe("observation of files with grammar gaps", () => {
  it("observes a labelled tuple member instead of failing the file", () => {
    const root = workspaceWith({
      "src/types.ts":
        "export interface S {\n  shapes: [subject: string, object: string][];\n}\nexport const answer = 42;\n",
    });
    const registry = new LanguageRegistry().register(
      createTypeScriptAdapter({
        workspaceRoot: root,
        includePrivate: true,
        includeMembers: true,
        maxDepth: 2,
      }),
    );
    const adapter = registry.observationAdapterFor("src/types.ts")!;
    const records = adapter.observation!.observeFile(root, "src/types.ts");
    const keys = records.map((record) => record.identityKey);
    expect(keys).toContain("symbol:variable:src/types.ts#answer");
    expect(keys).toContain("symbol:interface:src/types.ts#S");
  });

  it("does not change a file that already parses", () => {
    const root = workspaceWith({
      "src/clean.ts": "export const value = 1;\n",
    });
    const registry = new LanguageRegistry().register(
      createTypeScriptAdapter({
        workspaceRoot: root,
        includePrivate: true,
        includeMembers: true,
        maxDepth: 2,
      }),
    );
    const records = registry
      .observationAdapterFor("src/clean.ts")!
      .observation!.observeFile(root, "src/clean.ts");
    expect(records.map((record) => record.identityKey)).toContain(
      "symbol:variable:src/clean.ts#value",
    );
  });
});
