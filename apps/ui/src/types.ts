// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the Insight Canvas frontend.
 * Mirrors the server-side InsightResponse shape.
 */

export type VizType =
  | "decision-tree"
  | "impact-graph"
  | "knowledge-graph"
  | "kwg"
  | "kwg-plus"
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
  | "risk"
  | "center"
  | "affected"
  // KWG+ / TCG overlay kinds
  | "file"
  | "commit"
  | "author"
  | "drift"
  // SCG (Static Code Graph) layer kinds
  | "directory"
  | "symbol";

export interface InsightNode {
  id: string;
  label: string;
  kind: NodeKind;
  description?: string;
  confidence?: number;
  aliases?: string[];
  sourceDoc?: string;
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
  /** Hop distance from center (impact graph: 0 = center, 1 = direct, 2+ = ripple). */
  depth?: number;
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

export interface DecisionTreeData {
  nodes: InsightNode[];
  edges: InsightEdge[];
  rootId: string;
}

export interface ImpactGraphData {
  nodes: InsightNode[];
  edges: InsightEdge[];
  centerId: string;
  maxDepth: number;
  summary: ImpactSummary;
}

export interface KnowledgeGraphData {
  nodes: InsightNode[];
  edges: InsightEdge[];
  totalEntities: number;
  totalRelationships: number;
}

export type ImpactSeverity = "critical" | "warning" | "info";

export interface ImpactChain {
  path: string;
  severity: ImpactSeverity;
  predicate: string;
  entities: string[];
}

export interface ImpactSummary {
  headline: string;
  stats: {
    directCount: number;
    rippleCount: number;
    riskCount: number;
    decisionCount: number;
    totalRelationships: number;
  };
  riskChains: ImpactChain[];
  decisionChains: ImpactChain[];
  dependencyChains: ImpactChain[];
  contextLines: string[];
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
  data: DecisionTreeData | ImpactGraphData | KnowledgeGraphData;
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
  center: "#ec4899",
  affected: "#a78bfa",
  // KWG+ / TCG overlay kinds
  file: "#38bdf8",     // sky-400 — file nodes
  commit: "#a78bfa",   // violet-400 — git commits
  author: "#fb923c",   // orange-400 — git authors
  drift: "#f43f5e",    // rose-500 — drift signals
  // SCG layer kinds
  directory: "#6b7280", // gray-500 — directories
  symbol: "#22d3ee",    // cyan-400 — code symbols
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
  center: "Center",
  affected: "Affected",
  // KWG+ / TCG overlay kinds
  file: "File",
  commit: "Commit",
  author: "Author",
  drift: "Drift Signal",
  // SCG layer kinds
  directory: "Directory",
  symbol: "Symbol",
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
  // SCG predicates
  SCG_CONTAINS: "contains",
  SAME_FILE: "same file",
  // Cross-layer predicates
  GROUNDED_IN: "grounded in",
  DRIFTED: "drifted from",
  DRIFTED_FILE: "drift in file",
};

/** Edge stroke colors by predicate severity. */
export const EDGE_SEVERITY_COLORS: Record<ImpactSeverity, string> = {
  critical: "#ef4444", // red-500
  warning: "#f59e0b",  // amber-500
  info: "#64748b",     // slate-500
};

/** Map predicates to their severity level. */
export function predicateSeverity(pred: string): ImpactSeverity {
  if (pred === "RISKS" || pred === "BLOCKS") return "critical";
  if (
    pred === "DEPENDS_ON" ||
    pred === "DECIDED_AGAINST" ||
    pred === "REQUIRES"
  )
    return "warning";
  return "info";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lineage (entity provenance chain)
// ═══════════════════════════════════════════════════════════════════════════════

/** A raw triple from the KG, with provenance back to source document. */
export interface LineageTriple {
  subject: string;
  predicate: string;
  object: string;
  role: "subject" | "object";
  confidence: number | null;
  rationale: string | null;
  subjectKind: string | null;
  objectKind: string | null;
  sourceFile: string | null;
  artifactId: string | null;
  runId: string | null;
}

/** A unique source document contributing knowledge about an entity. */
export interface LineageSource {
  sourceFile: string;
  artifactId: string;
  tripleCount: number;
  predicates: string[];
}

/** A canonical relationship with raw predicate provenance. */
export interface LineageRelation {
  direction: "outgoing" | "incoming";
  predicate: string;
  rawPredicate: string | null;
  otherName: string;
  otherCanonId: string;
  otherType: string | null;
  artifactId: string | null;
  confidence: number | null;
}

/** Full lineage response for a single entity. */
export interface LineageResponse {
  canonId: string;
  name: string;
  type: string;
  sessionId: string;
  triples: LineageTriple[];
  sources: LineageSource[];
  canonRelations: LineageRelation[];
  queryTimeMs: number;
}
