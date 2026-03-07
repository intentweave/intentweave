// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Mermaid diagram renderer
 * 
 * Converts subgraph to Mermaid flowchart syntax.
 */

import type { Subgraph } from './subgraph.js';
import type { VizNode, VizEdge } from './types.js';

export interface MermaidOptions {
  /** Flowchart direction (default: LR) */
  direction?: 'LR' | 'TB' | 'RL' | 'BT';
  /** Include style definitions */
  includeStyles?: boolean;
  /** Title for the diagram */
  title?: string;
  /** Wrap in markdown code block */
  wrapInCodeBlock?: boolean;
}

export interface MermaidGraph {
  /** Raw mermaid syntax */
  mermaid: string;
  /** Wrapped in markdown code block */
  markdown: string;
  /** Node count */
  nodeCount: number;
  /** Edge count */
  edgeCount: number;
}

/**
 * Style definitions for different entity types
 */
const TYPE_STYLES: Record<string, string> = {
  state: 'fill:#e8f0fe,stroke:#1a73e8,stroke-width:1px',
  action: 'fill:#e6f4ea,stroke:#137333,stroke-width:1px',
  role: 'fill:#fef7e0,stroke:#b26a00,stroke-width:1px',
  resource: 'fill:#fce8e6,stroke:#c5221f,stroke-width:1px',
  transition: 'fill:#f3e8fd,stroke:#7c3aed,stroke-width:1px',
  event: 'fill:#e0f2fe,stroke:#0284c7,stroke-width:1px',
  rule: 'fill:#fef3c7,stroke:#d97706,stroke-width:1px',
  constraint: 'fill:#fee2e2,stroke:#dc2626,stroke-width:1px',
  concept: 'fill:#f3f4f6,stroke:#6b7280,stroke-width:1px',
};

const SPECIAL_STYLES = {
  dangling: 'stroke:#d93025,stroke-width:3px,stroke-dasharray:5 3',
  ghost: 'fill:#f9fafb,stroke:#9ca3af,stroke-dasharray:3 3,opacity:0.7',
  focal: 'stroke-width:3px',
};

/**
 * Escape label for Mermaid (handle special chars)
 */
function escapeLabel(label: string): string {
  return label
    .replace(/"/g, "'")
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
}

/**
 * Get node shape based on type
 */
function getNodeShape(node: VizNode): { open: string; close: string } {
  switch (node.type) {
    case 'state':
      return { open: '([', close: '])' };  // Stadium shape
    case 'action':
      return { open: '{{', close: '}}' };  // Hexagon
    case 'transition':
      return { open: '[[', close: ']]' };  // Subroutine
    case 'role':
      return { open: '((', close: '))' };  // Circle
    case 'event':
      return { open: '>', close: ']' };    // Flag
    case 'resource':
      return { open: '[(', close: ')]' };  // Cylinder
    default:
      return { open: '[', close: ']' };    // Rectangle
  }
}

/**
 * Render subgraph as Mermaid flowchart
 */
export function renderMermaid(
  subgraph: Subgraph,
  options: MermaidOptions = {}
): MermaidGraph {
  const {
    direction = 'LR',
    includeStyles = true,
    title,
    wrapInCodeBlock = false,
  } = options;

  const lines: string[] = [];
  
  // Header
  if (title) {
    lines.push(`---`);
    lines.push(`title: ${title}`);
    lines.push(`---`);
  }
  lines.push(`flowchart ${direction}`);
  lines.push('');

  // Style definitions
  if (includeStyles) {
    lines.push('  %% Style definitions');
    for (const [type, style] of Object.entries(TYPE_STYLES)) {
      lines.push(`  classDef ${type} ${style}`);
    }
    lines.push(`  classDef dangling ${SPECIAL_STYLES.dangling}`);
    lines.push(`  classDef ghost ${SPECIAL_STYLES.ghost}`);
    lines.push(`  classDef focal ${SPECIAL_STYLES.focal}`);
    lines.push('');
  }

  // Group nodes by type for organization
  const nodesByType = new Map<string, VizNode[]>();
  for (const node of subgraph.nodes) {
    const type = node.type;
    if (!nodesByType.has(type)) nodesByType.set(type, []);
    nodesByType.get(type)!.push(node);
  }

  // Render nodes grouped by type
  for (const [type, nodes] of nodesByType) {
    lines.push(`  %% ${type}s`);
    for (const node of nodes) {
      const shape = getNodeShape(node);
      const label = escapeLabel(node.label);
      lines.push(`  ${node.id}${shape.open}"${label}"${shape.close}`);
    }
    lines.push('');
  }

  // Render edges
  if (subgraph.edges.length > 0) {
    lines.push('  %% Edges');
    for (const edge of subgraph.edges) {
      const arrow = edge.isDashed ? '-.->' : '-->';
      if (edge.label && edge.label !== '→') {
        lines.push(`  ${edge.source} ${arrow}|${edge.label}| ${edge.target}`);
      } else {
        lines.push(`  ${edge.source} ${arrow} ${edge.target}`);
      }
    }
    lines.push('');
  }

  // Apply classes
  if (includeStyles) {
    lines.push('  %% Apply styles');
    
    // Type-based classes
    for (const [type, nodes] of nodesByType) {
      if (nodes.length > 0) {
        const ids = nodes.map(n => n.id).join(',');
        lines.push(`  class ${ids} ${type}`);
      }
    }
    
    // Dangling nodes
    const danglingNodes = subgraph.nodes.filter(n => n.isDangling);
    if (danglingNodes.length > 0) {
      const ids = danglingNodes.map(n => n.id).join(',');
      lines.push(`  class ${ids} dangling`);
    }
    
    // Ghost nodes
    const ghostNodes = subgraph.nodes.filter(n => n.isGhost);
    if (ghostNodes.length > 0) {
      const ids = ghostNodes.map(n => n.id).join(',');
      lines.push(`  class ${ids} ghost`);
    }
    
    // Focal nodes
    const focalNodes = subgraph.nodes.filter(n => n.isFocal);
    if (focalNodes.length > 0) {
      const ids = focalNodes.map(n => n.id).join(',');
      lines.push(`  class ${ids} focal`);
    }
  }

  const mermaid = lines.join('\n');
  const markdown = wrapInCodeBlock 
    ? '```mermaid\n' + mermaid + '\n```'
    : mermaid;

  return {
    mermaid,
    markdown,
    nodeCount: subgraph.nodes.length,
    edgeCount: subgraph.edges.length,
  };
}

/**
 * Render a simple entity relationship diagram
 */
export function renderSimpleERD(
  entities: { id: string; type: string; label: string }[],
  relationships: { from: string; to: string; label: string }[],
  options: MermaidOptions = {}
): MermaidGraph {
  const lines: string[] = [];
  const direction = options.direction || 'LR';
  
  lines.push(`flowchart ${direction}`);
  
  for (const entity of entities) {
    const shape = getNodeShape({ ...entity, entityId: entity.id } as VizNode);
    lines.push(`  ${entity.id}${shape.open}"${escapeLabel(entity.label)}"${shape.close}`);
  }
  
  for (const rel of relationships) {
    lines.push(`  ${rel.from} -->|${rel.label}| ${rel.to}`);
  }

  const mermaid = lines.join('\n');
  return {
    mermaid,
    markdown: '```mermaid\n' + mermaid + '\n```',
    nodeCount: entities.length,
    edgeCount: relationships.length,
  };
}
