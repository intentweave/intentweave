// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Preflight Document Health — Lightweight, zero-dependency doc health analysis.
 *
 * Runs without Neo4j or any LLM pipeline. Uses only:
 *   1. Markdown parsing to extract candidate entity names (headings, bold, code spans, etc.)
 *   2. Keyword indexing to check if those names appear in source files.
 *
 * Use cases:
 *   - Pre-flight check before running the full `iw run` pipeline
 *   - CI gate that needs no infrastructure
 *   - Quick sanity check for any markdown repo
 *
 * Entities are extracted heuristically from markdown structure:
 *   - H1–H4 headings (stripped of markdown formatting)
 *   - **Bold** phrases (strong emphasis)
 *   - `Code spans` (backtick-wrapped terms)
 *   - Capitalized multi-word phrases (e.g., "Auth Service", "Rate Limiter")
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanKeywordNames as indexKeywordsInCodebase } from "./keywordScanner.js";

// =============================================================================
// Inline helpers (originally from docHealthAnalyzer.ts)
// =============================================================================

const PLANNING_DOC_PATTERNS = [
  /roadmap/i, /plan/i, /implementation[-_]plan/i, /backlog/i, /todo/i,
  /rfc/i, /proposal/i, /adr/i, /future/i, /next[-_]?steps/i, /strategy/i,
];
const PLANNED_ENTITY_TYPES = new Set(["phase", "requirement", "feature", "question", "tradeoff", "risk"]);
const CONCRETE_ENTITY_TYPES = new Set(["technology", "component", "resource"]);

function classifyOrphanedEntity(entityType: string, sourceDocPath: string): "stale" | "planned" | "unknown" {
  const isPlannedType = PLANNED_ENTITY_TYPES.has(entityType.toLowerCase());
  const isConcreteType = CONCRETE_ENTITY_TYPES.has(entityType.toLowerCase());
  const isFromPlanningDoc = PLANNING_DOC_PATTERNS.some((re) => re.test(sourceDocPath));
  if (isFromPlanningDoc && isPlannedType) return "planned";
  if (isFromPlanningDoc) return "planned";
  if (isConcreteType && !isFromPlanningDoc) return "stale";
  if (isPlannedType) return "planned";
  return "unknown";
}

// =============================================================================
// Types
// =============================================================================

/** A candidate entity extracted from markdown text. */
export interface MarkdownEntity {
  /** Extracted name */
  name: string;
  /** How it was found */
  source: "heading" | "bold" | "code-span" | "capitalized";
}

/** Preflight report for a single document. */
export interface PreflightDocReport {
  filePath: string;
  /** Candidate entity names extracted from the document */
  entities: MarkdownEntity[];
  /** Names found in at least one source file */
  groundedNames: string[];
  /** Names not found in any source file */
  floatingNames: string[];
  /** Percentage of entities found in code (0-100) */
  groundingPercent: number;
  /** Classification hints for floating entities */
  floatingDetails: Array<{
    name: string;
    source: string;
    likelyStatus: "stale" | "planned" | "unknown";
  }>;
}

/** Full preflight result. */
export interface PreflightResult {
  /** Documents analyzed */
  reports: PreflightDocReport[];
  /** Aggregate stats */
  stats: {
    docsAnalyzed: number;
    totalEntities: number;
    groundedCount: number;
    floatingCount: number;
    avgGroundingPercent: number;
  };
}

export interface PreflightOptions {
  /** Document file paths to analyze */
  files: string[];
  /** Working directory (for resolving file paths and scanning source code) */
  cwd: string;
  /** Optional log callback */
  log?: (msg: string) => void;
  /** File extensions to consider as "documents" when scanning directories */
  docExtensions?: string[];
}

// =============================================================================
// Markdown entity extraction
// =============================================================================

/**
 * Extract candidate entity names from a markdown string.
 *
 * Sources:
 *   - **Headings** (H1–H4): text after `#`, stripped of formatting
 *   - **Bold phrases**: text within `**...**` or `__...__`
 *   - **Code spans**: text within backticks (single) — filtered to ≥2 words or PascalCase
 *   - **Capitalized phrases**: sequences of 2–5 capitalized words (e.g., "Auth Service")
 *
 * Deduplication is by lowercased name; first occurrence wins.
 */
export function extractMarkdownEntities(markdown: string): MarkdownEntity[] {
  const seen = new Set<string>();
  const entities: MarkdownEntity[] = [];

  function add(name: string, source: MarkdownEntity["source"]): void {
    const trimmed = name.trim();
    if (trimmed.length < 3) return;
    // Skip common markdown / natural-language noise
    if (NOISE_WORDS.has(trimmed.toLowerCase())) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ name: trimmed, source });
  }

  // ── Headings (H1–H4) ──────────────────────────────────────────────
  const headingRe = /^#{1,4}\s+(.+)$/gm;
  for (const match of markdown.matchAll(headingRe)) {
    // Strip inline markdown (bold, code, links)
    const cleaned = stripInlineMarkdown(match[1]);
    if (cleaned.length >= 3) {
      add(cleaned, "heading");
    }
  }

  // ── Bold phrases (**text** or __text__) ────────────────────────────
  const boldRe = /\*\*([^*]+?)\*\*|__([^_]+?)__/g;
  for (const match of markdown.matchAll(boldRe)) {
    const text = match[1] ?? match[2];
    if (text) add(text, "bold");
  }

  // ── Code spans (`text`) — only meaningful ones ─────────────────────
  const codeSpanRe = /`([^`\n]+?)`/g;
  for (const match of markdown.matchAll(codeSpanRe)) {
    const text = match[1].trim();
    // Keep PascalCase identifiers, multi-word, or typical entity names
    if (
      isPascalCase(text) ||
      text.includes("-") ||
      text.includes("_") ||
      /^[A-Z]/.test(text)
    ) {
      add(text, "code-span");
    }
  }

  // ── Capitalized multi-word phrases ─────────────────────────────────
  // Match sequences of 2-5 consecutive capitalized words
  const capRe = /(?<![#*`\[])\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g;
  for (const match of markdown.matchAll(capRe)) {
    add(match[1], "capitalized");
  }

  return entities;
}

/** Strip inline markdown formatting from a string. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/__(.+?)__/g, "$1") // bold alt
    .replace(/\*(.+?)\*/g, "$1") // italic
    .replace(/_(.+?)_/g, "$1") // italic alt
    .replace(/`(.+?)`/g, "$1") // code span
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .trim();
}

/** Check if a string is PascalCase (e.g., "AuthService", "Neo4j"). */
function isPascalCase(s: string): boolean {
  return /^[A-Z][a-zA-Z0-9]+$/.test(s) && /[a-z]/.test(s);
}

/** Common noise words to skip. */
const NOISE_WORDS = new Set([
  // English noise
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "its",
  "let",
  "say",
  "she",
  "too",
  "use",
  "how",
  "why",
  "see",
  "now",
  "way",
  "may",
  "also",
  "then",
  "than",
  "that",
  "this",
  "with",
  "will",
  "each",
  "make",
  "like",
  "from",
  "have",
  "been",
  "just",
  "more",
  "over",
  "such",
  "note",
  "todo",
  "done",
  "here",
  "true",
  "false",
  "null",
  "undefined",
  // Markdown noise
  "table",
  "example",
  "summary",
  "overview",
  "introduction",
  "conclusion",
  "appendix",
  "references",
  "changelog",
  "version",
  "status",
  "usage",
  "setup",
  "install",
  "getting started",
  "quick start",
  "prerequisites",
  "important",
  "warning",
  "deprecated",
]);

// =============================================================================
// Preflight analysis
// =============================================================================

/**
 * Run a lightweight, zero-infrastructure doc health check.
 *
 * 1. Read each markdown file and extract candidate entity names.
 * 2. Build a keyword index from source files in the cwd.
 * 3. Report which entity names are grounded (found in code) vs floating.
 *
 * No Neo4j or LLM required.
 */
export async function preflightDocHealth(
  options: PreflightOptions,
): Promise<PreflightResult> {
  const {
    files,
    cwd,
    log = () => {},
    docExtensions = [".md", ".mdx"],
  } = options;

  // Step 1: resolve document paths
  let docPaths: string[] = [];
  for (const f of files) {
    const full = path.isAbsolute(f) ? f : path.resolve(cwd, f);
    try {
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        // Scan directory for markdown files
        const found = await findMarkdownFiles(full, docExtensions);
        docPaths.push(...found.map((fp) => path.relative(cwd, fp)));
      } else {
        docPaths.push(path.relative(cwd, full));
      }
    } catch {
      // File doesn't exist — skip
      log(`Warning: ${f} not found, skipping`);
    }
  }

  // Deduplicate
  docPaths = [...new Set(docPaths)];
  log(`Preflight: found ${docPaths.length} document(s)`);

  if (docPaths.length === 0) {
    return {
      reports: [],
      stats: {
        docsAnalyzed: 0,
        totalEntities: 0,
        groundedCount: 0,
        floatingCount: 0,
        avgGroundingPercent: 100,
      },
    };
  }

  // Step 2: extract entities from each document
  const docEntities: Array<{ filePath: string; entities: MarkdownEntity[] }> =
    [];
  const allNames = new Set<string>();

  for (const docPath of docPaths) {
    const fullPath = path.resolve(cwd, docPath);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const entities = extractMarkdownEntities(content);
      docEntities.push({ filePath: docPath, entities });
      for (const e of entities) {
        allNames.add(e.name);
      }
      log(`  ${docPath}: ${entities.length} candidate entities`);
    } catch {
      log(`  Warning: cannot read ${docPath}`);
    }
  }

  // Step 3: build keyword index from codebase source files
  log("Preflight: scanning codebase for keyword matches…");
  const keywordIndex = await indexKeywordsInCodebase(cwd, [...allNames], log);

  // Step 4: build per-document reports
  const reports: PreflightDocReport[] = [];

  for (const { filePath, entities } of docEntities) {
    const names = entities.map((e) => e.name);
    const unique = [...new Set(names)];
    const groundedNames = unique.filter((n) => keywordIndex.has(n));
    const floatingNames = unique.filter((n) => !keywordIndex.has(n));

    const groundingPercent =
      unique.length > 0
        ? Math.round((groundedNames.length / unique.length) * 100)
        : 100;

    const floatingDetails = floatingNames.map((name) => {
      const entity = entities.find((e) => e.name === name);
      // Infer entity type from source for the heuristic
      const inferredType = inferEntityType(name, entity?.source ?? "bold");
      return {
        name,
        source: entity?.source ?? "unknown",
        likelyStatus: classifyOrphanedEntity(inferredType, filePath),
      };
    });

    reports.push({
      filePath,
      entities,
      groundedNames,
      floatingNames,
      groundingPercent,
      floatingDetails,
    });
  }

  // Step 5: aggregate stats
  const totalEntities = reports.reduce(
    (sum, r) => sum + new Set(r.entities.map((e) => e.name)).size,
    0,
  );
  const groundedCount = reports.reduce(
    (sum, r) => sum + r.groundedNames.length,
    0,
  );
  const floatingCount = reports.reduce(
    (sum, r) => sum + r.floatingNames.length,
    0,
  );
  const avgGroundingPercent =
    reports.length > 0
      ? Math.round(
          reports.reduce((sum, r) => sum + r.groundingPercent, 0) /
            reports.length,
        )
      : 100;

  return {
    reports,
    stats: {
      docsAnalyzed: reports.length,
      totalEntities,
      groundedCount,
      floatingCount,
      avgGroundingPercent,
    },
  };
}

/**
 * Infer a rough entity type from a markdown extraction source.
 * Used for the likelyStatus heuristic when no KG type is available.
 */
function inferEntityType(
  name: string,
  source: MarkdownEntity["source"],
): string {
  // Code spans that look like identifiers → component/technology
  if (source === "code-span") {
    if (isPascalCase(name)) return "component";
    if (name.includes("-") || name.includes("_")) return "technology";
    return "component";
  }
  // Headings are usually concepts or sections
  if (source === "heading") return "concept";
  // Capitalized phrases → concept
  if (source === "capitalized") return "concept";
  // Bold → concept
  return "concept";
}

/** Recursively find markdown files in a directory. */
async function findMarkdownFiles(
  dir: string,
  extensions: string[],
): Promise<string[]> {
  const results: string[] = [];
  const IGNORE = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".iw",
    "coverage",
  ]);

  async function scan(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await scan(dir);
  return results;
}

// =============================================================================
// Formatters
// =============================================================================

/**
 * Format preflight results as markdown for human consumption.
 */
export function formatPreflightMarkdown(result: PreflightResult): string {
  const lines: string[] = [];
  const { stats, reports } = result;

  lines.push("# 🔍 Preflight Doc Health (Keyword-Only)");
  lines.push("");
  lines.push(
    "_No KG or LLM required — entities extracted from markdown structure, grounded via codebase keyword scan._",
  );
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Documents scanned | ${stats.docsAnalyzed} |`);
  lines.push(`| Candidate entities | ${stats.totalEntities} |`);
  lines.push(`| Grounded in code | ${stats.groundedCount} |`);
  lines.push(`| Floating (not in code) | ${stats.floatingCount} |`);
  lines.push(`| Avg grounding | ${stats.avgGroundingPercent}% |`);
  lines.push("");

  // Per-doc reports (worst first)
  const sorted = [...reports].sort(
    (a, b) => a.groundingPercent - b.groundingPercent,
  );

  for (const report of sorted) {
    const icon =
      report.groundingPercent >= 80
        ? "✅"
        : report.groundingPercent >= 50
          ? "⚠️"
          : "🔴";
    lines.push(`### ${icon} ${report.filePath}`);
    lines.push("");
    lines.push(
      `**Grounding:** ${report.groundingPercent}% (${report.groundedNames.length}/${report.groundedNames.length + report.floatingNames.length} terms found in code)`,
    );
    lines.push("");

    if (report.floatingNames.length > 0) {
      lines.push("**Floating entities** (not found in source files):");
      lines.push("");
      for (const detail of report.floatingDetails) {
        const badge =
          detail.likelyStatus === "planned"
            ? "🟢 planned"
            : detail.likelyStatus === "stale"
              ? "🔴 stale"
              : "⚪ unknown";
        lines.push(`- \`${detail.name}\` — ${badge} (from: ${detail.source})`);
      }
      lines.push("");
    }

    if (report.groundedNames.length > 0 && report.groundedNames.length <= 15) {
      lines.push(
        `**Grounded:** ${report.groundedNames.map((n) => `\`${n}\``).join(", ")}`,
      );
      lines.push("");
    }
  }

  // Tips
  lines.push("---");
  lines.push(
    "_This is a lightweight pre-check. For full analysis with KG-backed staleness, drift, and contradiction detection, run `iw doc-health -s <session>`._",
  );
  lines.push(
    "_Floating entities may be planned features, not yet integrated concepts, or genuinely stale references._",
  );

  return lines.join("\n");
}

/**
 * Format preflight results for agent / MCP consumption (markdown + JSON).
 */
export function formatPreflightForAgent(result: PreflightResult): string {
  const markdown = formatPreflightMarkdown(result);

  const structured = {
    mode: "preflight-keyword-only",
    stats: result.stats,
    documents: Object.fromEntries(
      result.reports.map((r) => [
        r.filePath,
        {
          groundingPercent: r.groundingPercent,
          groundedNames: r.groundedNames,
          floatingEntities: r.floatingDetails,
        },
      ]),
    ),
  };

  const agentBlock = [
    "",
    "---",
    "",
    "## 🤖 Structured Preflight Data (for agent reasoning)",
    "",
    "This is a **keyword-only** analysis (no KG). `likelyStatus` is a heuristic based on entity type and document path:",
    "- **planned**: from a planning/roadmap doc, or an aspirational entity type (feature, phase, requirement)",
    "- **stale**: concrete type (technology, component) from a non-planning doc, not found in source code",
    "- **unknown**: ambiguous — run the full `iw doc-health -s <session>` for KG-backed analysis",
    "",
    "```json",
    JSON.stringify(structured, null, 2),
    "```",
    "",
    "**Next steps for agent:**",
    "- Review `stale` items → likely candidates for removal or update",
    "- Review `planned` items → verify they belong in the document's scope",
    "- Run `iw run <docs> --track open -i` to build the full KG for deeper analysis",
  ];

  return markdown + "\n" + agentBlock.join("\n");
}
