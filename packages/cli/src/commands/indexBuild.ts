// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw index build — Build the Code-Aware Retrieval Index (CARI).
 *
 * Thin CLI wrapper over `buildFromPaths()` from @intentweave/index.
 * All pipeline orchestration lives in the facade — this file only
 * handles argument parsing and formatted console output.
 *
 * Output: .iw/index.db
 *
 * Usage:
 *   iw index build docs/ -s my-project -v
 *   iw index build docs/ -s my-project --depth full -v
 *
 * @version 0.2
 */

import { Command } from "commander";
import chalk from "chalk";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

// Analyzer stages (used by update subcommand)
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

// Core types (used by update subcommand TCG assembly)
import type { KwxStageOutput, TcgPipelineOutput } from "@intentweave/core";

// Index package — facade + queries
import {
  buildFromPaths,
  type CariStageProgress,
  annotate,
} from "@intentweave/index";
import { detectChanges, applyChanges, hashFile } from "@intentweave/index";

// Import facade utilities for local use + re-export for test access
import {
  DEFAULT_EXCLUDES,
  loadIwIgnore,
  buildExcludeList,
  discoverFiles,
  isExcluded,
} from "@intentweave/index";

export {
  DEFAULT_EXCLUDES,
  loadIwIgnore,
  buildExcludeList,
  discoverFiles,
  isExcluded,
};

// =============================================================================
// Subcommand: iw index build
// =============================================================================

const BAR = "████████████████████████████████";

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
    const cwd = process.cwd();
    const session = opts.session ?? path.basename(cwd);
    const verbose = opts.verbose;

    console.log(chalk.blue(`\n  ▸ CARI Index Build — session: ${session}`));
    console.log(
      chalk.blue(
        `  ▸ depth: ${opts.depth} | output: ${opts.output ?? ".iw/index.db"}\n`,
      ),
    );

    try {
      const result = await buildFromPaths({
        paths,
        workspaceRoot: cwd,
        depth: opts.depth as "structured" | "full",
        exclude: opts.exclude,
        include: opts.include,
        session,
        outputPath: opts.output,
        log: verbose
          ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
          : undefined,
        onProgress: (p) => {
          const label = p.stage.toUpperCase().padEnd(4);
          console.log(
            `  ${label} ${chalk.green(BAR)}  ${(p.durationMs / 1000).toFixed(1)}s`,
          );
          console.log(chalk.gray(`       → ${p.detail}`));
        },
      });

      console.log(`\n  ${chalk.green("✓")} Index built → ${result.dbPath}`);
      console.log(
        chalk.gray(
          `    symbols=${result.counts.symbols} annotations=${result.counts.annotations} ` +
            `co_occ=${result.counts.coOccurrences} co_change=${result.counts.coChanges} ` +
            `files=${result.counts.files}`,
        ),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(chalk.red(`\n  ✗ Index build failed: ${msg}`));
      if (verbose && stack) {
        console.error(chalk.gray(stack));
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
  mentionsOf,
  annotationsForFile,
  registerExternalEntities,
  testCoverage,
  hubs,
  communities,
  surprises,
  rationale,
  terminologyInconsistency,
} from "@intentweave/index";
import type {
  RetrieveParams,
  ConnectionsParams,
  CheckParams,
  ExternalEntity,
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

// Helpers for update subcommand
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

// ── iw index mentions-of ──────────────────────────────────────

const indexMentionsOfSubcommand = new Command("mentions-of")
  .description("Find all document mentions referencing an entity")
  .argument("<entityId>", "Entity ID (symbol or external entity)")
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "100")
  .option("--min-confidence <n>", "Minimum confidence threshold (0-1)", "0")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((entityId, opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = mentionsOf(dbPath, {
      entityId,
      limit: parseInt(opts.limit, 10),
      minConfidence: parseFloat(opts.minConfidence),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalCount === 0) {
      console.log(chalk.green(`\n  ✓ No mentions found for "${entityId}".\n`));
      return;
    }

    console.log(
      chalk.blue(`\n  ▸ ${result.totalCount} mention(s) of "${entityId}"`),
    );

    for (const m of result.mentions) {
      const qual = m.qualifier ? ` [${m.qualifier}]` : "";
      console.log(
        `    ${chalk.gray(m.docPath + ":" + m.line)} ${m.text} ${chalk.dim(`(${m.confidence.toFixed(2)})`)}${qual}`,
      );
    }
    console.log();
  });

// ── iw index annotations-for ──────────────────────────────────

const indexAnnotationsForSubcommand = new Command("annotations-for")
  .description("List all annotations for a document file")
  .argument("<filePath>", "Document file path (relative to workspace)")
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "500")
  .option("--min-confidence <n>", "Minimum confidence threshold (0-1)", "0")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((filePath, opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = annotationsForFile(dbPath, {
      filePath,
      limit: parseInt(opts.limit, 10),
      minConfidence: parseFloat(opts.minConfidence),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalCount === 0) {
      console.log(
        chalk.green(`\n  ✓ No annotations found for "${filePath}".\n`),
      );
      return;
    }

    console.log(
      chalk.blue(`\n  ▸ ${result.totalCount} annotation(s) in "${filePath}"`),
    );

    console.log(
      "    " +
        chalk.gray(
          "Line".padEnd(6) +
            "Confidence".padEnd(12) +
            "Source".padEnd(12) +
            "Entity".padEnd(30) +
            "Text",
        ),
    );

    for (const a of result.annotations) {
      const entityLabel = a.entityName
        ? `${a.entityName} (${a.entitySource})`
        : chalk.dim("ungrounded");
      console.log(
        `    ${String(a.line).padEnd(6)}${a.confidence.toFixed(2).padEnd(12)}${a.source.padEnd(12)}${entityLabel.padEnd(30)}${a.text}`,
      );
    }
    console.log();
  });

// ── iw index register-entities ────────────────────────────────

const indexRegisterEntitiesSubcommand = new Command("register-entities")
  .description("Register external entities from a JSON file")
  .argument("<file>", "Path to JSON file containing an array of entities")
  .option("--db <path>", "Path to index.db")
  .action(async (file, opts) => {
    const dbPath = resolveDbPath(opts.db);
    const content = await fs.readFile(file, "utf-8");
    let entities: ExternalEntity[];
    try {
      entities = JSON.parse(content);
    } catch {
      console.error(chalk.red(`  ✗ Failed to parse ${file} as JSON.`));
      process.exitCode = 1;
      return;
    }

    if (!Array.isArray(entities)) {
      console.error(
        chalk.red("  ✗ JSON file must contain an array of entities."),
      );
      process.exitCode = 1;
      return;
    }

    const result = registerExternalEntities(dbPath, entities, {
      log: (msg) => console.log(chalk.gray(`  ${msg}`)),
    });

    console.log(
      chalk.green(
        `\n  ✓ Registered ${result.entitiesWritten} entities, ` +
          `created ${result.annotationsCreated} annotations.\n`,
      ),
    );
  });

const indexTestCoverageSubcommand = new Command("test-coverage")
  .description(
    "Map test files to source files and find untested exported symbols",
  )
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Max untested symbols to show", parseInt)
  .option("-f, --format <format>", "Output format: text or json", "text")
  .option("-v, --verbose", "Show test→source mappings", false)
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = testCoverage(dbPath, { limit: opts.limit });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const color =
      result.coveragePercent >= 80
        ? chalk.green
        : result.coveragePercent >= 50
          ? chalk.yellow
          : chalk.red;
    console.log(
      chalk.blue("\n  ▸ Test Coverage: ") +
        color(
          `${result.covered}/${result.totalExported} exported symbols (${result.coveragePercent}%)`,
        ),
    );

    if (opts.verbose && result.mappings.length > 0) {
      console.log(chalk.gray("\n    Mappings:"));
      for (const m of result.mappings) {
        const strat =
          m.strategy === "both"
            ? chalk.cyan("naming+import")
            : m.strategy === "naming"
              ? chalk.blue("naming")
              : chalk.magenta("import");
        console.log(
          chalk.gray(
            `      ${m.testFile} → ${m.sourceFile}  [${strat}${chalk.gray("]")}`,
          ),
        );
      }
    }

    if (result.untested.length > 0) {
      console.log(chalk.gray("\n    Untested exported symbols:"));
      for (const u of result.untested) {
        console.log(
          chalk.gray(`      ${u.kind} `) +
            chalk.white(u.name) +
            chalk.gray(` (${u.filePath}:${u.line})`),
        );
      }
    }

    if (result.byDirectory.length > 0) {
      console.log(chalk.gray("\n    Per-directory coverage:"));
      for (const d of result.byDirectory) {
        const dColor =
          d.coveragePercent >= 80
            ? chalk.green
            : d.coveragePercent >= 50
              ? chalk.yellow
              : chalk.red;
        console.log(
          chalk.gray(`      ${d.directory.padEnd(48)} `) +
            dColor(
              `${d.covered}/${d.totalExported} (${d.coveragePercent.toFixed(0)}%)`,
            ),
        );
      }
    }
    console.log();
  });

// ── iw index hubs ─────────────────────────────────────────────

const indexHubsSubcommand = new Command("hubs")
  .description(
    "Rank entities by degree centrality across all edge types (god-node analysis)",
  )
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "20")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = hubs(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.hubs.length === 0) {
      console.log(
        chalk.gray("\n  No hub data available. Ensure the index is built.\n"),
      );
      return;
    }

    const limit = parseInt(opts.limit, 10);
    const items = result.hubs.slice(0, limit);

    console.log(
      chalk.blue(`\n  ▸ Top ${items.length} hubs (by total degree)`),
    );
    console.log(
      chalk.gray(
        "    Entity                                        Kind       Ann  Imp  CoOcc  CoChg  Total",
      ),
    );

    for (const h of items) {
      const name = h.name.length > 48 ? h.name.slice(0, 45) + "..." : h.name;
      console.log(
        `    ${name.padEnd(48)} ${h.kind.padEnd(10)} ${String(h.annotationDegree).padStart(4)} ${String(h.importDegree).padStart(4)} ${String(h.coOccurrenceDegree).padStart(5)} ${String(h.coChangeDegree).padStart(5)} ${String(h.totalDegree).padStart(6)}`,
      );
    }
    console.log();
  });

// ── iw index communities ──────────────────────────────────────

const indexCommunitiesSubcommand = new Command("communities")
  .description(
    "Detect natural module clusters via label propagation on the combined graph",
  )
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = communities(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.communities.length === 0) {
      console.log(
        chalk.gray(
          "\n  No communities detected. Ensure the index has co-occurrence or import data.\n",
        ),
      );
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ ${result.totalCommunities} communities detected (${result.totalNodes} nodes)`,
      ),
    );

    for (const c of result.communities) {
      console.log(
        chalk.cyan(`\n    Community ${c.id}: ${c.label} (${c.size} members)`),
      );
      const display = c.members.slice(0, 10);
      for (const m of display) {
        console.log(
          chalk.gray(`      • ${m.name}`) +
            (m.kind !== "unknown" ? chalk.gray(` [${m.kind}]`) : ""),
        );
      }
      if (c.members.length > 10) {
        console.log(
          chalk.gray(`      … and ${c.members.length - 10} more`),
        );
      }
    }
    console.log();
  });

// ── iw index surprises ────────────────────────────────────────

const indexSurprisesSubcommand = new Command("surprises")
  .description(
    "Rank connections by composite surprise score (cross-layer, community distance, rarity)",
  )
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "20")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = surprises(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.surprises.length === 0) {
      console.log(
        chalk.gray(
          "\n  No surprising connections found. Ensure the index has edges.\n",
        ),
      );
      return;
    }

    const limit = parseInt(opts.limit, 10);
    const items = result.surprises.slice(0, limit);

    console.log(
      chalk.blue(
        `\n  ▸ Top ${items.length} surprising connections (of ${result.totalEvaluated} evaluated)`,
      ),
    );

    for (const s of items) {
      console.log(
        chalk.white(`\n    ${s.entityA} ↔ ${s.entityB}`) +
          chalk.yellow(` (score: ${s.score})`),
      );
      console.log(
        chalk.gray(`      ${s.reason}`),
      );
      console.log(
        chalk.gray(
          `      cross-layer=${s.crossLayerWeight} community=${s.communityDistance} rarity=${s.inverseFrequency}`,
        ),
      );
    }
    console.log();
  });

// ── iw index rationale ────────────────────────────────────────

const indexRationaleSubcommand = new Command("rationale")
  .description(
    "List WHY/NOTE/IMPORTANT/DESIGN rationale comments found in the codebase",
  )
  .option("--db <path>", "Path to index.db")
  .option("--kind <kind>", "Filter by kind: WHY, NOTE, IMPORTANT, DESIGN")
  .option("-n, --limit <n>", "Maximum results", "50")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = rationale(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    let items = result.rationale;
    if (opts.kind) {
      items = items.filter(
        (r) => r.kind.toLowerCase() === opts.kind.toLowerCase(),
      );
    }

    if (items.length === 0) {
      console.log(
        chalk.gray(
          opts.kind
            ? `\n  No ${opts.kind} rationale comments found.\n`
            : "\n  No WHY/NOTE/IMPORTANT/DESIGN rationale comments found.\n",
        ),
      );
      return;
    }

    const limit = parseInt(opts.limit, 10);
    const limited = items.slice(0, limit);

    const kindSummary = Object.entries(result.byKind)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    console.log(
      chalk.blue(`\n  ▸ ${result.totalCount} rationale comments (${kindSummary})`),
    );

    for (const r of limited) {
      const kindColor =
        r.kind === "why"
          ? chalk.yellow
          : r.kind === "important"
            ? chalk.red
            : r.kind === "design"
              ? chalk.cyan
              : chalk.gray;
      console.log(
        `    ${chalk.gray(r.filePath + ":" + r.line)} ${kindColor(r.kind.toUpperCase())} ${r.text}`,
      );
    }
    console.log();
  });

// ── iw index terminology ──────────────────────────────────────

const indexTerminologySubcommand = new Command("terminology")
  .description(
    "Detect terminology inconsistencies — different names for the same code symbol across docs",
  )
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "20")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = terminologyInconsistency(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalInconsistencies === 0) {
      console.log(
        chalk.green(
          `\n  ✓ No terminology inconsistencies found (${result.totalAnalyzed} entities analyzed).\n`,
        ),
      );
      return;
    }

    const limit = parseInt(opts.limit, 10);
    const items = result.inconsistencies.slice(0, limit);

    console.log(
      chalk.blue(
        `\n  ▸ ${result.totalInconsistencies} terminology inconsistencies (${result.totalAnalyzed} entities analyzed)`,
      ),
    );

    const severityColor = (s: string) =>
      s === "critical"
        ? chalk.red(s)
        : s === "warning"
          ? chalk.yellow(s)
          : chalk.gray(s);

    for (const inc of items) {
      console.log(
        `\n    ${chalk.bold(inc.symbolName)} ${chalk.gray(`(${inc.kind})`)} — ${severityColor(inc.severity)} — consistency: ${Math.round(inc.consistency * 100)}%`,
      );
      console.log(chalk.gray(`    ${inc.filePath}`));
      console.log(chalk.gray("    Variants:"));
      for (const v of inc.variants) {
        const isCanonical = v.text === inc.symbolName ? chalk.green(" ← canonical") : "";
        console.log(
          `      "${v.text}" × ${v.count} (avg conf: ${v.avgConfidence})${isCanonical}`,
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
  .addCommand(indexCrossGroupDriftSubcommand)
  .addCommand(indexMentionsOfSubcommand)
  .addCommand(indexAnnotationsForSubcommand)
  .addCommand(indexRegisterEntitiesSubcommand)
  .addCommand(indexTestCoverageSubcommand)
  .addCommand(indexHubsSubcommand)
  .addCommand(indexCommunitiesSubcommand)
  .addCommand(indexSurprisesSubcommand)
  .addCommand(indexRationaleSubcommand)
  .addCommand(indexTerminologySubcommand);
