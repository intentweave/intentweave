// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: Entity-Level Architecture Diagram Validation
 *
 * Validates diagram-extracted flows against entity-level evidence in the
 * CARI index — co_occurrences and annotations — instead of file import edges.
 *
 * This is the right validator for `arch-check --from-scan` because
 * diagram components are logical/conceptual names (KWG, SKG, FX, Annotator…),
 * not source directory names. It answers:
 *
 *   1. Are the declared components grounded in the CARI index at all?
 *      (do they appear in annotations or co_occurrences?)
 *   2. Do the declared flows have evidence in the index?
 *      (co_occurrences pair, or both entities mentioned in the same doc)
 *   3. Which entity pairs have high co-occurrence that are NOT declared?
 *      (undocumented entity connections)
 *
 * $0 / no LLM — pure SQLite evidence.
 */

import type Database from "@intentweave/sqlite-compat";
import type { ArchConfig, ArchCheckResult } from "../types.js";
import { openIndex } from "./shared.js";
import { resolveComponentFromDb } from "./resolveComponent.js";

// =============================================================================
// Types
// =============================================================================

export interface EntityGrounding {
  /** Original component name from the diagram. */
  name: string;
  /** Normalised (lowercase, trimmed) lookup key. */
  normalized: string;
  /** Best grounding source found. */
  groundedIn: "co_occurrence" | "annotation" | "none";
  /** Total annotation mentions across all documents. */
  mentionCount: number;
  /** Number of distinct documents that mention this entity. */
  docCount: number;
}

/** Extended arch-check result with entity-level metadata. */
export interface DiagramEntityCheckResult extends ArchCheckResult {
  /** Discriminator: always "entity". */
  mode: "entity";
  /** Per-component grounding details. */
  entityGrounding: EntityGrounding[];
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Validate diagram-extracted architecture against entity-level CARI evidence.
 */
export function diagramEntityCheck(
  dbPath: string,
  config: ArchConfig,
): DiagramEntityCheckResult {
  const db = openIndex(dbPath);
  try {
    return diagramEntityCheckFromDb(db, config);
  } finally {
    db.close();
  }
}

/**
 * Core logic against an open database.
 */
export function diagramEntityCheckFromDb(
  db: Database.Database,
  config: ArchConfig,
): DiagramEntityCheckResult {
  const components = config.components ?? [];
  const flows = config.flows ?? [];

  if (components.length === 0) {
    return emptyResult();
  }

  // ── 1. Ground each component in the index ─────────────────────────────────
  const grounding = new Map<string, EntityGrounding>();

  for (const comp of components) {
    const norm = normalizeEntityName(comp.name);
    if (!norm) continue;

    // All lookup terms: the component name itself + any LLM-provided aliases
    // Aliases are filtered through isUsableAlias to prevent generic terms
    // like "code", "file", "data" from matching everything in the index.
    const lookupTerms = [norm];
    for (const alias of comp.aliases ?? []) {
      const aliasNorm = normalizeEntityName(alias);
      if (
        aliasNorm &&
        !lookupTerms.includes(aliasNorm) &&
        isUsableAlias(aliasNorm)
      ) {
        lookupTerms.push(aliasNorm);
      }
    }

    // Annotation mentions — try each term, take the best (highest count)
    let mentionCount = 0;
    let docCount = 0;
    let matchedTerm = norm;

    for (const term of lookupTerms) {
      const annotRow = db
        .prepare(
          `SELECT count(*) AS cnt, count(DISTINCT doc_path) AS docs
             FROM annotations
            WHERE lower(text) = ?`,
        )
        .get(term) as { cnt: number; docs: number } | undefined;
      if ((annotRow?.cnt ?? 0) > mentionCount) {
        mentionCount = annotRow!.cnt;
        docCount = annotRow!.docs;
        matchedTerm = term;
      }
    }

    // Co-occurrence existence — check all terms
    let groundedIn: EntityGrounding["groundedIn"] = "none";
    if (mentionCount > 0) {
      groundedIn = "annotation";
    } else {
      for (const term of lookupTerms) {
        const coRow = db
          .prepare(
            `SELECT 1 FROM co_occurrences
              WHERE lower(entity_a) = ? OR lower(entity_b) = ?
              LIMIT 1`,
          )
          .get(term, term) as { 1: number } | undefined;
        if (coRow) {
          groundedIn = "co_occurrence";
          break;
        }
      }
    }

    grounding.set(comp.name, {
      name: comp.name,
      normalized: matchedTerm,
      groundedIn,
      mentionCount,
      docCount,
    });
  }

  // ── 1b. resolveComponent post-pass for still-ungrounded components ─────────
  // For components that could not be grounded via name/alias lookup alone,
  // run resolveComponent to find index-grounded terms (symbol names, annotation
  // text) and upgrade the grounding entry.
  //
  // This replaces LLM-guessed aliases for the ungrounded fraction with
  // deterministic, index-derived terms — no external calls, pure SQLite.
  const resolvedTermsMap = new Map<string, string[]>(); // comp.name → extra terms

  for (const comp of components) {
    const entry = grounding.get(comp.name);
    if (!entry || entry.groundedIn !== "none") continue; // already grounded

    const { resolved } = resolveComponentFromDb(db, {
      name: comp.name,
      limitSymbols: 6,
      limitDocs: 3,
    });

    if (resolved.confidence < 0.2) continue; // too weak to trust

    // resolved.terms includes the original name + index-derived extras
    const extraTerms = resolved.terms.filter(
      (t) => t !== entry.normalized && isUsableAlias(t),
    );
    if (extraTerms.length === 0) continue;

    resolvedTermsMap.set(comp.name, extraTerms);

    // Re-score grounding with the new terms
    let mentionCount = entry.mentionCount;
    let docCount = entry.docCount;
    let matchedTerm = entry.normalized;
    let groundedIn: EntityGrounding["groundedIn"] = entry.groundedIn;

    for (const term of extraTerms) {
      const annotRow = db
        .prepare(
          `SELECT count(*) AS cnt, count(DISTINCT doc_path) AS docs
             FROM annotations WHERE lower(text) = ?`,
        )
        .get(term) as { cnt: number; docs: number } | undefined;
      if ((annotRow?.cnt ?? 0) > mentionCount) {
        mentionCount = annotRow!.cnt;
        docCount = annotRow!.docs;
        matchedTerm = term;
        groundedIn = "annotation";
      }
    }

    if (groundedIn === "none") {
      for (const term of extraTerms) {
        const coRow = db
          .prepare(
            `SELECT 1 FROM co_occurrences
              WHERE lower(entity_a) = ? OR lower(entity_b) = ? LIMIT 1`,
          )
          .get(term, term) as { 1: number } | undefined;
        if (coRow) {
          groundedIn = "co_occurrence";
          break;
        }
      }
    }

    grounding.set(comp.name, {
      ...entry,
      normalized: matchedTerm,
      groundedIn,
      mentionCount,
      docCount,
    });
  }

  // ── 2. Validate declared flows ─────────────────────────────────────────────
  const flowResults: ArchCheckResult["flows"] = [];
  const declaredPairs = new Set<string>(); // "normA::normB"

  // Build lookup term list per component name (name + filtered aliases)
  function getTerms(componentName: string): string[] {
    const comp = components.find((c) => c.name === componentName);
    const norm = normalizeEntityName(componentName);
    const terms = norm ? [norm] : [];
    for (const alias of comp?.aliases ?? []) {
      const aliasNorm = normalizeEntityName(alias);
      if (aliasNorm && !terms.includes(aliasNorm) && isUsableAlias(aliasNorm)) {
        terms.push(aliasNorm);
      }
    }
    // Merge index-resolved terms from the post-pass (only for previously ungrounded)
    for (const t of resolvedTermsMap.get(componentName) ?? []) {
      if (!terms.includes(t)) terms.push(t);
    }
    return terms;
  }

  for (const flow of flows) {
    const targets = Array.isArray(flow.to) ? flow.to : [flow.to];
    for (const to of targets) {
      const fromTerms = getTerms(flow.from);
      const toTerms = getTerms(to);
      if (fromTerms.length === 0 || toTerms.length === 0) continue;

      // Register canonical pair for undocumented detection (use first term)
      const key = `${fromTerms[0]}::${toTerms[0]}`;
      declaredPairs.add(key);
      declaredPairs.add(`${toTerms[0]}::${fromTerms[0]}`);

      const evidence = findFlowEvidence(db, fromTerms, toTerms);

      flowResults.push({
        from: flow.from,
        to,
        status: evidence.length > 0 ? "confirmed" : "missing",
        evidence,
      });
    }
  }

  // ── 3. Undocumented entity connections ─────────────────────────────────────
  // High-score co-occurrence pairs whose components are both in the diagram
  // but whose directional flow was not declared.
  const componentNorms = new Set(
    components
      .map((c) => normalizeEntityName(c.name))
      .filter((n): n is string => n !== null),
  );

  // Build norm→original name map for display
  const normToName = new Map<string, string>();
  for (const comp of components) {
    const norm = normalizeEntityName(comp.name);
    if (norm) normToName.set(norm, comp.name);
  }

  const coocRows = db
    .prepare(
      `SELECT entity_a, entity_b, score
         FROM co_occurrences
        WHERE score >= 0.15
        ORDER BY score DESC
        LIMIT 500`,
    )
    .all() as Array<{ entity_a: string; entity_b: string; score: number }>;

  const undocumented: ArchCheckResult["undocumented"] = [];

  for (const row of coocRows) {
    const a = row.entity_a.toLowerCase();
    const b = row.entity_b.toLowerCase();
    if (!componentNorms.has(a) || !componentNorms.has(b)) continue;

    const key = `${a}::${b}`;
    const revKey = `${b}::${a}`;
    if (declaredPairs.has(key) || declaredPairs.has(revKey)) continue;

    const nameA = normToName.get(a) ?? row.entity_a;
    const nameB = normToName.get(b) ?? row.entity_b;

    undocumented.push({
      from: nameA,
      to: nameB,
      edges: [
        {
          sourceFile: `co_occurrence score=${row.score.toFixed(3)}`,
          targetFile: "(entity-level)",
        },
      ],
    });
  }

  // ── 4. Component summary ───────────────────────────────────────────────────
  const componentSummary = components.map((comp) => ({
    name: comp.name,
    // fileCount repurposed: total annotation mentions (0 = ungrounded)
    fileCount: grounding.get(comp.name)?.mentionCount ?? 0,
  }));

  // ── 5. Summary statistics ──────────────────────────────────────────────────
  const totalFlows = flowResults.length;
  const confirmedFlows = flowResults.filter(
    (f) => f.status === "confirmed",
  ).length;
  const missingFlows = totalFlows - confirmedFlows;
  const undocumentedFlows = undocumented.length;
  const totalChecks = totalFlows + undocumentedFlows;
  const conformancePercent =
    totalChecks > 0 ? Math.round((confirmedFlows / totalChecks) * 100) : 100;

  return {
    mode: "entity",
    flows: flowResults,
    undocumented,
    constraintViolations: [],
    componentSummary,
    summary: {
      totalFlows,
      confirmedFlows,
      missingFlows,
      undocumentedFlows,
      constraintViolations: 0,
      conformancePercent,
    },
    entityGrounding: Array.from(grounding.values()),
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Normalise a component name for case-insensitive index lookups.
 * Returns null for empty/invalid names.
 */
function normalizeEntityName(name: string): string | null {
  if (!name) return null;
  // Strip surrounding whitespace, lowercase
  const norm = name.trim().toLowerCase();
  // Skip placeholder names and single characters that are noise
  if (norm.length <= 1) return null;
  // Strip common diagram punctuation that wouldn't appear in annotations
  return norm.replace(/[[\](){}'"]/g, "").trim() || null;
}

/**
 * Generic terms that are too broad to be meaningful alias lookups.
 * These match thousands of annotation rows and produce false positives.
 */
const ALIAS_STOPWORDS = new Set([
  "code",
  "file",
  "data",
  "node",
  "type",
  "list",
  "item",
  "base",
  "core",
  "main",
  "test",
  "util",
  "helper",
  "index",
  "input",
  "output",
  "result",
  "value",
  "key",
  "name",
  "text",
  "graph",
  "model",
  "layer",
  "stage",
  "step",
  "task",
  "run",
  "source",
  "target",
  "store",
  "state",
  "event",
  "error",
]);

/**
 * Return true if this alias term is specific enough to be a reliable lookup.
 */
function isUsableAlias(term: string): boolean {
  return term.length >= 4 && !ALIAS_STOPWORDS.has(term);
}

/**
 * Find evidence for a flow A → B in the CARI index.
 * Both fromTerms and toTerms may contain multiple lookup names (name + aliases).
 *
 * Evidence sources (in descending confidence):
 *   1. co_occurrences row (explicit doc co-mention pair)
 *   2. Same-doc co-annotation (both entities appear in same document)
 */
function findFlowEvidence(
  db: Database.Database,
  fromTerms: string[],
  toTerms: string[],
): Array<{ sourceFile: string; targetFile: string }> {
  // ── Source 1: co_occurrences — try all term combinations ─────────────────
  for (const a of fromTerms) {
    for (const b of toTerms) {
      if (a === b) continue;
      const coocRow = db
        .prepare(
          `SELECT entity_a, entity_b, score, file_paths
             FROM co_occurrences
            WHERE (lower(entity_a) = ? AND lower(entity_b) = ?)
               OR (lower(entity_a) = ? AND lower(entity_b) = ?)
            LIMIT 1`,
        )
        .get(a, b, b, a) as
        | {
            entity_a: string;
            entity_b: string;
            score: number;
            file_paths: string | null;
          }
        | undefined;

      if (coocRow) {
        return [
          {
            sourceFile: `co_occurrence: score=${coocRow.score.toFixed(3)}`,
            targetFile: coocRow.file_paths ?? "(entity-level)",
          },
        ];
      }
    }
  }

  // ── Source 2: same-doc co-annotation — try all term combinations ──────────
  for (const a of fromTerms) {
    for (const b of toTerms) {
      if (a === b) continue;
      const coAnnotRows = db
        .prepare(
          `SELECT DISTINCT a1.doc_path
             FROM annotations a1
             JOIN annotations a2 ON a1.doc_path = a2.doc_path
            WHERE lower(a1.text) = ?
              AND lower(a2.text) = ?
            LIMIT 3`,
        )
        .all(a, b) as Array<{ doc_path: string }>;

      if (coAnnotRows.length > 0) {
        const termNote =
          a !== fromTerms[0] || b !== toTerms[0]
            ? ` (via aliases: ${a}↔${b})`
            : "";
        return coAnnotRows.map((r) => ({
          sourceFile: `co_annotation${termNote}`,
          targetFile: r.doc_path,
        }));
      }
    }
  }

  return [];
}

function emptyResult(): DiagramEntityCheckResult {
  return {
    mode: "entity",
    flows: [],
    undocumented: [],
    constraintViolations: [],
    componentSummary: [],
    summary: {
      totalFlows: 0,
      confirmedFlows: 0,
      missingFlows: 0,
      undocumentedFlows: 0,
      constraintViolations: 0,
      conformancePercent: 100,
    },
    entityGrounding: [],
  };
}
