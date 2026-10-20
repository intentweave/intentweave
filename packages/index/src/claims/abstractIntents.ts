// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Abstract Intent Anchors (Phase G5.4 slice 2). An abstract intent has no statement of its
 * own. It is realized by a set of Claims, and an abstract anchor protects that set: the intent
 * holds while the set is unchanged and every realizer is supported.
 *
 * The realizer set is recorded by a person. Nothing here infers it, and no model is called.
 */

import type Database from "@intentweave/sqlite-compat";
import { fingerprint } from "./canonical.js";
import { IntentAnchorStore } from "./intentAnchors.js";

export class AbstractIntentError extends Error {}

export interface AbstractRealization {
  id: string;
  intentKey: string;
  claimIdentityId: string;
  status: "active" | "retired";
  actor: string;
  rationale?: string;
  createdAt: number;
  retiredAt?: number;
}

export interface AbstractIntentAnchor {
  id: string;
  intentKey: string;
  scope: string;
  realizerSetFingerprint: string;
  realizers: string[];
  authority: "human" | "ai-proposed";
  status: "active" | "superseded";
  actor: string;
  rationale?: string;
  createdAt: number;
}

export interface AbstractAnchorEvaluation {
  anchorId: string;
  intentKey: string;
  outcome: "satisfied" | "intent_conflict" | "intent_unresolved";
  reason: string;
  anchoredRealizers: string[];
  currentRealizers: string[];
}

export const DEFAULT_ABSTRACT_SCOPE = "intent";

interface RealizationRow {
  id: string;
  intent_key: string;
  claim_identity_id: string;
  status: "active" | "retired";
  actor: string;
  rationale: string | null;
  created_at: number;
  retired_at: number | null;
}

interface AnchorRow {
  id: string;
  intent_key: string;
  scope: string;
  realizer_set_fingerprint: string;
  realizers_json: string;
  authority: "human" | "ai-proposed";
  status: "active" | "superseded";
  actor: string;
  rationale: string | null;
  created_at: number;
}

function toRealization(row: RealizationRow): AbstractRealization {
  return {
    id: row.id,
    intentKey: row.intent_key,
    claimIdentityId: row.claim_identity_id,
    status: row.status,
    actor: row.actor,
    ...(row.rationale !== null ? { rationale: row.rationale } : {}),
    createdAt: row.created_at,
    ...(row.retired_at !== null ? { retiredAt: row.retired_at } : {}),
  };
}

function toAnchor(row: AnchorRow): AbstractIntentAnchor {
  return {
    id: row.id,
    intentKey: row.intent_key,
    scope: row.scope,
    realizerSetFingerprint: row.realizer_set_fingerprint,
    realizers: JSON.parse(row.realizers_json) as string[],
    authority: row.authority,
    status: row.status,
    actor: row.actor,
    ...(row.rationale !== null ? { rationale: row.rationale } : {}),
    createdAt: row.created_at,
  };
}

/** The fingerprint of a realizer set. The order of the input does not matter. */
export function realizerSetFingerprint(realizers: readonly string[]): string {
  return fingerprint([...realizers].sort());
}

export class AbstractIntentStore {
  constructor(private readonly db: Database.Database) {}

  realization(id: string): AbstractRealization | undefined {
    const row = this.db
      .prepare(`SELECT * FROM abstract_intent_realizations WHERE id = ?`)
      .get(id) as RealizationRow | undefined;
    return row ? toRealization(row) : undefined;
  }

  /** The active realizers of an intent, sorted. */
  activeRealizers(intentKey: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT claim_identity_id AS id FROM abstract_intent_realizations
           WHERE status = 'active' AND intent_key = ? ORDER BY claim_identity_id`,
        )
        .all(intentKey) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  /** Record that a Claim realizes an abstract intent. */
  realize(input: {
    intentKey: string;
    claimIdentityId: string;
    actor: string;
    rationale?: string;
    createdAt?: number;
  }): AbstractRealization {
    if (input.intentKey.trim() === "") {
      throw new AbstractIntentError("An intent key cannot be empty");
    }
    if (
      !this.db
        .prepare(`SELECT 1 FROM claim_identities WHERE id = ?`)
        .get(input.claimIdentityId)
    ) {
      throw new AbstractIntentError(
        `Unknown Claim identity ${input.claimIdentityId}`,
      );
    }
    const duplicate = this.db
      .prepare(
        `SELECT id FROM abstract_intent_realizations
         WHERE status = 'active' AND intent_key = ? AND claim_identity_id = ?`,
      )
      .get(input.intentKey, input.claimIdentityId) as
      | { id: string }
      | undefined;
    if (duplicate) {
      throw new AbstractIntentError(
        `${input.claimIdentityId} already realizes ${input.intentKey} as ${duplicate.id}`,
      );
    }
    const createdAt = input.createdAt ?? Date.now();
    const id = `realization:${fingerprint({
      intent: input.intentKey,
      claim: input.claimIdentityId,
      createdAt,
    }).slice(0, 24)}`;
    this.db
      .prepare(
        `INSERT INTO abstract_intent_realizations (
           id, intent_key, claim_identity_id, status, actor, rationale, created_at
         ) VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        input.intentKey,
        input.claimIdentityId,
        input.actor,
        input.rationale ?? null,
        createdAt,
      );
    return this.realization(id)!;
  }

  /** Retire a realization. The row stays as history. */
  unrealize(id: string, retiredAt: number = Date.now()): AbstractRealization {
    const current = this.realization(id);
    if (!current) throw new AbstractIntentError(`Unknown realization ${id}`);
    if (current.status !== "active") {
      throw new AbstractIntentError(`Realization ${id} is already retired`);
    }
    this.db
      .prepare(
        `UPDATE abstract_intent_realizations SET status = 'retired', retired_at = ? WHERE id = ?`,
      )
      .run(retiredAt, id);
    return this.realization(id)!;
  }

  anchor(id: string): AbstractIntentAnchor | undefined {
    const row = this.db
      .prepare(`SELECT * FROM abstract_intent_anchors WHERE id = ?`)
      .get(id) as AnchorRow | undefined;
    return row ? toAnchor(row) : undefined;
  }

  active(): AbstractIntentAnchor[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM abstract_intent_anchors WHERE status = 'active' ORDER BY intent_key, scope`,
        )
        .all() as AnchorRow[]
    ).map(toAnchor);
  }

  /**
   * Protect the current realizer set of an intent. A human decision. Replacing an active
   * anchor requires `amendment: true`, the same rule as for concrete anchors.
   */
  protect(input: {
    intentKey: string;
    actor: string;
    rationale?: string;
    scope?: string;
    authority?: "human" | "ai-proposed";
    amendment?: boolean;
    createdAt?: number;
  }): AbstractIntentAnchor {
    const realizers = this.activeRealizers(input.intentKey);
    if (realizers.length === 0) {
      throw new AbstractIntentError(
        `Intent ${input.intentKey} has no realizers to protect`,
      );
    }
    const scope = input.scope ?? DEFAULT_ABSTRACT_SCOPE;
    const active = this.db
      .prepare(
        `SELECT id FROM abstract_intent_anchors
         WHERE status = 'active' AND intent_key = ? AND scope = ?`,
      )
      .get(input.intentKey, scope) as { id: string } | undefined;
    if (active && !input.amendment) {
      throw new AbstractIntentError(
        `Intent ${input.intentKey} is already protected in scope ${scope} by ${active.id}; ` +
          `replace it with an amendment decision`,
      );
    }
    const createdAt = input.createdAt ?? Date.now();
    const setFingerprint = realizerSetFingerprint(realizers);
    const id = `abstract-anchor:${fingerprint({
      intent: input.intentKey,
      scope,
      set: setFingerprint,
      createdAt,
    }).slice(0, 24)}`;
    const protect = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE abstract_intent_anchors SET status = 'superseded'
           WHERE intent_key = ? AND scope = ? AND status = 'active'`,
        )
        .run(input.intentKey, scope);
      this.db
        .prepare(
          `INSERT INTO abstract_intent_anchors (
             id, intent_key, scope, realizer_set_fingerprint, realizers_json,
             authority, status, actor, rationale, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          input.intentKey,
          scope,
          setFingerprint,
          JSON.stringify(realizers),
          input.authority ?? "human",
          input.actor,
          input.rationale ?? null,
          createdAt,
        );
    });
    protect();
    return this.anchor(id)!;
  }

  /**
   * Judge each active abstract anchor against the current database state. Undecided
   * outcomes come first: a changed set is a conflict, so it is reported before the
   * realizers are judged.
   */
  evaluate(input: {
    retiredClaimIds: ReadonlySet<string>;
  }): AbstractAnchorEvaluation[] {
    const assessments = new IntentAnchorStore(this.db);
    return this.active().map((anchor) => {
      const current = this.activeRealizers(anchor.intentKey);
      const base = {
        anchorId: anchor.id,
        intentKey: anchor.intentKey,
        anchoredRealizers: anchor.realizers,
        currentRealizers: current,
      };
      if (current.length === 0) {
        return {
          ...base,
          outcome: "intent_unresolved" as const,
          reason: "the intent has no realizers",
        };
      }
      if (realizerSetFingerprint(current) !== anchor.realizerSetFingerprint) {
        return {
          ...base,
          outcome: "intent_conflict" as const,
          reason: `the realizer set changed (anchored ${anchor.realizers.length}, now ${current.length})`,
        };
      }
      for (const realizer of current) {
        if (input.retiredClaimIds.has(realizer)) {
          return {
            ...base,
            outcome: "intent_conflict" as const,
            reason: `realizer ${realizer} was retired`,
          };
        }
        const status = assessments.currentAssessmentStatus(realizer);
        if (status === "refuted" || status === "contested") {
          return {
            ...base,
            outcome: "intent_conflict" as const,
            reason: `realizer ${realizer} is ${status}`,
          };
        }
        if (status === undefined || status === "inconclusive") {
          return {
            ...base,
            outcome: "intent_unresolved" as const,
            reason: `realizer ${realizer} has no decided assessment`,
          };
        }
      }
      return {
        ...base,
        outcome: "satisfied" as const,
        reason: "the realizer set is unchanged and every realizer is supported",
      };
    });
  }

  /** Import a realization from portable state. Existing ids are kept, not rewritten. */
  importRealization(
    input: AbstractRealization,
  ): "imported" | "present" | "unknown_claim" {
    if (this.realization(input.id)) return "present";
    if (
      !this.db
        .prepare(`SELECT 1 FROM claim_identities WHERE id = ?`)
        .get(input.claimIdentityId)
    ) {
      return "unknown_claim";
    }
    this.db
      .prepare(
        `INSERT INTO abstract_intent_realizations (
           id, intent_key, claim_identity_id, status, actor, rationale, created_at, retired_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.intentKey,
        input.claimIdentityId,
        input.status,
        input.actor,
        input.rationale ?? null,
        input.createdAt,
        input.retiredAt ?? null,
      );
    return "imported";
  }

  /** Import an anchor from portable state. An active anchor never displaces another one. */
  importAnchor(
    input: AbstractIntentAnchor,
  ): "imported" | "present" | "active_conflict" {
    if (this.anchor(input.id)) return "present";
    if (input.status === "active") {
      const other = this.db
        .prepare(
          `SELECT id FROM abstract_intent_anchors
           WHERE status = 'active' AND intent_key = ? AND scope = ?`,
        )
        .get(input.intentKey, input.scope);
      if (other) return "active_conflict";
    }
    this.db
      .prepare(
        `INSERT INTO abstract_intent_anchors (
           id, intent_key, scope, realizer_set_fingerprint, realizers_json,
           authority, status, actor, rationale, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.intentKey,
        input.scope,
        input.realizerSetFingerprint,
        JSON.stringify(input.realizers),
        input.authority,
        input.status,
        input.actor,
        input.rationale ?? null,
        input.createdAt,
      );
    return "imported";
  }
}
