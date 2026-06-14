// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Semantic Capsule Writer (14.0)
 *
 * Generates and caches LLM-derived semantic interpretations of CARI entities:
 *
 *   symbol_summary   — purpose, inputs, outputs, concepts for one symbol
 *   call_semantics   — why does caller A call callee B
 *   path_summary     — narrative for a full CALLS*N path
 *   subgraph_summary — component-level summary for a 2-hop neighborhood
 *
 * Each capsule is stored in `semantic_capsules` and keyed by
 * `capsule:<kind>:<target_id>@<source_revision>` so it is automatically
 * invalidated when the target symbol's body_hash changes.
 *
 * A capsule is returned from cache if its status is "fresh".
 * A capsule is regenerated if:
 *   - it doesn't exist yet, OR
 *   - its source_revision differs from the current body_hash, OR
 *   - force=true is passed
 *
 * Staleness propagation (non-LLM, fast):
 *   markStaleForChangedSymbols(db, changedBodyHashes) marks all capsules
 *   whose source_revision is no longer current as "possibly_stale".
 */

import * as fs from "node:fs";
import Database from "@intentweave/sqlite-compat";
import type { SemanticCapsule, CapsuleKind } from "../types.js";

// ── Public input types ────────────────────────────────────────────────────────

export interface SymbolEvidence {
  /** The CARI symbol id (numeric, without 'symbol:' prefix). */
  symbolId: string;
  name: string;
  kind: string;
  signature: string;
  /** Already-extracted JSDoc / TSDoc summary (may be empty). */
  docSummary: string;
  /** Raw body text (first 600 chars is enough for context). */
  bodyText: string;
  /** Annotation spans from docs that mention this symbol. */
  docAnnotations: string[];
  /** Names of direct callees. */
  callees: string[];
  /** Names of direct callers (up to 10). */
  callers: string[];
  /** Current body_hash — used as source_revision. */
  bodyHash: string;
  /** File path. */
  filePath: string;
}

export interface CapsuleWriteOptions {
  /** Force regeneration even if a fresh capsule exists. Default: false. */
  force?: boolean;
  /** LLM model name. Stored in the capsule for cache invalidation. */
  model: string;
  /** Prompt version string. Bump to invalidate all cached capsules. */
  promptVersion?: string;
  /** Max tokens for LLM response. Default: 600. */
  maxTokens?: number;
  /** Temperature. Default: 0.2 (deterministic summaries). */
  temperature?: number;
}

/** Minimal LLM interface required by the capsule writer. */
export interface CapsuleLLM {
  complete(req: {
    system?: string;
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    responseSchema?: Record<string, unknown>;
    maxTokens?: number;
    temperature?: number;
    model?: string;
  }): Promise<{
    content: string;
    parsed?: unknown;
    tokensUsed: { prompt: number; completion: number };
    model: string;
  }>;
}

export interface CapsuleWriteResult {
  capsule: SemanticCapsule;
  fromCache: boolean;
  tokensUsed?: { prompt: number; completion: number };
}

// ── JSON schema for LLM structured output ─────────────────────────────────────

const SYMBOL_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary"],
  properties: {
    summary: {
      type: "string",
      description:
        "One-paragraph plain-English description of what the symbol does.",
    },
    purpose: {
      type: "string",
      description: "Single sentence: the business/technical purpose.",
    },
    inputs: {
      type: "array",
      items: { type: "string" },
      description:
        "Key input parameters or data consumed (type names / concepts).",
    },
    outputs: {
      type: "array",
      items: { type: "string" },
      description: "Key return values or data produced.",
    },
    sideEffects: {
      type: "array",
      items: { type: "string" },
      description:
        "Observable side effects: DB writes, network calls, mutations.",
    },
    keyConcepts: {
      type: "array",
      items: { type: "string" },
      description:
        "Domain concepts or architectural terms this symbol is part of.",
    },
    failureModes: {
      type: "array",
      items: { type: "string" },
      description: "Known or likely failure modes / error conditions.",
    },
  },
  additionalProperties: false,
};

const CALL_SEMANTICS_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary", "role"],
  properties: {
    summary: { type: "string" },
    role: {
      type: "string",
      description:
        "Why does the caller invoke the callee? (e.g. 'validates payload before persistence')",
    },
    keyConcepts: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const PATH_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary"],
  properties: {
    summary: { type: "string" },
    domains: {
      type: "array",
      items: { type: "string" },
      description: "Architectural or domain areas traversed by this call path.",
    },
    sideEffects: { type: "array", items: { type: "string" } },
    keyConcepts: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

// ── Evidence collectors ───────────────────────────────────────────────────────

/**
 * Collect all evidence for a symbol from the CARI index.
 */
export function collectSymbolEvidence(
  db: Database.Database,
  symbolId: string,
): SymbolEvidence | null {
  const sym = db
    .prepare(
      `SELECT id, name, kind, signature, doc_summary, body_hash, file_path
     FROM symbols WHERE id = ?`,
    )
    .get(symbolId) as
    | {
        id: string;
        name: string;
        kind: string;
        signature: string;
        doc_summary: string;
        body_hash: string;
        file_path: string;
      }
    | undefined;
  if (!sym) return null;

  // Body text: read from file if available, truncate to 800 chars
  let bodyText = "";
  try {
    const absPath = sym.file_path;
    if (fs.existsSync(absPath)) {
      const lines = fs.readFileSync(absPath, "utf-8").split("\n");
      // Find the symbol's line range from DB
      const lineInfo = db
        .prepare(`SELECT line, end_line FROM symbols WHERE id = ?`)
        .get(symbolId) as { line: number; end_line: number } | undefined;
      if (lineInfo) {
        const start = Math.max(0, lineInfo.line - 1);
        const end = Math.min(
          lines.length,
          lineInfo.end_line ?? lineInfo.line + 20,
        );
        bodyText = lines.slice(start, end).join("\n").slice(0, 800);
      }
    }
  } catch {
    // file read failure is non-fatal
  }

  // Doc annotations that mention this symbol
  const annotations = db
    .prepare(
      `SELECT text FROM annotations WHERE symbol_id = ? ORDER BY confidence DESC LIMIT 5`,
    )
    .all(symbolId) as Array<{ text: string }>;

  // Callers (up to 10)
  const callers = db
    .prepare(
      `SELECT DISTINCT caller_name FROM symbol_calls WHERE callee_name = ? AND caller_name IS NOT NULL LIMIT 10`,
    )
    .all(sym.name) as Array<{ caller_name: string }>;

  // Callees (up to 10)
  const callees = db
    .prepare(
      `SELECT DISTINCT callee_name FROM symbol_calls WHERE caller_name = ? LIMIT 10`,
    )
    .all(sym.name) as Array<{ callee_name: string }>;

  return {
    symbolId,
    name: sym.name,
    kind: sym.kind,
    signature: sym.signature ?? "",
    docSummary: sym.doc_summary ?? "",
    bodyText,
    docAnnotations: annotations.map((a) => a.text),
    callers: callers.map((c) => c.caller_name),
    callees: callees.map((c) => c.callee_name),
    bodyHash: sym.body_hash ?? "",
    filePath: sym.file_path,
  };
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildSymbolSummaryPrompt(ev: SymbolEvidence): string {
  const parts: string[] = [
    `## Symbol: ${ev.name}  (${ev.kind})`,
    `File: ${ev.filePath}`,
  ];
  if (ev.signature) parts.push(`Signature: \`${ev.signature}\``);
  if (ev.docSummary) parts.push(`\n### Existing JSDoc\n${ev.docSummary}`);
  if (ev.bodyText)
    parts.push(`\n### Source (excerpt)\n\`\`\`\n${ev.bodyText}\n\`\`\``);
  if (ev.docAnnotations.length > 0) {
    parts.push(
      `\n### Documentation mentions\n${ev.docAnnotations.map((a) => `- ${a}`).join("\n")}`,
    );
  }
  if (ev.callers.length > 0) parts.push(`\nCallers: ${ev.callers.join(", ")}`);
  if (ev.callees.length > 0) parts.push(`Callees: ${ev.callees.join(", ")}`);
  parts.push(
    `\n---\nReturn a JSON object describing this symbol per the schema.`,
  );
  return parts.join("\n");
}

function buildCallSemanticsPrompt(
  callerName: string,
  callerSig: string,
  calleeName: string,
  calleeSig: string,
  callerDoc: string,
  calleeDoc: string,
): string {
  return [
    `## Call Edge Analysis`,
    `Caller: \`${callerName}\`  ${callerSig ? `— ${callerSig}` : ""}`,
    callerDoc ? `Caller context: ${callerDoc}` : "",
    `Callee: \`${calleeName}\`  ${calleeSig ? `— ${calleeSig}` : ""}`,
    calleeDoc ? `Callee context: ${calleeDoc}` : "",
    `\nExplain WHY the caller invokes the callee and what architectural role this call plays.`,
    `Return a JSON object per the schema.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPathSummaryPrompt(
  steps: Array<{ name: string; docSummary: string }>,
): string {
  const chain = steps
    .map(
      (s, i) =>
        `${i + 1}. \`${s.name}\`${s.docSummary ? ` — ${s.docSummary}` : ""}`,
    )
    .join("\n");
  return [
    `## Call Path Summary`,
    `The following call chain was identified:\n${chain}`,
    `\nDescribe in plain English what this execution path does end-to-end.`,
    `Return a JSON object per the schema.`,
  ].join("\n");
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function getCachedCapsule(
  db: Database.Database,
  targetId: string,
  capsuleKind: CapsuleKind,
  currentRevision: string,
  force: boolean,
): SemanticCapsule | null {
  if (force) return null;
  const row = db
    .prepare(
      `SELECT * FROM semantic_capsules WHERE target_id = ? AND capsule_kind = ? AND status = 'fresh' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(targetId, capsuleKind) as Record<string, unknown> | undefined;
  if (!row) return null;
  // Stale if source changed
  if (row.source_revision !== currentRevision) return null;
  return deserializeCapsule(row);
}

function deserializeCapsule(row: Record<string, unknown>): SemanticCapsule {
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    capsuleKind: String(row.capsule_kind) as CapsuleKind,
    content: JSON.parse(String(row.content)),
    evidenceIds: JSON.parse(String(row.evidence_ids)),
    model: String(row.model),
    promptVersion: String(row.prompt_version),
    sourceRevision: String(row.source_revision),
    confidence: Number(row.confidence),
    status: String(row.status) as SemanticCapsule["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function writeCapsule(
  db: Database.Database,
  capsule: Omit<SemanticCapsule, "createdAt" | "updatedAt">,
): SemanticCapsule {
  const now = new Date().toISOString();
  const full: SemanticCapsule = { ...capsule, createdAt: now, updatedAt: now };
  db.prepare(
    `
    INSERT OR REPLACE INTO semantic_capsules
      (id, target_id, capsule_kind, content, evidence_ids, model, prompt_version,
       source_revision, confidence, status, created_at, updated_at)
    VALUES
      ($id, $targetId, $capsuleKind, $content, $evidenceIds, $model, $promptVersion,
       $sourceRevision, $confidence, $status, $createdAt, $updatedAt)
  `,
  ).run({
    id: full.id,
    targetId: full.targetId,
    capsuleKind: full.capsuleKind,
    content: JSON.stringify(full.content),
    evidenceIds: JSON.stringify(full.evidenceIds),
    model: full.model,
    promptVersion: full.promptVersion,
    sourceRevision: full.sourceRevision,
    confidence: full.confidence,
    status: full.status,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
  });
  return full;
}

// ── Main capsule generators ───────────────────────────────────────────────────

const DEFAULT_PROMPT_VERSION = "capsule-v1";
const SYSTEM_PROMPT =
  "You are a senior software architect analyzing a TypeScript/JavaScript codebase. " +
  "Respond only with the requested JSON object. Be concise and precise. " +
  "Base your analysis solely on the provided evidence.";

/**
 * Generate (or return cached) a symbol_summary capsule for a given symbol ID.
 *
 * The symbol ID is the numeric ID from the `symbols` table (without prefix).
 */
export async function generateSymbolSummary(
  db: Database.Database,
  symbolId: string,
  llm: CapsuleLLM,
  opts: CapsuleWriteOptions,
): Promise<CapsuleWriteResult> {
  const targetId = `symbol:${symbolId}`;
  const promptVersion = opts.promptVersion ?? DEFAULT_PROMPT_VERSION;

  const evidence = collectSymbolEvidence(db, symbolId);
  if (!evidence) throw new Error(`Symbol ${symbolId} not found in index`);

  const cached = getCachedCapsule(
    db,
    targetId,
    "symbol_summary",
    evidence.bodyHash,
    opts.force ?? false,
  );
  if (cached) return { capsule: cached, fromCache: true };

  const prompt = buildSymbolSummaryPrompt(evidence);
  const response = await llm.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    responseSchema: SYMBOL_SUMMARY_SCHEMA,
    maxTokens: opts.maxTokens ?? 600,
    temperature: opts.temperature ?? 0.2,
    model: opts.model,
  });

  const parsed = (response.parsed ??
    tryParseJson(response.content)) as SemanticCapsule["content"];
  const capsuleId = `capsule:symbol_summary:${targetId}@${evidence.bodyHash.slice(0, 12)}`;

  const evidenceIds = [
    targetId,
    ...evidence.docAnnotations.map((_, i) => `doc:annotation:${symbolId}:${i}`),
  ];

  const capsule = writeCapsule(db, {
    id: capsuleId,
    targetId,
    capsuleKind: "symbol_summary",
    content: parsed,
    evidenceIds,
    model: response.model,
    promptVersion,
    sourceRevision: evidence.bodyHash,
    confidence: 0.85,
    status: "fresh",
  });

  return { capsule, fromCache: false, tokensUsed: response.tokensUsed };
}

/**
 * Generate (or return cached) a call_semantics capsule for a caller→callee edge.
 */
export async function generateCallSemantics(
  db: Database.Database,
  callerSymbolId: string,
  calleeSymbolId: string,
  llm: CapsuleLLM,
  opts: CapsuleWriteOptions,
): Promise<CapsuleWriteResult> {
  const targetId = `call:${callerSymbolId}→${calleeSymbolId}`;
  const promptVersion = opts.promptVersion ?? DEFAULT_PROMPT_VERSION;

  const caller = db
    .prepare(
      `SELECT name, signature, doc_summary, body_hash FROM symbols WHERE id = ?`,
    )
    .get(callerSymbolId) as
    | {
        name: string;
        signature: string;
        doc_summary: string;
        body_hash: string;
      }
    | undefined;
  const callee = db
    .prepare(
      `SELECT name, signature, doc_summary, body_hash FROM symbols WHERE id = ?`,
    )
    .get(calleeSymbolId) as
    | {
        name: string;
        signature: string;
        doc_summary: string;
        body_hash: string;
      }
    | undefined;
  if (!caller || !callee)
    throw new Error(
      `Caller or callee not found: ${callerSymbolId}, ${calleeSymbolId}`,
    );

  const rev = `${caller.body_hash?.slice(0, 8) ?? "x"}+${callee.body_hash?.slice(0, 8) ?? "x"}`;
  const cached = getCachedCapsule(
    db,
    targetId,
    "call_semantics",
    rev,
    opts.force ?? false,
  );
  if (cached) return { capsule: cached, fromCache: true };

  const prompt = buildCallSemanticsPrompt(
    caller.name,
    caller.signature ?? "",
    callee.name,
    callee.signature ?? "",
    caller.doc_summary ?? "",
    callee.doc_summary ?? "",
  );
  const response = await llm.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    responseSchema: CALL_SEMANTICS_SCHEMA,
    maxTokens: opts.maxTokens ?? 400,
    temperature: opts.temperature ?? 0.2,
    model: opts.model,
  });

  const parsed = (response.parsed ??
    tryParseJson(response.content)) as SemanticCapsule["content"];
  const capsuleId = `capsule:call_semantics:${targetId}@${rev}`;

  const capsule = writeCapsule(db, {
    id: capsuleId,
    targetId,
    capsuleKind: "call_semantics",
    content: parsed,
    evidenceIds: [`symbol:${callerSymbolId}`, `symbol:${calleeSymbolId}`],
    model: response.model,
    promptVersion,
    sourceRevision: rev,
    confidence: 0.8,
    status: "fresh",
  });

  return { capsule, fromCache: false, tokensUsed: response.tokensUsed };
}

/**
 * Generate (or return cached) a path_summary capsule for a list of symbol IDs
 * representing a call path (in order: entry → ... → leaf).
 */
export async function generatePathSummary(
  db: Database.Database,
  symbolIds: string[],
  llm: CapsuleLLM,
  opts: CapsuleWriteOptions,
): Promise<CapsuleWriteResult> {
  if (symbolIds.length < 2)
    throw new Error("Path must contain at least 2 symbols");
  const targetId = `path:${symbolIds.join("→")}`;
  const promptVersion = opts.promptVersion ?? DEFAULT_PROMPT_VERSION;

  const syms = symbolIds.map(
    (id) =>
      db
        .prepare(
          `SELECT name, doc_summary, body_hash FROM symbols WHERE id = ?`,
        )
        .get(id) as
        | { name: string; doc_summary: string; body_hash: string }
        | undefined,
  );
  if (syms.some((s) => !s))
    throw new Error("One or more symbol IDs not found in index");

  const rev = syms.map((s) => s!.body_hash?.slice(0, 6) ?? "x").join("+");
  const cached = getCachedCapsule(
    db,
    targetId,
    "path_summary",
    rev,
    opts.force ?? false,
  );
  if (cached) return { capsule: cached, fromCache: true };

  const steps = syms.map((s) => ({
    name: s!.name,
    docSummary: s!.doc_summary ?? "",
  }));
  const prompt = buildPathSummaryPrompt(steps);
  const response = await llm.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    responseSchema: PATH_SUMMARY_SCHEMA,
    maxTokens: opts.maxTokens ?? 500,
    temperature: opts.temperature ?? 0.2,
    model: opts.model,
  });

  const parsed = (response.parsed ??
    tryParseJson(response.content)) as SemanticCapsule["content"];
  const capsuleId = `capsule:path_summary:${targetId}@${rev}`;

  const capsule = writeCapsule(db, {
    id: capsuleId,
    targetId,
    capsuleKind: "path_summary",
    content: parsed,
    evidenceIds: symbolIds.map((id) => `symbol:${id}`),
    model: response.model,
    promptVersion,
    sourceRevision: rev,
    confidence: 0.75,
    status: "fresh",
  });

  return { capsule, fromCache: false, tokensUsed: response.tokensUsed };
}

// ── Staleness propagation ─────────────────────────────────────────────────────

/**
 * Mark capsules as possibly_stale when the underlying symbol body_hash has changed.
 *
 * Call this at the end of `iw index build` / `iw index update` after writing
 * new symbols.  Only touches capsules that are currently "fresh".
 *
 * Returns the number of capsules marked stale.
 */
export function markStaleForChangedSymbols(db: Database.Database): number {
  // For symbol_summary capsules: compare source_revision against current body_hash
  const result = db
    .prepare(
      `
    UPDATE semantic_capsules
    SET status = 'possibly_stale', updated_at = ?
    WHERE capsule_kind = 'symbol_summary'
      AND status = 'fresh'
      AND target_id LIKE 'symbol:%'
      AND source_revision != (
        SELECT COALESCE(body_hash, '') FROM symbols
        WHERE 'symbol:' || id = semantic_capsules.target_id
        LIMIT 1
      )
      AND EXISTS (
        SELECT 1 FROM symbols WHERE 'symbol:' || id = semantic_capsules.target_id
      )
  `,
    )
    .run(new Date().toISOString());

  return result.changes;
}

/**
 * List all capsules with their freshness status.
 */
export function listCapsules(
  db: Database.Database,
  opts: {
    targetId?: string;
    kind?: CapsuleKind;
    status?: string;
    limit?: number;
  } = {},
): SemanticCapsule[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.targetId) {
    conditions.push("target_id = $targetId");
    params.targetId = opts.targetId;
  }
  if (opts.kind) {
    conditions.push("capsule_kind = $kind");
    params.kind = opts.kind;
  }
  if (opts.status) {
    conditions.push("status = $status");
    params.status = opts.status;
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT * FROM semantic_capsules ${where} ORDER BY updated_at DESC LIMIT ${limit}`,
    )
    .all(params) as Record<string, unknown>[];
  return rows.map(deserializeCapsule);
}

/**
 * Get a single capsule by target_id + kind (returns the freshest one).
 */
export function getCapsule(
  db: Database.Database,
  targetId: string,
  kind: CapsuleKind,
): SemanticCapsule | null {
  const row = db
    .prepare(
      `SELECT * FROM semantic_capsules WHERE target_id = ? AND capsule_kind = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(targetId, kind) as Record<string, unknown> | undefined;
  return row ? deserializeCapsule(row) : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tryParseJson(text: string): Record<string, unknown> {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {
    // fall through
  }
  return { summary: text.trim() };
}
