// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: contextPack
 *
 * Composite context bundle for LLM injection. Runs several CARI signals in
 * one call — ranked files, symbols, architectural rules, cross-layer
 * connections, design rationale, and doc drift — then renders a
 * deterministic, token-budgeted markdown block ready for prompt injection.
 *
 * Empty sections are omitted from the output automatically.
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  ContextPackInput,
  ContextPackOutput,
  ContextPackFileEntry,
  ContextPackRuleEntry,
  ContextPackConnectionEntry,
  ContextPackRationaleEntry,
  ContextPackDriftEntry,
} from "../types.js";
import { openIndex } from "./shared.js";
import { retrieveFromDb } from "./retrieve.js";
import { connectionsFromDb } from "./connections.js";
import { checkFromDb } from "./check.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build a context pack, opening and closing the DB internally. */
export function contextPack(
  dbPath: string,
  input: ContextPackInput,
): ContextPackOutput {
  const db = openIndex(dbPath);
  try {
    return contextPackFromDb(db, input);
  } finally {
    db.close();
  }
}

/** Build a context pack against an already-open database handle. */
export function contextPackFromDb(
  db: Database.Database,
  input: ContextPackInput,
): ContextPackOutput {
  const budget = input.budget ?? 4000;
  const sections = input.sections ?? [
    "files",
    "symbols",
    "rules",
    "connections",
    "rationale",
    "drift",
  ];

  const query = input.query?.trim() ?? "";
  const anchorFiles = input.files ?? [];
  const anchorEntity = input.entity?.trim() ?? "";

  // ── 1. Ranked files ─────────────────────────────────────────────────────
  let files: ContextPackFileEntry[] = [];
  if (sections.includes("files")) {
    const effectiveQuery = query || anchorEntity;
    if (effectiveQuery) {
      const result = retrieveFromDb(db, { query: effectiveQuery, limit: 20 });
      files = result.files.map((f) => ({
        path: f.path,
        score: Math.round(f.score * 100) / 100,
        role: isDocFile(f.path) ? "doc" : "code",
        topSymbols: [],
        reason: f.reason,
      }));
    }
    // Always include anchor files at the top if not already present
    for (const af of anchorFiles) {
      if (!files.some((f) => f.path === af)) {
        files.unshift({
          path: af,
          score: 1.0,
          role: isDocFile(af) ? "doc" : "code",
          topSymbols: [],
          reason: "provided",
        });
      }
    }
    // Budget: keep top files that fit within ~40% of budget
    files = trimToChars(files, Math.floor(budget * 0.4 * 4), (f) =>
      formatFileLine(f),
    );
  }

  // Collect the set of context file paths for subsequent queries
  const contextPaths = new Set([
    ...files.map((f) => f.path),
    ...anchorFiles,
  ]);

  // ── 2. Symbols from context files ───────────────────────────────────────
  let symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    exported: boolean;
  }> = [];
  if (sections.includes("symbols") && contextPaths.size > 0) {
    const placeholders = Array.from(contextPaths)
      .map(() => "?")
      .join(",");
    const rows = db
      .prepare(
        `SELECT name, kind, file_path, line, export
         FROM symbols
         WHERE file_path IN (${placeholders})
           AND export = 'exported'
         ORDER BY file_path, line
         LIMIT 100`,
      )
      .all(...Array.from(contextPaths)) as Array<{
      name: string;
      kind: string;
      file_path: string;
      line: number;
      export: string;
    }>;

    // Annotate top symbols back onto files
    const symbolsByFile = new Map<string, string[]>();
    for (const row of rows) {
      const arr = symbolsByFile.get(row.file_path) ?? [];
      arr.push(row.name);
      symbolsByFile.set(row.file_path, arr);
    }
    for (const f of files) {
      f.topSymbols = (symbolsByFile.get(f.path) ?? []).slice(0, 5);
    }

    symbols = rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      file: r.file_path,
      line: r.line,
      exported: r.export === "exported",
    }));
    symbols = trimToChars(symbols, Math.floor(budget * 0.2 * 4), (s) =>
      `  ${s.name} (${s.kind}) — ${s.file}:${s.line}`,
    );
  }

  // ── 3. Architectural rules applicable to context files ──────────────────
  let rules: ContextPackRuleEntry[] = [];
  if (sections.includes("rules")) {
    try {
      rules = loadApplicableRules(db);
      rules = trimToChars(rules, Math.floor(budget * 0.15 * 4), (r) =>
        formatRuleLine(r),
      );
    } catch {
      // Rules are optional — skip if conformance table is absent or schema differs
    }
  }

  // ── 4. Cross-layer connections ───────────────────────────────────────────
  let connections: ContextPackConnectionEntry[] = [];
  if (sections.includes("connections")) {
    // Use top entity from retrieve result or explicit anchor
    const entityName =
      anchorEntity ||
      (files.find((f) => f.role === "code")?.topSymbols[0] ?? "");
    if (entityName) {
      try {
        const result = connectionsFromDb(db, {
          entity: entityName,
          limit: 15,
        });
        connections = [
          ...result.connections.map((c) => ({
            from: entityName,
            to: c.name,
            signal: c.sources[0]?.type ?? "doc_cooc",
            strength: Math.round((c.sources[0]?.score ?? 0) * 100) / 100,
            isGap: false,
          })),
          ...result.gaps.map((g) => ({
            from: entityName,
            to: g.entities[0] ?? g.description,
            signal: "doc_cooc",
            strength: 0,
            isGap: true,
          })),
        ];
        connections = trimToChars(
          connections,
          Math.floor(budget * 0.1 * 4),
          formatConnectionLine,
        );
      } catch {
        // Connections are optional — skip if entity not in index
      }
    }
  }

  // ── 5. Design rationale from context files ───────────────────────────────
  let rationale: ContextPackRationaleEntry[] = [];
  if (sections.includes("rationale") && contextPaths.size > 0) {
    const tableExists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='rationale'`,
      )
      .get();
    if (tableExists) {
      const placeholders = Array.from(contextPaths)
        .map(() => "?")
        .join(",");
      const rows = db
        .prepare(
          `SELECT file_path, line, kind, text FROM rationale
           WHERE file_path IN (${placeholders})
             AND kind IN ('WHY', 'DESIGN', 'NOTE')
           ORDER BY file_path, line
           LIMIT 30`,
        )
        .all(...Array.from(contextPaths)) as Array<{
        file_path: string;
        line: number;
        kind: string;
        text: string;
      }>;
      rationale = rows.map((r) => ({
        kind: r.kind,
        text: r.text,
        file: r.file_path,
        line: r.line,
      }));
      rationale = trimToChars(
        rationale,
        Math.floor(budget * 0.1 * 4),
        (r) => `  [${r.kind}] ${r.text} (${r.file}:${r.line})`,
      );
    }
  }

  // ── 6. Documentation drift for anchor files ─────────────────────────────
  let drift: ContextPackDriftEntry[] = [];
  if (sections.includes("drift") && anchorFiles.length > 0) {
    try {
      const result = checkFromDb(db, { changed: anchorFiles });
      // Deduplicate by docFile — group findings by the file they flag
      const seen = new Map<string, { severity: string; count: number }>();
      for (const f of result.findings) {
        const existing = seen.get(f.file);
        if (!existing) {
          seen.set(f.file, { severity: f.severity, count: 1 });
        } else {
          existing.count++;
        }
      }
      drift = Array.from(seen.entries()).map(([docFile, info]) => ({
        docFile,
        severity: info.severity,
        annotationCount: info.count,
      }));
      drift = trimToChars(drift, Math.floor(budget * 0.05 * 4), (d) =>
        `  ${d.severity.toUpperCase()} ${d.docFile} (${d.annotationCount} annotations)`,
      );
    } catch {
      // Drift is optional
    }
  }

  // ── 7. Render markdown summary ────────────────────────────────────────────
  const summary = renderMarkdown({
    query,
    anchorEntity,
    files,
    symbols,
    rules,
    connections,
    rationale,
    drift,
  });

  const tokenEstimate = Math.ceil(summary.length / 4);

  return {
    query,
    sections: {
      files,
      symbols,
      rules,
      connections,
      rationale,
      drift,
    },
    summary,
    tokenEstimate,
  };
}

// ---------------------------------------------------------------------------
// Rules loader (reads .iw/rules.yaml if present, falls back to DB scan)
// ---------------------------------------------------------------------------

function loadApplicableRules(db: Database.Database): ContextPackRuleEntry[] {
  // Check if rules_violations snapshot table exists (created by snapshotConformance)
  const snap = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='conformance_snapshots'`,
    )
    .get();

  if (!snap) return [];

  // Use most-recent snapshot
  const latest = db
    .prepare(
      `SELECT snapshot_id FROM conformance_snapshots ORDER BY timestamp DESC LIMIT 1`,
    )
    .get() as { snapshot_id: string } | undefined;
  if (!latest) return [];

  const rows = db
    .prepare(
      `SELECT rule_id, violation_count
       FROM conformance_snapshots
       WHERE snapshot_id = ?
       ORDER BY violation_count DESC`,
    )
    .all(latest.snapshot_id) as Array<{
    rule_id: string;
    violation_count: number;
  }>;

  return rows.map((r) => ({
    ruleId: r.rule_id,
    domain: "structural",
    severity: r.violation_count > 0 ? "high" : "info",
    description: r.rule_id,
    violations: r.violation_count,
  }));
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(data: {
  query: string;
  anchorEntity: string;
  files: ContextPackFileEntry[];
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    exported: boolean;
  }>;
  rules: ContextPackRuleEntry[];
  connections: ContextPackConnectionEntry[];
  rationale: ContextPackRationaleEntry[];
  drift: ContextPackDriftEntry[];
}): string {
  const parts: string[] = [];

  // Header
  const header =
    data.query
      ? `## CARI Context — "${data.query}"`
      : data.anchorEntity
        ? `## CARI Context — ${data.anchorEntity}`
        : `## CARI Context`;
  parts.push(header);
  parts.push("");

  // Files section
  if (data.files.length > 0) {
    parts.push("### Relevant Files");
    for (const f of data.files) {
      const symbols =
        f.topSymbols.length > 0 ? ` — ${f.topSymbols.join(", ")}` : "";
      const score = f.score < 1.0 ? ` (score: ${f.score})` : "";
      parts.push(`- \`${f.path}\`${score}${symbols}`);
    }
    parts.push("");
  }

  // Symbols section — only if not already implied by files list
  const uniqueSymbols = data.symbols.filter(
    (s) =>
      !data.files.some(
        (f) => f.topSymbols.includes(s.name) && f.path === s.file,
      ),
  );
  if (uniqueSymbols.length > 0) {
    parts.push("### Exported Symbols");
    for (const s of uniqueSymbols) {
      parts.push(`- \`${s.name}\` (${s.kind}) — \`${s.file}\`:${s.line}`);
    }
    parts.push("");
  }

  // Rules section — separate clean vs violated
  if (data.rules.length > 0) {
    const violated = data.rules.filter((r) => r.violations > 0);
    const clean = data.rules.filter((r) => r.violations === 0);

    if (violated.length > 0) {
      parts.push("### Active Violations");
      for (const r of violated) {
        parts.push(
          `- ✗ \`${r.ruleId}\` [${r.severity.toUpperCase()}] ${r.description} — ${r.violations} violation(s)`,
        );
      }
      parts.push("");
    }
    if (clean.length > 0) {
      parts.push("### Architecture Rules (clean)");
      for (const r of clean) {
        parts.push(`- ✓ \`${r.ruleId}\` [${r.severity}] ${r.description}`);
      }
      parts.push("");
    }
  }

  // Connections section
  if (data.connections.length > 0) {
    const gaps = data.connections.filter((c) => c.isGap);
    const linked = data.connections.filter((c) => !c.isGap);

    if (linked.length > 0) {
      parts.push("### Connections");
      for (const c of linked) {
        parts.push(
          `- \`${c.from}\` ↔ \`${c.to}\` via ${c.signal} (${c.strength})`,
        );
      }
      parts.push("");
    }
    if (gaps.length > 0) {
      parts.push("### ⚠ Hidden Coupling Gaps");
      for (const c of gaps) {
        parts.push(
          `- \`${c.from}\` ↔ \`${c.to}\` — mentioned together but no code link (${c.signal})`,
        );
      }
      parts.push("");
    }
  }

  // Rationale section
  if (data.rationale.length > 0) {
    parts.push("### Design Rationale");
    for (const r of data.rationale) {
      parts.push(
        `- [${r.kind}] ${r.text} (\`${r.file}\`:${r.line})`,
      );
    }
    parts.push("");
  }

  // Drift section
  if (data.drift.length > 0) {
    parts.push("### Documentation Drift");
    for (const d of data.drift) {
      parts.push(
        `- ${d.severity.toUpperCase()} \`${d.docFile}\` — ${d.annotationCount} annotation(s) reference changed code`,
      );
    }
    parts.push("");
  }

  return parts.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDocFile(p: string): boolean {
  return /\.(md|mdx|rst|txt|adoc)$/i.test(p);
}

function formatFileLine(f: ContextPackFileEntry): string {
  return `- \`${f.path}\` (${f.score})`;
}

function formatRuleLine(r: ContextPackRuleEntry): string {
  return `- ${r.ruleId} [${r.severity}] ${r.description}`;
}

function formatConnectionLine(c: ContextPackConnectionEntry): string {
  return `- ${c.from} ↔ ${c.to} (${c.signal})`;
}

/**
 * Trim an array to fit within a character budget.
 * Returns the largest prefix whose serialized lines fit in `charBudget`.
 */
function trimToChars<T>(
  items: T[],
  charBudget: number,
  toLine: (item: T) => string,
): T[] {
  let used = 0;
  const result: T[] = [];
  for (const item of items) {
    const cost = toLine(item).length + 1; // +1 for newline
    if (used + cost > charBudget && result.length > 0) break;
    result.push(item);
    used += cost;
  }
  return result;
}
