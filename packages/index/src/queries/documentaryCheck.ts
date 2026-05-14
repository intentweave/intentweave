// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentary domain check (Phase 1 — Intent Engine Foundation)
 *
 * Converts existing CARI query results into RulesViolation objects so they
 * can flow through the same enforcement pipeline as structural rules:
 *   iw intent check --domain documentary
 *
 * Built-in documentary rules (no rules.yaml entry required):
 *
 *   doc.coverage.low       — directory with < 50% exported symbol coverage
 *   doc.terminology        — symbol referred to by multiple inconsistent names
 *   doc.orphaned-section   — doc section where all mentions are ungrounded
 *   doc.completeness.low   — doc covers < 40% of the exports it references
 *
 * Confidence ceilings per check:
 *   doc.coverage.low       ~0.97 (deterministic symbol count)
 *   doc.terminology        ~0.80 (annotation confidence dependent)
 *   doc.orphaned-section   ~0.90 (grounding rate)
 *   doc.completeness.low   ~0.97 (deterministic annotation count)
 */

import type Database from "better-sqlite3";
import type { RulesViolation } from "../types.js";
import { moduleCoverageFromDb } from "./moduleCoverage.js";
import { terminologyInconsistencyFromDb } from "./terminologyInconsistency.js";
import { orphanedSectionsFromDb } from "./orphanedSections.js";
import { docCompletenessFromDb } from "./docCompleteness.js";

export interface DocumentaryCheckOptions {
  /** Minimum severity threshold */
  severity?: "high" | "medium" | "low";
  /** Maximum violations to return */
  limit?: number;
  /**
   * Minimum coverage percentage below which a module is flagged.
   * Default: 50
   */
  coverageThreshold?: number;
  /**
   * Minimum completeness percentage below which a doc is flagged.
   * Default: 40
   */
  completenessThreshold?: number;
}

const SEVERITY_ORDER: Record<"high" | "medium" | "low", number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function meetsThreshold(
  sev: "high" | "medium" | "low",
  threshold: "high" | "medium" | "low",
): boolean {
  return SEVERITY_ORDER[sev] >= SEVERITY_ORDER[threshold];
}

/**
 * Run all built-in documentary checks against an open database.
 * Returns violations in the same format as rulesCheck.
 */
export function documentaryCheckFromDb(
  db: Database.Database,
  opts: DocumentaryCheckOptions = {},
): RulesViolation[] {
  const {
    severity = "low",
    coverageThreshold = 50,
    completenessThreshold = 40,
  } = opts;

  const violations: RulesViolation[] = [];

  // ── 1. Module coverage ──────────────────────────────────────────────────────
  // Modules with coverage < threshold. Severity scaled by how far below:
  //   < 20%  → high
  //   < 50%  → medium
  //   < threshold → low  (only when threshold > 50)
  if (meetsThreshold("medium", severity)) {
    try {
      const { modules } = moduleCoverageFromDb(db);
      for (const m of modules) {
        if (m.totalExported < 3) continue; // ignore tiny modules
        if (m.coveragePercent >= coverageThreshold) continue;

        const ruleSeverity: "high" | "medium" | "low" =
          m.coveragePercent < 20
            ? "high"
            : m.coveragePercent < 50
              ? "medium"
              : "low";

        if (!meetsThreshold(ruleSeverity, severity)) continue;

        violations.push({
          ruleId: "doc.coverage.low",
          ruleSeverity,
          ruleDomain: "documentary",
          ruleMode: "warn",
          confidence: 0.97,
          ruleDescription: "Module documentation coverage below threshold",
          filePath: m.module,
          line: null,
          detail: `${m.coveragePercent}% of exported symbols documented (${m.documented}/${m.totalExported}) — threshold: ${coverageThreshold}%`,
        });
      }
    } catch {
      // Table may not exist if index hasn't been built yet — skip silently
    }
  }

  // ── 2. Terminology inconsistency ────────────────────────────────────────────
  // Symbols referred to by 2+ distinct names in docs.
  if (meetsThreshold("medium", severity)) {
    try {
      const { inconsistencies } = terminologyInconsistencyFromDb(db);
      for (const inc of inconsistencies) {
        const variantCount = inc.variants.length;
        const ruleSeverity: "high" | "medium" | "low" =
          variantCount >= 4 ? "high" : "medium";

        if (!meetsThreshold(ruleSeverity, severity)) continue;

        const variantList = inc.variants
          .map((v) => `"${v.text}"`)
          .join(", ");

        violations.push({
          ruleId: "doc.terminology",
          ruleSeverity,
          ruleDomain: "documentary",
          ruleMode: "warn",
          confidence: Math.min(...inc.variants.map((v) => v.avgConfidence)),
          ruleDescription:
            "Symbol referred to by inconsistent names across documentation",
          filePath: inc.filePath,
          line: null,
          symbol: inc.symbolName,
          detail: `\`${inc.symbolName}\` referred to as ${variantList} — canonical name: \`${inc.symbolName}\``,
        });
      }
    } catch {
      // Skip if annotations table missing
    }
  }

  // ── 3. Orphaned sections ────────────────────────────────────────────────────
  // Doc sections where every mention is ungrounded (no code symbol match).
  if (meetsThreshold("low", severity)) {
    try {
      const { sections } = orphanedSectionsFromDb(db);
      for (const s of sections) {
        const ruleSeverity: "high" | "medium" | "low" =
          s.ungroundedMentions >= 5 ? "high" : "medium";

        if (!meetsThreshold(ruleSeverity, severity)) continue;

        violations.push({
          ruleId: "doc.orphaned-section",
          ruleSeverity,
          ruleDomain: "documentary",
          ruleMode: "warn",
          confidence: 0.9,
          ruleDescription: "Documentation section with no grounded code mentions",
          filePath: s.docPath,
          line: s.line,
          detail: `Section "${s.heading}" has ${s.ungroundedMentions} ungrounded mention(s) — may be outdated or refer to removed code`,
        });
      }
    } catch {
      // Skip if annotations table missing
    }
  }

  // ── 4. Doc completeness ─────────────────────────────────────────────────────
  // Docs that cover < threshold% of the exports from files they reference.
  if (meetsThreshold("medium", severity)) {
    try {
      const { docs } = docCompletenessFromDb(db);
      for (const d of docs) {
        if (d.totalRelevantExports < 3) continue; // ignore trivially small docs
        if (d.completenessPercent >= completenessThreshold) continue;

        const ruleSeverity: "high" | "medium" | "low" =
          d.completenessPercent < 20
            ? "high"
            : d.completenessPercent < 40
              ? "medium"
              : "low";

        if (!meetsThreshold(ruleSeverity, severity)) continue;

        const topMissing = d.missing
          .slice(0, 3)
          .map((m) => `\`${m.name}\``)
          .join(", ");
        const moreCount = d.missing.length > 3 ? ` +${d.missing.length - 3} more` : "";

        violations.push({
          ruleId: "doc.completeness.low",
          ruleSeverity,
          ruleDomain: "documentary",
          ruleMode: "warn",
          confidence: 0.97,
          ruleDescription: "Documentation file covers fewer than threshold% of referenced exports",
          filePath: d.docPath,
          line: null,
          detail: `${d.completenessPercent}% completeness (${d.coveredExports}/${d.totalRelevantExports} exports covered). Missing: ${topMissing}${moreCount}`,
        });
      }
    } catch {
      // Skip if annotations table missing
    }
  }

  return violations;
}
