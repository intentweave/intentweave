// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: Architecture Diagram Validation (5.8)
 *
 * Validates the real import graph against a declared architecture config
 * (.iw/architecture.yaml). Checks three things:
 *
 *   1. Declared flows — do they exist in the import graph?
 *   2. Undocumented flows — imports between components not in any flow.
 *   3. Constraint violations — forbidden imports that exist.
 *
 * $0 / no LLM — pure graph validation on SQLite data.
 */

import type Database from "better-sqlite3";
import type {
  ArchConfig,
  ArchComponent,
  ArchFlow,
  ArchConstraint,
  ArchCheckResult,
  ArchFlowResult,
  UndocumentedFlow,
  ArchConstraintViolation,
} from "../types.js";
import { openIndex, buildImportGraph } from "./shared.js";
import { minimatch } from "minimatch";
import * as fs from "node:fs";
import * as path from "node:path";

// =============================================================================
// Public API — dual signature
// =============================================================================

/**
 * Validate architecture diagram from a database file path + config.
 */
export function archCheck(dbPath: string, config: ArchConfig): ArchCheckResult {
  const db = openIndex(dbPath);
  try {
    return archCheckFromDb(db, config);
  } finally {
    db.close();
  }
}

/**
 * Enrich an ArchConfig that has empty component `files` arrays by
 * inferring file globs from the index (annotation matches + name tokens).
 *
 * Used by `arch-check --from-scan` where the diagram scan produces
 * components without file patterns.
 */
export function enrichArchConfigWithFiles(
  dbPath: string,
  config: ArchConfig,
): ArchConfig {
  const db = openIndex(dbPath);
  try {
    return {
      ...config,
      components: (config.components ?? []).map((comp) => ({
        ...comp,
        files:
          comp.files && comp.files.length > 0
            ? comp.files
            : inferFilesForComponent(db, comp.name),
      })),
    };
  } finally {
    db.close();
  }
}

/**
 * Build an in-memory ArchConfig from enriched KG triples.
 *
 * Intended for diagram-driven architecture validation (ASCII/Mermaid -> FX/KX -> kg_*).
 */
export function inferArchConfigFromKg(
  dbPath: string,
  options?: {
    minConfidence?: number;
    sourceFiles?: string[];
    requireDiagramHints?: boolean;
    workspaceRoot?: string;
  },
): ArchConfig {
  const db = openIndex(dbPath);
  try {
    return inferArchConfigFromKgDb(db, options);
  } finally {
    db.close();
  }
}

/**
 * Core inference logic against an open database.
 */
export function inferArchConfigFromKgDb(
  db: Database.Database,
  options?: {
    minConfidence?: number;
    sourceFiles?: string[];
    requireDiagramHints?: boolean;
    workspaceRoot?: string;
  },
): ArchConfig {
  if (!hasKgTables(db)) {
    return { components: [], flows: [], constraints: [] };
  }

  const minConfidence = options?.minConfidence ?? 0.5;
  const sourceFiles = options?.sourceFiles ?? [];
  const requireDiagramHints = options?.requireDiagramHints ?? false;
  const workspaceRoot = options?.workspaceRoot ?? process.cwd();

  const rows = (
    db
      .prepare(
        `
      SELECT
        r.predicate AS predicate,
        r.confidence AS confidence,
        r.source_file AS sourceFile,
        f.name AS fromName,
        f.type AS fromType,
        t.name AS toName,
        t.type AS toType
      FROM kg_relationships r
      JOIN kg_entities f ON f.id = r.from_id
      JOIN kg_entities t ON t.id = r.to_id
      WHERE r.confidence >= ?
        AND r.source_file IS NOT NULL
    `,
      )
      .all(minConfidence) as Array<{
      predicate: string;
      confidence: number;
      sourceFile: string;
      fromName: string;
      fromType: string;
      toName: string;
      toType: string;
    }>
  )
    .filter((r) => r.sourceFile.toLowerCase().endsWith(".md"))
    .filter((r) =>
      sourceFiles.length === 0 ? true : sourceFiles.includes(r.sourceFile),
    )
    .filter((r) => FLOW_PREDICATES.has(r.predicate));

  const docsWithDiagramHints = requireDiagramHints
    ? collectDiagramSourceFiles(
        rows.map((r) => r.sourceFile),
        workspaceRoot,
      )
    : null;

  const filteredRows = rows.filter((r) => {
    if (!docsWithDiagramHints) return true;
    return docsWithDiagramHints.has(r.sourceFile);
  });

  if (filteredRows.length === 0) {
    return { components: [], flows: [], constraints: [] };
  }

  const componentNames = new Set<string>();
  const flowKeys = new Set<string>();
  const flows: ArchConfig["flows"] = [];

  for (const row of filteredRows) {
    const from = normalizeComponentName(row.fromName);
    const to = normalizeComponentName(row.toName);
    if (!from || !to || from === to) continue;

    const normalized = normalizeFlowDirection(from, to, row.predicate);
    componentNames.add(normalized.from);
    componentNames.add(normalized.to);

    const key = `${normalized.from}::${normalized.to}`;
    if (flowKeys.has(key)) continue;
    flowKeys.add(key);
    flows.push({ from: normalized.from, to: normalized.to });
  }

  const components: ArchComponent[] = Array.from(componentNames)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      files: inferFilesForComponent(db, name),
    }));

  return {
    components,
    flows,
    constraints: [],
  };
}

/**
 * Core architecture validation logic against an open database.
 */
export function archCheckFromDb(
  db: Database.Database,
  config: ArchConfig,
): ArchCheckResult {
  if (!config.components || config.components.length === 0) {
    return emptyResult();
  }

  // ── 1. Assign files to components ───────────────────────────────────────
  const fileToComponent = new Map<string, string>();
  const componentFiles = new Map<string, Set<string>>();

  for (const comp of config.components) {
    componentFiles.set(comp.name, new Set());
  }

  const allKnownFiles = (
    db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>
  ).map((r) => r.path);

  for (const filePath of allKnownFiles) {
    for (const comp of config.components) {
      for (const pattern of comp.files) {
        if (minimatch(filePath, pattern, { dot: true })) {
          fileToComponent.set(filePath, comp.name);
          componentFiles.get(comp.name)!.add(filePath);
          break;
        }
      }
      if (fileToComponent.has(filePath)) break;
    }
  }

  // ── 2. Build import graph and collect component-level edges ─────────────
  const { forward } = buildImportGraph(db);

  // Collect actual component→component import edges with evidence
  const actualEdges = new Map<
    string,
    Array<{ sourceFile: string; targetFile: string }>
  >();

  for (const [source, targets] of forward) {
    const sourceComp = fileToComponent.get(source);
    if (!sourceComp) continue;

    for (const target of targets) {
      const targetComp = fileToComponent.get(target);
      if (!targetComp) continue;
      if (sourceComp === targetComp) continue; // internal import

      const edgeKey = `${sourceComp}::${targetComp}`;
      if (!actualEdges.has(edgeKey)) actualEdges.set(edgeKey, []);
      actualEdges
        .get(edgeKey)!
        .push({ sourceFile: source, targetFile: target });
    }
  }

  // ── 3. Validate declared flows ──────────────────────────────────────────
  const flows: ArchFlowResult[] = [];
  const declaredEdges = new Set<string>();

  for (const flow of config.flows ?? []) {
    const targets = Array.isArray(flow.to) ? flow.to : [flow.to];
    for (const to of targets) {
      const edgeKey = `${flow.from}::${to}`;
      declaredEdges.add(edgeKey);

      const evidence = actualEdges.get(edgeKey) ?? [];
      flows.push({
        from: flow.from,
        to,
        status: evidence.length > 0 ? "confirmed" : "missing",
        evidence: evidence.slice(0, 10), // limit evidence for large graphs
      });
    }
  }

  // ── 4. Find undocumented flows ──────────────────────────────────────────
  const undocumented: UndocumentedFlow[] = [];

  for (const [edgeKey, edges] of actualEdges) {
    if (declaredEdges.has(edgeKey)) continue;

    const [from, to] = edgeKey.split("::");
    undocumented.push({
      from,
      to,
      edges: edges.slice(0, 10),
    });
  }

  // Sort undocumented by edge count (most significant first)
  undocumented.sort((a, b) => b.edges.length - a.edges.length);

  // ── 5. Check constraints ────────────────────────────────────────────────
  const constraintViolations: ArchConstraintViolation[] = [];

  for (const constraint of config.constraints ?? []) {
    if (constraint.type !== "no-direct-dependency") continue;

    const edgeKey = `${constraint.from}::${constraint.to}`;
    const edges = actualEdges.get(edgeKey);

    if (edges && edges.length > 0) {
      constraintViolations.push({
        from: constraint.from,
        to: constraint.to,
        reason:
          constraint.reason ??
          `${constraint.from} should not import from ${constraint.to}`,
        edges: edges.slice(0, 10),
      });
    }
  }

  // ── 6. Build component summary ──────────────────────────────────────────
  const componentSummary = config.components.map((comp) => ({
    name: comp.name,
    fileCount: componentFiles.get(comp.name)?.size ?? 0,
  }));

  // ── 7. Summary statistics ──────────────────────────────────────────────
  const totalFlows = flows.length;
  const confirmedFlows = flows.filter((f) => f.status === "confirmed").length;
  const missingFlows = totalFlows - confirmedFlows;
  const undocumentedFlows = undocumented.length;
  const constraintViolationCount = constraintViolations.length;

  // Conformance = (confirmed flows + 0 undocumented + 0 violations) / total checks
  const totalChecks = totalFlows + undocumentedFlows + constraintViolationCount;
  const conformancePercent =
    totalChecks > 0 ? Math.round((confirmedFlows / totalChecks) * 100) : 100;

  return {
    flows,
    undocumented,
    constraintViolations,
    componentSummary,
    summary: {
      totalFlows,
      confirmedFlows,
      missingFlows,
      undocumentedFlows,
      constraintViolations: constraintViolationCount,
      conformancePercent,
    },
  };
}

// =============================================================================
// YAML Parser — hand-rolled for architecture.yaml
// =============================================================================

/**
 * Parse .iw/architecture.yaml content into an ArchConfig.
 * Handles components (name + files), flows (from/to), and constraints.
 */
export function parseArchitectureYaml(content: string): ArchConfig {
  const components: ArchComponent[] = [];
  const flows: ArchFlow[] = [];
  const constraints: ArchConstraint[] = [];

  type Section = "none" | "components" | "flows" | "constraints";
  let section: Section = "none";

  // Component parsing state
  let currentComp: { name: string; files: string[] } | null = null;
  let inCompFiles = false;

  // Flow parsing state
  let currentFlow: { from?: string; to: string[] } | null = null;
  let inFlowTo = false;

  // Constraint parsing state
  let currentConstraint: {
    type?: string;
    from?: string;
    to?: string;
    reason?: string;
  } | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    // Top-level section detection
    if (line === "components:" || line === "components: []") {
      flushComp();
      flushFlow();
      flushConstraint();
      section = "components";
      inCompFiles = false;
      continue;
    }
    if (line === "flows:" || line === "flows: []") {
      flushComp();
      flushFlow();
      flushConstraint();
      section = "flows";
      inFlowTo = false;
      continue;
    }
    if (line === "constraints:" || line === "constraints: []") {
      flushComp();
      flushFlow();
      flushConstraint();
      section = "constraints";
      continue;
    }

    // ── Components section ──
    if (section === "components") {
      const nameMatch = line.match(/^-\s*name:\s*["']?([^"'\n]+?)["']?\s*$/);
      if (nameMatch) {
        flushComp();
        currentComp = { name: nameMatch[1], files: [] };
        inCompFiles = false;
        continue;
      }

      if (line === "files:" || line === "files: []") {
        inCompFiles = true;
        continue;
      }

      // Inline files array: files: ["glob1", "glob2"]
      const inlineFilesMatch = line.match(/^files:\s*\[(.+)\]\s*$/);
      if (inlineFilesMatch && currentComp) {
        inCompFiles = false;
        const items = inlineFilesMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
        currentComp.files.push(...items.filter(Boolean));
        continue;
      }

      if (inCompFiles && currentComp && line.startsWith("-")) {
        const pattern = line
          .replace(/^-\s*/, "")
          .replace(/^["']|["']$/g, "")
          .trim();
        if (pattern) currentComp.files.push(pattern);
        continue;
      }
    }

    // ── Flows section ──
    if (section === "flows") {
      const fromMatch = line.match(/^-\s*from:\s*["']?([^"'\n]+?)["']?\s*$/);
      if (fromMatch) {
        flushFlow();
        currentFlow = { from: fromMatch[1], to: [] };
        inFlowTo = false;
        continue;
      }

      // Inline to: "Target" or to: ["A", "B"]
      const inlineToSingle = line.match(/^to:\s*["']?([^"'\[\]\n]+?)["']?\s*$/);
      if (inlineToSingle && currentFlow) {
        currentFlow.to.push(inlineToSingle[1]);
        inFlowTo = false;
        continue;
      }

      const inlineToArray = line.match(/^to:\s*\[(.+)\]\s*$/);
      if (inlineToArray && currentFlow) {
        const items = inlineToArray[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""));
        currentFlow.to.push(...items.filter(Boolean));
        inFlowTo = false;
        continue;
      }

      if (line === "to:") {
        inFlowTo = true;
        continue;
      }

      if (inFlowTo && currentFlow && line.startsWith("-")) {
        const target = line
          .replace(/^-\s*/, "")
          .replace(/^["']|["']$/g, "")
          .trim();
        if (target) currentFlow.to.push(target);
        continue;
      }
    }

    // ── Constraints section ──
    if (section === "constraints") {
      const typeMatch = line.match(/^-\s*type:\s*["']?([^"'\n]+?)["']?\s*$/);
      if (typeMatch) {
        flushConstraint();
        currentConstraint = { type: typeMatch[1] };
        continue;
      }

      if (currentConstraint) {
        const fromMatch = line.match(/^from:\s*["']?([^"'\n]+?)["']?\s*$/);
        if (fromMatch) {
          currentConstraint.from = fromMatch[1];
          continue;
        }

        const toMatch = line.match(/^to:\s*["']?([^"'\n]+?)["']?\s*$/);
        if (toMatch) {
          currentConstraint.to = toMatch[1];
          continue;
        }

        const reasonMatch = line.match(/^reason:\s*["']?([^"'\n]+?)["']?\s*$/);
        if (reasonMatch) {
          currentConstraint.reason = reasonMatch[1];
          continue;
        }
      }
    }
  }

  flushComp();
  flushFlow();
  flushConstraint();

  if (components.length === 0) {
    throw new Error(
      "No components found in architecture config. Expected 'components:' section.",
    );
  }

  return { components, flows, constraints };

  // ── Flush helpers ──

  function flushComp() {
    if (currentComp) {
      components.push(currentComp);
      currentComp = null;
      inCompFiles = false;
    }
  }

  function flushFlow() {
    if (currentFlow?.from && currentFlow.to.length > 0) {
      flows.push({
        from: currentFlow.from,
        to: currentFlow.to.length === 1 ? currentFlow.to[0] : currentFlow.to,
      });
    }
    currentFlow = null;
    inFlowTo = false;
  }

  function flushConstraint() {
    if (
      currentConstraint?.type === "no-direct-dependency" &&
      currentConstraint.from &&
      currentConstraint.to
    ) {
      constraints.push({
        type: "no-direct-dependency",
        from: currentConstraint.from,
        to: currentConstraint.to,
        reason: currentConstraint.reason,
      });
    }
    currentConstraint = null;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function emptyResult(): ArchCheckResult {
  return {
    flows: [],
    undocumented: [],
    constraintViolations: [],
    componentSummary: [],
    summary: {
      totalFlows: 0,
      confirmedFlows: 0,
      missingFlows: 0,
      undocumentedFlows: 0,
      constraintViolations: 0,
      conformancePercent: 100,
    },
  };
}

const FLOW_PREDICATES = new Set([
  "DEPENDS_ON",
  "CALLS",
  "USES",
  "PRODUCES",
  "CONSUMES",
  "PRECEDES",
  "FOLLOWS",
  "TRIGGERS",
  "TRANSITIONS_TO",
  "ENABLES",
  "REQUIRES",
]);

function hasKgTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name IN ('kg_entities','kg_relationships')`,
    )
    .get() as { c: number };
  return row.c === 2;
}

function normalizeComponentName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function normalizeFlowDirection(
  from: string,
  to: string,
  predicate: string,
): {
  from: string;
  to: string;
} {
  // "A FOLLOWS B" implies B -> A in architecture flow terms.
  if (predicate === "FOLLOWS") {
    return { from: to, to: from };
  }
  return { from, to };
}

function inferFilesForComponent(
  db: Database.Database,
  componentName: string,
): string[] {
  const exactRows = db
    .prepare(
      `
      SELECT DISTINCT s.file_path AS filePath
      FROM annotations a
      JOIN symbols s ON s.id = a.symbol_id
      WHERE lower(a.text) = lower(?)
      LIMIT 12
    `,
    )
    .all(componentName) as Array<{ filePath: string }>;

  if (exactRows.length > 0) {
    return exactRows.map((r) => r.filePath);
  }

  const token = componentName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];

  if (token && token.length >= 3) {
    return [`**/*${token}*`];
  }

  return ["**/*"];
}

function collectDiagramSourceFiles(
  sourceFiles: string[],
  workspaceRoot: string,
): Set<string> {
  const out = new Set<string>();
  const unique = Array.from(new Set(sourceFiles));

  for (const file of unique) {
    const abs = path.resolve(workspaceRoot, file);
    if (!fs.existsSync(abs)) continue;

    let content = "";
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }

    const hasMermaid = /```\s*mermaid[\s\S]*?```/i.test(content);
    const hasAsciiFlow = /(?:->|-->|=>|==>|\|\s*\n\s*\|)/.test(content);
    if (hasMermaid || hasAsciiFlow) {
      out.add(file);
    }
  }

  return out;
}
