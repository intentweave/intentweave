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

/// Symbol identity in the TypeScript AX scheme (`generateSymbolId`):
/// `impl:<path>#<kind>:<container.>name` plus `(<sha256(signature)[..8]>)` when a
/// signature is present. Identities are shared with the claims layer, so they must match.
pub fn symbol_identity(s: &crate::types::Symbol) -> String {
    use sha2::{Digest, Sha256};
    let base = match s.container.as_deref() {
        Some(c) if !c.is_empty() => format!("{c}.{}", s.name),
        _ => s.name.clone(),
    };
    let path = s.file_path.replace('\\', "/");
    match s.signature.as_deref() {
        Some(sig) if !sig.is_empty() => {
            let hex = format!("{:x}", Sha256::digest(sig.as_bytes()));
            format!("impl:{path}#{}:{base}({})", s.kind, &hex[..8])
        }
        _ => format!("impl:{path}#{}:{base}", s.kind),
    }
}
