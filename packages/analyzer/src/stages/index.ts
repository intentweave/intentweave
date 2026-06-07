// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline Stages
 *
 * Code extraction: AX (AST), IN (ingestion), REF (reference resolution)
 */

// IN Stage - Ingestion
export * from "./in.js";

// REF Stage - Reference Resolution (post-RX)
export * from "./ref.js";

// AX Stage - AST Extraction (code symbols)
export * from "./ax.js";

// AX Helpers - shared utilities for language adapter plugins
export * from "./ax-helpers.js";
