/**
 * Pipeline Module
 * 
 * Contains pipeline orchestration utilities:
 * - Pipeline orchestrator for running full analysis
 * - PipelineContext for stage execution
 * - Run metadata management
 * - Aggregation utilities
 * - Profile converter utility
 */

export * from './context.js';
export * from './aggregation.js';
export * from './orchestrator.js';
export { convertProfileForAnalyzer } from './converter.js';

// Open Track (schema-free parallel pipeline: IN → FX → KX)
export * from './openTrack.js';
export * from './unifiedRunner.js';
