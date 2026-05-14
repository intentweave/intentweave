// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: mermaidCheck (Phase 3 — Behavioral Domain)
 *
 * Parses inline or file-referenced Mermaid diagrams and derives behavioral
 * violations from the CARI import graph — no call graph, no LLM.
 *
 * Supported diagram types:
 *   sequenceDiagram  → must_call + must_not_call (import absence, ~0.85 confidence)
 *   stateDiagram-v2  → valid_transition (symbol naming heuristic, ~0.50 confidence)
 *   flowchart        → must_precede (structural, ~0.30 confidence)
 *
 * All three diagram types default to `mode: warn` until the calls table ships (Phase 4).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { RuleDefinition, RulesViolation } from "../types.js";

// ── Diagram types ─────────────────────────────────────────────────────────────

export type MermaidDiagramType =
  | "sequenceDiagram"
  | "stateDiagram-v2"
  | "flowchart"
  | "unknown";

/** A directed edge parsed from any Mermaid diagram. */
export interface MermaidEdge {
  from: string;
  to: string;
  /** Human-readable label from the diagram (e.g. `login(credentials)`) */
  label: string;
  /**
   * Edge kind for sequence diagrams:
   *   `solid`  = solid arrow (->>, ->) — explicit call, yields must_call
   *   `dashed` = dashed arrow (-->>, -->) — response, not enforced
   */
  arrowKind?: "solid" | "dashed";
}

// ── Mermaid text loading ──────────────────────────────────────────────────────

/**
 * Load Mermaid diagram text from the `mermaid:` inline key or a referenced file.
 * Returns null if the diagram cannot be loaded.
 */
export function loadMermaidDiagram(
  rule: RuleDefinition,
  workspaceRoot: string,
): string | null {
  if (rule.mermaid) {
    return rule.mermaid;
  }

  if (rule.source?.type === "mermaid_file" && rule.source.file) {
    const mdPath = path.isAbsolute(rule.source.file)
      ? rule.source.file
      : path.join(workspaceRoot, rule.source.file);

    if (!fs.existsSync(mdPath)) return null;
    const content = fs.readFileSync(mdPath, "utf8");
    return extractMermaidBlock(content, rule.source.block_id);
  }

  return null;
}

/**
 * Extract the first (or named) Mermaid fenced block from a markdown file.
 * Named blocks are identified by an HTML comment anchor immediately before
 * the fence: `<!-- mermaid:auth-login-flow -->` or `<!-- auth-login-flow -->`.
 */
export function extractMermaidBlock(
  markdown: string,
  blockId?: string,
): string | null {
  // Match all ```mermaid ... ``` blocks with optional preceding anchor comments
  const blockPattern =
    /(?:<!--\s*(?:mermaid:)?([a-z0-9_-]+)\s*-->\s*\n)?```mermaid\s*\n([\s\S]*?)```/gi;

  let firstBlock: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(markdown)) !== null) {
    const anchorId = match[1] ?? null;
    const diagramText = match[2];

    if (!firstBlock) firstBlock = diagramText;

    if (blockId && anchorId === blockId) {
      return diagramText;
    }
  }

  // If no named block matched, return the first block found
  return blockId ? null : firstBlock;
}

// ── Diagram type detection ────────────────────────────────────────────────────

export function detectDiagramType(diagram: string): MermaidDiagramType {
  const firstLine = diagram
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
    ?.toLowerCase();

  if (!firstLine) return "unknown";
  if (firstLine.startsWith("sequencediagram")) return "sequenceDiagram";
  if (firstLine.startsWith("statediagram")) return "stateDiagram-v2";
  if (
    firstLine.startsWith("flowchart") ||
    firstLine.startsWith("graph ") ||
    firstLine.startsWith("graph\n")
  )
    return "flowchart";
  return "unknown";
}

// ── Sequence diagram parser ───────────────────────────────────────────────────

/**
 * Parse a sequenceDiagram into directed edges.
 *
 * Supported arrow types and their mapping:
 *   A->>B  A->B   A-)B   → solid (must_call candidate)
 *   A-->>B A-->B  A--)B  → dashed (response, not enforced)
 *   A-xB   A--xB          → failed/async, ignored for enforcement
 */
export function parseMermaidSequence(diagram: string): MermaidEdge[] {
  const edges: MermaidEdge[] = [];
  const participants = new Map<string, string>(); // alias → display name

  for (const rawLine of diagram.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) continue;

    // participant declaration: participant A as Auth Service
    const pMatch = line.match(
      /^(?:participant|actor)\s+(\w[\w\s]*?)(?:\s+as\s+(.+))?$/i,
    );
    if (pMatch) {
      const id = pMatch[1].trim();
      const alias = pMatch[2]?.trim() ?? id;
      participants.set(id, alias);
      continue;
    }

    // Arrow pattern: A(--?>?>|-->|--x|--))B: label
    // Groups: 1=from, 2=arrowBody, 3=to, 4=label
    const arrowMatch = line.match(
      /^([^\s\-]+)\s*(-{1,2}[>x)]{1,2})\s*([^\s:]+)\s*(?::\s*(.*))?$/,
    );
    if (!arrowMatch) continue;

    const [, rawFrom, arrow, rawTo, label = ""] = arrowMatch;
    const from = resolveParticipantName(rawFrom, participants);
    const to = resolveParticipantName(rawTo, participants);

    // Classify arrow kind
    const isDashed = arrow.startsWith("--");
    const arrowKind: MermaidEdge["arrowKind"] = isDashed ? "dashed" : "solid";

    edges.push({ from, to, label: label.trim(), arrowKind });
  }

  return edges;
}

function resolveParticipantName(
  raw: string,
  participants: Map<string, string>,
): string {
  return participants.get(raw) ?? raw;
}

// ── State diagram parser ──────────────────────────────────────────────────────

/**
 * Parse a stateDiagram-v2 into state transitions.
 * Returns edges where `from` and `to` are state names.
 * The `[*]` sentinel is preserved as-is.
 */
export function parseMermaidState(diagram: string): MermaidEdge[] {
  const edges: MermaidEdge[] = [];

  for (const rawLine of diagram.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%") || line.startsWith("//")) continue;
    if (/^stateDiagram/i.test(line)) continue;
    if (/^state\s+/i.test(line)) continue; // composite state declarations

    // A --> B : label
    const m = line.match(/^(\[?\*?\]?[\w\s[\]]+?)\s*-->\s*([\w\s[\]*]+?)(?:\s*:\s*(.+))?$/);
    if (!m) continue;
    const [, from, to, label = ""] = m;
    edges.push({
      from: from.trim(),
      to: to.trim(),
      label: label.trim(),
      arrowKind: "solid",
    });
  }

  return edges;
}

// ── Flowchart parser ──────────────────────────────────────────────────────────

/**
 * Parse a flowchart (TD/LR/etc.) into directed edges.
 * Handles: A --> B, A -->|label| B, A --- B, A ==> B, A -.-> B
 */
export function parseMermaidFlowchart(diagram: string): MermaidEdge[] {
  const edges: MermaidEdge[] = [];
  // node definitions: A[label], A(label), A{label}, A((label)) — extract just the id
  const nodeIdPattern = /^([A-Za-z0-9_]+)(?:\[.*\]|\(.*\)|\{.*\}|\(\(.*\)\))?$/;

  for (const rawLine of diagram.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) continue;
    if (/^(?:flowchart|graph)\s/i.test(line)) continue;
    if (/^subgraph\s/i.test(line) || line === "end") continue;

    // A --> B, A -->|label| B, A ==> B, A -.-> B
    const m = line.match(
      /^(.+?)\s*(?:-->|==>|-\.->|---)\|?([^|]*?)\|?\s*(.+)$/,
    );
    if (!m) continue;
    const [, rawFrom, label, rawTo] = m;
    const fromId = rawFrom.trim().match(nodeIdPattern)?.[1] ?? rawFrom.trim();
    const toId = rawTo.trim().match(nodeIdPattern)?.[1] ?? rawTo.trim();
    edges.push({ from: fromId, to: toId, label: label.trim(), arrowKind: "solid" });
  }

  return edges;
}

// ── Participant → file resolution ─────────────────────────────────────────────

/**
 * Resolve a Mermaid participant name to a set of file paths in the index.
 *
 * Resolution order (first match wins for each candidate):
 *   1. Exact symbol name match in `symbols` table
 *   2. Symbol name contains participant (case-insensitive)
 *   3. File path segment contains participant (case-insensitive, snake_case expansion)
 */
export function resolveParticipantToFiles(
  db: Database.Database,
  name: string,
): string[] {
  const slug = nameToSlug(name);

  // 1. Exact symbol name
  const exact = db
    .prepare<[string], { file_path: string }>(
      `SELECT DISTINCT file_path FROM symbols WHERE LOWER(name) = LOWER(?)`,
    )
    .all(name);

  if (exact.length > 0) return exact.map((r) => r.file_path);

  // 2. Symbol name contains slug  
  const bySymbol = db
    .prepare<{ slug: string }, { file_path: string }>(
      `SELECT DISTINCT file_path FROM symbols WHERE LOWER(name) LIKE '%' || LOWER(:slug) || '%'`,
    )
    .all({ slug });

  if (bySymbol.length > 0) return bySymbol.map((r) => r.file_path);

  // 3. File path segment contains slug
  const byFile = db
    .prepare<{ slug: string }, { path: string }>(
      `SELECT DISTINCT path FROM files WHERE LOWER(path) LIKE '%' || LOWER(:slug) || '%'`,
    )
    .all({ slug });

  return byFile.map((r) => r.path);
}

/** Convert a PascalCase / camelCase participant name to a slug for path matching. */
function nameToSlug(name: string): string {
  // "AuthService" → "authservice", "TokenStore" → "tokenstore"
  // Keeps simple: lowercase, strip spaces
  return name.toLowerCase().replace(/\s+/g, "");
}

// ── Import-graph helpers ──────────────────────────────────────────────────────

/**
 * Returns true if any file in `fromFiles` imports any file in `toFiles`
 * (direct import only — not transitive).
 */
function hasDirectImport(
  db: Database.Database,
  fromFiles: string[],
  toFiles: string[],
): { exists: boolean; fromFile: string; toFile: string } | false {
  if (fromFiles.length === 0 || toFiles.length === 0) return false;

  // Build placeholders
  const fromPlaceholders = fromFiles.map(() => "?").join(",");
  const toPlaceholders = toFiles.map(() => "?").join(",");

  const row = db
    .prepare<unknown[], { source_file: string; target_file: string }>(
      `SELECT i.source_file, i.target_file
       FROM imports i
       WHERE i.source_file IN (${fromPlaceholders})
         AND i.target_file IN (${toPlaceholders})
       LIMIT 1`,
    )
    .get([...fromFiles, ...toFiles]);

  if (!row) return false;
  return { exists: true, fromFile: row.source_file, toFile: row.target_file };
}

/**
 * Returns true if `fromFiles` contain any call to a symbol defined in `toFiles`.
 * Uses the `symbol_calls` table (Phase 4) — higher confidence than import presence.
 * Returns match details or false if no direct call is found.
 */
function hasDirectCall(
  db: Database.Database,
  fromFiles: string[],
  toFiles: string[],
): { exists: boolean; fromFile: string; callerLine: number | null; calleeName: string } | false {
  if (fromFiles.length === 0 || toFiles.length === 0) return false;

  // Resolve symbol names defined in toFiles
  const toSymRows = db
    .prepare<unknown[], { name: string }>(
      `SELECT DISTINCT name FROM symbols WHERE file_path IN (${toFiles.map(() => "?").join(",")})`,
    )
    .all(toFiles) as Array<{ name: string }>;

  if (toSymRows.length === 0) return false;

  const toNames = toSymRows.map((r) => r.name);
  const fromPh = fromFiles.map(() => "?").join(",");
  const namePh = toNames.map(() => "?").join(",");

  const row = db
    .prepare<
      unknown[],
      { caller_file: string; caller_line: number | null; callee_name: string }
    >(
      `SELECT caller_file, caller_line, callee_name
       FROM symbol_calls
       WHERE caller_file IN (${fromPh})
         AND callee_name IN (${namePh})
       LIMIT 1`,
    )
    .get([...fromFiles, ...toNames]) as
    | { caller_file: string; caller_line: number | null; callee_name: string }
    | undefined;

  if (!row) return false;
  return {
    exists: true,
    fromFile: row.caller_file,
    callerLine: row.caller_line,
    calleeName: row.callee_name,
  };
}

/**
 * Returns true if `fromFiles` have any calls recorded in the `symbol_calls` table.
 * Used to decide whether to trust the calls table or fall back to import-based checks.
 */
function hasCallsData(db: Database.Database, fromFiles: string[]): boolean {
  if (fromFiles.length === 0) return false;
  const ph = fromFiles.map(() => "?").join(",");
  const row = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM symbol_calls WHERE caller_file IN (${ph})`,
    )
    .get(fromFiles) as { cnt: number } | undefined;
  return (row?.cnt ?? 0) > 0;
}

// ── Sequence diagram enforcement ──────────────────────────────────────────────

/**
 * Derive and check behavioral violations from a sequence diagram.
 *
 * Phase 4 enforcement levels:
 * - Solid arrows (->>): `must_call` checks
 *   - With calls table data: confidence 0.95, mode: error (call graph is precise)
 *   - Fallback (no calls data): confidence 0.70, mode: warn (import-based)
 * - Implied forbidden edges: `must_not_call` checks
 *   Confidence: 0.85 (import absence is deterministic), mode: error
 */
function checkSequenceDiagram(
  db: Database.Database,
  rule: RuleDefinition,
  diagram: string,
  workspaceRoot: string,
  changed?: string[],
): RulesViolation[] {
  const edges = parseMermaidSequence(diagram);
  const violations: RulesViolation[] = [];

  // Solid edges = intended must_call (from → to is required via imports)
  const mustCallEdges = edges.filter((e) => e.arrowKind === "solid");

  // Collect all participants
  const participants = [
    ...new Set(edges.flatMap((e) => [e.from, e.to])),
  ];

  // Derive implied must_not_call:
  // For each participant P that has at least one solid outbound edge,
  // check all OTHER participants Q that P does NOT directly call.
  // But only flag (P→Q) if Q is reachable from some intermediary in the diagram
  // (i.e. bypassing the intended path matters).
  const mustNotCallPairs: Array<{ from: string; to: string }> = [];
  for (const from of participants) {
    const directTargets = new Set(
      mustCallEdges.filter((e) => e.from === from).map((e) => e.to),
    );
    // Targets reachable via intermediaries (P→M→T in the diagram, so P→T is a bypass)
    for (const from2 of participants) {
      if (from2 === from) continue;
      for (const e of mustCallEdges) {
        if (e.from !== from2) continue;
        const intermediaryTarget = e.to;
        // from→from2 is in diagram, from2→intermediaryTarget is in diagram
        // But if from→intermediaryTarget is NOT in diagram, flag it
        if (
          mustCallEdges.some((e2) => e2.from === from && e2.to === from2) &&
          !directTargets.has(intermediaryTarget) &&
          intermediaryTarget !== from
        ) {
          mustNotCallPairs.push({ from, to: intermediaryTarget });
        }
      }
    }
  }

  // Check must_call violations: Phase 4 — try calls table first, fall back to imports
  for (const edge of mustCallEdges) {
    const fromFiles = resolveParticipantToFiles(db, edge.from);
    const toFiles = resolveParticipantToFiles(db, edge.to);

    if (fromFiles.length === 0 || toFiles.length === 0) continue; // unresolved

    // Phase 4: check symbol_calls table for a direct call edge
    const directCall = hasDirectCall(db, fromFiles, toFiles);
    if (directCall) continue; // found — no violation

    const representativeFile = fromFiles[0];
    if (changed && !changed.some((c) => c === representativeFile)) continue;

    const callsPresent = hasCallsData(db, fromFiles);
    if (callsPresent) {
      // Calls data exists but no match — high-confidence violation
      violations.push({
        ruleId: rule.id,
        ruleSeverity: rule.severity,
        ruleDomain: "behavioral",
        ruleMode: rule.mode ?? "error", // promoted to error: call graph is precise
        ruleDescription: rule.description,
        adr: rule.adr,
        filePath: representativeFile,
        line: null,
        symbol: edge.from,
        detail: `[mermaid:must_call] "${edge.from}" never calls "${edge.to}" (confidence 0.95, call graph). Sequence diagram requires: "${edge.from} ->> ${edge.to}: ${edge.label}"`,
        confidence: 0.95,
        autofix: rule.autofix,
      });
    } else {
      // No calls data — fall back to import-based check (0.70, warn)
      const directImport = hasDirectImport(db, fromFiles, toFiles);
      if (!directImport) {
        violations.push({
          ruleId: rule.id,
          ruleSeverity: rule.severity,
          ruleDomain: "behavioral",
          ruleMode: rule.mode ?? "warn", // import-based: warn until calls table available
          ruleDescription: rule.description,
          adr: rule.adr,
          filePath: representativeFile,
          line: null,
          symbol: edge.from,
          detail: `[mermaid:must_call] Expected "${edge.from}" → "${edge.to}" call path not found in imports (confidence 0.70, import-based). Sequence diagram declares: "${edge.from} ->> ${edge.to}: ${edge.label}"`,
          confidence: 0.7,
          autofix: rule.autofix,
        });
      }
    }
  }

  // Check must_not_call violations: from-files should NOT import to-files
  for (const pair of mustNotCallPairs) {
    const fromFiles = resolveParticipantToFiles(db, pair.from);
    const toFiles = resolveParticipantToFiles(db, pair.to);

    if (fromFiles.length === 0 || toFiles.length === 0) continue;

    const found = hasDirectImport(db, fromFiles, toFiles);
    if (found) {
      // Direct import exists — this bypasses the declared sequence
      if (changed && !changed.some((c) => c === found.fromFile)) continue;

      violations.push({
        ruleId: rule.id,
        ruleSeverity: rule.severity,
        ruleDomain: "behavioral",
        ruleMode: rule.mode ?? "error", // must_not_call is deterministic — default error
        ruleDescription: rule.description,
        adr: rule.adr,
        filePath: found.fromFile,
        line: null,
        symbol: pair.from,
        detail: `[mermaid:must_not_call] "${pair.from}" imports "${pair.to}" directly, bypassing the declared sequence (confidence 0.85). Sequence diagram implies this path is not allowed.`,
        confidence: 0.85,
        autofix: rule.autofix,
      });
    }
  }

  return violations;
}

// ── State diagram enforcement ─────────────────────────────────────────────────

/**
 * Derive violations from a state diagram.
 * Checks that symbol names in the index match expected state transition patterns.
 * Confidence ~0.50 — limited without CFG; kept as mode: warn.
 */
function checkStateDiagram(
  db: Database.Database,
  rule: RuleDefinition,
  diagram: string,
  workspaceRoot: string,
  changed?: string[],
): RulesViolation[] {
  const transitions = parseMermaidState(diagram);
  if (transitions.length === 0) return [];

  const violations: RulesViolation[] = [];

  // Collect valid states
  const validStates = new Set<string>();
  for (const t of transitions) {
    if (t.from !== "[*]") validStates.add(t.from);
    if (t.to !== "[*]") validStates.add(t.to);
  }

  // Build set of valid (from, to) transitions
  const validPairs = new Set(
    transitions.map((t) => `${t.from}→${t.to}`),
  );

  // Look for enum/const symbols whose names match the state names in the index.
  // A symbol named "Pending", "Processing", "Fulfilled", etc. in the context of
  // the same file suggests the state machine is implemented there.
  const stateSymbols = db
    .prepare<unknown[], { name: string; file_path: string; line: number }>(
      `SELECT name, file_path, line FROM symbols
       WHERE kind IN ('property','const','variable','enum_member')
         AND name IN (${[...validStates].map(() => "?").join(",")})`,
    )
    .all([...validStates]);

  if (stateSymbols.length === 0) return []; // No state symbols found — skip

  // Group state symbols by file
  const fileToStates = new Map<string, string[]>();
  for (const sym of stateSymbols) {
    const list = fileToStates.get(sym.file_path) ?? [];
    list.push(sym.name);
    fileToStates.set(sym.file_path, list);
  }

  // For files that have ≥2 valid states (likely the state machine implementation),
  // report a notice-level violation if not all valid states appear.
  for (const [filePath, foundStates] of fileToStates) {
    if (foundStates.length < 2) continue;
    if (changed && !changed.includes(filePath)) continue;

    const missingStates = [...validStates].filter(
      (s) => !foundStates.includes(s),
    );
    if (missingStates.length > 0) {
      violations.push({
        ruleId: rule.id,
        ruleSeverity: rule.severity,
        ruleDomain: "behavioral",
        ruleMode: rule.mode ?? "warn",
        ruleDescription: rule.description,
        adr: rule.adr,
        filePath,
        line: null,
        symbol: undefined,
        detail: `[mermaid:valid_transition] State machine in this file appears to be missing states declared in diagram: ${missingStates.join(", ")}. Confidence 0.50 — verify manually.`,
        confidence: 0.5,
        autofix: rule.autofix,
      });
    }
  }

  return violations;
}

// ── Flowchart enforcement ─────────────────────────────────────────────────────

/**
 * Derive violations from a flowchart diagram.
 * Checks that the declared flow ordering is respected in the import graph
 * (precursor imports target — if not, a must_precede violation is raised).
 * Confidence ~0.30 — structural heuristic only; kept as mode: warn.
 */
function checkFlowchartDiagram(
  db: Database.Database,
  rule: RuleDefinition,
  diagram: string,
  workspaceRoot: string,
  changed?: string[],
): RulesViolation[] {
  const edges = parseMermaidFlowchart(diagram);
  if (edges.length === 0) return [];

  const violations: RulesViolation[] = [];

  // For each flowchart edge A→B, check that the component implementing B
  // is imported by something that also imports A (i.e. A precedes B in some file).
  // This is a very coarse structural check — the confidence is low.
  for (const edge of edges) {
    const fromFiles = resolveParticipantToFiles(db, edge.from);
    const toFiles = resolveParticipantToFiles(db, edge.to);

    if (fromFiles.length === 0 || toFiles.length === 0) continue;

    // Find any file that imports both A and B — if none, must_precede may be violated.
    const fromPlaceholders = fromFiles.map(() => "?").join(",");
    const toPlaceholders = toFiles.map(() => "?").join(",");

    const sharedImporter = db
      .prepare<unknown[], { source_file: string }>(
        `SELECT DISTINCT i1.source_file FROM imports i1
         JOIN imports i2 ON i1.source_file = i2.source_file
         WHERE i1.target_file IN (${fromPlaceholders})
           AND i2.target_file IN (${toPlaceholders})
         LIMIT 1`,
      )
      .get([...fromFiles, ...toFiles]);

    if (!sharedImporter) {
      // No file imports both — cannot verify must_precede order
      const representativeFile = fromFiles[0];
      if (changed && !changed.includes(representativeFile)) continue;

      violations.push({
        ruleId: rule.id,
        ruleSeverity: rule.severity,
        ruleDomain: "behavioral",
        ruleMode: rule.mode ?? "warn",
        ruleDescription: rule.description,
        adr: rule.adr,
        filePath: representativeFile,
        line: null,
        symbol: edge.from,
        detail: `[mermaid:must_precede] No file found that imports both "${edge.from}" and "${edge.to}" together — cannot verify that "${edge.from}" precedes "${edge.to}" in the execution path (confidence 0.30).`,
        confidence: 0.3,
        autofix: rule.autofix,
      });
    }
  }

  return violations;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Check behavioral violations derived from a Mermaid diagram rule.
 *
 * Called by `rulesCheck.ts` when `rule.source?.type` is `mermaid_inline` or
 * `mermaid_file` and `rule.domain === "behavioral"`.
 */
export function checkMermaidRule(
  db: Database.Database,
  rule: RuleDefinition,
  workspaceRoot: string,
  changed?: string[],
): RulesViolation[] {
  const diagram = loadMermaidDiagram(rule, workspaceRoot);
  if (!diagram) {
    // Cannot load diagram — emit a single config-error violation
    return [
      {
        ruleId: rule.id,
        ruleSeverity: rule.severity,
        ruleDomain: "behavioral",
        ruleMode: rule.mode ?? "warn",
        ruleDescription: rule.description,
        adr: rule.adr,
        filePath: rule.source?.file ?? "(unknown)",
        line: null,
        detail: `[mermaid] Could not load diagram for rule "${rule.id}". Check that source.file exists and contains a mermaid block.`,
        confidence: 1.0,
        autofix: rule.autofix,
      },
    ];
  }

  const diagramType = detectDiagramType(diagram);

  switch (diagramType) {
    case "sequenceDiagram":
      return checkSequenceDiagram(db, rule, diagram, workspaceRoot, changed);
    case "stateDiagram-v2":
      return checkStateDiagram(db, rule, diagram, workspaceRoot, changed);
    case "flowchart":
      return checkFlowchartDiagram(db, rule, diagram, workspaceRoot, changed);
    default:
      return []; // unknown diagram type — silently skip
  }
}
