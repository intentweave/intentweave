// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! Shared utilities used by multiple pipeline stages.

/// Deterministic 16-char hex ID: blake3 hash of `input`, truncated.
///
/// Used by the writer to generate stable primary keys for symbols,
/// imports, annotations, TODOs, rationale, and calls — and by the
/// annotator to resolve the same symbol IDs without round-tripping
/// through the DB.
pub fn make_id(input: &str) -> String {
    let hash = blake3::hash(input.as_bytes());
    let hex = hash.to_hex();
    hex[..16].to_string()
}
