/**
 * @intentweave/core/schemas/validation
 *
 * Zod schemas for validating IntentWeave bundle outputs.
 * These schemas mirror the JSON Schema definitions and provide
 * runtime validation with TypeScript type inference.
 */

import { z } from 'zod';

// =============================================================================
// LX Stage Validation Schemas
// =============================================================================

/**
 * Link predicate types - matches TypeScript LinkPredicate
 */
export const LinkPredicateSchema = z.enum([
  'REFINES',
  'DERIVED_FROM',
  'IMPLEMENTS',
  'DESCRIBES',
  'MAPS_TO',
]);

export type LinkPredicateValue = z.infer<typeof LinkPredicateSchema>;

/**
 * Link match method - matches TypeScript LinkMatchMethod
 */
export const LinkMatchMethodSchema = z.enum([
  'name',
  'alias',
  'structural',
  'profile',
  'semantic',
]);

export type LinkMatchMethodValue = z.infer<typeof LinkMatchMethodSchema>;

/**
 * Link evidence - matches TypeScript LinkEvidence
 */
export const LinkEvidenceSchema = z.object({
  text: z.string().describe('Text snippet supporting the link'),
  artifactId: z.string().describe('Source artifact ID'),
  sourceCgId: z.string().optional().describe('Source entity cgId'),
  targetCgId: z.string().optional().describe('Target entity cgId'),
});

export type LinkEvidenceValue = z.infer<typeof LinkEvidenceSchema>;

/**
 * Link proposal - matches TypeScript LinkProposal
 */
export const LinkProposalSchema = z.object({
  id: z.string().optional().describe('Unique proposal ID'),
  sourceArtifact: z.string().describe('Source artifact ID'),
  sourceCgId: z.string().describe('Source entity cgId'),
  targetArtifact: z.string().describe('Target artifact ID'),
  targetCgId: z.string().describe('Target entity cgId'),
  predicate: LinkPredicateSchema.describe('Link predicate type'),
  confidence: z.number().min(0).max(1).describe('Confidence score (0-1)'),
  matchMethod: LinkMatchMethodSchema.describe('Method used for matching'),
  evidence: z.array(LinkEvidenceSchema).describe('Supporting evidence'),
  accepted: z.boolean().optional().describe('Whether proposal has been accepted'),
  rejectionReason: z.string().optional().describe('Rejection reason if rejected'),
});

export type LinkProposalValue = z.infer<typeof LinkProposalSchema>;

/**
 * LX stage output metadata
 */
export const LxMetaSchema = z.object({
  entitiesAnalyzed: z.number().int().min(0).optional(),
  proposalsGenerated: z.number().int().min(0).optional(),
  processingTimeMs: z.number().int().min(0).optional(),
  matchersUsed: z.array(z.string()).optional(),
}).passthrough(); // Allow additional properties

/**
 * LX stage output - matches TypeScript LxStageOutput
 */
export const LxStageOutputSchema = z.object({
  $schema: z.literal('intentweave://schemas/lx-proposals/v1'),
  schemaVersion: z.literal('0.1'),
  stage: z.literal('LX').optional(),
  runId: z.string(),
  workspaceKey: z.string().optional(),
  generatedAt: z.string().datetime().optional(),
  proposals: z.array(LinkProposalSchema),
  meta: LxMetaSchema.optional(),
});

export type LxStageOutputValue = z.infer<typeof LxStageOutputSchema>;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validation result with details
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: z.ZodError['errors'];
  errorMessage?: string;
}

/**
 * Validate a link proposal
 */
export function validateLinkProposal(data: unknown): ValidationResult<LinkProposalValue> {
  const result = LinkProposalSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors,
    errorMessage: result.error.message,
  };
}

/**
 * Validate an array of link proposals
 */
export function validateLinkProposals(data: unknown[]): ValidationResult<LinkProposalValue[]> {
  const validated: LinkProposalValue[] = [];
  const errors: z.ZodError['errors'] = [];
  
  for (let i = 0; i < data.length; i++) {
    const result = LinkProposalSchema.safeParse(data[i]);
    if (result.success) {
      validated.push(result.data);
    } else {
      // Add index to error path
      for (const err of result.error.errors) {
        errors.push({
          ...err,
          path: [i, ...err.path],
        });
      }
    }
  }
  
  if (errors.length > 0) {
    return {
      success: false,
      errors,
      errorMessage: `${errors.length} validation error(s) in proposals`,
    };
  }
  
  return { success: true, data: validated };
}

/**
 * Validate LX stage output
 */
export function validateLxOutput(data: unknown): ValidationResult<LxStageOutputValue> {
  const result = LxStageOutputSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors,
    errorMessage: result.error.message,
  };
}

/**
 * Check if a link proposal is valid (boolean only)
 */
export function isValidLinkProposal(data: unknown): data is LinkProposalValue {
  return LinkProposalSchema.safeParse(data).success;
}

/**
 * Check if LX output is valid (boolean only)
 */
export function isValidLxOutput(data: unknown): data is LxStageOutputValue {
  return LxStageOutputSchema.safeParse(data).success;
}

/**
 * Normalize a link proposal to canonical format
 * Fills in defaults and ensures required fields
 */
export function normalizeLinkProposal(
  proposal: Partial<LinkProposalValue> & Pick<LinkProposalValue, 'sourceArtifact' | 'sourceCgId' | 'targetArtifact' | 'targetCgId'>
): LinkProposalValue {
  return {
    ...proposal,
    predicate: proposal.predicate ?? 'MAPS_TO',
    confidence: proposal.confidence ?? 0.5,
    matchMethod: proposal.matchMethod ?? 'name',
    evidence: proposal.evidence ?? [],
  };
}
