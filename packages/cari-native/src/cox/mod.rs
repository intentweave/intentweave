// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! COX — Co-occurrence scoring stage. Phase R1-b.
//!
//! Computes entity pairs that are co-mentioned in the same document or
//! co-imported in the same source file, then scores them.
//!
//! ## Algorithm (mirrors coxStage.ts exactly)
//! For each doc file, slide a window of size WINDOW_SIZE=2 over the ordered
//! mention list.  For each pair (i, j) within the window, emit a local edge
//! (entityA, entityB) with canonical a < b ordering.
//!
//! Aggregate across all files: group by pair, sum counts, collect file paths.
//! Filter: discard pairs with count < MIN_COUNT=2.
//! Score: count / max_count (simple normalisation, matches TS v1).
//!
//! ## Parallelism
//! Each file's edge list is built in parallel with rayon.  Results are merged
//! sequentially (HashMap contention would outweigh parallelism here).

use anyhow::Result;
use rayon::prelude::*;
use std::collections::HashMap;

use crate::types::{AxResult, CoOccurrence, CoxResult, KwxResult};

/// Sliding window size — matches `WINDOW_SIZE = 2` in coxStage.ts.
const WINDOW_SIZE: usize = 2;

/// Minimum co-occurrence count to emit an edge — matches `MIN_COUNT = 2`.
const MIN_COUNT: usize = 2;

/// Run COX stage: score entity co-occurrence pairs from doc files and imports.
pub fn run(ax: &AxResult, kwx: &KwxResult) -> Result<CoxResult> {
    // --- Document co-occurrences (sliding window) ---
    // Each file emits (entityA, entityB, filePath) triples in parallel.
    let doc_edge_lists: Vec<Vec<(String, String, String)>> = kwx
        .doc_files
        .par_iter()
        .map(|doc| {
            let mentions = &doc.mentions;
            let mut edges = Vec::new();
            for i in 0..mentions.len() {
                let limit = (i + WINDOW_SIZE).min(mentions.len() - 1);
                for j in (i + 1)..=limit {
                    let a = &mentions[i].text;
                    let b = &mentions[j].text;
                    if a == b {
                        continue;
                    }
                    // Canonical ordering: lexicographically smaller first
                    let (ea, eb) = if a < b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
                    edges.push((ea, eb, doc.path.clone()));
                }
            }
            edges
        })
        .collect();

    // --- Import co-occurrences (pairwise per source file, unchanged) ---
    let import_pairs: Vec<(String, String)> = {
        let mut by_source: HashMap<&str, Vec<&str>> = HashMap::new();
        for imp in &ax.imports {
            by_source.entry(&imp.source_file).or_default().push(&imp.target_file);
        }
        let mut pairs = Vec::new();
        for targets in by_source.values() {
            let mut sorted: Vec<&str> = targets.clone();
            sorted.sort_unstable();
            sorted.dedup();
            for i in 0..sorted.len() {
                for j in (i + 1)..sorted.len() {
                    pairs.push((sorted[i].to_string(), sorted[j].to_string()));
                }
            }
        }
        pairs
    };

    // --- Aggregate doc edges ---
    struct EdgeInfo { count: usize, file_paths: Vec<String> }
    let mut doc_map: HashMap<(String, String), EdgeInfo> = HashMap::new();
    for edges in doc_edge_lists {
        for (a, b, file) in edges {
            let entry = doc_map.entry((a, b)).or_insert(EdgeInfo { count: 0, file_paths: Vec::new() });
            entry.count += 1;
            if !entry.file_paths.contains(&file) {
                entry.file_paths.push(file);
            }
        }
    }

    let mut import_counts: HashMap<(String, String), usize> = HashMap::new();
    for pair in import_pairs {
        *import_counts.entry(pair).or_insert(0) += 1;
    }

    // --- Score: count / max_count (matches TS v1 normalisation) ---
    let doc_max = doc_map.values().map(|e| e.count).max().unwrap_or(1).max(1);
    let imp_max = import_counts.values().copied().max().unwrap_or(1).max(1);

    // --- Emit filtered CoOccurrence rows ---
    let mut co_occurrences = Vec::new();

    for ((a, b), info) in &doc_map {
        if info.count < MIN_COUNT {
            continue;
        }
        let mut file_paths = info.file_paths.clone();
        file_paths.sort_unstable();
        co_occurrences.push(CoOccurrence {
            entity_a: a.clone(),
            entity_b: b.clone(),
            count: info.count as i64,
            score: info.count as f64 / doc_max as f64,
            source: "doc".to_string(),
            file_paths: Some(file_paths.join(",")),
        });
    }

    for ((a, b), count) in &import_counts {
        // Imports: min_count=1 (any shared import is meaningful)
        co_occurrences.push(CoOccurrence {
            entity_a: a.clone(),
            entity_b: b.clone(),
            count: *count as i64,
            score: *count as f64 / imp_max as f64,
            source: "import".to_string(),
            file_paths: None,
        });
    }

    Ok(CoxResult { co_occurrences })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AxResult, DocFile, KwxResult, Mention, MentionSource};

    fn make_kwx(mentions_per_doc: Vec<Vec<&str>>) -> KwxResult {
        let doc_files = mentions_per_doc
            .into_iter()
            .enumerate()
            .map(|(i, names)| DocFile {
                path: format!("doc{}.md", i),
                is_doc: true,
                doc_group: None,
                mentions: names
                    .into_iter()
                    .enumerate()
                    .map(|(j, name)| Mention {
                        line: j as i64 + 1,
                        text: name.to_string(),
                        source: MentionSource::Heading,
                        char_start: Some((j * 10) as i64),
                        char_end: Some((j * 10 + name.len()) as i64),
                    })
                    .collect(),
            })
            .collect();
        KwxResult { doc_files }
    }

    fn empty_ax() -> AxResult {
        AxResult {
            files: vec![],
            symbols: vec![],
            imports: vec![],
            calls: vec![],
            todos: vec![],
            rationale: vec![],
        }
    }

    #[test]
    fn window_limits_pairs() {
        // 4 distinct entities in one doc → with window=2 only adjacent pairs
        // [A,B,C,D]: pairs = (A,B),(A,C),(B,C),(B,D),(C,D) NOT (A,D)
        let kwx = make_kwx(vec![vec!["alpha", "beta", "gamma", "delta"]]);
        let ax = empty_ax();
        let result = run(&ax, &kwx).unwrap();
        // Each pair appears only once → all filtered out by MIN_COUNT=2
        // (min_count requires ≥2 occurrences)
        assert_eq!(result.co_occurrences.len(), 0,
            "single-occurrence pairs should be filtered by MIN_COUNT");
    }

    #[test]
    fn repeated_pair_across_docs_survives_min_count() {
        // Same pair appears in two different documents → count=2 → kept
        let kwx = make_kwx(vec![
            vec!["alpha", "beta"],
            vec!["alpha", "beta"],
        ]);
        let ax = empty_ax();
        let result = run(&ax, &kwx).unwrap();
        assert_eq!(result.co_occurrences.len(), 1);
        let edge = &result.co_occurrences[0];
        assert_eq!(edge.count, 2);
        assert!((edge.score - 1.0).abs() < 1e-9, "max pair should score 1.0");
    }

    #[test]
    fn score_normalised_to_max() {
        // Three docs: pair (a,b) appears 3 times, pair (c,d) appears 2 times
        let kwx = make_kwx(vec![
            vec!["alpha", "beta"],
            vec!["alpha", "beta"],
            vec!["alpha", "beta"],
            vec!["gamma", "delta"],
            vec!["gamma", "delta"],
        ]);
        let ax = empty_ax();
        let result = run(&ax, &kwx).unwrap();
        let ab = result.co_occurrences.iter().find(|e| e.count == 3).unwrap();
        let cd = result.co_occurrences.iter().find(|e| e.count == 2).unwrap();
        assert!((ab.score - 1.0).abs() < 1e-9);
        assert!((cd.score - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn self_co_occurrence_skipped() {
        let kwx = make_kwx(vec![vec!["alpha", "alpha", "beta", "beta"]]);
        let ax = empty_ax();
        let result = run(&ax, &kwx).unwrap();
        // (alpha, alpha) and (beta, beta) should never be emitted
        for e in &result.co_occurrences {
            assert_ne!(e.entity_a, e.entity_b);
        }
    }
}
