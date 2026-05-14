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
import { load as yamlLoad } from "js-yaml";
import { minimatch } from "minimatch";

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

// Enrichment subcommand (11.8)
import { indexEnrichSubcommand } from "./indexEnrich.js";

// Rules extract subcommand (13.4)
import { indexRulesExtractSubcommand } from "./indexRulesExtract.js";

// Diagram scanner subcommand
import {
  indexScanDiagramsSubcommand,
  buildArchConfigFromDiagrams,
} from "./indexScanDiagrams.js";

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
  .description(
    "Build the CARI Evidence Engine index: KWG + TCG + AX → SQLite (.iw/index.db)",
  )
  .argument(
    "[paths...]",
    "Document file(s) or directories to analyze (default: .)",
  )
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
  .option(
    "--max-file-size <bytes>",
    "Skip source files larger than this size in bytes during AX extraction (default: 262144)",
    "262144",
  )
  .option(
    "--root <path:role[:group]>",
    "Add a workspace root with a role (e.g. ../docs:docs or ../docs:docs:my-docs). " +
      "Role 'code' runs AX extraction; any other role (e.g. 'docs') runs keyword extraction only. " +
      "Can be repeated. When present, overrides the [paths...] argument.",
    (val: string, prev: string[]) => [...(prev ?? []), val],
    [] as string[],
  )
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    if (!paths || paths.length === 0) paths = ["."];
    const cwd = process.cwd();
    const session = opts.session ?? path.basename(cwd);
    const verbose = opts.verbose;

    // Parse --root tuples: "path:role" or "path:role:group"
    const roots: import("@intentweave/index").WorkspaceRoot[] = (
      (opts.root ?? []) as string[]
    ).map((raw) => {
      const parts = raw.split(":");
      const rootPath = parts[0];
      const role = parts[1] ?? "docs";
      const group = parts[2]; // undefined → defaults to basename in facade
      return group ? { path: rootPath, role, group } : { path: rootPath, role };
    });

    console.log(
      chalk.blue(`\n  ▸ CARI Evidence Engine Build — session: ${session}`),
    );
    console.log(
      chalk.blue(
        `  ▸ depth: ${opts.depth} | output: ${opts.output ?? ".iw/index.db"}\n`,
      ),
    );
    if (roots.length > 0) {
      for (const r of roots) {
        console.log(
          chalk.gray(
            `  ▸ root: ${r.path} [${r.role}${r.group ? `:${r.group}` : ""}]`,
          ),
        );
      }
      console.log();
    }

    try {
      const result = await buildFromPaths({
        paths,
        workspaceRoot: cwd,
        roots: roots.length > 0 ? roots : undefined,
        depth: opts.depth as "structured" | "full",
        exclude: opts.exclude,
        include: opts.include,
        session,
        outputPath: opts.output,
        maxFileSize: parseInt(opts.maxFileSize, 10),
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

      // Auto-snapshot conformance if .iw/rules.yaml exists (14.5, fire-and-forget)
      try {
        const { existsSync, readFileSync } = await import("node:fs");
        const rulesYamlPath = path.join(process.cwd(), ".iw", "rules.yaml");
        if (existsSync(rulesYamlPath)) {
          const jsYaml = await import("js-yaml");
          const raw = readFileSync(rulesYamlPath, "utf-8");
          const config = jsYaml.load(
            raw,
          ) as import("@intentweave/index").RulesConfig;
          if (config?.rules?.length) {
            const snapshotId = `build-${Date.now()}`;
            snapshotConformance(result.dbPath, config, snapshotId, Date.now());
          }
        }
      } catch {
        // Snapshot failure must not fail the build
      }
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
  dependencyDepth,
  boundaryViolations,
  layersInfer,
  layersCheck,
  layersCompare,
  interfaceConformance,
  deadFeatures,
  slices,
  focus,
  nameLayers,
  archReport,
  renderArchReportHtml,
  renderPrescriptiveReportHtml,
  renderInsightsBookHtml,
  renderFocusReportHtml,
  analyzeFocusInsights,
  archCheck,
  parseArchitectureYaml,
  inferArchConfigFromKg,
  enrichArchConfigWithFiles,
  diagramEntityCheck,
  namingViolations,
  commentCodeRatio,
  skippedFiles,
  rulesCheck,
  deprecatedCallers,
  internalViolations,
  typeAssertions,
  layersFromDecorators,
  rulesTrend,
  snapshotConformance,
  testIntent,
  livingScore,
  calls,
  trace,
  ruleCoverage,
} from "@intentweave/index";
import type {
  RetrieveParams,
  ConnectionsParams,
  CheckParams,
  ExternalEntity,
  LayerConfig,
  ArchConfig,
  RulesConfig,
  RulesCheckResult,
  InsightsBookData,
  InsightsDocMap,
} from "@intentweave/index";

function resolveDbPath(output?: string): string {
  return output ?? path.join(process.cwd(), ".iw", "index.db");
}

function fileLayerIndexFromConfig(
  filePath: string,
  config: LayerConfig,
): number | null {
  for (let i = 0; i < config.layers.length; i++) {
    const layer = config.layers[i];
    if (layer.patterns.some((p) => minimatch(filePath, p, { dot: true }))) {
      return i;
    }
  }
  return null;
}

function globBase(pattern: string): string {
  const normalized = pattern.replace(/\\/g, "/").trim();
  const wildcardIdx = normalized.search(/[\*\?\[{]/);
  const base = wildcardIdx >= 0 ? normalized.slice(0, wildcardIdx) : normalized;
  return base.replace(/\/+$/, "");
}

function globsLikelyOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (minimatch(a, b, { dot: true }) || minimatch(b, a, { dot: true })) {
    return true;
  }
  const aBase = globBase(a);
  const bBase = globBase(b);
  if (!aBase || !bBase) return false;
  return aBase.startsWith(bBase) || bBase.startsWith(aBase);
}

function layerIndicesFromScope(
  scope: string | undefined,
  config: LayerConfig,
): number[] {
  if (!scope) return [];
  const result: number[] = [];
  for (let i = 0; i < config.layers.length; i++) {
    const layer = config.layers[i];
    if (layer.name === scope) {
      result.push(i);
      continue;
    }
    if (layer.patterns.some((p) => globsLikelyOverlap(scope, p))) {
      result.push(i);
    }
  }
  return [...new Set(result)];
}

function layerIndicesFromImportPattern(
  pattern: string | undefined,
  config: LayerConfig,
  targetLayer?: string,
): number[] {
  // Explicit target_layer hint takes precedence — reliable for **/path patterns.
  if (targetLayer) {
    const idx = config.layers.findIndex((l) => l.name === targetLayer);
    if (idx >= 0) return [idx];
  }
  if (!pattern) return [];
  // Normalize protocol-style specifiers to path-like for glob matching.
  // e.g. "node:fs*" → "node/fs*" so it can match a "node/**" layer pattern.
  const normalized = pattern.replace(/^([a-z][a-z0-9+.\-]*):/, "$1/");
  // Strip leading **/ for patterns like "**/workers/resolved-entity-worker*"
  const stripped = normalized.startsWith("**/")
    ? normalized.slice(3)
    : normalized;
  if (!stripped.includes("/")) {
    return [];
  }
  const result: number[] = [];
  for (let i = 0; i < config.layers.length; i++) {
    const layer = config.layers[i];
    if (
      layer.patterns.some(
        (p) =>
          globsLikelyOverlap(stripped, p) || globsLikelyOverlap(normalized, p),
      )
    ) {
      result.push(i);
    }
  }
  return [...new Set(result)];
}

async function loadLayerConfigOrInfer(
  dbPath: string,
  hierarchical: boolean,
): Promise<LayerConfig> {
  const layersPath = path.join(process.cwd(), ".iw", "layers.yaml");
  try {
    const content = await fs.readFile(layersPath, "utf-8");
    return parseLayersYaml(content);
  } catch {
    // Fallback to inferred layer config.
    const inferred = layersInfer(
      dbPath,
      hierarchical ? { hierarchical: true } : undefined,
    );
    return {
      layers: inferred.layers.map((l) => ({
        name: l.label,
        patterns: l.files,
      })),
    };
  }
}

async function buildPrescriptiveReportData(
  dbPath: string,
  opts: {
    hierarchical: boolean;
    showRuleElements: boolean;
    rulesConfigPath?: string;
  },
) {
  const layerConfig = await loadLayerConfigOrInfer(dbPath, opts.hierarchical);
  const layerCheckResult = layersCheck(dbPath, layerConfig);

  let rulesConfig: RulesConfig | undefined;
  let rulesYamlRaw: string | undefined;
  const cfgPath = opts.rulesConfigPath
    ? path.resolve(opts.rulesConfigPath)
    : path.join(process.cwd(), ".iw", "rules.yaml");
  try {
    rulesConfig = await loadRulesConfig(cfgPath);
  } catch {
    rulesConfig = undefined;
  }
  if (rulesConfig) {
    try {
      rulesYamlRaw = await fs.readFile(cfgPath, "utf-8");
    } catch {
      rulesYamlRaw = undefined;
    }
  }

  const rulesResult = rulesConfig
    ? rulesCheck(dbPath, rulesConfig, {
        severity: "low",
        limit: 5000,
        domain: "all", // Phase 3: include behavioral (Mermaid) violations
        workspaceRoot: process.cwd(),
      })
    : {
        violations: [],
        totalViolations: 0,
        bySeverity: { high: 0, medium: 0, low: 0 },
        byRule: {} as Record<string, number>,
        rulesChecked: 0,
      };

  const ruleViolationsByLayer = new Map<number, number>();
  for (const v of rulesResult.violations) {
    const idx = fileLayerIndexFromConfig(v.filePath, layerConfig);
    if (idx == null) continue;
    ruleViolationsByLayer.set(idx, (ruleViolationsByLayer.get(idx) ?? 0) + 1);
  }

  const fileCounts = new Map<number, number>();
  for (const row of layerCheckResult.layerSummary) {
    fileCounts.set(row.index, row.fileCount);
  }

  const elementsByLayer = new Map<
    string,
    Array<{
      name: string;
      kind: "component" | "class" | "method" | "symbol";
      layerName: string;
      ruleId?: string;
      flowSeq?: number;
    }>
  >();
  const policiesByLayer = new Map<
    number,
    Array<{
      ruleId: string;
      kind: string;
      count: number;
      description?: string;
      adr?: string;
      severity?: "high" | "medium" | "low";
    }>
  >();

  if (opts.showRuleElements && rulesConfig) {
    const seen = new Set<string>();
    const addElement = (
      layerName: string,
      name: string,
      kind: "component" | "class" | "method" | "symbol",
      ruleId: string,
      flowSeq?: number,
    ) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const dedupeKey = `${layerName}::${trimmed}::${kind}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      const arr = elementsByLayer.get(layerName) ?? [];
      arr.push({
        name: trimmed,
        kind,
        layerName,
        ruleId,
        flowSeq,
      });
      elementsByLayer.set(layerName, arr);
    };

    for (const rule of rulesConfig.rules) {
      const expr = (rule as any).expresses;
      const elements = Array.isArray(expr?.elements) ? expr.elements : [];
      for (let elIdx = 0; elIdx < elements.length; elIdx++) {
        const el = elements[elIdx];
        if (
          !el ||
          typeof el.name !== "string" ||
          typeof el.layer !== "string"
        ) {
          continue;
        }
        const kindRaw =
          typeof el.kind === "string"
            ? (el.kind as string).toLowerCase()
            : "symbol";
        const kind =
          kindRaw === "component" || kindRaw === "class" || kindRaw === "method"
            ? (kindRaw as "component" | "class" | "method")
            : "symbol";
        addElement(el.layer, el.name, kind, rule.id, elIdx);
      }

      // Fallback extraction: derive visualizable rule elements from forbidden
      // clauses so --show-rule-elements is useful even without expresses.elements.
      for (const forbidden of rule.forbidden ?? []) {
        const sourceLayers = layerIndicesFromScope(forbidden.in, layerConfig);
        if (sourceLayers.length === 0) continue;

        for (const sourceLayerIndex of sourceLayers) {
          const sourceLayerName = layerConfig.layers[sourceLayerIndex]?.name;
          if (!sourceLayerName) continue;
          if (typeof forbidden.in === "string") {
            addElement(sourceLayerName, forbidden.in, "component", rule.id);
          }

          if (forbidden.type === "import_pattern") {
            if (typeof forbidden.pattern === "string") {
              const targetLayers = layerIndicesFromImportPattern(
                forbidden.pattern,
                layerConfig,
                forbidden.target_layer,
              );
              // If a target layer is resolvable, the prescriptive edge already carries
              // fromElementName/toElementName anchors; avoid adding duplicate fallback
              // chips that compete as hover-edge endpoints.
              if (targetLayers.length === 0) {
                addElement(
                  sourceLayerName,
                  forbidden.pattern,
                  "symbol",
                  rule.id,
                );
              }
            }
            continue;
          }

          if (
            forbidden.type === "call" &&
            typeof forbidden.callee === "string"
          ) {
            addElement(sourceLayerName, forbidden.callee, "symbol", rule.id);
          }
          if (
            forbidden.type === "symbol_name" &&
            typeof forbidden.pattern === "string"
          ) {
            addElement(sourceLayerName, forbidden.pattern, "symbol", rule.id);
          }
          if (
            forbidden.type === "property_access" &&
            typeof forbidden.chain === "string"
          ) {
            addElement(sourceLayerName, forbidden.chain, "symbol", rule.id);
          }
          if (forbidden.type === "property_chain_length") {
            const root =
              typeof forbidden.root === "string"
                ? forbidden.root
                : "property chain";
            const minDepth = Number.isFinite(forbidden.min_depth)
              ? String(forbidden.min_depth)
              : "?";
            addElement(
              sourceLayerName,
              `${root} (depth>=${minDepth})`,
              "symbol",
              rule.id,
            );
          }
          if (
            forbidden.type === "variable_assignment" &&
            typeof forbidden.value_pattern === "string"
          ) {
            addElement(
              sourceLayerName,
              forbidden.value_pattern,
              "symbol",
              rule.id,
            );
          }
        }
      }
    }
  }

  const layers = layerConfig.layers.map((layer, index) => ({
    index,
    name: layer.name,
    fileCount: fileCounts.get(index) ?? 0,
    ruleViolationCount: ruleViolationsByLayer.get(index) ?? 0,
    elements: elementsByLayer.get(layer.name) ?? [],
    policies: policiesByLayer.get(index) ?? [],
    row: typeof layer.row === "number" ? layer.row : undefined,
    column: typeof layer.column === "number" ? layer.column : undefined,
    colSpan: typeof layer.col_span === "number" ? layer.col_span : undefined,
    rowSpan: typeof layer.row_span === "number" ? layer.row_span : undefined,
    side:
      layer.side === "left" || layer.side === "right" ? layer.side : undefined,
  }));

  const layerNameToIndex = new Map<string, number>();
  for (const layer of layers) {
    layerNameToIndex.set(layer.name, layer.index);
  }

  const elementNameToLayerIndex = new Map<string, number>();
  for (const layer of layers) {
    for (const el of layer.elements) {
      if (!elementNameToLayerIndex.has(el.name)) {
        elementNameToLayerIndex.set(el.name, layer.index);
      }
    }
  }

  const edges: Array<{
    fromLayerIndex: number;
    toLayerIndex: number;
    type: "allowed" | "forbidden";
    label: string;
    count?: number;
    flowKind?: "control" | "data" | "hop";
    ruleId?: string;
    description?: string;
    adr?: string;
    severity?: "high" | "medium" | "low";
    fromElementName?: string;
    toElementName?: string;
  }> = [];

  // §17.2 — When rules.yaml has explicit `allowed:` entries, use those as green edges.
  // When absent, fall back to "within-layer + one-step-down" derived defaults.
  if (rulesConfig?.allowed && rulesConfig.allowed.length > 0) {
    for (const entry of rulesConfig.allowed) {
      const fromIdx = layerConfig.layers.findIndex(
        (l) => l.name === entry.from_layer,
      );
      const toIdx = layerConfig.layers.findIndex(
        (l) => l.name === entry.to_layer,
      );
      if (fromIdx < 0 || toIdx < 0) continue;
      edges.push({
        fromLayerIndex: fromIdx,
        toLayerIndex: toIdx,
        type: "allowed",
        label:
          entry.description ??
          `allowed (${entry.from_layer} → ${entry.to_layer})`,
        description: entry.description,
      });
    }
  } else {
    // Default allowed policy: within-layer + one-step-down in declared order.
    for (let i = 1; i < layerConfig.layers.length; i++) {
      edges.push({
        fromLayerIndex: i,
        toLayerIndex: i - 1,
        type: "allowed",
        label: "allowed (derived)",
      });
    }
  }

  // Layer-check violations shown as forbidden edges.
  const forbiddenCounts = new Map<string, number>();
  for (const v of layerCheckResult.violations) {
    const key = `${v.sourceLayerIndex}->${v.targetLayerIndex}`;
    forbiddenCounts.set(key, (forbiddenCounts.get(key) ?? 0) + 1);
  }
  for (const [k, count] of forbiddenCounts) {
    const [fromStr, toStr] = k.split("->");
    const from = parseInt(fromStr, 10);
    const to = parseInt(toStr, 10);
    edges.push({
      fromLayerIndex: from,
      toLayerIndex: to,
      type: "forbidden",
      label: `forbidden (${count})`,
      count,
    });
  }

  // Build allowed-override set from explicit edges in layers.yaml (e.g. providers → node).
  const allowedOverrides = new Set<string>(
    (layerConfig.allowed ?? [])
      .map((a) => {
        const f = layerConfig.layers.findIndex((l) => l.name === a.from);
        const t = layerConfig.layers.findIndex((l) => l.name === a.to);
        return f >= 0 && t >= 0 ? `${f}->${t}` : "";
      })
      .filter(Boolean),
  );

  // Synthetic forbidden policy edges from rules (even without expresses metadata).
  if (rulesConfig) {
    const seenRuleEdges = new Set<string>();
    const seenLayerPolicies = new Set<string>();
    for (const rule of rulesConfig.rules) {
      const ruleCount = rulesResult.byRule[rule.id] ?? 0;
      for (const forbidden of rule.forbidden ?? []) {
        const sourceLayers = layerIndicesFromScope(forbidden.in, layerConfig);
        if (sourceLayers.length === 0) continue;

        const inferredTargets =
          forbidden.type === "import_pattern"
            ? layerIndicesFromImportPattern(
                forbidden.pattern,
                layerConfig,
                forbidden.target_layer,
              )
            : [];
        const targetLayers = inferredTargets;

        const flowKind: "control" | "data" | "hop" =
          forbidden.type === "property_access" ||
          forbidden.type === "property_chain_length"
            ? "data"
            : forbidden.type === "import_pattern"
              ? "hop"
              : "control";

        for (const fromLayerIndex of sourceLayers) {
          if (targetLayers.length === 0) {
            const pKey = `${rule.id}::${forbidden.type}::${fromLayerIndex}`;
            if (!seenLayerPolicies.has(pKey)) {
              seenLayerPolicies.add(pKey);
              const arr = policiesByLayer.get(fromLayerIndex) ?? [];
              arr.push({
                ruleId: rule.id,
                kind: forbidden.type,
                count: ruleCount,
                description: rule.description,
                adr: rule.adr,
                severity: rule.severity,
              });
              policiesByLayer.set(fromLayerIndex, arr);
            }
            continue;
          }

          for (const toLayerIndex of targetLayers) {
            const key = `${rule.id}::${forbidden.type}::${fromLayerIndex}->${toLayerIndex}`;
            if (seenRuleEdges.has(key)) continue;
            seenRuleEdges.add(key);

            // Skip forbidden edge when layers.yaml declares an explicit allowed override.
            const overrideKey = `${fromLayerIndex}->${toLayerIndex}`;
            if (allowedOverrides.has(overrideKey)) continue;

            const suffix = ruleCount > 0 ? `, ${ruleCount}` : ", 0";
            edges.push({
              fromLayerIndex,
              toLayerIndex,
              type: "forbidden",
              flowKind,
              ruleId: rule.id,
              description: rule.description,
              adr: rule.adr,
              severity: rule.severity,
              count: ruleCount,
              label: `${forbidden.type} (${rule.id}${suffix})`,
              fromElementName: forbidden.in,
              toElementName: forbidden.pattern,
            });
          }
        }
      }
    }
  }

  for (const layer of layers) {
    layer.policies = policiesByLayer.get(layer.index) ?? [];
  }

  // Rule-expressed flows (17.1b): policy + flow kind + optional element endpoints.
  if (rulesConfig) {
    const seenFlows = new Set<string>();
    for (const rule of rulesConfig.rules) {
      const expr = (rule as any).expresses;
      const flows = Array.isArray(expr?.flows) ? expr.flows : [];
      for (const flow of flows) {
        if (
          !flow ||
          typeof flow.from !== "string" ||
          typeof flow.to !== "string"
        ) {
          continue;
        }

        const fromLayerIdx =
          typeof flow.from_layer === "string"
            ? layerNameToIndex.get(flow.from_layer)
            : elementNameToLayerIndex.get(flow.from);
        const toLayerIdx =
          typeof flow.to_layer === "string"
            ? layerNameToIndex.get(flow.to_layer)
            : elementNameToLayerIndex.get(flow.to);

        if (fromLayerIdx == null || toLayerIdx == null) {
          continue;
        }

        const kindRaw =
          typeof flow.kind === "string"
            ? String(flow.kind).toLowerCase()
            : "control";
        const flowKind: "control" | "data" | "hop" =
          kindRaw === "data" || kindRaw === "hop" ? kindRaw : "control";

        const policyRaw =
          typeof flow.policy === "string"
            ? String(flow.policy).toLowerCase()
            : "forbidden";
        const type: "allowed" | "forbidden" =
          policyRaw === "allowed" ? "allowed" : "forbidden";

        const key = [
          rule.id,
          fromLayerIdx,
          toLayerIdx,
          flow.from,
          flow.to,
          flowKind,
          type,
        ].join("::");
        if (seenFlows.has(key)) {
          continue;
        }
        seenFlows.add(key);

        const ruleCount = rulesResult.byRule[rule.id] ?? 0;
        edges.push({
          fromLayerIndex: fromLayerIdx,
          toLayerIndex: toLayerIdx,
          type,
          flowKind,
          ruleId: rule.id,
          fromElementName: flow.from,
          toElementName: flow.to,
          count: type === "forbidden" ? ruleCount : undefined,
          label:
            type === "forbidden"
              ? `${flowKind} flow (${rule.id}, ${ruleCount})`
              : `${flowKind} flow (${rule.id})`,
        });
      }
    }
  }

  const totalFiles = [...fileCounts.values()].reduce((a, b) => a + b, 0);

  // Build a lookup for rule metadata (description, adr, severity).
  const ruleMetaMap = new Map<
    string,
    { description?: string; adr?: string; severity: "high" | "medium" | "low" }
  >();
  for (const rule of rulesConfig?.rules ?? []) {
    ruleMetaMap.set(rule.id, {
      description: rule.description,
      adr: rule.adr,
      severity: rule.severity,
    });
  }

  const rules = Object.entries(rulesResult.byRule)
    .map(([id, count]) => {
      const meta = ruleMetaMap.get(id);
      const severity =
        meta?.severity ??
        rulesResult.violations.find((v) => v.ruleId === id)?.ruleSeverity ??
        "low";
      return {
        id,
        severity: severity as "high" | "medium" | "low",
        description: meta?.description,
        adr: meta?.adr,
        count,
      };
    })
    .filter((r) => r.count > 0);

  // Collect top violations per rule (up to 50 per rule, 500 total) for the architecture book.
  const violationsForBook: Array<{
    ruleId: string;
    severity: "high" | "medium" | "low";
    ruleDomain?: "structural" | "behavioral" | "documentary";
    ruleMode?: "error" | "warn";
    confidence?: number;
    filePath: string;
    line: number | null;
    symbol?: string | null;
    detail: string;
  }> = [];
  const violsByRule = new Map<string, number>();
  for (const v of rulesResult.violations) {
    const seen = violsByRule.get(v.ruleId) ?? 0;
    if (seen >= 50) continue;
    violsByRule.set(v.ruleId, seen + 1);
    if (violationsForBook.length >= 500) continue;
    violationsForBook.push({
      ruleId: v.ruleId,
      severity: v.ruleSeverity,
      ruleDomain: v.ruleDomain,
      ruleMode: v.ruleMode,
      confidence: v.confidence,
      filePath: v.filePath,
      line: v.line,
      symbol: v.symbol ?? undefined,
      detail: v.detail,
    });
  }

  // ── 18.1b/18.3: CARI overlay + coverage data ──────────────────────────────
  // Collect element names → file paths from the symbols table.
  const allElementNames = new Set<string>();
  for (const layer of layers) {
    for (const el of layer.elements) {
      if (el.name && !el.name.includes("*") && !el.name.includes("/")) {
        allElementNames.add(el.name);
      }
    }
  }

  // Build CARI overlay maps (best-effort — empty if DB has no data).
  let cariOverlay:
    | {
        hotspot: Record<
          string,
          { score: number; churn: number; coverage: number }
        >;
        hubs: Record<string, { degree: number }>;
        communities: Record<string, { id: number; label: string }>;
        actualImports: Array<{ from: string; to: string }>;
      }
    | undefined;

  let analyticsCodeHealth: InsightsBookData["codeHealth"] | undefined;
  let analyticsHotspots: InsightsBookData["hotspots"] | undefined;
  let analyticsDocumentation: InsightsBookData["documentation"] | undefined;
  let analyticsLivingScore: InsightsBookData["livingScore"] | undefined;
  let analyticsDocMap: InsightsDocMap | undefined;

  let layerCoverageData:
    | Array<{
        layerIndex: number;
        layerName: string;
        fileCount: number;
        coveragePercent: number;
        rulesGoverning: string[];
        hotspotFiles: Array<{ filePath: string; churn: number; score: number }>;
      }>
    | undefined;

  const rulesCatalog: InsightsBookData["rulesCatalog"] = rulesConfig
    ? {
        configPath: path.relative(process.cwd(), cfgPath),
        rawYaml: rulesYamlRaw,
        rules: rulesConfig.rules.map((rule) => ({
          id: rule.id,
          description: rule.description,
          adr: rule.adr,
          severity: rule.severity,
          domain: rule.domain,
          mode: rule.mode,
          sourceType: rule.source?.type,
          sourceFile: rule.source?.file,
          sourceBlockId: rule.source?.block_id,
          mermaid: rule.mermaid,
          forbidden: rule.forbidden ?? [],
        })),
      }
    : undefined;

  try {
    // ── hotspot overlay ──
    const hotspotResult = hotspotPriority(dbPath);
    const maxScore = Math.max(
      ...hotspotResult.priorities.map((p) => p.priorityScore),
      1,
    );
    // Map: file path → priority data
    const hotspotByFile = new Map<
      string,
      { score: number; churn: number; coverage: number }
    >();
    for (const p of hotspotResult.priorities) {
      hotspotByFile.set(p.filePath, {
        score: p.priorityScore / maxScore,
        churn: p.churn,
        coverage: p.coveragePercent,
      });
    }

    // ── hubs overlay ──
    const hubsResult = hubs(dbPath);
    const maxDegree = Math.max(...hubsResult.hubs.map((h) => h.totalDegree), 1);
    const hubsByName = new Map<string, { degree: number }>();
    for (const h of hubsResult.hubs) {
      hubsByName.set(h.name, { degree: h.totalDegree / maxDegree });
      // Also key by file path for file-level lookup
      if (h.filePath)
        hubsByName.set(h.filePath, { degree: h.totalDegree / maxDegree });
    }

    // ── communities overlay ──
    const commResult = communities(dbPath);
    // Assign a stable palette index per community id
    const communityById = new Map<number, string>();
    commResult.communities.forEach((c) => communityById.set(c.id, c.label));
    const memberToCommunity = new Map<string, { id: number; label: string }>();
    for (const c of commResult.communities) {
      for (const m of c.members) {
        memberToCommunity.set(m.name, { id: c.id, label: c.label });
        if (m.filePath)
          memberToCommunity.set(m.filePath, { id: c.id, label: c.label });
      }
    }

    // ── resolve element names → file paths from symbols ──
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true });
    let elementFileMap: Map<string, string>;
    try {
      const nameList = [...allElementNames]
        .map((n) => `'${n.replace(/'/g, "''")}'`)
        .join(",");
      const rows: Array<{ name: string; file_path: string }> = nameList
        ? (db
            .prepare(
              `SELECT name, file_path FROM symbols WHERE name IN (${nameList}) LIMIT 1000`,
            )
            .all() as any)
        : [];
      elementFileMap = new Map<string, string>(
        rows.map((r) => [r.name, r.file_path]),
      );
    } finally {
      db.close();
    }

    // ── build per-element overlay maps ──
    const hotspotOverlay: Record<
      string,
      { score: number; churn: number; coverage: number }
    > = {};
    const hubsOverlay: Record<string, { degree: number }> = {};
    const commOverlay: Record<string, { id: number; label: string }> = {};
    for (const name of allElementNames) {
      const fp = elementFileMap.get(name);
      const hotspotData =
        (fp ? hotspotByFile.get(fp) : undefined) ?? hotspotByFile.get(name);
      if (hotspotData) hotspotOverlay[name] = hotspotData;
      const hubData =
        hubsByName.get(name) ?? (fp ? hubsByName.get(fp) : undefined);
      if (hubData) hubsOverlay[name] = hubData;
      const commData =
        memberToCommunity.get(name) ??
        (fp ? memberToCommunity.get(fp) : undefined);
      if (commData) commOverlay[name] = commData;
    }

    // ── actual imports between element file paths ──
    const elementFiles = [...new Set([...elementFileMap.values()])];
    let actualImports: Array<{ from: string; to: string }> = [];
    if (elementFiles.length >= 2) {
      const Database2 = (await import("better-sqlite3")).default;
      const db2 = new Database2(dbPath, { readonly: true });
      try {
        const fpList = elementFiles
          .map((f) => `'${f.replace(/'/g, "''")}'`)
          .join(",");
        const importRows: Array<{ source_file: string; target_file: string }> =
          db2
            .prepare(
              `SELECT DISTINCT source_file, target_file FROM imports
             WHERE source_file IN (${fpList}) AND target_file IN (${fpList})
             LIMIT 500`,
            )
            .all() as any;
        // Invert file path back to element name
        const fileToElement = new Map<string, string>();
        for (const [elName, fp] of elementFileMap) {
          if (!fileToElement.has(fp)) fileToElement.set(fp, elName);
        }
        actualImports = importRows
          .map((r) => ({
            from: fileToElement.get(r.source_file) ?? r.source_file,
            to: fileToElement.get(r.target_file) ?? r.target_file,
          }))
          .filter((r) => r.from !== r.to);
      } finally {
        db2.close();
      }
    }

    cariOverlay = {
      hotspot: hotspotOverlay,
      hubs: hubsOverlay,
      communities: commOverlay,
      actualImports,
    };

    // ── §18 Analytics chapters (best-effort) ──────────────────────────────
    try {
      const clonesResult = clones(dbPath);
      const structResult = structuralClones(dbPath);
      const circResult = circularImports(dbPath);
      const unusedResult = unusedExports(dbPath);
      const bvResult = boundaryViolations(dbPath);
      analyticsCodeHealth = {
        cloneGroups: clonesResult.cloneGroups.map((g) => ({
          symbols: g.symbols,
          bodyLines: g.bodyLines,
        })),
        structuralCloneGroups: structResult.cloneGroups.map((g) => ({
          symbols: g.symbols,
          bodyLines: g.bodyLines,
        })),
        circularCycles: circResult.cycles,
        unusedExports: unusedResult.unused,
        boundaryViolations: bvResult.violations.map((v) => ({
          sourceFile: v.sourceFile,
          targetFile: v.targetFile,
          sourcePackage: v.sourcePackage,
          targetPackage: v.targetPackage,
          reason: v.reason,
        })),
        byPackagePair: bvResult.byPackagePair,
      };
    } catch {
      /* best-effort */
    }

    try {
      const depResult = dependencyDepth(dbPath);
      analyticsHotspots = {
        priorities: hotspotResult.priorities.map((p) => ({
          filePath: p.filePath,
          churn: p.churn,
          coveragePercent: p.coveragePercent,
          priorityScore: p.priorityScore,
          totalExportedSymbols: p.totalExportedSymbols,
        })),
        depthFiles: depResult.files.map((f) => ({
          filePath: f.filePath,
          maxDepth: f.maxDepth,
          directDependencies: f.directDependencies,
          directDependents: f.directDependents,
          risk: f.risk,
          reason: f.reason,
        })),
        hubs: hubsResult.hubs.map((h) => ({
          name: h.name,
          kind: h.kind,
          filePath: h.filePath,
          totalDegree: h.totalDegree,
          annotationDegree: h.annotationDegree,
          importDegree: h.importDegree,
        })),
        communities: commResult.communities.map((c) => ({
          id: c.id,
          label: c.label,
          size: c.size,
          members: c.members.map((m) => ({ name: m.name, kind: m.kind })),
        })),
      };
    } catch {
      /* best-effort */
    }

    try {
      const orphanedResult = orphanedSections(dbPath);
      const docResult = docCompleteness(dbPath);
      const rationaleResult = rationale(dbPath);
      const termResult = terminologyInconsistency(dbPath);
      // Aggregate: how many exported symbols are covered by at least one doc?
      const AggDatabase = (await import("better-sqlite3")).default;
      const aggDb = new AggDatabase(dbPath, { readonly: true });
      const aggRow = aggDb
        .prepare(`SELECT
          (SELECT COUNT(DISTINCT a.symbol_id) FROM annotations a
           JOIN symbols s ON a.symbol_id = s.id
           WHERE s.export='exported' AND a.confidence >= 0.5) AS covered,
          (SELECT COUNT(*) FROM symbols WHERE export='exported') AS total`)
        .get() as { covered: number; total: number };
      aggDb.close();

      // Meta-doc paths to exclude from completeness reporting
      const META_DOC_PREFIXES = [".github/", "ISSUE_TEMPLATE/"];
      const META_DOC_EXACT = new Set(["CLA.md","SECURITY.md","CODE_OF_CONDUCT.md","CONTRIBUTING.md","CHANGELOG.md","NOTICE"]);
      function isMetaDoc(p: string): boolean {
        const base = p.split("/").pop() ?? p;
        return META_DOC_PREFIXES.some(pre => p.startsWith(pre)) || META_DOC_EXACT.has(base);
      }

      analyticsDocumentation = {
        orphanedSections: orphanedResult.sections,
        docCoverageAggregate: { coveredSymbols: aggRow.covered, totalSymbols: aggRow.total },
        docCompleteness: docResult.docs.filter(d => !isMetaDoc(d.docPath)).map((d) => ({
          docPath: d.docPath,
          completenessPercent: d.completenessPercent,
          totalRelevantExports: d.totalRelevantExports,
          coveredExports: d.coveredExports,
          missing: d.missing.map((m) => ({ name: m.name, kind: m.kind })),
        })),
        rationale: rationaleResult.rationale,
        terminology: termResult.inconsistencies.map((ti) => ({
          symbolName: ti.symbolName,
          kind: ti.kind,
          filePath: ti.filePath,
          severity: ti.severity,
          variants: ti.variants.map((v) => ({ text: v.text, count: v.count })),
        })),
      };
    } catch {
      /* best-effort */
    }

    try {
      const lsResult = livingScore(dbPath);
      analyticsLivingScore = {
        score: lsResult.score,
        grade: lsResult.grade,
        specCoverage: {
          score: lsResult.specCoverage.score,
          available: lsResult.specCoverage.available,
          detail: lsResult.specCoverage.detail,
        },
        constraintConsistency: {
          score: lsResult.constraintConsistency.score,
          available: lsResult.constraintConsistency.available,
          detail: lsResult.constraintConsistency.detail,
        },
        docFreshness: {
          score: lsResult.docFreshness.score,
          available: lsResult.docFreshness.available,
          detail: lsResult.docFreshness.detail,
        },
        archConformance: {
          score: lsResult.archConformance.score,
          available: lsResult.archConformance.available,
          detail: lsResult.archConformance.detail,
        },
      };
    } catch {
      /* best-effort */
    }

    // ── 18.3 coverage chapter ──
    const coverageResult = moduleCoverage(dbPath);
    // Build: module path prefix → coverage data
    const moduleCovMap = new Map<
      string,
      { totalExported: number; documented: number }
    >();
    for (const m of coverageResult.modules) {
      moduleCovMap.set(m.module, {
        totalExported: m.totalExported,
        documented: m.documented,
      });
    }

    // For each layer, find modules that belong to it (simple prefix match against layer name)
    const rulesForLayer = new Map<number, Set<string>>();
    for (const rule of rulesConfig?.rules ?? []) {
      const expr = (rule as any).expresses;
      const els = Array.isArray(expr?.elements) ? expr.elements : [];
      for (const el of els) {
        if (!el || typeof el.layer !== "string") continue;
        const lIdx = layerConfig.layers.findIndex((l) => l.name === el.layer);
        if (lIdx < 0) continue;
        const set = rulesForLayer.get(lIdx) ?? new Set<string>();
        set.add(rule.id);
        rulesForLayer.set(lIdx, set);
      }
    }

    layerCoverageData = layers.map((layer) => {
      // Modules that belong to this layer: look for coverage modules whose path starts with the layer name
      const layerModules = coverageResult.modules.filter(
        (m) =>
          m.module.startsWith(layer.name) || layer.name.startsWith(m.module),
      );
      let totalEx = 0,
        totalDoc = 0;
      for (const m of layerModules) {
        totalEx += m.totalExported;
        totalDoc += m.documented;
      }
      const covPct = totalEx > 0 ? Math.round((totalDoc / totalEx) * 100) : 0;

      // Top 5 hotspot files for this layer
      const layerHotspots = hotspotResult.priorities
        .filter(
          (p) =>
            p.filePath.startsWith(layer.name + "/") ||
            p.filePath.includes("/" + layer.name + "/"),
        )
        .slice(0, 5)
        .map((p) => ({
          filePath: p.filePath,
          churn: p.churn,
          score: Math.round(p.priorityScore),
        }));

      return {
        layerIndex: layer.index,
        layerName: layer.name,
        fileCount: layer.fileCount,
        coveragePercent: covPct,
        rulesGoverning: [...(rulesForLayer.get(layer.index) ?? [])],
        hotspotFiles: layerHotspots,
      };
    });
  } catch {
    // CARI overlay is best-effort; skip silently if queries fail
  }

  // ── Documentation Map: doc→code interconnections via CARI annotations ──
  try {
    const DocDatabase = (await import("better-sqlite3")).default;
    const docDb = new DocDatabase(dbPath, { readonly: true });
    try {
      // Total annotations count
      const totalAnnotations = (
        docDb.prepare("SELECT COUNT(*) as cnt FROM annotations").get() as any
      ).cnt as number;

      // Per-doc stats: unique symbols and source files
      const docStats = docDb
        .prepare(
          `SELECT a.doc_path, COUNT(DISTINCT s.id) as unique_symbols, COUNT(DISTINCT s.file_path) as source_files
           FROM annotations a JOIN symbols s ON a.symbol_id = s.id
           GROUP BY a.doc_path
           ORDER BY unique_symbols DESC`,
        )
        .all() as Array<{
          doc_path: string;
          unique_symbols: number;
          source_files: number;
        }>;

      // Quality-filtered annotations for inline highlighting:
      // include code-span, bold, and high-confidence identifier/dictionary annotations
      const highlightAnnRows = docDb
        .prepare(
          `SELECT a.doc_path, a.line, a.text, a.source, a.confidence,
                  a.char_start, a.char_end,
                  s.name, s.kind, s.file_path, s.line as sym_line
           FROM annotations a JOIN symbols s ON a.symbol_id = s.id
           WHERE (a.source IN ('code-span', 'bold', 'heading')
                  OR (a.source = 'identifier' AND a.confidence >= 0.55)
                  OR (a.source = 'dictionary' AND a.confidence >= 0.85))
           ORDER BY a.doc_path, a.line, a.confidence DESC`,
        )
        .all() as Array<{
          doc_path: string;
          line: number;
          text: string;
          source: string;
          confidence: number;
          char_start: number | null;
          char_end: number | null;
          name: string;
          kind: string;
          file_path: string;
          sym_line: number;
        }>;

      // Also collect unmatched code-spans (symbol_id IS NULL) — these are
      // things like MCP tool names (`kg_query`, `cari_retrieve`) that are string
      // literals in the codebase, not TypeScript identifiers the AST can index.
      // Synthesise them as pointing to the MCP server file so they get highlighted.
      const mcpServerPath = "packages/cli/src/mcp/server.ts";
      const unmatchedCodeSpans = docDb
        .prepare(
          `SELECT a.doc_path, a.line, a.text, a.source
           FROM annotations a
           WHERE a.source = 'code-span' AND (a.symbol_id IS NULL OR a.symbol_id = '')
             AND length(a.text) >= 3`,
        )
        .all() as Array<{ doc_path: string; line: number; text: string; source: string }>;

      // Synthesise as virtual annotations pointing to the MCP server
      const syntheticRows = unmatchedCodeSpans.map(r => ({
        doc_path: r.doc_path,
        line: r.line,
        text: r.text,
        source: r.source,
        confidence: 0.5,
        char_start: null,
        char_end: null,
        name: r.text,       // display as the literal tool/command name
        kind: "tool",
        file_path: mcpServerPath,
        sym_line: 1,
      }));
      const allHighlightRows = [...highlightAnnRows, ...syntheticRows];

      // Group highlight annotations per doc
      const highlightsByDoc = new Map<string, typeof allHighlightRows>();
      for (const row of allHighlightRows) {
        const arr = highlightsByDoc.get(row.doc_path) ?? [];
        arr.push(row);
        highlightsByDoc.set(row.doc_path, arr);
      }

      // Summary annotations (deduplicated by symbol, for sidebar stats)
      const allAnnRows = docDb
        .prepare(
          `SELECT a.doc_path, s.name, s.kind, s.file_path, s.line, MAX(a.confidence) as confidence,
                  (SELECT a2.line FROM annotations a2 WHERE a2.symbol_id = s.id AND a2.doc_path = a.doc_path ORDER BY a2.confidence DESC LIMIT 1) as best_line,
                  (SELECT a2.text FROM annotations a2 WHERE a2.symbol_id = s.id AND a2.doc_path = a.doc_path ORDER BY a2.confidence DESC LIMIT 1) as best_text,
                  (SELECT a2.source FROM annotations a2 WHERE a2.symbol_id = s.id AND a2.doc_path = a.doc_path ORDER BY a2.confidence DESC LIMIT 1) as best_source
           FROM annotations a JOIN symbols s ON a.symbol_id = s.id
           GROUP BY a.doc_path, s.id
           ORDER BY a.doc_path, confidence DESC`,
        )
        .all() as Array<{
          doc_path: string;
          name: string;
          kind: string;
          file_path: string;
          line: number;
          confidence: number;
          best_line: number;
          best_text: string;
          best_source: string;
        }>;

      // Group summary annotations per doc, cap at 30 for display
      const topByDoc = new Map<string, typeof allAnnRows>();
      for (const row of allAnnRows) {
        const arr = topByDoc.get(row.doc_path) ?? [];
        if (arr.length < 30) arr.push(row);
        topByDoc.set(row.doc_path, arr);
      }

      // Hot symbols: mentioned in 3+ docs
      const hotSymbolRows = docDb
        .prepare(
          `SELECT s.name, s.kind, s.file_path,
                  COUNT(DISTINCT a.doc_path) as doc_count,
                  GROUP_CONCAT(DISTINCT a.doc_path) as docs
           FROM annotations a JOIN symbols s ON a.symbol_id = s.id
           GROUP BY s.id
           HAVING doc_count >= 3
           ORDER BY doc_count DESC
           LIMIT 60`,
        )
        .all() as Array<{
          name: string;
          kind: string;
          file_path: string;
          doc_count: number;
          docs: string;
        }>;

      const docEntries = await Promise.all(
        docStats.map(async (stat) => {
          const anns = topByDoc.get(stat.doc_path) ?? [];
          const highlights = highlightsByDoc.get(stat.doc_path) ?? [];

          // Extract package prefixes from referenced file paths
          const pkgSet = new Set<string>();
          for (const ann of anns) {
            const m = ann.file_path.match(/^(packages\/[^/]+|apps\/[^/]+)/);
            if (m) pkgSet.add(m[1]);
          }

          // Read full file content (best-effort)
          let content = "";
          try {
            const fullPath = path.join(process.cwd(), stat.doc_path);
            content = await fs.readFile(fullPath, "utf8");
          } catch {
            /* file not readable — skip content */
          }

          return {
            path: stat.doc_path,
            content,
            uniqueSymbols: stat.unique_symbols,
            uniqueSourceFiles: stat.source_files,
            referencedPackages: [...pkgSet].slice(0, 12),
            topAnnotations: highlights.map((ann) => ({
              symbolName: ann.name,
              symbolKind: ann.kind,
              symbolFile: ann.file_path,
              symbolLine: ann.sym_line,
              confidence: ann.confidence,
              docLine: ann.line,
              text: ann.text,
              source: ann.source,
              charStart: ann.char_start,
              charEnd: ann.char_end,
            })),
          };
        }),
      );

      // Collect all source files referenced by annotations across all docs.
      // Cap: max 200 unique files to keep the book size manageable.
      const linkedSourcePaths = new Set<string>();
      for (const entry of docEntries) {
        for (const ann of entry.topAnnotations) {
          if (ann.symbolFile) linkedSourcePaths.add(ann.symbolFile);
          if (linkedSourcePaths.size >= 200) break;
        }
        if (linkedSourcePaths.size >= 200) break;
      }

      // Read each referenced source file (best-effort, cap at 2000 lines to keep size reasonable)
      const SOURCE_LINE_CAP = 2000;
      const sourceFiles: Record<string, string> = {};
      await Promise.all(
        [...linkedSourcePaths].map(async (relPath) => {
          try {
            const fullPath = path.join(process.cwd(), relPath);
            const raw = await fs.readFile(fullPath, "utf8");
            const lines = raw.split("\n");
            sourceFiles[relPath] = lines.slice(0, SOURCE_LINE_CAP).join("\n") +
              (lines.length > SOURCE_LINE_CAP ? `\n// … [truncated at ${SOURCE_LINE_CAP} lines]` : "");
          } catch {
            /* skip unreadable */
          }
        }),
      );

      analyticsDocMap = {
        docs: docEntries,
        totalAnnotations,
        hotSymbols: hotSymbolRows.map((h) => ({
          name: h.name,
          kind: h.kind,
          file: h.file_path,
          docCount: h.doc_count,
          docs: h.docs ? h.docs.split(",") : [],
        })),
        sourceFiles,
      };
    } finally {
      docDb.close();
    }
  } catch {
    /* best-effort */
  }

  return {
    meta: {
      generated: new Date().toISOString(),
      totalFiles,
      totalRuleViolations: rulesResult.totalViolations,
      totalLayerViolations: layerCheckResult.totalViolations,
    },
    layers,
    edges,
    rules,
    violations: violationsForBook,
    cariOverlay,
    layerCoverage: layerCoverageData,
    codeHealth: analyticsCodeHealth,
    hotspots: analyticsHotspots,
    documentation: analyticsDocumentation,
    livingScore: analyticsLivingScore,
    rulesCatalog,
    docMap: analyticsDocMap,
    options: {
      showRuleElements: opts.showRuleElements,
    },
  };
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

// ── iw index watch ─────────────────────────────────────────────

const WATCH_IGNORE_RE =
  /[/\\](node_modules|\.git|dist|build|coverage)[/\\]|[/\\]\.iw[/\\]|\.min\.js$|\.map$/;

function isWatchIgnored(filePath: string): boolean {
  return WATCH_IGNORE_RE.test(filePath);
}

const indexWatchSubcommand = new Command("watch")
  .description(
    "Watch the workspace and incrementally update the CARI index on file changes",
  )
  .argument(
    "[paths...]",
    "Scope to specific directories (default: workspace root)",
  )
  .option("--db <path>", "Path to index.db")
  .option("--exclude <patterns...>", "Exclude files matching these globs")
  .option("--debounce <ms>", "Debounce delay in ms (default: 500)", parseInt)
  .option("-v, --verbose", "Verbose output", false)
  .action(async (paths: string[], opts) => {
    const cwd = process.cwd();
    const dbPath = resolveDbPath(opts.db);
    const verbose: boolean = opts.verbose;
    const debounceMs: number = opts.debounce ?? 500;

    const log = verbose
      ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
      : () => {};

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

    const iwIgnorePatterns = await loadIwIgnore(cwd);
    const cliExcludes: string[] = opts.exclude ?? [];
    const excludePatterns = buildExcludeList(
      cliExcludes,
      iwIgnorePatterns,
      true,
    );

    const watchPaths =
      paths.length > 0
        ? paths.map((p) => (path.isAbsolute(p) ? p : path.join(cwd, p)))
        : [cwd];

    console.log(chalk.blue(`\n  ▸ CARI Watch Mode`));
    console.log(chalk.blue("  " + "═".repeat(40)));
    console.log(
      `    Watching: ${watchPaths.map((p) => path.relative(cwd, p) || ".").join(", ")}`,
    );
    console.log(`    Index:    ${path.relative(cwd, dbPath)}`);
    console.log(`    Debounce: ${debounceMs}ms`);
    console.log(chalk.dim("\n    Press Ctrl+C to stop.\n"));

    let running = false;
    let pendingPaths: Set<string> = new Set();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cycleCount = 0;

    /** Pretty-print a compact timestamp. */
    function ts(): string {
      return chalk.dim(new Date().toLocaleTimeString());
    }

    /** Run one incremental update cycle. */
    async function runCycle(changedAbsPaths: string[]): Promise<void> {
      if (running) {
        for (const p of changedAbsPaths) pendingPaths.add(p);
        return;
      }
      running = true;
      cycleCount++;

      const relChanged = changedAbsPaths.map((p) => path.relative(cwd, p));
      console.log(
        `${ts()} ${chalk.magenta(`Cycle #${cycleCount}`)} — ${changedAbsPaths.length} file(s) changed`,
      );
      if (verbose) {
        for (const rp of relChanged) console.log(`    ${chalk.dim(rp)}`);
      }

      const cycleStart = performance.now();
      try {
        // 1. Discover all current files
        const docFiles = await discoverFiles(watchPaths, cwd, {
          exclude: excludePatterns,
        });
        const axOutput = await runAxStage({ workspaceRoot: cwd });
        const allCodeFiles = axOutput.files.map((f) =>
          path.resolve(cwd, f.filePath),
        );
        const allFiles = [...docFiles, ...allCodeFiles];

        // 2. Detect changes
        const changes = detectChanges(dbPath, cwd, allFiles);
        if (changes.length === 0) {
          console.log(`${ts()} ${chalk.green("✓")} Index up to date`);
          running = false;
          flushPending();
          return;
        }

        console.log(
          chalk.cyan(
            `    ${changes.length} change(s): ` +
              `${changes.filter((c) => c.status === "added").length} added, ` +
              `${changes.filter((c) => c.status === "modified").length} modified, ` +
              `${changes.filter((c) => c.status === "deleted").length} deleted`,
          ),
        );

        // 3. Re-extract changed doc files
        const changedDocs = changes.filter(
          (c) => c.isDoc && c.status !== "deleted",
        );
        const kwxOutputs: KwxStageOutput[] = [];
        const ctx = createMinimalContext(verbose);

        for (const change of changedDocs) {
          const abs = path.resolve(cwd, change.path);
          log(`KWX: ${change.path}`);
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

        const coxOutput =
          kwxOutputs.length > 0 ? await runCoxStage({ kwxOutputs }) : undefined;
        const annotations =
          kwxOutputs.length > 0 ? annotate(axOutput, kwxOutputs, { log }) : [];

        // 4. Refresh TCG (lightweight)
        const tcxOutput = await runTcxStage({
          workspaceRoot: cwd,
          depth: 100,
          log: verbose
            ? (msg: string) => console.log(chalk.gray(`    tcx: ${msg}`))
            : undefined,
        });
        const cocOutput = runCocStage({ tcxOutput });
        const hotOutput = runHotStage({ tcxOutput });
        const ownOutput = runOwnStage({ tcxOutput });
        const stlOutput = runStlStage({ tcxOutput, workspaceRoot: cwd });
        const tcgOutput: TcgPipelineOutput = {
          tcx: tcxOutput,
          coc: cocOutput,
          hot: hotOutput,
          own: ownOutput,
          stl: stlOutput,
          meta: {
            session: "watch",
            workspaceRoot: cwd,
            gitDepth: "100 commits",
            totalDurationMs: 0,
          },
        };

        // 5. Apply changes
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

        const elapsed = ((performance.now() - cycleStart) / 1000).toFixed(1);
        console.log(
          `${ts()} ${chalk.green("✓")} Updated in ${elapsed}s — ` +
            chalk.gray(
              `symbols=${result.updated.symbols} annotations=${result.updated.annotations} files=${result.updated.files}`,
            ),
        );
      } catch (err: any) {
        console.error(
          `${ts()} ${chalk.red("✗")} Update failed: ${err.message}`,
        );
        if (verbose && err.stack) console.error(chalk.gray(err.stack));
      } finally {
        running = false;
        flushPending();
      }
    }

    function flushPending(): void {
      if (pendingPaths.size > 0) {
        const batch = [...pendingPaths];
        pendingPaths = new Set();
        void runCycle(batch);
      }
    }

    function scheduleCycle(absPath: string): void {
      pendingPaths.add(absPath);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const batch = [...pendingPaths];
        pendingPaths = new Set();
        void runCycle(batch);
      }, debounceMs);
    }

    // Start chokidar watcher
    const { watch: chokidarWatch } = await import("chokidar");
    const watcher = chokidarWatch(watchPaths, {
      ignored: isWatchIgnored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    watcher.on("add", (p) => scheduleCycle(p));
    watcher.on("change", (p) => scheduleCycle(p));
    watcher.on("unlink", (p) => scheduleCycle(p));
    watcher.on("error", (err) =>
      console.error(chalk.red(`  Watcher error: ${err}`)),
    );

    // Graceful shutdown
    process.on("SIGINT", () => {
      console.log(chalk.dim("\n\n  Stopping watcher..."));
      void watcher.close().then(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      void watcher.close().then(() => process.exit(0));
    });
  });

// ── iw index clones ────────────────────────────────────────────

const indexClonesSubcommand = new Command("clones")
  .description("Detect exact code clones (identical body hash)")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .option(
    "--layer-analysis",
    "Annotate each clone group with inferred layer context (DRY vs architectural violation)",
    false,
  )
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = clones(dbPath, { layerAnalysis: opts.layerAnalysis });

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
      const la = group.layerAnalysis;
      const layerTag = la
        ? la.kind === "architectural"
          ? chalk.red(
              `  ⚠  ARCHITECTURAL VIOLATION (layers ${la.uniqueLayers.join(", ")})`,
            )
          : la.kind === "dry"
            ? chalk.yellow(`  ⚠  DRY VIOLATION (layer ${la.uniqueLayers[0]})`)
            : chalk.gray("  ·  UNKNOWN LAYER")
        : "";
      console.log(
        chalk.cyan(
          `\n    Clone group (${group.bodyLines} lines, ${group.symbols.length} copies):`,
        ) + layerTag,
      );
      for (let i = 0; i < group.symbols.length; i++) {
        const s = group.symbols[i];
        const layerSuffix =
          la && la.layers[i] !== undefined && la.layers[i] >= 0
            ? chalk.gray(` [Layer ${la.layers[i]}]`)
            : "";
        console.log(
          chalk.gray(`      ${s.kind} ${s.name} (${s.filePath}:${s.line})`) +
            layerSuffix,
        );
      }
      if (la && la.kind !== "unknown") {
        console.log(chalk.gray(`      → ${la.suggestion}`));
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
  .option(
    "--layer-analysis",
    "Annotate each clone group with inferred layer context (DRY vs architectural violation)",
    false,
  )
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = structuralClones(dbPath, {
      layerAnalysis: opts.layerAnalysis,
    });

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
      const la = group.layerAnalysis;
      const layerTag = la
        ? la.kind === "architectural"
          ? chalk.red(
              `  ⚠  ARCHITECTURAL VIOLATION (layers ${la.uniqueLayers.join(", ")})`,
            )
          : la.kind === "dry"
            ? chalk.yellow(`  ⚠  DRY VIOLATION (layer ${la.uniqueLayers[0]})`)
            : chalk.gray("  ·  UNKNOWN LAYER")
        : "";
      console.log(
        chalk.cyan(
          `\n    Clone group (${group.bodyLines} lines, ${group.symbols.length} copies):`,
        ) + layerTag,
      );
      for (let i = 0; i < group.symbols.length; i++) {
        const s = group.symbols[i];
        const layerSuffix =
          la && la.layers[i] !== undefined && la.layers[i] >= 0
            ? chalk.gray(` [Layer ${la.layers[i]}]`)
            : "";
        console.log(
          chalk.gray(`      ${s.kind} ${s.name} (${s.filePath}:${s.line})`) +
            layerSuffix,
        );
      }
      if (la && la.kind !== "unknown") {
        console.log(chalk.gray(`      → ${la.suggestion}`));
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

    console.log(chalk.blue(`\n  ▸ Top ${items.length} hubs (by total degree)`));
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
  .option(
    "-r, --resolution <n>",
    "Community granularity: higher values (2–5) produce more, smaller communities (default: 1.0)",
    "1.0",
  )
  .option(
    "--max-size <n>",
    "Max community size before recursive sub-splitting (default: 100)",
    "100",
  )
  .option(
    "-m, --mode <mode>",
    "Community graph mode: structural (imports/co-changes), semantic (full co-occurrence), temporal (co-changes only)",
    "structural",
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = communities(dbPath, {
      resolution: parseFloat(opts.resolution),
      maxSize: parseInt(opts.maxSize, 10),
      mode: opts.mode as "structural" | "semantic" | "temporal",
    });

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
        console.log(chalk.gray(`      … and ${c.members.length - 10} more`));
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
      console.log(chalk.gray(`      ${s.reason}`));
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
      chalk.blue(
        `\n  ▸ ${result.totalCount} rationale comments (${kindSummary})`,
      ),
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

// ── iw index naming-violations ─────────────────────────────────

const indexNamingViolationsSubcommand = new Command("naming-violations")
  .description("List code symbols that violate naming conventions (6.1)")
  .option("--db <path>", "Path to index.db")
  .option(
    "--kind <kind>",
    "Filter by symbol kind: function, class, method, etc.",
  )
  .option("--exported-only", "Only check exported symbols", false)
  .option("-n, --limit <n>", "Maximum results", "50")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = namingViolations(dbPath, {
      exportedOnly: opts.exportedOnly,
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    let items = result.violations;
    if (opts.kind) {
      items = items.filter(
        (v) => v.kind.toLowerCase() === opts.kind.toLowerCase(),
      );
    }

    if (items.length === 0) {
      console.log(
        chalk.green("\n  ✓ No naming convention violations found.\n"),
      );
      return;
    }

    const kindSummary = Object.entries(result.byKind)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    console.log(
      chalk.blue(
        `\n  ▸ ${result.totalViolations} violation(s) (${kindSummary})`,
      ),
    );

    const limit = parseInt(opts.limit, 10);
    for (const v of items.slice(0, limit)) {
      console.log(
        `    ${chalk.red(v.kind.padEnd(12))} ${chalk.yellow(v.name.padEnd(30))} expected ${chalk.gray(v.expected)} — ${chalk.gray(v.filePath + ":" + v.line)}`,
      );
    }
    if (items.length > limit) {
      console.log(chalk.gray(`    ...and ${items.length - limit} more`));
    }
    console.log();
  });

// ── iw index comment-code-ratio ────────────────────────────────

const indexCommentCodeRatioSubcommand = new Command("comment-code-ratio")
  .description("Show comment-to-code ratio anomalies per file (6.4)")
  .option("--db <path>", "Path to index.db")
  .option("--all", "Show all files, not just anomalies")
  .option("-n, --limit <n>", "Maximum results", "50")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = commentCodeRatio(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const items = opts.all ? result.files : result.anomalies;

    if (items.length === 0) {
      console.log(
        chalk.green(
          opts.all
            ? "\n  ✓ No files with comment data found.\n"
            : "\n  ✓ No comment-to-code ratio anomalies found.\n",
        ),
      );
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ ${opts.all ? `${result.totalFiles} file(s)` : `${result.anomalies.length} anomaly(ies)`} — workspace average ratio: ${result.averageRatio.toFixed(3)}`,
      ),
    );

    const limit = parseInt(opts.limit, 10);
    for (const f of items.slice(0, limit)) {
      const anomalyLabel =
        f.anomaly === "under-commented"
          ? chalk.yellow(" ⚠ under-commented")
          : f.anomaly === "over-commented"
            ? chalk.red(" ⚠ over-commented")
            : "";
      console.log(
        `    ${chalk.gray(f.filePath.padEnd(50))} ratio=${f.ratio.toFixed(3)} (${f.commentLines}/${f.codeLines})${anomalyLabel}`,
      );
    }
    if (items.length > limit) {
      console.log(chalk.gray(`    ...and ${items.length - limit} more`));
    }
    console.log();
  });

// ── iw index skipped-files ─────────────────────────────────────

const indexSkippedFilesSubcommand = new Command("skipped-files")
  .description("List files that were skipped during AX extraction (6.5)")
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = skippedFiles(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalSkipped === 0) {
      console.log(
        chalk.green("\n  ✓ No files were skipped during AX extraction.\n"),
      );
      return;
    }

    console.log(
      chalk.yellow(
        `\n  ⚠ ${result.totalSkipped} file(s) skipped during AX extraction`,
      ),
    );
    console.log(
      chalk.gray("  Use --max-file-size to adjust the size threshold.\n"),
    );
    for (const f of result.skipped) {
      console.log(`    ${chalk.gray(f.filePath)}`);
      console.log(`      ${chalk.red(f.reason)}`);
    }
    console.log();
  });

// ── iw index rules-check ──────────────────────────────────────────────────────

/**
 * §17.4 — ASCII Architecture Conformance Diagram for `iw index rules-check`.
 * Shows each rule as a flow edge (import_pattern) or bullet check (other types),
 * with ✓/✗ verdict per rule and a summary line.
 */
function renderAsciiConformanceDiagram(
  config: RulesConfig,
  result: RulesCheckResult,
  filteredRuleId?: string,
): string {
  // Extract a short human-readable label from a file glob
  function labelFromGlob(g: string): string {
    // Strip leading **/
    let s = g.replace(/^\*\*\//, "");
    const parts = s.split("/");
    // Find first segment that is a real name (no wildcards)
    for (const p of parts) {
      if (p && !p.includes("*")) return p;
    }
    // Fallback: use whole thing trimmed
    return g.slice(0, 16);
  }

  type FlowEdge = {
    ruleId: string;
    from: string;
    to: string;
    severity: "high" | "medium" | "low";
    violations: number;
    description?: string;
  };
  type CheckRule = {
    ruleId: string;
    severity: "high" | "medium" | "low";
    violations: number;
    description?: string;
  };

  const flowEdges: FlowEdge[] = [];
  const checkRules: CheckRule[] = [];

  const rulesToShow = filteredRuleId
    ? config.rules.filter((r) => r.id === filteredRuleId)
    : config.rules;

  for (const rule of rulesToShow) {
    const violations = result.byRule[rule.id] ?? 0;
    const importForbidden = rule.forbidden.filter(
      (f) => f.type === "import_pattern" && f.in && f.pattern,
    );

    if (importForbidden.length > 0) {
      const fromLabels = [
        ...new Set(importForbidden.map((f) => labelFromGlob(f.in!))),
      ];
      const toLabels = [
        ...new Set(importForbidden.map((f) => labelFromGlob(f.pattern!))),
      ];
      flowEdges.push({
        ruleId: rule.id,
        from: fromLabels.join("/"),
        to: toLabels.join("/"),
        severity: rule.severity,
        violations,
        description: rule.description?.split("\n")[0].slice(0, 55),
      });
    } else {
      checkRules.push({
        ruleId: rule.id,
        severity: rule.severity,
        violations,
        description: rule.description?.split("\n")[0].slice(0, 55),
      });
    }
  }

  if (
    flowEdges.length === 0 &&
    checkRules.length === 0 &&
    !config.allowed?.length
  )
    return "";

  const lines: string[] = [];
  lines.push("");
  lines.push("  Architecture Conformance (rules.yaml):");
  lines.push("");

  // §17.2 Allowed entries — explicit positive permissions
  if (config.allowed && config.allowed.length > 0 && !filteredRuleId) {
    const maxFrom = Math.max(...config.allowed.map((e) => e.from_layer.length));
    for (const entry of config.allowed) {
      const fromPad = entry.from_layer.padEnd(maxFrom);
      const desc = entry.description
        ? chalk.gray(` — ${entry.description}`)
        : "";
      lines.push(
        `  ${chalk.gray("[OK]  ")}  ${fromPad}  ${chalk.green("──────────✓──────────▶")}  ${chalk.cyan(entry.to_layer)}${desc}`,
      );
    }
    lines.push("");
  }

  // Flow edges (import_pattern rules with from/to topology)
  if (flowEdges.length > 0) {
    const maxFrom = Math.max(...flowEdges.map((e) => e.from.length));
    for (const edge of flowEdges) {
      const sevLabel =
        edge.severity === "high"
          ? chalk.red("[HIGH]")
          : edge.severity === "medium"
            ? chalk.yellow("[MED] ")
            : chalk.gray("[LOW] ");
      const fromPad = edge.from.padEnd(maxFrom);
      const arrow =
        edge.violations > 0
          ? chalk.red(
              `──✗ ${edge.violations} violation${edge.violations !== 1 ? "s" : ""}──▶`,
            )
          : chalk.green("──────────✓──────────▶");
      const ruleLabel = chalk.gray(`  ${edge.ruleId}`);
      const desc = edge.description ? chalk.gray(` — ${edge.description}`) : "";
      lines.push(
        `  ${sevLabel}  ${fromPad}  ${arrow}  ${chalk.cyan(edge.to)}${ruleLabel}${desc}`,
      );
    }
    lines.push("");
  }

  // Non-flow rules (call, symbol_name, cypher, etc.)
  if (checkRules.length > 0) {
    const maxId = Math.max(...checkRules.map((r) => r.ruleId.length));
    for (const rule of checkRules) {
      const sevLabel =
        rule.severity === "high"
          ? chalk.red("[HIGH]")
          : rule.severity === "medium"
            ? chalk.yellow("[MED] ")
            : chalk.gray("[LOW] ");
      const verdict =
        rule.violations > 0
          ? chalk.red(
              `✗ ${rule.violations} violation${rule.violations !== 1 ? "s" : ""}`,
            )
          : chalk.green("✓ clean");
      const desc = rule.description ? chalk.gray(` — ${rule.description}`) : "";
      lines.push(
        `  ${sevLabel}  ● ${chalk.white(rule.ruleId.padEnd(maxId))}  ${verdict}${desc}`,
      );
    }
    lines.push("");
  }

  // Summary line
  const cleanCount = rulesToShow.filter(
    (r) => (result.byRule[r.id] ?? 0) === 0,
  ).length;
  const totalCount = rulesToShow.length;
  const totalViol = rulesToShow.reduce(
    (s, r) => s + (result.byRule[r.id] ?? 0),
    0,
  );
  const summaryColor = totalViol === 0 ? chalk.green : chalk.yellow;
  lines.push(
    `  ${summaryColor(`${cleanCount}/${totalCount} rule${totalCount !== 1 ? "s" : ""} clean`)}${totalViol > 0 ? chalk.red(`  ·  ${totalViol} total violation(s)`) : ""}`,
  );
  lines.push("");

  return lines.join("\n");
}

async function loadRulesConfig(configPath: string): Promise<RulesConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    throw new Error(
      `Rules config not found: ${configPath}\n  Create a .iw/rules.yaml file to define architectural rules.`,
    );
  }
  const parsed = yamlLoad(raw) as RulesConfig;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid rules config: ${configPath}`);
  }
  if (!Array.isArray(parsed.rules)) {
    throw new Error(`rules.yaml must have a top-level 'rules' array.`);
  }
  // §17.2 — validate allowed: block if present
  if (parsed.allowed !== undefined && !Array.isArray(parsed.allowed)) {
    throw new Error(
      `rules.yaml 'allowed' must be an array of {from_layer, to_layer} entries.`,
    );
  }
  if (Array.isArray(parsed.allowed)) {
    for (const entry of parsed.allowed) {
      if (!entry.from_layer || !entry.to_layer) {
        throw new Error(
          `rules.yaml 'allowed' entries must have 'from_layer' and 'to_layer' fields.`,
        );
      }
    }
  }
  return parsed;
}

/**
 * Load optional .iw/config.yaml workspace config.
 * Returns undefined (silently) if the file doesn't exist.
 */
async function loadIwConfig(
  configDir: string,
): Promise<import("@intentweave/index").IwConfig | undefined> {
  const configPath = path.join(configDir, "config.yaml");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = yamlLoad(raw) as import("@intentweave/index").IwConfig;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
  high: chalk.red,
  medium: chalk.yellow,
  low: chalk.gray,
};

const indexRulesCheckSubcommand = new Command("rules-check")
  .description(
    "Check codebase against semantic architectural rules from .iw/rules.yaml (13.2/13.3/13.5)",
  )
  .option("--db <path>", "Path to index.db")
  .option("--config <path>", "Path to rules.yaml", ".iw/rules.yaml")
  .option(
    "--severity <level>",
    "Minimum severity to report: high | medium | low",
    "low",
  )
  .option("--rule-id <id>", "Only check a specific rule by ID")
  .option(
    "--changed <files>",
    "Comma-separated list of changed files (incremental CI mode; 13.3)",
  )
  .option("-n, --limit <n>", "Maximum violations to report", "100")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .option(
    "--domain <domain>",
    "Intent domain to check: structural | behavioral | documentary | all",
  )
  .option(
    "--save-baseline <file>",
    "Save current violation counts as baseline JSON (13.5)",
  )
  .option(
    "--baseline <file>",
    "Compare against saved baseline; combine with --fail-on-increase for CI gate (13.5)",
  )
  .option(
    "--fail-on-increase",
    "Exit code 1 if any severity count exceeds baseline (use with --baseline; 13.5)",
  )
  .option(
    "--dry-run-query <rule-id>",
    "Execute a specific cypher rule and print resulting violations (13.11)",
  )
  .option(
    "--no-diagram",
    "Suppress the ASCII conformance diagram in text output (17.4)",
  )
  .action(async (opts) => {
    const dbPath = resolveDbPath(opts.db);
    const configPath = path.resolve(opts.config);

    let config: RulesConfig;
    try {
      config = await loadRulesConfig(configPath);
    } catch (err: any) {
      console.error(chalk.red(`\n  ✗ ${err.message}\n`));
      process.exitCode = 2;
      return;
    }

    // Load optional .iw/config.yaml for per-domain thresholds (Phase 1)
    const iwConfigDir = path.join(path.dirname(configPath));
    const iwConfig = await loadIwConfig(iwConfigDir);

    const changed = opts.changed
      ? opts.changed
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined;

    // ── --dry-run-query (13.11) ─────────────────────────────────────────────
    if (opts.dryRunQuery) {
      const ruleId = opts.dryRunQuery as string;
      const hasCypherRule = config.rules.some(
        (r) => r.id === ruleId && r.forbidden.some((f) => f.type === "cypher"),
      );
      if (!hasCypherRule) {
        console.error(
          chalk.red(`\n  ✗ No cypher rule found with id: ${ruleId}\n`),
        );
        process.exitCode = 1;
        return;
      }

      const dryRun = rulesCheck(dbPath, config, {
        severity: "low",
        ruleId,
        changed,
        limit: parseInt(opts.limit, 10),
        workspaceRoot: process.cwd(),
      });

      process.stdout.write(JSON.stringify(dryRun, null, 2) + "\n");
      return;
    }

    const result = rulesCheck(dbPath, config, {
      severity: opts.severity as "high" | "medium" | "low",
      ruleId: opts.ruleId,
      changed,
      limit: parseInt(opts.limit, 10),
      domain: opts.domain as
        | "structural"
        | "behavioral"
        | "documentary"
        | "all"
        | undefined,
      iwConfig,
      workspaceRoot: process.cwd(),
    });

    // ── --save-baseline (13.5) ──────────────────────────────────────────────
    if (opts.saveBaseline) {
      const baselineData = {
        high: result.bySeverity.high,
        medium: result.bySeverity.medium,
        low: result.bySeverity.low,
        total: result.totalViolations,
        timestamp: new Date().toISOString(),
        rulesChecked: result.rulesChecked,
      };
      const baselinePath = path.resolve(opts.saveBaseline);
      await fs.mkdir(path.dirname(baselinePath), { recursive: true });
      await fs.writeFile(
        baselinePath,
        JSON.stringify(baselineData, null, 2) + "\n",
      );
      console.log(chalk.green(`\n  ✓ Baseline saved → ${baselinePath}`));
      console.log(
        chalk.gray(
          `    high=${baselineData.high} medium=${baselineData.medium} low=${baselineData.low} total=${baselineData.total}\n`,
        ),
      );
      return;
    }

    // ── --format json (13.8 fix: write synchronously to avoid redirect truncation) ──
    if (opts.format === "json") {
      const output = JSON.stringify(result, null, 2) + "\n";
      process.stdout.write(output);
      if (result.totalViolations > 0) process.exitCode = 1;
      return;
    }

    // ── --baseline comparison (13.5) ───────────────────────────────────────
    let baseline:
      | {
          high: number;
          medium: number;
          low: number;
          total: number;
          timestamp?: string;
        }
      | undefined;
    if (opts.baseline) {
      try {
        const raw = await fs.readFile(path.resolve(opts.baseline), "utf-8");
        baseline = JSON.parse(raw);
      } catch {
        console.error(
          chalk.red(`\n  ✗ Could not read baseline: ${opts.baseline}\n`),
        );
        process.exitCode = 2;
        return;
      }
    }

    // ── CI report table (shown when baseline is provided) ─────────────────
    if (baseline) {
      const cur = result.bySeverity;
      const bl = baseline;
      const deltaHigh = cur.high - bl.high;
      const deltaMed = cur.medium - bl.medium;
      const deltaLow = cur.low - bl.low;
      const deltaTotal = result.totalViolations - bl.total;

      const fmtDelta = (n: number) =>
        n === 0
          ? chalk.gray("0")
          : n > 0
            ? chalk.red(`+${n}`)
            : chalk.green(`${n}`);
      const pad = (s: string | number, w: number) => String(s).padStart(w);

      console.log();
      console.log(
        "  ╔══════════════════════════════════════════════════════════╗",
      );
      console.log(
        "  ║  IntentWeave Semantic Rules — CI Report                 ║",
      );
      console.log(
        "  ╠══════════════════════════════════════════════════════════╣",
      );
      console.log(`  ║  Rules checked: ${result.rulesChecked}`);
      console.log(`  ║  Severity    Current   Baseline    Delta`);
      console.log(`  ║  ──────────  ────────  ────────  ──────────`);
      console.log(
        `  ║  HIGH        ${pad(cur.high, 6)}    ${pad(bl.high, 6)}   ${fmtDelta(deltaHigh)}`,
      );
      console.log(
        `  ║  MEDIUM      ${pad(cur.medium, 6)}    ${pad(bl.medium, 6)}   ${fmtDelta(deltaMed)}`,
      );
      console.log(
        `  ║  LOW         ${pad(cur.low, 6)}    ${pad(bl.low, 6)}   ${fmtDelta(deltaLow)}`,
      );
      console.log(
        `  ║  TOTAL       ${pad(result.totalViolations, 6)}    ${pad(bl.total, 6)}   ${fmtDelta(deltaTotal)}`,
      );
      if (result.byRule && Object.keys(result.byRule).length > 0) {
        console.log("  ║");
        console.log("  ║  Per-rule breakdown:");
        for (const [ruleId, count] of Object.entries(result.byRule).sort()) {
          console.log(`  ║    ${ruleId}: ${count}`);
        }
      }
      console.log(
        "  ╚══════════════════════════════════════════════════════════╝",
      );
      console.log();

      if (opts.failOnIncrease) {
        const sevThreshold = opts.severity as "high" | "medium" | "low";
        const checkSeverities: Array<"high" | "medium" | "low"> =
          sevThreshold === "high"
            ? ["high"]
            : sevThreshold === "medium"
              ? ["high", "medium"]
              : ["high", "medium", "low"];

        const violations = checkSeverities.filter(
          (s) => result.bySeverity[s] > (baseline as any)[s],
        );
        if (violations.length > 0) {
          for (const sev of violations) {
            const delta = result.bySeverity[sev] - (baseline as any)[sev];
            console.log(
              chalk.red(
                `  ❌ GATE FAILED — ${sev.toUpperCase()} violations increased: ${(baseline as any)[sev]} → ${result.bySeverity[sev]} (+${delta})`,
              ),
            );
          }
          // Print the new violations for context
          const newViolations = result.violations.filter((v) =>
            checkSeverities.includes(v.ruleSeverity),
          );
          if (newViolations.length > 0) {
            console.log();
            for (const v of newViolations.slice(0, 20)) {
              const loc = v.line != null ? `:${v.line}` : "";
              const colorFn = SEVERITY_COLOR[v.ruleSeverity] ?? chalk.white;
              console.log(
                `  ${colorFn(`[${v.ruleId}]`)} ${chalk.cyan(v.filePath + loc)}`,
              );
              console.log(`    ${chalk.white(v.detail)}`);
            }
          }
          console.log();
          process.exitCode = 1;
          return;
        }
        const scopeLabel =
          sevThreshold !== "low"
            ? ` ${sevThreshold.toUpperCase()}-severity`
            : "";
        console.log(
          chalk.green(
            `  ✅ GATE PASSED — no new${scopeLabel} violations (current: ${result.bySeverity[sevThreshold === "low" ? "high" : sevThreshold]}, baseline: ${(baseline as any)[sevThreshold === "low" ? "high" : sevThreshold]})`,
          ),
        );
        console.log();
        return;
      }
      // baseline shown but no fail-on-increase — fall through to violation list
    }

    if (result.violations.length === 0) {
      const scope = changed ? ` (${changed.length} changed file(s))` : "";
      // §17.4 ASCII conformance diagram
      if (opts.diagram !== false) {
        const diagram = renderAsciiConformanceDiagram(
          config,
          result,
          opts.ruleId,
        );
        if (diagram) process.stdout.write(diagram);
      }
      console.log(
        chalk.green(
          `  ✓ No semantic rule violations found${scope}. (${result.rulesChecked} rule(s) checked)\n`,
        ),
      );
      return;
    }

    console.log(
      chalk.red(`\n  ✗ ${result.totalViolations} semantic rule violation(s)\n`),
    );

    // §17.4 ASCII conformance diagram
    if (opts.diagram !== false) {
      const diagram = renderAsciiConformanceDiagram(
        config,
        result,
        opts.ruleId,
      );
      if (diagram) process.stdout.write(diagram);
    }

    // Group violations by domain, then by ruleId
    const DOMAIN_LABEL: Record<string, string> = {
      structural: "Structural",
      behavioral: "Behavioral",
      documentary: "Documentary",
    };

    const byDomain = new Map<string, typeof result.violations>();
    for (const v of result.violations) {
      const domain = v.ruleDomain ?? "structural";
      const arr = byDomain.get(domain) ?? [];
      arr.push(v);
      byDomain.set(domain, arr);
    }

    for (const domain of ["structural", "behavioral", "documentary"]) {
      const domainViolations = byDomain.get(domain);
      if (!domainViolations?.length) continue;

      console.log(chalk.bold(`  ── ${DOMAIN_LABEL[domain]} domain ──`));

      const grouped = new Map<string, typeof result.violations>();
      for (const v of domainViolations) {
        const arr = grouped.get(v.ruleId) ?? [];
        arr.push(v);
        grouped.set(v.ruleId, arr);
      }

      for (const [ruleId, violations] of grouped) {
        const first = violations[0];
        const sev = first.ruleSeverity.toUpperCase();
        const colorFn = SEVERITY_COLOR[first.ruleSeverity] ?? chalk.white;
        const adrStr = first.adr ? ` (${first.adr})` : "";
        const modeTag =
          first.ruleMode === "warn" ? chalk.yellow(" [WARN]") : "";
        console.log(colorFn(`  Rule: ${ruleId}${adrStr} [${sev}]`) + modeTag);
        if (first.ruleDescription) {
          console.log(chalk.gray(`  ${first.ruleDescription}`));
        }
        console.log(chalk.gray("  " + "─".repeat(60)));

        for (const v of violations) {
          const loc = v.line != null ? `:${v.line}` : "";
          const confStr =
            v.confidence != null && v.confidence < 1.0
              ? chalk.gray(` [conf ${Math.round(v.confidence * 100)}%]`)
              : "";
          console.log(
            `  ${chalk.cyan(v.filePath + loc).padEnd(55)} ${chalk.white(v.detail)}${confStr}`,
          );
          // 15.5 autofix hint
          if (v.autofix) {
            console.log(chalk.gray(`    → Fix: ${v.autofix.hint}`));
            if (v.autofix.reference) {
              console.log(chalk.gray(`      See: ${v.autofix.reference}`));
            }
          }
        }
        console.log();
      }
    }

    if (result.totalViolations > result.violations.length) {
      console.log(
        chalk.gray(
          `  ...showing ${result.violations.length} of ${result.totalViolations} total violations. Increase --limit to see more.\n`,
        ),
      );
    }

    // Only exit non-zero if there are error-mode violations (warn-only → pass)
    const hasErrorViolations = result.violations.some(
      (v) => (v.ruleMode ?? "error") === "error",
    );

    // Show config.yaml threshold context when they are active
    const docCfg = iwConfig?.thresholds?.documentary;
    if (docCfg && opts.format !== "json") {
      const notes: string[] = [];
      if (docCfg.coverage_min !== undefined)
        notes.push(`coverage_min=${docCfg.coverage_min}%`);
      if (docCfg.completeness_min !== undefined)
        notes.push(`completeness_min=${docCfg.completeness_min}%`);
      if (docCfg.mode)
        notes.push(`mode=${docCfg.mode}`);
      if (notes.length) {
        console.log(
          chalk.gray(`  config.yaml documentary thresholds: ${notes.join(", ")}\n`),
        );
      }
    }

    if (hasErrorViolations) {
      process.exitCode = 1;
    } else if (result.totalViolations > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ All violations are mode:warn — CI gate passed (warnings only)\n`,
        ),
      );
    }
  });

// ── iw index deprecated-callers ─────────────────────────────────

const indexDeprecatedCallersSubcommand = new Command("deprecated-callers")
  .description("Find active callers of @deprecated symbols (14.1)")
  .option("--db <path>", "Path to index.db")
  .option(
    "--changed <files>",
    "Comma-separated list of changed files (incremental CI mode)",
  )
  .option("-n, --limit <n>", "Maximum caller entries to report", "200")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .option("--fail-on-any", "Exit with code 1 if any callers found (CI gate)")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const changed = opts.changed
      ? opts.changed
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined;

    const result = deprecatedCallers(dbPath, {
      changed,
      limit: parseInt(opts.limit, 10),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      if (opts.failOnAny && result.totalCallers > 0) process.exitCode = 1;
      return;
    }

    if (result.callers.length === 0) {
      const scope = changed ? ` (${changed.length} file(s) checked)` : "";
      console.log(
        chalk.green(
          `\n  ✓ No active callers of @deprecated symbols${scope}. (${result.deprecatedSymbols} deprecated symbol(s) indexed)\n`,
        ),
      );
      return;
    }

    console.log(
      chalk.yellow(
        `\n  ⚠ ${result.totalCallers} caller(s) of ${result.symbolsWithCallers} @deprecated symbol(s):\n`,
      ),
    );

    for (const sym of result.callers) {
      const note = sym.deprecatedNote
        ? chalk.gray(` — ${sym.deprecatedNote}`)
        : "";
      console.log(
        chalk.bold(`  ${sym.symbolName}`) + chalk.gray(` [deprecated]`) + note,
      );
      console.log(
        chalk.gray(`    Defined in: ${sym.symbolFile}:${sym.symbolLine}`),
      );
      console.log(chalk.gray("    Called from:"));
      for (const caller of sym.callers) {
        const loc = caller.callerLine != null ? `:${caller.callerLine}` : "";
        const fn = caller.callerName ? ` (in ${caller.callerName})` : "";
        console.log(
          `      ${chalk.cyan(caller.callerFile + loc)}${chalk.gray(fn)}`,
        );
      }
      console.log();
    }

    if (opts.failOnAny) process.exitCode = 1;
  });

// ── iw index internal-violations ────────────────────────────────

const indexInternalViolationsSubcommand = new Command("internal-violations")
  .description(
    "Detect @internal / _prefix symbols imported across package boundaries (14.2)",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "--changed <files>",
    "Comma-separated list of changed files (incremental CI mode)",
  )
  .option("--no-jsdoc", "Skip @internal JSDoc enforcement")
  .option("--no-underscore", "Skip _prefix convention enforcement")
  .option("-n, --limit <n>", "Maximum violations to report", "200")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const changed = opts.changed
      ? opts.changed
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined;

    const result = internalViolations(dbPath, {
      checkJsDoc: opts.jsdoc !== false,
      checkUnderscore: opts.underscore !== false,
      changed,
      limit: parseInt(opts.limit, 10),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      if (result.totalViolations > 0) process.exitCode = 1;
      return;
    }

    if (result.violations.length === 0) {
      const scope = changed ? ` (${changed.length} file(s) checked)` : "";
      console.log(
        chalk.green(
          `\n  ✓ No @internal / _prefix boundary violations${scope}.\n`,
        ),
      );
      return;
    }

    const jsdocCount = result.byMarker.jsdoc;
    const underscoreCount = result.byMarker.underscore;
    const summary = [
      jsdocCount > 0 ? `${jsdocCount} @internal` : null,
      underscoreCount > 0 ? `${underscoreCount} _prefix` : null,
    ]
      .filter(Boolean)
      .join(", ");

    console.log(
      chalk.red(
        `\n  ✗ ${result.totalViolations} boundary violation(s) [${summary}]:\n`,
      ),
    );

    for (const v of result.violations) {
      const tag =
        v.marker === "jsdoc"
          ? chalk.yellow("@internal")
          : chalk.yellow("_prefix");
      console.log(
        `  ${chalk.bold(v.symbolName)} ${tag}  ${chalk.gray(`(${v.symbolFile}:${v.symbolLine})`)}`,
      );
      console.log(
        `    ${chalk.gray("imported by:")} ${chalk.cyan(v.importerFile)}`,
      );
      console.log(
        chalk.gray(`    packages: ${v.symbolPackage} → ${v.importerPackage}`),
      );
      console.log();
    }

    process.exitCode = 1;
  });

// ── iw index type-assertions ─────────────────────────────────

const indexTypeAssertionsSubcommand = new Command("type-assertions")
  .description(
    "Inventory type assertion patterns: `as any`, double casts, and angle-bracket casts (14.3)",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "--kind <kind>",
    "Filter by kind: as_any | double_cast | angle_cast | as_cast",
  )
  .option("--risk-sort", "Sort by file fan-in (highest risk first)")
  .option("-n, --limit <n>", "Maximum results", "100")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = typeAssertions(dbPath, {
      kind: opts.kind as
        | "as_any"
        | "double_cast"
        | "angle_cast"
        | "as_cast"
        | undefined,
      riskSort: opts.riskSort ?? false,
      limit: parseInt(opts.limit, 10),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.total === 0) {
      console.log(chalk.green("\n  ✓ No type assertions found.\n"));
      return;
    }

    const kindLabel = (k: string): string => {
      if (k === "as_any") return chalk.red("as any");
      if (k === "double_cast") return chalk.yellow("double cast");
      if (k === "angle_cast") return chalk.yellow("angle cast");
      return chalk.gray("as cast");
    };

    console.log(
      chalk.blue(
        `\n  ▸ ${result.total} type assertion(s) found  ` +
          `[as_any: ${result.byKind.as_any}  double: ${result.byKind.double_cast}  angle: ${result.byKind.angle_cast}  cast: ${result.byKind.as_cast}]`,
      ),
    );

    if (result.highRisk.length > 0) {
      console.log(
        chalk.red(
          `\n  High-risk (high fan-in files): ${result.highRisk.length}\n`,
        ),
      );
    }

    let lastFile = "";
    for (const a of result.assertions) {
      if (a.file !== lastFile) {
        console.log(chalk.cyan(`\n  ${a.file}`));
        lastFile = a.file;
      }
      const ctx = a.context ? chalk.gray(` in ${a.context}`) : "";
      const type = a.targetType ? chalk.gray(` → ${a.targetType}`) : "";
      const risk = (a.fanIn ?? 0) >= 5 ? chalk.red(" ★") : "";
      console.log(
        `    ${String(a.line).padStart(4)}  ${kindLabel(a.kind)}${type}${ctx}${risk}`,
      );
    }
    console.log();
  });

// ── iw index test-intent ────────────────────────────────────────

const indexTestIntentSubcommand = new Command("test-intent")
  .description("Find stale test descriptions and orphaned test files (14.6)")
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "50")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = testIntent(dbPath, {
      limit: parseInt(opts.limit, 10),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.staleCount === 0 && result.orphanedFiles.length === 0) {
      console.log(
        chalk.green(
          "\n  ✓ No stale test descriptions or orphaned files found.\n",
        ),
      );
      return;
    }

    console.log(
      chalk.blue(`\n  ▸ ${result.total} test description(s) analyzed`),
    );

    if (result.staleCount > 0) {
      console.log(
        chalk.yellow(`\n  Stale test descriptions (${result.staleCount}):\n`),
      );

      let lastFile = "";
      for (const test of result.staleTests) {
        if (test.file !== lastFile) {
          console.log(chalk.cyan(`  ${test.file}`));
          lastFile = test.file;
        }
        const kindLabel =
          test.kind === "describe"
            ? chalk.blue("describe")
            : test.kind === "it"
              ? chalk.cyan("it")
              : chalk.green("test");
        console.log(
          `    ${String(test.line).padStart(4)}  ${kindLabel}  "${test.description}"`,
        );
        console.log(
          `           ✗ missing symbol: ${chalk.red(test.missingSymbol)}`,
        );
      }
    }

    if (result.orphanedFiles.length > 0) {
      console.log(
        chalk.red(
          `\n  Orphaned test files (${result.orphanedFiles.length}):\n`,
        ),
      );
      for (const file of result.orphanedFiles) {
        console.log(`    ${file}`);
      }
    }

    console.log();
  });

// ── iw index rules-trend ─────────────────────────────────────

const indexRulesTrendSubcommand = new Command("rules-trend")
  .description("Show ADR conformance trend from historical snapshots (14.5)")
  .option("--db <path>", "Path to index.db")
  .option("--days <n>", "Time window in days", "30")
  .option("--rule-id <id>", "Filter to a specific rule id")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = rulesTrend(dbPath, {
      days: parseInt(opts.days, 10),
      ruleId: opts.ruleId,
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.rules.length === 0) {
      console.log(
        chalk.gray(
          `\n  No conformance snapshots found in the last ${result.days} days.\n` +
            `  Snapshots are recorded automatically after each \`iw index build\`.\n`,
        ),
      );
      return;
    }

    console.log(
      chalk.blue(`\n  ▸ ADR conformance trend (last ${result.days} days)\n`),
    );

    for (const rule of result.rules) {
      const trendIcon =
        rule.trend === "improving"
          ? chalk.green("↑")
          : rule.trend === "worsening"
            ? chalk.red("↓")
            : rule.trend === "stable"
              ? chalk.gray("→")
              : chalk.gray("?");

      const adr = rule.adr ? chalk.gray(` [${rule.adr}]`) : "";
      console.log(
        `  ${trendIcon} ${chalk.bold(rule.ruleId)}${adr}  ${chalk.gray(`(${rule.snapshots.length} snapshot(s))`)}`,
      );

      const last = rule.snapshots[rule.snapshots.length - 1];
      if (last) {
        const pct = last.conformancePct.toFixed(1);
        const viol = last.violationCount;
        const date = new Date(last.timestamp).toLocaleDateString();
        console.log(
          chalk.gray(
            `      Latest (${date}): ${pct}% conformance  ${viol} violation(s)`,
          ),
        );
      }

      // ASCII trend bars (last 7 snapshots)
      const recent = rule.snapshots.slice(-7);
      if (recent.length > 1) {
        const bars = recent.map((s) => {
          const pct = s.conformancePct;
          const bar = pct >= 90 ? "█" : pct >= 70 ? "▆" : pct >= 50 ? "▄" : "▂";
          return pct >= 90
            ? chalk.green(bar)
            : pct >= 70
              ? chalk.yellow(bar)
              : chalk.red(bar);
        });
        console.log(`      ${bars.join("")}`);
      }
      console.log();
    }
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
        const isCanonical =
          v.text === inc.symbolName ? chalk.green(" ← canonical") : "";
        console.log(
          `      "${v.text}" × ${v.count} (avg conf: ${v.avgConfidence})${isCanonical}`,
        );
      }
    }
    console.log();
  });

// ── iw index dep-depth ────────────────────────────────────────

const indexDepDepthSubcommand = new Command("dep-depth")
  .description(
    "Compute transitive import depth per file — flag excessive fan-in/fan-out",
  )
  .option("--db <path>", "Path to index.db")
  .option("-n, --limit <n>", "Maximum results", "20")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = dependencyDepth(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalFiles === 0) {
      console.log(
        chalk.gray(
          "\n  No import graph data available. Ensure the index is built.\n",
        ),
      );
      return;
    }

    const limit = parseInt(opts.limit, 10);
    const items = result.files.slice(0, limit);

    console.log(
      chalk.blue(
        `\n  ▸ ${result.totalFiles} files in import graph (${result.highRiskCount} high/critical risk)`,
      ),
    );
    console.log(
      chalk.gray(
        "    File                                         DirDep  TransDep  DirIn  TransIn  Depth  Risk",
      ),
    );

    const riskColor = (r: string) =>
      r === "critical"
        ? chalk.red(r)
        : r === "high"
          ? chalk.yellow(r)
          : r === "medium"
            ? chalk.cyan(r)
            : chalk.gray(r);

    for (const f of items) {
      const name =
        f.filePath.length > 46
          ? "…" + f.filePath.slice(f.filePath.length - 45)
          : f.filePath;
      console.log(
        `    ${name.padEnd(48)} ${String(f.directDependencies).padStart(5)} ${String(f.transitiveDependencies).padStart(9)} ${String(f.directDependents).padStart(6)} ${String(f.transitiveDependents).padStart(8)} ${String(f.maxDepth).padStart(6)}  ${riskColor(f.risk)}`,
      );
    }
    console.log();
  });

// ── iw index boundary-violations ──────────────────────────────

const indexBoundaryViolationsSubcommand = new Command("boundary-violations")
  .description(
    "Detect when files import from another package's internal modules",
  )
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = boundaryViolations(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.totalViolations === 0) {
      console.log(
        chalk.green("\n  ✓ No package boundary violations detected.\n"),
      );
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ ${result.totalViolations} package boundary violation${result.totalViolations === 1 ? "" : "s"}`,
      ),
    );

    if (result.byPackagePair.length > 0) {
      console.log(chalk.gray("\n    Summary by package pair:"));
      for (const pair of result.byPackagePair) {
        console.log(
          `    ${pair.sourcePackage} → ${pair.targetPackage}: ${pair.count} violation${pair.count === 1 ? "" : "s"}`,
        );
      }
    }

    console.log(chalk.gray("\n    Details:"));
    for (const v of result.violations) {
      console.log(`    ${chalk.yellow("⚠")} ${v.sourceFile} → ${v.targetFile}`);
      console.log(chalk.gray(`      ${v.reason}`));
    }
    console.log();
  });

// ── iw index layers-infer ─────────────────────────────────────

const indexLayersInferSubcommand = new Command("layers-infer")
  .description("Auto-infer architectural layers from the import graph topology")
  .option("--db <path>", "Path to index.db")
  .option(
    "-o, --output <path>",
    "Write layers.yaml to this path (default: .iw/layers.yaml)",
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .option(
    "--hierarchical",
    "Two-level inference: macro layers at package boundary, sub-layers within packages",
  )
  .option(
    "--scope <path>",
    "Scope inference to a single package directory (e.g., packages/analyzer)",
  )
  .option(
    "--min-files <n>",
    "Minimum files for a package to get sub-layers (hierarchical mode)",
    "10",
  )
  .option(
    "--from-decorators",
    "Use decorator metadata instead of import graph (14.4)",
  )
  .option(
    "--preset <preset>",
    "Decorator preset when --from-decorators is used: nestjs | angular | spring",
    "nestjs",
  )
  .option(
    "--write",
    "Write inferred layers to .iw/layers.yaml (--from-decorators mode)",
  )
  .action(async (opts) => {
    const dbPath = resolveDbPath(opts.db);

    // ── from-decorators mode (14.4) ──
    if (opts.fromDecorators) {
      const result = layersFromDecorators(dbPath, {
        preset: opts.preset as "nestjs" | "angular" | "spring",
        writeYaml: opts.write,
        workspaceRoot: process.cwd(),
      });

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.assignments.length === 0) {
        console.log(
          chalk.gray(
            `\n  No decorated symbols found. Make sure the index was built after adding decorator support.\n`,
          ),
        );
        return;
      }

      console.log(
        chalk.blue(
          `\n  ▸ Decorator-derived layers (preset: ${result.preset})  —  ${result.totalSymbols} symbol(s)\n`,
        ),
      );

      for (const [layerNum, layerDef] of Object.entries(result.layers)) {
        console.log(
          chalk.cyan(
            `  Layer ${layerNum}: ${layerDef.name}  (${layerDef.files.length} file(s))`,
          ),
        );
        const decoratorList = layerDef.decorators
          .slice(0, 6)
          .map((d) => `@${d}`)
          .join(", ");
        console.log(chalk.gray(`    decorators: ${decoratorList}`));
        for (const f of layerDef.files.slice(0, 6)) {
          console.log(chalk.gray(`    ${f}`));
        }
        if (layerDef.files.length > 6) {
          console.log(
            chalk.gray(`    … and ${layerDef.files.length - 6} more`),
          );
        }
      }

      if (opts.write) {
        console.log(chalk.green(`\n  ✓ Wrote .iw/layers.yaml\n`));
      }
      return;
    }

    const options = {
      hierarchical: opts.hierarchical ?? false,
      scope: opts.scope,
      minFilesForSubLayers: parseInt(opts.minFiles, 10),
    };
    const result = layersInfer(dbPath, options);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.layers.length === 0) {
      console.log(
        chalk.gray(
          "\n  No import graph data available. Ensure the index is built.\n",
        ),
      );
      return;
    }

    const modeLabel = options.hierarchical
      ? "hierarchical"
      : options.scope
        ? `scoped (${options.scope})`
        : "flat";
    console.log(
      chalk.blue(
        `\n  ▸ ${result.layers.length} layers inferred from ${result.totalFiles} files (${modeLabel})`,
      ),
    );

    for (const layer of result.layers) {
      const pkgInfo =
        layer.packages && layer.packages.length > 0
          ? ` [${layer.packages.join(", ")}]`
          : "";
      console.log(
        chalk.cyan(
          `\n    Layer ${layer.index}: ${layer.label} (${layer.files.length} files, depth ${layer.depthRange[0]}–${layer.depthRange[1]})${pkgInfo}`,
        ),
      );
      const display = layer.files.slice(0, 8);
      for (const f of display) {
        console.log(chalk.gray(`      ${f}`));
      }
      if (layer.files.length > 8) {
        console.log(chalk.gray(`      … and ${layer.files.length - 8} more`));
      }

      // Show sub-layers in hierarchical mode
      if (layer.subLayers && layer.subLayers.length > 0) {
        // Group by package
        const byPkg = new Map<string, typeof layer.subLayers>();
        for (const sub of layer.subLayers) {
          if (!byPkg.has(sub.package)) byPkg.set(sub.package, []);
          byPkg.get(sub.package)!.push(sub);
        }
        for (const [pkg, subs] of byPkg) {
          console.log(chalk.white(`\n      Sub-layers in ${pkg}:`));
          for (const sub of subs) {
            console.log(
              chalk.gray(
                `        ${sub.index}: ${sub.label} (${sub.files.length} files, depth ${sub.depthRange[0]}–${sub.depthRange[1]})`,
              ),
            );
          }
        }
      }
    }

    if (result.isolatedFiles.length > 0) {
      console.log(
        chalk.yellow(
          `\n    ${result.isolatedFiles.length} isolated file(s) not in any layer`,
        ),
      );
    }

    // Write YAML if requested
    const outputPath =
      opts.output ?? path.join(process.cwd(), ".iw", "layers.yaml");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.yaml, "utf-8");
    console.log(chalk.green(`\n  ✓ Wrote ${outputPath}`));
    console.log(
      chalk.gray(
        "    Review and edit, then run `iw index layers-check` to validate.\n",
      ),
    );
  });

// ── iw index layers-check ─────────────────────────────────────

const indexLayersCheckSubcommand = new Command("layers-check")
  .description(
    "Validate imports against .iw/layers.yaml — detect reverse and skip-layer violations",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "-c, --config <path>",
    "Path to layers.yaml (default: .iw/layers.yaml)",
  )
  .option("--allow-skip-layer", "Ignore skip-layer violations", false)
  .option(
    "--compare",
    "Compare inferred (as-is) vs. configured (as-should) layers",
    false,
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action(async (opts) => {
    const dbPath = resolveDbPath(opts.db);
    const configPath =
      opts.config ?? path.join(process.cwd(), ".iw", "layers.yaml");

    // Load layer config
    const { readFile } = await import("node:fs/promises");
    let configContent: string;
    try {
      configContent = await readFile(configPath, "utf-8");
    } catch {
      console.error(
        chalk.red(
          `\n  ✗ Layer config not found at ${configPath}.\n    Run \`iw index layers-infer\` first to generate one.\n`,
        ),
      );
      process.exit(1);
    }

    // Parse YAML (simple parser — layers.yaml has a known structure)
    let config: LayerConfig;
    try {
      config = parseLayersYaml(configContent);
    } catch (err: any) {
      console.error(
        chalk.red(`\n  ✗ Failed to parse ${configPath}: ${err.message}\n`),
      );
      process.exit(1);
    }

    if (opts.allowSkipLayer) {
      config.allowSkipLayer = true;
    }

    // ── Compare mode (5.6) ──────────────────────────────────────
    if (opts.compare) {
      const compareResult = layersCompare(dbPath, config);

      if (opts.format === "json") {
        console.log(JSON.stringify(compareResult, null, 2));
        return;
      }

      console.log(chalk.blue("\n  ▸ As-Is vs. As-Should Layer Comparison\n"));

      // Column widths
      const maxFile = Math.max(
        4,
        ...compareResult.entries.map((e) => e.file.length),
      );
      const maxInferred = Math.max(
        8,
        ...compareResult.entries.map((e) => (e.inferredLayer ?? "—").length),
      );
      const maxConfigured = Math.max(
        10,
        ...compareResult.entries.map((e) => (e.configuredLayer ?? "—").length),
      );

      // Header
      const header = `    ${"File".padEnd(maxFile)}  ${"Inferred".padEnd(maxInferred)}  ${"Configured".padEnd(maxConfigured)}  Status`;
      console.log(chalk.gray(header));
      console.log(chalk.gray("    " + "─".repeat(header.length - 4)));

      for (const entry of compareResult.entries) {
        const file = entry.file.padEnd(maxFile);
        const inf = (entry.inferredLayer ?? "—").padEnd(maxInferred);
        const cfg = (entry.configuredLayer ?? "—").padEnd(maxConfigured);

        let statusIcon: string;
        if (entry.status === "ok") {
          statusIcon = chalk.green("✓ OK");
        } else if (entry.status === "drift") {
          statusIcon = chalk.yellow("⚠ DRIFT");
        } else {
          statusIcon = chalk.gray("? UNASSIGNED");
        }

        console.log(`    ${file}  ${inf}  ${cfg}  ${statusIcon}`);
      }

      // Summary
      console.log();
      console.log(
        chalk.gray(
          `    ${compareResult.totalFiles} file(s): ` +
            chalk.green(`${compareResult.matchCount} OK`) +
            `, ` +
            (compareResult.driftCount > 0
              ? chalk.yellow(`${compareResult.driftCount} drift`)
              : `${compareResult.driftCount} drift`) +
            `, ` +
            `${compareResult.unassignedCount} unassigned`,
        ),
      );
      console.log();
      return;
    }

    const result = layersCheck(dbPath, config);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Layer summary
    console.log(chalk.blue("\n  ▸ Layer Architecture Summary"));
    for (const ls of result.layerSummary) {
      console.log(
        chalk.gray(
          `    Layer ${ls.index}: ${ls.name.padEnd(24)} ${ls.fileCount} file(s)`,
        ),
      );
    }

    if (result.totalViolations === 0) {
      console.log(
        chalk.green(
          "\n  ✓ No layer violations — all imports respect the architecture.\n",
        ),
      );
      return;
    }

    console.log(
      chalk.yellow(
        `\n  ⚠ ${result.totalViolations} violation(s): ${result.byType.reverse} reverse, ${result.byType.skipLayer} skip-layer`,
      ),
    );

    for (const v of result.violations) {
      const icon = v.type === "reverse" ? chalk.red("↑") : chalk.yellow("⤴");
      console.log(`    ${icon} ${v.sourceFile} → ${v.targetFile}`);
      console.log(chalk.gray(`      ${v.reason}`));
    }
    console.log();
  });

/**
 * Parse a simple layers.yaml config.
 * Expected format:
 *   layers:
 *     - name: "core"
 *       patterns:
 *         - "packages/core/**"
 *     - name: "server"
 *       patterns:
 *         - "packages/server/**"
 */
function parseLayersYaml(content: string): LayerConfig {
  const layers: LayerConfig["layers"] = [];
  const allowed: Array<{ from: string; to: string }> = [];
  let currentLayer: LayerConfig["layers"][number] | null = null;
  let inPatterns = false;
  let inAllowed = false;
  let currentAllowed: Partial<{ from: string; to: string }> | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    // Top-level "allowed:" section
    if (line === "allowed:" || line === "allowed: []") {
      if (currentLayer) {
        layers.push(currentLayer);
        currentLayer = null;
      }
      inPatterns = false;
      inAllowed = true;
      continue;
    }

    // Top-level "layers:" section
    if (line === "layers:" || line === "layers: []") {
      if (currentAllowed?.from && currentAllowed?.to) {
        allowed.push({ from: currentAllowed.from, to: currentAllowed.to });
        currentAllowed = null;
      }
      inAllowed = false;
      continue;
    }

    // Inside allowed: section — parse "- from: X" / "to: Y" pairs
    if (inAllowed) {
      const fromMatch = line.match(/^-?\s*from:\s*["']?([^"'\n]+?)["']?\s*$/);
      if (fromMatch) {
        if (currentAllowed?.from && currentAllowed?.to) {
          allowed.push({ from: currentAllowed.from, to: currentAllowed.to });
        }
        currentAllowed = { from: fromMatch[1] };
        continue;
      }
      const toMatch = line.match(/^to:\s*["']?([^"'\n]+?)["']?\s*$/);
      if (toMatch && currentAllowed) {
        currentAllowed.to = toMatch[1];
        if (currentAllowed.from) {
          allowed.push({ from: currentAllowed.from, to: currentAllowed.to });
          currentAllowed = null;
        }
        continue;
      }
      // Inline "- { from: X, to: Y }" or "- from: X to: Y" style
      const inlineMatch = line.match(
        /from:\s*["']?([^"',\s]+?)["']?[,\s]+to:\s*["']?([^"',}\s]+?)["']?/,
      );
      if (inlineMatch) {
        allowed.push({ from: inlineMatch[1], to: inlineMatch[2] });
        continue;
      }
      continue;
    }

    // Detect "- name:" which starts a new layer
    const nameMatch = line.match(/^-\s*name:\s*["']?([^"'\n]+?)["']?\s*$/);
    if (nameMatch) {
      if (currentLayer) layers.push(currentLayer);
      currentLayer = { name: nameMatch[1], patterns: [] };
      inPatterns = false;
      continue;
    }

    // Detect "name:" without leading dash (alternative format)
    const plainNameMatch = line.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/);
    if (plainNameMatch && !line.startsWith("-")) {
      if (currentLayer) layers.push(currentLayer);
      currentLayer = { name: plainNameMatch[1], patterns: [] };
      inPatterns = false;
      continue;
    }

    const rowMatch = line.match(/^row:\s*(-?\d+)\s*$/);
    if (rowMatch && currentLayer) {
      currentLayer.row = parseInt(rowMatch[1], 10);
      continue;
    }

    const columnMatch = line.match(/^column:\s*(-?\d+)\s*$/);
    if (columnMatch && currentLayer) {
      currentLayer.column = parseInt(columnMatch[1], 10);
      continue;
    }

    const colSpanMatch = line.match(/^col_span:\s*(\d+)\s*$/);
    if (colSpanMatch && currentLayer) {
      currentLayer.col_span = Math.max(1, parseInt(colSpanMatch[1], 10));
      continue;
    }

    const rowSpanMatch = line.match(/^row_span:\s*(\d+)\s*$/);
    if (rowSpanMatch && currentLayer) {
      currentLayer.row_span = Math.max(1, parseInt(rowSpanMatch[1], 10));
      continue;
    }

    const sideMatch = line.match(/^side:\s*(left|right)\s*$/);
    if (sideMatch && currentLayer) {
      currentLayer.side = sideMatch[1] as "left" | "right";
      continue;
    }

    if (line === "patterns:" || line === "patterns: []") {
      inPatterns = true;
      continue;
    }

    // Pattern item
    if (inPatterns && currentLayer && line.startsWith("-")) {
      const pattern = line
        .replace(/^-\s*/, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      if (pattern) {
        currentLayer.patterns.push(pattern);
      }
    }
  }

  if (currentAllowed?.from && currentAllowed?.to) {
    allowed.push({ from: currentAllowed.from, to: currentAllowed.to });
  }
  if (currentLayer) layers.push(currentLayer);

  if (layers.length === 0) {
    throw new Error("No layers found in config");
  }

  return { layers, allowed: allowed.length > 0 ? allowed : undefined };
}

// ── iw index arch-check ───────────────────────────────────────────

const indexArchCheckSubcommand = new Command("arch-check")
  .description(
    "Validate code imports against architecture intent (YAML config, enriched diagram triples, or direct diagram scan)",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "-c, --config <path>",
    "Path to architecture.yaml (default: .iw/architecture.yaml)",
  )
  .option(
    "--from-diagrams",
    "Infer architecture config from enriched diagram triples in index.db (requires prior `iw index enrich`)",
    false,
  )
  .option(
    "--from-scan [paths...]",
    "Scan markdown files for diagrams and interpret via LLM directly (no enrichment needed)",
  )
  .option(
    "--provider <name>",
    "LLM provider for --from-scan: openai or smart-mock",
    "smart-mock",
  )
  .option("--model <name>", "LLM model for --from-scan (default: gpt-4o-mini)")
  .option(
    "--api-key <key>",
    "OpenAI API key for --from-scan (overrides OPENAI_API_KEY)",
  )
  .option(
    "--refresh",
    "Re-run LLM scan even if a valid cache exists (for use with --from-scan)",
    false,
  )
  .option(
    "--strict",
    "Fail on undocumented flows (exit code 1 even without violations)",
    false,
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .addHelpText(
    "after",
    `
Architecture YAML schema example (.iw/architecture.yaml):
  components:
    - name: API
      description: HTTP entry-point layer
      files:
        - "src/routes/**"
        - "src/controllers/**"
    - name: Services
      description: Business logic
      files:
        - "src/services/**"
    - name: Data
      description: Database access layer
      files:
        - "src/repositories/**"
        - "src/models/**"
  flows:
    - from: API
      to: Services
    - from: Services
      to: Data

Notes:
  - Use --from-scan <paths> to auto-generate config from Mermaid/ASCII diagrams (requires --provider openai).
  - Use --from-diagrams to infer config from previously enriched diagram triples.
  - Omit --config to auto-discover .iw/architecture.yaml in the current directory.
`,
  )
  .action(async (opts) => {
    const dbPath = resolveDbPath(opts.db);
    let config: ArchConfig | null = null;

    // ── Priority 1: --from-scan — scan diagrams via LLM directly ────────────
    if (opts.fromScan !== undefined) {
      // 5.10: smart-mock cannot interpret diagram content — fail early with a clear message
      if (opts.provider === "smart-mock") {
        console.error(
          chalk.red(
            "\n  ✗ arch-check --from-scan requires a real LLM provider.\n" +
              "    smart-mock cannot interpret diagram content.\n" +
              "    Configure a provider: --provider openai\n",
          ),
        );
        process.exitCode = 2;
        return;
      }

      const scanPaths: string[] =
        Array.isArray(opts.fromScan) && opts.fromScan.length > 0
          ? opts.fromScan
          : typeof opts.fromScan === "string"
            ? [opts.fromScan]
            : ["."];

      if (opts.format !== "json") {
        console.log(
          chalk.blue("\n  ▸ Architecture Diagram Validation (--from-scan)\n"),
        );
      }

      config = await buildArchConfigFromDiagrams({
        paths: scanPaths,
        provider: opts.provider,
        model: opts.model,
        apiKey: opts.apiKey,
        silent: opts.format === "json",
        refresh: opts.refresh ?? false,
      });

      if (!config.components || config.components.length === 0) {
        console.error(
          chalk.red(
            "\n  ✗ No components found in scanned diagrams.\n" +
              "    Check that the scanned paths contain Mermaid or ASCII-art diagrams.\n",
          ),
        );
        process.exit(1);
      }

      // Enrich empty file arrays with inferred globs from the index
      config = enrichArchConfigWithFiles(dbPath, config);

      if (opts.format !== "json") {
        console.log(
          chalk.gray(
            `\n  ▸ Extracted ${config.components.length} components, ${config.flows?.length ?? 0} flows from diagrams\n`,
          ),
        );
      }

      // ── Priority 2: --from-diagrams — use enriched KG triples ───────────────
    } else if (opts.fromDiagrams) {
      config = inferArchConfigFromKg(dbPath, {
        requireDiagramHints: true,
        workspaceRoot: process.cwd(),
      });

      if (!config.components || config.components.length === 0) {
        console.error(
          chalk.red(
            "\n  ✗ No architecture triples found from diagrams.\n    Run `iw index enrich --provider openai` first, or use --from-scan.\n",
          ),
        );
        process.exit(1);
      }

      // ── Priority 3: YAML config (explicit or auto-discovered) ───────────────
    } else {
      const configPath =
        opts.config ?? path.join(process.cwd(), ".iw", "architecture.yaml");

      const { readFile } = await import("node:fs/promises");
      let configContent: string;
      try {
        configContent = await readFile(configPath, "utf-8");
      } catch {
        config = inferArchConfigFromKg(dbPath, {
          requireDiagramHints: true,
          workspaceRoot: process.cwd(),
        });

        if (!config.components || config.components.length === 0) {
          console.error(
            chalk.red(
              `\n  ✗ Architecture config not found at ${configPath}, and no diagram triples were inferred.\n` +
                `    Run --from-scan <paths> to scan diagrams directly, or create .iw/architecture.yaml.\n`,
            ),
          );
          process.exit(1);
        }

        if (opts.format !== "json") {
          console.log(
            chalk.yellow(
              `\n  ⚠ Architecture config not found at ${configPath}; using inferred diagram triples instead.\n`,
            ),
          );
        }
        configContent = "";
      }

      if (configContent) {
        try {
          config = parseArchitectureYaml(configContent);
        } catch (err: any) {
          console.error(
            chalk.red(`\n  ✗ Failed to parse ${configPath}: ${err.message}\n`),
          );
          process.exit(1);
        }
      }
    }

    if (!config) {
      console.error(chalk.red("\n  ✗ Failed to load architecture config.\n"));
      process.exit(1);
    }

    // --from-scan uses entity-level validation; everything else uses file-import validation
    const isEntityMode = opts.fromScan !== undefined;
    const result = isEntityMode
      ? diagramEntityCheck(dbPath, config)
      : archCheck(dbPath, config);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const { summary } = result;
      const entityResult = isEntityMode
        ? (result as ReturnType<typeof diagramEntityCheck>)
        : null;

      if (!isEntityMode) {
        console.log(chalk.blue(`\n  ▸ Architecture Diagram Validation\n`));
      }

      // Component summary
      console.log(chalk.bold("  Components:"));
      for (const c of result.componentSummary) {
        const grounding = entityResult?.entityGrounding.find(
          (g) => g.name === c.name,
        );
        if (grounding) {
          const icon =
            grounding.groundedIn === "none" ? chalk.red("✗") : chalk.green("✓");
          const detail =
            grounding.groundedIn === "none"
              ? "ungrounded"
              : `${grounding.mentionCount} mentions in ${grounding.docCount} doc${grounding.docCount !== 1 ? "s" : ""} (${grounding.groundedIn})`;
          console.log(chalk.gray(`    ${icon} ${c.name}: ${detail}`));
        } else {
          console.log(chalk.gray(`    ${c.name}: ${c.fileCount} files`));
        }
      }
      console.log("");

      // Declared flows
      if (result.flows.length > 0) {
        console.log(chalk.bold("  Declared Flows:"));
        for (const f of result.flows) {
          const icon =
            f.status === "confirmed" ? chalk.green("✓") : chalk.yellow("⚠");
          let status: string;
          if (f.status === "confirmed") {
            if (entityResult) {
              // Show entity-level evidence source
              const evidenceSrc =
                f.evidence[0]?.sourceFile ?? "entity evidence";
              status = `confirmed (${evidenceSrc})`;
            } else {
              status = `confirmed (${f.evidence.length} import${f.evidence.length !== 1 ? "s" : ""})`;
            }
          } else {
            status = entityResult
              ? "MISSING — no co-occurrence or co-annotation evidence found"
              : "MISSING — no direct import path found";
          }
          console.log(`    ${icon} ${f.from} → ${f.to}: ${status}`);
        }
        console.log("");
      }

      // Undocumented flows
      if (result.undocumented.length > 0) {
        const undocLabel = entityResult
          ? "  Undocumented Entity Connections (co-occurring but not declared):"
          : "  Undocumented Flows (not in diagram):";
        console.log(chalk.bold.yellow(undocLabel));
        for (const u of result.undocumented) {
          if (entityResult) {
            const score = u.edges[0]?.sourceFile ?? "";
            console.log(
              `    ${chalk.yellow("~")} ${u.from} ↔ ${u.to}: ${score}`,
            );
          } else {
            console.log(
              `    ${chalk.red("✗")} ${u.from} → ${u.to} (${u.edges.length} import${u.edges.length !== 1 ? "s" : ""})`,
            );
          }
        }
        console.log("");
      }

      // Constraint violations
      if (result.constraintViolations.length > 0) {
        console.log(chalk.bold.red("  Constraint Violations:"));
        for (const v of result.constraintViolations) {
          console.log(
            `    ${chalk.red("✗")} ${v.from} → ${v.to}: ${v.reason} (${v.edges.length} import${v.edges.length !== 1 ? "s" : ""})`,
          );
        }
        console.log("");
      }

      // Summary
      console.log(chalk.bold("  Summary:"));
      if (entityResult) {
        const groundedCount = entityResult.entityGrounding.filter(
          (g) => g.groundedIn !== "none",
        ).length;
        const totalComponents = entityResult.entityGrounding.length;
        console.log(
          `    ${chalk.green("✓")} ${summary.confirmedFlows}/${summary.totalFlows} flows confirmed (entity-level)  ` +
            `${chalk.yellow("⚠")} ${summary.missingFlows} missing  ` +
            `${chalk.yellow("~")} ${summary.undocumentedFlows} undocumented connections`,
        );
        console.log(
          `    Components grounded: ${groundedCount}/${totalComponents}  ` +
            `(${Math.round((groundedCount / Math.max(totalComponents, 1)) * 100)}% coverage)`,
        );
      } else {
        console.log(
          `    ${chalk.green("✓")} ${summary.confirmedFlows}/${summary.totalFlows} flows confirmed  ` +
            `${chalk.yellow("⚠")} ${summary.missingFlows} missing  ` +
            `${chalk.red("✗")} ${summary.undocumentedFlows} undocumented  ` +
            `${chalk.red("!")} ${summary.constraintViolations} constraint violations`,
        );
      }
      console.log(
        `    Architecture conformance: ${summary.conformancePercent}%`,
      );
      console.log("");
    }

    // Exit codes: 2 = constraint violations, 1 = strict + undocumented, 0 = OK
    if (result.constraintViolations.length > 0) {
      process.exit(2);
    } else if (opts.strict && result.undocumented.length > 0) {
      process.exit(1);
    }
  });

// ── iw index conformance ──────────────────────────────────────────

const indexConformanceSubcommand = new Command("conformance")
  .description(
    "Detect interface conformance drift — missing methods, changed signatures across packages",
  )
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = interfaceConformance(dbPath);

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ Interface Conformance Check — ${result.pairsChecked} pair(s) checked\n`,
      ),
    );

    if (result.totalViolations === 0) {
      console.log(
        chalk.green("  ✓ All classes conform to their declared interfaces.\n"),
      );
      return;
    }

    console.log(
      chalk.yellow(
        `  ⚠ ${result.totalViolations} violation(s): ` +
          `${result.byType.missingMethod} missing method(s), ` +
          `${result.byType.missingProperty} missing property/ies, ` +
          `${result.byType.signatureMismatch} signature mismatch(es)\n`,
      ),
    );

    for (const v of result.violations) {
      let icon: string;
      let detail: string;

      switch (v.type) {
        case "missing-method":
          icon = chalk.red("✗");
          detail = `${v.className} is missing method ${chalk.bold(v.memberName)}()`;
          if (v.expectedSignature)
            detail += chalk.gray(` — expected: ${v.expectedSignature}`);
          break;
        case "missing-property":
          icon = chalk.red("✗");
          detail = `${v.className} is missing property ${chalk.bold(v.memberName)}`;
          break;
        case "signature-mismatch":
          icon = chalk.yellow("≠");
          detail = `${v.className}.${chalk.bold(v.memberName)}() signature differs`;
          break;
      }

      console.log(`    ${icon} ${detail}`);
      console.log(
        chalk.gray(
          `      interface ${v.interfaceName} (${v.interfaceFile}) → class ${v.className} (${v.classFile})`,
        ),
      );

      if (v.type === "signature-mismatch") {
        if (v.expectedSignature)
          console.log(chalk.gray(`      expected: ${v.expectedSignature}`));
        if (v.actualSignature)
          console.log(chalk.gray(`      actual:   ${v.actualSignature}`));
      }
    }
    console.log();
  });

// ── iw index dead-features ───────────────────────────────────────

const indexDeadFeaturesSubcommand = new Command("dead-features")
  .description(
    "Detect likely dead features — symbols that are unused, undocumented, and stale",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "--min-signals <n>",
    "Minimum signals to report (1–3). Default: 2",
    "2",
  )
  .option(
    "--staleness <months>",
    "Months without commits to count as stale",
    "6",
  )
  .option("-n, --limit <n>", "Maximum results", "100")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const minSignals = parseInt(opts.minSignals, 10);
    const stalenessMonths = parseInt(opts.staleness, 10);
    const limit = parseInt(opts.limit, 10);

    const result = deadFeatures(dbPath, { minSignals, stalenessMonths, limit });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ Dead Feature Detection — staleness: ${stalenessMonths} months, min signals: ${minSignals}\n`,
      ),
    );

    if (result.totalCandidates === 0) {
      console.log(chalk.green("  ✓ No dead feature candidates found.\n"));
      return;
    }

    const { three, two, one } = result.bySignalCount;
    const parts: string[] = [];
    if (three > 0) parts.push(`${three} with 3 signals`);
    if (two > 0) parts.push(`${two} with 2 signals`);
    if (one > 0) parts.push(`${one} with 1 signal`);
    console.log(
      chalk.yellow(
        `  ⚠ ${result.totalCandidates} candidate(s): ${parts.join(", ")}\n`,
      ),
    );

    for (const c of result.candidates) {
      const signals: string[] = [];
      if (c.unusedExport) signals.push("unused");
      if (c.undocumented) signals.push("undocumented");
      if (c.stale) signals.push("stale");

      const icon =
        c.signalCount === 3
          ? chalk.red("✗✗✗")
          : c.signalCount === 2
            ? chalk.yellow("✗✗ ")
            : chalk.gray("✗  ");

      console.log(
        `    ${icon} ${chalk.bold(c.name)} ${chalk.gray(`(${c.kind})`)} — ${signals.join(", ")}`,
      );
      console.log(chalk.gray(`        ${c.filePath}:${c.line}`));
    }

    if (result.totalCandidates > result.candidates.length) {
      console.log(
        chalk.gray(
          `\n    ...and ${result.totalCandidates - result.candidates.length} more`,
        ),
      );
    }
    console.log();
  });

// ── iw index api-surface ─────────────────────────────────────────

const indexApiSurfaceSubcommand = new Command("api-surface")
  .description(
    "Track exported API changes between git refs — additions, removals, signature changes",
  )
  .option(
    "--baseline <ref>",
    "Git ref to compare against (default: latest tag or HEAD~1)",
  )
  .option("--db <path>", "Path to index.db")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action(async (opts) => {
    const { analyzeApiSurface } = await import("../api-surface/apiSurface.js");
    const dbPath = resolveDbPath(opts.db);
    const result = await analyzeApiSurface({
      baseline: opts.baseline,
      dbPath,
      workspaceRoot: process.cwd(),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ API Surface Changelog — baseline: ${result.baseline}\n`,
      ),
    );

    if (result.changes.length === 0) {
      console.log(
        chalk.green(
          `  ✓ No API surface changes detected (${result.filesAnalyzed} files analyzed).\n`,
        ),
      );
      return;
    }

    // Summary line
    const { added, removed, changed } = result.summary;
    const parts: string[] = [];
    if (added > 0) parts.push(chalk.green(`+${added} added`));
    if (removed > 0) parts.push(chalk.red(`−${removed} removed`));
    if (changed > 0) parts.push(chalk.yellow(`~${changed} signature changed`));
    console.log(
      `  ${parts.join(", ")} across ${result.filesAnalyzed} file(s)\n`,
    );

    // Per-package breakdown
    for (const [pkg, stats] of Object.entries(result.byPackage)) {
      const pkgParts: string[] = [];
      if (stats.added > 0) pkgParts.push(chalk.green(`+${stats.added}`));
      if (stats.removed > 0) pkgParts.push(chalk.red(`−${stats.removed}`));
      if (stats.changed > 0) pkgParts.push(chalk.yellow(`~${stats.changed}`));
      console.log(chalk.bold(`  ${pkg}: `) + pkgParts.join(", "));
    }
    console.log();

    // Individual changes
    for (const c of result.changes) {
      let icon: string;
      let detail: string;

      switch (c.changeType) {
        case "added":
          icon = chalk.green("+");
          detail = `${chalk.green(c.name)} ${chalk.gray(`(${c.kind})`)}`;
          break;
        case "removed":
          icon = chalk.red("−");
          detail = `${chalk.red(c.name)} ${chalk.gray(`(${c.kind})`)}`;
          break;
        case "signature-changed":
          icon = chalk.yellow("≠");
          detail = `${chalk.yellow(c.name)} ${chalk.gray(`(${c.kind})`)}`;
          break;
      }

      console.log(`    ${icon} ${detail}`);
      console.log(
        chalk.gray(`      ${c.filePath}${c.line ? `:${c.line}` : ""}`),
      );

      if (c.changeType === "signature-changed") {
        if (c.oldSignature)
          console.log(chalk.gray(`      old: ${c.oldSignature}`));
        if (c.newSignature)
          console.log(chalk.gray(`      new: ${c.newSignature}`));
      }
    }
    console.log();
  });

// ── iw index slices ───────────────────────────────────────────────

const indexSlicesSubcommand = new Command("slices")
  .description(
    "Detect vertical slices — communities that span multiple architectural layers end-to-end",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "-n, --min-layers <n>",
    "Minimum layers a community must span to be a vertical slice",
    "3",
  )
  .option("-l, --limit <n>", "Maximum slices to show")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action(
    (opts: {
      db?: string;
      minLayers?: string;
      limit?: string;
      format?: string;
    }) => {
      const dbPath = resolveDbPath(opts.db);
      const result = slices(dbPath, {
        minLayers: opts.minLayers ? parseInt(opts.minLayers, 10) : undefined,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(
        chalk.bold(
          `\n  Vertical Slice Detection — ${result.totalLayers} layers, ${result.totalCommunities} communities\n`,
        ),
      );

      if (result.slices.length === 0) {
        console.log(
          chalk.yellow(
            "  No vertical slices detected (no community spans enough layers).\n",
          ),
        );
      } else {
        console.log(
          chalk.cyan(
            `  ${result.slices.length} vertical slice(s) (spanning ≥${opts.minLayers ?? 3} layers):\n`,
          ),
        );
        for (const s of result.slices) {
          console.log(
            chalk.bold(
              `    ${s.label}  —  ${s.totalFiles} files across ${s.layerSpan} layers`,
            ),
          );
          for (const layerIdx of [...s.layers].sort((a, b) => b - a)) {
            const files = s.filesByLayer[layerIdx] || [];
            console.log(
              chalk.gray(
                `      Layer ${layerIdx}: ${files.map((f: string) => f.split("/").pop()).join(", ")}`,
              ),
            );
          }
          console.log();
        }
      }

      if (result.horizontal.length > 0) {
        console.log(
          chalk.gray(
            `  ${result.horizontal.length} horizontal module(s) (spanning 1–2 layers):\n`,
          ),
        );
        for (const h of result.horizontal.slice(0, 10)) {
          console.log(
            chalk.gray(
              `    ${h.label}  —  ${h.totalFiles} files in layer(s) ${h.layers.join(", ")}`,
            ),
          );
        }
        if (result.horizontal.length > 10) {
          console.log(
            chalk.gray(`    ... and ${result.horizontal.length - 10} more`),
          );
        }
        console.log();
      }
    },
  );

// ── iw index impact ─────────────────────────────────────────────

const indexImpactSubcommand = new Command("impact")
  .description(
    "Analyze impact of changed files using the CARI index (no Neo4j required)",
  )
  .argument("<files...>", "Changed file paths (workspace-relative)")
  .option("--db <path>", "Path to index.db")
  .option(
    "--hops <n>",
    "Max import-graph hops for dependents (default: 2)",
    "2",
  )
  .option("--limit <n>", "Max results per category (default: 50)", "50")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action(async (files: string[], opts) => {
    const dbPath = resolveDbPath(opts.db);
    const hops = parseInt(opts.hops, 10) || 2;
    const limit = parseInt(opts.limit, 10) || 50;

    const { impact, formatCariImpact } = await import("@intentweave/index");
    const result = impact(dbPath, { changed: files, hops, limit });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(formatCariImpact(result));
  });

// ── iw index focus ──────────────────────────────────────────────

const indexFocusSubcommand = new Command("focus")
  .description(
    "Generate a focused architecture view centred on a file, symbol, or topic",
  )
  .argument("<target>", "File path, symbol name, or topic keyword")
  .option("--db <path>", "Path to index.db")
  .option(
    "-h, --hops <n>",
    "Number of import-graph hops to expand (default: 2)",
    "2",
  )
  .option(
    "-n, --max-nodes <n>",
    "Maximum nodes in the subgraph (default: 25)",
    "25",
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action(
    (
      target: string,
      opts: {
        db?: string;
        hops?: string;
        maxNodes?: string;
        format?: string;
      },
    ) => {
      const dbPath = resolveDbPath(opts.db);
      const result = focus(dbPath, {
        target,
        hops: opts.hops ? parseInt(opts.hops, 10) : undefined,
        maxNodes: opts.maxNodes ? parseInt(opts.maxNodes, 10) : undefined,
      });

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.nodes.length === 0) {
        console.log(
          chalk.yellow(
            `\n  No results found for target "${target}". Try a file path, symbol name, or keyword.\n`,
          ),
        );
        return;
      }

      console.log(chalk.bold(`\n  Focused Architecture: ${result.target}`));
      console.log(
        chalk.gray(
          `  ${result.nodes.length} nodes (of ${result.totalNeighborhood} in ${result.hops}-hop neighbourhood), ${result.edges.length} edges\n`,
        ),
      );

      for (const n of result.nodes) {
        const marker = n.isTarget ? chalk.yellow("⭐ ") : "   ";
        const name = n.name || n.filePath.split("/").pop() || n.filePath;
        const layer = n.layerLabel ?? `L${n.layerIndex}`;
        const comm = n.communityLabel ?? `C${n.communityId}`;
        console.log(
          `${marker}${chalk.cyan(name)}  ${chalk.gray(`[${layer}]`)}  ${chalk.gray(`{${comm}}`)}  ${chalk.gray(`${n.dependents} dep`)}  ${chalk.gray(`hop ${n.hopDistance}`)}`,
        );
      }

      const importEdges = result.edges.filter((e) => e.type === "import");
      const coChangeEdges = result.edges.filter((e) => e.type === "co_change");
      const docEdges = result.edges.filter((e) => e.type === "doc_cooc");

      if (importEdges.length > 0) {
        console.log(chalk.bold(`\n  Import edges (${importEdges.length}):`));
        for (const e of importEdges) {
          console.log(
            chalk.gray(
              `    ${e.source.split("/").pop()} → ${e.target.split("/").pop()}`,
            ),
          );
        }
      }

      if (coChangeEdges.length > 0) {
        console.log(
          chalk.bold(`\n  Co-change edges (${coChangeEdges.length}):`),
        );
        for (const e of coChangeEdges) {
          console.log(
            chalk.gray(
              `    ${e.source.split("/").pop()} ↔ ${e.target.split("/").pop()} (${e.weight.toFixed(2)})`,
            ),
          );
        }
      }

      if (docEdges.length > 0) {
        console.log(
          chalk.bold(`\n  Doc co-occurrence edges (${docEdges.length}):`),
        );
        for (const e of docEdges) {
          console.log(
            chalk.gray(
              `    ${e.source.split("/").pop()} ↔ ${e.target.split("/").pop()} (${e.weight.toFixed(2)})`,
            ),
          );
        }
      }

      console.log();
    },
  );

// ── iw index export ─────────────────────────────────────────────

const indexExportSubcommand = new Command("export")
  .description("Export architecture report as a self-contained HTML file")
  .option("--db <path>", "Path to index.db")
  .option("--html", "Generate HTML architecture report (default)", true)
  .option(
    "--book",
    "Generate interactive Insights Book HTML with per-ADR Cytoscape flow diagrams (18.0)",
    false,
  )
  .option(
    "--prescriptive",
    "Generate prescriptive architecture report (17.1) with top-down SVG layers",
    false,
  )
  .option(
    "--show-rule-elements",
    "In --prescriptive mode, render rule-expressed elements inside layers",
    false,
  )
  .option(
    "--rules-config <path>",
    "Path to rules.yaml for --prescriptive (default: .iw/rules.yaml)",
  )
  .option("-o, --output <path>", "Output file path")
  .option(
    "--focus <target>",
    "Generate a focused architecture view centred on a file, symbol, or topic (Graphviz SVG)",
  )
  .option(
    "--hops <n>",
    "Number of import-graph hops for --focus (default: 2)",
    "2",
  )
  .option("--max-nodes <n>", "Maximum nodes for --focus (default: 25)", "25")
  .option(
    "--explain",
    "Generate an LLM-narrated architecture explanation (requires --provider)",
  )
  .option(
    "--adr-docs <glob>",
    "Glob of ADR markdown files to use as context for --prescriptive --explain (e.g. 'docs/ADR-*.md')",
  )
  .option(
    "--provider <name>",
    "LLM provider for layer naming / --explain: openai | smart-mock (omit for heuristic labels only)",
  )
  .option("--model <name>", "LLM model name", "gpt-4o-mini")
  .option("--api-key <key>", "OpenAI API key (or set OPENAI_API_KEY)")
  .option(
    "--no-hierarchical",
    "Disable two-level hierarchical layer inference (flat layers only)",
  )
  .option(
    "-r, --resolution <n>",
    "Community granularity: higher values (2–5) produce more, smaller communities (default: 1.0)",
    "1.0",
  )
  .option(
    "--max-size <n>",
    "Max community size before recursive sub-splitting (default: 100)",
    "100",
  )
  .option(
    "-m, --mode <mode>",
    "Community graph mode: structural (imports/co-changes), semantic (full co-occurrence), temporal (co-changes only)",
    "structural",
  )
  .action(
    async (opts: {
      db?: string;
      html?: boolean;
      book?: boolean;
      prescriptive?: boolean;
      showRuleElements?: boolean;
      rulesConfig?: string;
      output?: string;
      focus?: string;
      explain?: boolean;
      adrDocs?: string;
      hops: string;
      maxNodes: string;
      provider?: string;
      model: string;
      apiKey?: string;
      hierarchical: boolean;
      resolution: string;
      maxSize: string;
      mode: string;
    }) => {
      const dbPath = resolveDbPath(opts.db);

      // ── Architecture Book mode (18.0) ─────────────────────────────────────
      if (opts.book) {
        const outputPath = opts.output ?? "insights-book.html";
        console.log("Collecting architecture book data…");

        const data = await buildPrescriptiveReportData(dbPath, {
          hierarchical: opts.hierarchical,
          showRuleElements: true, // always show elements in the book
          rulesConfigPath: opts.rulesConfig,
        });

        const adrChapters = data.rules.filter((r) =>
          data.layers.some((l) =>
            (l.elements ?? []).some((e: any) => e.ruleId === r.id),
          ),
        );

        console.log(
          `  ${data.layers.length} layers · ${data.rules.length} rule(s) · ` +
            `${adrChapters.length} ADR chapter(s) · ` +
            `${data.meta.totalRuleViolations} violation(s)`,
        );

        // Also collect §10.1 arch report for the interactive D3 "Arch Graph" chapter.
        let archReportHtmlStr: string | undefined;
        try {
          const archData = archReport(dbPath, {});
          archReportHtmlStr = renderArchReportHtml(archData, {
            embedDark: true,
          });
        } catch {
          // Non-fatal — book still renders without the arch graph chapter.
        }

        const html = renderInsightsBookHtml(data, archReportHtmlStr);
        const fsSync = await import("node:fs");
        fsSync.writeFileSync(outputPath, html, "utf-8");
        console.log(`\n✓ Written to ${outputPath}`);
        return;
      }

      // ── Prescriptive mode: SVG should-be architecture report (17.1) ─────────
      if (opts.prescriptive) {
        const outputPath = opts.output ?? "architecture-prescriptive.html";
        console.log("Collecting prescriptive architecture data…");

        const data = await buildPrescriptiveReportData(dbPath, {
          hierarchical: opts.hierarchical,
          showRuleElements: Boolean(opts.showRuleElements),
          rulesConfigPath: opts.rulesConfig,
        });

        const totalRuleElements = data.layers.reduce(
          (sum, layer) =>
            sum + (Array.isArray(layer.elements) ? layer.elements.length : 0),
          0,
        );

        console.log(
          `  ${data.layers.length} layers · ${data.edges.length} policy edge(s) · ` +
            `${data.meta.totalRuleViolations} rule violation(s)`,
        );
        if (opts.showRuleElements) {
          console.log(`  ${totalRuleElements} rule element(s) rendered`);
          if (totalRuleElements === 0) {
            console.log(
              "  Note: no `expresses.elements` found in rules.yaml; add them to display rule elements.",
            );
          }
        }

        // ── Optional LLM edge rationale (--explain, §17.3) ──────────────
        if (opts.explain) {
          if (!opts.provider) {
            console.error(
              chalk.red(
                "--explain requires --provider (e.g. --provider openai)",
              ),
            );
            process.exit(1);
          }

          const { OpenAILLMProvider, SmartMockLLMProvider } =
            await import("@intentweave/analyzer/llm");
          const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
          const llm =
            opts.provider === "smart-mock"
              ? new SmartMockLLMProvider({
                  workspaceKey: "prescriptive-explain",
                })
              : new OpenAILLMProvider({ apiKey, model: opts.model });

          // Read ADR docs if provided via --adr-docs glob
          let adrContext = "";
          if (opts.adrDocs) {
            const { glob: tinyGlob } = await import("tinyglobby");
            const fsSync2 = await import("node:fs");
            const adrFiles = await tinyGlob(opts.adrDocs, {
              cwd: process.cwd(),
            });
            if (adrFiles.length > 0) {
              adrContext =
                "\n\nADR context:\n" +
                adrFiles
                  .map((f: string) => {
                    try {
                      return `=== ${path.basename(f)} ===\n${fsSync2.readFileSync(path.resolve(f), "utf-8").slice(0, 3000)}`;
                    } catch {
                      return "";
                    }
                  })
                  .filter(Boolean)
                  .join("\n\n---\n\n");
              console.log(
                chalk.blue(`  Using ${adrFiles.length} ADR doc(s) as context…`),
              );
            }
          }

          // Build edge list for the prompt
          const layerNames = data.layers.map((l) => l.name);
          const edgeSummary = data.edges
            .map((e) => {
              const from =
                layerNames[e.fromLayerIndex] ?? `layer[${e.fromLayerIndex}]`;
              const to =
                layerNames[e.toLayerIndex] ?? `layer[${e.toLayerIndex}]`;
              const arrow = e.type === "allowed" ? "→" : "↛";
              const existing = e.description
                ? ` (existing: "${e.description}")`
                : "";
              return `${from} ${arrow} ${to} [${e.type.toUpperCase()}${e.severity ? ` ${e.severity}` : ""}${e.ruleId ? ` ${e.ruleId}` : ""}]${existing}`;
            })
            .join("\n");

          const explainSystem = `You are an architecture documentation assistant.
Given a list of architecture edges (allowed and forbidden layer flows), write a single
clear sentence per edge explaining the architectural rationale.

Output ONLY a JSON object mapping "fromLayer→toLayer" to a rationale string.
Use the exact from/to layer names from the input.
Example: {"apps/ui → packages/data": "The UI must not bypass the service layer to preserve transaction integrity."}
If the edge already has a description, improve and cite it; otherwise synthesise from context.
Be concise: one sentence, under 160 characters.`;

          const explainUser = `Architecture edges:\n${edgeSummary}${adrContext}`;

          console.log(chalk.blue("  Generating LLM edge rationale…"));
          try {
            const resp = await llm.complete({
              system: explainSystem,
              messages: [{ role: "user", content: explainUser }],
              temperature: 0.2,
              maxTokens: 1024,
            });

            // Parse JSON map
            const jsonText = (() => {
              const m = resp.content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
              if (m) return m[1];
              const s = resp.content.indexOf("{");
              const e2 = resp.content.lastIndexOf("}");
              return s !== -1 && e2 !== -1
                ? resp.content.slice(s, e2 + 1)
                : resp.content;
            })();
            const rationaleMap: Record<string, string> = JSON.parse(jsonText);

            // Inject into edge descriptions
            let injected = 0;
            for (const edge of data.edges) {
              const from = layerNames[edge.fromLayerIndex] ?? "";
              const to = layerNames[edge.toLayerIndex] ?? "";
              const key = `${from}→${to}`;
              const altKey = `${from} → ${to}`;
              const rationale = rationaleMap[key] ?? rationaleMap[altKey];
              if (rationale) {
                edge.description = rationale;
                injected++;
              }
            }
            console.log(
              `  ✓ Rationale injected for ${injected}/${data.edges.length} edge(s)`,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              chalk.yellow(
                `  ⚠ --explain LLM call failed: ${msg} (continuing without rationale)`,
              ),
            );
          }
        }

        const html = renderPrescriptiveReportHtml(data);
        const fsSync = await import("node:fs");
        fsSync.writeFileSync(outputPath, html, "utf-8");
        console.log(`\n✓ Written to ${outputPath}`);
        return;
      }

      // ── Focus mode: Graphviz SVG report ─────────────────────
      if (opts.focus) {
        const outputPath = opts.output ?? "focus.html";
        console.log(
          chalk.blue(
            `Generating focused architecture view for "${opts.focus}"…`,
          ),
        );
        const result = focus(dbPath, {
          target: opts.focus,
          hops: parseInt(opts.hops, 10),
          maxNodes: parseInt(opts.maxNodes, 10),
        });

        if (result.nodes.length === 0) {
          console.error(
            chalk.red(
              `No results found for target "${opts.focus}". Try a file path, symbol name, or keyword.`,
            ),
          );
          process.exit(1);
        }

        console.log(
          `  ${result.nodes.length} nodes · ${result.edges.length} edges · ${result.hops}-hop view`,
        );

        // Optional LLM explanation
        let narrative: string | undefined;
        if (opts.explain) {
          if (!opts.provider) {
            console.error(
              chalk.red(
                "--explain requires --provider (e.g. --provider openai)",
              ),
            );
            process.exit(1);
          }

          const { OpenAILLMProvider, SmartMockLLMProvider } =
            await import("@intentweave/analyzer/llm");
          const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
          const llm =
            opts.provider === "smart-mock"
              ? new SmartMockLLMProvider()
              : new OpenAILLMProvider({
                  apiKey,
                  model: opts.model,
                });

          console.log(chalk.blue("  Generating LLM architecture narrative…"));

          const insights = analyzeFocusInsights(result);
          narrative = await generateFocusNarrative(llm, result, insights);
          console.log("  ✓ Narrative generated");
        }

        const html = await renderFocusReportHtml(result, { narrative });
        const fsSync = await import("node:fs");
        fsSync.writeFileSync(outputPath, html, "utf-8");
        console.log(`\n✓ Written to ${outputPath}`);
        return;
      }

      // ── Full architecture report ────────────────────────────

      // Optional LLM layer naming pass (5.1c)
      let layerNames;
      let directoryNames;
      if (opts.provider) {
        const { OpenAILLMProvider, SmartMockLLMProvider } =
          await import("@intentweave/analyzer/llm");
        const layers = layersInfer(
          dbPath,
          opts.hierarchical ? { hierarchical: true } : undefined,
        );
        let llm;
        if (opts.provider === "openai") {
          const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
          if (!apiKey) {
            console.error(
              chalk.red(
                "OpenAI API key required. Set OPENAI_API_KEY or use --api-key.",
              ),
            );
            process.exit(1);
          }
          llm = new OpenAILLMProvider({ apiKey, model: opts.model });
        } else {
          llm = new SmartMockLLMProvider({ workspaceKey: "export" });
        }
        console.log(
          chalk.blue(`Naming layers with ${opts.provider} (${opts.model})…`),
        );
        const naming = await nameLayers(layers, llm);
        layerNames = naming.layers;
        console.log(
          `  Named ${layerNames.length} layers + ${naming.directories.length} directories (${naming.tokensUsed.prompt + naming.tokensUsed.completion} tokens, ${naming.latencyMs}ms)`,
        );
        directoryNames = naming.directories;
      }

      console.log("Collecting architecture data…");
      const layerOptions = opts.hierarchical
        ? { hierarchical: true }
        : undefined;
      const communityOptions = {
        resolution: parseFloat(opts.resolution),
        maxSize: parseInt(opts.maxSize, 10),
        mode: opts.mode as "structural" | "semantic" | "temporal",
      };
      const data = archReport(dbPath, {
        ...(layerNames ? { layerNames, directoryNames } : {}),
        ...(layerOptions ? { layerOptions } : {}),
        communityOptions,
      });
      console.log(
        `  ${data.meta.totalFiles} files · ${data.summary.totalLayers} layers · ` +
          `${data.summary.totalCommunities} communities`,
      );
      if (data.summary.layerViolations > 0) {
        console.log(`  ⚠ ${data.summary.layerViolations} layer violation(s)`);
      }
      if (data.summary.boundaryViolations > 0) {
        console.log(
          `  ⚠ ${data.summary.boundaryViolations} boundary violation(s)`,
        );
      }
      const html = renderArchReportHtml(data);
      const fsSync = await import("node:fs");
      const outputPath = opts.output ?? "architecture.html";
      fsSync.writeFileSync(outputPath, html, "utf-8");
      console.log(`\n✓ Written to ${outputPath}`);
    },
  );

// ── iw index calls (Phase 4) ─────────────────────────────────────

const indexCallsSubcommand = new Command("calls")
  .description("Query the symbol_calls call graph (Phase 4)")
  .option("--db <path>", "Path to index.db")
  .option("--caller-file <path>", "Filter by caller file path (substring)")
  .option("--callee-name <name>", "Filter by callee name (substring)")
  .option("--caller-name <name>", "Filter by caller function name (substring)")
  .option("--method-only", "Only show method calls")
  .option("-n, --limit <n>", "Maximum results", "100")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = calls(dbPath, {
      callerFile: opts.callerFile,
      calleeName: opts.calleeName,
      callerName: opts.callerName,
      methodOnly: opts.methodOnly,
      limit: parseInt(opts.limit, 10),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.total === 0) {
      console.log(chalk.green("\n  ✓ No call edges found (check filter options).\n"));
      return;
    }

    console.log(chalk.blue(`\n  ▸ ${result.total} call edge(s) in index`));
    if (result.topCallees.length > 0) {
      console.log(chalk.gray(`  Top callees: ${result.topCallees.slice(0, 5).map((c) => `${c.calleeName}(${c.count})`).join(", ")}`));
    }
    console.log();

    const limit = parseInt(opts.limit, 10);
    for (const edge of result.edges.slice(0, limit)) {
      const methodMark = edge.isMethod ? chalk.cyan(".") : " ";
      const line = edge.callerLine ? chalk.gray(`:${edge.callerLine}`) : "";
      const caller = edge.callerName ? chalk.gray(`[${edge.callerName}]`) : "";
      console.log(
        `  ${methodMark} ${chalk.white(edge.callerFile)}${line} ${caller} → ${chalk.yellow(edge.calleeName)}`,
      );
    }
    if (result.edges.length > limit) {
      console.log(chalk.gray(`  ...and ${result.total - limit} more (use --limit or --format json)`));
    }
    console.log();
  });

// ── iw index trace (Phase 4) ─────────────────────────────────────

const indexTraceSubcommand = new Command("trace")
  .description("Trace call paths from an entry-point file (Phase 4)")
  .requiredOption("--entry <file>", "Entry-point file path (substring match)")
  .option("--db <path>", "Path to index.db")
  .option("--hops <n>", "Maximum BFS depth", "6")
  .option("--max-nodes <n>", "Maximum nodes in result", "50")
  .option(
    "--direction <dir>",
    "forward (what does entry call?) or backward (who calls entry?)",
    "forward",
  )
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action((opts) => {
    const dbPath = resolveDbPath(opts.db);
    const result = trace(dbPath, {
      entry: opts.entry,
      hops: parseInt(opts.hops, 10),
      maxNodes: parseInt(opts.maxNodes, 10),
      direction: opts.direction as "forward" | "backward",
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.nodes.length === 0) {
      console.log(
        chalk.yellow(`\n  ⚠ No entry files found matching "${opts.entry}".\n`),
      );
      return;
    }

    const callsStatus = result.callsTableActive
      ? chalk.green("(call graph active, ~0.95 confidence)")
      : chalk.yellow("(no call graph data — index with AX extractor)");
    console.log(
      chalk.blue(
        `\n  ▸ Call trace from "${result.entryFile}" — ${result.nodes.length} node(s), ${result.edges.length} edge(s) ${callsStatus}`,
      ),
    );
    if (result.truncated) {
      console.log(chalk.gray("  (truncated — use --hops or --max-nodes to expand)"));
    }
    console.log();

    // Group nodes by depth
    const byDepth = new Map<number, typeof result.nodes>();
    for (const node of result.nodes) {
      if (!byDepth.has(node.depth)) byDepth.set(node.depth, []);
      byDepth.get(node.depth)!.push(node);
    }

    for (const [depth, nodes] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      const indent = "  " + "  ".repeat(depth);
      const depthLabel = depth === 0 ? chalk.cyan("[entry]") : chalk.gray(`[depth ${depth}]`);
      for (const node of nodes) {
        const syms =
          node.symbols.length > 0
            ? chalk.gray(` (${node.symbols.slice(0, 3).join(", ")}${node.symbols.length > 3 ? ", ..." : ""})`)
            : "";
        console.log(`${indent}${depthLabel} ${chalk.white(node.file)}${syms}`);
      }
    }
    console.log();
  });

// ── iw index rule-coverage (Phase 4) ────────────────────────────

const indexRuleCoverageSubcommand = new Command("rule-coverage")
  .description(
    "Flag packages/directories with zero behavioral rules (Phase 4)",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "--rules <path>",
    "Path to rules.yaml",
    path.join(process.cwd(), ".iw", "rules.yaml"),
  )
  .option("--group-depth <n>", "Directory grouping depth", "2")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action(async (opts) => {
    const dbPath = resolveDbPath(opts.db);
    const { readFile } = await import("node:fs/promises");
    const { load: yamlLoadRc } = await import("js-yaml");

    let rulesConfig: import("@intentweave/index").RulesConfig = {
      version: 1,
      rules: [],
    };
    try {
      const raw = await readFile(opts.rules, "utf-8");
      const parsed = yamlLoadRc(raw) as import("@intentweave/index").RulesConfig;
      if (parsed?.rules) rulesConfig = parsed;
    } catch {
      // No rules.yaml — will show all packages as uncovered
    }

    const result = ruleCoverage(dbPath, {
      rulesConfig,
      groupDepth: parseInt(opts.groupDepth, 10),
    });

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(
      chalk.blue(
        `\n  ▸ Behavioral rule coverage — ${result.totalBehavioralRules} rule(s)`,
      ),
    );
    console.log(
      `    Covered packages: ${chalk.green(String(result.covered.length))}  ` +
        `Uncovered: ${chalk.yellow(String(result.uncovered.length))}`,
    );
    console.log();

    if (result.totalBehavioralRules === 0) {
      console.log(
        chalk.gray(
          "  No behavioral rules defined. Add rules with domain: behavioral to .iw/rules.yaml\n",
        ),
      );
      return;
    }

    if (result.topUncovered.length > 0) {
      console.log(chalk.yellow("  Packages with no behavioral rules (top by file count):"));
      for (const pkg of result.topUncovered) {
        console.log(
          `    ${chalk.white(pkg.dir.padEnd(40))} ${chalk.gray(pkg.fileCount + " file(s)")}`,
        );
      }
      console.log();
    }

    if (result.covered.length > 0) {
      console.log(chalk.green("  Covered packages:"));
      for (const pkg of result.covered) {
        console.log(
          `    ${chalk.white(pkg.dir.padEnd(40))} rules: ${chalk.cyan(pkg.coveredByRules.join(", "))}`,
        );
      }
      console.log();
    }
  });

export const indexCommand = new Command("index")
  .description("CARI Evidence Engine commands")
  .addCommand(indexBuildSubcommand)
  .addCommand(indexUpdateSubcommand)
  .addCommand(indexWatchSubcommand)
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
  .addCommand(indexTerminologySubcommand)
  .addCommand(indexNamingViolationsSubcommand)
  .addCommand(indexCommentCodeRatioSubcommand)
  .addCommand(indexSkippedFilesSubcommand)
  .addCommand(indexRulesCheckSubcommand)
  .addCommand(indexDeprecatedCallersSubcommand)
  .addCommand(indexInternalViolationsSubcommand)
  .addCommand(indexTypeAssertionsSubcommand)
  .addCommand(indexTestIntentSubcommand)
  .addCommand(indexRulesTrendSubcommand)
  .addCommand(indexDepDepthSubcommand)
  .addCommand(indexBoundaryViolationsSubcommand)
  .addCommand(indexLayersInferSubcommand)
  .addCommand(indexLayersCheckSubcommand)
  .addCommand(indexArchCheckSubcommand)
  .addCommand(indexConformanceSubcommand)
  .addCommand(indexDeadFeaturesSubcommand)
  .addCommand(indexApiSurfaceSubcommand)
  .addCommand(indexSlicesSubcommand)
  .addCommand(indexFocusSubcommand)
  .addCommand(indexImpactSubcommand)
  .addCommand(indexExportSubcommand)
  .addCommand(indexEnrichSubcommand)
  .addCommand(indexRulesExtractSubcommand)
  .addCommand(indexScanDiagramsSubcommand)
  .addCommand(indexCallsSubcommand)
  .addCommand(indexTraceSubcommand)
  .addCommand(indexRuleCoverageSubcommand);

// ── LLM narrative generation for --explain ──────────────────────

interface FocusInsightsLike {
  targetSummary: string;
  clusters: Array<{
    label: string;
    files: string[];
    role: string;
    avgHop: number;
  }>;
  hubs: Array<{
    name: string;
    filePath: string;
    dependents: number;
    risk: string;
  }>;
  flowSummary: string;
  observations: string[];
}

async function generateFocusNarrative(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llm: any,
  result: {
    target: string;
    nodes: Array<{
      name: string;
      filePath: string;
      layerLabel: string;
      communityLabel: string;
      dependents: number;
      hopDistance: number;
      isTarget: boolean;
    }>;
    edges: Array<{ source: string; target: string; type: string }>;
    hops: number;
    totalNeighborhood: number;
  },
  insights: FocusInsightsLike,
): Promise<string> {
  const nodesSummary = result.nodes
    .map(
      (n) =>
        `${n.isTarget ? "⭐ " : ""}${n.name} (${n.filePath}, layer: ${n.layerLabel}, hop: ${n.hopDistance}, dependents: ${n.dependents})`,
    )
    .join("\n");

  const edgeSummary = `${result.edges.filter((e) => e.type === "import").length} imports, ${result.edges.filter((e) => e.type === "co_change").length} co-changes, ${result.edges.filter((e) => e.type === "doc_cooc").length} doc links`;

  const clusterSummary = insights.clusters
    .map((c) => `• ${c.label}: ${c.role} (${c.files.length} files)`)
    .join("\n");

  const hubSummary =
    insights.hubs.length > 0
      ? insights.hubs
          .map(
            (h) => `• ${h.name}: ${h.dependents} dependents (${h.risk} risk)`,
          )
          .join("\n")
      : "No high-connectivity hubs detected.";

  const system = `You are a senior software architect analysing a codebase.
Write a clear, concise architecture narrative (3-5 paragraphs) for a developer who wants to understand this part of the system.

Cover:
1. What the target module does and its role in the system
2. How the layers are organised and why
3. Key data/control flow patterns
4. Risks or architectural concerns (hubs, tight coupling, boundary violations)
5. Recommendations for a newcomer working in this area

Use plain language. No markdown formatting — the text will be displayed in a pre-formatted panel.
Keep it under 400 words.`;

  const userMsg = `Focused architecture view for "${result.target}":

NODES (${result.nodes.length} of ${result.totalNeighborhood} in ${result.hops}-hop neighbourhood):
${nodesSummary}

EDGES: ${edgeSummary}

LAYER CLUSTERS:
${clusterSummary}

HUB ANALYSIS:
${hubSummary}

DATA FLOW: ${insights.flowSummary}

STRUCTURAL OBSERVATIONS:
${insights.observations.map((o) => `• ${o.replace(/<[^>]*>/g, "")}`).join("\n")}

Please write an architecture narrative explaining this area of the codebase.`;

  const response = await llm.complete({
    system,
    messages: [{ role: "user", content: userMsg }],
    temperature: 0.3,
    maxTokens: 800,
  });

  return response.content;
}
