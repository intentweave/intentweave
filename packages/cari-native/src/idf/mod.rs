// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! IDF — Inverse Document Frequency scoring.
//!
//! Provides stopword detection and IDF scoring for annotation confidence.
//! Mirrors `packages/index/src/idf.ts` logic.
//!
//! ## Scoring rules (match TypeScript implementation exactly)
//!
//! - Stopwords get a fixed score of 0.15 (ceiling, same as TS)
//! - IDF = log(N / df) where N = total docs, df = document frequency of term
//! - Score is clamped to [0.0, 1.0]
//! - Short terms (< 3 chars) get score 0.0

use std::collections::{HashMap, HashSet};

/// Stopword list — mirrors the 50-term baseline in idf.ts.
pub static STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "in", "to", "for", "with",
    "on", "at", "from", "by", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "that", "this",
    "it", "its", "not", "as", "if", "but", "so", "when", "where",
    "all", "no", "any", "some",
];

const STOPWORD_SCORE: f64 = 0.15;
const MIN_TERM_LEN: usize = 3;

/// Pre-computed stopword set for O(1) lookup.
pub fn stopword_set() -> HashSet<&'static str> {
    STOPWORDS.iter().copied().collect()
}

/// Compute IDF scores for a list of terms given a document frequency map.
///
/// - `total_docs`: total number of documents in the corpus
/// - `df`: term → count of documents containing the term
/// - Returns: term → IDF score ∈ [0.0, 1.0]
pub fn compute_idf(total_docs: usize, df: &HashMap<String, usize>) -> HashMap<String, f64> {
    let stops = stopword_set();
    let n = total_docs as f64;
    df.iter()
        .map(|(term, &freq)| {
            let score = if term.len() < MIN_TERM_LEN {
                0.0
            } else if stops.contains(term.as_str()) {
                STOPWORD_SCORE
            } else {
                let idf = (n / (freq as f64 + 1.0)).ln().max(0.0);
                // Normalise to [0, 1] — same approach as idf.ts (cap at log(N))
                let max_idf = n.ln().max(1.0);
                (idf / max_idf).min(1.0)
            };
            (term.clone(), score)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopwords_score_low() {
        let df: HashMap<String, usize> = [("the".to_string(), 1)].into_iter().collect();
        let scores = compute_idf(10, &df);
        assert!(*scores.get("the").unwrap() <= STOPWORD_SCORE + 0.001);
    }

    #[test]
    fn rare_term_scores_high() {
        let df: HashMap<String, usize> = [("AuthService".to_string(), 1)].into_iter().collect();
        let scores = compute_idf(100, &df);
        let score = *scores.get("AuthService").unwrap();
        assert!(score > 0.5, "rare term score should be > 0.5, got {score}");
    }
}
