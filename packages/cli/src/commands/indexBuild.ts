// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw index build — Build the Code-Aware Retrieval Index (CARI).
 *
 * Runs the full non-LLM pipeline and writes results to a SQLite database:
 *   KWG (IN→KWX→COX) + TCG (TCX→COC→HOT→OWN→STL) + AX → annotate → IDF → SQLite
 *
 * Output: .iw/index.db
 *
 * Usage:
 *   iw index build docs/ -s my-project -v
 *   iw index build docs/ -s my-project --depth full -v
 *
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

// Analyzer stages
import {
  runInStage,
  runKwxStage,
  runCoxStage,
  runAxStage,
  runTcxStage,
  runCocStage,
  runHotStage,
  runOwnStage,
  runStlStage,
  ConsoleLogger,
  NoopLogger,
} from "@intentweave/analyzer";
import type { InStageInput } from "@intentweave/analyzer";

// Core types
import type { KwxStageOutput, TcgPipelineOutput } from "@intentweave/core";

// Index package
import { buildIndex, annotate, computeIdf } from "@intentweave/index";
import { detectChanges, applyChanges, hashFile } from "@intentweave/index";
import type { IndexBuildOptions } from "@intentweave/index";

// =============================================================================
// Default Excludes & .iwignore
// =============================================================================

/** Directories excluded by default (similar to .gitignore defaults). */
const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.output/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.iw/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/build/**",
  "**/__pycache__/**",
];

/**
 * Load `.iwignore` from workspace root (if it exists).
 * Format: one glob pattern per line. Lines starting with `#` are comments.
 */
async function loadIwIgnore(cwd: string): Promise<string[]> {
  const ignorePath = path.join(cwd, ".iwignore");
  try {
    const content = await fs.readFile(ignorePath, "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Build the effective exclude list from defaults + .iwignore + CLI --exclude.
 * Passing `--no-default-excludes` disables the built-in list.
 */
function buildExcludeList(
  cliExcludes: string[],
  iwIgnorePatterns: string[],
  useDefaults: boolean,
): string[] {
  const excludes: string[] = [];
  if (useDefaults) excludes.push(...DEFAULT_EXCLUDES);
  excludes.push(...iwIgnorePatterns);
  excludes.push(...cliExcludes);
  return excludes;
}

// =============================================================================
// File Discovery
// =============================================================================

const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

interface DiscoverOptions {
  /** Glob patterns to include (if empty, include all supported files) */
  include?: string[];
  /** Glob patterns to exclude */
  exclude?: string[];
}

async function discoverFiles(
  paths: string[],
  cwd: string,
  opts: DiscoverOptions = {},
): Promise<string[]> {
  const { exclude = [] } = opts;

  // If include patterns are provided, use glob-based discovery instead
  if (opts.include && opts.include.length > 0) {
    const { minimatch } = await import("minimatch");
    const includeMatchers = opts.include.map(
      (p) => (file: string) => minimatch(file, p),
    );
    const files = await discoverFilesRecursive(paths, cwd, exclude);
    return files.filter((f) => {
      const rel = path.relative(cwd, f);
      return includeMatchers.some((m) => m(rel));
    });
  }

  return discoverFilesRecursive(paths, cwd, exclude);
}

async function discoverFilesRecursive(
  paths: string[],
  cwd: string,
  excludePatterns: string[],
): Promise<string[]> {
  let minimatchFn: ((file: string, pattern: string) => boolean) | null = null;
  if (excludePatterns.length > 0) {
    const { minimatch } = await import("minimatch");
    minimatchFn = minimatch;
  }

  const files: string[] = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;

    if (stat.isFile()) {
      if (SUPPORTED_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
        const rel = path.relative(cwd, abs);
        if (!isExcluded(rel, excludePatterns, minimatchFn)) {
          files.push(abs);
        }
      }
    } else if (stat.isDirectory()) {
      const dirName = path.basename(abs);
      // Fast-path: skip well-known excluded directories without glob matching
      if (
        dirName === "node_modules" ||
        dirName === ".git" ||
        dirName === ".iw"
      ) {
        continue;
      }
      const rel = path.relative(cwd, abs);
      if (rel && isExcluded(rel + "/", excludePatterns, minimatchFn)) {
        continue;
      }
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const subPaths = entries.map((e) => path.join(abs, e.name));
      files.push(
        ...(await discoverFilesRecursive(subPaths, cwd, excludePatterns)),
      );
    }
  }
  return [...new Set(files)].sort();
}

function isExcluded(
  relPath: string,
  patterns: string[],
  minimatchFn:
    | ((file: string, pattern: string, opts?: { dot?: boolean }) => boolean)
    | null,
): boolean {
  if (!minimatchFn || patterns.length === 0) return false;
  return patterns.some((p) => minimatchFn(relPath, p, { dot: true }));
}

function toArtifactId(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  return rel.replace(/[/\\]/g, ".").replace(/\.[^.]+$/, "");
}

function createMinimalContext(verbose: boolean) {
  const logger = verbose ? new ConsoleLogger("[index]") : new NoopLogger();
  return {
    logger,
    workspace: { root: process.cwd(), key: "index" },
    runId: `index-${Date.now()}`,
    store: null as any,
    profile: null as any,
    providers: null as any,
    now: () => new Date(),
    timestamp: () => new Date().toISOString(),
  };
}

// =============================================================================
// Subcommand: iw index build
// =============================================================================

const indexBuildSubcommand = new Command("build")
  .description("Build CARI index: KWG + TCG + AX → SQLite (.iw/index.db)")
  .argument("<paths...>", "Document file(s) or directories to analyze")
  .option("-s, --session <name>", "Session name (default: directory name)")
  .option(
    "--depth <depth>",
    "Annotation depth: structured (default) or full (includes IDF scoring)",
    "structured",
  )
  .option("--include <patterns...>", "Only include files matching these globs")
  .option(
    "--exclude <patterns...>",
    "Exclude files matching these globs (added to defaults)",
  )
  .option(
    "--no-default-excludes",
    "Disable built-in excludes (node_modules, dist, etc.)",
  )
  .option("-o, --output <path>", "Output path for the SQLite database")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    const depth = opts.depth;
    const output = opts.output;
    const verbose = opts.verbose;
    const cwd = process.cwd();

    // Resolve session: explicit flag > directory name
    const session = opts.session ?? path.basename(cwd);

    // Build exclude list: defaults + .iwignore + --exclude
    const iwIgnorePatterns = await loadIwIgnore(cwd);
    const cliExcludes: string[] = opts.exclude ?? [];
    const useDefaults = opts.defaultExcludes !== false;
    const excludePatterns = buildExcludeList(
      cliExcludes,
      iwIgnorePatterns,
      useDefaults,
    );

    const log = verbose
      ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
      : () => {};

    console.log(chalk.blue(`\n  ▸ CARI Index Build — session: ${session}`));
    console.log(
      chalk.blue(`  ▸ depth: ${depth} | output: ${output ?? ".iw/index.db"}\n`),
    );

    const pipelineStart = performance.now();

    try {
      // ── 1. Discover doc files ──────────────────────────────────
      log("Discovering document files...");
      if (excludePatterns.length > 0 && verbose) {
        log(`Excluding: ${excludePatterns.join(", ")}`);
      }
      const docFiles = await discoverFiles(paths, cwd, {
        include: opts.include,
        exclude: excludePatterns,
      });
      if (docFiles.length === 0) {
        console.error(chalk.red("No document files found in the given paths."));
        process.exit(1);
      }
      log(`Found ${docFiles.length} document files`);

      const ctx = createMinimalContext(verbose);

      // ── 2. AX: code symbol extraction (runs first for dictionary) ─
      const axStart = performance.now();
      const axOutput = await runAxStage({ workspaceRoot: cwd });
      const axMs = performance.now() - axStart;
      console.log(
        `  AXE  ${chalk.green("████████████████████████████████")}  ${(axMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `       → ${axOutput.totalFiles} files, ${axOutput.totalSymbols} code symbols`,
        ),
      );

      // Build symbol dictionary for body-text matching (--depth full)
      const symbolDictionary =
        depth === "full"
          ? new Set(
              axOutput.files.flatMap((f) =>
                f.symbols.map((s) => s.name.toLowerCase()),
              ),
            )
          : undefined;

      // ── 3. KWG: IN → KWX → COX ───────────────────────────────
      const kwgStart = performance.now();
      const kwxOutputs: KwxStageOutput[] = [];

      for (const filePath of docFiles) {
        const relPath = path.relative(cwd, filePath);
        log(`  KWX: ${relPath}`);

        const content = await fs.readFile(filePath, "utf-8");
        const artifactId = toArtifactId(filePath, cwd);

        const inInput: InStageInput = {
          artifactId,
          filePath: relPath,
          content,
        };
        const inOutput = await runInStage(inInput, ctx as any);
        const kwxOutput = await runKwxStage(
          { inOutput },
          {
            depth: depth as "structured" | "full",
            dictionary: symbolDictionary,
          },
        );
        kwxOutputs.push(kwxOutput);
      }

      const coxOutput = await runCoxStage({ kwxOutputs });

      const kwgMs = performance.now() - kwgStart;
      const totalMentions = kwxOutputs.reduce(
        (acc, o) => acc + o.mentions.length,
        0,
      );
      console.log(
        `  KWG  ${chalk.green("████████████████████████████████")}  ${(kwgMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `       → ${kwxOutputs.reduce((a, o) => a + o.entities.length, 0)} entities, ${totalMentions} mentions, ${coxOutput.edges.length} co-occ edges`,
        ),
      );

      // ── 4. TCG: TCX → COC → HOT → OWN → STL ─────────────────
      const tcgStart = performance.now();
      const tcxOutput = await runTcxStage({
        workspaceRoot: cwd,
        depth: "full",
        log: verbose
          ? (msg: string) => console.log(chalk.gray(`  tcx: ${msg}`))
          : undefined,
      });
      const cocOutput = runCocStage({ tcxOutput });
      const hotOutput = runHotStage({ tcxOutput });
      const ownOutput = runOwnStage({ tcxOutput });
      const stlOutput = runStlStage({
        tcxOutput,
        kwgEntities: kwxOutputs.flatMap((o) => o.entities).map((e) => e.name),
        workspaceRoot: cwd,
      });

      const tcgOutput: TcgPipelineOutput = {
        tcx: tcxOutput,
        coc: cocOutput,
        hot: hotOutput,
        own: ownOutput,
        stl: stlOutput,
        meta: {
          session,
          workspaceRoot: cwd,
          gitDepth: "full history",
          totalDurationMs: performance.now() - tcgStart,
        },
      };

      const tcgMs = performance.now() - tcgStart;
      console.log(
        `  TCG  ${chalk.green("████████████████████████████████")}  ${(tcgMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `       → ${tcxOutput.commits.length} commits, ${cocOutput.edges.length} co-change edges, ${hotOutput.hotspots.length} hotspots`,
        ),
      );

      // ── 5. IDF scoring (for "full" depth) ─────────────────────
      const idfScores = depth === "full" ? computeIdf(kwxOutputs) : undefined;

      if (idfScores) {
        log(`IDF computed: ${idfScores.size} terms`);
      }

      // ── 6. Annotate: match KWX mentions → AX symbols ─────────
      const annStart = performance.now();
      const annotations = annotate(axOutput, kwxOutputs, {
        idfScores,
        applyIdfPenalty: depth === "full",
        log,
      });
      const annMs = performance.now() - annStart;
      console.log(
        `  ANN  ${chalk.green("████████████████████████████████")}  ${(annMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `       → ${annotations.length} annotations (${annotations.filter((a) => a.symbolId).length} grounded)`,
        ),
      );

      // ── 7. Write SQLite index ─────────────────────────────────
      const buildOpts: IndexBuildOptions = {
        session,
        workspaceRoot: cwd,
        depth: depth as "structured" | "full",
        outputPath: output,
        log,
      };

      const result = buildIndex(
        axOutput,
        kwxOutputs,
        coxOutput,
        tcgOutput,
        annotations,
        buildOpts,
      );

      const totalMs = performance.now() - pipelineStart;
      console.log(
        `\n  ${chalk.green("✓")} Index built in ${(totalMs / 1000).toFixed(1)}s → ${result.dbPath}`,
      );
      console.log(
        chalk.gray(
          `    symbols=${result.counts.symbols} annotations=${result.counts.annotations} ` +
            `co_occ=${result.counts.coOccurrences} co_change=${result.counts.coChanges} ` +
            `files=${result.counts.files}`,
        ),
      );
    } catch (err: any) {
      console.error(chalk.red(`\n  ✗ Index build failed: ${err.message}`));
      if (verbose && err.stack) {
        console.error(chalk.gray(err.stack));
      }
      process.exit(1);
    }
  });

// =============================================================================
// Parent "index" command
// =============================================================================

import {
  retrieve,
  connections,
  check,
  formatCheck,
  report,
  clones,
  structuralClones,
  circularImports,
  unusedExports,
  hotspotPriority,
  todos,
  moduleCoverage,
  orphanedSections,
  docCompleteness,
  crossGroupDrift,
} from "@intentweave/index";
import type {
  RetrieveParams,
  ConnectionsParams,
  CheckParams,
} from "@intentweave/index";

function resolveDbPath(output?: string): string {
  return output ?? path.join(process.cwd(), ".iw", "index.db");
}

// ── iw index retrieve ──────────────────────────────────────────

const indexRetrieveSubcommand = new Command("retrieve")
  .description("Ranked file retrieval from the CARI index")
  .argument("<query...>", "Topic or symbol name to search for")
  .option("-n, --limit <n>", "Maximum results", "10")
  .option("--scope <scope>", "Filter: code, docs, or all", "all")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((queryParts: string[], opts) => {
    const dbPath = resolveDbPath(opts.db);
    const params: RetrieveParams = {
      query: queryParts.join(" "),
      limit: parseInt(opts.limit, 10),
      scope: opts.scope,
    };

    const result = retrieve(dbPath, params);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.files.length === 0) {
      console.log(chalk.yellow("  No matching files found."));
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ Top ${result.files.length} files for: "${params.query}"\n`,
      ),
    );
    for (const file of result.files) {
      console.log(`  ${chalk.green(file.score.toFixed(2))}  ${file.path}`);
      console.log(chalk.gray(`         ${file.reason}`));
      if (file.spans && file.spans.length > 0) {
        for (const span of file.spans.slice(0, 3)) {
          console.log(chalk.gray(`         L${span.line}: ${span.text}`));
        }
      }
    }
    console.log();
  });

// ── iw index connections ───────────────────────────────────────

const indexConnectionsSubcommand = new Command("connections")
  .description("Discover connections for an entity across doc, git, and code")
  .argument("<entity>", "Symbol name or keyword")
  .option("-n, --limit <n>", "Maximum connections per source", "10")
  .option(
    "--include <sources>",
    "Filter sources: doc_cooc,co_change,code_import",
  )
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((entity: string, opts) => {
    const dbPath = resolveDbPath(opts.db);
    const params: ConnectionsParams = {
      entity,
      limit: parseInt(opts.limit, 10),
      include: opts.include?.split(","),
    };

    const result = connections(dbPath, params);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(chalk.blue(`\n  ▸ Connections for: "${entity}"\n`));

    if (result.connections.length === 0) {
      console.log(chalk.yellow("  No connections found."));
      return;
    }

    // Group by source type for display
    const byType = new Map<string, typeof result.connections>();
    for (const conn of result.connections) {
      for (const src of conn.sources) {
        const list = byType.get(src.type) ?? [];
        list.push(conn);
        byType.set(src.type, list);
      }
    }

    const labels: Record<string, string> = {
      doc_cooc: "Co-mentioned in docs",
      co_change: "Co-changes in git",
      code_import: "Structural (code)",
    };

    for (const [type, conns] of byType) {
      console.log(chalk.cyan(`  ${labels[type] ?? type}:`));
      const seen = new Set<string>();
      for (const conn of conns) {
        if (seen.has(conn.name)) continue;
        seen.add(conn.name);
        const src = conn.sources.find((s) => s.type === type)!;
        const gapTag = conn.gap ? chalk.yellow(` ⚠ ${conn.gap}`) : "";
        console.log(`    ${conn.name.padEnd(30)} (${src.detail})${gapTag}`);
      }
      console.log();
    }

    if (result.gaps.length > 0) {
      console.log(chalk.yellow("  ⚠ Gaps:"));
      for (const gap of result.gaps) {
        const icon = gap.severity === "warning" ? "⚠" : "ℹ";
        console.log(`    ${icon} ${gap.description}`);
      }
      console.log();
    }
  });

// ── iw index check ─────────────────────────────────────────────

const indexCheckSubcommand = new Command("check")
  .description("CI drift detection: find docs affected by changed files")
  .argument("<changed...>", "Changed file paths (from PR diff or git status)")
  .option(
    "--severity <level>",
    "Minimum severity: info, warning, or critical",
    "info",
  )
  .option("--exclude <patterns...>", "Exclude findings matching these globs")
  .option(
    "-f, --format <format>",
    "Output format: text, json, or github",
    "text",
  )
  .option("--db <path>", "Path to index.db")
  .action(async (changed: string[], opts) => {
    const dbPath = resolveDbPath(opts.db);
    const cwd = process.cwd();

    // Filter changed files through .iwignore + --exclude + defaults
    const iwIgnorePatterns = await loadIwIgnore(cwd);
    const cliExcludes: string[] = opts.exclude ?? [];
    const allExcludes = buildExcludeList(cliExcludes, iwIgnorePatterns, true);

    let filteredChanged = changed;
    if (allExcludes.length > 0) {
      const { minimatch } = await import("minimatch");
      filteredChanged = changed.filter(
        (f) =>
          !allExcludes.some((p) =>
            minimatch(f.replace(/^\.\//, ""), p, { dot: true }),
          ),
      );
    }

    if (filteredChanged.length === 0) {
      console.log(
        chalk.green("\n  ✓ No relevant changed files (after filtering).\n"),
      );
      return;
    }

    const params: CheckParams = {
      changed: filteredChanged,
      severity: opts.severity,
      format: opts.format,
    };

    const result = check(dbPath, params);

    // Also filter findings whose file or related paths match excludes
    if (allExcludes.length > 0) {
      const { minimatch } = await import("minimatch");
      result.findings = result.findings.filter(
        (f) =>
          !allExcludes.some((p) =>
            minimatch(f.file.replace(/^\.\//, ""), p, { dot: true }),
          ),
      );
    }

    if (opts.format === "json" || opts.format === "github") {
      console.log(formatCheck(result, opts.format));
    } else {
      if (result.findings.length === 0) {
        console.log(chalk.green("\n  ✓ No drift findings.\n"));
      } else {
        console.log(chalk.blue(`\n  ▸ ${result.findings.length} finding(s)\n`));
        console.log(formatCheck(result, "text"));
        console.log();
      }
    }

    if (result.exitCode > 0) {
      process.exit(result.exitCode);
    }
  });

// ── iw index report ────────────────────────────────────────────

const indexReportSubcommand = new Command("report")
  .description("Corpus-wide insights: coverage, staleness, couplings")
  .option("--db <path>", "Path to index.db")
  .option(
    "--threshold <n>",
    "Minimum co-occurrence/co-change score (default: 0.3)",
    "0.3",
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const threshold = parseFloat(opts.threshold);
    const result = report(dbPath, {
      coocThreshold: threshold,
      cochangeThreshold: threshold,
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Coverage
    console.log(chalk.blue("\n  ▸ Documentation Coverage"));
    console.log(
      `    ${result.coverage.documented} / ${result.coverage.total} exported symbols documented (${result.coverage.percentage}%)`,
    );
    if (result.coverage.topUndocumented.length > 0) {
      console.log(chalk.gray("    Top undocumented:"));
      for (const sym of result.coverage.topUndocumented.slice(0, 5)) {
        console.log(
          chalk.gray(`      ${sym.kind} ${sym.name} (${sym.filePath})`),
        );
      }
    }

    // Staleness
    console.log(chalk.blue("\n  ▸ Staleness"));
    console.log(
      `    ${result.staleness.staleDocCount} doc(s) behind their referenced code`,
    );
    for (const stale of result.staleness.topStale.slice(0, 5)) {
      console.log(
        chalk.yellow(
          `    ${stale.docPath} — ${stale.daysBehind} days behind ${stale.newerCodeFile}`,
        ),
      );
    }

    // Hidden couplings
    const hiddenOnly = result.hiddenCouplings.filter(
      (c) => !c.hasCodeDependency,
    );
    if (hiddenOnly.length > 0) {
      console.log(chalk.blue("\n  ▸ Hidden Couplings"));
      console.log(
        `    ${hiddenOnly.length} entity pair(s) co-mentioned in docs but no code dependency`,
      );
      for (const c of hiddenOnly.slice(0, 5)) {
        console.log(
          chalk.yellow(
            `    ${c.entityA} ↔ ${c.entityB} (doc co-occ: ${c.docCoocScore})`,
          ),
        );
      }
    }

    // Undocumented deps
    if (result.undocumentedDeps.length > 0) {
      console.log(chalk.blue("\n  ▸ Undocumented Dependencies"));
      console.log(
        `    ${result.undocumentedDeps.length} co-change pair(s) with zero doc mentions`,
      );
      for (const dep of result.undocumentedDeps.slice(0, 5)) {
        console.log(
          chalk.gray(
            `    ${dep.entityA} ↔ ${dep.entityB} (${dep.coChangeCount} co-changes, 0 doc mentions)`,
          ),
        );
      }
    }

    console.log();
  });

// ── iw index update ────────────────────────────────────────────

const indexUpdateSubcommand = new Command("update")
  .description("Incrementally update the CARI index for changed files only")
  .argument(
    "[paths...]",
    "Scope to specific directories (default: workspace root)",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "-s, --session <name>",
    "Session name (reads from existing DB if omitted)",
  )
  .option("--exclude <patterns...>", "Exclude files matching these globs")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    const cwd = process.cwd();
    const dbPath = resolveDbPath(opts.db);
    const verbose = opts.verbose;
    const log = verbose
      ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
      : () => {};

    // Build exclude list
    const iwIgnorePatterns = await loadIwIgnore(cwd);
    const cliExcludes: string[] = opts.exclude ?? [];
    const excludePatterns = buildExcludeList(
      cliExcludes,
      iwIgnorePatterns,
      true,
    );

    try {
      // Verify existing index
      const fsSync = await import("node:fs");
      if (!fsSync.existsSync(dbPath)) {
        console.error(
          chalk.red(
            `\n  ✗ No index found at ${dbPath}. Run "iw index build" first.\n`,
          ),
        );
        process.exit(1);
      }

      console.log(chalk.blue(`\n  ▸ CARI Incremental Update`));
      const pipelineStart = performance.now();

      // ── 1. Discover current files ────────────────────────────
      const scanPaths = paths.length > 0 ? paths : [cwd];
      const docFiles = await discoverFiles(scanPaths, cwd, {
        exclude: excludePatterns,
      });
      // Also discover code files via AX
      const axOutput = await runAxStage({ workspaceRoot: cwd });
      const allCodeFiles = axOutput.files.map((f) =>
        path.resolve(cwd, f.filePath),
      );
      const allFiles = [...docFiles, ...allCodeFiles];
      log(
        `Scanned ${docFiles.length} doc files, ${allCodeFiles.length} code files`,
      );

      // ── 2. Detect changes ────────────────────────────────────
      const changes = detectChanges(dbPath, cwd, allFiles);

      if (changes.length === 0) {
        const elapsed = performance.now() - pipelineStart;
        console.log(
          chalk.green(`\n  ✓ Index is up to date (${elapsed.toFixed(0)}ms)\n`),
        );
        return;
      }

      console.log(
        chalk.cyan(
          `  ${changes.length} change(s): ` +
            `${changes.filter((c) => c.status === "added").length} added, ` +
            `${changes.filter((c) => c.status === "modified").length} modified, ` +
            `${changes.filter((c) => c.status === "deleted").length} deleted`,
        ),
      );

      // ── 3. Re-extract for changed doc files ──────────────────
      const changedDocs = changes.filter(
        (c) => c.isDoc && c.status !== "deleted",
      );
      const kwxOutputs: KwxStageOutput[] = [];
      const ctx = createMinimalContext(verbose);

      for (const change of changedDocs) {
        const abs = path.resolve(cwd, change.path);
        log(`  KWX: ${change.path}`);

        const content = await fs.readFile(abs, "utf-8");
        const artifactId = toArtifactId(abs, cwd);

        const inInput: InStageInput = {
          artifactId,
          filePath: change.path,
          content,
        };
        const inOutput = await runInStage(inInput, ctx as any);
        const kwxOutput = await runKwxStage({ inOutput });
        kwxOutputs.push(kwxOutput);
      }

      // Re-run COX on changed doc KWX outputs
      const coxOutput =
        kwxOutputs.length > 0 ? await runCoxStage({ kwxOutputs }) : undefined;

      // ── 4. Annotate changed files ────────────────────────────
      // Only annotate if we have both code symbols and doc mentions
      const annotations =
        kwxOutputs.length > 0 ? annotate(axOutput, kwxOutputs, { log }) : [];

      // ── 5. Refresh TCG (lightweight — git data) ──────────────
      const tcgStart = performance.now();
      const tcxOutput = await runTcxStage({
        workspaceRoot: cwd,
        depth: 100, // shallow for incremental
        log: verbose
          ? (msg: string) => console.log(chalk.gray(`  tcx: ${msg}`))
          : undefined,
      });
      const cocOutput = runCocStage({ tcxOutput });
      const hotOutput = runHotStage({ tcxOutput });
      const ownOutput = runOwnStage({ tcxOutput });
      const stlOutput = runStlStage({
        tcxOutput,
        workspaceRoot: cwd,
      });

      const tcgOutput: TcgPipelineOutput = {
        tcx: tcxOutput,
        coc: cocOutput,
        hot: hotOutput,
        own: ownOutput,
        stl: stlOutput,
        meta: {
          session: opts.session ?? "incremental",
          workspaceRoot: cwd,
          gitDepth: "100 commits",
          totalDurationMs: performance.now() - tcgStart,
        },
      };

      // ── 6. Apply changes to index ────────────────────────────
      const result = applyChanges(
        dbPath,
        changes,
        {
          ax: axOutput,
          kwxOutputs,
          cox: coxOutput,
          annotations,
          tcg: tcgOutput,
        },
        { dbPath, workspaceRoot: cwd, log },
      );

      const totalMs = performance.now() - pipelineStart;
      console.log(
        `\n  ${chalk.green("✓")} Incremental update in ${(totalMs / 1000).toFixed(1)}s`,
      );
      console.log(
        chalk.gray(
          `    symbols=${result.updated.symbols} annotations=${result.updated.annotations} ` +
            `co_occ=${result.updated.coOccurrences} files=${result.updated.files}`,
        ),
      );
    } catch (err: any) {
      console.error(
        chalk.red(`\n  ✗ Incremental update failed: ${err.message}`),
      );
      if (verbose && err.stack) {
        console.error(chalk.gray(err.stack));
      }
      process.exit(1);
    }
  });

// ── iw index clones ────────────────────────────────────────────

const indexClonesSubcommand = new Command("clones")
  .description("Detect exact code clones (identical body hash)")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = clones(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalCloneGroups === 0) {
      console.log(chalk.green("\n  ✓ No exact clones found.\n"));
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ ${result.totalCloneGroups} clone group(s), ${result.totalClonedSymbols} symbol(s)`,
      ),
    );

    for (const group of result.cloneGroups) {
      console.log(
        chalk.cyan(
          `\n    Clone group (${group.bodyLines} lines, ${group.symbols.length} copies):`,
        ),
      );
      for (const s of group.symbols) {
        console.log(
          chalk.gray(`      ${s.kind} ${s.name} (${s.filePath}:${s.line})`),
        );
      }
    }
    console.log();
  });

// ── iw index structural-clones ─────────────────────────────────

const indexStructuralClonesSubcommand = new Command("structural-clones")
  .description(
    "Detect structural code clones (same AST structure, different identifiers)",
  )
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = structuralClones(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalCloneGroups === 0) {
      console.log(chalk.green("\n  ✓ No structural clones found.\n"));
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ ${result.totalCloneGroups} structural clone group(s), ${result.totalClonedSymbols} symbol(s)`,
      ),
    );

    for (const group of result.cloneGroups) {
      console.log(
        chalk.cyan(
          `\n    Clone group (${group.bodyLines} lines, ${group.symbols.length} copies):`,
        ),
      );
      for (const s of group.symbols) {
        console.log(
          chalk.gray(`      ${s.kind} ${s.name} (${s.filePath}:${s.line})`),
        );
      }
    }
    console.log();
  });

// ── iw index circular-imports ──────────────────────────────────

const indexCircularImportsSubcommand = new Command("circular-imports")
  .description("Detect circular import cycles")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = circularImports(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalCycles === 0) {
      console.log(chalk.green("\n  ✓ No circular imports detected.\n"));
      return;
    }

    console.log(
      chalk.blue(`\n  ▸ ${result.totalCycles} circular import cycle(s)`),
    );

    for (const cycle of result.cycles) {
      console.log(
        chalk.yellow(
          `\n    ${cycle.length}-file cycle: ${cycle.files.join(" → ")} → ${cycle.files[0]}`,
        ),
      );
    }
    console.log();
  });

// ── iw index unused-exports ────────────────────────────────────

const indexUnusedExportsSubcommand = new Command("unused-exports")
  .description("Find exported symbols never imported anywhere")
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "50")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = unusedExports(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalUnused === 0) {
      console.log(
        chalk.green(
          `\n  ✓ All ${result.totalExported} exported symbols are imported somewhere.\n`,
        ),
      );
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ ${result.totalUnused} of ${result.totalExported} exported symbols are unused`,
      ),
    );

    const limit = parseInt(opts.limit, 10);
    for (const u of result.unused.slice(0, limit)) {
      console.log(
        chalk.yellow(`    ${u.kind} ${u.name} (${u.filePath}:${u.line})`),
      );
    }
    if (result.totalUnused > limit) {
      console.log(chalk.gray(`    ...and ${result.totalUnused - limit} more`));
    }
    console.log();
  });

// ── iw index hotspot-priority ──────────────────────────────────

const indexHotspotPrioritySubcommand = new Command("hotspot-priority")
  .description(
    "Rank files by documentation urgency (high churn × low coverage)",
  )
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "20")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = hotspotPriority(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.priorities.length === 0) {
      console.log(
        chalk.gray(
          "\n  No hotspot data — ensure index was built with git history.\n",
        ),
      );
      return;
    }

    const limit = parseInt(opts.limit, 10);
    const items = result.priorities.slice(0, limit);

    console.log(
      chalk.blue(`\n  ▸ Hotspot Priority — top ${items.length} files`),
    );
    console.log(
      chalk.gray(
        "    File                                          Churn  Coverage  Priority",
      ),
    );

    for (const p of items) {
      const file = p.filePath.padEnd(48);
      console.log(
        `    ${file} ${String(p.churn).padStart(5)}  ${(p.coveragePercent.toFixed(0) + "%").padStart(8)}  ${p.priorityScore.toFixed(2)}`,
      );
    }
    console.log();
  });

// ── iw index todos ─────────────────────────────────────────────

const indexTodosSubcommand = new Command("todos")
  .description("List TODO/FIXME/HACK/XXX comments")
  .option("--db <path>", "Path to index.db")
  .option("--kind <kind>", "Filter by kind: TODO, FIXME, HACK, XXX")
  .option("-n, --limit <n>", "Maximum results", "50")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = todos(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    let items = result.todos;
    if (opts.kind) {
      items = items.filter(
        (t) => t.kind.toLowerCase() === opts.kind.toLowerCase(),
      );
    }

    if (items.length === 0) {
      console.log(
        chalk.green(
          opts.kind
            ? `\n  ✓ No ${opts.kind} comments found.\n`
            : "\n  ✓ No TODO/FIXME/HACK/XXX comments found.\n",
        ),
      );
      return;
    }

    const kindSummary = Object.entries(result.byKind)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    console.log(
      chalk.blue(`\n  ▸ ${result.totalCount} total (${kindSummary})`),
    );

    const limit = parseInt(opts.limit, 10);
    for (const t of items.slice(0, limit)) {
      const kindColor =
        t.kind === "FIXME" || t.kind === "HACK" ? chalk.red : chalk.yellow;
      console.log(
        `    ${kindColor(t.kind.padEnd(5))} ${chalk.gray(t.filePath + ":" + t.line)} ${t.text}`,
      );
    }
    if (items.length > limit) {
      console.log(chalk.gray(`    ...and ${items.length - limit} more`));
    }
    console.log();
  });

// ── iw index module-coverage ───────────────────────────────────

const indexModuleCoverageSubcommand = new Command("module-coverage")
  .description("Documentation coverage percentage per directory")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = moduleCoverage(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.modules.length === 0) {
      console.log(chalk.gray("\n  No module coverage data available.\n"));
      return;
    }

    console.log(
      chalk.blue(`\n  ▸ Module Coverage — ${result.modules.length} module(s)`),
    );
    console.log(
      chalk.gray(
        "    Module                                        Documented  Total  Coverage",
      ),
    );

    for (const m of result.modules) {
      const mod = m.module.padEnd(48);
      const pct = m.coveragePercent.toFixed(0) + "%";
      const color =
        m.coveragePercent >= 80
          ? chalk.green
          : m.coveragePercent >= 50
            ? chalk.yellow
            : chalk.red;
      console.log(
        `    ${mod} ${String(m.documented).padStart(10)}  ${String(m.totalExported).padStart(5)}  ${color(pct.padStart(8))}`,
      );
    }
    console.log();
  });

// ── iw index orphaned-sections ─────────────────────────────────

const indexOrphanedSectionsSubcommand = new Command("orphaned-sections")
  .description("Find doc sections where all mentions are ungrounded")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = orphanedSections(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalOrphaned === 0) {
      console.log(
        chalk.green(
          "\n  ✓ No orphaned sections — all sections have grounded mentions.\n",
        ),
      );
      return;
    }

    console.log(
      chalk.blue(`\n  ▸ ${result.totalOrphaned} orphaned section(s)`),
    );

    for (const s of result.sections) {
      console.log(
        chalk.yellow(
          `    ${s.docPath}:${s.line} — "${s.heading}" (${s.ungroundedMentions} ungrounded)`,
        ),
      );
    }
    console.log();
  });

// ── iw index doc-completeness ──────────────────────────────────

const indexDocCompletenessSubcommand = new Command("doc-completeness")
  .description("Per-doc completeness vs. referenced exports")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = docCompleteness(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.docs.length === 0) {
      console.log(chalk.gray("\n  No doc completeness data available.\n"));
      return;
    }

    console.log(chalk.blue("\n  ▸ Doc Completeness"));
    console.log(
      chalk.gray(
        "    Document                                      Covered  Total  Completeness",
      ),
    );

    for (const d of result.docs) {
      const doc = d.docPath.padEnd(48);
      const pct = d.completenessPercent.toFixed(0) + "%";
      const color =
        d.completenessPercent >= 80
          ? chalk.green
          : d.completenessPercent >= 50
            ? chalk.yellow
            : chalk.red;
      console.log(
        `    ${doc} ${String(d.coveredExports).padStart(7)}  ${String(d.totalRelevantExports).padStart(5)}  ${color(pct.padStart(12))}`,
      );

      if (d.missing.length > 0 && d.missing.length <= 5) {
        for (const m of d.missing) {
          console.log(
            chalk.gray(`      missing: ${m.kind} ${m.name} (${m.filePath})`),
          );
        }
      } else if (d.missing.length > 5) {
        console.log(
          chalk.gray(`      ${d.missing.length} exported symbols missing`),
        );
      }
    }
    console.log();
  });

// ── iw index cross-group-drift ─────────────────────────────────

const indexCrossGroupDriftSubcommand = new Command("cross-group-drift")
  .description("Cross-group entity coverage conflicts")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = crossGroupDrift(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalDrifts === 0) {
      console.log(
        chalk.green(
          "\n  ✓ No cross-group drift — entity coverage is consistent.\n",
        ),
      );
      return;
    }

    console.log(
      chalk.blue(`\n  ▸ ${result.totalDrifts} cross-group drift finding(s)`),
    );

    for (const drift of result.drifts) {
      console.log(chalk.yellow(`\n    ${drift.entity}: ${drift.reason}`));
      for (const g of drift.groups) {
        const quals =
          g.qualifiers.length > 0 ? ` [${g.qualifiers.join(", ")}]` : "";
        console.log(
          chalk.gray(
            `      ${g.docGroup}: ${g.mentionCount} mention(s) in ${g.docPaths.join(", ")}${quals}`,
          ),
        );
      }
    }
    console.log();
  });

export const indexCommand = new Command("index")
  .description("CARI — Code-Aware Retrieval Index commands")
  .addCommand(indexBuildSubcommand)
  .addCommand(indexUpdateSubcommand)
  .addCommand(indexRetrieveSubcommand)
  .addCommand(indexConnectionsSubcommand)
  .addCommand(indexCheckSubcommand)
  .addCommand(indexReportSubcommand)
  .addCommand(indexClonesSubcommand)
  .addCommand(indexStructuralClonesSubcommand)
  .addCommand(indexCircularImportsSubcommand)
  .addCommand(indexUnusedExportsSubcommand)
  .addCommand(indexHotspotPrioritySubcommand)
  .addCommand(indexTodosSubcommand)
  .addCommand(indexModuleCoverageSubcommand)
  .addCommand(indexOrphanedSectionsSubcommand)
  .addCommand(indexDocCompletenessSubcommand)
  .addCommand(indexCrossGroupDriftSubcommand);

// =============================================================================
// @internal — Exported for testing only
// =============================================================================

export {
  DEFAULT_EXCLUDES,
  loadIwIgnore,
  buildExcludeList,
  discoverFiles,
  isExcluded,
};
