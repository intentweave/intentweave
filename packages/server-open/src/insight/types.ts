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
  | "risk"
  | "center"
  | "affected";

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
  /** Hop distance from the center node (0 = center, 1 = direct, 2+ = ripple). */
  depth?: number;
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
// Impact graph data
// ═══════════════════════════════════════════════════════════════════════════════

/** A relationship chain showing a path of impact. */
export interface ImpactChain {
  /** Human-readable path description (e.g. "Auth → DEPENDS_ON → JWT → RISKS → Expiry"). */
  path: string;
  /** Severity: critical (RISKS/BLOCKS), warning (DEPENDS_ON/DECIDED_AGAINST), info (other). */
  severity: "critical" | "warning" | "info";
  /** The predicate that determines severity (the most severe in the chain). */
  predicate: string;
  /** Entity names along the chain. */
  entities: string[];
}

/** Structured impact summary for RAG consumption and human interpretation. */
export interface ImpactSummary {
  /** One-sentence overview: "Changing X directly affects N entities and ripples to M more." */
  headline: string;
  /** Breakdown counts by category. */
  stats: {
    directCount: number;
    rippleCount: number;
    riskCount: number;
    decisionCount: number;
    totalRelationships: number;
  };
  /** Risk chains (RISKS / BLOCKS relationships). */
  riskChains: ImpactChain[];
  /** Decision chains (DECIDED_FOR / DECIDED_AGAINST). */
  decisionChains: ImpactChain[];
  /** Dependency chains (DEPENDS_ON / ENABLES / CONTAINS). */
  dependencyChains: ImpactChain[];
  /** Plain-text context list suitable for RAG / agent consumption. */
  contextLines: string[];
}

export interface ImpactGraphData {
  nodes: InsightNode[];
  edges: InsightEdge[];
  /** The center entity from which impact radiates outward. */
  centerId: string;
  /** Maximum hop distance reached during expansion. */
  maxDepth: number;
  /** Structured impact summary with stats, chains, and RAG context. */
  summary: ImpactSummary;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Response envelope
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsightResponse {
  vizType: VizType;
  title: string;
  data: DecisionTreeData | ImpactGraphData;
  meta: {
    session: string;
    entityCount: number;
    edgeCount: number;
    queryTimeMs: number;
  };
}
