// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import { fingerprint } from "./canonical.js";

/**
 * Intent Anchors (Phase G5.4). An anchor is a human decision that protects one Claim
 * statement. It separates a normative decision ("this value is intended") from an
 * epistemic confirmation ("this value is currently true"). Evaluation is pure and
 * deterministic: it compares statement fingerprints and never calls a model.
 */

export type IntentAnchorMode = "observe" | "protect";
export type IntentAnchorStatus = "active" | "superseded" | "retired";
export type IntentAnchorOutcome =
  | "satisfied"
  | "intent_conflict"
  | "intent_unresolved";

export interface IntentAnchor {
  id: string;
  claimIdentityId: string;
  claimVersionId: string;
  statementFingerprint: string;
  scope: string;
  mode: IntentAnchorMode;
  authority: "human" | "reviewed-policy";
  source: "review" | "adr" | "spec" | "declaration";
  status: IntentAnchorStatus;
  actor: string;
  rationale?: string;
  createdAt: number;
}

export interface ProtectInput {
  claimIdentityId: string;
  actor: string;
  rationale?: string;
  scope?: string;
  createdAt?: number;
}

export interface IntentAnchorEvaluation {
  anchorId: string;
  claimIdentityId: string;
  outcome: IntentAnchorOutcome;
  reason: string;
  anchoredStatementFingerprint: string;
  currentStatementFingerprint?: string;
}

/** Everything the evaluator needs to know about the current run, per Claim identity. */
export interface AnchorEvaluationInput {
  /** Claim identities that discovery or promotion evaluated in this run. */
  evaluatedClaimIds: ReadonlySet<string>;
  /** Claim identities that were retired in this run. */
  retiredClaimIds: ReadonlySet<string>;
}

interface AnchorRow {
  id: string;
  claim_identity_id: string;
  claim_version_id: string;
  statement_fingerprint: string;
  scope: string;
  mode: IntentAnchorMode;
  authority: "human" | "reviewed-policy";
  source: "review" | "adr" | "spec" | "declaration";
  status: IntentAnchorStatus;
  actor: string;
  rationale: string | null;
  created_at: number;
}

function toAnchor(row: AnchorRow): IntentAnchor {
  return {
    id: row.id,
    claimIdentityId: row.claim_identity_id,
    claimVersionId: row.claim_version_id,
    statementFingerprint: row.statement_fingerprint,
    scope: row.scope,
    mode: row.mode,
    authority: row.authority,
    source: row.source,
    status: row.status,
    actor: row.actor,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    createdAt: row.created_at,
  };
}

export const DEFAULT_ANCHOR_SCOPE = "claim";

export class IntentAnchorStore {
  constructor(private readonly db: Database.Database) {}

  /** The statement fingerprint of a stored Claim version. */
  statementFingerprint(claimVersionId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT normalized_statement_json FROM claim_versions WHERE id = ?`,
      )
      .get(claimVersionId) as { normalized_statement_json: string } | undefined;
    return row
      ? fingerprint(JSON.parse(row.normalized_statement_json))
      : undefined;
  }

  /** The newest version of a Claim identity. */
  latestVersion(
    claimIdentityId: string,
  ): { id: string; statementFingerprint: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, normalized_statement_json
         FROM claim_versions
         WHERE claim_identity_id = ?
         ORDER BY version_ordinal DESC
         LIMIT 1`,
      )
      .get(claimIdentityId) as
      | { id: string; normalized_statement_json: string }
      | undefined;
    return row
      ? {
          id: row.id,
          statementFingerprint: fingerprint(
            JSON.parse(row.normalized_statement_json),
          ),
        }
      : undefined;
  }

  /**
   * Protect the current statement of a Claim. A human decision: authority is `human`
   * and the source is a review. An existing active anchor on the same Claim and scope
   * is superseded, so one scope has one active anchor.
   */
  protect(input: ProtectInput): IntentAnchor {
    const latest = this.latestVersion(input.claimIdentityId);
    if (!latest) {
      throw new Error(
        `Claim ${input.claimIdentityId} has no version to protect`,
      );
    }
    const scope = input.scope ?? DEFAULT_ANCHOR_SCOPE;
    const createdAt = input.createdAt ?? Date.now();
    const id = `anchor:${fingerprint({
      claim: input.claimIdentityId,
      scope,
      statement: latest.statementFingerprint,
      createdAt,
    }).slice(0, 24)}`;
    const protect = this.db.transaction(() => {
      // The partial unique index allows one active anchor per Claim and scope, so the
      // old anchor is retired before the new one is inserted, then linked to it.
      this.db
        .prepare(
          `UPDATE intent_anchors SET status = 'superseded'
           WHERE claim_identity_id = ? AND scope = ? AND status = 'active'`,
        )
        .run(input.claimIdentityId, scope);
      this.db
        .prepare(
          `INSERT INTO intent_anchors (
             id, claim_identity_id, claim_version_id, statement_fingerprint, scope,
             mode, authority, source, status, actor, rationale, created_at
           ) VALUES (?, ?, ?, ?, ?, 'protect', 'human', 'review', 'active', ?, ?, ?)`,
        )
        .run(
          id,
          input.claimIdentityId,
          latest.id,
          latest.statementFingerprint,
          scope,
          input.actor,
          input.rationale ?? null,
          createdAt,
        );
      this.db
        .prepare(
          `UPDATE intent_anchors SET superseded_by_anchor_id = ?
           WHERE claim_identity_id = ? AND scope = ? AND status = 'superseded'
             AND superseded_by_anchor_id IS NULL AND id != ?`,
        )
        .run(id, input.claimIdentityId, scope, id);
    });
    protect();
    return this.get(id)!;
  }

  /**
   * Import an anchor from portable state after a rebuild. Keyed by the anchor id, so
   * an existing row is never rewritten. A second active anchor for one Claim and scope
   * is refused, because it would conflict with the one already in the index.
   */
  importAnchor(input: {
    id: string;
    claimIdentityId: string;
    scope: string;
    statementFingerprint: string;
    status: IntentAnchorStatus;
    actor: string;
    rationale?: string;
    createdAt: number;
  }): "imported" | "present" | "unknown_claim" | "active_conflict" {
    if (this.get(input.id)) return "present";
    const version = this.db
      .prepare(
        `SELECT cv.id, cv.normalized_statement_json
         FROM claim_versions cv
         WHERE cv.claim_identity_id = ?
         ORDER BY cv.version_ordinal DESC`,
      )
      .all(input.claimIdentityId) as Array<{
      id: string;
      normalized_statement_json: string;
    }>;
    if (version.length === 0) return "unknown_claim";
    const matching =
      version.find(
        (row) =>
          fingerprint(JSON.parse(row.normalized_statement_json)) ===
          input.statementFingerprint,
      ) ?? version[0]!;
    if (input.status === "active") {
      const active = this.db
        .prepare(
          `SELECT 1 AS present FROM intent_anchors
           WHERE claim_identity_id = ? AND scope = ? AND status = 'active'`,
        )
        .get(input.claimIdentityId, input.scope) as
        | { present: number }
        | undefined;
      if (active) return "active_conflict";
    }
    this.db
      .prepare(
        `INSERT INTO intent_anchors (
           id, claim_identity_id, claim_version_id, statement_fingerprint, scope,
           mode, authority, source, status, actor, rationale, created_at
         ) VALUES (?, ?, ?, ?, ?, 'protect', 'human', 'review', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.claimIdentityId,
        matching.id,
        input.statementFingerprint,
        input.scope,
        input.status,
        input.actor,
        input.rationale ?? null,
        input.createdAt,
      );
    return "imported";
  }

  get(id: string): IntentAnchor | undefined {
    const row = this.db
      .prepare(`SELECT * FROM intent_anchors WHERE id = ?`)
      .get(id) as AnchorRow | undefined;
    return row ? toAnchor(row) : undefined;
  }

  /** Active anchors, optionally restricted to one Claim identity. */
  active(claimIdentityId?: string): IntentAnchor[] {
    const rows = (
      claimIdentityId
        ? this.db
            .prepare(
              `SELECT * FROM intent_anchors
               WHERE status = 'active' AND claim_identity_id = ?
               ORDER BY created_at, id`,
            )
            .all(claimIdentityId)
        : this.db
            .prepare(
              `SELECT * FROM intent_anchors WHERE status = 'active'
               ORDER BY created_at, id`,
            )
            .all()
    ) as AnchorRow[];
    return rows.map(toAnchor);
  }

  retire(id: string): void {
    this.db
      .prepare(
        `UPDATE intent_anchors SET status = 'retired'
         WHERE id = ? AND status = 'active'`,
      )
      .run(id);
  }

  /** The current assessment status of a Claim identity, when one exists. */
  currentAssessmentStatus(
    claimIdentityId: string,
  ): "supported" | "refuted" | "contested" | "inconclusive" | undefined {
    const row = this.db
      .prepare(
        `SELECT ca.epistemic_status
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         WHERE cv.claim_identity_id = ? AND ca.is_current = 1
         ORDER BY ca.created_at DESC
         LIMIT 1`,
      )
      .get(claimIdentityId) as
      | {
          epistemic_status:
            | "supported"
            | "refuted"
            | "contested"
            | "inconclusive";
        }
      | undefined;
    return row?.epistemic_status;
  }

  /**
   * Evaluate every active anchor against the current run. Checks run in order:
   * - retired Claim: `intent_conflict`.
   * - not evaluated in this run: `intent_unresolved`, never a silent pass.
   * - statement changed: `intent_conflict`.
   * - current assessment refuted or contested: `intent_conflict`.
   * - current assessment inconclusive: `intent_unresolved`.
   * - otherwise `satisfied`.
   */
  evaluate(input: AnchorEvaluationInput): IntentAnchorEvaluation[] {
    const results: IntentAnchorEvaluation[] = [];
    for (const anchor of this.active()) {
      if (anchor.mode !== "protect") continue;
      const base = {
        anchorId: anchor.id,
        claimIdentityId: anchor.claimIdentityId,
        anchoredStatementFingerprint: anchor.statementFingerprint,
      };
      if (input.retiredClaimIds.has(anchor.claimIdentityId)) {
        results.push({
          ...base,
          outcome: "intent_conflict",
          reason: "the anchored Claim was retired",
        });
        continue;
      }
      if (!input.evaluatedClaimIds.has(anchor.claimIdentityId)) {
        results.push({
          ...base,
          outcome: "intent_unresolved",
          reason: "the anchored Claim was not evaluated in this run",
        });
        continue;
      }
      const latest = this.latestVersion(anchor.claimIdentityId);
      if (!latest) {
        results.push({
          ...base,
          outcome: "intent_unresolved",
          reason: "the anchored Claim has no stored version",
        });
        continue;
      }
      const assessment = this.currentAssessmentStatus(anchor.claimIdentityId);
      const current = {
        currentStatementFingerprint: latest.statementFingerprint,
      };
      if (latest.statementFingerprint !== anchor.statementFingerprint) {
        results.push({
          ...base,
          ...current,
          outcome: "intent_conflict",
          reason: "the Claim statement differs from the anchored statement",
        });
      } else if (assessment === "refuted" || assessment === "contested") {
        results.push({
          ...base,
          ...current,
          outcome: "intent_conflict",
          reason: `the current assessment is ${assessment}`,
        });
      } else if (assessment === "inconclusive") {
        results.push({
          ...base,
          ...current,
          outcome: "intent_unresolved",
          reason: "the current assessment is inconclusive",
        });
      } else {
        results.push({
          ...base,
          ...current,
          outcome: "satisfied",
          reason: "the anchored statement is unchanged and supported",
        });
      }
    }
    return results;
  }
}
