// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Description synthesis — builds human-readable entity descriptions
 * from raw triples and connections already attached to InsightNodes.
 *
 * This runs **after** raw triples and connections are fetched from Neo4j,
 * so it adds zero additional queries.
 */

import type { InsightNode, InsightRawTriple, InsightConnection } from "./types.js";

// ── Predicate priority for description building ──────────────────────────────

/** Predicates that directly describe what an entity *is*. */
const IDENTITY_PREDICATES = new Set([
  "IS_A",
  "DESCRIBES",
  "HAS_PROPERTY",
  "IMPLEMENTS",
  "EXTENDS",
]);

/** Predicates that convey behavioral / state info. */
const BEHAVIORAL_PREDICATES = new Set([
  "HAS_STATE",
  "TRANSITIONS_TO",
  "TRIGGERS",
  "ENABLES",
  "BLOCKS",
  "RISKS",
  "REQUIRES",
]);

/** Predicates that describe structural containment / dependency. */
const STRUCTURAL_PREDICATES = new Set([
  "CONTAINS",
  "DEPENDS_ON",
  "USES",
  "CALLS",
  "PRODUCES",
  "CONSUMES",
]);

/** All design-decision predicates. */
const DECISION_PREDICATES = new Set([
  "DECIDED_FOR",
  "DECIDED_AGAINST",
  "SUPERSEDES",
  "MOTIVATED_BY",
  "ALTERNATIVE_TO",
  "PROPOSED_FOR",
  "REPLACES",
]);

// ── Human-readable predicate phrases ─────────────────────────────────────────

const PREDICATE_PHRASES: Record<string, string> = {
  IS_A: "is a",
  DESCRIBES: "is described as",
  HAS_PROPERTY: "has property",
  IMPLEMENTS: "implements",
  EXTENDS: "extends",
  CONTAINS: "contains",
  DEPENDS_ON: "depends on",
  USES: "uses",
  CALLS: "calls",
  PRODUCES: "produces",
  CONSUMES: "consumes",
  ENABLES: "enables",
  BLOCKS: "blocks",
  RISKS: "risks",
  REQUIRES: "requires",
  DECIDED_FOR: "was decided for",
  DECIDED_AGAINST: "was decided against",
  SUPERSEDES: "supersedes",
  MOTIVATED_BY: "is motivated by",
  ALTERNATIVE_TO: "is an alternative to",
  PROPOSED_FOR: "was proposed for",
  REPLACES: "replaces",
  TRIGGERS: "triggers",
  TRANSITIONS_TO: "transitions to",
  HAS_STATE: "has state",
  HAS_PHASE: "has phase",
  PRECEDES: "precedes",
  FOLLOWS: "follows",
  DEFERRED_TO: "is deferred to",
  RELATED_TO: "is related to",
};

/**
 * Build a human-readable phrase for a predicate.
 * Falls back to lowercased + space-separated form.
 */
function humanPredicate(pred: string): string {
  return PREDICATE_PHRASES[pred] ?? pred.toLowerCase().replace(/_/g, " ");
}

// ── Description synthesis ────────────────────────────────────────────────────

/**
 * Synthesize a description for an InsightNode from its raw triples.
 *
 * Strategy:
 * 1. Pick the best "identity" triple (IS_A, DESCRIBES, HAS_PROPERTY) where
 *    the entity is the subject → use the object as the core description.
 * 2. Add key relationship facts (up to 3 additional sentences).
 * 3. Cap at ~200 chars for readability.
 */
export function synthesizeDescription(node: InsightNode): string {
  const triples = node.rawTriples ?? [];
  const label = node.label.toLowerCase();

  // Separate triples where this entity is the subject vs. object.
  const asSubject: InsightRawTriple[] = [];
  const asObject: InsightRawTriple[] = [];
  for (const t of triples) {
    if (t.subject.toLowerCase() === label) {
      asSubject.push(t);
    } else if (t.object.toLowerCase() === label) {
      asObject.push(t);
    }
  }

  const parts: string[] = [];

  // 1. Core identity — what IS this entity?
  const identityTriple =
    asSubject.find((t) => IDENTITY_PREDICATES.has(t.predicate)) ??
    asObject.find(
      (t) => t.predicate === "DESCRIBES" || t.predicate === "CONTAINS",
    );

  if (identityTriple) {
    if (identityTriple.subject.toLowerCase() === label) {
      parts.push(
        `${node.label} ${humanPredicate(identityTriple.predicate)} ${identityTriple.object}.`,
      );
    } else {
      parts.push(
        `${identityTriple.subject} ${humanPredicate(identityTriple.predicate)} ${node.label}.`,
      );
    }
  } else if (node.entityType) {
    // Fallback: use the KG entity type
    parts.push(`${node.label} is a ${node.entityType}.`);
  }

  // 2. Key facts — behavioral or structural relationships (up to 3)
  const usedPredicates = new Set<string>(
    identityTriple ? [identityTriple.predicate] : [],
  );
  let factCount = 0;
  const MAX_FACTS = 3;

  for (const t of asSubject) {
    if (factCount >= MAX_FACTS) break;
    if (usedPredicates.has(t.predicate) && !BEHAVIORAL_PREDICATES.has(t.predicate))
      continue;
    if (IDENTITY_PREDICATES.has(t.predicate)) continue; // already handled
    usedPredicates.add(t.predicate);
    parts.push(
      `${capitalize(humanPredicate(t.predicate))} ${t.object}.`,
    );
    factCount++;
  }

  // If we still have room, add facts where entity is the object.
  for (const t of asObject) {
    if (factCount >= MAX_FACTS) break;
    if (usedPredicates.has(t.predicate)) continue;
    usedPredicates.add(t.predicate);
    parts.push(`${t.subject} ${humanPredicate(t.predicate)} ${node.label}.`);
    factCount++;
  }

  return parts.join(" ") || "";
}

/**
 * Build a compact relationship summary string from connections.
 * Groups connections by predicate and lists target labels.
 *
 * Example: "depends on: React, TypeScript | enables: Fast Builds"
 */
export function summarizeConnections(connections: InsightConnection[]): string {
  if (!connections || connections.length === 0) return "";

  // Group by predicate + direction
  const groups = new Map<string, string[]>();
  for (const conn of connections) {
    const arrow = conn.direction === "outgoing" ? "→" : "←";
    const key = `${arrow} ${humanPredicate(conn.predicate)}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    if (list.length < 4) {
      list.push(conn.targetLabel);
    }
  }

  const parts: string[] = [];
  for (const [key, targets] of groups) {
    const overflow =
      connections.filter(
        (c) =>
          `${c.direction === "outgoing" ? "→" : "←"} ${humanPredicate(c.predicate)}` === key,
      ).length - targets.length;
    const suffix = overflow > 0 ? `, +${overflow} more` : "";
    parts.push(`${key}: ${targets.join(", ")}${suffix}`);
  }

  return parts.join(" | ");
}

/**
 * Enrich all nodes in a collection with synthesized descriptions.
 * Only sets `description` if the node doesn't already have one
 * (preserves manually set descriptions like "Impact center — technology").
 */
export function enrichNodeDescriptions(nodes: Iterable<InsightNode>): void {
  for (const node of nodes) {
    if (!node.description) {
      const desc = synthesizeDescription(node);
      if (desc) node.description = desc;
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
