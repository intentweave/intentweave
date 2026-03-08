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
