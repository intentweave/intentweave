// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file Core Validation Rules Engine
 * @description Built-in validators for IntentWeave analysis
 *
 * This module implements the core validation rule types:
 * - missingEdge: Check for required but missing relationships
 * - shapeViolation: Validate entity relationships against shapes
 * - coverageTarget: Check cross-artifact coverage metrics
 * - forbiddenKind: Disallow certain entity kinds
 * - cardinalityViolation: Validate relationship cardinality
 *
 * @packageDocumentation
 */

import type {
  Entity,
  Statement,
  LinkProposal,
  ArtifactRole,
} from '@intentweave/core';
import type {
  RuleDefinition,
  ShapeDefinition,
  ProfilePack,
} from '@intentweave/profiles';

// =============================================================================
// Types
// =============================================================================

/**
 * Validation finding from a rule
 */
export interface ValidationFinding {
  /** Unique finding ID */
  id: string;
  /** Rule ID that generated this finding */
  ruleId: string;
  /** Rule name */
  ruleName: string;
  /** Severity level */
  severity: 'error' | 'warning' | 'info';
  /** Finding category */
  category: string;
  /** Human-readable message */
  message: string;
  /** Affected entity cgId */
  entityCgId?: string;
  /** Affected entity name */
  entityName?: string;
  /** Artifact ID */
  artifactId?: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Input for validation rule execution
 */
export interface ValidationInput {
  /** All entities */
  entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>;
  /** All statements */
  statements: Array<Statement & { artifactId: string; artifactRole: ArtifactRole }>;
  /** Link proposals */
  linkProposals: LinkProposal[];
  /** Profile pack with rules and shapes */
  profilePack: ProfilePack;
}

/**
 * Validation output
 */
export interface ValidationOutput {
  /** All findings */
  findings: ValidationFinding[];
  /** Summary by severity */
  summary: {
    errors: number;
    warnings: number;
    info: number;
    total: number;
  };
  /** Rules executed */
  rulesExecuted: number;
  /** Execution time in ms */
  executionTimeMs: number;
}

/**
 * Rule executor function type
 */
type RuleExecutor = (
  rule: RuleDefinition,
  input: ValidationInput
) => ValidationFinding[];

// =============================================================================
// Rule Registry
// =============================================================================

const ruleExecutors: Map<string, RuleExecutor> = new Map();

/**
 * Register a rule executor
 */
export function registerRuleExecutor(type: string, executor: RuleExecutor): void {
  ruleExecutors.set(type, executor);
}

// =============================================================================
// Core Rule Executors
// =============================================================================

/**
 * Missing Edge Rule
 *
 * Checks if entities of a certain kind are missing required relationships.
 */
function executeMissingEdgeRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    subject?: string;
    predicate?: string;
    targetRole?: ArtifactRole;
    inverse?: boolean;
    required?: boolean;
    minCard?: number;
    /** If set, rule is skipped when no entities of this kind exist */
    requiresEntityKind?: string;
  };

  const { entities, statements, linkProposals } = input;

  // Skip rule if requiresEntityKind is set but no such entities exist
  if (condition.requiresEntityKind) {
    const hasRequiredKind = entities.some(e => e.type === condition.requiresEntityKind);
    if (!hasRequiredKind) {
      return findings; // Skip rule silently
    }
  }

  // Get subject entities
  const subjectEntities = entities.filter(e => 
    !condition.subject || e.type === condition.subject
  );

  // Build edge index
  const edgesBySource = new Map<string, Set<string>>();
  const edgesByTarget = new Map<string, Set<string>>();

  // From statements
  for (const stmt of statements) {
    if (!condition.predicate || stmt.predicate === condition.predicate) {
      // Skip statements without an object
      if (!stmt.objectCgId) continue;
      
      if (!edgesBySource.has(stmt.subjectCgId)) {
        edgesBySource.set(stmt.subjectCgId, new Set());
      }
      edgesBySource.get(stmt.subjectCgId)!.add(stmt.objectCgId);
      
      if (!edgesByTarget.has(stmt.objectCgId)) {
        edgesByTarget.set(stmt.objectCgId, new Set());
      }
      edgesByTarget.get(stmt.objectCgId)!.add(stmt.subjectCgId);
    }
  }

  // From link proposals (if predicate matches)
  for (const link of linkProposals) {
    if (!condition.predicate || link.predicate === condition.predicate) {
      if (!edgesBySource.has(link.sourceCgId)) {
        edgesBySource.set(link.sourceCgId, new Set());
      }
      edgesBySource.get(link.sourceCgId)!.add(link.targetCgId);
      
      if (!edgesByTarget.has(link.targetCgId)) {
        edgesByTarget.set(link.targetCgId, new Set());
      }
      edgesByTarget.get(link.targetCgId)!.add(link.sourceCgId);
    }
  }

  // Check each subject entity
  const minCard = condition.minCard ?? (condition.required ? 1 : 0);
  const edges = condition.inverse ? edgesByTarget : edgesBySource;

  for (const entity of subjectEntities) {
    const entityEdges = edges.get(entity.cgId);
    const edgeCount = entityEdges?.size ?? 0;

    if (edgeCount < minCard) {
      findings.push({
        id: `${rule.id}-${entity.cgId}`,
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        category: 'completeness',
        message: interpolateMessage(rule.message, { entity }),
        entityCgId: entity.cgId,
        entityName: entity.name,
        artifactId: entity.artifactId,
        context: {
          predicate: condition.predicate,
          expectedMin: minCard,
          actual: edgeCount,
        },
      });
    }
  }

  return findings;
}

/**
 * Shape Violation Rule
 *
 * Validates relationships against shape definitions.
 */
function executeShapeViolationRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    predicate?: string;
    checkNameSimilarity?: boolean;
    checkTypeCompatibility?: boolean;
    minSimilarity?: number;
    maxConfidence?: number;
    targetExists?: boolean;
  };

  const { entities, statements, linkProposals, profilePack } = input;

  // Build entity lookup
  const entityByCgId = new Map<string, Entity & { artifactId: string; artifactRole: ArtifactRole }>();
  for (const e of entities) {
    entityByCgId.set(e.cgId, e);
  }

  // Check statements against shapes
  for (const stmt of statements) {
    if (condition.predicate && stmt.predicate !== condition.predicate) continue;

    const source = entityByCgId.get(stmt.subjectCgId);
    if (!source) continue;

    // Find shape for this subject type
    const shape = profilePack.shapes.find((s: { subject: string }) => s.subject === source.type);
    if (!shape) continue;

    // Check if predicate is allowed
    const allowedPred = shape.predicates.find((p: { name: string }) => p.name === stmt.predicate);
    if (!allowedPred) {
      findings.push({
        id: `${rule.id}-${stmt.id ?? stmt.subjectCgId}`,
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        category: 'shape-violation',
        message: `Entity "${source.name}" (${source.type}) cannot have predicate "${stmt.predicate}"`,
        entityCgId: source.cgId,
        entityName: source.name,
        artifactId: source.artifactId,
        context: {
          predicate: stmt.predicate,
          allowedPredicates: shape.predicates.map((p: { name: string }) => p.name),
        },
      });
      continue;
    }

    // Check target type is valid
    if (!stmt.objectCgId) continue;
    
    const target = entityByCgId.get(stmt.objectCgId);
    if (target && !allowedPred.targets.includes(target.type)) {
      findings.push({
        id: `${rule.id}-target-${stmt.id ?? stmt.subjectCgId}`,
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        category: 'shape-violation',
        message: `"${source.name}" ${stmt.predicate} "${target.name}" - target type "${target.type}" not allowed`,
        entityCgId: source.cgId,
        entityName: source.name,
        artifactId: source.artifactId,
        context: {
          predicate: stmt.predicate,
          targetType: target.type,
          allowedTargets: allowedPred.targets,
        },
      });
    }
  }

  // Check link proposals for low confidence or similarity issues
  if (condition.maxConfidence !== undefined) {
    for (const link of linkProposals) {
      if (condition.predicate && link.predicate !== condition.predicate) continue;
      
      if (link.confidence <= condition.maxConfidence) {
        const source = entityByCgId.get(link.sourceCgId);
        const target = entityByCgId.get(link.targetCgId);
        
        findings.push({
          id: `${rule.id}-lowconf-${link.id}`,
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          category: 'link-quality',
          message: interpolateMessage(rule.message, {
            source,
            target,
            confidence: Math.round(link.confidence * 100),
          }),
          entityCgId: link.sourceCgId,
          entityName: source?.name,
          context: {
            linkId: link.id,
            confidence: link.confidence,
            predicate: link.predicate,
          },
        });
      }
    }
  }

  return findings;
}

/**
 * Coverage Target Rule
 *
 * Checks that coverage between artifact roles meets targets.
 */
function executeCoverageTargetRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    sourceRole?: ArtifactRole;
    targetRole?: ArtifactRole;
    subject?: string;
    minCoverage?: number;
    isPublic?: boolean;
  };

  const { entities, linkProposals } = input;
  const minCoverage = condition.minCoverage ?? 0.8;

  // Get source entities
  let sourceEntities = entities.filter(e => {
    if (condition.sourceRole && e.artifactRole !== condition.sourceRole) return false;
    if (condition.subject && e.type !== condition.subject) return false;
    return true;
  });

  if (sourceEntities.length === 0) return findings;

  // Count linked source entities
  const linkedSourceIds = new Set<string>();
  for (const link of linkProposals) {
    if (condition.targetRole) {
      const targetEntity = entities.find(e => e.cgId === link.targetCgId);
      if (targetEntity?.artifactRole !== condition.targetRole) continue;
    }
    linkedSourceIds.add(link.sourceCgId);
  }

  const linkedCount = sourceEntities.filter(e => linkedSourceIds.has(e.cgId)).length;
  const actualCoverage = linkedCount / sourceEntities.length;

  if (actualCoverage < minCoverage) {
    findings.push({
      id: `${rule.id}-coverage`,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      category: 'coverage',
      message: interpolateMessage(rule.message, {
        coverage: Math.round(actualCoverage * 100),
        target: Math.round(minCoverage * 100),
      }),
      context: {
        sourceRole: condition.sourceRole,
        targetRole: condition.targetRole,
        totalEntities: sourceEntities.length,
        linkedEntities: linkedCount,
        actualCoverage,
        targetCoverage: minCoverage,
      },
    });
  }

  return findings;
}

/**
 * Forbidden Kind Rule
 *
 * Disallows certain entity kinds in specific contexts.
 */
function executeForbiddenKindRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    forbiddenKinds?: string[];
    inRole?: ArtifactRole;
    exceptWhen?: Record<string, unknown>;
  };

  const forbiddenKinds = condition.forbiddenKinds ?? [];
  const { entities } = input;

  for (const entity of entities) {
    if (condition.inRole && entity.artifactRole !== condition.inRole) continue;
    
    if (forbiddenKinds.includes(entity.type)) {
      findings.push({
        id: `${rule.id}-${entity.cgId}`,
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        category: 'forbidden-kind',
        message: `Entity kind "${entity.type}" is not allowed in ${condition.inRole ?? 'this context'}`,
        entityCgId: entity.cgId,
        entityName: entity.name,
        artifactId: entity.artifactId,
        context: {
          forbiddenKind: entity.type,
          role: condition.inRole,
        },
      });
    }
  }

  return findings;
}

/**
 * Cardinality Violation Rule
 *
 * Validates relationship cardinality constraints.
 */
function executeCardinalityViolationRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    subject?: string;
    predicate?: string;
    minCard?: number;
    maxCard?: number;
  };

  const { entities, statements, profilePack } = input;

  // Build edge count by source and predicate
  const edgeCounts = new Map<string, Map<string, number>>();
  
  for (const stmt of statements) {
    if (!edgeCounts.has(stmt.subjectCgId)) {
      edgeCounts.set(stmt.subjectCgId, new Map());
    }
    const predicateCounts = edgeCounts.get(stmt.subjectCgId)!;
    predicateCounts.set(
      stmt.predicate,
      (predicateCounts.get(stmt.predicate) ?? 0) + 1
    );
  }

  // Build entity lookup
  const entityByCgId = new Map<string, Entity & { artifactId: string; artifactRole: ArtifactRole }>();
  for (const e of entities) {
    entityByCgId.set(e.cgId, e);
  }

  // Check cardinality constraints from shapes
  for (const shape of profilePack.shapes) {
    if (condition.subject && shape.subject !== condition.subject) continue;

    for (const pred of shape.predicates) {
      if (condition.predicate && pred.name !== condition.predicate) continue;

      const minCard = condition.minCard ?? pred.minCard;
      const maxCard = condition.maxCard ?? pred.maxCard;

      if (minCard === undefined && maxCard === undefined) continue;

      // Check entities of this type
      const subjectEntities = entities.filter(e => e.type === shape.subject);
      
      for (const entity of subjectEntities) {
        const counts = edgeCounts.get(entity.cgId);
        const count = counts?.get(pred.name) ?? 0;

        if (minCard !== undefined && count < minCard) {
          findings.push({
            id: `${rule.id}-min-${entity.cgId}-${pred.name}`,
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            category: 'cardinality',
            message: `"${entity.name}" has ${count} ${pred.name} relationships, minimum is ${minCard}`,
            entityCgId: entity.cgId,
            entityName: entity.name,
            artifactId: entity.artifactId,
            context: {
              predicate: pred.name,
              actual: count,
              minCard,
            },
          });
        }

        if (maxCard !== undefined && count > maxCard) {
          findings.push({
            id: `${rule.id}-max-${entity.cgId}-${pred.name}`,
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            category: 'cardinality',
            message: `"${entity.name}" has ${count} ${pred.name} relationships, maximum is ${maxCard}`,
            entityCgId: entity.cgId,
            entityName: entity.name,
            artifactId: entity.artifactId,
            context: {
              predicate: pred.name,
              actual: count,
              maxCard,
            },
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Custom Rule (placeholder for extensibility)
 */
function executeCustomRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  // Custom rules require specific implementation
  // Return empty for now - can be extended via registerRuleExecutor
  return [];
}

/**
 * Orphan Entity Rule
 *
 * Checks for entities that are referenced in statements but don't exist,
 * and for entities that have no incoming or outgoing edges (completely isolated).
 */
function executeOrphanEntityRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const { entities, statements, linkProposals } = input;

  const condition = rule.condition as {
    checkDanglingRefs?: boolean;
    checkIsolated?: boolean;
  };

  const checkDanglingRefs = condition.checkDanglingRefs !== false;
  const checkIsolated = condition.checkIsolated !== false;

  // Build entity ID set
  const entityIds = new Set(entities.map(e => e.cgId));

  // Check for dangling references (statements referencing non-existent entities)
  if (checkDanglingRefs) {
    for (const stmt of statements) {
      // Check subject
      if (!entityIds.has(stmt.subjectCgId)) {
        findings.push({
          id: `${rule.id}-subject-${stmt.id ?? stmt.subjectCgId}`,
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          category: 'integrity',
          message: `Statement references non-existent subject entity "${stmt.subjectCgId}"`,
          entityCgId: stmt.subjectCgId,
          entityName: stmt.subjectCgId,
          artifactId: stmt.artifactId,
          context: {
            statementId: stmt.id,
            predicate: stmt.predicate,
            position: 'subject',
          },
        });
      }

      // Check object
      if (stmt.objectCgId && !entityIds.has(stmt.objectCgId)) {
        findings.push({
          id: `${rule.id}-object-${stmt.id ?? stmt.objectCgId}`,
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          category: 'integrity',
          message: `Statement references non-existent object entity "${stmt.objectCgId}"`,
          entityCgId: stmt.objectCgId,
          entityName: stmt.objectCgId,
          artifactId: stmt.artifactId,
          context: {
            statementId: stmt.id,
            predicate: stmt.predicate,
            position: 'object',
          },
        });
      }
    }
  }

  // Check for isolated entities (no incoming or outgoing edges)
  if (checkIsolated) {
    const connectedEntities = new Set<string>();

    for (const stmt of statements) {
      connectedEntities.add(stmt.subjectCgId);
      if (stmt.objectCgId) {
        connectedEntities.add(stmt.objectCgId);
      }
    }

    for (const link of linkProposals) {
      connectedEntities.add(link.sourceCgId);
      connectedEntities.add(link.targetCgId);
    }

    for (const entity of entities) {
      if (!connectedEntities.has(entity.cgId)) {
        findings.push({
          id: `${rule.id}-isolated-${entity.cgId}`,
          ruleId: rule.id,
          ruleName: rule.name,
          severity: 'info', // Isolated entities are often not a problem
          category: 'completeness',
          message: `Entity "${entity.name}" is isolated (no relationships)`,
          entityCgId: entity.cgId,
          entityName: entity.name,
          artifactId: entity.artifactId,
          context: {
            type: entity.type,
          },
        });
      }
    }
  }

  return findings;
}

// =============================================================================
// Semantic Analysis Rule Executors
// =============================================================================

/**
 * Get searchable text from an entity (name + evidence text + props)
 */
function getEntitySearchText(entity: Entity & { artifactId: string }): string {
  let text = entity.name;
  
  // Add evidence text
  if (entity.evidence?.length > 0) {
    text += ' ' + entity.evidence.map(e => e.text).join(' ');
  }
  
  // Add relevant props
  if (entity.props) {
    if (typeof entity.props.description === 'string') {
      text += ' ' + entity.props.description;
    }
  }
  
  return text.toLowerCase();
}

/**
 * Semantic Contradiction Rule
 *
 * Detects contradicting requirements based on patterns.
 * Example: "MUST NOT delete" vs "MAY request erasure"
 */
function executeSemanticContradictionRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    patterns?: string[];
    sameSubject?: boolean;
    requireBothPatterns?: boolean;
  };

  const { entities } = input;
  const patterns = condition.patterns ?? [];
  
  if (patterns.length < 2) return findings;

  // Get all entity descriptions and names as searchable text
  const entityTexts = entities.map(e => ({
    entity: e,
    text: getEntitySearchText(e),
  }));

  // Check if patterns match across entities
  const patternMatches: Array<{ pattern: string; matches: typeof entityTexts }> = [];
  
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      const matches = entityTexts.filter(et => regex.test(et.text));
      if (matches.length > 0) {
        patternMatches.push({ pattern, matches });
      }
    } catch {
      // Invalid regex, skip
    }
  }

  // If we need both patterns and found matches for at least 2
  if (condition.requireBothPatterns && patternMatches.length >= 2) {
    findings.push({
      id: `${rule.id}-contradiction`,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      category: 'semantic',
      message: rule.message,
      context: {
        matchedPatterns: patternMatches.map(pm => pm.pattern),
        matchedEntities: patternMatches.flatMap(pm => pm.matches.map(m => m.entity.name)),
      },
    });
  }

  return findings;
}

/**
 * Semantic Ambiguity Rule
 *
 * Detects vague or ambiguous language in specifications.
 */
function executeSemanticAmbiguityRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    patterns?: string[];
  };

  const { entities } = input;
  const patterns = condition.patterns ?? [];

  for (const entity of entities) {
    const text = getEntitySearchText(entity);
    
    for (const pattern of patterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        const match = text.match(regex);
        
        if (match) {
          findings.push({
            id: `${rule.id}-${entity.cgId}-${pattern.slice(0, 10)}`,
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            category: 'semantic',
            message: interpolateMessage(rule.message, { match: match[0], entity }),
            entityCgId: entity.cgId,
            entityName: entity.name,
            artifactId: entity.artifactId,
            context: {
              pattern,
              matchedText: match[0],
            },
          });
          break; // One finding per entity
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  return findings;
}

/**
 * Semantic Tension Rule
 *
 * Detects implementation tensions where multiple requirements
 * create difficult tradeoffs when combined.
 */
function executeSemanticTensionRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    patterns?: string[];
    sameSubject?: boolean;
    requiresAdditionalContext?: string[];
  };

  const { entities } = input;
  const patterns = condition.patterns ?? [];
  const additionalContext = condition.requiresAdditionalContext ?? [];

  // Find entities matching primary patterns
  for (const entity of entities) {
    const text = getEntitySearchText(entity);
    
    for (const pattern of patterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(text)) {
          // Check if additional context is missing
          const hasContext = additionalContext.length === 0 || 
            additionalContext.some(ctx => {
              const ctxRegex = new RegExp(ctx, 'i');
              return ctxRegex.test(text);
            });
          
          if (!hasContext) {
            findings.push({
              id: `${rule.id}-${entity.cgId}`,
              ruleId: rule.id,
              ruleName: rule.name,
              severity: rule.severity,
              category: 'semantic',
              message: interpolateMessage(rule.message, { entity, subject: entity.name }),
              entityCgId: entity.cgId,
              entityName: entity.name,
              artifactId: entity.artifactId,
              context: {
                matchedPattern: pattern,
                missingContext: additionalContext,
              },
            });
          }
          break;
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  return findings;
}

/**
 * Semantic Coverage Rule
 *
 * Checks that referenced concepts are fully covered.
 * Example: Audit trail should cover all state changes.
 */
function executeSemanticCoverageRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    check?: string;
    requiredEvents?: string[];
  };

  const { entities } = input;

  if (condition.check === 'auditTrailCoverage') {
    const requiredEvents = condition.requiredEvents ?? ['created', 'edited', 'deleted'];
    
    // Find audit trail related entities
    const auditEntities = entities.filter(e => 
      /audit|trail|log|history/i.test(getEntitySearchText(e))
    );

    if (auditEntities.length > 0) {
      // Find event entities
      const eventEntities = entities.filter(e => e.type === 'event');
      const eventNames = eventEntities.map(e => e.name.toLowerCase());

      // Check which required events are missing
      const missingEvents = requiredEvents.filter(req => 
        !eventNames.some(name => name.includes(req.toLowerCase()))
      );

      if (missingEvents.length > 0) {
        findings.push({
          id: `${rule.id}-audit-coverage`,
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          category: 'semantic',
          message: `Audit trail defined but missing events: ${missingEvents.join(', ')}`,
          context: {
            requiredEvents,
            foundEvents: eventNames,
            missingEvents,
          },
        });
      }
    }
  }

  return findings;
}

/**
 * Issue Entity Rule
 *
 * Surfaces entities with kind="issue" that were detected during extraction.
 * These represent problems the LLM found in the specification.
 */
function executeIssueEntityRule(
  rule: RuleDefinition,
  input: ValidationInput
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const condition = rule.condition as {
    subject?: string;
    minConfidence?: number;
  };

  const { entities } = input;
  const minConfidence = condition.minConfidence ?? 0.5;
  const targetType = condition.subject ?? 'issue';

  // Find issue entities
  const issueEntities = entities.filter(e => 
    e.type === targetType && 
    (e.confidence ?? 1) >= minConfidence
  );

  for (const entity of issueEntities) {
    // Get description from props if available
    const description = entity.props?.description as string | undefined;
    
    findings.push({
      id: `${rule.id}-${entity.cgId}`,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      category: 'semantic',
      message: interpolateMessage(rule.message, { entity }),
      entityCgId: entity.cgId,
      entityName: entity.name,
      artifactId: entity.artifactId,
      context: {
        issueType: entity.type,
        description,
        confidence: entity.confidence,
      },
    });
  }

  return findings;
}

// =============================================================================
// Register Built-in Executors
// =============================================================================

registerRuleExecutor('missing-edge', executeMissingEdgeRule);
registerRuleExecutor('shape-violation', executeShapeViolationRule);
registerRuleExecutor('coverage-target', executeCoverageTargetRule);
registerRuleExecutor('forbidden-kind', executeForbiddenKindRule);
registerRuleExecutor('cardinality-violation', executeCardinalityViolationRule);
registerRuleExecutor('orphan-entity', executeOrphanEntityRule);
registerRuleExecutor('custom', executeCustomRule);

// Semantic analysis executors
registerRuleExecutor('semantic-contradiction', executeSemanticContradictionRule);
registerRuleExecutor('semantic-ambiguity', executeSemanticAmbiguityRule);
registerRuleExecutor('semantic-tension', executeSemanticTensionRule);
registerRuleExecutor('semantic-coverage', executeSemanticCoverageRule);
registerRuleExecutor('issue-entity', executeIssueEntityRule);

// =============================================================================
// Main Export
// =============================================================================

/**
 * Run all validation rules
 */
export function runValidation(input: ValidationInput): ValidationOutput {
  const startTime = Date.now();
  const findings: ValidationFinding[] = [];
  let rulesExecuted = 0;

  const { profilePack } = input;

  // Execute each enabled rule
  for (const rule of profilePack.rules) {
    if (rule.enabled === false) continue;

    const executor = ruleExecutors.get(rule.type);
    if (!executor) {
      console.warn(`No executor for rule type: ${rule.type}`);
      continue;
    }

    try {
      const ruleFindings = executor(rule, input);
      findings.push(...ruleFindings);
      rulesExecuted++;
    } catch (error) {
      console.error(`Error executing rule ${rule.id}:`, error);
    }
  }

  // Calculate summary
  const summary = {
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    info: findings.filter(f => f.severity === 'info').length,
    total: findings.length,
  };

  return {
    findings,
    summary,
    rulesExecuted,
    executionTimeMs: Date.now() - startTime,
  };
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Interpolate message template with context
 */
function interpolateMessage(
  template: string,
  context: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
    const parts = path.split('.');
    let value: unknown = context;
    
    for (const part of parts) {
      if (value && typeof value === 'object') {
        value = (value as Record<string, unknown>)[part];
      } else {
        return `{{${path}}}`;
      }
    }
    
    return String(value ?? `{{${path}}}`);
  });
}

/**
 * Create an empty validation output
 */
export function createEmptyValidationOutput(): ValidationOutput {
  return {
    findings: [],
    summary: {
      errors: 0,
      warnings: 0,
      info: 0,
      total: 0,
    },
    rulesExecuted: 0,
    executionTimeMs: 0,
  };
}
