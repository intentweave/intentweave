// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! KWX — Keyword extraction stage. Phase R1-a.
//!
//! Walks documentation files (.md, .mdx, .rst, .txt, .adoc) and extracts
//! keyword mentions at multiple syntactic levels using pulldown-cmark.
//! Mirrors `packages/analyzer/src/kwg/heuristicExtractor.ts` logic.
//!
//! ## Extraction sources (by priority / confidence)
//!
//! | Source      | pulldown-cmark event          | Depth   | Confidence |
//! |-------------|-------------------------------|---------|------------|
//! | Heading     | `Start(Tag::Heading(..))` text| both    | 1.0        |
//! | Bold        | `Start(Tag::Strong)` text     | both    | 0.9        |
//! | CodeSpan    | `Code(text)`                  | both    | 0.95       |
//! | Identifier  | PascalCase/camelCase in text  | both    | 0.8        |
//! | Body        | Plain text paragraphs         | full    | 0.6        |
//!
//! ## Parallelism
//! Files are collected in a single-threaded walk then processed with
//! `rayon::par_iter()` — each file is fully independent.

use anyhow::Result;
use ignore::WalkBuilder;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use rayon::prelude::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::types::{AxResult, BuildOpts, Depth, DocFile, KwxResult, Mention, MentionSource};

// ---------------------------------------------------------------------------
// Noise words — mirrors heuristicExtractor.ts NOISE_WORDS
// ---------------------------------------------------------------------------

static NOISE_WORDS: &[&str] = &[
    // English function words
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
    "her", "was", "one", "our", "out", "has", "its", "let", "say", "she",
    "too", "use", "how", "why", "see", "now", "way", "may", "also", "then",
    "than", "that", "this", "with", "will", "each", "make", "like", "from",
    "have", "been", "just", "more", "over", "such", "note", "todo", "done",
    "here", "true", "false", "null",
    // Markdown structural noise
    "table", "example", "summary", "overview", "introduction", "conclusion",
    "appendix", "references", "changelog", "version", "status", "usage",
    "setup", "install", "important", "warning", "deprecated",
];

fn noise_set() -> HashSet<&'static str> {
    NOISE_WORDS.iter().copied().collect()
}

// ---------------------------------------------------------------------------
// File classification — mirrors isDocFile() / classifyDocGroup() in writer.ts
// ---------------------------------------------------------------------------

/// Returns true for documentation file extensions.
pub fn is_doc_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    matches!(ext.as_str(), "md" | "mdx" | "rst" | "txt" | "adoc")
}

/// Classify a documentation file into a group.
/// Mirrors `classifyDocGroup()` in writer.ts.
pub fn classify_doc_group(file_path: &str) -> String {
    let lower = file_path.to_lowercase();
    let base = Path::new(&lower)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    if base.starts_with("readme") {
        return "readme".to_string();
    }
    if base.starts_with("changelog") || base.starts_with("release") {
        return "changelog".to_string();
    }
    if base.starts_with("contributing") || base.starts_with("code_of_conduct") {
        return "contributing".to_string();
    }
    if base.starts_with("license") || base.starts_with("licence") {
        return "license".to_string();
    }
    if lower.contains("/api/") || lower.contains("/reference/") {
        return "api-reference".to_string();
    }
    if lower.contains("/architecture")
        || lower.contains("/design")
        || lower.contains("/decisions")
        || lower.contains("/adr")
    {
        return "architecture".to_string();
    }
    if lower.contains("/spec") || lower.contains("/requirement") {
        return "specification".to_string();
    }
    if lower.contains("/guide") || lower.contains("/tutorial") {
        return "guide".to_string();
    }
    if lower.contains("/docs/") || lower.contains("/doc/") {
        return "project-docs".to_string();
    }
    "other".to_string()
}

// ---------------------------------------------------------------------------
// Identifier heuristics
// ---------------------------------------------------------------------------

/// Returns true if the string looks like a PascalCase identifier.
fn is_pascal_case(s: &str) -> bool {
    if s.len() < 2 {
        return false;
    }
    let mut chars = s.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    first.is_uppercase()
        && chars.clone().all(|c| c.is_alphanumeric())
        && chars.any(|c| c.is_lowercase())
}

/// Returns true if the string looks like a camelCase identifier.
fn is_camel_case(s: &str) -> bool {
    if s.len() < 2 {
        return false;
    }
    let mut chars = s.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    first.is_lowercase()
        && chars.clone().all(|c| c.is_alphanumeric())
        && chars.any(|c| c.is_uppercase())
}

/// Extract PascalCase and camelCase identifiers from text.
/// Returns Vec of (word, byte_start_in_text, byte_end_in_text).
fn extract_identifiers(text: &str, noise: &HashSet<&str>) -> Vec<(String, usize, usize)> {
    let mut results = Vec::new();
    let mut word_start: Option<usize> = None;

    for (byte_pos, ch) in text.char_indices() {
        let is_alnum = ch.is_alphanumeric();
        if is_alnum && word_start.is_none() {
            word_start = Some(byte_pos);
        } else if !is_alnum {
            if let Some(start) = word_start.take() {
                let word = &text[start..byte_pos];
                if word.len() >= 2
                    && !noise.contains(word.to_lowercase().as_str())
                    && (is_pascal_case(word) || is_camel_case(word))
                {
                    results.push((word.to_string(), start, byte_pos));
                }
            }
        }
    }
    // Flush the last word
    if let Some(start) = word_start {
        let word = &text[start..];
        if word.len() >= 2
            && !noise.contains(word.to_lowercase().as_str())
            && (is_pascal_case(word) || is_camel_case(word))
        {
            results.push((word.to_string(), start, text.len()));
        }
    }
    results
}

/// Normalize a keyword — lowercase, trim, collapse whitespace.
fn normalize(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Line index — O(log n) byte-offset → line number lookup
// ---------------------------------------------------------------------------

fn build_line_index(text: &str) -> Vec<usize> {
    let mut idx = vec![0usize];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            idx.push(i + 1);
        }
    }
    idx
}

fn byte_to_line(line_idx: &[usize], byte_pos: usize) -> i64 {
    match line_idx.binary_search(&byte_pos) {
        Ok(i) => (i + 1) as i64,
        Err(i) => i as i64,
    }
}

// ---------------------------------------------------------------------------
// Dictionary matching helpers (full depth only)
// ---------------------------------------------------------------------------

/// True for characters that form a "word" boundary in JS `\b` sense.
/// Mirrors `\w` = `[A-Za-z0-9_]`.
#[inline]
fn is_word_byte(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_')
}

/// Strip markdown for body-text dictionary scan.
/// - Blanks heading lines (preserves line count)
/// - Strips inline markdown markers: **bold**, _italic_, `code`, [links](url)
/// Mirrors `stripInlineMarkdown(text.replace(/^#{1,6}\s+.+$/gm, ""))` in TS.
fn strip_for_dictionary(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') && !trimmed.starts_with("#!") {
            // Blank heading lines — keep newline for line-count fidelity
            out.push('\n');
            continue;
        }
        // Strip inline markdown: **bold**, __bold__, *italic*, _italic_, `code`, [text](url)
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '*' if chars.peek() == Some(&'*') => {
                    // skip second *; content will be emitted naturally
                    chars.next();
                }
                '_' if chars.peek() == Some(&'_') => {
                    chars.next();
                }
                '*' | '_' => { /* skip single marker */ }
                '`' => { /* skip backtick */ }
                '[' => {
                    // [text](url) → emit text, skip (url)
                    for ch2 in chars.by_ref() {
                        if ch2 == ']' { break; }
                        out.push(ch2);
                    }
                    // Skip (url)
                    if chars.peek() == Some(&'(') {
                        chars.next();
                        for ch2 in chars.by_ref() {
                            if ch2 == ')' { break; }
                        }
                    }
                }
                _ => out.push(ch),
            }
        }
        out.push('\n');
    }
    out
}

/// Scan body text for word-boundary occurrences of known dictionary terms,
/// processing each Markdown section independently.
///
/// The TS IN stage splits documents into per-heading chunks and runs
/// `extractor.extract()` on each chunk with a fresh `seen` set, meaning the
/// same dictionary term can be emitted once per section where it appears.
/// We replicate that by identifying section boundaries from the original
/// content (heading lines) and resetting `seen_in_section` at each boundary.
///
/// `strip_for_dictionary` preserves line count, so line N in the original
/// maps to line N in the stripped text — the `stripped_line_idx` offsets are
/// used for both section-boundary mapping and position reporting.
///
/// Mirrors `extractDictionary()` in heuristicExtractor.ts (called per-chunk).
fn extract_dictionary_mentions(
    content: &str,
    already_seen: &HashSet<String>,
    dictionary: &HashSet<String>,
    noise: &HashSet<&str>,
) -> Vec<Mention> {
    if dictionary.is_empty() {
        return Vec::new();
    }

    let stripped = strip_for_dictionary(content);
    let stripped_line_idx = build_line_index(&stripped);
    let stripped_bytes = stripped.as_bytes();
    let len = stripped_bytes.len();

    // ── Build section boundaries from heading lines in original content ──────
    // Each heading line starts a new section.  The first section always starts
    // at byte 0; each subsequent section starts at the byte offset of the
    // corresponding line in the stripped text (line count is preserved).
    let mut section_starts: Vec<usize> = vec![0];
    for (line_no, line) in content.lines().enumerate() {
        if line_no == 0 {
            continue; // first section already recorded at 0
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') && !trimmed.starts_with("#!") {
            let byte_start = if line_no < stripped_line_idx.len() {
                stripped_line_idx[line_no]
            } else {
                len
            };
            section_starts.push(byte_start);
        }
    }
    section_starts.push(len); // sentinel

    // ── Scan each section with its own seen-set ───────────────────────────────
    let mut all_mentions = Vec::new();
    for window in section_starts.windows(2) {
        let sect_start = window[0];
        let sect_end = window[1];
        let mut seen_in_section: HashSet<String> = HashSet::new();
        let mut i = sect_start;

        while i < sect_end {
            while i < sect_end && !is_word_byte(stripped_bytes[i]) {
                i += 1;
            }
            if i >= sect_end {
                break;
            }
            let word_start = i;
            while i < sect_end && is_word_byte(stripped_bytes[i]) {
                i += 1;
            }
            let word_end = i;

            // Safety: word_start..word_end are ASCII-only token boundaries.
            let word = &stripped[word_start..word_end];
            let word_lower = word.to_lowercase();

            if word_lower.len() < 3 { continue; }
            if noise.contains(word_lower.as_str()) { continue; }
            if already_seen.contains(&word_lower) { continue; }
            if seen_in_section.contains(&word_lower) { continue; }

            if dictionary.contains(&word_lower) {
                let line = byte_to_line(&stripped_line_idx, word_start);
                all_mentions.push(Mention {
                    line,
                    text: word_lower.clone(),
                    source: MentionSource::Dictionary,
                    char_start: Some(word_start as i64),
                    char_end: Some(word_end as i64),
                });
                seen_in_section.insert(word_lower);
            }
        }
    }

    all_mentions
}



#[derive(Debug, Clone, PartialEq)]
enum ContextTag {
    Heading,
    Strong,
    CodeBlock,
}

fn extract_markdown_mentions(
    content: &str,
    depth: &Depth,
    noise: &HashSet<&str>,
    dictionary: Option<&HashSet<String>>,
) -> Vec<Mention> {
    let line_idx = build_line_index(content);
    let mut mentions: Vec<Mention> = Vec::new();

    let mut ctx_stack: Vec<ContextTag> = Vec::new();
    let mut ctx_text = String::new();
    let mut ctx_byte_start: usize = 0;

    let options = Options::empty();
    let parser = Parser::new_ext(content, options);

    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { .. }) => {
                ctx_stack.push(ContextTag::Heading);
                ctx_text.clear();
                ctx_byte_start = range.start;
            }

            Event::Start(Tag::Strong) => {
                ctx_stack.push(ContextTag::Strong);
                ctx_text.clear();
                ctx_byte_start = range.start;
            }

            Event::Start(Tag::CodeBlock(_)) => {
                ctx_stack.push(ContextTag::CodeBlock);
                ctx_text.clear();
                ctx_byte_start = range.start;
            }

            Event::End(TagEnd::Heading(_)) => {
                if ctx_stack.last() == Some(&ContextTag::Heading) {
                    ctx_stack.pop();
                }
                let text = ctx_text.trim().to_string();
                if !text.is_empty() {
                    let norm = normalize(&text);
                    if norm.len() >= 3 && !noise.contains(norm.as_str()) {
                        let line = byte_to_line(&line_idx, ctx_byte_start);
                        mentions.push(Mention {
                            line,
                            text: norm,
                            source: MentionSource::Heading,
                            char_start: Some(ctx_byte_start as i64),
                            char_end: Some(range.end as i64),
                        });
                    }
                    // Also extract individual identifiers from heading text.
                    // Mirrors TS HeuristicKeywordExtractor which runs the
                    // PascalCase/camelCase regex over the ENTIRE document text
                    // (including heading lines), producing an extra mention per
                    // identifier found inside a heading.
                    for (word, rel_start, _) in extract_identifiers(&text, noise) {
                        let word_norm = normalize(&word);
                        if word_norm.len() >= 2 {
                            let abs_start = ctx_byte_start + rel_start;
                            let line = byte_to_line(&line_idx, abs_start);
                            mentions.push(Mention {
                                line,
                                text: word_norm,
                                source: MentionSource::Identifier,
                                char_start: Some(abs_start as i64),
                                char_end: None,
                            });
                        }
                    }
                }
                ctx_text.clear();
            }

            Event::End(TagEnd::Strong) => {
                if ctx_stack.last() == Some(&ContextTag::Strong) {
                    ctx_stack.pop();
                }
                let text = ctx_text.trim().to_string();
                if !text.is_empty() {
                    let norm = normalize(&text);
                    if norm.len() >= 3 && !noise.contains(norm.as_str()) {
                        let line = byte_to_line(&line_idx, ctx_byte_start);
                        mentions.push(Mention {
                            line,
                            text: norm,
                            source: MentionSource::Bold,
                            char_start: Some(ctx_byte_start as i64),
                            char_end: Some(range.end as i64),
                        });
                    }
                    // Also extract identifiers within bold text (mirrors TS behaviour).
                    for (word, rel_start, _) in extract_identifiers(&text, noise) {
                        let word_norm = normalize(&word);
                        if word_norm.len() >= 2 {
                            let abs_start = ctx_byte_start + rel_start;
                            let line = byte_to_line(&line_idx, abs_start);
                            mentions.push(Mention {
                                line,
                                text: word_norm,
                                source: MentionSource::Identifier,
                                char_start: Some(abs_start as i64),
                                char_end: None,
                            });
                        }
                    }
                }
                ctx_text.clear();
            }

            Event::End(TagEnd::CodeBlock) => {
                if ctx_stack.last() == Some(&ContextTag::CodeBlock) {
                    ctx_stack.pop();
                }
                // Extract identifiers from code block content
                let identifiers = extract_identifiers(&ctx_text, noise);
                for (word, rel_start, rel_end) in identifiers {
                    let abs_start = ctx_byte_start + rel_start;
                    let abs_end = ctx_byte_start + rel_end;
                    let line = byte_to_line(&line_idx, abs_start);
                    mentions.push(Mention {
                        line,
                        text: normalize(&word),
                        source: MentionSource::Identifier,
                        char_start: Some(abs_start as i64),
                        char_end: Some(abs_end as i64),
                    });
                }
                ctx_text.clear();
            }

            // Inline code span: `` `text` ``
            Event::Code(text) => {
                let t = text.trim();
                if t.len() >= 2 && !noise.contains(t.to_lowercase().as_str()) {
                    let norm = normalize(t);
                    if !norm.is_empty() {
                        let line = byte_to_line(&line_idx, range.start);
                        mentions.push(Mention {
                            line,
                            text: norm,
                            source: MentionSource::CodeSpan,
                            char_start: Some(range.start as i64),
                            char_end: Some(range.end as i64),
                        });
                    }
                }
            }

            Event::Text(text) => {
                match ctx_stack.last() {
                    // Accumulate text inside heading or bold
                    Some(ContextTag::Heading) | Some(ContextTag::Strong) => {
                        ctx_text.push_str(&text);
                    }
                    // Accumulate text inside code block
                    Some(ContextTag::CodeBlock) => {
                        ctx_text.push_str(&text);
                    }
                    // Body text
                    None => {
                        let identifiers = extract_identifiers(&text, noise);
                        let source = match depth {
                            Depth::Full => MentionSource::Body,
                            Depth::Structured => MentionSource::Identifier,
                        };
                        for (word, rel_start, rel_end) in identifiers {
                            let abs_start = range.start + rel_start;
                            let abs_end = range.start + rel_end;
                            let line = byte_to_line(&line_idx, abs_start);
                            mentions.push(Mention {
                                line,
                                text: normalize(&word),
                                source: source.clone(),
                                char_start: Some(abs_start as i64),
                                char_end: Some(abs_end as i64),
                            });
                        }
                    }
                }
            }

            _ => {}
        }
    }

    // ── Dictionary pass (full depth only) ────────────────────────────────────
    // Scan body text for word-boundary occurrences of known symbol names not
    // already found by the structured extractors above.
    // Mirrors `extractDictionary()` in heuristicExtractor.ts.
    if matches!(depth, Depth::Full) {
        if let Some(dict) = dictionary {
            let already_seen: HashSet<String> =
                mentions.iter().map(|m| m.text.clone()).collect();
            let dict_mentions =
                extract_dictionary_mentions(content, &already_seen, dict, noise);
            mentions.extend(dict_mentions);
        }
    }

    mentions
}

// ---------------------------------------------------------------------------
// Plain text extraction (.rst, .txt, .adoc)
// ---------------------------------------------------------------------------

fn extract_plaintext_mentions(
    content: &str,
    depth: &Depth,
    noise: &HashSet<&str>,
    dictionary: Option<&HashSet<String>>,
) -> Vec<Mention> {
    let mut mentions = Vec::new();
    let source = match depth {
        Depth::Full => MentionSource::Body,
        Depth::Structured => MentionSource::Identifier,
    };
    for (line_num, line) in content.lines().enumerate() {
        let line_1based = (line_num + 1) as i64;
        for (word, _, _) in extract_identifiers(line, noise) {
            mentions.push(Mention {
                line: line_1based,
                text: word,
                source: source.clone(),
                char_start: None,
                char_end: None,
            });
        }
    }
    // Dictionary pass (full depth only)
    if matches!(depth, Depth::Full) {
        if let Some(dict) = dictionary {
            let already_seen: HashSet<String> =
                mentions.iter().map(|m| m.text.clone()).collect();
            let dict_mentions =
                extract_dictionary_mentions(content, &already_seen, dict, noise);
            mentions.extend(dict_mentions);
        }
    }
    mentions
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

fn process_file(
    abs_path: &Path,
    root: &Path,
    depth: &Depth,
    noise: &HashSet<&str>,
    dictionary: Option<&HashSet<String>>,
) -> Option<DocFile> {
    let content = std::fs::read_to_string(abs_path).ok()?;
    // Store relative path (matches TypeScript pipeline behaviour).
    let rel_path = abs_path
        .strip_prefix(root)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .to_string();
    let ext = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mentions = match ext.as_str() {
        "md" | "mdx" => extract_markdown_mentions(&content, depth, noise, dictionary),
        _ => extract_plaintext_mentions(&content, depth, noise, dictionary),
    };

    Some(DocFile {
        path: rel_path.clone(),
        is_doc: true,
        doc_group: Some(classify_doc_group(&rel_path)),
        mentions,
    })
}

// ---------------------------------------------------------------------------
// Source-file comment extraction
// ---------------------------------------------------------------------------

/// Extract comment content from a source file, blanking out non-comment lines.
/// Preserves line count so line numbers stay correct in the resulting annotations.
/// Mirrors `extractSourceCommentContent()` in packages/index/src/facade.ts.
fn extract_source_comment_content(source: &str) -> String {
    let mut result: Vec<String> = Vec::new();
    let mut in_block = false;

    for line in source.lines() {
        let trimmed = line.trim();

        if in_block {
            if let Some(end_pos) = trimmed.find("*/") {
                let before = &trimmed[..end_pos];
                let stripped = before.trim_start_matches('*').trim_start_matches(' ');
                result.push(stripped.trim().to_string());
                in_block = false;
            } else {
                let stripped = trimmed.trim_start_matches('*').trim_start_matches(' ');
                result.push(stripped.to_string());
            }
        } else if trimmed.starts_with("/**") || trimmed.starts_with("/*") {
            in_block = true;
            // Strip opening delimiter: /** or /* (plus any leading asterisks/spaces)
            let after_open = if trimmed.starts_with("/**") {
                trimmed[3..].trim_start_matches('*').trim_start()
            } else {
                trimmed[2..].trim_start()
            };
            if let Some(end_pos) = after_open.find("*/") {
                // Single-line block: /** Foo */ or /* Foo */
                result.push(after_open[..end_pos].trim().to_string());
                in_block = false;
            } else {
                result.push(after_open.trim().to_string());
            }
        } else if trimmed.starts_with("//") {
            let content = trimmed[2..].trim_start_matches(' ').trim();
            result.push(content.to_string());
        } else if trimmed.starts_with('#') && !trimmed.starts_with("#!") {
            // Python / shell style
            let content = trimmed[1..].trim_start_matches(' ').trim();
            result.push(content.to_string());
        } else {
            result.push(String::new()); // blank out code lines — preserves line numbers
        }
    }

    result.join("\n")
}

/// Source-file extensions eligible for comment-based KWX processing.
/// Mirrors `SOURCE_COMMENT_EXTS` in facade.ts.
const SOURCE_COMMENT_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "py", "swift", "go", "java", "cs",
];

/// Process a source file by extracting keyword mentions from its comments only.
/// `rel_path` is the path used as `DocFile.path` (relative to workspace root).
/// Always uses Full depth — mirrors TS: `depth: "full"` for comment extraction.
fn process_source_file(
    abs_path: &Path,
    rel_path: &str,
    noise: &HashSet<&str>,
    dictionary: Option<&HashSet<String>>,
) -> Option<DocFile> {
    let content = std::fs::read_to_string(abs_path).ok()?;
    let comment_content = extract_source_comment_content(&content);
    if comment_content.trim().is_empty() {
        return None;
    }
    // Always use Full depth for comment content (mirrors TS facade.ts).
    let mentions = extract_plaintext_mentions(&comment_content, &Depth::Full, noise, dictionary);
    if mentions.is_empty() {
        return None;
    }
    Some(DocFile {
        path: rel_path.to_string(),
        is_doc: false,
        doc_group: None,
        mentions,
    })
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

fn collect_doc_paths(opts: &BuildOpts) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for base in &opts.paths {
        // hidden(false) so that .github/ and other dot-directories are included.
        // Mirrors the TypeScript discoverFilesRecursive() which uses its own
        // recursive walker and does not skip hidden directories.
        for entry in WalkBuilder::new(base).hidden(false).build() {
            match entry {
                Ok(e) => {
                    if e.file_type().map(|ft| ft.is_file()).unwrap_or(false)
                        && is_doc_file(e.path())
                    {
                        paths.push(e.into_path());
                    }
                }
                Err(e) => {
                    eprintln!("[kwx] walk error: {e}");
                }
            }
        }
    }
    Ok(paths)
}

// ---------------------------------------------------------------------------
// Stage entry point
// ---------------------------------------------------------------------------

/// Run KWX stage: extract keyword mentions from documentation files in parallel,
/// then run a second pass over source-file comments from the AX result.
/// Mirrors stages 2 and 2b in `buildFromPaths()` (facade.ts).
pub fn run(opts: &BuildOpts, ax: &AxResult) -> Result<KwxResult> {
    let doc_paths = collect_doc_paths(opts)?;

    if opts.verbose {
        eprintln!("[kwx] found {} doc files", doc_paths.len());
    }

    let noise: HashSet<&'static str> = noise_set();
    let depth = opts.depth.clone();

    // Build symbol dictionary for body-text matching (full depth only).
    // Mirrors `symbolDictionary` in facade.ts — lowercase symbol names from AX.
    let dictionary: Option<HashSet<String>> = if matches!(depth, Depth::Full) {
        let dict: HashSet<String> = ax
            .symbols
            .iter()
            .map(|s| s.name.to_lowercase())
            .collect();
        Some(dict)
    } else {
        None
    };
    let dict_ref: Option<&HashSet<String>> = dictionary.as_ref();

    let root = opts.root.as_path();
    let mut doc_files: Vec<DocFile> = doc_paths
        .par_iter()
        .filter_map(|path| process_file(path, root, &depth, &noise, dict_ref))
        .collect();

    if opts.verbose {
        let total_mentions: usize = doc_files.iter().map(|df| df.mentions.len()).sum();
        eprintln!(
            "[kwx] {} doc files → {} mentions",
            doc_files.len(),
            total_mentions
        );
    }

    // ── KWX pass 2: source-file comments ─────────────────────────────────────
    let source_doc_files: Vec<DocFile> = ax
        .files
        .par_iter()
        .filter_map(|file_entry| {
            let ext = Path::new(&file_entry.path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !SOURCE_COMMENT_EXTS.contains(&ext.as_str()) {
                return None;
            }
            let abs_path = opts.root.join(&file_entry.path);
            process_source_file(&abs_path, &file_entry.path, &noise, dict_ref)
        })
        .collect();

    if opts.verbose && !source_doc_files.is_empty() {
        let src_mentions: usize = source_doc_files.iter().map(|df| df.mentions.len()).sum();
        eprintln!(
            "[kwx] {} source files → {} comment mentions",
            source_doc_files.len(),
            src_mentions
        );
    }

    doc_files.extend(source_doc_files);

    Ok(KwxResult { doc_files })
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn noise() -> HashSet<&'static str> {
        noise_set()
    }

    #[test]
    fn extracts_heading_as_mention() {
        let md = "# AuthService\n\nSome body text.";
        let mentions = extract_markdown_mentions(md, &Depth::Structured, &noise(), None);
        let heading = mentions.iter().find(|m| m.source == MentionSource::Heading);
        assert!(heading.is_some(), "should extract heading mention");
        assert_eq!(heading.unwrap().text, "authservice");
    }

    #[test]
    fn extracts_bold_as_mention() {
        let md = "The **TokenStore** is important.";
        let mentions = extract_markdown_mentions(md, &Depth::Structured, &noise(), None);
        let bold = mentions.iter().find(|m| m.source == MentionSource::Bold);
        assert!(bold.is_some(), "should extract bold mention");
        assert_eq!(bold.unwrap().text, "tokenstore");
    }

    #[test]
    fn extracts_code_span() {
        let md = "Call `validateToken` to verify.";
        let mentions = extract_markdown_mentions(md, &Depth::Structured, &noise(), None);
        let code = mentions.iter().find(|m| m.source == MentionSource::CodeSpan);
        assert!(code.is_some(), "should extract code span");
        assert_eq!(code.unwrap().text, "validatetoken");
    }

    #[test]
    fn extracts_pascal_from_body_in_full_depth() {
        let md = "The AuthService calls TokenStore internally.";
        let mentions = extract_markdown_mentions(md, &Depth::Full, &noise(), None);
        let names: Vec<&str> = mentions.iter().map(|m| m.text.as_str()).collect();
        assert!(names.contains(&"authservice"), "should find AuthService");
        assert!(names.contains(&"tokenstore"), "should find TokenStore");
    }

    #[test]
    fn noise_words_filtered() {
        let md = "## The\n\nTable example summary.";
        let mentions = extract_markdown_mentions(md, &Depth::Structured, &noise(), None);
        for m in &mentions {
            assert!(
                !["the", "table", "example", "summary"].contains(&m.text.as_str()),
                "noise word '{}' leaked through",
                m.text
            );
        }
    }

    #[test]
    fn is_doc_file_detects_extensions() {
        assert!(is_doc_file(Path::new("README.md")));
        assert!(is_doc_file(Path::new("guide.mdx")));
        assert!(is_doc_file(Path::new("spec.rst")));
        assert!(!is_doc_file(Path::new("main.ts")));
        assert!(!is_doc_file(Path::new("index.js")));
    }

    #[test]
    fn classify_doc_group_readme() {
        assert_eq!(classify_doc_group("README.md"), "readme");
        assert_eq!(classify_doc_group("CHANGELOG.md"), "changelog");
        assert_eq!(
            classify_doc_group("docs/architecture/ADR-001.md"),
            "architecture"
        );
        assert_eq!(classify_doc_group("docs/api/endpoints.md"), "api-reference");
    }

    #[test]
    fn pascal_case_detection() {
        assert!(is_pascal_case("AuthService"));
        assert!(is_pascal_case("TokenStore"));
        assert!(!is_pascal_case("authservice"));
        assert!(!is_pascal_case("AUTH"));
        assert!(!is_pascal_case("A"));
    }

    #[test]
    fn camel_case_detection() {
        assert!(is_camel_case("validateToken"));
        assert!(is_camel_case("getUser"));
        assert!(!is_camel_case("AuthService"));
        assert!(!is_camel_case("auth"));
    }

    // ── source comment extraction ──────────────────────────────────────────

    #[test]
    fn extracts_line_comment_content() {
        // Only line-starting `//` comments are extracted — inline comments on code
        // lines are treated as code (blanked), matching the TS behaviour.
        let src = "// This calls AuthService\nconst y = 2;";
        let out = extract_source_comment_content(src);
        // Use split('\n') so we see the trailing blank line from the code line.
        let lines: Vec<&str> = out.split('\n').collect();
        assert_eq!(lines[0], "This calls AuthService");
        assert_eq!(lines[1], ""); // code line blanked out
    }

    #[test]
    fn extracts_block_comment_content() {
        let src = "/**\n * Validates a TokenStore request.\n * Returns bool.\n */\nfunction foo() {}";
        let out = extract_source_comment_content(src);
        let lines: Vec<&str> = out.lines().collect();
        // Line 0: opening /** (empty after stripping)
        // Line 1: "Validates a TokenStore request."
        assert!(out.contains("Validates a TokenStore request."), "got: {out}");
        assert!(out.contains("Returns bool."), "got: {out}");
        // The function line should be blanked
        assert!(!out.contains("function foo"), "code line should be blank");
    }

    #[test]
    fn extracts_python_hash_comment() {
        let src = "# AuthService handles auth\nx = 1\n# TokenStore provides tokens";
        let out = extract_source_comment_content(src);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "AuthService handles auth");
        assert_eq!(lines[1], ""); // code line
        assert_eq!(lines[2], "TokenStore provides tokens");
    }

    #[test]
    fn single_line_block_comment_extracted() {
        let src = "/** AuthService entry point */\nclass Foo {}";
        let out = extract_source_comment_content(src);
        // Use split('\n') so trailing blank line (blanked class line) is visible.
        let lines: Vec<&str> = out.split('\n').collect();
        assert_eq!(lines[0], "AuthService entry point");
        assert_eq!(lines[1], ""); // class declaration blanked
    }

    #[test]
    fn shebang_not_treated_as_comment() {
        let src = "#!/usr/bin/env python\n# AuthService module\nx = 1";
        let out = extract_source_comment_content(src);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], ""); // shebang → blank
        assert_eq!(lines[1], "AuthService module");
    }
}
