// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Observed changes against Intent Anchors (G5.4 bridge, decision: a separate command).
 *
 * An observed change to an identity that a Claim depends on impacts that Claim. The impact
 * is judged deterministically:
 * - a Claim whose observed subject was removed is `intent_conflict`;
 * - an impacted Claim without an assessment judged at HEAD is `intent_unresolved`, until
 *   `claims check` re-assesses it. The observation check never re-assesses anything;
 * - a Claim with unclear continuity is `intent_unresolved`;
 * - otherwise the anchor is judged by the same rules as `claims check`.
 *
 * `claims check` does not read observation state (decision C), so this check is separate.
 * It applies direct anchors only. Realizer-based outcomes stay in `claims check`.
 */

import {
  IntentAnchorStore,
  type IntentAnchorEvaluation,
} from "@intentweave/index";
import { readIntentConfig, type IntentMode } from "../claims/intentConfig.js";
import {
  projectPortableConflictDecisions,
  projectPortableIntentAnchors,
} from "../claims/portableReviewProjection.js";
import { loadPortableClaimsState } from "../claims/portableState.js";
import { observationChangeSet } from "./observationCommands.js";

export interface AnchorImpact {
  claimIdentityId: string;
  changeKinds: string[];
  reassessedAtHead: boolean;
}

export interface AnchorImpactReport {
  mode: IntentMode;
  base?: string;
  head?: string;
  impacts: AnchorImpact[];
  anchors: IntentAnchorEvaluation[];
  exitCode: 0 | 1 | 2;
}

/** Judge observed changes against the active anchors of the Claims they impact. */
export function checkObservationAnchors(
  workspaceRoot: string,
  since: string,
): AnchorImpactReport {
  const mode = readIntentConfig(workspaceRoot).mode;
  if (mode === "off") {
    return { mode, impacts: [], anchors: [], exitCode: 0 };
  }
  const range = observationChangeSet(workspaceRoot, since);
  try {
    // A rebuilt index has no anchors until portable state is imported, as in claims check.
    const portable = loadPortableClaimsState(workspaceRoot);
    if (portable) {
      projectPortableIntentAnchors(range.db, portable);
      projectPortableConflictDecisions(range.db, portable);
    }
    const kindsByClaim = new Map<string, Set<string>>();
    const removed = new Set<string>();
    const unclear = new Set<string>();
    // Two deterministic routes: the Subject bridge (Claim, Subject, active observed identity)
    // and the evidence dependency route used by observation producers.
    const claimsBySubject = range.db.prepare(
      `SELECT claim_identity_id AS id FROM claim_subjects
       WHERE subject_identity_id IN (
         SELECT subject_identity_id FROM subject_observations
         WHERE observed_identity_id = ? AND retired_run_id IS NULL
       )`,
    );
    for (const item of range.items) {
      const viaSubject = (
        claimsBySubject.all(item.observedIdentityId) as Array<{ id: string }>
      ).map((row) => row.id);
      const claimIds = new Set([
        ...viaSubject,
        ...range.store.dependentClaims(item.observedIdentityId),
      ]);
      for (const claimId of claimIds) {
        const kinds = kindsByClaim.get(claimId) ?? new Set<string>();
        kinds.add(item.changeKind);
        kindsByClaim.set(claimId, kinds);
        if (item.changeKind === "removed") removed.add(claimId);
        if (item.changeKind === "continuity-unclear") unclear.add(claimId);
      }
    }

    const assessedAtHead = range.db.prepare(
      `SELECT ca.repository_revision AS revision
       FROM claim_assessments ca
       JOIN claim_versions cv ON cv.id = ca.claim_version_id
       WHERE cv.claim_identity_id = ? AND ca.is_current = 1
       ORDER BY ca.created_at DESC LIMIT 1`,
    );
    const reassessed = new Set<string>();
    const impacts: AnchorImpact[] = [];
    for (const [claimId, kinds] of kindsByClaim) {
      const row = assessedAtHead.get(claimId) as
        | { revision: string }
        | undefined;
      const atHead = row?.revision === range.head;
      if (atHead) reassessed.add(claimId);
      impacts.push({
        claimIdentityId: claimId,
        changeKinds: [...kinds].sort(),
        reassessedAtHead: atHead,
      });
    }
    impacts.sort((a, b) => a.claimIdentityId.localeCompare(b.claimIdentityId));

    const anchors = new IntentAnchorStore(range.db);
    const judged = anchors.evaluate({
      evaluatedClaimIds: reassessed,
      retiredClaimIds: removed,
    });
    const reports: IntentAnchorEvaluation[] = [];
    for (const claimId of kindsByClaim.keys()) {
      const active = anchors.active(claimId);
      if (active.length === 0) continue;
      if (removed.has(claimId)) {
        for (const anchor of active) {
          reports.push(
            conflict(
              anchor.id,
              claimId,
              anchor.statementFingerprint,
              "an observed subject of this Claim was removed",
            ),
          );
        }
      } else if (unclear.has(claimId)) {
        for (const anchor of active) {
          reports.push(
            unresolved(
              anchor.id,
              claimId,
              anchor.statementFingerprint,
              "the continuity of an observed subject is unclear",
            ),
          );
        }
      } else if (!reassessed.has(claimId)) {
        for (const anchor of active) {
          reports.push(
            unresolved(
              anchor.id,
              claimId,
              anchor.statementFingerprint,
              "observed changes are not yet reassessed at HEAD; run claims check",
            ),
          );
        }
      } else {
        reports.push(...judged.filter((r) => r.claimIdentityId === claimId));
      }
    }

    const outcomes = reports.map((r) => r.outcome);
    const exitCode: 0 | 1 | 2 =
      mode !== "gate"
        ? 0
        : outcomes.includes("intent_conflict")
          ? 1
          : outcomes.includes("intent_unresolved")
            ? 2
            : 0;
    return {
      mode,
      base: range.base,
      head: range.head,
      impacts,
      anchors: reports,
      exitCode,
    };
  } finally {
    range.db.close();
  }
}

function conflict(
  anchorId: string,
  claimIdentityId: string,
  fingerprintValue: string,
  reason: string,
): IntentAnchorEvaluation {
  return {
    anchorId,
    claimIdentityId,
    anchoredStatementFingerprint: fingerprintValue,
    outcome: "intent_conflict",
    reason,
  };
}

function unresolved(
  anchorId: string,
  claimIdentityId: string,
  fingerprintValue: string,
  reason: string,
): IntentAnchorEvaluation {
  return {
    anchorId,
    claimIdentityId,
    anchoredStatementFingerprint: fingerprintValue,
    outcome: "intent_unresolved",
    reason,
  };
}
