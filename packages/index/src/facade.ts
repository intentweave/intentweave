// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CariIndex — High-level facade for the Code-Aware Retrieval Index.
 *
 * Provides a consumer-friendly API that wraps pipeline orchestration,
 * DB lifecycle, and typed query methods. Consumers call `CariIndex.build()`
 * or `CariIndex.load()` and get a ready-to-query instance.
 *
 * @example
 * ```typescript
 * import { CariIndex } from '@intentweave/index';
 *
 * // Build from scratch
 * const index = await CariIndex.build({
 *   paths: ['docs/', 'packages/'],
 *   workspaceRoot: process.cwd(),
 *   depth: 'full',
 * });
 *
 * // Or load existing
 * const index = CariIndex.load('.iw/index.db');
 *
 * // Query
 * const results = index.retrieve({ query: 'authentication' });
 * const drift   = index.check({ changed: ['src/auth.ts'] });
 *
 * // Cleanup
 * index.close();
 * ```
 */

import type { Database } from "@intentweave/sqlite-compat";
import * as path from "path";
import * as fs from "fs";
import { performance } from "perf_hooks";

import { buildIndex, registerExternalEntities } from "./writer.js";
import { annotate } from "./annotator.js";
import { computeIdf } from "./idf.js";
import { openIndex } from "./queries/shared.js";
import {
  retrieveFromDb,
  connectionsFromDb,
  checkFromDb,
  reportFromDb,
  clonesFromDb,
  structuralClonesFromDb,
  circularImportsFromDb,
  unusedExportsFromDb,
  hotspotPriorityFromDb,
  todosFromDb,
  moduleCoverageFromDb,
  orphanedSectionsFromDb,
  docCompletenessFromDb,
  crossGroupDriftFromDb,
  testCoverageFromDb,
  mentionsOfFromDb,
  annotationsForFileFromDb,
  hubsFromDb,
  communitiesFromDb,
  surprisesFromDb,
  rationaleFromDb,
  terminologyInconsistencyFromDb,
  dependencyDepthFromDb,
  boundaryViolationsFromDb,
  layersInferFromDb,
  layersCheckFromDb,
  slicesFromDb,
  focusFromDb,
  archReportFromDb,
  namingViolationsFromDb,
  commentCodeRatioFromDb,
  skippedFilesFromDb,
  rulesCheckFromDb,
  deprecatedCallersFromDb,
  internalViolationsFromDb,
  typeAssertionsFromDb,
  layersFromDecoratorsFromDb,
  rulesTrendFromDb,
  testIntentFromDb,
  callsFromDb,
  traceFromDb,
  ruleCoverageFromDb,
} from "./queries/index.js";
import type {
  ReportOptions,
  RulesCheckOptions,
  DeprecatedCallersOptions,
  InternalViolationsOptions,
  TypeAssertionsOptions,
  LayersFromDecoratorsOptions,
  RulesTrendOptions,
  TestIntentOptions,
} from "./queries/index.js";

import type {
  IndexBuildOptions,
  IndexBuildResult,
  RetrieveParams,
  RetrieveResult,
  ConnectionsParams,
  ConnectionsResult,
  CheckParams,
  CheckResult,
  ReportResult,
  ClonesResult,
  StructuralClonesResult,
  CircularImportsResult,
  UnusedExportsResult,
  HotspotPriorityResult,
  TodosResult,
  ModuleCoverageResult,
  OrphanedSectionsResult,
  DocCompletenessResult,
  CrossGroupDriftResult,
  TestCoverageParams,
  TestCoverageResult,
  ExternalEntity,
  MentionsOfParams,
  MentionsOfResult,
  AnnotationsForFileParams,
  AnnotationsForFileResult,
  HubAnalysisResult,
  CommunityDetectionResult,
  CommunityOptions,
  SurprisingConnectionsResult,
  RationaleResult,
  TerminologyInconsistencyResult,
  DependencyDepthResult,
  BoundaryViolationsResult,
  LayersInferResult,
  LayersInferOptions,
  LayerConfig,
  LayersCheckResult,
  ArchReportData,
  SlicesOptions,
  SlicesResult,
  FocusParams,
  FocusResult,
  NamingViolationsResult,
  CommentCodeRatioResult,
  SkippedFilesResult,
  RulesConfig,
  RulesCheckResult,
  DeprecatedCallersResult,
  InternalViolationsResult,
  TypeAssertionsResult,
  LayersFromDecoratorsResult,
  RulesTrendResult,
  TestIntentResult,
  CallsOptions,
  CallsResult,
  TraceOptions,
  TraceResult,
  RuleCoverageOptions,
  RuleCoverageResult,
} from "./types.js";

import type { ArchReportOptions } from "./queries/archReport.js";
import type { KwxStageOutput, TcgPipelineOutput } from "@intentweave/core";
import type { InStageInput } from "@intentweave/analyzer";
import { minimatch } from "minimatch";

// =============================================================================
// Configuration
// =============================================================================

/** Options for building a CARI index from file paths. */
/**
 * A workspace root entry — pairs a filesystem path with a semantic role.
 *
 * The `role` field is open-ended and drives how the pipeline treats the root:
 * - `"code"` — AST extraction (AX) runs here; symbols are registered in the index.
 * - `"docs"` — keyword extraction only (KWX); files are tagged as a documentation group.
 *             Any other non-`"code"` string is treated the same as `"docs"`.
 *
 * This is intentionally untyped beyond `string` so that future roles (e.g. `"test"`,
 * `"generated"`, or LLM-inferred labels) can be added without a breaking change.
 *
 * @example
 * ```typescript
 * roots: [
 *   { path: ".",                                      role: "code" },
 *   { path: "../intentweave.org/src/content",         role: "docs", group: "intentweave.org" },
 * ]
 * ```
 */
export interface WorkspaceRoot {
  /** Absolute path, or relative to `process.cwd()`. */
  path: string;
  /** Semantic role — drives which pipeline stages run on this root. */
  role: string;
  /**
   * Optional doc_group label stored in the `files` table.
   * Defaults to the basename of `path` when not specified.
   */
  group?: string;
}

export interface CariConfig {
  /**
   * Document file paths or directories to analyze.
   *
   * @deprecated Prefer `roots` for multi-root setups. When `roots` is
   * provided this field is ignored; it is kept for backward compatibility.
   */
  paths: string[];

  /**
   * Workspace root directory — the primary code root for AX extraction.
   *
   * @deprecated Prefer `roots` for multi-root setups. When `roots` is
   * provided this field is still used as the base for output-path resolution
   * but AX extraction is driven by roots with `role: "code"` instead.
   */
  workspaceRoot: string;

  /**
   * Multi-root workspace configuration.
   *
   * When provided, `paths` and `workspaceRoot` are superseded for the purposes
   * of file discovery and AX extraction:
   * - Roots with `role: "code"` are scanned by AX for symbols.
   * - All other roles are keyword-extracted only and tagged with their `group`.
   *
   * `workspaceRoot` is still used for output-path resolution (`.iw/index.db`).
   * The first `role: "code"` root in the list is used as the primary workspace
   * root for relative-path storage and git analysis (TCG stage).
   */
  roots?: WorkspaceRoot[];

  /** Annotation depth: structured (headings/bold/code-spans) or full (all text + IDF) */
  depth?: "structured" | "full";

  /** Glob patterns to exclude */
  exclude?: string[];

  /** Glob patterns to include (filters discovered files) */
  include?: string[];

  /** Session name (default: directory basename) */
  session?: string;

  /** Output path for the SQLite database (default: .iw/index.db) */
  outputPath?: string;

  /**
   * Maximum file size in bytes for AX extraction.
   * Files larger than this will be skipped and recorded with indexed=false.
   * Default: 65536 (64 KiB)
   */
  maxFileSize?: number;

  /** Logging callback */
  log?: (msg: string) => void;

  /** Progress callback — called after each pipeline stage completes */
  onProgress?: (stage: CariStageProgress) => void;
}

/** Progress report for a completed pipeline stage. */
export interface CariStageProgress {
  /** Stage name */
  stage: "ax" | "kwg" | "tcg" | "annotate" | "write";

  /** Duration of this stage in ms */
  durationMs: number;

  /** Human-readable detail string */
  detail: string;
}

// =============================================================================
// File Discovery (extracted from CLI)
// =============================================================================

const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

/** Directories excluded by default. */
export const DEFAULT_EXCLUDES = [
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
 * One glob pattern per line. Lines starting with `#` are comments.
 */
export async function loadIwIgnore(cwd: string): Promise<string[]> {
  const ignorePath = path.join(cwd, ".iwignore");
  try {
    const content = await fs.promises.readFile(ignorePath, "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** Build the effective exclude list from defaults + .iwignore + explicit excludes. */
export function buildExcludeList(
  cliExcludes: string[],
  iwIgnorePatterns: string[],
  useDefaults: boolean = true,
): string[] {
  const excludes: string[] = [];
  if (useDefaults) excludes.push(...DEFAULT_EXCLUDES);
  excludes.push(...iwIgnorePatterns);
  excludes.push(...cliExcludes);
  return excludes;
}

/** Check whether a relative path matches any exclude pattern. */
export function isExcluded(
  relPath: string,
  patterns: string[],
  minimatchFn:
    | ((file: string, pattern: string, opts?: { dot?: boolean }) => boolean)
    | null,
): boolean {
  if (!minimatchFn || patterns.length === 0) return false;
  return patterns.some((p) => minimatchFn(relPath, p, { dot: true }));
}

/** Discover supported document files from paths, applying include/exclude filters. */
export async function discoverFiles(
  paths: string[],
  cwd: string,
  opts: { include?: string[]; exclude?: string[] } = {},
): Promise<string[]> {
  const { exclude = [] } = opts;

  if (opts.include && opts.include.length > 0) {
    const includeMatchers = opts.include.map(
      (p: string) => (file: string) => minimatch(file, p),
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
    minimatchFn = minimatch;
  }

  const files: string[] = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    const stat = await fs.promises.stat(abs).catch(() => null);
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
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      const subPaths = entries.map((e) => path.join(abs, e.name));
      files.push(
        ...(await discoverFilesRecursive(subPaths, cwd, excludePatterns)),
      );
    }
  }
  return [...new Set(files)].sort();
}

function toArtifactId(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  return rel.replace(/[/\\]/g, ".").replace(/\.[^.]+$/, "");
}

/**
 * Extract only the comment content from a source file, blanking out all
 * non-comment lines so that line numbers remain accurate.
 *
 * Handles single-line slash comments, block slash-star comments,
 * and Python/shell hash comments.
 */
function extractSourceCommentContent(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inBlock) {
      // Inside a block comment — emit the content, strip leading * or */
      if (trimmed.includes("*/")) {
        const before = trimmed
          .slice(0, trimmed.indexOf("*/"))
          .replace(/^\*?\s?/, "");
        result.push(before.trim());
        inBlock = false;
      } else {
        result.push(trimmed.replace(/^\*\s?/, ""));
      }
    } else if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
      inBlock = true;
      // Opening line may have content: /** Foo bar */ or /** Foo bar
      const afterOpen = trimmed.replace(/^\/\*+\s?/, "");
      if (afterOpen.includes("*/")) {
        // Single-line block: /** Foo */
        result.push(afterOpen.slice(0, afterOpen.indexOf("*/")).trim());
        inBlock = false;
      } else {
        result.push(afterOpen.trim());
      }
    } else if (trimmed.startsWith("//")) {
      result.push(trimmed.replace(/^\/\/\s?/, "").trim());
    } else if (trimmed.startsWith("#") && !trimmed.startsWith("#!")) {
      // Python / shell style
      result.push(trimmed.replace(/^#+\s?/, "").trim());
    } else {
      result.push(""); // blank out code lines — preserves line numbers
    }
  }

  return result.join("\n");
}

// =============================================================================
// Pipeline Orchestration
// =============================================================================

/**
 * Run the full CARI pipeline from file paths and produce a SQLite index.
 *
 * Orchestrates: file discovery → AX → KWX → COX → TCG → IDF → annotate → write.
 * This is the extracted core of `iw index build` — the CLI is a thin wrapper.
 */
export async function buildFromPaths(
  config: CariConfig,
): Promise<IndexBuildResult> {
  const {
    paths: inputPaths,
    workspaceRoot,
    roots,
    depth = "structured",
    exclude = [],
    include,
    session = path.basename(workspaceRoot),
    outputPath,
    maxFileSize = 262144,
    log = () => {},
    onProgress,
  } = config;

  // ── Resolve roots ────────────────────────────────────────────
  // When `roots` is provided it drives both AX (code roots) and file
  // discovery (all roots). Otherwise fall back to legacy single-root mode.
  const resolvedRoots: Array<{ absPath: string; role: string; group: string }> =
    roots
      ? roots.map((r) => ({
          absPath: path.isAbsolute(r.path)
            ? r.path
            : path.resolve(workspaceRoot, r.path),
          role: r.role,
          group: r.group ?? path.basename(r.path),
        }))
      : [];

  // The primary code root for TCG (git) and relative-path storage.
  // In legacy mode it is `workspaceRoot`; in roots mode it is the first "code" entry.
  const primaryCodeRoot =
    resolvedRoots.find((r) => r.role === "code")?.absPath ?? workspaceRoot;

  // ── 0. File discovery ────────────────────────────────────────
  const iwIgnorePatterns = await loadIwIgnore(primaryCodeRoot);
  const excludePatterns = buildExcludeList(exclude, iwIgnorePatterns);

  log("Discovering document files...");

  let docFiles: string[];
  // Map from absolute file path → doc_group override (for external doc roots)
  const fileGroupOverride = new Map<string, string>();

  if (resolvedRoots.length > 0) {
    // Multi-root: discover docs from ALL roots, tag external-doc-root files
    const allFiles: string[] = [];
    for (const root of resolvedRoots) {
      const files = await discoverFiles([root.absPath], primaryCodeRoot, {
        include,
        exclude: excludePatterns,
      });
      allFiles.push(...files);
      // Only non-primary roots (or non-code roots) get a group override
      if (root.role !== "code") {
        for (const f of files) fileGroupOverride.set(f, root.group);
      }
    }
    docFiles = [...new Set(allFiles)].sort();
  } else {
    // Legacy: discover from inputPaths relative to workspaceRoot
    docFiles = await discoverFiles(inputPaths, workspaceRoot, {
      include,
      exclude: excludePatterns,
    });
  }

  if (docFiles.length === 0) {
    throw new Error("No document files found in the given paths.");
  }
  log(`Found ${docFiles.length} document files`);

  // Dynamic import for analyzer stages — @intentweave/analyzer is a peer dep
  const analyzer = await import("@intentweave/analyzer");

  // ── 1. AX: code symbol extraction ───────────────────────────
  const axStart = performance.now();

  // Collect AX outputs from all code roots (legacy: single workspaceRoot)
  const codeRoots =
    resolvedRoots.length > 0
      ? resolvedRoots.filter((r) => r.role === "code").map((r) => r.absPath)
      : [workspaceRoot];

  // Run AX on each code root and merge results; file paths are stored relative
  // to the primary code root so imports/connections work correctly.
  const axMerged: Awaited<ReturnType<typeof analyzer.runAxStage>> = {
    version: "1.0",
    workspaceRoot: primaryCodeRoot,
    extractedAt: Date.now(),
    files: [],
    totalFiles: 0,
    totalSymbols: 0,
    stats: { byKind: {}, exported: 0, internal: 0 },
  };
  for (const codeRoot of codeRoots) {
    const axOut = await analyzer.runAxStage({
      workspaceRoot: codeRoot,
      maxFileSize,
    });
    // Re-root file paths to be relative to primaryCodeRoot
    if (codeRoot !== primaryCodeRoot) {
      for (const f of axOut.files) {
        f.filePath = path.relative(
          primaryCodeRoot,
          path.join(codeRoot, f.filePath),
        );
      }
    }
    axMerged.files.push(...axOut.files);
    axMerged.totalFiles += axOut.totalFiles;
    axMerged.totalSymbols += axOut.totalSymbols;
    axMerged.stats.exported += axOut.stats.exported;
    axMerged.stats.internal += axOut.stats.internal;
    for (const [k, v] of Object.entries(axOut.stats.byKind)) {
      axMerged.stats.byKind[k] = (axMerged.stats.byKind[k] ?? 0) + v;
    }
    if ("durationMs" in axOut) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (axMerged as any).durationMs =
        ((axMerged as any).durationMs ?? 0) + (axOut as any).durationMs;
    }
  }
  const axOutput = axMerged;
  const axMs = performance.now() - axStart;

  const skippedCount = axOutput.files.filter(
    (f: { skipped?: boolean }) => f.skipped,
  ).length;
  log(
    `AX: ${axOutput.totalFiles} files, ${axOutput.totalSymbols} symbols (${(axMs / 1000).toFixed(1)}s)`,
  );
  if (skippedCount > 0) {
    const skippedPaths = axOutput.files
      .filter((f: { skipped?: boolean }) => f.skipped)
      .map((f: { filePath: string }) => f.filePath);
    log(
      `AX WARNING: ${skippedCount} file(s) skipped (too large). Use --max-file-size to adjust. Skipped:\n  ${skippedPaths.join("\n  ")}`,
    );
  }
  onProgress?.({
    stage: "ax",
    durationMs: axMs,
    detail: `${axOutput.totalFiles} files, ${axOutput.totalSymbols} symbols${skippedCount > 0 ? `, ${skippedCount} skipped` : ""}`,
  });

  // Build symbol dictionary for body-text matching (full depth)
  const symbolDictionary =
    depth === "full"
      ? new Set(
          axOutput.files.flatMap((f: { symbols: { name: string }[] }) =>
            f.symbols.map((s: { name: string }) => s.name.toLowerCase()),
          ),
        )
      : undefined;

  // ── 2. KWG: IN → KWX → COX ─────────────────────────────────
  const kwgStart = performance.now();
  const kwxOutputs: KwxStageOutput[] = [];

  const logger = new analyzer.NoopLogger();
  const ctx = {
    logger,
    workspace: { root: primaryCodeRoot, key: "index", id: "index" },
    runId: `index-${Date.now()}`,
    store: null as unknown,
    profile: null as unknown,
    providers: null as unknown,
    now: () => new Date(),
    timestamp: () => new Date().toISOString(),
  } as unknown;

  for (const filePath of docFiles) {
    const relPath = path.relative(primaryCodeRoot, filePath);
    const docGroup = fileGroupOverride.get(filePath);
    log(`  KWX: ${relPath}${docGroup ? ` [${docGroup}]` : ""}`);

    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const artifactId = toArtifactId(filePath, primaryCodeRoot);

      const inInput: InStageInput = {
        artifactId,
        filePath: relPath,
        content,
      };
      const inOutput = await analyzer.runInStage(
        inInput,
        ctx as Parameters<typeof analyzer.runInStage>[1],
      );
      const kwxOutput = await analyzer.runKwxStage(
        { inOutput },
        { depth, dictionary: symbolDictionary },
      );
      kwxOutputs.push(kwxOutput);
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      throw new Error(`KWX failed for ${relPath}: ${base}`);
    }
  }

  // ── 2b. KWX pass over source-file comments ──────────────────────────────
  // Run KWX on each source file that AX indexed, but pass only the comment
  // content (non-comment lines blanked out so line numbers stay correct).
  // This creates annotations where doc_path = source_file, enabling gutter
  // dots on comment lines in the AR Evidence viewer.
  const SOURCE_COMMENT_EXTS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".swift",
    ".go",
    ".java",
    ".cs",
  ]);
  const sourceFilesForKwx = axOutput.files
    .map((f: { filePath: string }) => f.filePath)
    .filter((fp: string) => {
      const ext = path.extname(fp).toLowerCase();
      return SOURCE_COMMENT_EXTS.has(ext);
    });

  let srcCommentCount = 0;
  for (const relPath of sourceFilesForKwx) {
    const absPath = path.join(primaryCodeRoot, relPath);
    try {
      const raw = await fs.promises.readFile(absPath, "utf-8");
      const commentContent = extractSourceCommentContent(raw);
      if (!commentContent.trim()) continue;

      const artifactId = toArtifactId(absPath, primaryCodeRoot);
      const inInput: InStageInput = {
        artifactId,
        filePath: relPath,
        // Use plain-text format so parseGenericText handles it (preserves line numbers)
        artifactFormat: "text",
        content: commentContent,
      };
      const inOutput = await analyzer.runInStage(
        inInput,
        ctx as Parameters<typeof analyzer.runInStage>[1],
        // Lower minChunkSize so isolated comment lines are not filtered out
        { minChunkSize: 1 },
      );
      const kwxOutput = await analyzer.runKwxStage(
        { inOutput },
        // Always use full depth for comments — they're structured text
        { depth: "full", dictionary: symbolDictionary },
      );
      kwxOutputs.push(kwxOutput);
      srcCommentCount++;
    } catch {
      // Skip files that can't be read or parsed
    }
  }
  if (srcCommentCount > 0) {
    log(
      `KWX-comments: processed comments from ${srcCommentCount} source files`,
    );
  }

  const coxOutput = await analyzer.runCoxStage({ kwxOutputs });

  const kwgMs = performance.now() - kwgStart;
  const totalMentions = kwxOutputs.reduce(
    (acc, o) => acc + o.mentions.length,
    0,
  );
  const totalEntities = kwxOutputs.reduce(
    (acc, o) => acc + o.entities.length,
    0,
  );

  log(
    `KWG: ${totalEntities} entities, ${totalMentions} mentions, ${coxOutput.edges.length} co-occ edges (${(kwgMs / 1000).toFixed(1)}s)`,
  );
  onProgress?.({
    stage: "kwg",
    durationMs: kwgMs,
    detail: `${totalEntities} entities, ${totalMentions} mentions, ${coxOutput.edges.length} co-occ edges`,
  });

  // ── 3. TCG: TCX → COC → HOT → OWN → STL ───────────────────
  const tcgStart = performance.now();
  const tcxOutput = await analyzer.runTcxStage({
    workspaceRoot: primaryCodeRoot,
    depth: "full",
    log: (msg: string) => log(`  tcg: ${msg}`),
  });
  const cocOutput = analyzer.runCocStage({ tcxOutput });
  const hotOutput = analyzer.runHotStage({ tcxOutput });
  const ownOutput = analyzer.runOwnStage({ tcxOutput });
  const stlOutput = analyzer.runStlStage({
    tcxOutput,
    kwgEntities: kwxOutputs.flatMap((o) => o.entities).map((e) => e.name),
    workspaceRoot: primaryCodeRoot,
  });

  const tcgOutput: TcgPipelineOutput = {
    tcx: tcxOutput,
    coc: cocOutput,
    hot: hotOutput,
    own: ownOutput,
    stl: stlOutput,
    meta: {
      session,
      workspaceRoot: primaryCodeRoot,
      gitDepth: "full history",
      totalDurationMs: performance.now() - tcgStart,
    },
  };

  const tcgMs = performance.now() - tcgStart;
  log(
    `TCG: ${tcxOutput.commits.length} commits, ${cocOutput.edges.length} co-change edges (${(tcgMs / 1000).toFixed(1)}s)`,
  );
  onProgress?.({
    stage: "tcg",
    durationMs: tcgMs,
    detail: `${tcxOutput.commits.length} commits, ${cocOutput.edges.length} co-change edges`,
  });

  // ── 4. IDF + Annotate ───────────────────────────────────────
  const annStart = performance.now();
  const idfScores = depth === "full" ? computeIdf(kwxOutputs) : undefined;
  const annotations = annotate(axOutput, kwxOutputs, {
    idfScores,
    applyIdfPenalty: depth === "full",
    log,
  });
  const annMs = performance.now() - annStart;

  const grounded = annotations.filter((a) => a.symbolId).length;
  log(
    `Annotate: ${annotations.length} annotations (${grounded} grounded) (${(annMs / 1000).toFixed(1)}s)`,
  );
  onProgress?.({
    stage: "annotate",
    durationMs: annMs,
    detail: `${annotations.length} annotations (${grounded} grounded)`,
  });

  // ── 5. Write SQLite index ───────────────────────────────────
  const buildOpts: IndexBuildOptions = {
    session,
    workspaceRoot: primaryCodeRoot,
    depth,
    outputPath,
    log,
    docGroupOverride:
      fileGroupOverride.size > 0 ? fileGroupOverride : undefined,
  };

  const result = buildIndex(
    axOutput,
    kwxOutputs,
    coxOutput,
    tcgOutput,
    annotations,
    buildOpts,
  );

  onProgress?.({
    stage: "write",
    durationMs: result.durationMs,
    detail: `symbols=${result.counts.symbols} annotations=${result.counts.annotations}`,
  });

  return result;
}

// =============================================================================
// CariIndex Class
// =============================================================================

/**
 * Stateful facade wrapping a CARI SQLite index.
 *
 * Manages the database lifecycle and exposes typed query methods.
 * Use `CariIndex.build()` to create a new index or `CariIndex.load()` to open
 * an existing one.
 */
export class CariIndex {
  private db: Database;
  private readonly _dbPath: string;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this._dbPath = dbPath;
  }

  /** Path to the underlying SQLite database file. */
  get dbPath(): string {
    return this._dbPath;
  }

  // ---------------------------------------------------------------------------
  // Static factory methods
  // ---------------------------------------------------------------------------

  /**
   * Build a new CARI index from file paths by running the full pipeline
   * (AX → KWX → COX → TCG → annotate → write), then return a ready-to-query instance.
   */
  static async build(config: CariConfig): Promise<CariIndex> {
    const result = await buildFromPaths(config);
    const db = openIndex(result.dbPath);
    return new CariIndex(db, result.dbPath);
  }

  /**
   * Load an existing CARI index (read-only).
   * Throws if the database file doesn't exist.
   */
  static load(dbPath: string): CariIndex {
    const db = openIndex(dbPath);
    return new CariIndex(db, dbPath);
  }

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  /** Ranked file retrieval by topic or symbol name. */
  retrieve(params: RetrieveParams): RetrieveResult {
    return retrieveFromDb(this.db, params);
  }

  /** Cross-layer connection discovery + gap detection. */
  connections(params: ConnectionsParams): ConnectionsResult {
    return connectionsFromDb(this.db, params);
  }

  /** CI drift detection for changed files. */
  check(params: CheckParams): CheckResult {
    return checkFromDb(this.db, params);
  }

  /** Corpus-wide health report. */
  report(opts?: ReportOptions): ReportResult {
    return reportFromDb(this.db, opts);
  }

  /** Exact clone detection (identical normalised body hash). */
  clones(): ClonesResult {
    return clonesFromDb(this.db);
  }

  /** Structural clone detection (same AST structure, different identifiers). */
  structuralClones(): StructuralClonesResult {
    return structuralClonesFromDb(this.db);
  }

  /** Circular import cycle detection. */
  circularImports(): CircularImportsResult {
    return circularImportsFromDb(this.db);
  }

  /** Exported symbols never imported anywhere. */
  unusedExports(): UnusedExportsResult {
    return unusedExportsFromDb(this.db);
  }

  /** High-churn, low-doc files ranked by documentation urgency. */
  hotspotPriority(): HotspotPriorityResult {
    return hotspotPriorityFromDb(this.db);
  }

  /** TODO/FIXME/HACK/XXX inventory. */
  todos(): TodosResult {
    return todosFromDb(this.db);
  }

  /** Naming convention violations (6.1). */
  namingViolations(): NamingViolationsResult {
    return namingViolationsFromDb(this.db);
  }

  /** Comment-to-code ratio anomalies (6.4). */
  commentCodeRatio(): CommentCodeRatioResult {
    return commentCodeRatioFromDb(this.db);
  }

  /** Files skipped during AX extraction due to size (6.5). */
  skippedFiles(): SkippedFilesResult {
    return skippedFilesFromDb(this.db);
  }

  /** Semantic rule checking against .iw/rules.yaml (13.2/13.3). */
  rulesCheck(
    config: RulesConfig,
    opts: RulesCheckOptions = {},
  ): RulesCheckResult {
    return rulesCheckFromDb(this.db, config, opts);
  }

  /** Find active callers of @deprecated symbols (14.1). */
  deprecatedCallers(
    opts: DeprecatedCallersOptions = {},
  ): DeprecatedCallersResult {
    return deprecatedCallersFromDb(this.db, opts);
  }

  /** Detect @internal / _prefix symbols imported across package boundaries (14.2). */
  internalViolations(
    opts: InternalViolationsOptions = {},
  ): InternalViolationsResult {
    return internalViolationsFromDb(this.db, opts);
  }

  /** Inventory type assertions: `as any`, double casts, angle-bracket casts (14.3). */
  typeAssertions(opts: TypeAssertionsOptions = {}): TypeAssertionsResult {
    return typeAssertionsFromDb(this.db, opts);
  }

  /** Derive architectural layer assignments from decorator metadata (14.4). */
  layersFromDecorators(
    opts: LayersFromDecoratorsOptions = {},
  ): LayersFromDecoratorsResult {
    return layersFromDecoratorsFromDb(this.db, opts);
  }

  /** ADR conformance trend over time (14.5). */
  rulesTrend(opts: RulesTrendOptions = {}): RulesTrendResult {
    return rulesTrendFromDb(this.db, opts);
  }

  /** Find stale test descriptions and orphaned test files (14.6). */
  testIntent(opts: TestIntentOptions = {}): TestIntentResult {
    return testIntentFromDb(this.db, opts);
  }

  // ── Phase 4: Call Graph ───────────────────────────────────────────────────

  /** Query the symbol_calls call graph (Phase 4). */
  calls(opts: CallsOptions = {}): CallsResult {
    return callsFromDb(this.db, opts);
  }

  /** BFS call-path trace from an entry-point file (Phase 4). */
  trace(opts: TraceOptions): TraceResult {
    return traceFromDb(this.db, opts);
  }

  /** Flag packages with zero behavioral rules (Phase 4). */
  ruleCoverage(opts: RuleCoverageOptions): RuleCoverageResult {
    return ruleCoverageFromDb(this.db, opts);
  }

  /** Documentation coverage percentage per directory. */
  moduleCoverage(): ModuleCoverageResult {
    return moduleCoverageFromDb(this.db);
  }

  /** Doc sections where all mentions are ungrounded. */
  orphanedSections(): OrphanedSectionsResult {
    return orphanedSectionsFromDb(this.db);
  }

  /** Per-doc completeness vs. referenced exported symbols. */
  docCompleteness(): DocCompletenessResult {
    return docCompletenessFromDb(this.db);
  }

  /** Cross-group entity coverage conflicts. */
  crossGroupDrift(): CrossGroupDriftResult {
    return crossGroupDriftFromDb(this.db);
  }

  /** Map test files to source files and find untested exported symbols. */
  testCoverage(params: TestCoverageParams = {}): TestCoverageResult {
    return testCoverageFromDb(this.db, params);
  }

  // ---------------------------------------------------------------------------
  // Graph Topology & Structure (Section 9)
  // ---------------------------------------------------------------------------

  /** Degree centrality across all edge types — find god-nodes / hubs. */
  hubs(): HubAnalysisResult {
    return hubsFromDb(this.db);
  }

  /** Label-propagation community detection on the combined graph. */
  communities(options?: CommunityOptions): CommunityDetectionResult {
    return communitiesFromDb(this.db, options);
  }

  /** Rank connections by surprise score (cross-layer, community distance, rarity). */
  surprises(): SurprisingConnectionsResult {
    return surprisesFromDb(this.db);
  }

  /** WHY/NOTE/IMPORTANT/DESIGN rationale comments inventory. */
  rationale(): RationaleResult {
    return rationaleFromDb(this.db);
  }

  // ---------------------------------------------------------------------------
  // Documentation Intelligence (Section 1)
  // ---------------------------------------------------------------------------

  /** Detect terminology inconsistencies across documentation. */
  terminologyInconsistency(): TerminologyInconsistencyResult {
    return terminologyInconsistencyFromDb(this.db);
  }

  /** Compute transitive import depth and fan-in/fan-out per file. */
  dependencyDepth(): DependencyDepthResult {
    return dependencyDepthFromDb(this.db);
  }

  /** Detect cross-package internal module imports. */
  boundaryViolations(): BoundaryViolationsResult {
    return boundaryViolationsFromDb(this.db);
  }

  // ---------------------------------------------------------------------------
  // Architecture & Design Intelligence (Section 5)
  // ---------------------------------------------------------------------------

  /** Auto-infer architectural layers from the import graph. */
  layersInfer(options?: LayersInferOptions): LayersInferResult {
    return layersInferFromDb(this.db, options);
  }

  /** Validate imports against a layer config, detecting reverse and skip-layer violations. */
  layersCheck(config: LayerConfig): LayersCheckResult {
    return layersCheckFromDb(this.db, config);
  }

  /** Detect vertical slices — communities that span multiple layers end-to-end. */
  slices(options?: SlicesOptions): SlicesResult {
    return slicesFromDb(this.db, options);
  }

  /** Extract a focused architecture subgraph around a target entity. */
  focus(params: FocusParams): FocusResult {
    return focusFromDb(this.db, params);
  }

  // ---------------------------------------------------------------------------
  // Architecture Report (Section 10)
  // ---------------------------------------------------------------------------

  /** Collect architecture report data from all CARI analyses. */
  archReport(options?: ArchReportOptions): ArchReportData {
    return archReportFromDb(this.db, options);
  }

  // ---------------------------------------------------------------------------
  // Entity Bridge
  // ---------------------------------------------------------------------------

  /**
   * Register external entities into the index.
   * Creates annotations for doc mentions matching entity names/aliases.
   *
   * Note: this closes and reopens the DB (needs write access).
   */
  registerEntities(entities: ExternalEntity[]): {
    entitiesWritten: number;
    annotationsCreated: number;
  } {
    // Close read-only handle, write, reopen
    this.db.close();
    const result = registerExternalEntities(this._dbPath, entities);
    this.db = openIndex(this._dbPath);
    return result;
  }

  /**
   * Find all document mentions referencing a given entity
   * (code symbol or external entity).
   */
  mentionsOf(params: MentionsOfParams): MentionsOfResult {
    return mentionsOfFromDb(this.db, params);
  }

  /**
   * List all annotations for a given document file,
   * with entity names resolved from both symbols and external entities.
   */
  annotationsForFile(
    params: AnnotationsForFileParams,
  ): AnnotationsForFileResult {
    return annotationsForFileFromDb(this.db, params);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
