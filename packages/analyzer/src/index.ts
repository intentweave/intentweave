// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/analyzer
 *
 * CARI pipeline stages: AX (AST extraction), KWG (keyword graph), TCG (temporal change graph).
 */

// Pipeline stages (AX, IN, REF)
export * from "./stages/index.js";

// Entity extractors
export * from "./extractors/index.js";

// Storage abstractions
export * from "./stores/index.js";

// KWG (Keyword Graph) — KWX + COX evidence pipeline
export * from "./kwg/index.js";

// TCG (Temporal Change Graph) — git co-changes, hotspots, ownership
export * from "./tcg/index.js";

// Pipeline context types + loggers
export * from "./pipeline/context.js";
