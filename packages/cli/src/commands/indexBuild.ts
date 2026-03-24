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
import type {
  KwxStageOutput,
  TcgPipelineOutput,
} from "@intentweave/core";

// Index package
import { buildIndex, annotate, computeIdf } from "@intentweave/index";
import { detectChanges, applyChanges, hashFile } from "@intentweave/index";
import type { IndexBuildOptions } from "@intentweave/index";

// =============================================================================
// File Discovery
// =============================================================================

const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

async function discoverFiles(
  paths: string[],
  cwd: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;

    if (stat.isFile()) {
      if (SUPPORTED_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
        files.push(abs);
      }
    } else if (stat.isDirectory()) {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const subPaths = entries.map((e) => path.join(abs, e.name));
      files.push(...(await discoverFiles(subPaths, cwd)));
    }
  }
  return [...new Set(files)].sort();
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
  .description(
    "Build CARI index: KWG + TCG + AX → SQLite (.iw/index.db)",
  )
  .argument("<paths...>", "Document file(s) or directories to analyze")
  .requiredOption("-s, --session <name>", "Session name")
  .option(
    "--depth <depth>",
    "Annotation depth: structured (default) or full (includes IDF scoring)",
    "structured",
  )
  .option("-o, --output <path>", "Output path for the SQLite database")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    const { session, depth, output, verbose } = opts;
    const cwd = process.cwd();
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
      const docFiles = await discoverFiles(paths, cwd);
      if (docFiles.length === 0) {
        console.error(
          chalk.red("No document files found in the given paths."),
        );
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
          { depth: depth as "structured" | "full", dictionary: symbolDictionary },
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
        kwgEntities: kwxOutputs
          .flatMap((o) => o.entities)
          .map((e) => e.name),
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
      const idfScores =
        depth === "full" ? computeIdf(kwxOutputs) : undefined;

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

    console.log(chalk.blue(`\n  ▸ Top ${result.files.length} files for: "${params.query}"\n`));
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
  .option("--include <sources>", "Filter sources: doc_cooc,co_change,code_import")
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
        console.log(
          `    ${conn.name.padEnd(30)} (${src.detail})${gapTag}`,
        );
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
  .option("--severity <level>", "Minimum severity: info, warning, or critical", "info")
  .option("-f, --format <format>", "Output format: text, json, or github", "text")
  .option("--db <path>", "Path to index.db")
  .action((changed: string[], opts) => {
    const dbPath = resolveDbPath(opts.db);
    const params: CheckParams = {
      changed,
      severity: opts.severity,
      format: opts.format,
    };

    const result = check(dbPath, params);

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
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = report(dbPath);

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
        console.log(chalk.gray(`      ${sym.kind} ${sym.name} (${sym.filePath})`));
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
    const hiddenOnly = result.hiddenCouplings.filter((c) => !c.hasCodeDependency);
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
  .description(
    "Incrementally update the CARI index for changed files only",
  )
  .argument("[paths...]", "Scope to specific directories (default: workspace root)")
  .option("--db <path>", "Path to index.db")
  .option("-s, --session <name>", "Session name (reads from existing DB if omitted)")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    const cwd = process.cwd();
    const dbPath = resolveDbPath(opts.db);
    const verbose = opts.verbose;
    const log = verbose
      ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
      : () => {};

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
      const docFiles = await discoverFiles(scanPaths, cwd);
      // Also discover code files via AX
      const axOutput = await runAxStage({ workspaceRoot: cwd });
      const allCodeFiles = axOutput.files.map((f) =>
        path.resolve(cwd, f.filePath),
      );
      const allFiles = [...docFiles, ...allCodeFiles];
      log(`Scanned ${docFiles.length} doc files, ${allCodeFiles.length} code files`);

      // ── 2. Detect changes ────────────────────────────────────
      const changes = detectChanges(dbPath, cwd, allFiles);

      if (changes.length === 0) {
        const elapsed = performance.now() - pipelineStart;
        console.log(
          chalk.green(
            `\n  ✓ Index is up to date (${(elapsed).toFixed(0)}ms)\n`,
          ),
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
        kwxOutputs.length > 0
          ? await runCoxStage({ kwxOutputs })
          : undefined;

      // ── 4. Annotate changed files ────────────────────────────
      // Only annotate if we have both code symbols and doc mentions
      const annotations =
        kwxOutputs.length > 0
          ? annotate(axOutput, kwxOutputs, { log })
          : [];

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

export const indexCommand = new Command("index")
  .description("CARI — Code-Aware Retrieval Index commands")
  .addCommand(indexBuildSubcommand)
  .addCommand(indexUpdateSubcommand)
  .addCommand(indexRetrieveSubcommand)
  .addCommand(indexConnectionsSubcommand)
  .addCommand(indexCheckSubcommand)
  .addCommand(indexReportSubcommand);
