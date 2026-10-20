// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! Writer — Persist all stage results to SQLite.
//!
//! Opens (or creates) the output database, initializes the schema,
//! inserts all rows in a single transaction, then writes metadata.
//!
//! Uses `rusqlite` with WAL mode and PRAGMA foreign_keys = ON.
//!
//! ## Batch-insert strategy
//! All inserts use `conn.prepare()` outside loops and `stmt.execute()`
//! inside, wrapped in `conn.execute_batch("BEGIN") / COMMIT"` for
//! performance. This mirrors the `better-sqlite3` transaction approach
//! in `writer.ts`.

use anyhow::Result;
use rusqlite::Connection;
use std::collections::HashSet;

use crate::schema;
use crate::util;
use crate::types::{
    AnnotateResult, AxResult, BuildOpts, CoxResult, KwxResult, TcgResult, WriteCounts,
};

/// Write all pipeline results to the output SQLite database.
pub fn write(
    opts: &BuildOpts,
    ax: &AxResult,
    kwx: &KwxResult,
    cox: &CoxResult,
    tcg: &TcgResult,
    ann: &AnnotateResult,
) -> Result<WriteCounts> {
    let db_path = &opts.output;
    let conn = Connection::open(db_path)?;

    // Initialize schema (idempotent)
    schema::init_schema(&conn)?;

    let mut counts = WriteCounts::default();

    conn.execute_batch("BEGIN IMMEDIATE")?;

    // ── Build TCG file-stat lookup ──────────────────────────────────────────
    let tcg_stat_map: std::collections::HashMap<&str, &crate::types::FileStat> =
        tcg.file_stats.iter().map(|s| (s.path.as_str(), s)).collect();

    // Write files
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO files
             (path, last_modified, churn, is_hotspot, primary_owner, bus_factor,
              is_doc, content_hash, doc_group, indexed, skip_reason, comment_lines, code_lines)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        )?;

        // Write AX code files, merging TCG stats.
        for f in &ax.files {
            let st = tcg_stat_map.get(f.path.as_str());
            stmt.execute(rusqlite::params![
                f.path,
                st.and_then(|s| s.last_modified.as_deref()).or(f.last_modified.as_deref()),
                st.map(|s| s.churn).unwrap_or(f.churn),
                st.map(|s| s.is_hotspot as i64).unwrap_or(f.is_hotspot as i64),
                st.and_then(|s| s.primary_owner.as_deref()).or(f.primary_owner.as_deref()),
                st.and_then(|s| s.bus_factor).or(f.bus_factor),
                f.is_doc as i64,
                f.content_hash.as_deref(),
                f.doc_group.as_deref(),
                f.indexed as i64,
                f.skip_reason.as_deref(),
                f.comment_lines,
                f.code_lines,
            ])?;
            counts.files += 1;
        }

        // Write KWX doc files that AX did not already cover.
        let ax_paths: HashSet<&str> = ax.files.iter().map(|f| f.path.as_str()).collect();
        for doc in &kwx.doc_files {
            if ax_paths.contains(doc.path.as_str()) {
                continue;
            }
            let st = tcg_stat_map.get(doc.path.as_str());
            stmt.execute(rusqlite::params![
                doc.path,
                st.and_then(|s| s.last_modified.as_deref()),
                st.map(|s| s.churn).unwrap_or(0_i64),
                st.map(|s| s.is_hotspot as i64).unwrap_or(0_i64),
                st.and_then(|s| s.primary_owner.as_deref()),
                st.and_then(|s| s.bus_factor),
                1_i64, // is_doc = true
                None::<&str>,
                doc.doc_group.as_deref(),
                1_i64, // indexed
                None::<&str>,
                None::<i64>,
                None::<i64>,
            ])?;
            counts.files += 1;
        }
    }

    // Write symbols
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO symbols
             (id, name, kind, container, signature, file_path, line, end_line,
              export, doc_summary, body_hash, body_lines, structure_hash,
              implements, deprecated, deprecated_note, is_internal, decorators)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        )?;
        // Top-level export status per (file, name). Members inherit their container's.
        let top_export: std::collections::HashMap<(&str, &str), bool> = ax
            .symbols
            .iter()
            .filter(|s| s.container.is_none())
            .map(|s| ((s.file_path.as_str(), s.name.as_str()), s.export))
            .collect();
        for s in &ax.symbols {
            let id = util::symbol_identity(s);
            let exported = match s.container.as_deref() {
                Some(c) => top_export.get(&(s.file_path.as_str(), c)).copied().unwrap_or(false),
                None => s.export,
            };
            let export_text = if exported { "exported" } else { "internal" };
            stmt.execute(rusqlite::params![
                id, s.name, s.kind, s.container, s.signature,
                s.file_path, s.line, s.end_line,
                export_text, s.doc_summary, s.body_hash, s.body_lines,
                s.structure_hash, s.implements, s.deprecated as i64,
                s.deprecated_note, s.is_internal as i64, s.decorators,
            ])?;
            counts.symbols += 1;
        }
    }

    // Write imports
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO imports
             (id, source_file, target_file, module_specifier, line, is_relative, imported_names)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
        )?;
        let known: HashSet<&str> = ax.files.iter().map(|f| f.path.as_str()).collect();
        for imp in &ax.imports {
            let target = imp.target_file.as_deref().map(|r| resolve_target_file(r, &known));
            // The line keeps two imports of one module in one file (type and value) apart.
            let id = util::make_id(&format!(
                "imp:{}:{}:{}:{}",
                imp.source_file,
                target.as_deref().unwrap_or(""),
                imp.module_specifier,
                imp.line.unwrap_or(0)
            ));
            stmt.execute(rusqlite::params![
                id, imp.source_file, target, imp.module_specifier,
                imp.line, imp.is_relative as i64, imp.imported_names,
            ])?;
            counts.imports += 1;
        }
    }

    // Write TODOs
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO todos (id, file_path, line, kind, text)
             VALUES (?1,?2,?3,?4,?5)",
        )?;
        for t in &ax.todos {
            let id = util::make_id(&format!("todo:{}:{}:{}", t.file_path, t.line, t.kind));
            stmt.execute(rusqlite::params![id, t.file_path, t.line, t.kind, t.text])?;
            counts.todos += 1;
        }
    }

    // Write rationale
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO rationale (id, file_path, line, kind, text, symbol)
             VALUES (?1,?2,?3,?4,?5,?6)",
        )?;
        for r in &ax.rationale {
            let id = util::make_id(&format!("rat:{}:{}:{}", r.file_path, r.line, r.kind));
            stmt.execute(rusqlite::params![id, r.file_path, r.line, r.kind, r.text, r.symbol])?;
            counts.rationale += 1;
        }
    }

    // Write symbol calls
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO symbol_calls
             (id, caller_file, caller_name, caller_line, callee_name, callee_id, is_method)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
        )?;
        for (seq, c) in ax.calls.iter().enumerate() {
            // Sequence within the build keeps two identical calls on one line apart.
            let id = util::make_id(&format!(
                "call:{}:{}:{}:{}:{}",
                c.caller_file, c.caller_name.as_deref().unwrap_or(""), c.caller_line, c.callee_name, seq
            ));
            stmt.execute(rusqlite::params![
                id, c.caller_file, c.caller_name, c.caller_line,
                c.callee_name, c.callee_id, c.is_method as i64,
            ])?;
            counts.calls += 1;
        }
    }

    // Write co-occurrences
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO co_occurrences
             (entity_a, entity_b, count, score, source, file_paths)
             VALUES (?1,?2,?3,?4,?5,?6)",
        )?;
        for co in &cox.co_occurrences {
            stmt.execute(rusqlite::params![
                co.entity_a, co.entity_b, co.count, co.score, co.source, co.file_paths,
            ])?;
            counts.co_occurrences += 1;
        }
    }

    // Write co-changes
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO co_changes
             (file_a, file_b, count, jaccard, recency, commit_hashes)
             VALUES (?1,?2,?3,?4,?5,?6)",
        )?;
        for cc in &tcg.co_changes {
            stmt.execute(rusqlite::params![
                cc.file_a, cc.file_b, cc.count, cc.jaccard, cc.recency, cc.commit_hashes,
            ])?;
            counts.co_changes += 1;
        }
    }

    // Write annotations
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO annotations
             (id, doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score, char_start, char_end)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        )?;
        for a in &ann.annotations {
            let id = util::make_id(&format!(
                "ann:{}:{}:{}:{}",
                a.doc_path, a.line,
                a.symbol_id.as_deref().unwrap_or(""),
                a.source,
            ));
            stmt.execute(rusqlite::params![
                id, a.doc_path, a.line, a.text, a.symbol_id,
                a.confidence, a.source, a.qualifier, a.idf_score,
                a.char_start, a.char_end,
            ])?;
            counts.annotations += 1;
        }
    }

    conn.execute_batch("COMMIT")?;

    // Write _meta outside the main transaction (own transaction)
    let session = format!("cari-native/{}", env!("CARGO_PKG_VERSION"));
    schema::write_meta(
        &conn,
        &session,
        &opts.depth.to_string(),
        &opts.root.to_string_lossy(),
    )?;

    Ok(counts)
}


#[cfg(test)]
mod symbol_identity_tests {
    use crate::util::symbol_identity;

    fn symbol(name: &str, kind: &str, container: Option<&str>, signature: Option<&str>) -> crate::types::Symbol {
        crate::ax::test_symbol(name, kind, container, signature, None)
    }

    #[test]
    fn identity_matches_the_typescript_scheme() {
        // sha256("interface Extractor")[..8] = 4f65b0c2, as in the TypeScript index.
        let s = symbol("Extractor", "interface", None, Some("interface Extractor"));
        assert_eq!(symbol_identity(&s), "impl:src/a.ts#interface:Extractor(4f65b0c2)");
        let p = symbol("name", "property", Some("Extractor"), None);
        assert_eq!(symbol_identity(&p), "impl:src/a.ts#property:Extractor.name");
    }

    #[test]
    fn same_name_members_in_one_file_keep_distinct_identities() {
        let a = symbol("name", "property", Some("PrescriptiveElementNode"), None);
        let b = symbol("name", "property", Some("PrescriptiveLayerNode"), None);
        assert_ne!(symbol_identity(&a), symbol_identity(&b));
    }
}

/// Port of `resolveTargetFile` (TypeScript index writer): a resolved path that is not a
/// known file is retried with the extensions that TypeScript source may use instead.
fn resolve_target_file(resolved: &str, known: &HashSet<&str>) -> String {
    if known.contains(resolved) {
        return resolved.to_string();
    }
    let swaps: &[&str] = match std::path::Path::new(resolved)
        .extension()
        .and_then(|e| e.to_str())
    {
        Some("js") => &[".ts", ".tsx", ".js"],
        Some("jsx") => &[".tsx", ".jsx"],
        Some("mjs") => &[".mts", ".mjs"],
        Some("cjs") => &[".cts", ".cjs"],
        _ => return resolved.to_string(),
    };
    let ext_len = resolved.len() - resolved.rfind('.').unwrap_or(resolved.len());
    let base = &resolved[..resolved.len() - ext_len];
    for swap in swaps {
        let candidate = format!("{base}{swap}");
        if known.contains(candidate.as_str()) {
            return candidate;
        }
    }
    resolved.to_string()
}
