// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! Shared types used across all pipeline stages.

use std::path::PathBuf;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Build configuration
// ---------------------------------------------------------------------------

/// Index depth — mirrors the TypeScript `Depth` type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Depth {
    /// Headings, bold text, code spans, and identifiers only.
    Structured,
    /// Everything in `Structured` plus body text with IDF filtering.
    Full,
}

impl std::fmt::Display for Depth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Depth::Structured => write!(f, "structured"),
            Depth::Full => write!(f, "full"),
        }
    }
}

/// Options passed to `run_pipeline()` and each stage.
#[derive(Debug, Clone)]
pub struct BuildOpts {
    pub root: PathBuf,
    pub paths: Vec<PathBuf>,
    pub output: PathBuf,
    pub depth: Depth,
    pub verbose: bool,
}

// ---------------------------------------------------------------------------
// Stage output types
// ---------------------------------------------------------------------------

/// Output of the AX (AST extraction) stage.
#[derive(Debug, Default)]
pub struct AxResult {
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub calls: Vec<SymbolCall>,
    pub todos: Vec<Todo>,
    pub rationale: Vec<Rationale>,
    pub files: Vec<FileEntry>,
}

/// Output of the KWX (keyword extraction) stage.
#[derive(Debug, Default)]
pub struct KwxResult {
    pub doc_files: Vec<DocFile>,
}

/// Output of the COX (co-occurrence) stage.
#[derive(Debug, Default)]
pub struct CoxResult {
    pub co_occurrences: Vec<CoOccurrence>,
}

/// Per-file TCG-derived stats. Fed into `FileEntry` records by the writer.
#[derive(Debug, Clone, Default)]
pub struct FileStat {
    pub path: String,
    /// Total lines added + removed across all commits.
    pub churn: i64,
    /// True if commit-count z-score > Z_SCORE_THRESHOLD (2.0).
    pub is_hotspot: bool,
    /// Author with >50% of commits for this file.
    pub primary_owner: Option<String>,
    /// Number of authors with >=10% of commits for this file.
    pub bus_factor: Option<i64>,
    /// ISO-8601 date of the most recent commit touching this file.
    pub last_modified: Option<String>,
}

/// Output of the TCG (git analysis) stage.
#[derive(Debug, Default)]
pub struct TcgResult {
    pub co_changes: Vec<CoChange>,
    /// Per-file git-derived stats (churn, hotspot, ownership, last-modified).
    pub file_stats: Vec<FileStat>,
}

/// Output of the Annotate stage.
#[derive(Debug, Default)]
pub struct AnnotateResult {
    pub annotations: Vec<Annotation>,
}

/// Row counts written to the database.
#[derive(Debug, Default)]
pub struct WriteCounts {
    pub symbols: usize,
    pub annotations: usize,
    pub co_occurrences: usize,
    pub co_changes: usize,
    pub files: usize,
    pub imports: usize,
    pub todos: usize,
    pub rationale: usize,
    pub calls: usize,
}

// ---------------------------------------------------------------------------
// Per-entity types (mirror the SQLite schema exactly)
// ---------------------------------------------------------------------------

/// A code symbol extracted from AST. Mirrors the `symbols` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub container: Option<String>,
    pub signature: Option<String>,
    pub file_path: String,
    pub line: Option<i64>,
    pub end_line: Option<i64>,
    pub export: bool,
    pub doc_summary: Option<String>,
    pub body_hash: Option<String>,
    pub body_lines: Option<i64>,
    pub structure_hash: Option<String>,
    pub implements: Option<String>,
    pub deprecated: bool,
    pub deprecated_note: Option<String>,
    pub is_internal: bool,
    pub decorators: Option<String>,
}

/// An import relationship. Mirrors the `imports` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Import {
    pub source_file: String,
    pub target_file: String,
    pub module_specifier: String,
    pub line: Option<i64>,
    pub is_relative: bool,
    pub imported_names: Option<String>,
}

/// A symbol-call edge. Mirrors the `symbol_calls` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolCall {
    pub caller_file: String,
    pub caller_name: String,
    pub caller_line: i64,
    pub callee_name: String,
    pub callee_id: Option<String>,
    pub is_method: bool,
}

/// An inline TODO/FIXME/HACK/XXX marker. Mirrors the `todos` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub file_path: String,
    pub line: i64,
    pub kind: String,
    pub text: String,
}

/// A WHY/NOTE/IMPORTANT/DESIGN rationale comment. Mirrors the `rationale` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rationale {
    pub file_path: String,
    pub line: i64,
    pub kind: String,
    pub text: String,
    pub symbol: Option<String>,
}

/// Per-file metadata. Mirrors the `files` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub last_modified: Option<String>,
    pub churn: i64,
    pub is_hotspot: bool,
    pub primary_owner: Option<String>,
    pub bus_factor: Option<i64>,
    pub is_doc: bool,
    pub content_hash: Option<String>,
    pub doc_group: Option<String>,
    pub indexed: bool,
    pub skip_reason: Option<String>,
    pub comment_lines: Option<i64>,
    pub code_lines: Option<i64>,
}

/// A documentation file with extracted keyword mentions.
#[derive(Debug, Clone)]
pub struct DocFile {
    pub path: String,
    #[allow(dead_code)]
    pub is_doc: bool,
    pub doc_group: Option<String>,
    pub mentions: Vec<Mention>,
}

/// A keyword mention extracted from a document.
#[derive(Debug, Clone)]
pub struct Mention {
    pub line: i64,
    pub text: String,
    pub source: MentionSource,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
}

/// The syntactic source of a mention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MentionSource {
    Heading,
    Bold,
    CodeSpan,
    Identifier,
    Body,
    /// Body-text dictionary match (full depth only).
    /// Mirrors `source: "dictionary"` in heuristicExtractor.ts.
    Dictionary,
}

impl MentionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            MentionSource::Heading => "heading",
            MentionSource::Bold => "bold",
            MentionSource::CodeSpan => "code_span",
            MentionSource::Identifier => "identifier",
            MentionSource::Body => "body",
            MentionSource::Dictionary => "dictionary",
        }
    }
}

/// A co-occurrence pair. Mirrors the `co_occurrences` table.
#[derive(Debug, Clone)]
pub struct CoOccurrence {
    pub entity_a: String,
    pub entity_b: String,
    pub count: i64,
    pub score: f64,
    pub source: String,
    pub file_paths: Option<String>,
}

/// A co-change pair from git history. Mirrors the `co_changes` table.
#[derive(Debug, Clone)]
pub struct CoChange {
    pub file_a: String,
    pub file_b: String,
    pub count: i64,
    pub jaccard: f64,
    pub recency: f64,
    pub commit_hashes: Option<String>,
}

/// An annotation linking a doc span to a code symbol.
/// Mirrors the `annotations` table.
///
/// `symbol_id` is `None` for ungrounded annotations (no matching code symbol
/// was found). These are still stored so doc sections can be found by
/// full-text search.
#[derive(Debug, Clone)]
pub struct Annotation {
    pub doc_path: String,
    pub line: i64,
    pub text: String,
    /// `None` = ungrounded (no matching symbol found). Maps to NULL in SQLite.
    pub symbol_id: Option<String>,
    pub confidence: f64,
    pub source: String,
    pub qualifier: Option<String>,
    pub idf_score: f64,
    pub char_start: Option<i64>,
    pub char_end: Option<i64>,
}
