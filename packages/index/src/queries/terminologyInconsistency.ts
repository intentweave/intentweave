// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: terminologyInconsistency (1.5)
 *
 * Detect when docs use different names for the same code symbol.
 * For example, "auth service", "AuthService", and "authentication module"
 * all referring to the same `AuthService` class.
 *
 * Suggests the canonical name (the actual symbol name from code) for each entity.
 */

import type Database from "better-sqlite3";
import type {
  TerminologyInconsistencyResult,
  TerminologyVariant,
  TerminologyInconsistency,
} from "../types.js";
import { openIndex } from "./shared.js";

/** Minimum confidence threshold for annotations to consider. */
const MIN_CONFIDENCE = 0.4;

/** Minimum number of distinct text variants to flag as inconsistent. */
const MIN_VARIANTS = 2;

/**
 * Detect terminology inconsistencies across documentation.
 */
export function terminologyInconsistency(
  dbPath: string,
): TerminologyInconsistencyResult {
  const db = openIndex(dbPath);
  try {
    return terminologyInconsistencyFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Normalise a mention text for grouping purposes.
 * Lowercases and collapses whitespace, but preserves the original for display.
 */
function normaliseMention(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/**
 * Core terminology inconsistency logic against an open database.
 */
export function terminologyInconsistencyFromDb(
  db: Database.Database,
): TerminologyInconsistencyResult {
  // 1. Get all grounded annotations with their symbol info
  const rows = db
    .prepare(
      `
      SELECT
        a.symbol_id,
        a.text,
        a.confidence,
        a.doc_path,
        s.name AS symbol_name,
        s.kind AS symbol_kind,
        s.file_path AS symbol_file
      FROM annotations a
      JOIN symbols s ON a.symbol_id = s.id
      WHERE a.symbol_id IS NOT NULL
        AND a.confidence >= ?
      ORDER BY a.symbol_id, a.text
    `,
    )
    .all(MIN_CONFIDENCE) as Array<{
    symbol_id: string;
    text: string;
    confidence: number;
    doc_path: string;
    symbol_name: string;
    symbol_kind: string;
    symbol_file: string;
  }>;

  // 2. Group by symbol_id
  const symbolGroups = new Map<
    string,
    {
      symbolName: string;
      kind: string;
      filePath: string;
      mentions: Array<{ text: string; confidence: number; docPath: string }>;
    }
  >();

  for (const row of rows) {
    let group = symbolGroups.get(row.symbol_id);
    if (!group) {
      group = {
        symbolName: row.symbol_name,
        kind: row.symbol_kind,
        filePath: row.symbol_file,
        mentions: [],
      };
      symbolGroups.set(row.symbol_id, group);
    }
    group.mentions.push({
      text: row.text,
      confidence: row.confidence,
      docPath: row.doc_path,
    });
  }

  const totalAnalyzed = symbolGroups.size;

  // 3. For each symbol, collect distinct text variants (case-insensitive grouping)
  const inconsistencies: TerminologyInconsistency[] = [];

  for (const [symbolId, group] of symbolGroups) {
    // Group mentions by normalised text
    const variantMap = new Map<
      string,
      {
        displayText: string;
        count: number;
        totalConfidence: number;
        docPaths: Set<string>;
      }
    >();

    for (const m of group.mentions) {
      const normalised = normaliseMention(m.text);
      let variant = variantMap.get(normalised);
      if (!variant) {
        variant = {
          displayText: m.text, // keep first occurrence as display text
          count: 0,
          totalConfidence: 0,
          docPaths: new Set(),
        };
        variantMap.set(normalised, variant);
      }
      variant.count++;
      variant.totalConfidence += m.confidence;
      variant.docPaths.add(m.docPath);
    }

    // Only flag if there are multiple distinct variants
    if (variantMap.size < MIN_VARIANTS) continue;

    // Build variant list sorted by count descending
    const variants: TerminologyVariant[] = [...variantMap.values()]
      .map((v) => ({
        text: v.displayText,
        count: v.count,
        avgConfidence: Math.round((v.totalConfidence / v.count) * 100) / 100,
        docPaths: [...v.docPaths].sort(),
      }))
      .sort((a, b) => b.count - a.count);

    // Compute consistency: ratio of mentions using the canonical name
    const canonicalNorm = normaliseMention(group.symbolName);
    const canonicalVariant = variantMap.get(canonicalNorm);
    const totalMentions = group.mentions.length;
    const canonicalCount = canonicalVariant?.count ?? 0;
    const consistency =
      Math.round((canonicalCount / totalMentions) * 100) / 100;

    // Determine severity
    let severity: "info" | "warning" | "critical";
    if (variantMap.size >= 4 || consistency < 0.3) {
      severity = "critical";
    } else if (variantMap.size >= 3 || consistency < 0.6) {
      severity = "warning";
    } else {
      severity = "info";
    }

    inconsistencies.push({
      symbolId,
      symbolName: group.symbolName,
      kind: group.kind,
      filePath: group.filePath,
      variants,
      consistency,
      severity,
    });
  }

  // Sort: critical first, then warning, then info; within same severity by consistency ascending
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  inconsistencies.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.consistency - b.consistency,
  );

  return {
    inconsistencies,
    totalInconsistencies: inconsistencies.length,
    totalAnalyzed,
  };
}
