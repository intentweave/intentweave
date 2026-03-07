// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

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
