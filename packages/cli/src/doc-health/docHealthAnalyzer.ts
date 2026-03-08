// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Document Health Analyzer
 *
 * Answers: "Which parts of my documentation are stale, drifted, or missing?"
 *
 * Approach:
 *   1. For each document, find entities extracted from it (via RawTriple provenance)
 *   2. Compare those entities' current graph state against what the doc says:
 *      - **Stale**: Entity has been DECIDED_AGAINST or SUPERSEDED since extraction
 *      - **Drift**: Entity has gained new DEPENDS_ON / CONTAINS / IMPLEMENTS
 *        relationships not reflected in the document's triples
 *      - **Missing**: Canon entities with no RawTriple provenance from any .md file
 *   3. Score each document: fresh / warning / rotten based on issue counts
 *   4. Format as a structured report
 *
 * Data model:
 *   (:RawTriple {session_id, sourceFile, subject, predicate, object, rationale, confidence})
 *     -[:CANONICALIZED_FROM]-> (:Canon:Entity {name, type, session_id})
 *
 *   (:Canon:Entity) -[:CANON_REL {predicate}]-> (:Canon:Entity)
 */

import type { Neo4jRunner } from "../context/index.js";
import * as fs from "node:fs/promises";

// =============================================================================
// Types
// =============================================================================

/** A single issue found in a document */
export interface DocIssue {
  /** Issue severity */
  severity: "stale" | "drift" | "missing" | "contradiction" | "stale-temporal";
  /** Human-readable description */
  message: string;
  /** The entity name involved */
  entityName: string;
  /** Entity type */
  entityType: string;
  /** Detail for context (e.g., which predicate superseded, what new relationships exist) */
  detail?: string;
}

/** Health report for a single document */
export interface DocReport {
  /** File path of the document */
  filePath: string;
  /** Overall health score: fresh, warning, rotten */
  status: "fresh" | "warning" | "rotten";
  /** Entities mentioned in this document that are still current */
  freshCount: number;
  /** Total entities extracted from this document */
  totalCount: number;
  /** Percentage of entities still fresh (0-100) */
  freshnessPercent: number;
  /** Issues found */
  issues: DocIssue[];
}

/** Entity that exists in the graph but has no doc provenance */
export interface UndocumentedEntity {
  name: string;
  type: string;
  /** Number of relationships this entity participates in */
  relationshipCount: number;
}

/** Full doc-health analysis result */
export interface DocHealthResult {
  /** Session analyzed */
  sessionId: string;
  /** Per-document reports */
  reports: DocReport[];
  /** Entities with no documentation provenance */
  undocumented: UndocumentedEntity[];
  /** Aggregate stats */
  stats: {
    docsAnalyzed: number;
    freshDocs: number;
    warningDocs: number;
    rottenDocs: number;
    totalIssues: number;
    staleCount: number;
    driftCount: number;
    missingCount: number;
    contradictionCount: number;
    temporalCount: number;
    undocumentedCount: number;
  };
}

export interface DocHealthOptions {
  runner: Neo4jRunner;
  sessionId: string;
  /** Only analyze these files (optional — analyzes all session docs if omitted) */
  files?: string[];
  /** Minimum relationship count for undocumented entity to be flagged (default: 2) */
  minRelCount?: number;
  /** Working directory for resolving file paths (for mtime lookup). Omit to skip temporal checks. */
  cwd?: string;
  /** Log callback */
  log?: (msg: string) => void;
}

// =============================================================================
// Predicates that signal staleness
// =============================================================================

const STALE_PREDICATES = ["DECIDED_AGAINST", "SUPERSEDES", "REPLACES"] as const;
const DECISION_PREDICATES = ["DECIDED_FOR", "DECIDED_AGAINST"] as const;
const STRUCTURAL_PREDICATES = [
  "CONTAINS",
  "DEPENDS_ON",
  "IMPLEMENTS",
  "EXTENDS",
  "USES",
  "CALLS",
] as const;

// =============================================================================
// Main entry
// =============================================================================

/**
 * Analyze documentation health for a session.
 *
 * Steps:
 * 1. Find all documents (sourceFile from RawTriple) or filter to provided files
 * 2. For each document, get entities extracted from it
 * 3. Check each entity for staleness signals in the graph
 * 4. Check for structural drift (new relationships not in doc's triples)
 * 5. Find undocumented entities (canon entities with no RawTriple from any .md)
 */
export async function analyzeDocHealth(
  options: DocHealthOptions,
): Promise<DocHealthResult> {
  const {
    runner,
    sessionId,
    files,
    minRelCount = 2,
    cwd,
    log = () => {},
  } = options;

  // Step 1: Find all docs in the session
  log("Step 1: Discovering documents…");
  const docRows = await runner.run(
    `MATCH (rt:RawTriple)
     WHERE rt.session_id = $sid
     RETURN DISTINCT rt.sourceFile AS filePath
     ORDER BY filePath`,
    { sid: sessionId },
  );

  let docPaths = docRows
    .map((r) => String(r.filePath))
    .filter((p) => p && p !== "null" && p !== "undefined");

  // Filter to requested files if provided
  if (files && files.length > 0) {
    const normalized = new Set(files.map((f) => f.replace(/^\.\//, "")));
    docPaths = docPaths.filter((p) => {
      const norm = p.replace(/^\.\//, "");
      return normalized.has(norm) || normalized.has(p);
    });
  }

  log(`  Found ${docPaths.length} document(s)`);

  // Step 2–4: Analyze each document
  const reports: DocReport[] = [];

  for (const filePath of docPaths) {
    log(`Step 2-4: Analyzing ${filePath}…`);
    const report = await analyzeDocument(runner, sessionId, filePath, log, cwd);
    reports.push(report);
  }

  // Step 5: Find undocumented entities
  log("Step 5: Finding undocumented entities…");
  const undocumented = await findUndocumentedEntities(
    runner,
    sessionId,
    minRelCount,
  );
  log(`  Found ${undocumented.length} undocumented entity(ies)`);

  // Aggregate stats
  const stats = {
    docsAnalyzed: reports.length,
    freshDocs: reports.filter((r) => r.status === "fresh").length,
    warningDocs: reports.filter((r) => r.status === "warning").length,
    rottenDocs: reports.filter((r) => r.status === "rotten").length,
    totalIssues: reports.reduce((sum, r) => sum + r.issues.length, 0),
    staleCount: reports.reduce(
      (sum, r) => sum + r.issues.filter((i) => i.severity === "stale").length,
      0,
    ),
    driftCount: reports.reduce(
      (sum, r) => sum + r.issues.filter((i) => i.severity === "drift").length,
      0,
    ),
    missingCount: reports.reduce(
      (sum, r) => sum + r.issues.filter((i) => i.severity === "missing").length,
      0,
    ),
    contradictionCount: reports.reduce(
      (sum, r) =>
        sum + r.issues.filter((i) => i.severity === "contradiction").length,
      0,
    ),
    temporalCount: reports.reduce(
      (sum, r) =>
        sum + r.issues.filter((i) => i.severity === "stale-temporal").length,
      0,
    ),
    undocumentedCount: undocumented.length,
  };

  return { sessionId, reports, undocumented, stats };
}

// =============================================================================
// Per-document analysis
// =============================================================================

async function analyzeDocument(
  runner: Neo4jRunner,
  sessionId: string,
  filePath: string,
  log: (msg: string) => void,
  cwd?: string,
): Promise<DocReport> {
  const issues: DocIssue[] = [];

  // Get entities extracted from this document
  const entityRows = await runner.run(
    `MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(ce:Canon:Entity)
     WHERE rt.session_id = $sid AND rt.sourceFile = $file
     RETURN DISTINCT ce.name AS name, ce.type AS type, ce.canonId AS canonId`,
    { sid: sessionId, file: filePath },
  );

  const entities = entityRows.map((r) => ({
    name: String(r.name),
    type: String(r.type),
    canonId: String(r.canonId ?? r.name),
  }));

  if (entities.length === 0) {
    return {
      filePath,
      status: "fresh",
      freshCount: 0,
      totalCount: 0,
      freshnessPercent: 100,
      issues: [],
    };
  }

  const entityNames = entities.map((e) => e.name);

  // Check for staleness — all three predicates flag the TARGET as stale:
  //
  // Predicate semantics (direction matters!):
  //   A DECIDED_AGAINST B  →  B is stale (A rejected B)        → flag TARGET
  //   A SUPERSEDES B       →  B is stale (was superseded by A) → flag TARGET
  //   A REPLACES B         →  B is stale (was replaced by A)   → flag TARGET
  //
  // Example: SmartMock -[DECIDED_AGAINST]-> schema-driven generation
  //   SmartMock rejected schema-driven generation → schema-driven generation is stale
  //   (SmartMock is the decision-maker, NOT the thing that was rejected)
  //
  const stalenessRows = await runner.run(
    `MATCH (src:Canon:Entity)-[r:CANON_REL]->(tgt:Canon:Entity)
     WHERE tgt.session_id = $sid
       AND tgt.name IN $names
       AND r.predicate IN ['DECIDED_AGAINST', 'SUPERSEDES', 'REPLACES']
     RETURN tgt.name AS entityName, r.predicate AS predicate, src.name AS decidedBy`,
    { sid: sessionId, names: entityNames },
  );

  for (const row of stalenessRows) {
    const entityName = String(row.entityName);
    const pred = String(row.predicate);
    const decidedBy = String(row.decidedBy);
    const verbMap: Record<string, string> = {
      DECIDED_AGAINST: "decided against",
      SUPERSEDES: "superseded",
      REPLACES: "replaced",
    };
    issues.push({
      severity: "stale",
      message: `"${entityName}" was ${verbMap[pred] ?? pred} by "${decidedBy}"`,
      entityName,
      entityType:
        entities.find((e) => e.name === entityName)?.type ?? "unknown",
      detail: `${pred} by: ${decidedBy}`,
    });
  }

  // Check for drift: entities that gained structural relationships not in the doc's triples
  const driftRows = await runner.run(
    `MATCH (src:Canon:Entity)-[r:CANON_REL]->(tgt:Canon:Entity)
     WHERE src.session_id = $sid
       AND src.name IN $names
       AND r.predicate IN $structPreds
     WITH src.name AS entityName, r.predicate AS predicate, tgt.name AS target
     WHERE NOT EXISTS {
       MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(ce:Canon:Entity)
       WHERE rt.session_id = $sid AND rt.sourceFile = $file
         AND ce.name = target
     }
     RETURN entityName, collect(predicate + ' → ' + target) AS newRels`,
    {
      sid: sessionId,
      names: entityNames,
      structPreds: [...STRUCTURAL_PREDICATES],
      file: filePath,
    },
  );

  for (const row of driftRows) {
    const entityName = String(row.entityName);
    const newRels = row.newRels as string[];
    if (newRels && newRels.length > 0) {
      const preview = newRels.slice(0, 5).join(", ");
      const suffix = newRels.length > 5 ? ` (+${newRels.length - 5} more)` : "";
      issues.push({
        severity: "drift",
        message: `"${entityName}" has ${newRels.length} relationship(s) not covered by this document`,
        entityName,
        entityType:
          entities.find((e) => e.name === entityName)?.type ?? "unknown",
        detail: `New: ${preview}${suffix}`,
      });
    }
  }

  // Check for contradictions: doc says X DECIDED_FOR Y but graph says DECIDED_AGAINST Y
  const contradictionRows = await runner.run(
    `MATCH (rt:RawTriple)
     WHERE rt.session_id = $sid AND rt.sourceFile = $file
       AND rt.predicate IN ['DECIDED_FOR', 'DECIDED_AGAINST']
     WITH rt.subject AS subj, rt.predicate AS docPred, rt.object AS obj
     MATCH (src:Canon:Entity)-[r:CANON_REL]->(tgt:Canon:Entity)
     WHERE src.session_id = $sid
       AND toLower(src.name) = toLower(subj)
       AND toLower(tgt.name) = toLower(obj)
       AND r.predicate IN ['DECIDED_FOR', 'DECIDED_AGAINST']
       AND r.predicate <> docPred
     RETURN src.name AS entityName, docPred, r.predicate AS graphPred, tgt.name AS target`,
    { sid: sessionId, file: filePath },
  );

  for (const row of contradictionRows) {
    const entityName = String(row.entityName);
    const target = String(row.target);
    issues.push({
      severity: "contradiction",
      message: `Document says ${row.docPred} "${target}" but graph says ${row.graphPred}`,
      entityName,
      entityType:
        entities.find((e) => e.name === entityName)?.type ?? "unknown",
      detail: `Doc: ${row.docPred}, Graph: ${row.graphPred}`,
    });
  }

  // ─── Temporal staleness: entity updated_at > doc mtime ────────────
  if (cwd) {
    await checkTemporalStaleness(
      runner,
      sessionId,
      filePath,
      entities,
      issues,
      cwd,
      log,
    );
  }

  // Deduplicate issues by entity+severity
  const seen = new Set<string>();
  const deduped = issues.filter((i) => {
    const key = `${i.entityName}|${i.severity}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Compute freshness
  const staleEntityNames = new Set(
    deduped.filter((i) => i.severity === "stale").map((i) => i.entityName),
  );
  const freshCount = entities.filter(
    (e) => !staleEntityNames.has(e.name),
  ).length;
  const freshnessPercent =
    entities.length > 0
      ? Math.round((freshCount / entities.length) * 100)
      : 100;

  // Determine status
  let status: "fresh" | "warning" | "rotten";
  if (
    freshnessPercent >= 80 &&
    deduped.filter((i) => i.severity === "stale").length === 0
  ) {
    status = "fresh";
  } else if (
    freshnessPercent < 50 ||
    deduped.filter((i) => i.severity === "stale").length >= 3
  ) {
    status = "rotten";
  } else {
    status = "warning";
  }

  return {
    filePath,
    status,
    freshCount,
    totalCount: entities.length,
    freshnessPercent,
    issues: deduped,
  };
}

// =============================================================================
// Temporal staleness check
// =============================================================================

/**
 * Compare Canon:Entity `updated_at` against the document's filesystem `mtime`.
 *
 * If an entity was updated in the graph *after* the document was last modified,
 * something changed (e.g. another document or pipeline run updated the entity)
 * but this doc hasn't been touched — flag it.
 */
async function checkTemporalStaleness(
  runner: Neo4jRunner,
  sessionId: string,
  filePath: string,
  entities: Array<{ name: string; type: string; canonId: string }>,
  issues: DocIssue[],
  cwd: string,
  log: (msg: string) => void,
): Promise<void> {
  if (entities.length === 0) return;

  // Resolve document mtime
  let docMtime: Date;
  try {
    const resolvedPath = filePath.startsWith("/")
      ? filePath
      : `${cwd}/${filePath}`;
    const stat = await fs.stat(resolvedPath);
    docMtime = stat.mtime;
  } catch {
    // File doesn't exist on disk (might have been deleted) — skip temporal check
    log(`  Temporal: cannot stat ${filePath}, skipping`);
    return;
  }

  const entityNames = entities.map((e) => e.name);

  // Fetch updated_at for all entities extracted from this document
  const rows = await runner.run(
    `MATCH (ce:Canon:Entity)
     WHERE ce.session_id = $sid AND ce.name IN $names AND ce.updated_at IS NOT NULL
     RETURN ce.name AS name, ce.type AS type, ce.updated_at AS updatedAt`,
    { sid: sessionId, names: entityNames },
  );

  for (const row of rows) {
    const entityName = String(row.name);
    const entityType = String(row.type ?? "unknown");
    const updatedAt = row.updatedAt as any;

    // Neo4j returns DateTime objects — convert to JS Date
    let updatedDate: Date;
    if (updatedAt && typeof updatedAt.toStandardDate === "function") {
      updatedDate = updatedAt.toStandardDate() as Date;
    } else if (updatedAt instanceof Date) {
      updatedDate = updatedAt;
    } else if (typeof updatedAt === "string") {
      updatedDate = new Date(updatedAt);
    } else {
      continue; // Can't parse — skip
    }

    if (updatedDate > docMtime) {
      const daysBehind = Math.ceil(
        (updatedDate.getTime() - docMtime.getTime()) / (1000 * 60 * 60 * 24),
      );
      issues.push({
        severity: "stale-temporal",
        message: `"${entityName}" was updated in the graph ${daysBehind}d after this document was last modified`,
        entityName,
        entityType,
        detail: `Entity updated: ${updatedDate.toISOString().slice(0, 10)}, Doc modified: ${docMtime.toISOString().slice(0, 10)}`,
      });
    }
  }
}

// =============================================================================
// Undocumented entities
// =============================================================================

async function findUndocumentedEntities(
  runner: Neo4jRunner,
  sessionId: string,
  minRelCount: number,
): Promise<UndocumentedEntity[]> {
  // Find canon entities that have NO RawTriple provenance from any .md file
  const rows = await runner.run(
    `MATCH (ce:Canon:Entity)
     WHERE ce.session_id = $sid
     AND NOT EXISTS {
       MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(ce)
       WHERE rt.sourceFile ENDS WITH '.md'
     }
     WITH ce
     OPTIONAL MATCH (ce)-[r:CANON_REL]-()
     WITH ce.name AS name, ce.type AS type, count(r) AS relCount
     WHERE relCount >= $minRel
     RETURN name, type, relCount
     ORDER BY relCount DESC
     LIMIT 50`,
    { sid: sessionId, minRel: minRelCount },
  );

  return rows.map((r) => ({
    name: String(r.name),
    type: String(r.type),
    relationshipCount: Number(r.relCount) || 0,
  }));
}

// =============================================================================
// Formatters
// =============================================================================

const STATUS_ICONS: Record<string, string> = {
  fresh: "✅",
  warning: "⚠️",
  rotten: "🔴",
};

const SEVERITY_ICONS: Record<string, string> = {
  stale: "🪦",
  drift: "🔀",
  missing: "📭",
  contradiction: "⚡",
  "stale-temporal": "🕐",
};

export function formatDocHealthMarkdown(result: DocHealthResult): string {
  const lines: string[] = [];
  const { stats, reports, undocumented, sessionId } = result;

  // ── Header ──────────────────────────────────────────────────────────
  lines.push(`# 📋 Documentation Health Report`);
  lines.push("");
  lines.push(`**Session:** ${sessionId}`);
  lines.push(`**Documents analyzed:** ${stats.docsAnalyzed}`);
  lines.push("");

  // ── Summary bar ─────────────────────────────────────────────────────
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Status | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| ✅ Fresh | ${stats.freshDocs} |`);
  lines.push(`| ⚠️ Warning | ${stats.warningDocs} |`);
  lines.push(`| 🔴 Rotten | ${stats.rottenDocs} |`);
  lines.push("");

  if (stats.totalIssues > 0) {
    lines.push(`**Issues found:** ${stats.totalIssues}`);
    const issueParts: string[] = [];
    if (stats.staleCount > 0) issueParts.push(`🪦 ${stats.staleCount} stale`);
    if (stats.driftCount > 0) issueParts.push(`🔀 ${stats.driftCount} drift`);
    if (stats.contradictionCount > 0)
      issueParts.push(`⚡ ${stats.contradictionCount} contradiction`);
    if (stats.temporalCount > 0)
      issueParts.push(`🕐 ${stats.temporalCount} temporal`);
    if (stats.missingCount > 0)
      issueParts.push(`📭 ${stats.missingCount} missing`);
    lines.push(issueParts.join(" · "));
    lines.push("");
  }

  // ── Per-doc reports (worst first) ───────────────────────────────────
  const sortOrder: Record<string, number> = { rotten: 0, warning: 1, fresh: 2 };
  const sorted = [...reports].sort(
    (a, b) => (sortOrder[a.status] ?? 2) - (sortOrder[b.status] ?? 2),
  );

  for (const report of sorted) {
    const icon = STATUS_ICONS[report.status] ?? "?";
    lines.push(`### ${icon} ${report.filePath}`);
    lines.push("");
    lines.push(
      `**Freshness:** ${report.freshnessPercent}% (${report.freshCount}/${report.totalCount} entities current)`,
    );
    lines.push("");

    if (report.issues.length === 0) {
      lines.push("No issues found.");
      lines.push("");
      continue;
    }

    for (const issue of report.issues) {
      const sIcon = SEVERITY_ICONS[issue.severity] ?? "•";
      lines.push(`- ${sIcon} **${issue.severity}**: ${issue.message}`);
      if (issue.detail) {
        lines.push(`  - ${issue.detail}`);
      }
    }
    lines.push("");
  }

  // ── Undocumented entities ───────────────────────────────────────────
  if (undocumented.length > 0) {
    lines.push("## 📭 Undocumented Entities");
    lines.push("");
    lines.push(
      "These entities exist in the knowledge graph but have no documentation provenance:",
    );
    lines.push("");
    lines.push("| Entity | Type | Relationships |");
    lines.push("| --- | --- | --- |");

    for (const ent of undocumented.slice(0, 30)) {
      lines.push(`| ${ent.name} | ${ent.type} | ${ent.relationshipCount} |`);
    }
    if (undocumented.length > 30) {
      lines.push(`| … | _+${undocumented.length - 30} more_ | |`);
    }
    lines.push("");
  }

  // ── Recommendations ─────────────────────────────────────────────────
  if (stats.totalIssues > 0 || undocumented.length > 0) {
    lines.push("## 💡 Recommendations");
    lines.push("");
    if (stats.staleCount > 0) {
      lines.push(
        "- **Update stale references**: Remove or update mentions of entities that have been superseded or decided against.",
      );
    }
    if (stats.driftCount > 0) {
      lines.push(
        "- **Document new relationships**: Some entities have evolved since the documentation was written. Consider updating the docs to reflect new dependencies and connections.",
      );
    }
    if (stats.contradictionCount > 0) {
      lines.push(
        "- **Resolve contradictions**: Some documents state decisions that conflict with the current graph state.",
      );
    }
    if (stats.temporalCount > 0) {
      lines.push(
        "- **Review temporally stale docs**: Some entities were updated in the knowledge graph after the document was last modified. Re-check those sections for accuracy.",
      );
    }
    if (undocumented.length > 0) {
      lines.push(
        `- **Document new entities**: ${undocumented.length} entity(ies) with significant graph presence have no documentation.`,
      );
    }
    lines.push("");
  }

  // ── Tip ─────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push(
    "_Run `iw doc-health` periodically to catch documentation rot early._",
  );
  lines.push(
    "_Use `iw context --entity <name>` to understand an entity before updating docs._",
  );

  return lines.join("\n");
}

export function formatDocHealthJson(result: DocHealthResult): string {
  return JSON.stringify(result, null, 2);
}
