// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact Analyzer
 *
 * Answers: "If I change file X, what semantic concepts are affected?"
 *
 * Traversal path:
 *   file path → :CodeRef ←[:REALIZED_BY]– :Canon (direct impact)
 *                                            │
 *                                     [:CANON_REL *1..N]
 *                                            │
 *                                       :Canon (indirect / ripple)
 *
 * Produces a structured report with:
 *   - Direct impacts: concepts implemented in the changed file(s)
 *   - Ripple impacts: decisions, risks, features connected to those concepts
 *   - Risk highlights: anything with a RISKS or BLOCKS predicate
 *   - Decision trail: DECIDED_FOR / DECIDED_AGAINST touching the subgraph
 */

import type { Neo4jRunner } from "../context/index.js";

// =============================================================================
// Types
// =============================================================================

export interface ImpactEntity {
  name: string;
  type: string;
  confidence: number;
  /** How this entity connects to the changed file */
  via: "direct" | "ripple";
  /** Hop distance from the directly-linked entity (0 = direct) */
  depth: number;
  /** Code ref details (only for direct entities) */
  codeRef?: {
    filePath: string;
    kind: string;
    strategy: string;
  };
}

export interface ImpactRelationship {
  sourceName: string;
  sourceType: string;
  predicate: string;
  targetName: string;
  targetType: string;
  confidence: number;
  /** Optional rationale from raw triple */
  rationale?: string;
}

export interface ImpactResult {
  /** The file(s) being analyzed */
  files: string[];
  /** Session used */
  sessionId: string;
  /** Directly-linked entities (file → CodeRef → Canon) */
  directEntities: ImpactEntity[];
  /** Ripple entities reachable via CANON_REL from direct entities */
  rippleEntities: ImpactEntity[];
  /** All relationships in the impact subgraph */
  relationships: ImpactRelationship[];
  /** Decisions that touch the impact subgraph */
  decisions: ImpactRelationship[];
  /** Risks that touch the impact subgraph */
  risks: ImpactRelationship[];
  /** Stats */
  stats: {
    filesAnalyzed: number;
    directCount: number;
    rippleCount: number;
    totalRelationships: number;
    decisionCount: number;
    riskCount: number;
  };
}

export interface ImpactOptions {
  runner: Neo4jRunner;
  sessionId: string;
  /** Max hops from direct entities to expand (default: 2) */
  hops?: number;
  /** Min confidence threshold (default: 0) */
  minConfidence?: number;
  /** Max ripple entities to return (default: 100) */
  limit?: number;
  /** Log callback */
  log?: (msg: string) => void;
}

// =============================================================================
// Main entry
// =============================================================================

/**
 * Analyze impact: given one or more file paths, find all semantic concepts
 * that would be affected by changes to those files.
 */
export async function analyzeImpact(
  files: string[],
  options: ImpactOptions,
): Promise<ImpactResult> {
  const {
    runner,
    sessionId,
    hops = 2,
    minConfidence = 0,
    limit = 100,
    log,
  } = options;

  // Normalize file paths: strip leading ./ and trailing /
  const normalizedFiles = files.map((f) =>
    f.replace(/^\.\//, "").replace(/\/$/, ""),
  );

  log?.(`Analyzing impact for ${normalizedFiles.length} file(s)…`);

  // ── Step 1: Find direct Canon entities via CodeRef ──────────────────
  log?.("Step 1: Finding directly linked entities…");

  const directRows = await runner.run(
    `MATCH (c:Canon)-[r:REALIZED_BY]->(cr:CodeRef)
     WHERE cr.session_id = $sid
       AND ANY(f IN $files WHERE cr.filePath = f OR cr.filePath ENDS WITH f OR f ENDS WITH cr.filePath)
     RETURN DISTINCT
       c.name AS name, c.type AS type,
       coalesce(c.confidence, 1.0) AS confidence,
       cr.filePath AS filePath, cr.kind AS kind, r.strategy AS strategy`,
    { sid: sessionId, files: normalizedFiles },
  );

  // Deduplicate by entity name (keep best confidence)
  const directMap = new Map<string, ImpactEntity>();
  for (const row of directRows) {
    const name = String(row.name);
    const existing = directMap.get(name);
    const conf = typeof row.confidence === "number" ? row.confidence : 1.0;
    if (!existing || conf > existing.confidence) {
      directMap.set(name, {
        name,
        type: String(row.type),
        confidence: conf,
        via: "direct",
        depth: 0,
        codeRef: {
          filePath: String(row.filePath),
          kind: String(row.kind),
          strategy: String(row.strategy),
        },
      });
    }
  }

  const directEntities = [...directMap.values()];
  const directNames = directEntities.map((e) => e.name);

  log?.(`  ${directEntities.length} directly-linked entities`);

  if (directEntities.length === 0) {
    log?.(
      "No entities linked to the specified file(s). Run `iw xlink` first to create cross-layer links.",
    );
    return emptyResult(normalizedFiles, sessionId);
  }

  // ── Step 2: Expand ripple via CANON_REL ─────────────────────────────
  log?.(`Step 2: Expanding ${hops} hops via CANON_REL…`);

  const hopRange = hops > 1 ? `1..${hops}` : "1";

  const rippleRows = await runner.run(
    `MATCH (seed:Canon)
     WHERE seed.session_id = $sid AND seed.name IN $seeds
     WITH collect(seed) AS seedNodes
     UNWIND seedNodes AS s
     OPTIONAL MATCH (s)-[:CANON_REL*${hopRange}]-(neighbor:Canon)
     WHERE neighbor.session_id = $sid
       AND NOT neighbor.name IN $seeds
       AND coalesce(neighbor.confidence, 1.0) >= $minConf
     WITH DISTINCT neighbor
     WHERE neighbor IS NOT NULL
     RETURN neighbor.name AS name, neighbor.type AS type,
            coalesce(neighbor.confidence, 1.0) AS confidence
     ORDER BY neighbor.confidence DESC
     LIMIT $lim`,
    { sid: sessionId, seeds: directNames, minConf: minConfidence, lim: limit },
  );

  // Compute depth for ripple entities (BFS-like: query per hop level)
  const rippleEntities: ImpactEntity[] = rippleRows.map((row) => ({
    name: String(row.name),
    type: String(row.type),
    confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
    via: "ripple" as const,
    depth: 1, // We'll refine below
  }));

  // Refine depth: check which are 1-hop vs 2-hop
  if (hops > 1 && rippleEntities.length > 0) {
    const hop1Rows = await runner.run(
      `MATCH (seed:Canon)-[:CANON_REL]-(neighbor:Canon)
       WHERE seed.session_id = $sid AND seed.name IN $seeds
         AND neighbor.session_id = $sid
         AND NOT neighbor.name IN $seeds
       RETURN DISTINCT neighbor.name AS name`,
      { sid: sessionId, seeds: directNames },
    );
    const hop1Names = new Set(hop1Rows.map((r) => String(r.name)));
    for (const e of rippleEntities) {
      e.depth = hop1Names.has(e.name) ? 1 : 2;
    }
  }

  log?.(`  ${rippleEntities.length} ripple entities`);

  // ── Step 3: Fetch relationships within the impact subgraph ──────────
  log?.("Step 3: Fetching relationships in impact subgraph…");

  const allNames = [...directNames, ...rippleEntities.map((e) => e.name)];

  const relRows = await runner.run(
    `MATCH (a:Canon)-[r:CANON_REL]->(b:Canon)
     WHERE a.session_id = $sid
       AND (a.name IN $names AND b.name IN $names)
     RETURN a.name AS sourceName, a.type AS sourceType,
            r.predicate AS predicate,
            b.name AS targetName, b.type AS targetType,
            coalesce(r.confidence, 1.0) AS confidence
     ORDER BY r.confidence DESC
     LIMIT 500`,
    { sid: sessionId, names: allNames },
  );

  const relationships: ImpactRelationship[] = relRows.map((row) => ({
    sourceName: String(row.sourceName),
    sourceType: String(row.sourceType),
    predicate: String(row.predicate),
    targetName: String(row.targetName),
    targetType: String(row.targetType),
    confidence: typeof row.confidence === "number" ? row.confidence : 1.0,
  }));

  // Enrich with rationales from raw triples (best effort)
  await enrichRelationshipsWithRationales(
    runner,
    sessionId,
    relationships,
    allNames,
  );

  // ── Step 4: Extract decision trail + risks ──────────────────────────
  const decisions = relationships.filter(
    (r) => r.predicate === "DECIDED_FOR" || r.predicate === "DECIDED_AGAINST",
  );
  const risks = relationships.filter(
    (r) => r.predicate === "RISKS" || r.predicate === "BLOCKS",
  );

  log?.(
    `  ${relationships.length} relationships, ${decisions.length} decisions, ${risks.length} risks`,
  );

  return {
    files: normalizedFiles,
    sessionId,
    directEntities,
    rippleEntities,
    relationships,
    decisions,
    risks,
    stats: {
      filesAnalyzed: normalizedFiles.length,
      directCount: directEntities.length,
      rippleCount: rippleEntities.length,
      totalRelationships: relationships.length,
      decisionCount: decisions.length,
      riskCount: risks.length,
    },
  };
}

// =============================================================================
// Enrichment
// =============================================================================

async function enrichRelationshipsWithRationales(
  runner: Neo4jRunner,
  sessionId: string,
  relationships: ImpactRelationship[],
  entityNames: string[],
): Promise<void> {
  if (relationships.length === 0) return;

  const rawTriples = await runner.run(
    `MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(ce:Canon:Entity)
     WHERE rt.session_id = $sid AND ce.name IN $names
       AND rt.rationale IS NOT NULL AND rt.rationale <> ''
     RETURN rt.subject AS subject, rt.object AS object,
            rt.rationale AS rationale, rt.confidence AS confidence
     LIMIT 500`,
    { sid: sessionId, names: entityNames },
  );

  if (rawTriples.length === 0) return;

  const rationaleMap = new Map<
    string,
    { rationale: string; confidence: number }
  >();
  for (const rt of rawTriples) {
    const key = `${String(rt.subject).toLowerCase()}|${String(rt.object).toLowerCase()}`;
    const conf = typeof rt.confidence === "number" ? rt.confidence : 0.5;
    const existing = rationaleMap.get(key);
    if (!existing || conf > existing.confidence) {
      rationaleMap.set(key, {
        rationale: String(rt.rationale),
        confidence: conf,
      });
    }
  }

  for (const rel of relationships) {
    const key = `${rel.sourceName.toLowerCase()}|${rel.targetName.toLowerCase()}`;
    const match = rationaleMap.get(key);
    if (match) {
      rel.rationale = match.rationale;
    }
  }
}

// =============================================================================
// Formatter
// =============================================================================

/**
 * Format impact results as structured Markdown for CLI or MCP output.
 */
export function formatImpactMarkdown(result: ImpactResult): string {
  const sections: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────
  const fileList =
    result.files.length <= 3
      ? result.files.map((f) => `\`${f}\``).join(", ")
      : `${result.files.length} files`;
  sections.push(`# Impact Analysis: ${fileList}`);
  sections.push(
    `> Session: ${result.sessionId} | ${result.stats.directCount} direct, ${result.stats.rippleCount} ripple, ${result.stats.decisionCount} decisions, ${result.stats.riskCount} risks\n`,
  );

  // ── Direct impacts ──────────────────────────────────────────────────
  if (result.directEntities.length > 0) {
    const lines = ["## Direct Impact"];
    lines.push("> Concepts implemented in the changed file(s)\n");
    for (const e of result.directEntities) {
      const confStr =
        e.confidence < 0.9 ? ` [${Math.round(e.confidence * 100)}%]` : "";
      const refStr = e.codeRef
        ? ` — via ${e.codeRef.kind} (${e.codeRef.strategy})`
        : "";
      lines.push(`- **${e.name}** (${e.type})${confStr}${refStr}`);
    }
    lines.push("");
    sections.push(lines.join("\n"));
  }

  // ── Ripple impacts ──────────────────────────────────────────────────
  if (result.rippleEntities.length > 0) {
    const lines = ["## Ripple Impact"];
    lines.push("> Concepts connected to the directly-affected entities\n");

    // Group by depth
    const byDepth = new Map<number, ImpactEntity[]>();
    for (const e of result.rippleEntities) {
      if (!byDepth.has(e.depth)) byDepth.set(e.depth, []);
      byDepth.get(e.depth)!.push(e);
    }

    for (const [depth, ents] of [...byDepth.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      lines.push(`### ${depth} hop${depth > 1 ? "s" : ""} away`);
      for (const e of ents.sort((a, b) => b.confidence - a.confidence)) {
        const confStr =
          e.confidence < 0.9 ? ` [${Math.round(e.confidence * 100)}%]` : "";
        lines.push(`- **${e.name}** (${e.type})${confStr}`);
      }
      lines.push("");
    }
    sections.push(lines.join("\n"));
  }

  // ── Decision Trail ──────────────────────────────────────────────────
  if (result.decisions.length > 0) {
    const lines = ["## Affected Decisions"];
    lines.push("> Design decisions that may need revisiting\n");
    for (const d of result.decisions) {
      const verb = d.predicate === "DECIDED_FOR" ? "✅ chose" : "❌ rejected";
      const line = `- **${d.sourceName}** ${verb} **${d.targetName}**`;
      lines.push(d.rationale ? `${line}\n  > ${d.rationale}` : line);
    }
    lines.push("");
    sections.push(lines.join("\n"));
  }

  // ── Risks ───────────────────────────────────────────────────────────
  if (result.risks.length > 0) {
    const lines = ["## Risks & Blockers"];
    lines.push("> Potential issues from changing these files\n");
    for (const r of result.risks) {
      const icon = r.predicate === "BLOCKS" ? "🚫" : "⚠️";
      const line = `- ${icon} **${r.sourceName}** ${r.predicate.toLowerCase()} **${r.targetName}**`;
      lines.push(r.rationale ? `${line}\n  > ${r.rationale}` : line);
    }
    lines.push("");
    sections.push(lines.join("\n"));
  }

  // ── Key Relationships ───────────────────────────────────────────────
  if (result.relationships.length > 0) {
    // Show top relationships (excluding already-shown decisions and risks)
    const shownPreds = new Set([
      "DECIDED_FOR",
      "DECIDED_AGAINST",
      "RISKS",
      "BLOCKS",
    ]);
    const keyRels = result.relationships.filter(
      (r) => !shownPreds.has(r.predicate),
    );

    if (keyRels.length > 0) {
      const lines = ["## Key Relationships"];
      const byPred = new Map<string, ImpactRelationship[]>();
      for (const r of keyRels) {
        if (!byPred.has(r.predicate)) byPred.set(r.predicate, []);
        byPred.get(r.predicate)!.push(r);
      }

      for (const [pred, rels] of [...byPred.entries()].sort(
        (a, b) => b[1].length - a[1].length,
      )) {
        lines.push(`### ${pred} (${rels.length})`);
        for (const r of rels.slice(0, 10)) {
          lines.push(`- ${r.sourceName} → ${r.targetName}`);
          if (r.rationale) {
            lines.push(`  > ${r.rationale}`);
          }
        }
        if (rels.length > 10) {
          lines.push(`- _(${rels.length - 10} more)_`);
        }
        lines.push("");
      }
      sections.push(lines.join("\n"));
    }
  }

  // ── No impact ───────────────────────────────────────────────────────
  if (result.directEntities.length === 0) {
    sections.push("## No Impact Found");
    sections.push("No semantic concepts are linked to the specified file(s).");
    sections.push(
      "Run `iw xlink --persist` to create cross-layer links first.\n",
    );
  }

  return sections.join("\n");
}

/**
 * Format impact results as JSON.
 */
export function formatImpactJson(result: ImpactResult): string {
  return JSON.stringify(result, null, 2);
}

// =============================================================================
// Helpers
// =============================================================================

function emptyResult(files: string[], sessionId: string): ImpactResult {
  return {
    files,
    sessionId,
    directEntities: [],
    rippleEntities: [],
    relationships: [],
    decisions: [],
    risks: [],
    stats: {
      filesAnalyzed: files.length,
      directCount: 0,
      rippleCount: 0,
      totalRelationships: 0,
      decisionCount: 0,
      riskCount: 0,
    },
  };
}
