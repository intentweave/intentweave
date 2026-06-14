// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Test Description ↔ Symbol Alignment (14.6)
 *
 * Cross-references test descriptions (from describe/it/test calls)
 * against the symbols table to find stale tests — tests whose descriptions
 * reference symbols that no longer exist or have been renamed.
 *
 * Example output:
 *   6 test descriptions reference symbols not found:
 *   auth.test.ts:44 "AuthService should validate token expiry" → "AuthService" not found
 *   resolver.test.ts:12 "resolveRawRef converts $ref to FQN" → "resolveRawRef" not found
 */

import Database from "@intentweave/sqlite-compat";
import type { TestIntentResult, TestDescriptionMatch } from "../types.js";

export interface TestIntentOptions {
  /** Filter by test file glob pattern (e.g., double star slash test.ts) */
  filePattern?: string;

  /** Limit results */
  limit?: number;
}

/**
 * Find test descriptions that reference symbols no longer in the index.
 * Opens and closes the database.
 */
export function testIntent(
  dbPath: string,
  opts?: TestIntentOptions,
): TestIntentResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    return testIntentFromDb(db, opts);
  } finally {
    db.close();
  }
}

/**
 * Find test descriptions that reference missing symbols.
 * Uses an open database connection.
 */
export function testIntentFromDb(
  db: Database.Database,
  opts?: TestIntentOptions,
): TestIntentResult {
  const limit = opts?.limit ?? 50;

  // Query all test descriptions
  const testDescsStmt = db.prepare(`
    SELECT file, line, kind, description
    FROM test_descriptions
    ORDER BY file, line
  `);

  const testDescs = testDescsStmt.all() as Array<{
    file: string;
    line: number;
    kind: "describe" | "it" | "test";
    description: string;
  }>;

  // Query all symbol names
  const symbolsStmt = db.prepare(`
    SELECT DISTINCT name FROM symbols
  `);

  const symbolNames = new Set(
    (symbolsStmt.all() as Array<{ name: string }>).map((s) => s.name),
  );

  // Extract symbol names from test descriptions (simple heuristic: CamelCase + lowercase words)
  // Match patterns like "AuthService", "resolveRawRef", "validateToken", etc.
  const symbolPattern = /\b([A-Z][a-zA-Z0-9]*|[a-z]+(?:[A-Z][a-z]+)*)\b/g;

  const staleTests: TestDescriptionMatch[] = [];

  for (const desc of testDescs) {
    const matches = desc.description.matchAll(symbolPattern);

    for (const match of matches) {
      const word = match[0];

      // Skip common non-symbol words
      if (
        [
          "should",
          "must",
          "must",
          "when",
          "then",
          "that",
          "this",
          "for",
          "and",
          "or",
          "to",
          "from",
          "with",
          "as",
          "be",
          "is",
          "are",
          "was",
          "were",
          "have",
          "has",
          "can",
          "will",
          "does",
          "do",
          "did",
          "not",
          "no",
          "The",
          "A",
          "An",
          "It",
          "In",
          "At",
          "On",
          "By",
          "Of",
          "or",
          "an",
          "the",
          "a",
          "it",
          "in",
          "at",
          "on",
          "by",
          "of",
        ].includes(word)
      ) {
        continue;
      }

      // If symbol not found in current index
      if (!symbolNames.has(word)) {
        staleTests.push({
          file: desc.file,
          line: desc.line,
          kind: desc.kind,
          description: desc.description,
          missingSymbol: word,
        });

        if (staleTests.length >= limit) {
          break;
        }
      }
    }

    if (staleTests.length >= limit) {
      break;
    }
  }

  // Also find test descriptions with no matching symbols at all
  const testFilesWithNoMatches: Array<{ file: string; count: number }> = [];
  for (const desc of testDescs) {
    const matches = Array.from(desc.description.matchAll(symbolPattern));
    const validMatches = matches.filter(
      (m) =>
        !["should", "must", "when", "then", "for", "and", "or"].includes(
          m[0],
        ) && symbolNames.has(m[0]),
    );

    if (validMatches.length === 0 && desc.description.length > 10) {
      // Test has no matching symbols
      const existing = testFilesWithNoMatches.find((t) => t.file === desc.file);
      if (existing) {
        existing.count++;
      } else {
        testFilesWithNoMatches.push({ file: desc.file, count: 1 });
      }
    }
  }

  return {
    total: testDescs.length,
    staleCount: staleTests.length,
    orphanedFiles: testFilesWithNoMatches,
    staleTests,
  };
}
