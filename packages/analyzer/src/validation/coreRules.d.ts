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
import type { Entity, Statement, LinkProposal, ArtifactRole } from '@intentweave/core';
import type { RuleDefinition, ProfilePack } from '@intentweave/profiles';
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
    entities: Array<Entity & {
        artifactId: string;
        artifactRole: ArtifactRole;
    }>;
    /** All statements */
    statements: Array<Statement & {
        artifactId: string;
        artifactRole: ArtifactRole;
    }>;
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
type RuleExecutor = (rule: RuleDefinition, input: ValidationInput) => ValidationFinding[];
/**
 * Register a rule executor
 */
export declare function registerRuleExecutor(type: string, executor: RuleExecutor): void;
/**
 * Run all validation rules
 */
export declare function runValidation(input: ValidationInput): ValidationOutput;
/**
 * Create an empty validation output
 */
export declare function createEmptyValidationOutput(): ValidationOutput;
export {};
//# sourceMappingURL=coreRules.d.ts.map