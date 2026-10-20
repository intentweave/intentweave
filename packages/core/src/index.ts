// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/core
 *
 * Core types, utilities, and interfaces for IntentWeave.
 * This package contains the foundational types shared across all IntentWeave packages.
 */

// Types (includes EntityType, ENTITY_TYPES - the single source of truth)
export * from "./types/index.js";

// cgId utilities
export * from "./cgId/index.js";

// Predicates (includes Predicate, PREDICATES - the single source of truth)
export * from "./predicates/index.js";

// Shapes - explicit exports to avoid conflicts with extractionSchema
export {
  SHAPE_RULES,
  shapeCheck,
  isKnownPredicate,
  getPredicatesForSubjectType,
  getPredicatesForObjectType,
  getAllowedSubjectTypes,
  getAllowedObjectTypes,
  type ShapeCheckResult,
} from "./shapes/index.js";

// Workspace
export * from "./workspace/index.js";

// Canonical Output (JSON writer, schema headers)
export * from "./output/index.js";

// JSON Schemas (includes extractionSchema with UNIFIED_EXTRACTION_SCHEMA)
export * from "./schemas/index.js";

// Interfaces
export * from "./interfaces.js";

// Provider-neutral structured inference
export * from "./inference/index.js";

// Token usage & cost tracking
export * from "./tokenUsage.js";

// Error hierarchy
export * from "./errors.js";

// Retry utility
export * from "./retry.js";

// Transcripts (chat/conversation as first-class artifacts)
export * from "./transcripts/index.js";

// Reports (actionable reports for humans + AI assistants)
export * from "./reports/index.js";

// Bundle (consolidated graph output)
export * from "./bundle/index.js";

// Weave (WX canonicalization stage)
export * from "./weave/index.js";

// Plugin system (11.1 + 11.2)
export * from "./plugin.js";
export * from "./pluginRegistry.js";
