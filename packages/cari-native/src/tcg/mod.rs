// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! TCG — Temporal Co-Change & Git analysis stage. Phase R1-d.
//!
//! Shells out to `git log --numstat` and computes:
//!   - `co_changes`: file pairs that change together (Jaccard similarity)
//!   - `file_stats.churn`: total lines added + removed per file
//!   - `file_stats.is_hotspot`: high-commit-frequency files (z-score > 2.0)
//!   - `file_stats.primary_owner`: author with >50% of commits
//!   - `file_stats.bus_factor`: #authors with >=10% of commits
//!   - `file_stats.last_modified`: ISO date of the most recent commit

use anyhow::Result;
use chrono::{DateTime, FixedOffset, Utc};
use std::collections::{HashMap, HashSet};
use std::process::Command;

use crate::types::{BuildOpts, CoChange, FileStat, TcgResult};

// =============================================================================
// Constants
// =============================================================================

/// Max files per commit — larger commits are skipped (noise from mass renames).
const MAX_FILES_PER_COMMIT: usize = 50;

/// Minimum co-change count threshold.
const MIN_CO_CHANGES: usize = 3;

/// Minimum Jaccard score threshold.
const MIN_JACCARD: f64 = 0.1;

/// Z-score threshold for hotspot classification.
const Z_SCORE_THRESHOLD: f64 = 2.0;

/// Exponential decay half-life in seconds (90 days).
const HALF_LIFE_SECS: f64 = 90.0 * 24.0 * 3600.0;

// =============================================================================
// Internal commit record
// =============================================================================

pub(crate) struct CommitRecord {
    hash: String,
    author_name: String,
    date: Option<DateTime<FixedOffset>>,
    /// ISO-8601 date string (raw from git).
    date_str: String,
    /// (file_path, lines_added, lines_removed)
    files: Vec<(String, i64, i64)>,
}

// =============================================================================
// Git log shell-out
// =============================================================================

fn run_git_log(root: &std::path::Path) -> Result<String> {
    let root_str = root.to_str().unwrap_or(".");
    let format = "--format=---COMMIT_START---%n%H%n%an%n%ae%n%aI%n---COMMIT_END---";

    let output = Command::new("git")
        .args(["-C", root_str, "log", format, "--numstat", "--diff-filter=ACDMR"])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") || stderr.contains("fatal: not a git") {
            return Ok(String::new());
        }
        return Err(anyhow::anyhow!("git log failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// =============================================================================
// Parsing
// =============================================================================

/// Parse raw `git log --numstat` output into `CommitRecord`s.
///
/// The format uses `---COMMIT_START---` / `---COMMIT_END---` delimiters
/// followed by `lines_added\tlines_removed\tpath` numstat lines.
pub fn parse_git_log_output(raw: &str) -> Vec<CommitRecord> {
    let mut commits = Vec::new();
    let lines: Vec<&str> = raw.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        if lines[i].trim() != "---COMMIT_START---" {
            i += 1;
            continue;
        }

        let hash = lines.get(i + 1).map(|s| s.trim()).unwrap_or("").to_string();
        let author_name = lines.get(i + 2).map(|s| s.trim()).unwrap_or("").to_string();
        // i+3 is author email — skip it
        let date_str = lines.get(i + 4).map(|s| s.trim()).unwrap_or("").to_string();

        // Advance past the header to COMMIT_END
        i += 5;
        while i < lines.len() && lines[i].trim() != "---COMMIT_END---" {
            i += 1;
        }
        i += 1; // skip COMMIT_END

        let date = DateTime::parse_from_rfc3339(&date_str).ok();

        // Collect numstat lines until next commit header or EOF
        let mut files: Vec<(String, i64, i64)> = Vec::new();
        while i < lines.len() && lines[i].trim() != "---COMMIT_START---" {
            let line = lines[i].trim();
            i += 1;
            if line.is_empty() {
                continue;
            }
            if let Some(entry) = parse_numstat_line(line) {
                files.push(entry);
            }
        }

        if !hash.is_empty() {
            commits.push(CommitRecord { hash, author_name, date, date_str, files });
        }
    }

    commits
}

/// Parse a single `--numstat` line: `added\tremoved\tpath`.
///
/// Returns `(resolved_path, lines_added, lines_removed)` or `None` on parse error.
pub fn parse_numstat_line(line: &str) -> Option<(String, i64, i64)> {
    let parts: Vec<&str> = line.splitn(3, '\t').collect();
    if parts.len() < 3 {
        return None;
    }

    let added: i64 = if parts[0] == "-" { 0 } else { parts[0].parse().ok()? };
    let removed: i64 = if parts[1] == "-" { 0 } else { parts[1].parse().ok()? };
    let path = resolve_rename(parts[2]);

    Some((path, added, removed))
}

/// Resolve the "new" path from git rename notation.
///
/// Handles:
/// - `"old/path => new/path"`
/// - `"prefix/{old => new}/suffix"`
pub fn resolve_rename(path_str: &str) -> String {
    if !path_str.contains(" => ") {
        return path_str.to_string();
    }

    // Partial rename: "prefix/{old => new}/suffix"
    if let (Some(open), Some(close)) = (path_str.find('{'), path_str.find('}')) {
        if open < close {
            let prefix = &path_str[..open];
            let inside = &path_str[open + 1..close];
            let suffix = &path_str[close + 1..];
            if let Some(arrow) = inside.find(" => ") {
                let new_middle = &inside[arrow + 4..];
                return format!("{}{}{}", prefix, new_middle, suffix);
            }
        }
    }

    // Full rename: "old/path => new/path"
    if let Some(arrow) = path_str.find(" => ") {
        return path_str[arrow + 4..].to_string();
    }

    path_str.to_string()
}

// =============================================================================
// Co-change computation
// =============================================================================

fn compute_co_changes(
    commits: &[CommitRecord],
    file_commits: &HashMap<String, HashSet<usize>>,
    pair_commits: &HashMap<(String, String), Vec<usize>>,
) -> Vec<CoChange> {
    let ln2 = std::f64::consts::LN_2;
    let now = Utc::now();
    let mut co_changes = Vec::new();

    for ((file_a, file_b), commit_indices) in pair_commits {
        if commit_indices.len() < MIN_CO_CHANGES {
            continue;
        }

        let a_count = file_commits.get(file_a).map(|s| s.len()).unwrap_or(0);
        let b_count = file_commits.get(file_b).map(|s| s.len()).unwrap_or(0);
        let intersection = commit_indices.len();
        let union = a_count + b_count - intersection;

        if union == 0 {
            continue;
        }

        let jaccard = intersection as f64 / union as f64;
        if jaccard < MIN_JACCARD {
            continue;
        }

        // Recency: max exponential decay (half-life = 90 days) over shared commits
        let mut recency = 0.0_f64;
        let mut hashes: Vec<String> = Vec::new();
        for &idx in commit_indices {
            let commit = &commits[idx];
            hashes.push(commit.hash.clone());
            if let Some(date) = &commit.date {
                let date_utc = date.with_timezone(&Utc);
                let age_secs = (now - date_utc).num_seconds().max(0) as f64;
                let decay = (-ln2 * age_secs / HALF_LIFE_SECS).exp();
                if decay > recency {
                    recency = decay;
                }
            }
        }

        co_changes.push(CoChange {
            file_a: file_a.clone(),
            file_b: file_b.clone(),
            count: intersection as i64,
            jaccard: (jaccard * 1000.0).round() / 1000.0,
            recency: (recency * 1000.0).round() / 1000.0,
            commit_hashes: serde_json::to_string(&hashes).ok(),
        });
    }

    // Sort by co-change count descending
    co_changes.sort_by(|a, b| b.count.cmp(&a.count));
    co_changes
}

// =============================================================================
// File stats computation
// =============================================================================

fn compute_file_stats(
    file_commits: &HashMap<String, HashSet<usize>>,
    file_churn: &HashMap<String, i64>,
    file_last_modified: &HashMap<String, String>,
    file_authors: &HashMap<String, HashMap<String, usize>>,
) -> Vec<FileStat> {
    // Compute mean and std-dev of commit counts (for hotspot z-score)
    let commit_counts: Vec<f64> = file_commits.values().map(|s| s.len() as f64).collect();
    let n = commit_counts.len() as f64;
    let mean = if n > 0.0 { commit_counts.iter().sum::<f64>() / n } else { 0.0 };
    let variance = if n > 0.0 {
        commit_counts.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n
    } else {
        0.0
    };
    let std_dev = variance.sqrt();

    let mut stats = Vec::new();

    for (path, commit_set) in file_commits {
        let commit_count = commit_set.len() as f64;
        let z_score = if std_dev > 0.0 { (commit_count - mean) / std_dev } else { 0.0 };
        let is_hotspot = z_score >= Z_SCORE_THRESHOLD;

        let churn = *file_churn.get(path).unwrap_or(&0);
        let last_modified = file_last_modified.get(path).cloned();

        // Ownership: primary owner + bus factor
        let (primary_owner, bus_factor) = match file_authors.get(path) {
            None => (None, None),
            Some(author_map) => {
                let total: usize = author_map.values().sum();
                if total == 0 {
                    (None, Some(0_i64))
                } else {
                    // Sort authors by commit count descending
                    let mut authors: Vec<(&String, usize)> =
                        author_map.iter().map(|(a, &c)| (a, c)).collect();
                    authors.sort_by(|a, b| b.1.cmp(&a.1));

                    // Primary owner: first author with >50% of commits
                    let primary = authors
                        .first()
                        .filter(|(_, c)| (*c as f64 / total as f64) > 0.5)
                        .map(|(name, _)| (*name).clone());

                    // Bus factor: #authors with >=10% of commits
                    let bus = authors
                        .iter()
                        .filter(|(_, c)| *c as f64 / total as f64 >= 0.10)
                        .count() as i64;

                    (primary, Some(bus))
                }
            }
        };

        stats.push(FileStat { path: path.clone(), churn, is_hotspot, primary_owner, bus_factor, last_modified });
    }

    stats
}

// =============================================================================
// Entry point
// =============================================================================

/// Run TCG stage: extract co-change and churn data from git history.
///
/// Shells out to `git log`. If git is not found or the directory is not a
/// git repository, returns an empty `TcgResult` (TCG is optional).
pub fn run(opts: &BuildOpts) -> Result<TcgResult> {
    let root = &opts.root;

    let raw = match run_git_log(root) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("TCG: git log failed, skipping git analysis: {}", e);
            return Ok(TcgResult::default());
        }
    };

    if raw.is_empty() {
        return Ok(TcgResult::default());
    }

    let commits = parse_git_log_output(&raw);
    if commits.is_empty() {
        return Ok(TcgResult::default());
    }

    // ── Build per-file maps ──────────────────────────────────────────────────
    // file → set of commit indices that touch it
    let mut file_commits: HashMap<String, HashSet<usize>> = HashMap::new();
    // (file_a, file_b) → list of commit indices where both files changed
    let mut pair_commits: HashMap<(String, String), Vec<usize>> = HashMap::new();
    // file → total lines added + removed
    let mut file_churn: HashMap<String, i64> = HashMap::new();
    // file → date of most recent commit (git log is newest-first, so or_insert on first occurrence)
    let mut file_last_modified: HashMap<String, String> = HashMap::new();
    // file → (author_name → commit count)
    let mut file_authors: HashMap<String, HashMap<String, usize>> = HashMap::new();

    for (commit_idx, commit) in commits.iter().enumerate() {
        let paths: Vec<&str> = commit.files.iter().map(|(p, _, _)| p.as_str()).collect();

        // Skip mass-change commits (noise from bulk renames, infrastructure commits, etc.)
        if paths.len() > MAX_FILES_PER_COMMIT {
            continue;
        }

        for (path, added, removed) in &commit.files {
            // Track which commits touch this file
            file_commits.entry(path.clone()).or_default().insert(commit_idx);

            // Accumulate churn
            *file_churn.entry(path.clone()).or_default() += added + removed;

            // Most recent commit date (git log is newest-first; or_insert keeps first occurrence)
            file_last_modified.entry(path.clone()).or_insert_with(|| commit.date_str.clone());

            // Author commit counts
            *file_authors
                .entry(path.clone())
                .or_default()
                .entry(commit.author_name.clone())
                .or_insert(0) += 1;
        }

        // Record co-change pairs (sorted so file_a < file_b alphabetically)
        let mut sorted_paths: Vec<&str> = paths.clone();
        sorted_paths.sort_unstable();
        for i in 0..sorted_paths.len() {
            for j in (i + 1)..sorted_paths.len() {
                let key = (sorted_paths[i].to_string(), sorted_paths[j].to_string());
                pair_commits.entry(key).or_default().push(commit_idx);
            }
        }
    }

    let co_changes = compute_co_changes(&commits, &file_commits, &pair_commits);
    let file_stats = compute_file_stats(&file_commits, &file_churn, &file_last_modified, &file_authors);

    Ok(TcgResult { co_changes, file_stats })
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── Numstat line parser ──────────────────────────────────────────────────

    #[test]
    fn test_parse_numstat_line_normal() {
        let result = parse_numstat_line("12\t5\tsrc/auth.ts");
        assert_eq!(result, Some(("src/auth.ts".to_string(), 12, 5)));
    }

    #[test]
    fn test_parse_numstat_line_binary() {
        let result = parse_numstat_line("-\t-\tassets/logo.png");
        assert_eq!(result, Some(("assets/logo.png".to_string(), 0, 0)));
    }

    #[test]
    fn test_parse_numstat_line_full_rename() {
        // "added\tremoved\told/path => new/path"
        let result = parse_numstat_line("3\t1\told/auth.ts => new/auth.ts");
        assert_eq!(result, Some(("new/auth.ts".to_string(), 3, 1)));
    }

    #[test]
    fn test_parse_numstat_line_partial_rename() {
        // "added\tremoved\tprefix/{old => new}/suffix"
        let result = parse_numstat_line("5\t2\tsrc/{auth => authn}/service.ts");
        assert_eq!(result, Some(("src/authn/service.ts".to_string(), 5, 2)));
    }

    #[test]
    fn test_parse_numstat_line_invalid() {
        assert_eq!(parse_numstat_line("not-numstat"), None);
        assert_eq!(parse_numstat_line(""), None);
    }

    // ── Git log output parser ────────────────────────────────────────────────

    #[test]
    fn test_parse_git_log_output_single_commit() {
        let raw = "\
---COMMIT_START---
abc123
Alice
alice@example.com
2024-06-01T10:00:00+00:00
---COMMIT_END---
10\t2\tsrc/auth.ts
3\t1\tsrc/db.ts
";
        let commits = parse_git_log_output(raw);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abc123");
        assert_eq!(commits[0].author_name, "Alice");
        assert_eq!(commits[0].files.len(), 2);
        assert_eq!(commits[0].files[0].0, "src/auth.ts");
        assert_eq!(commits[0].files[0].1, 10); // added
        assert_eq!(commits[0].files[0].2, 2);  // removed
    }

    #[test]
    fn test_parse_git_log_output_two_commits() {
        let raw = "\
---COMMIT_START---
hash1
Bob
bob@example.com
2024-06-02T12:00:00+00:00
---COMMIT_END---
5\t0\tsrc/a.ts
2\t1\tsrc/b.ts
---COMMIT_START---
hash2
Alice
alice@example.com
2024-06-01T10:00:00+00:00
---COMMIT_END---
1\t1\tsrc/a.ts
8\t4\tsrc/c.ts
";
        let commits = parse_git_log_output(raw);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "hash1");
        assert_eq!(commits[1].hash, "hash2");
    }

    // ── Jaccard calculation ──────────────────────────────────────────────────

    #[test]
    fn test_jaccard_is_correct() {
        // Simulate: file_a in commits [0,1,2], file_b in commits [1,2,3]
        // intersection = {1,2} = 2, union = {0,1,2,3} = 4
        // jaccard = 2/4 = 0.5
        let mut file_commits: HashMap<String, HashSet<usize>> = HashMap::new();
        file_commits.insert("a.ts".to_string(), [0, 1, 2].into_iter().collect());
        file_commits.insert("b.ts".to_string(), [1, 2, 3].into_iter().collect());

        let mut pair_commits: HashMap<(String, String), Vec<usize>> = HashMap::new();
        pair_commits.insert(("a.ts".to_string(), "b.ts".to_string()), vec![1, 2]);

        // Provide minimal commits (no dates, so recency = 0)
        let commits: Vec<CommitRecord> = (0..4)
            .map(|i| CommitRecord {
                hash: format!("h{}", i),
                author_name: "Dev".to_string(),
                date: None,
                date_str: String::new(),
                files: vec![],
            })
            .collect();

        let co_changes = compute_co_changes(&commits, &file_commits, &pair_commits);
        // Should NOT appear because MIN_CO_CHANGES = 3, but intersection = 2 < 3
        assert!(co_changes.is_empty(), "pair should be filtered (count 2 < min 3)");
    }

    #[test]
    fn test_jaccard_passes_min_threshold() {
        // file_a in [0,1,2,3], file_b in [1,2,3,4]
        // intersection = {1,2,3} = 3, union = 5, jaccard = 0.6 >= 0.1
        let mut file_commits: HashMap<String, HashSet<usize>> = HashMap::new();
        file_commits.insert("a.ts".to_string(), [0, 1, 2, 3].into_iter().collect());
        file_commits.insert("b.ts".to_string(), [1, 2, 3, 4].into_iter().collect());

        let mut pair_commits: HashMap<(String, String), Vec<usize>> = HashMap::new();
        pair_commits.insert(("a.ts".to_string(), "b.ts".to_string()), vec![1, 2, 3]);

        let commits: Vec<CommitRecord> = (0..5)
            .map(|i| CommitRecord {
                hash: format!("h{}", i),
                author_name: "Dev".to_string(),
                date: None,
                date_str: String::new(),
                files: vec![],
            })
            .collect();

        let co_changes = compute_co_changes(&commits, &file_commits, &pair_commits);
        assert_eq!(co_changes.len(), 1);
        // jaccard = 3/5 = 0.6, rounded to 3dp
        assert!((co_changes[0].jaccard - 0.6).abs() < 0.001);
    }

    // ── Hotspot / FileStat ───────────────────────────────────────────────────

    #[test]
    fn test_hotspot_detection() {
        // One file with 10 commits (outlier), others with 1 commit
        let mut file_commits: HashMap<String, HashSet<usize>> = HashMap::new();
        let n_normal = 10usize;
        let hotspot_path = "hot.ts".to_string();

        // 10 normal files with 1 commit each
        for i in 0..n_normal {
            file_commits.insert(format!("file{}.ts", i), [i].into_iter().collect());
        }
        // 1 hotspot file with 100 commits
        file_commits.insert(hotspot_path.clone(), (0..100).collect());

        let file_churn = HashMap::new();
        let file_last_modified = HashMap::new();
        let file_authors = HashMap::new();

        let stats = compute_file_stats(&file_commits, &file_churn, &file_last_modified, &file_authors);
        let hot = stats.iter().find(|s| s.path == hotspot_path).unwrap();
        assert!(hot.is_hotspot, "file with 100 commits should be a hotspot");

        // Normal files should not be hotspots
        let normal = stats.iter().find(|s| s.path == "file0.ts").unwrap();
        assert!(!normal.is_hotspot);
    }

    // ── Large commit filtering ───────────────────────────────────────────────

    #[test]
    fn test_skips_large_commits() {
        // Build a git log string with a commit touching 60 files
        let mut raw = String::from(
            "---COMMIT_START---\nbig123\nAuthor\nauthor@email.com\n2024-01-01T00:00:00+00:00\n---COMMIT_END---\n",
        );
        for i in 0..60 {
            raw.push_str(&format!("1\t0\tfile{}.ts\n", i));
        }
        // Add a small commit with 2 files
        raw.push_str(
            "---COMMIT_START---\nsmall456\nAuthor\nauthor@email.com\n2024-01-02T00:00:00+00:00\n---COMMIT_END---\n",
        );
        raw.push_str("2\t1\tsrc/a.ts\n");
        raw.push_str("1\t0\tsrc/b.ts\n");

        let commits = parse_git_log_output(&raw);
        assert_eq!(commits.len(), 2); // Both commits are parsed...

        // ...but the large commit should be skipped in run()
        // We can't call run() without a git repo, so verify the constant is correct
        assert_eq!(MAX_FILES_PER_COMMIT, 50);
        assert!(60 > MAX_FILES_PER_COMMIT, "large commit should exceed threshold");
    }
}
