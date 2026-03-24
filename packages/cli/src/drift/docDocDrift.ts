// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Doc ↔ Doc Drift Detector (C4)
 *
 * Uses KWG mention data to detect when two documents cover the same topic
 * but have diverged:
 *
 *   1. **Mention footprint divergence** — Two docs share many KWG entities
 *      but each has significant entities the other lacks.
 *
 *   2. **Qualifier contradiction** — The same entity has conflicting
 *      qualifiers in different docs (e.g., "decision" vs "deprecated").
 *
 * All non-LLM, $0. Pure function on serializable inputs.
 *
 * @see PHASE-C-SPEC.md §7
 * @version 0.1
 */

import type {
  DriftSignal,
  DriftEvidence,
  DocDocDriftInput,
  DocDocDriftOutput,
  KwgEntityForDrift,
  KwgMentionForDrift,
} from "@intentweave/core";
import type { SignalQualifier } from "@intentweave/core";

// =============================================================================
// Constants
// =============================================================================

/** Default minimum shared entities to consider a doc pair */
const DEFAULT_MIN_SHARED_ENTITIES = 3;

/** Default minimum divergence to report (0–1) */
const DEFAULT_MIN_DIVERGENCE = 0.3;

/**
 * Qualifier conflict matrix.
 * Maps a pair of qualifiers → severity (or null if no conflict).
 */
const QUALIFIER_CONFLICTS: Array<{
  a: SignalQualifier;
  b: SignalQualifier;
  severity: DriftSignal["severity"];
}> = [
  { a: "must", b: "deprecated", severity: "critical" },
  { a: "decision", b: "deprecated", severity: "warning" },
  { a: "decision", b: "alternative", severity: "warning" },
  { a: "planned", b: "deprecated", severity: "warning" },
  { a: "must", b: "should", severity: "info" },
];

// =============================================================================
// Types (internal)
// =============================================================================

interface DocEntityProfile {
  /** Entity names → mention details */
  entities: Map<string, {
    mentionCount: number;
    qualifiers: Set<SignalQualifier>;
    headings: Set<string>;
  }>;
}

// =============================================================================
// Main Detector
// =============================================================================

/**
 * Detect doc↔doc drift from KWG entity and mention data.
 *
 * Pure function — no Neo4j queries, no side effects.
 */
export function detectDocDocDrift(input: DocDocDriftInput): DocDocDriftOutput {
  const startTime = performance.now();
  const log = input.log ?? (() => {});
  const minSharedEntities = input.minSharedEntities ?? DEFAULT_MIN_SHARED_ENTITIES;
  const minDivergence = input.minDivergence ?? DEFAULT_MIN_DIVERGENCE;

  const { kwgEntities, kwgMentions } = input;
  const signals: DriftSignal[] = [];

  // ── 1. Build per-doc entity profiles ───────────────────────────────────
  log("Building per-doc entity profiles...");
  const docProfiles = buildDocProfiles(kwgMentions);
  const docPaths = [...docProfiles.keys()];
  log(`  → ${docPaths.length} docs with entity profiles`);

  if (docPaths.length < 2) {
    const durationMs = Math.round(performance.now() - startTime);
    log("  → Less than 2 docs, skipping doc-doc drift detection");
    return {
      signals: [],
      stats: {
        enabled: true,
        signalCount: 0,
        durationMs,
        metrics: { docCount: docPaths.length, pairsChecked: 0 },
      },
    };
  }

  // ── 2. Find candidate doc pairs ────────────────────────────────────────
  log("Finding candidate doc pairs...");
  let pairsChecked = 0;
  let candidatePairs = 0;

  for (let i = 0; i < docPaths.length; i++) {
    for (let j = i + 1; j < docPaths.length; j++) {
      pairsChecked++;
      const pathA = docPaths[i];
      const pathB = docPaths[j];
      const profileA = docProfiles.get(pathA)!;
      const profileB = docProfiles.get(pathB)!;

      // Compute shared entities
      const entitiesA = new Set(profileA.entities.keys());
      const entitiesB = new Set(profileB.entities.keys());
      const shared = new Set<string>();
      for (const e of entitiesA) {
        if (entitiesB.has(e)) shared.add(e);
      }

      if (shared.size < minSharedEntities) continue;
      candidatePairs++;

      // ── 3. Compute divergence ──────────────────────────────────────────
      const uniqueToA = [...entitiesA].filter(e => !shared.has(e));
      const uniqueToB = [...entitiesB].filter(e => !shared.has(e));
      const totalEntities = new Set([...entitiesA, ...entitiesB]).size;
      const divergenceScore = (uniqueToA.length + uniqueToB.length) / totalEntities;

      if (divergenceScore >= minDivergence) {
        // Determine severity
        let severity: DriftSignal["severity"];
        if (divergenceScore > 0.5 && shared.size > 5) {
          severity = "warning";
        } else {
          severity = "info";
        }

        signals.push({
          category: "doc-doc-diverged",
          severity,
          detector: "doc-doc",
          message: `"${pathA}" and "${pathB}" share ${shared.size} entities but diverged ${Math.round(divergenceScore * 100)}%`,
          name: `${pathA} ↔ ${pathB}`,
          files: [pathA, pathB],
          evidence: {
            docPair: [pathA, pathB],
            uniqueToA: uniqueToA.slice(0, 10), // Limit for readability
            uniqueToB: uniqueToB.slice(0, 10),
            shared: [...shared].slice(0, 10),
            footprintSimilarity: 1 - divergenceScore,
          },
        });
      }

      // ── 4. Detect qualifier contradictions ─────────────────────────────
      for (const entityName of shared) {
        const qualsA = profileA.entities.get(entityName)?.qualifiers ?? new Set();
        const qualsB = profileB.entities.get(entityName)?.qualifiers ?? new Set();

        if (qualsA.size === 0 || qualsB.size === 0) continue;

        // Check conflict matrix
        for (const conflict of QUALIFIER_CONFLICTS) {
          const hasConflict =
            (qualsA.has(conflict.a) && qualsB.has(conflict.b)) ||
            (qualsA.has(conflict.b) && qualsB.has(conflict.a));

          if (hasConflict) {
            signals.push({
              category: "doc-doc-contradicts",
              severity: conflict.severity,
              detector: "doc-doc",
              message: `Entity "${entityName}" has qualifier "${conflict.a}" in "${pathA}" but "${conflict.b}" in "${pathB}"`,
              name: entityName,
              files: [pathA, pathB],
              evidence: {
                docPair: [pathA, pathB],
                conflictingQualifiers: [{
                  entity: entityName,
                  qualifiersInA: [...qualsA] as SignalQualifier[],
                  qualifiersInB: [...qualsB] as SignalQualifier[],
                }],
              },
            });
          }
        }
      }
    }
  }

  const durationMs = Math.round(performance.now() - startTime);
  log(`Doc-doc drift: ${signals.length} signals, ${pairsChecked} pairs checked, ${candidatePairs} candidates (${durationMs}ms)`);

  return {
    signals,
    stats: {
      enabled: true,
      signalCount: signals.length,
      durationMs,
      metrics: {
        docCount: docPaths.length,
        pairsChecked,
        candidatePairs,
        divergedCount: signals.filter(s => s.category === "doc-doc-diverged").length,
        contradictionCount: signals.filter(s => s.category === "doc-doc-contradicts").length,
      },
    },
  };
}

// =============================================================================
// Utility: Build per-doc entity profiles
// =============================================================================

function buildDocProfiles(
  mentions: KwgMentionForDrift[],
): Map<string, DocEntityProfile> {
  const profiles = new Map<string, DocEntityProfile>();

  for (const mention of mentions) {
    const { filePath, entityName, heading } = mention;

    if (!profiles.has(filePath)) {
      profiles.set(filePath, { entities: new Map() });
    }
    const profile = profiles.get(filePath)!;

    if (!profile.entities.has(entityName)) {
      profile.entities.set(entityName, {
        mentionCount: 0,
        qualifiers: new Set(),
        headings: new Set(),
      });
    }
    const entityInfo = profile.entities.get(entityName)!;
    entityInfo.mentionCount++;
    if (heading) entityInfo.headings.add(heading);

    // Add qualifiers from the mention
    if (mention.qualifiers) {
      for (const q of mention.qualifiers) {
        entityInfo.qualifiers.add(q);
      }
    }
  }

  return profiles;
}
