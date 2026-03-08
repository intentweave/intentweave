// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * IntentWeave Visualization Module
 *
 * Generates deterministic Mermaid diagrams from findings/entities/statements.
 * No LLM calls - purely structural transformation.
 */

export {
  generateIssueLens,
  generateEntityLens,
  generateAllIssueLenses,
  findingToIssue,
  type IssueLensOptions,
  type IssueLensResult,
  type EntityLensResult,
} from "./lenses.js";
export {
  renderMermaid,
  renderSimpleERD,
  type MermaidOptions,
  type MermaidGraph,
} from "./mermaid.js";
export {
  buildSubgraph,
  toMermaidId,
  extractLabel,
  getPredicateLabel,
  type SubgraphOptions,
  type Subgraph,
} from "./subgraph.js";
export {
  renderAscii,
  renderDualOutput,
  type AsciiRenderOptions,
  type AsciiRenderResult,
} from "./ascii.js";
export {
  type VizFinding,
  type VizEntity,
  type VizStatement,
  type VizIssue,
  type VizNode,
  type VizEdge,
  type VizEvidence,
} from "./types.js";
