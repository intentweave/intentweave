// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the Insight Canvas frontend.
 * Mirrors the server-side InsightResponse shape.
 */

export type VizType =
  | "decision-tree"
  | "impact-graph"
  | "architecture"
  | "heatmap";

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
}

export interface InsightEdge {
  source: string;
  target: string;
  label: string;
}

export interface DecisionTreeData {
  nodes: InsightNode[];
  edges: InsightEdge[];
  rootId: string;
}

export interface InsightMeta {
  session: string;
  entityCount: number;
  edgeCount: number;
  queryTimeMs: number;
}

export interface InsightResponse {
  vizType: VizType;
  title: string;
  data: DecisionTreeData;
  meta: InsightMeta;
}

/** Colors for each node kind (matches CSS theme tokens). */
export const NODE_COLORS: Record<NodeKind, string> = {
  topic: "#3b82f6",
  decision: "#8b5cf6",
  chosen: "#10b981",
  rejected: "#ef4444",
  option: "#6b7280",
  concept: "#06b6d4",
  rationale: "#f59e0b",
  risk: "#f97316",
};

/** Human-readable labels for node kinds. */
export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  topic: "Topic",
  decision: "Decision",
  chosen: "Chosen",
  rejected: "Rejected",
  option: "Option",
  concept: "Concept",
  rationale: "Rationale",
  risk: "Risk",
};

/** Human-readable predicate labels. */
export const PREDICATE_LABELS: Record<string, string> = {
  DECIDED_FOR: "decided for",
  DECIDED_AGAINST: "decided against",
  ALTERNATIVE_TO: "alternative to",
  MOTIVATED_BY: "motivated by",
  SUPERSEDES: "supersedes",
  ENABLES: "enables",
  BLOCKS: "blocks",
  RISKS: "risks",
  DEPENDS_ON: "depends on",
  CONTAINS: "contains",
  RELATED_TO: "related to",
};
