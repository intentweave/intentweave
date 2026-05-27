// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! Annotate — match keyword mentions in documentation to code symbols.
//!
//! Implements a tiered matching strategy (exact → slug → token → ungrounded)
//! and optionally applies an IDF confidence penalty in `full` depth mode.
//! All doc files are processed in parallel via rayon.

use anyhow::Result;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::idf;
use crate::types::{
    AnnotateResult, Annotation, AxResult, BuildOpts, Depth, DocFile, KwxResult,
    MentionSource,
};
use crate::util;


// ── Matching confidence levels (mirrors annotator.ts exactly) ──────────────
const CONF_EXACT: f64 = 1.0;
const CONF_SLUG: f64 = 0.8;
const CONF_TOKEN: f64 = 0.5;
const CONF_HEADING_UNGROUNDED: f64 = 0.3;
const CONF_UNGROUNDED: f64 = 0.1;

const IDF_PENALTY_FLOOR: f64 = 0.1;
const MIN_SLUG_LEN: usize = 3;
const MIN_TOKEN_LEN: usize = 3;

// ── Symbol lookup index ─────────────────────────────────────────────────────

/// Pre-built lookup index over all code symbols. Shared immutably across
/// rayon threads (both HashMaps implement Sync).
struct SymbolIndex {
    /// `lowercase(name) → symbol_id`
    by_exact: HashMap<String, String>,
    /// `to_slug(name) → symbol_id`; also registers camelCase suffix slugs
    by_slug: HashMap<String, String>,
}

impl SymbolIndex {
    fn build(symbols: &[crate::types::Symbol]) -> Self {
        let mut by_exact: HashMap<String, String> = HashMap::new();
        let mut by_slug: HashMap<String, String> = HashMap::new();

        for sym in symbols {
            let sym_id = util::make_id(&format!("sym:{}:{}", sym.file_path, sym.name));
            let lower = sym.name.to_lowercase();

            // Prefer exported symbols — same semantics as annotator.ts:
            // always insert on first occurrence; overwrite with exported symbol.
            if !by_exact.contains_key(&lower) || sym.export {
                by_exact.insert(lower.clone(), sym_id.clone());
            }

            let slug = to_slug(&sym.name);
            if !by_slug.contains_key(&slug) || sym.export {
                by_slug.insert(slug.clone(), sym_id.clone());
            }

            // Register camelCase suffix slugs (length ≥ 5) so that e.g.
            // "co-change" (slug "cochange") matches "IndexCoChange".
            let parts = split_camel_case(&sym.name);
            if parts.len() >= 2 {
                for i in 1..parts.len() {
                    let suffix_slug: String = parts[i..].join("");
                    if suffix_slug.len() >= 5 {
                        by_slug.entry(suffix_slug).or_insert_with(|| sym_id.clone());
                    }
                }
            }
        }

        SymbolIndex { by_exact, by_slug }
    }
}

// ── Core matching logic ─────────────────────────────────────────────────────

enum MatchResult {
    Grounded {
        symbol_id: String,
        confidence: f64,
    },
    Ungrounded {
        confidence: f64,
    },
}

fn match_mention(text: &str, source: &MentionSource, index: &SymbolIndex) -> MatchResult {
    let lower = text.to_lowercase();

    // 1. Exact match
    if let Some(sym_id) = index.by_exact.get(&lower) {
        return MatchResult::Grounded {
            symbol_id: sym_id.clone(),
            confidence: CONF_EXACT,
        };
    }

    // 2. Slug match (filtered alphanumeric characters only)
    let slug = to_slug(text);
    if slug.len() >= MIN_SLUG_LEN {
        if let Some(sym_id) = index.by_slug.get(&slug) {
            return MatchResult::Grounded {
                symbol_id: sym_id.clone(),
                confidence: CONF_SLUG,
            };
        }
    }

    // 3. Token match — any token of the mention phrase is an exact symbol name
    let tokens = tokenize(text);
    for token in &tokens {
        if token.len() < MIN_TOKEN_LEN {
            continue;
        }
        if let Some(sym_id) = index.by_exact.get(token.as_str()) {
            return MatchResult::Grounded {
                symbol_id: sym_id.clone(),
                confidence: CONF_TOKEN,
            };
        }
    }

    // 4. Heading source gets a small structural-signal confidence boost
    if matches!(source, MentionSource::Heading) {
        return MatchResult::Ungrounded {
            confidence: CONF_HEADING_UNGROUNDED,
        };
    }

    // 5. Fully ungrounded
    MatchResult::Ungrounded {
        confidence: CONF_UNGROUNDED,
    }
}

fn annotate_doc(
    doc: &DocFile,
    index: &SymbolIndex,
    idf_scores: &HashMap<String, f64>,
    apply_idf: bool,
) -> Vec<Annotation> {
    let mut annotations = Vec::with_capacity(doc.mentions.len());

    for mention in &doc.mentions {
        let match_result = match_mention(&mention.text, &mention.source, index);

        let (symbol_id, mut confidence) = match match_result {
            MatchResult::Grounded {
                symbol_id,
                confidence,
            } => (Some(symbol_id), confidence),
            MatchResult::Ungrounded { confidence } => (None, confidence),
        };

        // IDF penalty: body-text and identifier sources in full-depth mode.
        // Mirrors annotator.ts: `confidence *= Math.max(idfScore, 0.1)`
        // The floor is applied even when idf_score is 0 (very common term).
        let norm_key = mention.text.to_lowercase();
        let idf_score = idf_scores.get(&norm_key).copied().unwrap_or(0.0);
        if apply_idf {
            // Mirrors annotator.ts: dictionary + identifier sources get IDF penalty.
            // "body" is the Rust name for body-text identifier matches (TS: "identifier").
            let is_body_source = matches!(
                mention.source,
                MentionSource::Body | MentionSource::Identifier | MentionSource::Dictionary
            );
            if is_body_source {
                confidence *= idf_score.max(IDF_PENALTY_FLOOR);
            }
        }

        annotations.push(Annotation {
            doc_path: doc.path.clone(),
            line: mention.line,
            text: mention.text.clone(),
            symbol_id,
            confidence,
            source: mention.source.as_str().to_string(),
            qualifier: None,
            idf_score,
            char_start: mention.char_start,
            char_end: mention.char_end,
        });
    }

    annotations
}

// ── IDF helper ──────────────────────────────────────────────────────────────

fn build_idf_scores(doc_files: &[DocFile]) -> HashMap<String, f64> {
    if doc_files.is_empty() {
        return HashMap::new();
    }

    let mut df: HashMap<String, usize> = HashMap::new();
    for doc in doc_files {
        let mut seen: HashSet<String> = HashSet::new();
        for mention in &doc.mentions {
            let norm = mention.text.to_lowercase();
            if seen.insert(norm.clone()) {
                *df.entry(norm).or_default() += 1;
            }
        }
    }

    idf::compute_idf(doc_files.len(), &df)
}

// ── Public entry point ──────────────────────────────────────────────────────

/// Run the annotation stage: match all doc mentions to code symbols.
///
/// Returns annotations sorted by `(doc_path, line)` for deterministic output
/// and stable DB inserts.
pub fn run(ax: &AxResult, kwx: &KwxResult, opts: &BuildOpts) -> Result<AnnotateResult> {
    let index = SymbolIndex::build(&ax.symbols);
    let apply_idf = opts.depth == Depth::Full;
    let idf_scores = if apply_idf {
        build_idf_scores(&kwx.doc_files)
    } else {
        HashMap::new()
    };

    // Process each doc file in parallel; flatten into a single Vec.
    let mut annotations: Vec<Annotation> = kwx
        .doc_files
        .par_iter()
        .flat_map(|doc| annotate_doc(doc, &index, &idf_scores, apply_idf))
        .collect();

    // Sort for deterministic order and stable INSERT OR REPLACE semantics.
    annotations.sort_by(|a, b| {
        a.doc_path
            .cmp(&b.doc_path)
            .then_with(|| a.line.cmp(&b.line))
    });

    Ok(AnnotateResult { annotations })
}

// ── String helpers ──────────────────────────────────────────────────────────

/// Remove all non-alphanumeric characters and lowercase — the "slug" form.
pub fn to_slug(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Split a camelCase / PascalCase / separator-delimited name into lowercase
/// tokens, following the same algorithm as `splitCamelCase` in annotator.ts.
///
/// Examples:
/// * `"IndexCoChange"` → `["index", "co", "change"]`
/// * `"TCGPipeline"` → `["tcg", "pipeline"]`
/// * `"auth-service"` → `["auth", "service"]`
pub fn split_camel_case(name: &str) -> Vec<String> {
    let chars: Vec<char> = name.chars().collect();
    let n = chars.len();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();

    for i in 0..n {
        let c = chars[i];

        // Separator characters → flush current token
        if matches!(c, '_' | '-' | '.' | '/' | ' ') {
            if !current.is_empty() {
                parts.push(current.to_lowercase());
                current = String::new();
            }
            continue;
        }

        if c.is_uppercase() {
            let prev_is_lower = i > 0 && chars[i - 1].is_lowercase();
            let prev_is_upper = i > 0 && chars[i - 1].is_uppercase();
            let next_is_lower = i + 1 < n && chars[i + 1].is_lowercase();

            // Case 1: lowercase→Uppercase boundary (e.g. "Index|Co")
            let split_at_lower_upper = prev_is_lower;
            // Case 2: end of an uppercase run before a lowercase letter (e.g. "TCG|Pipeline")
            let split_at_run_end = prev_is_upper && next_is_lower && !current.is_empty();

            if split_at_lower_upper || split_at_run_end {
                if !current.is_empty() {
                    parts.push(current.to_lowercase());
                    current = String::new();
                }
            }
        }

        current.push(c);
    }

    if !current.is_empty() {
        parts.push(current.to_lowercase());
    }

    parts.into_iter().filter(|p| !p.is_empty()).collect()
}

/// Tokenize a mention phrase: split at camelCase boundaries and separators.
pub fn tokenize(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut spaced = String::with_capacity(n + 8);

    for i in 0..n {
        let c = chars[i];
        if matches!(c, '-' | '_' | '.' | '/' | ' ' | '\t') {
            spaced.push(' ');
        } else if c.is_uppercase() && i > 0 && chars[i - 1].is_lowercase() {
            // camelCase boundary
            spaced.push(' ');
            spaced.push(c);
        } else {
            spaced.push(c);
        }
    }

    spaced
        .to_lowercase()
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AxResult, BuildOpts, Depth, DocFile, KwxResult, Mention, MentionSource, Symbol};
    use std::path::PathBuf;

    // ── Helpers ──────────────────────────────────────────────────────────

    fn make_symbol(name: &str, file: &str, export: bool) -> Symbol {
        Symbol {
            name: name.to_string(),
            kind: "function".to_string(),
            container: None,
            signature: None,
            file_path: file.to_string(),
            line: Some(1),
            end_line: None,
            export,
            doc_summary: None,
            body_hash: None,
            body_lines: None,
            structure_hash: None,
            implements: None,
            deprecated: false,
            deprecated_note: None,
            is_internal: false,
            decorators: None,
        }
    }

    fn make_mention(text: &str, source: MentionSource, line: i64) -> Mention {
        Mention {
            line,
            text: text.to_string(),
            source,
            char_start: None,
            char_end: None,
        }
    }

    fn make_ax(symbols: Vec<Symbol>) -> AxResult {
        AxResult {
            symbols,
            files: vec![],
            imports: vec![],
            todos: vec![],
            rationale: vec![],
            calls: vec![],
        }
    }

    fn make_kwx(doc_path: &str, mentions: Vec<Mention>) -> KwxResult {
        KwxResult {
            doc_files: vec![DocFile {
                path: doc_path.to_string(),
                is_doc: true,
                doc_group: None,
                mentions,
            }],
        }
    }

    fn opts(depth: Depth) -> BuildOpts {
        BuildOpts {
            root: PathBuf::from("/tmp"),
            paths: vec![],
            depth,
            output: PathBuf::from("/tmp/test.db"),
            verbose: false,
        }
    }

    // ── String helper tests ───────────────────────────────────────────────

    #[test]
    fn test_to_slug_removes_punctuation_and_lowercases() {
        assert_eq!(to_slug("co-occurrence"), "cooccurrence");
        assert_eq!(to_slug("AuthService"), "authservice");
        assert_eq!(to_slug("IDF_Score"), "idfscore");
    }

    #[test]
    fn test_split_camel_case_index_co_change() {
        assert_eq!(
            split_camel_case("IndexCoChange"),
            vec!["index", "co", "change"]
        );
    }

    #[test]
    fn test_split_camel_case_tcg_pipeline() {
        assert_eq!(split_camel_case("TCGPipeline"), vec!["tcg", "pipeline"]);
    }

    #[test]
    fn test_split_camel_case_separators() {
        assert_eq!(split_camel_case("auth-service"), vec!["auth", "service"]);
        assert_eq!(split_camel_case("build_opts"), vec!["build", "opts"]);
    }

    #[test]
    fn test_tokenize_camel_and_separators() {
        let t = tokenize("buildPipeline");
        assert_eq!(t, vec!["build", "pipeline"]);

        let t2 = tokenize("auth-service setup");
        assert_eq!(t2, vec!["auth", "service", "setup"]);
    }

    // ── Annotation matching tests ─────────────────────────────────────────

    #[test]
    fn test_exact_match_produces_confidence_one() {
        let ax = make_ax(vec![make_symbol("AuthService", "src/auth.ts", true)]);
        let kwx = make_kwx("docs/auth.md", vec![make_mention("AuthService", MentionSource::Bold, 5)]);
        let ann = run(&ax, &kwx, &opts(Depth::Structured)).unwrap();

        assert_eq!(ann.annotations.len(), 1);
        let a = &ann.annotations[0];
        assert!((a.confidence - 1.0).abs() < 1e-9, "expected exact confidence 1.0, got {}", a.confidence);
        assert!(a.symbol_id.is_some(), "expected grounded symbol_id");
    }

    #[test]
    fn test_slug_match_confidence_point_eight() {
        // "co-occurrence" (slug "cooccurrence") should match "CoOccurrence"
        let ax = make_ax(vec![make_symbol("CoOccurrence", "src/cox.ts", true)]);
        let kwx = make_kwx("docs/cox.md", vec![make_mention("co-occurrence", MentionSource::Bold, 3)]);
        let ann = run(&ax, &kwx, &opts(Depth::Structured)).unwrap();

        assert_eq!(ann.annotations.len(), 1);
        let a = &ann.annotations[0];
        assert!((a.confidence - 0.8).abs() < 1e-9, "expected slug confidence 0.8, got {}", a.confidence);
        assert!(a.symbol_id.is_some());
    }

    #[test]
    fn test_token_match_confidence_point_five() {
        // Mention "build the pipeline" → token "pipeline" is a symbol name
        let ax = make_ax(vec![make_symbol("pipeline", "src/pipeline.ts", true)]);
        let kwx = make_kwx("docs/overview.md", vec![make_mention("build the pipeline", MentionSource::Body, 10)]);
        let ann = run(&ax, &kwx, &opts(Depth::Structured)).unwrap();

        assert_eq!(ann.annotations.len(), 1);
        let a = &ann.annotations[0];
        assert!((a.confidence - 0.5).abs() < 1e-9, "expected token confidence 0.5, got {}", a.confidence);
        assert!(a.symbol_id.is_some());
    }

    #[test]
    fn test_ungrounded_mention_confidence_point_one() {
        let ax = make_ax(vec![]); // no symbols
        let kwx = make_kwx("docs/overview.md", vec![make_mention("totally-unknown-term", MentionSource::Body, 1)]);
        let ann = run(&ax, &kwx, &opts(Depth::Structured)).unwrap();

        assert_eq!(ann.annotations.len(), 1);
        let a = &ann.annotations[0];
        assert!(a.symbol_id.is_none(), "expected no symbol_id for ungrounded");
        assert!((a.confidence - 0.1).abs() < 1e-9, "expected ungrounded confidence 0.1, got {}", a.confidence);
    }

    #[test]
    fn test_heading_ungrounded_confidence_point_three() {
        let ax = make_ax(vec![]); // no symbols
        let kwx = make_kwx("docs/arch.md", vec![make_mention("Overview", MentionSource::Heading, 1)]);
        let ann = run(&ax, &kwx, &opts(Depth::Structured)).unwrap();

        assert_eq!(ann.annotations.len(), 1);
        let a = &ann.annotations[0];
        assert!(a.symbol_id.is_none());
        assert!((a.confidence - 0.3).abs() < 1e-9, "expected heading ungrounded 0.3, got {}", a.confidence);
    }

    #[test]
    fn test_idf_penalty_reduces_confidence_in_full_depth() {
        // "pipeline" is a symbol; mention in Body source gets IDF penalty.
        let ax = make_ax(vec![make_symbol("pipeline", "src/pipeline.ts", true)]);
        // Two docs — "pipeline" appears in both → df["pipeline"] = 2, idf will be low.
        let kwx = KwxResult {
            doc_files: vec![
                DocFile {
                    path: "docs/a.md".to_string(),
                    is_doc: true,
                    doc_group: None,
                    mentions: vec![make_mention("pipeline", MentionSource::Body, 1)],
                },
                DocFile {
                    path: "docs/b.md".to_string(),
                    is_doc: true,
                    doc_group: None,
                    mentions: vec![make_mention("pipeline", MentionSource::Body, 1)],
                },
            ],
        };
        let ann = run(&ax, &kwx, &opts(Depth::Full)).unwrap();

        // Both are exact matches (conf 1.0) but with IDF penalty for Body source.
        // With 2 docs and df=2: idf = ln(2/3) normalized → a very low score.
        // The key invariant is confidence < 1.0.
        for a in &ann.annotations {
            assert!(a.confidence < 1.0, "IDF penalty should reduce confidence below 1.0");
        }
    }

    #[test]
    fn test_camel_suffix_slug_matches() {
        // "IndexCoChange" registers suffix slug "cochange" (from "co" + "change")
        // → "co-change" (slug "cochange") should match via that suffix
        let ax = make_ax(vec![make_symbol("IndexCoChange", "src/index.ts", true)]);
        let kwx = make_kwx("docs/changes.md", vec![make_mention("co-change", MentionSource::Bold, 7)]);
        let ann = run(&ax, &kwx, &opts(Depth::Structured)).unwrap();

        assert_eq!(ann.annotations.len(), 1);
        let a = &ann.annotations[0];
        // slug "cochange" (8 chars ≥ 5) matches via suffix slug → confidence 0.8
        assert!((a.confidence - 0.8).abs() < 1e-9, "expected slug confidence 0.8, got {}", a.confidence);
        assert!(a.symbol_id.is_some());
    }

    #[test]
    fn test_parallel_output_sorted_by_doc_then_line() {
        let ax = make_ax(vec![make_symbol("run", "src/main.ts", true)]);
        let kwx = KwxResult {
            doc_files: vec![
                DocFile {
                    path: "docs/z.md".to_string(),
                    is_doc: true,
                    doc_group: None,
                    mentions: vec![
                        make_mention("run", MentionSource::Bold, 5),
                        make_mention("run", MentionSource::Bold, 2),
                    ],
                },
                DocFile {
                    path: "docs/a.md".to_string(),
                    is_doc: true,
                    doc_group: None,
                    mentions: vec![make_mention("run", MentionSource::Bold, 1)],
                },
            ],
        };
        let ann = run(&ax, &kwx, &opts(Depth::Structured)).unwrap();

        assert_eq!(ann.annotations.len(), 3);
        assert_eq!(ann.annotations[0].doc_path, "docs/a.md");
        assert_eq!(ann.annotations[0].line, 1);
        assert_eq!(ann.annotations[1].doc_path, "docs/z.md");
        assert_eq!(ann.annotations[1].line, 2);
        assert_eq!(ann.annotations[2].doc_path, "docs/z.md");
        assert_eq!(ann.annotations[2].line, 5);
    }
}

