// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;

mod schema;
mod types;
mod util;
mod ax;
mod kwx;
mod cox;
mod tcg;
mod annotate;
mod idf;
mod writer;

/// CARI Build — native Rust binary that builds the .iw/index.db index.
///
/// This binary replicates the TypeScript pipeline stages in Rust for
/// performance-critical workloads. It writes the same SQLite schema as
/// the TypeScript `iw index build` command, so existing consumers work
/// without modification.
///
/// Pipeline stages (same order as the TypeScript pipeline):
///   1. AX  — AST extraction (oxc for TS/JS, tree-sitter for other langs)
///   2. KWX — Keyword extraction (pulldown-cmark + heuristic extractor)
///   3. COX — Co-occurrence scoring
///   4. TCG — Git analysis (co-changes, churn, ownership)
///   5. Annotate — Match mentions → symbols, apply IDF penalties
///   6. Write — Persist all stages to SQLite in a single transaction
#[derive(Parser, Debug)]
#[command(name = "cari-build", version, about = "CARI native index builder")]
pub struct Args {
    /// Workspace root — all relative paths are resolved from here.
    #[arg(long, default_value = ".")]
    pub root: PathBuf,

    /// Output path for the SQLite database.
    #[arg(long, default_value = ".iw/index.db")]
    pub output: PathBuf,

    /// Index depth. `full` (default) indexes headings, bold, code spans,
    /// identifiers, and body text with IDF filtering (+72% annotations,
    /// +189% grounded). `structured` skips body text.
    #[arg(long, default_value = "full", value_parser = parse_depth)]
    pub depth: types::Depth,

    /// Additional paths to index (relative to --root). Defaults to the
    /// entire workspace root when not specified.
    #[arg(long)]
    pub paths: Vec<PathBuf>,

    /// Verbose output — prints stage timings and counts.
    #[arg(short, long)]
    pub verbose: bool,
}

fn parse_depth(s: &str) -> Result<types::Depth, String> {
    match s {
        "structured" => Ok(types::Depth::Structured),
        "full" => Ok(types::Depth::Full),
        _ => Err(format!("invalid depth '{}': expected 'structured' or 'full'", s)),
    }
}

fn main() -> Result<()> {
    let args = Args::parse();

    if args.verbose {
        eprintln!("[cari-build] root={} output={} depth={:?}",
            args.root.display(), args.output.display(), args.depth);
    }

    let start = std::time::Instant::now();

    // Resolve root to an absolute path.
    let root = std::fs::canonicalize(&args.root)
        .map_err(|e| anyhow::anyhow!("Cannot resolve --root '{}': {}", args.root.display(), e))?;

    // Determine paths to index.
    let paths: Vec<PathBuf> = if args.paths.is_empty() {
        vec![root.clone()]
    } else {
        args.paths.iter().map(|p| root.join(p)).collect()
    };

    // Ensure output directory exists.
    if let Some(parent) = args.output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Always start from a clean slate — delete the existing DB if present.
    // This matches the TypeScript writer.ts behaviour (unlinkSync before open).
    if args.output.exists() {
        std::fs::remove_file(&args.output)
            .map_err(|e| anyhow::anyhow!("Cannot remove existing DB '{}': {}", args.output.display(), e))?;
    }

    let opts = types::BuildOpts {
        root: root.clone(),
        paths,
        output: args.output.clone(),
        depth: args.depth.clone(),
        verbose: args.verbose,
    };

    // Run the full pipeline.
    run_pipeline(opts, start)?;

    Ok(())
}

fn run_pipeline(opts: types::BuildOpts, start: std::time::Instant) -> Result<()> {
    // Stage 1 — AX: AST extraction
    let t_ax = std::time::Instant::now();
    let ax_result = ax::run(&opts)?;
    let d_ax = t_ax.elapsed();

    // Stage 2 — KWX: Keyword extraction from docs + source-file comments
    let t_kwx = std::time::Instant::now();
    let kwx_result = kwx::run(&opts, &ax_result)?;
    let d_kwx = t_kwx.elapsed();

    // Stage 3 — COX: Co-occurrence scoring
    let t_cox = std::time::Instant::now();
    let cox_result = cox::run(&ax_result, &kwx_result)?;
    let d_cox = t_cox.elapsed();

    // Stage 4 — TCG: Git analysis
    let t_tcg = std::time::Instant::now();
    let tcg_result = tcg::run(&opts)?;
    let d_tcg = t_tcg.elapsed();

    // Stage 5 — Annotate: Match doc mentions to code symbols
    let t_ann = std::time::Instant::now();
    let annotations = annotate::run(&ax_result, &kwx_result, &opts)?;
    let d_ann = t_ann.elapsed();

    // Stage 6 — Write: Persist to SQLite
    let t_write = std::time::Instant::now();
    let counts = writer::write(&opts, &ax_result, &kwx_result, &cox_result, &tcg_result, &annotations)?;
    let d_write = t_write.elapsed();

    let total = start.elapsed();

    if opts.verbose {
        eprintln!("[cari-build] pipeline complete in {:.2}s", total.as_secs_f64());
        eprintln!("  ax={:.2}s kwx={:.2}s cox={:.2}s tcg={:.2}s annotate={:.2}s write={:.2}s",
            d_ax.as_secs_f64(), d_kwx.as_secs_f64(), d_cox.as_secs_f64(),
            d_tcg.as_secs_f64(), d_ann.as_secs_f64(), d_write.as_secs_f64());
        eprintln!("  symbols={} annotations={} co_occurrences={} files={} imports={}",
            counts.symbols, counts.annotations, counts.co_occurrences,
            counts.files, counts.imports);
    }

    Ok(())
}
