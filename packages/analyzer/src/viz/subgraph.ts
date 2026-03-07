/**
 * Subgraph extraction from entities and statements
 * 
 * Builds a focused subgraph around seed entities with configurable depth.
 */

import { createHash } from 'crypto';
import type { VizEntity, VizStatement, VizNode, VizEdge } from './types.js';

export interface SubgraphOptions {
  /** How many hops from seed entities (default: 1) */
  depth?: number;
  /** Maximum nodes to include (default: 40) */
  maxNodes?: number;
  /** Include ghost edges for missing relationships */
  includeGhostEdges?: boolean;
  /** Issue context for heuristic ghost edges */
  issueKind?: 'contradiction' | 'open_end' | 'needs_review' | 'error';
  issueTitle?: string;
}

export interface Subgraph {
  nodes: VizNode[];
  edges: VizEdge[];
  focalEntityIds: string[];
  danglingNodeIds: string[];
  stats: {
    totalEntities: number;
    totalStatements: number;
    includedNodes: number;
    includedEdges: number;
    ghostEdges: number;
  };
}

/**
 * Predicate to short label mapping
 */
const PREDICATE_LABELS: Record<string, string> = {
  'TRANSITIONS_TO': '→',
  'FROM_STATE': 'from',
  'TO_STATE': 'to',
  'TRIGGERS': 'triggers',
  'TRIGGERED_BY': 'triggered by',
  'HAS_STATE': 'has state',
  'HAS_STATUS_VALUE': 'status',
  'HAS_PRIORITY_VALUE': 'priority',
  'AUTHORIZED_FOR': 'auth',
  'CAN_PERFORM': 'can',
  'PERFORMS': 'performs',
  'HAS_ROLE': 'role',
  'BELONGS_TO': 'belongs to',
  'CONTAINS': 'contains',
  'REFERENCES': 'refs',
  'DEPENDS_ON': 'depends',
  'RELATED_TO': 'related',
  'DEFINES': 'defines',
  'IMPLEMENTS': 'implements',
  'SATISFIES': 'satisfies',
};

/**
 * Generate a mermaid-safe node ID from entity cgId
 */
export function toMermaidId(cgId: string): string {
  const hash = createHash('md5').update(cgId).digest('hex').slice(0, 8);
  return `n_${hash}`;
}

/**
 * Extract human-readable label from cgId
 */
export function extractLabel(cgId: string, entity?: VizEntity): string {
  if (entity?.label) return entity.label;
  
  // Extract last segment: "ws_0000|model|kg|state/Done" -> "Done"
  const parts = cgId.split('|');
  const lastPart = parts[parts.length - 1];
  
  // Handle type/name format: "state/Done" -> "Done"
  if (lastPart.includes('/')) {
    const namePart = lastPart.split('/').pop() || lastPart;
    // Clean up common prefixes
    return namePart
      .replace(/^state-/, '')
      .replace(/^action-/, '')
      .replace(/^transition-/, '')
      .replace(/->/g, ' → ')
      .replace(/__/g, ': ')
      .replace(/@/g, ' @');
  }
  
  return lastPart;
}

/**
 * Get short label for predicate
 */
export function getPredicateLabel(predicate: string): string {
  return PREDICATE_LABELS[predicate] || predicate.toLowerCase().replace(/_/g, ' ');
}

/**
 * Build a subgraph around seed entities
 */
export function buildSubgraph(
  seedEntityIds: string[],
  entities: VizEntity[],
  statements: VizStatement[],
  options: SubgraphOptions = {}
): Subgraph {
  const {
    depth = 1,
    maxNodes = 40,
    includeGhostEdges = true,
    issueKind,
    issueTitle,
  } = options;

  // Build lookup maps
  const entityMap = new Map(entities.map(e => [e.id, e]));
  
  // Find neighbors via statements
  const outEdges = new Map<string, VizStatement[]>();
  const inEdges = new Map<string, VizStatement[]>();
  
  for (const stmt of statements) {
    if (!outEdges.has(stmt.subject)) outEdges.set(stmt.subject, []);
    outEdges.get(stmt.subject)!.push(stmt);
    
    if (!inEdges.has(stmt.object)) inEdges.set(stmt.object, []);
    inEdges.get(stmt.object)!.push(stmt);
  }

  // Expand from seeds
  const includedIds = new Set<string>(seedEntityIds);
  let frontier = new Set<string>(seedEntityIds);

  for (let d = 0; d < depth && includedIds.size < maxNodes; d++) {
    const newFrontier = new Set<string>();
    
    for (const id of frontier) {
      // Add outgoing neighbors
      for (const stmt of outEdges.get(id) || []) {
        if (!includedIds.has(stmt.object) && includedIds.size < maxNodes) {
          includedIds.add(stmt.object);
          newFrontier.add(stmt.object);
        }
      }
      // Add incoming neighbors
      for (const stmt of inEdges.get(id) || []) {
        if (!includedIds.has(stmt.subject) && includedIds.size < maxNodes) {
          includedIds.add(stmt.subject);
          newFrontier.add(stmt.subject);
        }
      }
    }
    
    frontier = newFrontier;
  }

  // Build nodes
  const nodes: VizNode[] = [];
  const nodeIdMap = new Map<string, string>(); // cgId -> mermaid id
  
  for (const cgId of includedIds) {
    const entity = entityMap.get(cgId);
    const mermaidId = toMermaidId(cgId);
    nodeIdMap.set(cgId, mermaidId);
    
    nodes.push({
      id: mermaidId,
      entityId: cgId,
      label: extractLabel(cgId, entity),
      type: entity?.type || inferTypeFromCgId(cgId),
      isFocal: seedEntityIds.includes(cgId),
    });
  }

  // Build edges (only between included nodes)
  const edges: VizEdge[] = [];
  const includedStatements = statements.filter(
    s => includedIds.has(s.subject) && includedIds.has(s.object)
  );
  
  for (const stmt of includedStatements) {
    edges.push({
      source: nodeIdMap.get(stmt.subject)!,
      target: nodeIdMap.get(stmt.object)!,
      label: getPredicateLabel(stmt.predicate),
      predicate: stmt.predicate,
    });
  }

  // Find dangling nodes (no edges in subgraph)
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  }
  
  const danglingNodeIds: string[] = [];
  for (const node of nodes) {
    if (!connectedIds.has(node.id)) {
      node.isDangling = true;
      danglingNodeIds.push(node.entityId);
    }
  }

  // Add ghost edges based on issue context
  let ghostEdgeCount = 0;
  if (includeGhostEdges && issueKind && issueTitle) {
    const ghostEdges = generateGhostEdges(nodes, issueKind, issueTitle, nodeIdMap);
    edges.push(...ghostEdges);
    ghostEdgeCount = ghostEdges.length;
  }

  return {
    nodes,
    edges,
    focalEntityIds: seedEntityIds,
    danglingNodeIds,
    stats: {
      totalEntities: entities.length,
      totalStatements: statements.length,
      includedNodes: nodes.length,
      includedEdges: edges.length - ghostEdgeCount,
      ghostEdges: ghostEdgeCount,
    },
  };
}

/**
 * Infer entity type from cgId pattern
 */
function inferTypeFromCgId(cgId: string): string {
  const lower = cgId.toLowerCase();
  if (lower.includes('/state/') || lower.includes('|state/')) return 'state';
  if (lower.includes('/action/') || lower.includes('|action/')) return 'action';
  if (lower.includes('/role/') || lower.includes('|role/')) return 'role';
  if (lower.includes('/resource/') || lower.includes('|resource/')) return 'resource';
  if (lower.includes('/transition/') || lower.includes('|transition/')) return 'transition';
  if (lower.includes('/event/') || lower.includes('|event/')) return 'event';
  if (lower.includes('/rule/') || lower.includes('|rule/')) return 'rule';
  if (lower.includes('/constraint/') || lower.includes('|constraint/')) return 'constraint';
  return 'concept';
}

/**
 * Generate ghost edges based on issue heuristics
 */
function generateGhostEdges(
  nodes: VizNode[],
  issueKind: string,
  issueTitle: string,
  nodeIdMap: Map<string, string>
): VizEdge[] {
  const ghostEdges: VizEdge[] = [];
  const titleLower = issueTitle.toLowerCase();

  // "not authorized" → add ghost edge to role
  if (titleLower.includes('not authorized')) {
    const actionNodes = nodes.filter(n => n.type === 'action');
    for (const action of actionNodes) {
      // Check if there's already an auth edge
      const hasAuth = nodes.some(n => n.type === 'role');
      if (!hasAuth) {
        // Add ghost role node and edge
        const ghostRoleId = 'ghost_role';
        nodes.push({
          id: ghostRoleId,
          entityId: 'ghost:missing-role',
          label: '?',
          type: 'role',
          isGhost: true,
        });
        ghostEdges.push({
          source: action.id,
          target: ghostRoleId,
          label: 'missing auth',
          predicate: 'AUTHORIZED_FOR',
          isGhost: true,
          isDashed: true,
        });
      }
    }
  }

  // "missing a source state" → add ghost source
  if (titleLower.includes('missing a source state') || titleLower.includes('missing source')) {
    const transitionNodes = nodes.filter(n => n.type === 'transition');
    for (const transition of transitionNodes) {
      const ghostSourceId = `ghost_source_${transition.id}`;
      nodes.push({
        id: ghostSourceId,
        entityId: `ghost:missing-source-for-${transition.entityId}`,
        label: '?',
        type: 'state',
        isGhost: true,
      });
      ghostEdges.push({
        source: ghostSourceId,
        target: transition.id,
        label: 'from?',
        predicate: 'FROM_STATE',
        isGhost: true,
        isDashed: true,
      });
    }
  }

  // "missing a target state" → add ghost target
  if (titleLower.includes('missing a target state') || titleLower.includes('missing target')) {
    const transitionNodes = nodes.filter(n => n.type === 'transition');
    for (const transition of transitionNodes) {
      const ghostTargetId = `ghost_target_${transition.id}`;
      nodes.push({
        id: ghostTargetId,
        entityId: `ghost:missing-target-for-${transition.entityId}`,
        label: '?',
        type: 'state',
        isGhost: true,
      });
      ghostEdges.push({
        source: transition.id,
        target: ghostTargetId,
        label: 'to?',
        predicate: 'TO_STATE',
        isGhost: true,
        isDashed: true,
      });
    }
  }

  return ghostEdges;
}
