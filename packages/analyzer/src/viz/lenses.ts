// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Visualization Lenses
 * 
 * High-level functions for generating focused visualizations
 * around issues or entities.
 */

import { buildSubgraph, type SubgraphOptions } from './subgraph.js';
import { renderMermaid, type MermaidOptions, type MermaidGraph } from './mermaid.js';
import type { VizEntity, VizStatement, VizFinding, VizIssue } from './types.js';

export interface IssueLensOptions extends SubgraphOptions, MermaidOptions {
  /** Include description text above diagram */
  includeDescription?: boolean;
}

export interface IssueLensResult {
  /** The issue being visualized */
  issue: VizIssue;
  /** Mermaid diagram output */
  diagram: MermaidGraph;
  /** Human-readable description */
  description: string;
  /** Full markdown output (description + diagram) */
  markdown: string;
}

export interface EntityLensResult {
  /** The focal entity */
  entity: VizEntity;
  /** Mermaid diagram output */
  diagram: MermaidGraph;
  /** Human-readable description */
  description: string;
  /** Full markdown output */
  markdown: string;
}

/**
 * Convert raw finding to VizIssue format
 */
export function findingToIssue(
  finding: VizFinding,
  issueKey: string,
  issueNumber: number
): VizIssue {
  // Map severity
  const severityMap: Record<string, 'info' | 'warning' | 'blocker'> = {
    'info': 'info',
    'warning': 'warning',
    'error': 'blocker',
  };
  
  // Map category to kind
  const kindMap: Record<string, VizIssue['kind']> = {
    'semantic': 'needs_review',
    'completeness': 'open_end',
    'consistency': 'needs_review',
    'validation': 'open_end',
  };
  
  // Generate short key prefix based on category
  const prefixMap: Record<string, string> = {
    'semantic': 'N',
    'completeness': 'O',
    'consistency': 'N',
    'validation': 'O',
    'graph': 'O',
  };
  
  const prefix = prefixMap[finding.category] || 'N';
  const shortKey = `${prefix}-${issueNumber}`;

  return {
    key: issueKey || `workspace:unknown#${shortKey}`,
    kind: kindMap[finding.category] || 'needs_review',
    severity: severityMap[finding.severity] || 'warning',
    title: finding.message,
    confidence: 0.75,
    fingerprint: finding.id,
    evidence: finding.entities.map(e => ({ sourceKey: finding.id, entityId: e })),
    entities: finding.entities,
  };
}

/**
 * Provenance info for description
 */
interface ProvenanceInfo {
  entities: VizEntity[];
  statements: VizStatement[];
}

/**
 * Jump target for source navigation
 */
interface JumpTarget {
  id: string;           // E1, S1, etc.
  label: string;        // human-readable label
  kind: 'entity' | 'statement';
  sourceKey: string;    // iw open compatible key
  artifactPath?: string;
}

/**
 * Generate jump targets for entities and statements
 */
function generateJumpTargets(
  issue: VizIssue,
  provenance: ProvenanceInfo
): JumpTarget[] {
  const targets: JumpTarget[] = [];
  
  // Build entity map
  const entityMap = new Map<string, VizEntity>();
  for (const e of provenance.entities) {
    entityMap.set(e.id, e);
  }
  
  // Add entity targets
  let entityIdx = 1;
  for (const cgId of issue.entities) {
    const entity = entityMap.get(cgId);
    const label = cgId.split('/').pop() || cgId;
    const artifactPath = entity?.artifactPath;
    
    targets.push({
      id: `E${entityIdx}`,
      label,
      kind: 'entity',
      sourceKey: cgId,
      artifactPath,
    });
    entityIdx++;
  }
  
  // Add statement targets
  const entitySet = new Set(issue.entities);
  const relatedStatements = provenance.statements.filter(s => 
    entitySet.has(s.subject) || entitySet.has(s.object)
  );
  
  let stmtIdx = 1;
  for (const s of relatedStatements.slice(0, 20)) { // Limit to 20 statements
    const subLabel = s.subject.split('/').pop() || s.subject;
    const objLabel = s.object.split('/').pop() || s.object;
    const artifactPath = entityMap.get(s.subject)?.artifactPath || entityMap.get(s.object)?.artifactPath;
    
    targets.push({
      id: `S${stmtIdx}`,
      label: `${subLabel} ${s.predicate} ${objLabel}`,
      kind: 'statement',
      sourceKey: s.id || `${s.subject}|${s.predicate}|${s.object}`,
      artifactPath,
    });
    stmtIdx++;
  }
  
  return targets;
}

/**
 * Generate deterministic hints based on issue patterns
 */
function generateHints(
  issue: VizIssue,
  provenance: ProvenanceInfo
): string[] {
  const hints: string[] = [];
  const ruleId = issue.fingerprint;
  
  // Find available roles in the graph
  const roles = provenance.entities.filter(e => e.type === 'role');
  const roleNames = roles.map(r => r.label || r.id.split('/').pop() || r.id);
  
  // consistency-040: Action not authorized for any role
  if (ruleId === 'consistency-040') {
    const actionEntities = issue.entities.filter(e => e.includes('|action/'));
    
    hints.push('### 💡 Suggested Fix');
    hints.push('');
    
    if (actionEntities.length > 0 && roleNames.length > 0) {
      hints.push('Add an authorization statement to your requirements, e.g.:');
      hints.push('');
      
      for (const actionCgId of actionEntities.slice(0, 3)) {
        const actionLabel = actionCgId.split('/').pop() || actionCgId;
        const formattedAction = actionLabel.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        
        for (const role of roleNames.slice(0, 2)) {
          hints.push(`- **"${role} can ${formattedAction}"**`);
        }
      }
      
      hints.push('');
      hints.push('Or add a permissions table:');
      hints.push('');
      hints.push('```');
      hints.push('Permissions:');
      for (const actionCgId of actionEntities.slice(0, 3)) {
        const actionLabel = actionCgId.split('/').pop() || actionCgId;
        hints.push(`- ${roleNames[0] || 'user'}: ${actionLabel}`);
      }
      hints.push('```');
    } else if (actionEntities.length > 0) {
      // Have actions but no roles found - suggest defining roles first
      hints.push('Define roles in your requirements document, then map actions to them.');
      hints.push('');
      hints.push('Example:');
      hints.push('```');
      hints.push('Roles: User, Admin');
      hints.push('User can ' + (actionEntities[0]?.split('/').pop() || 'DoSomething'));
      hints.push('```');
    } else {
      // Unknown action format - generic hint
      hints.push('Ensure this action is authorized for at least one role in your requirements.');
    }
  }
  
  // validation-005: States not connected to transitions
  else if (ruleId === 'validation-005') {
    const stateEntities = issue.entities.filter(e => e.includes('|state/'));
    if (stateEntities.length > 0) {
      hints.push('### 💡 Suggested Fix');
      hints.push('');
      hints.push('Connect these states to transitions by defining state changes:');
      hints.push('');
      
      for (const stateCgId of stateEntities.slice(0, 3)) {
        const stateLabel = stateCgId.split('/').pop() || stateCgId;
        hints.push(`- Define an action that transitions **to** or **from** \`${stateLabel}\``);
      }
      
      hints.push('');
      hints.push('Example:');
      hints.push('```');
      hints.push('State Transitions:');
      const exampleState = stateEntities[0]?.split('/').pop() || 'state';
      hints.push(`- Action "DoSomething" moves Task from "Open" to "${exampleState}"`);
      hints.push('```');
    }
  }
  
  // completeness-010: Gaps in coverage
  else if (ruleId === 'completeness-010') {
    hints.push('### 💡 Suggested Fix');
    hints.push('');
    hints.push('Review the entities marked as "dangling" and either:');
    hints.push('- Add relationships connecting them to the main graph');
    hints.push('- Remove them if they are not needed');
    hints.push('- Mark them as intentionally isolated with a comment');
  }
  
  return hints;
}

/**
 * Generate description text for an issue
 */
function generateDescription(issue: VizIssue, provenance?: ProvenanceInfo): string {
  const kindEmoji: Record<string, string> = {
    'contradiction': '🔴',
    'open_end': '🟡',
    'needs_review': '🟠',
    'error': '❌',
  };
  
  const severityBadge: Record<string, string> = {
    'info': '💡',
    'warning': '⚠️',
    'blocker': '🚨',
  };
  
  const kindLabel: Record<string, string> = {
    'contradiction': 'Contradiction',
    'open_end': 'Open End',
    'needs_review': 'Needs Review',
    'error': 'Error',
  };
  
  const emoji = kindEmoji[issue.kind] || '⚪';
  const severityIcon = severityBadge[issue.severity] || '•';
  const entityCount = issue.entities.length;
  
  const lines: string[] = [];
  
  // Title with emoji
  lines.push(`${emoji} **${issue.title}**`);
  lines.push('');
  
  // Metadata table
  lines.push('| Property | Value |');
  lines.push('|----------|-------|');
  lines.push(`| **Rule** | \`${issue.fingerprint}\` |`);
  lines.push(`| **Kind** | ${kindLabel[issue.kind] || issue.kind} |`);
  lines.push(`| **Severity** | ${severityIcon} ${issue.severity} |`);
  if (issue.confidence > 0) {
    lines.push(`| **Confidence** | ${Math.round(issue.confidence * 100)}% |`);
  }
  lines.push(`| **Entities** | ${entityCount} |`);
  lines.push('');
  
  // Entity context
  if (entityCount > 0) {
    let contextText = `This issue involves ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}`;
    
    switch (issue.kind) {
      case 'open_end':
        contextText += ' that may be disconnected or incomplete.';
        break;
      case 'needs_review':
        contextText += ' that require manual review.';
        break;
      case 'contradiction':
        contextText += ' with potentially conflicting definitions.';
        break;
      case 'error':
        contextText += ' with structural errors.';
        break;
      default:
        contextText += '.';
    }
    
    lines.push(contextText);
    lines.push('');
    
    // Build entity->artifact map if provenance is available
    const entityArtifacts = new Map<string, VizEntity>();
    if (provenance) {
      for (const e of provenance.entities) {
        entityArtifacts.set(e.id, e);
      }
    }
    
    // Entity list with provenance (collapsed if many)
    if (entityCount <= 10) {
      lines.push('**Involved Entities:**');
      for (const cgId of issue.entities) {
        const label = cgId.split('/').pop() || cgId;
        const entity = entityArtifacts.get(cgId);
        if (entity?.artifactPath) {
          lines.push(`- \`${label}\` — from \`${entity.artifactPath}\``);
        } else {
          lines.push(`- \`${label}\``);
        }
      }
    } else {
      lines.push('<details>');
      lines.push(`<summary><strong>Involved Entities (${entityCount})</strong></summary>`);
      lines.push('');
      for (const cgId of issue.entities) {
        const label = cgId.split('/').pop() || cgId;
        const entity = entityArtifacts.get(cgId);
        if (entity?.artifactPath) {
          lines.push(`- \`${label}\` — from \`${entity.artifactPath}\``);
        } else {
          lines.push(`- \`${label}\``);
        }
      }
      lines.push('');
      lines.push('</details>');
    }
    
    // Provenance section: show related statements
    if (provenance && provenance.statements.length > 0) {
      // Find statements involving the issue entities
      const entitySet = new Set(issue.entities);
      const relatedStatements = provenance.statements.filter(s => 
        entitySet.has(s.subject) || entitySet.has(s.object)
      );
      
      if (relatedStatements.length > 0) {
        lines.push('');
        lines.push('**Source Statements:**');
        
        // Group by artifact
        const byArtifact = new Map<string, VizStatement[]>();
        for (const s of relatedStatements) {
          const artifact = s.artifact || 'unknown';
          if (!byArtifact.has(artifact)) byArtifact.set(artifact, []);
          byArtifact.get(artifact)!.push(s);
        }
        
        for (const [artifact, stmts] of byArtifact) {
          const artifactPath = provenance.entities.find(e => e.artifact === artifact)?.artifactPath || artifact;
          lines.push(`\n> 📄 **${artifactPath}**`);
          
          const displayStmts = stmts.slice(0, 8);
          for (const s of displayStmts) {
            const subLabel = s.subject.split('/').pop() || s.subject;
            const objLabel = s.object.split('/').pop() || s.object;
            lines.push(`> - \`${subLabel}\` **${s.predicate}** \`${objLabel}\``);
          }
          if (stmts.length > 8) {
            lines.push(`> - ... and ${stmts.length - 8} more`);
          }
        }
      }
    }
    
    // Jump targets section - show entity/statement refs with artifact paths
    if (provenance) {
      const jumpTargets = generateJumpTargets(issue, provenance);
      if (jumpTargets.length > 0) {
        lines.push('');
        lines.push('<details>');
        lines.push('<summary><strong>🔗 Jump Targets</strong></summary>');
        lines.push('');
        
        // Entity targets - show file path if available
        const entityTargets = jumpTargets.filter(t => t.kind === 'entity');
        if (entityTargets.length > 0) {
          lines.push('**Entities:**');
          for (const t of entityTargets) {
            if (t.artifactPath) {
              lines.push(`- [${t.id}] \`${t.label}\` — [${t.artifactPath}](${t.artifactPath})`);
            } else {
              lines.push(`- [${t.id}] \`${t.label}\``);
            }
          }
          lines.push('');
        }
        
        // Statement targets - show triple info with artifact context
        const stmtTargets = jumpTargets.filter(t => t.kind === 'statement');
        if (stmtTargets.length > 0) {
          lines.push('**Statements:**');
          for (const t of stmtTargets.slice(0, 10)) { // Limit displayed statements
            if (t.artifactPath) {
              lines.push(`- [${t.id}] ${t.label} — [${t.artifactPath}](${t.artifactPath})`);
            } else {
              lines.push(`- [${t.id}] ${t.label}`);
            }
          }
          if (stmtTargets.length > 10) {
            lines.push(`- ... and ${stmtTargets.length - 10} more`);
          }
        }
        
        lines.push('');
        lines.push('</details>');
      }
      
      // Deterministic hints
      const hints = generateHints(issue, provenance);
      if (hints.length > 0) {
        lines.push('');
        lines.push(...hints);
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Generate a visualization lens for an issue
 */
export function generateIssueLens(
  issue: VizIssue,
  entities: VizEntity[],
  statements: VizStatement[],
  options: IssueLensOptions = {}
): IssueLensResult {
  const {
    depth = 1,
    maxNodes = 40,
    includeGhostEdges = true,
    includeDescription = true,
    direction = 'LR',
    includeStyles = true,
    ...rest
  } = options;

  // Build subgraph around issue entities
  const subgraph = buildSubgraph(
    issue.entities,
    entities,
    statements,
    {
      depth,
      maxNodes,
      includeGhostEdges,
      issueKind: issue.kind,
      issueTitle: issue.title,
    }
  );

  // Render mermaid
  const diagram = renderMermaid(subgraph, {
    direction,
    includeStyles,
    title: issue.key,
    wrapInCodeBlock: true,
  });

  // Generate description with provenance
  const description = generateDescription(issue, { entities, statements });

  // Combine into full markdown
  let markdown = '';
  if (includeDescription) {
    markdown += description + '\n\n';
  }
  markdown += diagram.markdown;

  return {
    issue,
    diagram,
    description,
    markdown,
  };
}

/**
 * Generate a visualization lens for an entity
 */
export function generateEntityLens(
  entityId: string,
  entities: VizEntity[],
  statements: VizStatement[],
  options: IssueLensOptions = {}
): EntityLensResult {
  const {
    depth = 1,
    maxNodes = 30,
    direction = 'LR',
    includeStyles = true,
  } = options;

  const entity = entities.find(e => e.id === entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  // Build subgraph around entity
  const subgraph = buildSubgraph(
    [entityId],
    entities,
    statements,
    { depth, maxNodes, includeGhostEdges: false }
  );

  // Render mermaid
  const diagram = renderMermaid(subgraph, {
    direction,
    includeStyles,
    title: entity.label || entityId,
    wrapInCodeBlock: true,
  });

  // Generate entity description
  const description = generateEntityDescription(entity, subgraph);

  // Build markdown
  const markdown = description + '\n\n' + diagram.markdown;

  return {
    entity,
    diagram,
    description,
    markdown,
  };
}

/**
 * Generate description text for an entity
 */
function generateEntityDescription(entity: VizEntity, subgraph: import('./subgraph.js').Subgraph): string {
  const typeEmoji: Record<string, string> = {
    'state': '📍',
    'action': '⚡',
    'role': '👤',
    'resource': '📦',
    'transition': '➡️',
    'event': '📢',
    'rule': '📜',
    'constraint': '🔒',
    'concept': '💡',
  };
  
  const emoji = typeEmoji[entity.type] || '•';
  const label = entity.label || entity.id.split('/').pop() || entity.id;
  
  const lines: string[] = [];
  
  // Title with emoji
  lines.push(`### ${emoji} ${label}`);
  lines.push('');
  
  // Metadata table
  lines.push('| Property | Value |');
  lines.push('|----------|-------|');
  lines.push(`| **Type** | \`${entity.type}\` |`);
  lines.push(`| **ID** | \`${entity.id}\` |`);
  
  // Count connections
  const inEdges = subgraph.edges.filter(e => e.target === entity.id);
  const outEdges = subgraph.edges.filter(e => e.source === entity.id);
  lines.push(`| **Incoming** | ${inEdges.length} |`);
  lines.push(`| **Outgoing** | ${outEdges.length} |`);
  lines.push('');
  
  // List connected entities
  const connectedNodes = subgraph.nodes.filter(n => n.id !== entity.id);
  if (connectedNodes.length > 0) {
    const byType = new Map<string, typeof connectedNodes>();
    for (const n of connectedNodes) {
      if (!byType.has(n.type)) byType.set(n.type, []);
      byType.get(n.type)!.push(n);
    }
    
    lines.push('**Connected Entities:**');
    for (const [type, nodes] of byType) {
      const icon = typeEmoji[type] || '•';
      lines.push(`- ${icon} **${type}s** (${nodes.length}): ${nodes.slice(0, 5).map(n => `\`${n.label || n.id.split('/').pop()}\``).join(', ')}${nodes.length > 5 ? '...' : ''}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Generate visualizations for all findings in a report
 */
export function generateAllIssueLenses(
  findings: VizFinding[],
  entities: VizEntity[],
  statements: VizStatement[],
  options: IssueLensOptions = {}
): Map<string, IssueLensResult> {
  const results = new Map<string, IssueLensResult>();
  
  // Group findings by category for numbering
  const byCategory = new Map<string, VizFinding[]>();
  for (const finding of findings) {
    if (!byCategory.has(finding.category)) {
      byCategory.set(finding.category, []);
    }
    byCategory.get(finding.category)!.push(finding);
  }
  
  // Process each finding
  let globalIndex = 1;
  for (const [category, categoryFindings] of byCategory) {
    for (const finding of categoryFindings) {
      // Skip findings without entities (nothing to visualize)
      if (finding.entities.length === 0) continue;
      
      const issue = findingToIssue(finding, `workspace:unknown#${finding.id}`, globalIndex);
      const result = generateIssueLens(issue, entities, statements, options);
      results.set(finding.id + '-' + globalIndex, result);
      globalIndex++;
    }
  }
  
  return results;
}
