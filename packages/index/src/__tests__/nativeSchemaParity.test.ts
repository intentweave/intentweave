// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Native schema parity (Definition of Done item 14, decision A, option 2).
 *
 * The native Rust schema owns the CARI tables and the claims tables defined through
 * schema 16. Tables that schemas 17 and later introduce are owned by TypeScript only.
 * This test checks three things:
 *
 * 1. every table the native schema defines exists in TypeScript with the same columns;
 * 2. every table only TypeScript defines is listed explicitly as TypeScript-owned, so a
 *    new table fails the test until it is classified;
 * 3. the TypeScript-owned list does not contain a table the native schema defines.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../");

/** Tables introduced in schemas 17 and later. Owned by TypeScript only. */
const TYPESCRIPT_OWNED_TABLES = new Set([
  "subject_identities",
  "subject_aliases",
  "claim_subjects",
  "evidence_subjects",
  "subject_continuity",
  "claim_candidates",
  "candidate_evidence",
  "candidate_subjects",
  "candidate_inferences",
  "candidate_reviews",
  "candidate_policy_decisions",
  "candidate_reviews_g",
  "claim_identities_g",
  "subject_identities_g",
  "observation_runs",
  "observation_run_coverage",
  "observation_run_items",
  "observed_identities",
  "observed_versions",
  "observed_relations",
  "observed_continuity_links",
  "subject_observations",
  "observed_evidence_projection",
  "observed_changesets",
  "observed_change_items",
  "change_impacts",
]);

/**
 * Known pre-existing divergences. These knowledge-graph tables have the same names
 * in both schemas but different columns. They are outside the claims and CARI scope
 * of decision A. Each entry must be fixed or deliberately accepted. The test fails on
 * any divergence not listed here.
 */
const KNOWN_DIVERGENCES = new Set([
  "kg_entities",
  "kg_relationships",
  "kg_raw_triples",
  "enrichment_meta",
]);

const CONSTRAINT_WORDS = new Set([
  "primary",
  "unique",
  "check",
  "foreign",
  "constraint",
  "references",
]);

interface TableDefinition {
  columns: string[];
}

function tablesIn(sql: string): Map<string, TableDefinition> {
  const tables = new Map<string, TableDefinition>();
  const pattern = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1]!;
    const body = match[2]!;
    // A match inside migration code, not a DDL block, contains statements or
    // template syntax. Such a match is not a table definition.
    if (/[;`]|\$\{|\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\b/.test(body))
      continue;
    const columns: string[] = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      const column = /^(\w+)\s+/.exec(line);
      if (!column) continue;
      const word = column[1]!.toLowerCase();
      if (CONSTRAINT_WORDS.has(word)) continue;
      columns.push(column[1]!);
    }
    tables.set(name, { columns: columns.sort() });
  }
  return tables;
}

function readSource(relative: string): string {
  return readFileSync(path.join(repo, relative), "utf-8");
}

describe("native schema parity (decision A)", () => {
  const native = tablesIn(readSource("packages/cari-native/src/schema.rs"));
  const typescript = tablesIn(readSource("packages/index/src/schema.ts"));

  it("finds the tables on both sides", () => {
    expect(native.size).toBeGreaterThan(20);
    expect(typescript.size).toBeGreaterThan(native.size);
  });

  it("defines every native table in TypeScript with identical columns, except known divergences", () => {
    const mismatches: string[] = [];
    for (const [name, definition] of native) {
      if (KNOWN_DIVERGENCES.has(name)) continue;
      const counterpart = typescript.get(name);
      if (!counterpart) {
        mismatches.push(`${name}: missing in TypeScript`);
        continue;
      }
      const onlyNative = definition.columns.filter(
        (column) => !counterpart.columns.includes(column),
      );
      const onlyTypeScript = counterpart.columns.filter(
        (column) => !definition.columns.includes(column),
      );
      if (onlyNative.length || onlyTypeScript.length) {
        mismatches.push(
          `${name}: native-only [${onlyNative.join(", ")}] typescript-only [${onlyTypeScript.join(", ")}]`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("classifies every TypeScript-only table as TypeScript-owned", () => {
    const unclassified = [...typescript.keys()].filter(
      (name) => !native.has(name) && !TYPESCRIPT_OWNED_TABLES.has(name),
    );
    expect(unclassified).toEqual([]);
  });

  it("lists only divergences that actually exist", () => {
    const stale = [...KNOWN_DIVERGENCES].filter((name) => {
      const counterpart = typescript.get(name);
      const definition = native.get(name);
      if (!counterpart || !definition) return true;
      return (
        JSON.stringify(counterpart.columns) ===
        JSON.stringify(definition.columns)
      );
    });
    expect(stale).toEqual([]);
  });

  it("does not list a native table as TypeScript-owned", () => {
    const misclassified = [...TYPESCRIPT_OWNED_TABLES].filter((name) =>
      native.has(name),
    );
    expect(misclassified).toEqual([]);
  });
});
