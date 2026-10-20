import { describe, expect, it } from "vitest";
import { HeuristicKeywordExtractor } from "../kwg/heuristicExtractor.js";

describe("HeuristicKeywordExtractor dictionary matching", () => {
  it("matches case-insensitively at word boundaries and emits only the first occurrence", () => {
    const text = "xwidget widgetized (WIDGET), widget!";
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["widget"]),
    });

    const matches = extractor
      .extract(text)
      .filter((match) => match.source === "dictionary");

    expect(matches).toEqual([
      {
        name: "widget",
        originalText: "WIDGET",
        offset: text.indexOf("WIDGET"),
        length: "WIDGET".length,
        source: "dictionary",
      },
    ]);
  });

  it("preserves dictionary order rather than text occurrence order", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["beta", "alpha"]),
    });

    const matches = extractor
      .extract("alpha then beta then alpha")
      .filter((match) => match.source === "dictionary");

    expect(matches.map(({ name, offset }) => ({ name, offset }))).toEqual([
      { name: "beta", offset: 11 },
      { name: "alpha", offset: 0 },
    ]);
  });

  it("retains regex semantics for multi-word and punctuation terms", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["a+b", "state machine"]),
    });

    const matches = extractor
      .extract("State machine, then A+B.")
      .filter((match) => match.source === "dictionary");

    expect(
      matches.map(({ name, originalText }) => ({ name, originalText })),
    ).toEqual([
      { name: "a+b", originalText: "A+B" },
      { name: "state machine", originalText: "State machine" },
    ]);
  });

  it("does not emit a dictionary match already captured by a structured extractor", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["authservice"]),
    });

    const matches = extractor.extract(
      "# AuthService\n\nAuthService appears again.",
    );

    expect(
      matches.filter((match) => match.name === "authservice"),
    ).toHaveLength(1);
    expect(matches.find((match) => match.name === "authservice")?.source).toBe(
      "heading",
    );
  });

  it("observes dictionary Set changes between extractions", () => {
    const dictionary = new Set(["alpha"]);
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary,
    });

    expect(
      extractor
        .extract("beta")
        .filter((match) => match.source === "dictionary"),
    ).toEqual([]);
    dictionary.add("beta");
    expect(
      extractor
        .extract("beta")
        .filter((match) => match.source === "dictionary"),
    ).toHaveLength(1);
  });
});
