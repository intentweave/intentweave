// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline Stages
 *
 * Per-artifact stages: IN → RX → REF → CX → MX → PX
 * Code extraction: AX
 * Per-run aggregation: LX, Coverage, Validation
 */

// IN Stage - Ingestion
export * from "./in.js";

// RX Stage - Raw Extraction
export * from "./rx.js";

// REF Stage - Reference Resolution (post-RX)
export * from "./ref.js";

// AX Stage - AST Extraction (code symbols)
export * from "./ax.js";

// CX Stage - Consolidation
export * from "./cx.js";

// MX Stage - Materialization
export * from "./mx.js";

// PX Stage - Presentation/Filtering
export * from "./px.js";

// FX Stage - Free Extraction (schema-free, open track)
export * from "./fx.js";

// KX Stage - Canonicalization (open track)
export * from "./kx.js";

// GX Stage - Global Merge (cross-document entity unification)
export * from "./gx.js";
