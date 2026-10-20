// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Claim Relations (Phase G5.4 slice 2). A relation is a versioned edge from a source Claim
 * identity to a target Claim identity. It is not a hierarchy, and it decides nothing by
 * itself. Only `realizes` and `refines` take part in intent evaluation: an Intent Anchor on a
 * target applies through them to its realizers. `constrains` and `warrants` are recorded only.
 */

import type Database from "@intentweave/sqlite-compat";
import { fingerprint } from "./canonical.js";

export type ClaimRelationKind =
  | "realizes"
  | "refines"
  | "constrains"
  | "warrants";

/** Kinds that carry an anchored intent from a source to its target. */
export const REALIZATION_KINDS: readonly ClaimRelationKind[] = [
  "realizes",
  "refines",
];

export interface ClaimRelation {
  id: string;
  sourceClaimIdentityId: string;
  targetClaimIdentityId: string;
  relation: ClaimRelationKind;
  status: "active" | "retired";
  actor: string;
  rationale?: string;
  createdAt: number;
  retiredAt?: number;
}

export interface AddClaimRelationInput {
  sourceClaimIdentityId: string;
  targetClaimIdentityId: string;
  relation: ClaimRelationKind;
  actor: string;
  rationale?: string;
  createdAt?: number;
}

export class ClaimRelationError extends Error {}

interface RelationRow {
  id: string;
  source_claim_identity_id: string;
  target_claim_identity_id: string;
  relation: ClaimRelationKind;
  status: "active" | "retired";
  actor: string;
  rationale: string | null;
  created_at: number;
  retired_at: number | null;
}

function toRelation(row: RelationRow): ClaimRelation {
  return {
    id: row.id,
    sourceClaimIdentityId: row.source_claim_identity_id,
    targetClaimIdentityId: row.target_claim_identity_id,
    relation: row.relation,
    status: row.status,
    actor: row.actor,
    ...(row.rationale !== null ? { rationale: row.rationale } : {}),
    createdAt: row.created_at,
    ...(row.retired_at !== null ? { retiredAt: row.retired_at } : {}),
  };
}

export class ClaimRelationStore {
  constructor(private readonly db: Database.Database) {}

  get(id: string): ClaimRelation | undefined {
    const row = this.db
      .prepare(`SELECT * FROM claim_relations WHERE id = ?`)
      .get(id) as RelationRow | undefined;
    return row ? toRelation(row) : undefined;
  }

  active(): ClaimRelation[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM claim_relations WHERE status = 'active' ORDER BY created_at, id`,
        )
        .all() as RelationRow[]
    ).map(toRelation);
  }

  /** Source Claims that realize or refine the target, in deterministic order. */
  realizersOf(targetClaimIdentityId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT source_claim_identity_id AS source FROM claim_relations
           WHERE status = 'active' AND target_claim_identity_id = ?
             AND relation IN ('realizes', 'refines')
           ORDER BY source_claim_identity_id`,
        )
        .all(targetClaimIdentityId) as Array<{ source: string }>
    ).map((row) => row.source);
  }

  /**
   * Record an active relation. Refuses a self-edge, a second active edge of the same kind
   * between the same pair, a missing Claim, and a realization cycle: a `realizes` or
   * `refines` edge from A to B is refused when A is already reachable from B along
   * realization edges.
   */
  add(input: AddClaimRelationInput): ClaimRelation {
    if (input.sourceClaimIdentityId === input.targetClaimIdentityId) {
      throw new ClaimRelationError("A Claim cannot relate to itself");
    }
    for (const id of [
      input.sourceClaimIdentityId,
      input.targetClaimIdentityId,
    ]) {
      const exists = this.db
        .prepare(`SELECT 1 FROM claim_identities WHERE id = ?`)
        .get(id);
      if (!exists) throw new ClaimRelationError(`Unknown Claim identity ${id}`);
    }
    const duplicate = this.db
      .prepare(
        `SELECT id FROM claim_relations
         WHERE status = 'active' AND source_claim_identity_id = ?
           AND target_claim_identity_id = ? AND relation = ?`,
      )
      .get(
        input.sourceClaimIdentityId,
        input.targetClaimIdentityId,
        input.relation,
      ) as { id: string } | undefined;
    if (duplicate) {
      throw new ClaimRelationError(
        `The ${input.relation} relation already exists as ${duplicate.id}`,
      );
    }
    if (
      REALIZATION_KINDS.includes(input.relation) &&
      this.realizationReaches(
        input.targetClaimIdentityId,
        input.sourceClaimIdentityId,
      )
    ) {
      throw new ClaimRelationError(
        "This relation would create a realization cycle; realization must be acyclic",
      );
    }
    const createdAt = input.createdAt ?? Date.now();
    // Retiring and re-adding the same edge must not reuse the id of the retired row.
    const id = `relation:${fingerprint({
      source: input.sourceClaimIdentityId,
      target: input.targetClaimIdentityId,
      relation: input.relation,
      createdAt,
    }).slice(0, 24)}`;
    this.db
      .prepare(
        `INSERT INTO claim_relations (
           id, source_claim_identity_id, target_claim_identity_id, relation, status,
           actor, rationale, created_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceClaimIdentityId,
        input.targetClaimIdentityId,
        input.relation,
        input.actor,
        input.rationale ?? null,
        createdAt,
      );
    return this.get(id)!;
  }

  /** Retire an active relation. The row stays as history. */
  retire(id: string, retiredAt: number = Date.now()): ClaimRelation {
    const current = this.get(id);
    if (!current) throw new ClaimRelationError(`Unknown relation ${id}`);
    if (current.status !== "active") {
      throw new ClaimRelationError(`Relation ${id} is already retired`);
    }
    this.db
      .prepare(
        `UPDATE claim_relations SET status = 'retired', retired_at = ? WHERE id = ?`,
      )
      .run(retiredAt, id);
    return this.get(id)!;
  }

  /** Import a relation from portable state. Existing ids are kept, not rewritten. */
  importRelation(input: {
    id: string;
    sourceClaimIdentityId: string;
    targetClaimIdentityId: string;
    relation: ClaimRelationKind;
    status: "active" | "retired";
    actor: string;
    rationale?: string;
    createdAt: number;
    retiredAt?: number;
  }): "imported" | "present" | "unknown_claim" {
    if (this.get(input.id)) return "present";
    for (const id of [
      input.sourceClaimIdentityId,
      input.targetClaimIdentityId,
    ]) {
      if (
        !this.db.prepare(`SELECT 1 FROM claim_identities WHERE id = ?`).get(id)
      ) {
        return "unknown_claim";
      }
    }
    this.db
      .prepare(
        `INSERT INTO claim_relations (
           id, source_claim_identity_id, target_claim_identity_id, relation, status,
           actor, rationale, created_at, retired_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sourceClaimIdentityId,
        input.targetClaimIdentityId,
        input.relation,
        input.status,
        input.actor,
        input.rationale ?? null,
        input.createdAt,
        input.retiredAt ?? null,
      );
    return "imported";
  }

  /** True when `to` can be reached from `from` by following realization edges. */
  private realizationReaches(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    const outgoing = this.db.prepare(
      `SELECT target_claim_identity_id AS target FROM claim_relations
       WHERE status = 'active' AND source_claim_identity_id = ?
         AND relation IN ('realizes', 'refines')`,
    );
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === to) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const row of outgoing.all(node) as Array<{ target: string }>) {
        stack.push(row.target);
      }
    }
    return false;
  }
}
