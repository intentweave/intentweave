// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import { fingerprint } from "./canonical.js";
import { ClaimRelationStore } from "./claimRelations.js";

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
  | "intent_unresolved"
  | "intent_excepted";

/** A recorded decision on the conflict of one anchor and one exact statement. */
export interface ConflictDecision {
  id: string;
  anchorId: string;
  claimIdentityId: string;
  statementFingerprint: string;
  decision: "rejected" | "excepted";
  actor: string;
  rationale?: string;
  decidedAt: number;
  expiresAt?: number;
}

export interface IntentAnchor {
  id: string;
  claimIdentityId: string;
  claimVersionId: string;
  statementFingerprint: string;
  scope: string;
  mode: IntentAnchorMode;
  authority: IntentAnchorAuthority;
  source: "review" | "adr" | "spec" | "declaration";
  status: IntentAnchorStatus;
  actor: string;
  rationale?: string;
  createdAt: number;
}

/**
 * Who decided the anchor. `human` is a reviewed decision. `ai-proposed` is an anchor a model
 * proposed and the system activated on creation (G5.4). Its conflicts are still decided by a
 * person, and nothing resolves them automatically.
 */
export type IntentAnchorAuthority = "human" | "reviewed-policy" | "ai-proposed";

export interface ProtectInput {
  claimIdentityId: string;
  actor: string;
  /** Defaults to `human`. `ai-proposed` is recorded for an anchor a model proposed. */
  authority?: "human" | "ai-proposed";
  rationale?: string;
  scope?: string;
  createdAt?: number;
  /**
   * True only for a decided amendment (`accept_amendment`): the new anchor replaces the
   * active one on the same Claim and scope. Without it, an existing active anchor is never
   * replaced silently; protect refuses and the caller must decide the change explicitly.
   */
  amendment?: boolean;
}

export interface IntentAnchorEvaluation {
  anchorId: string;
  /** True when a declared follow-up made the statement change acceptable (G5.4). */
  followUp?: boolean;
  /** The recorded decision that shaped a conflict, if any (G5.4). */
  decision?: "rejected" | "excepted" | "exception-expired";
  claimIdentityId: string;
  outcome: IntentAnchorOutcome;
  reason: string;
  anchoredStatementFingerprint: string;
  currentStatementFingerprint?: string;
}

/** Everything the evaluator needs to know about the current run, per Claim identity. */
/**
 * A declared follow-up: the repository's own versioned record that a statement change
 * is intended. It names the Claim identity and the exact new statement fingerprint.
 */
export interface DeclaredFollowUp {
  claimIdentityId: string;
  statementFingerprint: string;
}

export interface AnchorEvaluationInput {
  /** The instant an exception is judged against (ms since epoch). */
  asOf?: number;
  /** Declared follow-ups from `.iw/claims/intent.yaml`. */
  followUps?: readonly DeclaredFollowUp[];
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
  authority: IntentAnchorAuthority;
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
   * and the source is a review. One scope has one active anchor. Replacing an active
   * anchor requires `amendment: true`, so an overwrite is always a decided change and
   * never a side effect of a new protection.
   */
  protect(input: ProtectInput): IntentAnchor {
    const latest = this.latestVersion(input.claimIdentityId);
    if (!latest) {
      throw new Error(
        `Claim ${input.claimIdentityId} has no version to protect`,
      );
    }
    const scope = input.scope ?? DEFAULT_ANCHOR_SCOPE;
    const active = this.active(input.claimIdentityId).find(
      (anchor) => anchor.scope === scope,
    );
    if (active && !input.amendment) {
      throw new Error(
        `Claim ${input.claimIdentityId} is already protected in scope ${scope} by ${active.id}; ` +
          `replace it with an amendment decision (claims conflicts resolve --decision accept_amendment)`,
      );
    }
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
           ) VALUES (?, ?, ?, ?, ?, 'protect', ?, 'review', 'active', ?, ?, ?)`,
        )
        .run(
          id,
          input.claimIdentityId,
          latest.id,
          latest.statementFingerprint,
          scope,
          input.authority ?? "human",
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
    authority: "human" | "ai-proposed";
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
         ) VALUES (?, ?, ?, ?, ?, 'protect', ?, 'review', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.claimIdentityId,
        matching.id,
        input.statementFingerprint,
        input.scope,
        input.authority,
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

  /** Record a decision on the conflict of an active anchor's current change. */
  recordConflictDecision(input: {
    anchorId: string;
    decision: "rejected" | "excepted";
    actor: string;
    rationale?: string;
    decidedAt: number;
    expiresAt?: number;
  }): ConflictDecision {
    const anchor = this.get(input.anchorId);
    if (!anchor || anchor.status !== "active") {
      throw new Error(`Intent anchor ${input.anchorId} is not active`);
    }
    const latest = this.latestVersion(anchor.claimIdentityId);
    if (
      !latest ||
      latest.statementFingerprint === anchor.statementFingerprint
    ) {
      throw new Error(
        `Claim ${anchor.claimIdentityId} has no changed statement to decide`,
      );
    }
    const decision: ConflictDecision = {
      id: `conflict-decision:${fingerprint({
        anchor: anchor.id,
        statement: latest.statementFingerprint,
        decision: input.decision,
        decidedAt: input.decidedAt,
      }).slice(0, 24)}`,
      anchorId: anchor.id,
      claimIdentityId: anchor.claimIdentityId,
      statementFingerprint: latest.statementFingerprint,
      decision: input.decision,
      actor: input.actor,
      ...(input.rationale ? { rationale: input.rationale } : {}),
      decidedAt: input.decidedAt,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO intent_conflict_decisions (
           id, anchor_id, claim_identity_id, statement_fingerprint, decision,
           actor, rationale, decided_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.anchorId,
        decision.claimIdentityId,
        decision.statementFingerprint,
        decision.decision,
        decision.actor,
        decision.rationale ?? null,
        decision.decidedAt,
        decision.expiresAt ?? null,
      );
    return decision;
  }

  /** The latest decision on an anchor's conflict for one statement fingerprint. */
  conflictDecision(
    anchorId: string,
    statementFingerprint: string,
  ): ConflictDecision | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM intent_conflict_decisions
         WHERE anchor_id = ? AND statement_fingerprint = ?
         ORDER BY decided_at DESC, id DESC
         LIMIT 1`,
      )
      .get(anchorId, statementFingerprint) as
      | {
          id: string;
          anchor_id: string;
          claim_identity_id: string;
          statement_fingerprint: string;
          decision: "rejected" | "excepted";
          actor: string;
          rationale: string | null;
          decided_at: number;
          expires_at: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      anchorId: row.anchor_id,
      claimIdentityId: row.claim_identity_id,
      statementFingerprint: row.statement_fingerprint,
      decision: row.decision,
      actor: row.actor,
      ...(row.rationale ? { rationale: row.rationale } : {}),
      decidedAt: row.decided_at,
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    };
  }

  /** Import a conflict decision from portable state. Existing rows are kept. */
  importConflictDecision(
    decision: ConflictDecision,
  ): "imported" | "present" | "unknown_anchor" {
    const exists = this.db
      .prepare(
        `SELECT 1 AS present FROM intent_conflict_decisions WHERE id = ?`,
      )
      .get(decision.id) as { present: number } | undefined;
    if (exists) return "present";
    const anchor = this.get(decision.anchorId);
    if (!anchor) return "unknown_anchor";
    this.db
      .prepare(
        `INSERT INTO intent_conflict_decisions (
           id, anchor_id, claim_identity_id, statement_fingerprint, decision,
           actor, rationale, decided_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.anchorId,
        decision.claimIdentityId,
        decision.statementFingerprint,
        decision.decision,
        decision.actor,
        decision.rationale ?? null,
        decision.decidedAt,
        decision.expiresAt ?? null,
      );
    return "imported";
  }

  /** The id of the current assessment of a Claim identity, when one exists. */
  currentAssessmentId(claimIdentityId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT ca.id
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         WHERE cv.claim_identity_id = ? AND ca.is_current = 1
         ORDER BY ca.created_at DESC
         LIMIT 1`,
      )
      .get(claimIdentityId) as { id: string } | undefined;
    return row?.id;
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
    const asOf = input.asOf ?? Date.now();
    return this.evaluateAnchors(input).map((result) => {
      if (
        result.outcome !== "intent_conflict" ||
        !result.currentStatementFingerprint
      ) {
        return result;
      }
      const decision = this.conflictDecision(
        result.anchorId,
        result.currentStatementFingerprint,
      );
      if (!decision) return result;
      if (decision.decision === "rejected") {
        return {
          ...result,
          decision: "rejected",
          reason: `${result.reason}; the change was rejected by ${decision.actor}`,
        };
      }
      if (decision.expiresAt === undefined || asOf < decision.expiresAt) {
        return {
          ...result,
          outcome: "intent_excepted",
          decision: "excepted",
          reason: `${result.reason}; excepted by ${decision.actor}${decision.expiresAt === undefined ? "" : ` until ${new Date(decision.expiresAt).toISOString()}`}`,
        };
      }
      return {
        ...result,
        decision: "exception-expired",
        reason: `${result.reason}; the exception expired at ${new Date(decision.expiresAt).toISOString()}`,
      };
    });
  }

  /**
   * An anchor on a Claim also holds through its realizers: each must be supported. A
   * refuted, contested, or retired realizer is a conflict, and a realizer without a decided
   * assessment is unresolved. Returns undefined when every realizer holds.
   */
  private realizationOutcome(
    realizers: readonly string[],
    input: AnchorEvaluationInput,
  ):
    | { outcome: "intent_conflict" | "intent_unresolved"; reason: string }
    | undefined {
    for (const realizer of realizers) {
      if (input.retiredClaimIds.has(realizer)) {
        return {
          outcome: "intent_conflict",
          reason: `realizer ${realizer} was retired`,
        };
      }
      const status = this.currentAssessmentStatus(realizer);
      if (status === "refuted" || status === "contested") {
        return {
          outcome: "intent_conflict",
          reason: `realizer ${realizer} is ${status}`,
        };
      }
      if (status === undefined || status === "inconclusive") {
        return {
          outcome: "intent_unresolved",
          reason: `realizer ${realizer} has no decided assessment`,
        };
      }
    }
    return undefined;
  }

  private evaluateAnchors(
    input: AnchorEvaluationInput,
  ): IntentAnchorEvaluation[] {
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
      // An anchor on a Claim is also evaluated when one of its realizers changed (G5.4 slice 2).
      const realizers = new ClaimRelationStore(this.db).realizersOf(
        anchor.claimIdentityId,
      );
      const reached =
        input.evaluatedClaimIds.has(anchor.claimIdentityId) ||
        realizers.some((id) => input.evaluatedClaimIds.has(id));
      if (!reached) {
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
      const current = {
        currentStatementFingerprint: latest.statementFingerprint,
      };
      const assessment = this.currentAssessmentStatus(anchor.claimIdentityId);
      if (latest.statementFingerprint !== anchor.statementFingerprint) {
        const declared = (input.followUps ?? []).some(
          (followUp) =>
            followUp.claimIdentityId === anchor.claimIdentityId &&
            followUp.statementFingerprint === latest.statementFingerprint,
        );
        // A declared follow-up is accepted only with a supported assessment, so it
        // cannot lift a refuted or unassessed statement.
        results.push(
          declared && assessment === "supported"
            ? {
                ...base,
                ...current,
                outcome: "satisfied",
                followUp: true,
                reason: "the statement change is a declared follow-up",
              }
            : {
                ...base,
                ...current,
                outcome: "intent_conflict",
                reason:
                  "the Claim statement differs from the anchored statement",
              },
        );
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
        const realized = this.realizationOutcome(realizers, input);
        results.push({
          ...base,
          ...current,
          outcome: realized?.outcome ?? "satisfied",
          reason:
            realized?.reason ??
            "the anchored statement is unchanged and supported",
        });
      }
    }
    return results;
  }
}
