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

import type { Database } from "better-sqlite3";
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
} from "./queries/index.js";
import type { ReportOptions } from "./queries/index.js";

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
  SurprisingConnectionsResult,
  RationaleResult,
  TerminologyInconsistencyResult,
  DependencyDepthResult,
  BoundaryViolationsResult,
} from "./types.js";

import type { KwxStageOutput, TcgPipelineOutput } from "@intentweave/core";
import type { InStageInput } from "@intentweave/analyzer";
import { minimatch } from "minimatch";

// =============================================================================
// Configuration
// =============================================================================

/** Options for building a CARI index from file paths. */
export interface CariConfig {
  /** Document file paths or directories to analyze */
  paths: string[];

  /** Workspace root directory */
  workspaceRoot: string;

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
    depth = "structured",
    exclude = [],
    include,
    session = path.basename(workspaceRoot),
    outputPath,
    log = () => {},
    onProgress,
  } = config;

  // ── 0. File discovery ────────────────────────────────────────
  const iwIgnorePatterns = await loadIwIgnore(workspaceRoot);
  const excludePatterns = buildExcludeList(exclude, iwIgnorePatterns);

  log("Discovering document files...");
  const docFiles = await discoverFiles(inputPaths, workspaceRoot, {
    include,
    exclude: excludePatterns,
  });
  if (docFiles.length === 0) {
    throw new Error("No document files found in the given paths.");
  }
  log(`Found ${docFiles.length} document files`);

  // Dynamic import for analyzer stages — @intentweave/analyzer is a peer dep
  const analyzer = await import("@intentweave/analyzer");

  // ── 1. AX: code symbol extraction ───────────────────────────
  const axStart = performance.now();
  const axOutput = await analyzer.runAxStage({ workspaceRoot });
  const axMs = performance.now() - axStart;

  log(
    `AX: ${axOutput.totalFiles} files, ${axOutput.totalSymbols} symbols (${(axMs / 1000).toFixed(1)}s)`,
  );
  onProgress?.({
    stage: "ax",
    durationMs: axMs,
    detail: `${axOutput.totalFiles} files, ${axOutput.totalSymbols} symbols`,
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
    workspace: { root: workspaceRoot, key: "index", id: "index" },
    runId: `index-${Date.now()}`,
    store: null as unknown,
    profile: null as unknown,
    providers: null as unknown,
    now: () => new Date(),
    timestamp: () => new Date().toISOString(),
  } as unknown;

  for (const filePath of docFiles) {
    const relPath = path.relative(workspaceRoot, filePath);
    log(`  KWX: ${relPath}`);

    const content = await fs.promises.readFile(filePath, "utf-8");
    const artifactId = toArtifactId(filePath, workspaceRoot);

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
    workspaceRoot,
    depth: "full",
    log: (msg: string) => log(`  tcg: ${msg}`),
  });
  const cocOutput = analyzer.runCocStage({ tcxOutput });
  const hotOutput = analyzer.runHotStage({ tcxOutput });
  const ownOutput = analyzer.runOwnStage({ tcxOutput });
  const stlOutput = analyzer.runStlStage({
    tcxOutput,
    kwgEntities: kwxOutputs.flatMap((o) => o.entities).map((e) => e.name),
    workspaceRoot,
  });

  const tcgOutput: TcgPipelineOutput = {
    tcx: tcxOutput,
    coc: cocOutput,
    hot: hotOutput,
    own: ownOutput,
    stl: stlOutput,
    meta: {
      session,
      workspaceRoot,
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
    workspaceRoot,
    depth,
    outputPath,
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
  communities(): CommunityDetectionResult {
    return communitiesFromDb(this.db);
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
