/**
 * Visualization types
 */

/**
 * Entity for visualization (simplified from full Entity)
 */
export interface VizEntity {
  id: string;           // cgId
  type: string;         // state, action, role, resource, transition, etc.
  label: string;        // human-readable label
  artifact?: string;    // source artifact id
  artifactPath?: string; // source artifact path
  props?: Record<string, unknown>;
}

/**
 * Statement/edge for visualization
 */
export interface VizStatement {
  id?: string;
  subject: string;      // subject entity id
  predicate: string;    // edge type
  object: string;       // object entity id
  confidence?: number;
  artifact?: string;    // source artifact id
}

/**
 * Finding for visualization
 */
export interface VizFinding {
  id: string;           // rule id (e.g., "completeness-010")
  severity: 'info' | 'warning' | 'error';
  category: string;     // semantic, completeness, consistency, etc.
  message: string;
  entities: string[];   // referenced entity cgIds
}

/**
 * Issue from report (aggregated findings)
 */
export interface VizIssue {
  key: string;          // e.g., "workspace:taskmanager#O-8"
  kind: 'contradiction' | 'open_end' | 'needs_review' | 'error';
  severity: 'info' | 'warning' | 'blocker';
  title: string;
  confidence: number;
  fingerprint: string;
  evidence: VizEvidence[];
  entities: string[];   // all entity cgIds from evidence
}

/**
 * Evidence item
 */
export interface VizEvidence {
  sourceKey: string;
  text?: string;
  entityId?: string;
}

/**
 * Node in visualization graph
 */
export interface VizNode {
  id: string;           // mermaid-safe id
  entityId: string;     // original cgId
  label: string;
  type: string;
  isDangling?: boolean;
  isGhost?: boolean;
  isFocal?: boolean;    // central node(s) of the visualization
}

/**
 * Edge in visualization graph
 */
export interface VizEdge {
  source: string;       // mermaid node id
  target: string;       // mermaid node id
  label: string;        // shortened predicate
  predicate: string;    // original predicate
  isGhost?: boolean;    // ghost edge for missing relationships
  isDashed?: boolean;
}
