// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw index scan-diagrams — Discover architectural diagrams in markdown documents
 * and extract components + flows using an LLM.
 *
 * Supports:
 *   - Mermaid blocks (```mermaid ... ```)
 *   - ASCII art / unlabeled code blocks containing diagram characters
 *     (box-drawing chars, arrows, layer stacks, pipeline flows)
 *
 * This is a pure discovery command — it does NOT write to index.db.
 * Use it to understand what architecture information is encoded in your docs
 * before running arch-check or building a .iw/architecture.yaml.
 *
 * Usage:
 *   iw index scan-diagrams docs/                      # scan local docs/
 *   iw index scan-diagrams . --provider openai -v     # full workspace
 *   iw index scan-diagrams /path/to/other/project/docs --provider openai
 *
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  OpenAILLMProvider,
  SmartMockLLMProvider,
} from "@intentweave/plugin-llm";
import type { LLMProvider } from "@intentweave/core";
import type { ArchConfig, ArchComponent } from "@intentweave/index";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractedDiagram {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  kind: "mermaid" | "ascii-art";
  content: string;
}

export interface DiagramComponentEntry {
  name: string;
  /** Aliases / known code symbols for this component (LLM-provided). */
  aliases?: string[];
}

export interface DiagramComponents {
  filePath: string;
  lineStart: number;
  kind: "mermaid" | "ascii-art";
  components: DiagramComponentEntry[];
  flows: Array<{ from: string; to: string; label?: string }>;
  rawResponse?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagram extraction — pure markdown parsing, no LLM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regex patterns that indicate ASCII art diagram content (not prose or code).
 * A block must match at least one to be considered a diagram.
 */
const ASCII_DIAGRAM_PATTERNS = [
  /[┌─┐│└┘├┤┬┴┼╔═╗║╚╝╠╣╦╩╬]/u, // box-drawing characters
  /[→←↑↓↔↕▲▼◀▶⟶⟵⇒⟹]/u, // arrow characters
  /──+/, // horizontal rules as separators
  /\+[-+]+\+/, // ASCII box corners (+--+)
  /\|.+\|/, // ASCII table/box rows
  /\[.+\]\s*[-–—→=>]+\s*\[/, // [A] --> [B] style
  /\(.+\)\s*[-–—→=>]+\s*\(/, // (A) --> (B) style
  /<[-=]+>/, // <--> or <==>
];

const ASCII_DIAGRAM_MIN_LINES = 3;

/**
 * Determine if a code block looks like an architectural diagram.
 */
function isDiagramBlock(lang: string, content: string): boolean {
  if (lang === "mermaid") return true;
  if (lang !== "") return false; // labeled non-mermaid blocks: skip

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < ASCII_DIAGRAM_MIN_LINES) return false;

  return ASCII_DIAGRAM_PATTERNS.some((re) => re.test(content));
}

/**
 * Extract all diagram blocks from a markdown file.
 */
export function extractDiagrams(filePath: string): ExtractedDiagram[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const diagrams: ExtractedDiagram[] = [];

  let inBlock = false;
  let blockLang = "";
  let blockStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inBlock && /^`{3,4}/.test(line)) {
      // Opening fence
      const match = line.match(/^`{3,4}(\w*)/);
      blockLang = match?.[1] ?? "";
      blockStart = i;
      inBlock = true;
    } else if (inBlock && /^`{3,4}/.test(line)) {
      // Closing fence
      const blockContent = lines.slice(blockStart + 1, i).join("\n");

      if (isDiagramBlock(blockLang, blockContent)) {
        diagrams.push({
          filePath,
          lineStart: blockStart + 1, // 1-indexed
          lineEnd: i + 1,
          kind: blockLang === "mermaid" ? "mermaid" : "ascii-art",
          content: blockContent,
        });
      }

      inBlock = false;
      blockLang = "";
    }
  }

  return diagrams;
}

/**
 * Recursively discover all markdown files under the given paths.
 */
function discoverMarkdownFiles(inputPaths: string[]): string[] {
  const files: string[] = [];

  function walk(p: string): void {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      // Skip common non-doc directories
      const base = path.basename(p);
      if (["node_modules", ".git", "dist", "build", ".iw"].includes(base))
        return;
      for (const entry of fs.readdirSync(p)) {
        walk(path.join(p, entry));
      }
    } else if (p.endsWith(".md") || p.endsWith(".mdx")) {
      files.push(p);
    }
  }

  for (const p of inputPaths) {
    if (fs.existsSync(p)) walk(p);
  }

  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM interpretation
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an architecture extraction engine. Given a diagram (Mermaid or ASCII art) from a software architecture document, extract:
1. The architectural components (systems, services, modules, layers, stages) shown
2. The directed flows or dependencies between them
3. For each component: likely aliases — alternative names, lowercase variants, or probable code symbol names

Rules:
- Only include named architectural elements, not CLI flags, file paths, durations, or prose text
- Normalize component names to CamelCase or short uppercase acronyms (e.g. "KWG", "AuthService", "Neo4j")
- A flow is a directed dependency, data flow, or call relationship
- If the diagram is bidirectional, emit both directions as separate flows
- If you cannot determine direction, omit the flow
- For aliases: include the lowercase version, likely camelCase symbol name, and any expansion of acronyms visible in the diagram context (e.g. KWG → ["kwg", "keyword graph", "kwxStage"])
- Keep aliases short (1-4 per component), only include ones you are confident about
- Respond ONLY with valid JSON, no prose`;

const USER_PROMPT_TEMPLATE = (kind: string, content: string) => `
Diagram type: ${kind}

\`\`\`
${content}
\`\`\`

Extract components and flows. Return JSON in this exact schema:
{
  "components": [
    { "name": "ComponentA", "aliases": ["componentA", "component a"] },
    { "name": "ComponentB", "aliases": ["componentB"] }
  ],
  "flows": [
    { "from": "ComponentA", "to": "ComponentB", "label": "optional label" }
  ]
}
`;

interface LlmDiagramResult {
  components: Array<{ name: string; aliases?: string[] } | string>;
  flows: Array<{ from: string; to: string; label?: string }>;
}

async function interpretDiagramWithLlm(
  diagram: ExtractedDiagram,
  provider: LLMProvider,
): Promise<DiagramComponents> {
  const prompt = USER_PROMPT_TEMPLATE(diagram.kind, diagram.content);

  let raw: string;
  try {
    const response = await provider.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });
    raw = response.content;
  } catch (err: unknown) {
    return {
      filePath: diagram.filePath,
      lineStart: diagram.lineStart,
      kind: diagram.kind,
      components: [],
      flows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Strip markdown code fences if wrapped
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: LlmDiagramResult;
  try {
    parsed = JSON.parse(cleaned) as LlmDiagramResult;
  } catch {
    return {
      filePath: diagram.filePath,
      lineStart: diagram.lineStart,
      kind: diagram.kind,
      components: [],
      flows: [],
      rawResponse: raw,
      error: `JSON parse failed: ${cleaned.slice(0, 80)}`,
    };
  }

  // Normalise components — LLM may return strings (old format) or objects (new format)
  const components: DiagramComponentEntry[] = (parsed.components ?? [])
    .map((c) => {
      if (typeof c === "string") return { name: c };
      return {
        name: String(c.name ?? ""),
        aliases: Array.isArray(c.aliases)
          ? c.aliases.map(String).filter(Boolean)
          : undefined,
      };
    })
    .filter((c) => c.name.trim());

  return {
    filePath: diagram.filePath,
    lineStart: diagram.lineStart,
    kind: diagram.kind,
    components,
    flows: (parsed.flows ?? []).map((f) => ({
      from: String(f.from),
      to: String(f.to),
      label: f.label ? String(f.label) : undefined,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider factory (shared with indexEnrich.ts)
// ─────────────────────────────────────────────────────────────────────────────

function createLlmProvider(
  providerName: string,
  opts: { model?: string; apiKey?: string },
): LLMProvider {
  if (providerName === "openai") {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error(
        chalk.red(
          "OpenAI API key required. Set OPENAI_API_KEY or use --api-key.",
        ),
      );
      process.exit(1);
    }
    return new OpenAILLMProvider({
      apiKey,
      model: opts.model ?? process.env.IW_LLM_MODEL ?? "gpt-4o-mini",
    });
  }
  return new SmartMockLLMProvider({ workspaceKey: "scan-diagrams" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: build ArchConfig from scanned diagrams (reusable by arch-check)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 1;

interface ScanCacheFile {
  version: number;
  contentHash: string;
  scannedAt: string;
  result: ArchConfig;
}

/** Compute a stable hash over a sorted list of file paths + their contents. */
function computeInputHash(filePaths: string[]): string {
  const h = createHash("sha256");
  for (const fp of [...filePaths].sort()) {
    try {
      h.update(fp);
      h.update(fs.readFileSync(fp, "utf-8"));
    } catch {
      /* file disappeared between discovery and hash — skip */
    }
  }
  return h.digest("hex").slice(0, 24);
}

/** Default cache file path relative to cwd. */
const DEFAULT_CACHE_PATH = ".iw/arch-scan-cache.json";

function loadCache(cachePath: string, contentHash: string): ArchConfig | null {
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const entry = JSON.parse(raw) as ScanCacheFile;
    if (entry.version !== CACHE_VERSION) return null;
    if (entry.contentHash !== contentHash) return null;
    return entry.result;
  } catch {
    return null;
  }
}

function saveCache(
  cachePath: string,
  contentHash: string,
  result: ArchConfig,
): void {
  const entry: ScanCacheFile = {
    version: CACHE_VERSION,
    contentHash,
    scannedAt: new Date().toISOString(),
    result,
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2), "utf-8");
  } catch {
    /* non-fatal — cache write failure should not break the run */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanDiagramsOptions {
  provider?: string;
  model?: string;
  apiKey?: string;
  /** Only scan files matching these absolute paths / directories */
  paths?: string[];
  /** Suppress progress output */
  silent?: boolean;
  /**
   * Absolute or cwd-relative path to the cache file.
   * Defaults to `.iw/arch-scan-cache.json`. Pass `null` to disable caching.
   */
  cachePath?: string | null;
  /** When true, ignore any existing cache and always re-run LLM scan. */
  refresh?: boolean;
}

/**
 * Scan markdown files for diagrams, interpret via LLM, and return an ArchConfig.
 * Used directly by `arch-check --from-scan` so it shares the exact same logic.
 */
export async function buildArchConfigFromDiagrams(
  opts: ScanDiagramsOptions = {},
): Promise<ArchConfig> {
  const inputPaths = (opts.paths ?? ["."]).map((p) =>
    path.isAbsolute(p) ? p : path.resolve(process.cwd(), p),
  );
  const silent = opts.silent ?? false;
  const cacheEnabled = opts.cachePath !== null;
  const cachePath = cacheEnabled
    ? path.resolve(process.cwd(), opts.cachePath ?? DEFAULT_CACHE_PATH)
    : null;

  const mdFiles = discoverMarkdownFiles(inputPaths);
  if (mdFiles.length === 0)
    return { components: [], flows: [], constraints: [] };

  const allDiagrams: ExtractedDiagram[] = [];
  for (const f of mdFiles) allDiagrams.push(...extractDiagrams(f));
  if (allDiagrams.length === 0)
    return { components: [], flows: [], constraints: [] };

  // ── Cache check ──────────────────────────────────────────────────────────
  const contentHash = computeInputHash(mdFiles);
  if (cachePath && !opts.refresh) {
    const cached = loadCache(cachePath, contentHash);
    if (cached) {
      if (!silent) {
        console.log(
          chalk.green("  ✓ scan-diagrams: loaded from cache") +
            chalk.gray(
              ` (${cached.components.length} components, ${cached.flows?.length ?? 0} flows)`,
            ),
        );
      }
      return cached;
    }
  }

  const provider = createLlmProvider(opts.provider ?? "smart-mock", {
    model: opts.model,
    apiKey: opts.apiKey,
  });

  if (!silent) {
    console.log(
      chalk.gray(
        `  ▸ scan-diagrams: ${mdFiles.length} files, ${allDiagrams.length} diagrams`,
      ),
    );
  }

  const results: DiagramComponents[] = [];
  let idx = 0;
  for (const diagram of allDiagrams) {
    idx++;
    if (!silent) {
      const rel = path.relative(process.cwd(), diagram.filePath);
      process.stdout.write(
        `  [${idx}/${allDiagrams.length}] ${chalk.gray(rel)}:${diagram.lineStart}  `,
      );
    }
    const result = await interpretDiagramWithLlm(diagram, provider);
    results.push(result);
    if (!silent) {
      if (result.error) {
        console.log(chalk.red("✗ " + result.error));
      } else {
        console.log(
          chalk.green("✓") +
            ` ${result.components.length} components, ${result.flows.length} flows`,
        );
      }
    }
  }

  // Merge all diagram results into a single ArchConfig
  // Components keyed by name; aliases are merged across diagrams (a component
  // may appear in multiple diagrams with slightly different alias suggestions).
  const componentMap = new Map<string, Set<string>>(); // name → alias set
  const flowKeys = new Set<string>();
  const flows: ArchConfig["flows"] = [];

  for (const r of results) {
    for (const c of r.components) {
      if (!c.name.trim()) continue;
      if (!componentMap.has(c.name)) componentMap.set(c.name, new Set());
      for (const alias of c.aliases ?? []) {
        if (alias.trim())
          componentMap.get(c.name)!.add(alias.trim().toLowerCase());
      }
    }
    for (const f of r.flows) {
      const key = `${f.from}::${f.to}`;
      if (!flowKeys.has(key)) {
        flowKeys.add(key);
        flows.push({ from: f.from, to: f.to });
      }
    }
  }

  const components: ArchComponent[] = Array.from(componentMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, aliasSet]) => ({
      name,
      files: [],
      aliases: aliasSet.size > 0 ? Array.from(aliasSet) : undefined,
    }));

  const archConfig: ArchConfig = { components, flows, constraints: [] };

  // ── Persist to cache ──────────────────────────────────────────────────────
  if (cachePath) {
    saveCache(cachePath, contentHash, archConfig);
    if (!silent) {
      const rel = path.relative(process.cwd(), cachePath);
      console.log(chalk.gray(`  ▸ scan result cached → ${rel}`));
    }
  }

  return archConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI command
// ─────────────────────────────────────────────────────────────────────────────

export const indexScanDiagramsSubcommand = new Command("scan-diagrams")
  .description(
    "Discover architectural diagrams in markdown documents and extract components + flows via LLM",
  )
  .argument("[paths...]", "Paths to scan (files or directories, default: .)")
  .option(
    "--provider <name>",
    "LLM provider: openai or smart-mock (default: smart-mock)",
    "smart-mock",
  )
  .option("--model <name>", "LLM model to use (default: gpt-4o-mini)")
  .option("--api-key <key>", "OpenAI API key (overrides OPENAI_API_KEY)")
  .option(
    "--dry-run",
    "Discover diagrams but do not call the LLM — just print locations",
    false,
  )
  .option("-v, --verbose", "Show raw LLM responses and errors", false)
  .action(async (inputPaths: string[], opts) => {
    const cwd = process.cwd();
    const paths = (inputPaths.length > 0 ? inputPaths : ["."]).map((p) =>
      path.resolve(cwd, p),
    );

    console.log(chalk.blue("\n  ▸ CARI Diagram Scanner"));
    console.log(chalk.gray(`  ▸ paths: ${paths.join(", ")}\n`));

    // ── 1. Discover markdown files ────────────────────────────────────────────
    const mdFiles = discoverMarkdownFiles(paths);
    if (mdFiles.length === 0) {
      console.log(chalk.yellow("  No markdown files found.\n"));
      return;
    }
    console.log(chalk.gray(`  Found ${mdFiles.length} markdown file(s)\n`));

    // ── 2. Extract diagrams ────────────────────────────────────────────────────
    const allDiagrams: ExtractedDiagram[] = [];
    for (const f of mdFiles) {
      const diagrams = extractDiagrams(f);
      allDiagrams.push(...diagrams);
    }

    if (allDiagrams.length === 0) {
      console.log(chalk.yellow("  No diagrams found in the scanned files."));
      console.log(
        chalk.gray(
          "  Diagrams are detected as: Mermaid blocks (```mermaid) or\n" +
            "  unlabeled code blocks containing box-drawing chars / arrows.\n",
        ),
      );
      return;
    }

    // Group by file for display
    const byFile = new Map<string, ExtractedDiagram[]>();
    for (const d of allDiagrams) {
      if (!byFile.has(d.filePath)) byFile.set(d.filePath, []);
      byFile.get(d.filePath)!.push(d);
    }

    // Print discovery summary
    console.log(
      `  ${chalk.green("✓")} Found ${chalk.bold(String(allDiagrams.length))} diagram(s) in ${byFile.size} file(s)\n`,
    );
    for (const [file, diags] of byFile) {
      const rel = path.relative(cwd, file);
      for (const d of diags) {
        const kindLabel =
          d.kind === "mermaid"
            ? chalk.cyan("mermaid")
            : chalk.yellow("ascii-art");
        console.log(
          `  ${chalk.gray(rel)}  ${kindLabel}  (lines ${d.lineStart}–${d.lineEnd})`,
        );
        if (opts.verbose) {
          console.log(
            chalk.gray(
              d.content
                .split("\n")
                .slice(0, 6)
                .map((l) => "    " + l)
                .join("\n"),
            ),
          );
          if (d.content.split("\n").length > 6)
            console.log(chalk.gray("    ..."));
        }
      }
    }

    if (opts.dryRun) {
      console.log(
        chalk.gray("\n  Dry-run mode: skipping LLM interpretation.\n"),
      );
      return;
    }

    // ── 3. LLM interpretation ─────────────────────────────────────────────────
    const provider = createLlmProvider(opts.provider, {
      model: opts.model,
      apiKey: opts.apiKey,
    });

    console.log(
      `\n  ${chalk.blue("▸")} Interpreting diagrams with LLM (provider: ${opts.provider})...\n`,
    );

    const results: DiagramComponents[] = [];
    let idx = 0;
    for (const diagram of allDiagrams) {
      idx++;
      const rel = path.relative(cwd, diagram.filePath);
      process.stdout.write(
        `  [${idx}/${allDiagrams.length}] ${chalk.gray(rel)}:${diagram.lineStart}  `,
      );

      const result = await interpretDiagramWithLlm(diagram, provider);
      results.push(result);

      if (result.error) {
        console.log(chalk.red("✗ " + result.error));
        if (opts.verbose && result.rawResponse) {
          console.log(chalk.gray("  Raw: " + result.rawResponse.slice(0, 200)));
        }
      } else {
        console.log(
          chalk.green("✓") +
            ` ${result.components.length} components, ${result.flows.length} flows`,
        );
      }
    }

    // ── 4. Summary ────────────────────────────────────────────────────────────
    const allComponents = new Set<string>();
    const allFlowKeys = new Set<string>();
    const allFlows: Array<{ from: string; to: string; label?: string }> = [];

    for (const r of results) {
      for (const c of r.components) allComponents.add(c.name);
      for (const f of r.flows) {
        const key = `${f.from}→${f.to}`;
        if (!allFlowKeys.has(key)) {
          allFlowKeys.add(key);
          allFlows.push(f);
        }
      }
    }

    console.log(`\n  ${chalk.bold("Summary")}`);
    console.log(`  ${"─".repeat(50)}`);
    console.log(
      `  ${chalk.green(String(allComponents.size))} unique components  ` +
        `${chalk.green(String(allFlows.length))} unique flows  ` +
        `across ${allDiagrams.length} diagram(s)\n`,
    );

    if (allComponents.size > 0) {
      console.log(`  ${chalk.bold("Components:")}`);
      const sorted = Array.from(allComponents).sort((a, b) =>
        a.localeCompare(b),
      );
      for (let i = 0; i < sorted.length; i += 4) {
        const row = sorted
          .slice(i, i + 4)
          .map((c) => c.padEnd(20))
          .join("  ");
        console.log(`    ${chalk.cyan(row)}`);
      }
    }

    if (allFlows.length > 0) {
      console.log(`\n  ${chalk.bold("Flows:")}`);
      for (const f of allFlows) {
        const label = f.label ? chalk.gray(` (${f.label})`) : "";
        console.log(
          `    ${chalk.cyan(f.from)}  →  ${chalk.cyan(f.to)}${label}`,
        );
      }
    }

    // Per-file breakdown
    console.log(`\n  ${chalk.bold("By file:")}`);
    for (const r of results) {
      if (r.error) continue;
      const rel = path.relative(cwd, r.filePath);
      console.log(`\n  ${chalk.gray(rel)}  (line ${r.lineStart})`);
      if (r.components.length > 0) {
        console.log(
          `    components: ${r.components.map((c) => chalk.cyan(c)).join(", ")}`,
        );
      }
      if (r.flows.length > 0) {
        for (const f of r.flows) {
          const label = f.label ? chalk.gray(` [${f.label}]`) : "";
          console.log(
            `    ${chalk.cyan(f.from)} → ${chalk.cyan(f.to)}${label}`,
          );
        }
      }
    }

    console.log();
  });
