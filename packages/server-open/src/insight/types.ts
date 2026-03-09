// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Insight Canvas — shared types for dynamically generated visualizations.
 *
 * The insight system queries the knowledge graph and structures the results
 * into purpose-built visualization formats. The LLM picks (or the user
 * specifies) the visualization type; the frontend renders the matching
 * component.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Visualization types (extensible — add new types here)
// ═══════════════════════════════════════════════════════════════════════════════

export type VizType =
  | "decision-tree"
  | "impact-graph"
  | "architecture"
  | "heatmap";

// ═══════════════════════════════════════════════════════════════════════════════
// Node & edge primitives
// ═══════════════════════════════════════════════════════════════════════════════

export type NodeKind =
  | "topic"
  | "decision"
  | "chosen"
  | "rejected"
  | "option"
  | "concept"
  | "rationale"
  | "risk";

export interface InsightNode {
  id: string;
  label: string;
  kind: NodeKind;
  description?: string;
  confidence?: number;
  /** Alternate surface forms from the KG. */
  aliases?: string[];
  /** Source document / artifact this entity was extracted from. */
  sourceDoc?: string;
  /** Run ID — used for temporal ordering (later runs = more recent thinking). */
  runId?: string;
  /** 1-based temporal sequence among decisions (1 = earliest run). */
  temporalOrder?: number;
  /** Raw KG entity type (e.g. 'decision', 'option', 'technology'). */
  entityType?: string;
  /** ISO timestamp when the entity was first persisted. */
  createdAt?: string;
  /** ISO timestamp when the entity was last updated. */
  updatedAt?: string;
  /** Raw triples (subject → predicate → object) mentioning this entity. */
  rawTriples?: InsightRawTriple[];
  /** Connections to other nodes (populated for detail panel). */
  connections?: InsightConnection[];
}

export interface InsightRawTriple {
  subject: string;
  predicate: string;
  object: string;
}

export interface InsightConnection {
  targetId: string;
  targetLabel: string;
  predicate: string;
  direction: "outgoing" | "incoming";
}

export interface InsightEdge {
  source: string;
  target: string;
  label: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Decision tree data
// ═══════════════════════════════════════════════════════════════════════════════

export interface DecisionTreeData {
  nodes: InsightNode[];
  edges: InsightEdge[];
  rootId: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Response envelope
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsightResponse {
  vizType: VizType;
  title: string;
  data: DecisionTreeData; // union with other data types later
  meta: {
    session: string;
    entityCount: number;
    edgeCount: number;
    queryTimeMs: number;
  };
}
