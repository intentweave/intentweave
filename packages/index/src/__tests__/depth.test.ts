// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { HeuristicKeywordExtractor } from "@intentweave/analyzer";

// =============================================================================
// Tests: Body text dictionary extraction (Phase 5)
// =============================================================================

describe("HeuristicKeywordExtractor — dictionary mode", () => {
  it("does NOT extract dictionary terms in structured depth", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "structured",
      dictionary: new Set(["authservice"]),
    });

    // Body text with no structured formatting
    const text = "The authservice handles all authentication logic.";
    const matches = extractor.extract(text);

    // "authservice" is not PascalCase/camelCase — won't match structured sources
    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(dictMatches).toHaveLength(0);
  });

  it("extracts dictionary terms in full depth", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["authservice"]),
    });

    const text = "The authservice handles all authentication logic.";
    const matches = extractor.extract(text);

    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(dictMatches).toHaveLength(1);
    expect(dictMatches[0].name).toBe("authservice");
    expect(dictMatches[0].source).toBe("dictionary");
  });

  it("skips dictionary terms already matched by structured sources", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["authservice"]),
    });

    // AuthService appears as PascalCase identifier — caught by structured source
    const text = "The AuthService handles authentication.";
    const matches = extractor.extract(text);

    // Should be matched by identifier source, NOT duplicated by dictionary
    const identMatches = matches.filter((m) => m.source === "identifier");
    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(identMatches.length).toBeGreaterThanOrEqual(1);
    expect(dictMatches).toHaveLength(0);
  });

  it("matches multi-word dictionary terms", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["rate limiter"]),
    });

    const text = "The rate limiter controls request throughput.";
    const matches = extractor.extract(text);

    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(dictMatches).toHaveLength(1);
    expect(dictMatches[0].name).toBe("rate limiter");
  });

  it("is case-insensitive for dictionary matching", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["better-sqlite3"]),
    });

    // "better-sqlite3" in body text won't be caught by PascalCase/camelCase
    // identifier extractors, but the text has mixed case "Better-SQLite3"
    const text = "We chose Better-SQLite3 for its simplicity.";
    const matches = extractor.extract(text);

    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(dictMatches).toHaveLength(1);
  });

  it("respects minLength for dictionary terms", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["db"]),
      minLength: 3,
    });

    const text = "The db connection is established.";
    const matches = extractor.extract(text);

    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(dictMatches).toHaveLength(0); // "db" is 2 chars < minLength of 3
  });

  it("heading-only term is not duplicated by dictionary", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["sqlite"]),
    });

    // "sqlite" only appears in a heading — heading line is stripped before
    // dictionary scan, and heading extractor captures "SQLite Design" which
    // normalizes to "sqlite design". The dictionary term "sqlite" is different
    // from "sqlite design" so not in seen. But the heading line is stripped
    // from the body text passed to dictionary scan, so "sqlite" is not found
    // in the remaining body. Net: heading match only, no dictionary match.
    const text = "# SQLite Design\n\nSome body text about databases.";
    const matches = extractor.extract(text);

    const headingMatches = matches.filter((m) => m.source === "heading");
    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(headingMatches).toHaveLength(1);
    expect(dictMatches).toHaveLength(0);
  });

  it("dictionary finds term in body even if heading has different phrase", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(["rate limiter"]),
    });

    // "rate limiter" only in body (lowercase, not PascalCase)
    // Heading mentions a different phrase
    const text =
      "# API Design\n\nWe use a rate limiter for throughput control.";
    const matches = extractor.extract(text);

    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(dictMatches).toHaveLength(1);
    expect(dictMatches[0].name).toBe("rate limiter");
  });

  it("handles empty dictionary gracefully", () => {
    const extractor = new HeuristicKeywordExtractor({
      depth: "full",
      dictionary: new Set(),
    });

    const text = "Some text about databases.";
    const matches = extractor.extract(text);

    const dictMatches = matches.filter((m) => m.source === "dictionary");
    expect(dictMatches).toHaveLength(0);
  });
});
