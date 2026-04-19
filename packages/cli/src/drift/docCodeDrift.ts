// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Doc ↔ Code Drift Detector
 *
 * Compares KWG (keyword mention graph from docs) against AX (AST extraction
 * from code) to detect disconnections:
 *
 *   1. **Ungrounded mentions** — KWG entity appears in docs but no matching
 *      code symbol exists. Likely: renamed, deleted, or speculative.
 *
 *   2. **Undocumented code** — Code symbol (exported) exists but has no
 *      matching KWG entity in docs. Likely: missing documentation.
 *
 * Uses heuristic name matching (exact, slug, token-overlap) — no LLM.
 * Produces structured DriftReport for CLI rendering and UI visualization.
 *
 * @see LAYERED-GRAPH-ARCHITECTURE.md §4.7.1
 * @version 0.1
 */

import type { AxOutput, AxSymbol } from "@intentweave/analyzer";
import type {
  DriftSignal,
  DriftSeverity,
  DriftCategory,
  DriftEvidence,
  DocCodeDriftOutput,
  DetectorStats,
  KwgMentionForDrift,
} from "@intentweave/core";

// =============================================================================
// Types (local — backward compat wrappers)
// =============================================================================

// Re-export unified types for downstream consumers
export type { DriftSignal, DriftSeverity, DriftCategory };

export interface DriftReport {
  /** Session analyzed */
  session: string;
  /** Workspace root for code scan */
  workspaceRoot: string;
  /** All drift signals */
  signals: DriftSignal[];
  /** Summary counts */
  stats: {
    ungroundedCount: number;
    undocumentedCount: number;
    signatureMismatchCount: number;
    totalKwgEntities: number;
    totalCodeSymbols: number;
    matchedCount: number;
    durationMs: number;
  };
}

export interface DocCodeDriftOptions {
  /** Minimum KWG mention count to consider an entity significant (default: 2) */
  minMentions?: number;
  /** Only consider exported code symbols (default: true) */
  exportedOnly?: boolean;
  /** Code symbol kinds to compare (default: function, class, interface, type, enum) */
  codeKinds?: string[];
  /** Token overlap threshold for near-match detection (default: 0.5) */
  nearMatchThreshold?: number;
  /** Enable signature-mismatch detection (default: true) */
  signatureCheck?: boolean;
  /** Log callback */
  log?: (msg: string) => void;
}

// =============================================================================
// Neo4j KWG Types
// =============================================================================

interface KwgEntity {
  name: string;
  mentionCount: number;
  qualifiers: string[];
  filePaths: string[];
  predominantSource: string;
}

interface KwgMention {
  entityName: string;
  text: string;
  heading: string;
  filePath: string;
  startLine: number;
}

/** A matched pair: KWG entity ↔ AX symbol(s) — used for signature checking */
interface MatchedPair {
  entity: KwgEntity;
  symbols: AxSymbol[];
}

// =============================================================================
// Name Matching Utilities
// =============================================================================

/** Normalize a PascalCase/camelCase/snake_case name to a slug */
function toSlug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "");
}

/** Tokenize a name into words */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Jaccard token overlap score (0–1) */
function tokenOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersect / union : 0;
}

// =============================================================================
// Main Detector
// =============================================================================

/**
 * Run doc↔code drift detection.
 *
 * @param driver     Neo4j driver (caller manages lifecycle)
 * @param session    Session name for KWG query scoping
 * @param axOutput   AX stage output (code symbols)
 * @param options    Detection options
 */
export async function detectDocCodeDrift(
  driver: import("neo4j-driver").Driver,
  session: string,
  axOutput: AxOutput,
  options?: DocCodeDriftOptions,
): Promise<DriftReport> {
  const startTime = performance.now();
  const log = options?.log ?? (() => {});
  const minMentions = options?.minMentions ?? 2;
  const exportedOnly = options?.exportedOnly ?? true;
  const codeKinds = options?.codeKinds ?? [
    "function",
    "class",
    "interface",
    "type",
    "enum",
    "struct",
    "protocol",
  ];
  const nearMatchThreshold = options?.nearMatchThreshold ?? 0.5;
  const signatureCheck = options?.signatureCheck ?? true;

  // ── 1. Fetch KWG entities from Neo4j ─────────────────────────────────
  log("Fetching KWG entities from Neo4j...");
  const neo4jSession = driver.session();
  let kwgEntities: KwgEntity[];
  let kwgMentions: KwgMention[] = [];

  try {
    const result = await neo4jSession.run(

  kwgEntities = entityRows.map((r) => ({
    name: r.name as string,
    mentionCount: toNumber(r.mentionCount),
    qualifiers: (r.qualifiers as string[]) ?? [],
    filePaths: (r.filePaths as string[]) ?? [],
    predominantSource: (r.predominantSource as string) ?? "",
  }));

  // Fetch mentions for signature matching
  if (signatureCheck) {
    log("Fetching KWG mentions for signature matching...");
    const mentionRows = await runner.run(
      `
      MATCH (m:KWMention {session_id: $session})
      RETURN m.entityName AS entityName,
             m.text AS text,
             m.heading AS heading,
             m.filePath AS filePath,
             m.startLine AS startLine
      `,
      { session },
    );

    }));

    // Fetch mentions for signature matching
    if (signatureCheck) {
      log("Fetching KWG mentions for signature matching...");
      const mentionResult = await neo4jSession.run(
        `
        MATCH (m:KWMention {session_id: $session})
        RETURN m.entityName AS entityName,
               m.text AS text,
               m.heading AS heading,
               m.filePath AS filePath,
               m.startLine AS startLine
        `,
        { session },
      );

      kwgMentions = mentionResult.records.map((r) => ({
        entityName: r.get("entityName") as string,
        text: r.get("text") as string,
        heading: (r.get("heading") as string) ?? "",
        filePath: r.get("filePath") as string,
        startLine: toNumber(r.get("startLine")),
      }));
      log(`  → ${kwgMentions.length} KWG mentions loaded`);
    }
  } finally {
    await neo4jSession.close();
  }

  log(`  → ${kwgEntities.length} KWG entities loaded`);

  // Filter to significant entities (above mention threshold)
  const significantEntities = kwgEntities.filter(
    (e) => e.mentionCount >= minMentions,
  );
  log(
    `  → ${significantEntities.length} significant (≥${minMentions} mentions)`,
  );

  // ── 2. Collect code symbols from AX output ───────────────────────────
  const codeSymbols: AxSymbol[] = [];
  for (const file of axOutput.files) {
    for (const sym of file.symbols) {
      if (!codeKinds.includes(sym.kind)) continue;
      if (exportedOnly && sym.export === "internal") continue;
      codeSymbols.push(sym);
    }
  }
  log(
    `  → ${codeSymbols.length} code symbols (${exportedOnly ? "exported" : "all"})`,
  );

  // ── 3. Build match indexes ────────────────────────────────────────────
  // Code symbol lookup: slug → symbol(s)
  const codeBySlug = new Map<string, AxSymbol[]>();
  const codeByName = new Map<string, AxSymbol[]>();
  const codeTokenIndex = new Map<string, { sym: AxSymbol; tokens: string[] }>();

  for (const sym of codeSymbols) {
    // By exact lowercase name
    const lower = sym.name.toLowerCase();
    if (!codeByName.has(lower)) codeByName.set(lower, []);
    codeByName.get(lower)!.push(sym);

    // By slug
    const slug = toSlug(sym.name);
    if (!codeBySlug.has(slug)) codeBySlug.set(slug, []);
    codeBySlug.get(slug)!.push(sym);

    // Token index for fuzzy match
    codeTokenIndex.set(sym.id, { sym, tokens: tokenize(sym.name) });
  }

  // KWG entity lookup: slug → entity
  const kwgBySlug = new Map<string, KwgEntity>();
  const kwgByName = new Map<string, KwgEntity>();
  for (const e of significantEntities) {
    kwgBySlug.set(toSlug(e.name), e);
    kwgByName.set(e.name.toLowerCase(), e);
  }

  // ── 4. Match KWG entities → code symbols ──────────────────────────────
  const matchedKwg = new Set<string>();
  const matchedCode = new Set<string>();
  const matchedPairs: MatchedPair[] = [];

  for (const entity of significantEntities) {
    const entityLower = entity.name.toLowerCase();
    const entitySlug = toSlug(entity.name);

    // Exact name match
    if (codeByName.has(entityLower)) {
      matchedKwg.add(entity.name);
      const syms = codeByName.get(entityLower)!;
      for (const sym of syms) matchedCode.add(sym.id);
      matchedPairs.push({ entity, symbols: syms });
      continue;
    }

    // Slug match (handles camelCase vs snake_case etc.)
    if (codeBySlug.has(entitySlug)) {
      matchedKwg.add(entity.name);
      const syms = codeBySlug.get(entitySlug)!;
      for (const sym of syms) matchedCode.add(sym.id);
      matchedPairs.push({ entity, symbols: syms });
      continue;
    }

    // Token overlap (fuzzy)
    const entityTokens = tokenize(entity.name);
    if (entityTokens.length === 0) continue;

    let bestScore = 0;
    let bestSym: AxSymbol | undefined;

    for (const { sym, tokens } of codeTokenIndex.values()) {
      const score = tokenOverlap(entityTokens, tokens);
      if (score > bestScore) {
        bestScore = score;
        bestSym = sym;
      }
    }

    if (bestScore >= nearMatchThreshold && bestSym) {
      matchedKwg.add(entity.name);
      matchedCode.add(bestSym.id);
      matchedPairs.push({ entity, symbols: [bestSym] });
    }
  }

  // ── 4.5 Signature-mismatch detection ──────────────────────────────────
  // For each matched pair, check if doc mentions have wrong signatures.
  // (Signals array pre-declared here for step 4.5 and step 5 to share)
  const signals: DriftSignal[] = [];

  /** Extract parameter list from text like "foo(a, b, c)" → ["a", "b", "c"] */
  const extractParams = (text: string, name: string): string[] | null => {
    // Match entityName(...) in text, case-insensitive
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\s*\\(([^)]*)\\)`, "i");
    const m = text.match(re);
    if (!m) return null;
    const inner = m[1].trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  };

  /** Extract kind reference from text like "the AuthService function" */
  const extractKindFromText = (text: string, name: string): string | null => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match "the <name> function/class/interface/type" or "function/class <name>"
    const patterns = [
      new RegExp(
        `\\b(function|class|interface|type|enum)\\s+${escaped}\\b`,
        "i",
      ),
      new RegExp(
        `\\b${escaped}\\s+(function|class|interface|type|enum)\\b`,
        "i",
      ),
      new RegExp(
        `the\\s+${escaped}\\s+(function|class|interface|type|enum)`,
        "i",
      ),
      new RegExp(
        `(function|class|interface|type|enum)\\s+called\\s+${escaped}`,
        "i",
      ),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m[1].toLowerCase();
    }
    return null;
  };

  if (signatureCheck && kwgMentions.length > 0) {
    log("Checking signature mismatches...");

    // Build mention lookup by entity name
    const mentionsByEntity = new Map<string, KwgMention[]>();
    for (const m of kwgMentions) {
      const lower = m.entityName.toLowerCase();
      if (!mentionsByEntity.has(lower)) mentionsByEntity.set(lower, []);
      mentionsByEntity.get(lower)!.push(m);
    }

    for (const { entity, symbols } of matchedPairs) {
      const entityLower = entity.name.toLowerCase();
      const mentions = mentionsByEntity.get(entityLower) ?? [];
      if (mentions.length === 0) continue;

      for (const sym of symbols) {
        // Check 1: Parameter count mismatch
        if (sym.parameters && sym.parameters.length > 0) {
          for (const mention of mentions) {
            const docParams = extractParams(mention.text, entity.name);
            if (
              docParams !== null &&
              docParams.length !== sym.parameters.length
            ) {
              signals.push({
                category: "signature-mismatch",
                severity: "warning",
                detector: "doc-code",
                message: `"${entity.name}" signature mismatch: doc mentions ${docParams.length} param${docParams.length === 1 ? "" : "s"} but code has ${sym.parameters.length}`,
                name: entity.name,
                files: [mention.filePath, sym.filePath],
                evidence: {
                  mentionCount: entity.mentionCount,
                  qualifiers: entity.qualifiers as DriftEvidence["qualifiers"],
                  docSignature: `${entity.name}(${docParams.join(", ")})`,
                  codeSignature: `${sym.name}(${sym.parameters.join(", ")})`,
                  mentionContexts: [
                    {
                      text: mention.text,
                      heading: mention.heading,
                      filePath: mention.filePath,
                      startLine: mention.startLine,
                    },
                  ],
                },
              });
              break; // One signal per entity-symbol pair is enough
            }
          }
        }

        // Check 2: Kind mismatch (function vs class etc.)
        for (const mention of mentions) {
          const docKind = extractKindFromText(mention.text, entity.name);
          if (docKind && docKind !== sym.kind) {
            signals.push({
              category: "signature-mismatch",
              severity: "critical",
              detector: "doc-code",
              message: `"${entity.name}" kind mismatch: doc says "${docKind}" but code is "${sym.kind}"`,
              name: entity.name,
              files: [mention.filePath, sym.filePath],
              evidence: {
                mentionCount: entity.mentionCount,
                qualifiers: entity.qualifiers as DriftEvidence["qualifiers"],
                docSignature: `${docKind} ${entity.name}`,
                codeSignature: `${sym.kind} ${sym.name}`,
                mentionContexts: [
                  {
                    text: mention.text,
                    heading: mention.heading,
                    filePath: mention.filePath,
                    startLine: mention.startLine,
                  },
                ],
              },
            });
            break;
          }
        }

        // Check 3: Deprecation gap — code is deprecated but doc doesn't acknowledge
        if (sym.docSummary && /\b@deprecated\b/i.test(sym.docSummary)) {
          const hasDeprecatedQualifier =
            entity.qualifiers.includes("deprecated");
          if (!hasDeprecatedQualifier) {
            signals.push({
              category: "signature-mismatch",
              severity: "warning",
              detector: "doc-code",
              message: `"${entity.name}" is deprecated in code but docs don't acknowledge it`,
              name: entity.name,
              files: entity.filePaths,
              evidence: {
                mentionCount: entity.mentionCount,
                qualifiers: entity.qualifiers as DriftEvidence["qualifiers"],
                codeSignature: sym.docSummary,
              },
            });
          }
        }
      }
    }
  }

  // ── 5. Generate drift signals ─────────────────────────────────────────
  // Note: signature-mismatch signals already added in step 4.5 above.

  // Ungrounded mentions: KWG entities not matched to any code symbol
  for (const entity of significantEntities) {
    if (matchedKwg.has(entity.name)) continue;

    // Find nearest code symbol for context
    const entityTokens = tokenize(entity.name);
    let nearScore = 0;
    let nearName: string | undefined;

    if (entityTokens.length > 0) {
      for (const { sym, tokens } of codeTokenIndex.values()) {
        const score = tokenOverlap(entityTokens, tokens);
        if (score > nearScore) {
          nearScore = score;
          nearName = sym.name;
        }
      }
    }

    // Planned/speculative entities get lower severity
    const isPlanned = entity.qualifiers.includes("planned");
    const isDecision = entity.qualifiers.includes("decision");

    signals.push({
      category: "ungrounded",
      severity: isPlanned || isDecision ? "info" : "warning",
      detector: "doc-code",
      message: `"${entity.name}" mentioned ${entity.mentionCount}× in docs but not found in code`,
      name: entity.name,
      files: entity.filePaths,
      evidence: {
        mentionCount: entity.mentionCount,
        qualifiers:
          entity.qualifiers.length > 0
            ? (entity.qualifiers as DriftEvidence["qualifiers"])
            : undefined,
        nearMatchScore: nearScore > 0.2 ? nearScore : undefined,
        nearMatchName: nearScore > 0.2 ? nearName : undefined,
      },
    });
  }

  // Undocumented code: code symbols not matched to any KWG entity
  for (const sym of codeSymbols) {
    if (matchedCode.has(sym.id)) continue;

    // Only report significant symbols (exported, non-trivial name)
    if (sym.name.length <= 2) continue;

    // Find nearest KWG entity
    const symTokens = tokenize(sym.name);
    let nearScore = 0;
    let nearName: string | undefined;

    if (symTokens.length > 0) {
      for (const entity of significantEntities) {
        const score = tokenOverlap(symTokens, tokenize(entity.name));
        if (score > nearScore) {
          nearScore = score;
          nearName = entity.name;
        }
      }
    }

    signals.push({
      category: "undocumented",
      severity: "info",
      detector: "doc-code",
      message: `"${sym.name}" (${sym.kind}) exists in code but has no doc mention`,
      name: sym.name,
      files: [sym.filePath],
      evidence: {
        nearMatchScore: nearScore > 0.2 ? nearScore : undefined,
        nearMatchName: nearScore > 0.2 ? nearName : undefined,
      },
    });
  }

  // Sort: critical first, then warning, then info; within severity by mention count
  const severityOrder: Record<DriftSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  signals.sort((a, b) => {
    const sv = severityOrder[a.severity] - severityOrder[b.severity];
    if (sv !== 0) return sv;
    return (b.evidence.mentionCount ?? 0) - (a.evidence.mentionCount ?? 0);
  });

  const durationMs = Math.round(performance.now() - startTime);

  return {
    session,
    workspaceRoot: axOutput.workspaceRoot,
    signals,
    stats: {
      ungroundedCount: signals.filter((s) => s.category === "ungrounded")
        .length,
      undocumentedCount: signals.filter((s) => s.category === "undocumented")
        .length,
      signatureMismatchCount: signals.filter(
        (s) => s.category === "signature-mismatch",
      ).length,
      totalKwgEntities: significantEntities.length,
      totalCodeSymbols: codeSymbols.length,
      matchedCount: matchedKwg.size,
      durationMs,
    },
  };
}

// =============================================================================
// Markdown Renderer
// =============================================================================

const CATEGORY_ICONS: Record<string, string> = {
  ungrounded: "⚠",
  undocumented: "📄",
  "signature-mismatch": "✗",
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "red",
  warning: "yellow",
  info: "dim",
};

/**
 * Render drift report as formatted markdown for CLI output.
 */
export function renderDriftReport(report: DriftReport): string {
  const lines: string[] = [];
  const { stats, signals } = report;

  lines.push("# Doc ↔ Code Drift Report");
  lines.push("");
  lines.push(
    `Session: **${report.session}**  |  Workspace: \`${report.workspaceRoot}\``,
  );
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| KWG entities (≥ threshold) | ${stats.totalKwgEntities} |`);
  lines.push(`| Code symbols (exported) | ${stats.totalCodeSymbols} |`);
  lines.push(`| Matched (doc ↔ code) | ${stats.matchedCount} |`);
  lines.push(`| ⚠ Ungrounded mentions | ${stats.ungroundedCount} |`);
  lines.push(`| 📄 Undocumented code | ${stats.undocumentedCount} |`);
  lines.push(`| ✗ Signature mismatches | ${stats.signatureMismatchCount} |`);
  lines.push(`| Duration | ${stats.durationMs}ms |`);
  lines.push("");

  if (signals.length === 0) {
    lines.push("✓ **No drift detected** — documentation and code are aligned.");
    return lines.join("\n");
  }

  // Ungrounded mentions
  const ungrounded = signals.filter((s) => s.category === "ungrounded");
  if (ungrounded.length > 0) {
    lines.push(`## ⚠ Ungrounded Mentions (${ungrounded.length})`);
    lines.push("");
    lines.push("Entities mentioned in documentation but not found in code:");
    lines.push("");

    for (const s of ungrounded) {
      const qualStr =
        s.evidence.qualifiers && s.evidence.qualifiers.length > 0
          ? ` [${s.evidence.qualifiers.join(", ")}]`
          : "";
      const nearStr =
        s.evidence.nearMatchName && s.evidence.nearMatchScore
          ? ` (near: "${s.evidence.nearMatchName}" @ ${Math.round(s.evidence.nearMatchScore * 100)}%)`
          : "";
      lines.push(
        `- ${CATEGORY_ICONS.ungrounded} **${s.name}** — ${s.evidence.mentionCount ?? 0}× in ${s.files.length} file(s)${qualStr}${nearStr}`,
      );
    }
    lines.push("");
  }

  // Undocumented code
  const undocumented = signals.filter((s) => s.category === "undocumented");
  if (undocumented.length > 0) {
    lines.push(`## 📄 Undocumented Code (${undocumented.length})`);
    lines.push("");
    lines.push("Code symbols that exist but have no documentation mentions:");
    lines.push("");

    // Only show top 30 to avoid overwhelming output
    const shown = undocumented.slice(0, 30);
    for (const s of shown) {
      const nearStr =
        s.evidence.nearMatchName && s.evidence.nearMatchScore
          ? ` (near: "${s.evidence.nearMatchName}" @ ${Math.round(s.evidence.nearMatchScore * 100)}%)`
          : "";
      lines.push(
        `- ${CATEGORY_ICONS.undocumented} **${s.name}** — \`${s.files[0]}\`${nearStr}`,
      );
    }
    if (undocumented.length > 30) {
      lines.push(`- ... and ${undocumented.length - 30} more`);
    }
    lines.push("");
  }

  // Signature mismatches
  const sigMismatch = signals.filter(
    (s) => s.category === "signature-mismatch",
  );
  if (sigMismatch.length > 0) {
    lines.push(`## ✗ Signature Mismatches (${sigMismatch.length})`);
    lines.push("");
    lines.push(
      "Entities matched in both docs and code, but with conflicting signatures:",
    );
    lines.push("");
    for (const s of sigMismatch) {
      const docSig = s.evidence.docSignature ?? "?";
      const codeSig = s.evidence.codeSignature ?? "?";
      lines.push(
        `- ${CATEGORY_ICONS["signature-mismatch"]} **${s.name}** — ${s.message}`,
      );
      lines.push(`  - Doc: \`${docSig}\`  →  Code: \`${codeSig}\``);
    }
    lines.push("");
  }

  // Footer
  const totalSignals = signals.length;
  const critCount = signals.filter((s) => s.severity === "critical").length;
  const warnCount = signals.filter((s) => s.severity === "warning").length;
  const infoCount = signals.filter((s) => s.severity === "info").length;

  lines.push("---");
  lines.push(
    `**${totalSignals} drift signals** | ${critCount} critical | ${warnCount} warnings | ${infoCount} info | ${stats.durationMs}ms | $0.00`,
  );

  return lines.join("\n");
}

// =============================================================================
// Helpers
// =============================================================================

function toNumber(val: unknown): number {
  if (typeof val === "number") return val;
  if (val && typeof val === "object" && "toNumber" in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return Number(val) || 0;
}
