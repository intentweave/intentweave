/**
 * Aggregate Stage Modules
 * 
 * These stages run at the run level (not per-artifact):
 * - LX: Cross-artifact linking
 * - Coverage: Traceability coverage computation
 * - Validation: Cross-artifact validation
 */

// LX Stage (Cross-Artifact Linking)
export * from './lx.js';
