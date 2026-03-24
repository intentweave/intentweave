// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { annotate, toSlug, tokenize } from "../annotator.js";
import type { AxOutput, AxSymbol } from "@intentweave/analyzer";
import type { KwxStageOutput, MentionRecord } from "@intentweave/core";

// =============================================================================
// Helpers — minimal fixture factories
// =============================================================================

function makeSymbol(overrides: Partial<AxSymbol> = {}): AxSymbol {
  return {
    id: "impl:src/foo.ts#function:doSomething",
    kind: "function",
    name: "doSomething",
    filePath: "src/foo.ts",
    span: { startLine: 10, startCol: 0, endLine: 20, endCol: 1 },
    export: "exported",
    ...overrides,
  };
}

function makeAxOutput(symbols: AxSymbol[]): AxOutput {
  return {
    version: "1.0",
    workspaceRoot: "/test",
    extractedAt: Date.now(),
    totalFiles: 1,
    totalSymbols: symbols.length,
    files: [
      {
        filePath: "src/foo.ts",
        contentHash: "abc123",
        language: "typescript",
        symbols,
        extractedAt: Date.now(),
      },
    ],
    stats: { byKind: {}, exported: symbols.length, internal: 0 },
  };
}

function makeMention(overrides: Partial<MentionRecord> = {}): MentionRecord {
  return {
    entityName: "doSomething",
    text: "the doSomething function handles this",
    filePath: "docs/README.md",
    startLine: 5,
    endLine: 5,
    startChar: 4,
    endChar: 15,
    qualifiers: [],
    source: "code-span",
    chunkId: "chunk-1",
    chunkType: "section",
    ...overrides,
  };
}

function makeKwxOutput(mentions: MentionRecord[]): KwxStageOutput {
  return {
    $schema: "intentweave://schemas/kwx/v1",
    stage: "KWX",
    schemaVersion: 1,
    artifactId: "docs.README",
    filePath: "docs/README.md",
    mentions,
    entities: mentions.map((m) => ({
      name: m.entityName,
      mentionCount: 1,
      filePaths: [m.filePath],
      qualifiers: m.qualifiers,
      predominantSource: m.source,
    })),
    meta: {
      mentionCount: mentions.length,
      entityCount: mentions.length,
      qualifiedMentionCount: 0,
      processingTimeMs: 1,
    },
  };
}

// =============================================================================
// toSlug
// =============================================================================

describe("toSlug", () => {
  it("lowercases and strips non-alphanumeric", () => {
    expect(toSlug("co-occurrence")).toBe("cooccurrence");
    expect(toSlug("TcgPipeline")).toBe("tcgpipeline");
    expect(toSlug("hello_world")).toBe("helloworld");
  });

  it("handles empty string", () => {
    expect(toSlug("")).toBe("");
  });
});

// =============================================================================
// tokenize
// =============================================================================

describe("tokenize", () => {
  it("splits camelCase", () => {
    expect(tokenize("doSomething")).toEqual(["do", "something"]);
  });

  it("splits kebab-case", () => {
    expect(tokenize("co-occurrence")).toEqual(["co", "occurrence"]);
  });

  it("splits snake_case", () => {
    expect(tokenize("my_function")).toEqual(["my", "function"]);
  });

  it("splits mixed", () => {
    expect(tokenize("TcgPipeline-output")).toEqual([
      "tcg",
      "pipeline",
      "output",
    ]);
  });
});

// =============================================================================
// annotate — matching strategies
// =============================================================================

describe("annotate", () => {
  it("exact match → confidence 1.0", () => {
    const sym = makeSymbol({ name: "doSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({ entityName: "doSomething" });
    const kwx = makeKwxOutput([mention]);

    const result = annotate(ax, [kwx]);

    expect(result).toHaveLength(1);
    expect(result[0].symbolId).toBe(sym.id);
    expect(result[0].confidence).toBe(1.0);
  });

  it("exact match is case-insensitive", () => {
    const sym = makeSymbol({ name: "DoSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({ entityName: "dosomething" });
    const kwx = makeKwxOutput([mention]);

    const result = annotate(ax, [kwx]);

    expect(result).toHaveLength(1);
    expect(result[0].symbolId).toBe(sym.id);
    expect(result[0].confidence).toBe(1.0);
  });

  it("slug match → confidence 0.8", () => {
    const sym = makeSymbol({
      id: "impl:src/foo.ts#class:CoOccurrence",
      name: "CoOccurrence",
    });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({ entityName: "co-occurrence" });
    const kwx = makeKwxOutput([mention]);

    const result = annotate(ax, [kwx]);

    expect(result).toHaveLength(1);
    expect(result[0].symbolId).toBe("impl:src/foo.ts#class:CoOccurrence");
    expect(result[0].confidence).toBe(0.8);
  });

  it("token overlap → confidence 0.5", () => {
    const sym = makeSymbol({
      id: "impl:src/pipeline.ts#function:pipeline",
      name: "pipeline",
    });
    const ax = makeAxOutput([sym]);
    // Mention "TcgPipeline" → tokens ["tcg", "pipeline"], "pipeline" matches
    const mention = makeMention({ entityName: "TcgPipeline" });
    const kwx = makeKwxOutput([mention]);

    const result = annotate(ax, [kwx]);

    expect(result).toHaveLength(1);
    expect(result[0].symbolId).toBe(
      "impl:src/pipeline.ts#function:pipeline",
    );
    expect(result[0].confidence).toBe(0.5);
  });

  it("heading mention ungrounded → confidence 0.3", () => {
    const ax = makeAxOutput([]);
    const mention = makeMention({
      entityName: "Architecture Overview",
      source: "heading",
    });
    const kwx = makeKwxOutput([mention]);

    const result = annotate(ax, [kwx]);

    expect(result).toHaveLength(1);
    expect(result[0].symbolId).toBeNull();
    expect(result[0].confidence).toBe(0.3);
  });

  it("fully ungrounded → confidence 0.1", () => {
    const ax = makeAxOutput([]);
    const mention = makeMention({
      entityName: "zzz_nonexistent",
      source: "bold",
    });
    const kwx = makeKwxOutput([mention]);

    const result = annotate(ax, [kwx]);

    expect(result).toHaveLength(1);
    expect(result[0].symbolId).toBeNull();
    expect(result[0].confidence).toBe(0.1);
  });

  it("prefers exported symbols over internal", () => {
    const internal = makeSymbol({
      id: "impl:a.ts#function:foo",
      name: "foo",
      export: "internal",
    });
    const exported = makeSymbol({
      id: "impl:b.ts#function:foo",
      name: "foo",
      export: "exported",
    });
    const ax: AxOutput = {
      version: "1.0",
      workspaceRoot: "/test",
      extractedAt: Date.now(),
      totalFiles: 2,
      totalSymbols: 2,
      files: [
        {
          filePath: "a.ts",
          contentHash: "a",
          language: "typescript",
          symbols: [internal],
          extractedAt: Date.now(),
        },
        {
          filePath: "b.ts",
          contentHash: "b",
          language: "typescript",
          symbols: [exported],
          extractedAt: Date.now(),
        },
      ],
      stats: { byKind: {}, exported: 1, internal: 1 },
    };
    const mention = makeMention({ entityName: "foo" });
    const kwx = makeKwxOutput([mention]);

    const result = annotate(ax, [kwx]);

    expect(result[0].symbolId).toBe("impl:b.ts#function:foo");
  });

  it("applies IDF scores when provided", () => {
    const sym = makeSymbol({ name: "doSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({ entityName: "doSomething" });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["dosomething", 0.75]]);
    const result = annotate(ax, [kwx], { idfScores });

    expect(result[0].idfScore).toBe(0.75);
  });

  it("respects minConfidence filter", () => {
    const ax = makeAxOutput([]);
    const mention = makeMention({
      entityName: "nonexistent",
      source: "bold",
    });
    const kwx = makeKwxOutput([mention]);

    const result = annotate(ax, [kwx], { minConfidence: 0.5 });

    expect(result).toHaveLength(0);
  });

  it("sorts by (docPath, line)", () => {
    const sym = makeSymbol();
    const ax = makeAxOutput([sym]);

    const m1 = makeMention({
      entityName: "doSomething",
      filePath: "docs/b.md",
      startLine: 10,
    });
    const m2 = makeMention({
      entityName: "doSomething",
      filePath: "docs/a.md",
      startLine: 5,
    });
    const m3 = makeMention({
      entityName: "doSomething",
      filePath: "docs/a.md",
      startLine: 3,
    });

    const kwx1 = makeKwxOutput([m1]);
    kwx1.filePath = "docs/b.md";
    const kwx2 = makeKwxOutput([m2, m3]);
    kwx2.filePath = "docs/a.md";

    const result = annotate(ax, [kwx1, kwx2]);

    expect(result.map((a) => `${a.docPath}:${a.line}`)).toEqual([
      "docs/a.md:3",
      "docs/a.md:5",
      "docs/b.md:10",
    ]);
  });
});

// =============================================================================
// annotate — IDF penalty (Phase 5)
// =============================================================================

describe("annotate — applyIdfPenalty", () => {
  it("penalizes dictionary-source annotations by IDF", () => {
    const sym = makeSymbol({ name: "doSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({
      entityName: "doSomething",
      source: "dictionary",
    });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["dosomething", 0.3]]);
    const result = annotate(ax, [kwx], {
      idfScores,
      applyIdfPenalty: true,
    });

    // Exact match confidence = 1.0, penalized by 0.3 → 0.3
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBeCloseTo(0.3, 5);
  });

  it("penalizes identifier-source annotations by IDF", () => {
    const sym = makeSymbol({ name: "doSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({
      entityName: "doSomething",
      source: "identifier",
    });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["dosomething", 0.5]]);
    const result = annotate(ax, [kwx], {
      idfScores,
      applyIdfPenalty: true,
    });

    // Exact match confidence = 1.0, penalized by 0.5 → 0.5
    expect(result[0].confidence).toBeCloseTo(0.5, 5);
  });

  it("does NOT penalize heading-source annotations", () => {
    const ax = makeAxOutput([]);
    const mention = makeMention({
      entityName: "Architecture Overview",
      source: "heading",
    });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["architecture overview", 0.1]]);
    const result = annotate(ax, [kwx], {
      idfScores,
      applyIdfPenalty: true,
    });

    // Heading ungrounded confidence = 0.3, NOT penalized
    expect(result[0].confidence).toBe(0.3);
  });

  it("does NOT penalize bold-source annotations", () => {
    const ax = makeAxOutput([]);
    const mention = makeMention({
      entityName: "important_thing",
      source: "bold",
    });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["important_thing", 0.2]]);
    const result = annotate(ax, [kwx], {
      idfScores,
      applyIdfPenalty: true,
    });

    // Bold ungrounded confidence = 0.1, NOT penalized
    expect(result[0].confidence).toBe(0.1);
  });

  it("does NOT penalize code-span-source annotations", () => {
    const sym = makeSymbol({ name: "doSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({
      entityName: "doSomething",
      source: "code-span",
    });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["dosomething", 0.2]]);
    const result = annotate(ax, [kwx], {
      idfScores,
      applyIdfPenalty: true,
    });

    // Exact match confidence = 1.0, NOT penalized (code-span)
    expect(result[0].confidence).toBe(1.0);
  });

  it("uses floor of 0.1 when IDF is very low", () => {
    const sym = makeSymbol({ name: "doSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({
      entityName: "doSomething",
      source: "dictionary",
    });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["dosomething", 0.0]]);
    const result = annotate(ax, [kwx], {
      idfScores,
      applyIdfPenalty: true,
    });

    // Confidence = 1.0 * max(0.0, 0.1) = 0.1
    expect(result[0].confidence).toBeCloseTo(0.1, 5);
  });

  it("does NOT penalize when applyIdfPenalty is false", () => {
    const sym = makeSymbol({ name: "doSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({
      entityName: "doSomething",
      source: "dictionary",
    });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["dosomething", 0.3]]);
    const result = annotate(ax, [kwx], {
      idfScores,
      applyIdfPenalty: false,
    });

    // No penalty — confidence stays at 1.0
    expect(result[0].confidence).toBe(1.0);
  });

  it("penalty can push annotation below minConfidence filter", () => {
    const sym = makeSymbol({ name: "doSomething" });
    const ax = makeAxOutput([sym]);
    const mention = makeMention({
      entityName: "doSomething",
      source: "dictionary",
    });
    const kwx = makeKwxOutput([mention]);

    const idfScores = new Map([["dosomething", 0.1]]);
    const result = annotate(ax, [kwx], {
      idfScores,
      applyIdfPenalty: true,
      minConfidence: 0.5,
    });

    // Confidence = 1.0 * max(0.1, 0.1) = 0.1, below minConfidence of 0.5
    expect(result).toHaveLength(0);
  });
});
