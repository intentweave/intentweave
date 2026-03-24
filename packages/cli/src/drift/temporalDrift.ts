// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Temporal Drift Detector (C2)
 *
 * Uses TCG data (commits, co-change, hotspots, staleness, ownership) combined
 * with KWG data (entities, mentions) to detect temporal drift:
 *
 *   1. **Enhanced staleness** — Doc not updated despite related code changes.
 *      Incorporates KWG entity-level info beyond the basic STL stage.
 *
 *   2. **Decision volatility** — Docs with frequent rewrites around decision-
 *      qualified mentions suggest unstable decisions.
 *
 *   3. **Correlated change lag** — Doc co-changes with a code file (high
 *      CO_CHANGED_WITH), but recently the code changed without the doc.
 *
 *   4. **Abandoned code** — Doc mentions entity, but the associated code file
 *      hasn't been touched in months and has no clear owner.
 *
 * All non-LLM, $0. Pure function on serializable inputs.
 *
 * @see PHASE-C-SPEC.md §5
 * @version 0.1
 */

import type {
  DriftSignal,
  DriftEvidence,
  TemporalDriftInput,
  TemporalDriftOutput,
  KwgEntityForDrift,
  KwgMentionForDrift,
} from "@intentweave/core";
import type {
  TcgPipelineOutput,
  CommitRecord,
  CoChangeEdge,
  HotspotSignal,
  OwnershipRecord,
  StalenessSignal,
} from "@intentweave/core";

// =============================================================================
// Constants
// =============================================================================

/** Default staleness threshold in days */
const DEFAULT_MIN_STALENESS_DAYS = 14;

/** Commit count threshold for decision volatility */
const VOLATILITY_WARN_THRESHOLD = 5;
const VOLATILITY_INFO_THRESHOLD = 3;

/** Line proximity for matching commits to mentions (±N lines) */
const MENTION_LINE_PROXIMITY = 20;

/** Days threshold for abandoned code detection */
const ABANDONED_THRESHOLD_DAYS = 180;

/** Recency window for correlated change lag (days) */
const COCHANGE_LAG_WINDOW_DAYS = 30;

/** Minimum Jaccard score to consider a co-change pair "strong" */
const STRONG_COCHANGE_JACCARD = 0.3;

// =============================================================================
// Main Detector
// =============================================================================

/**
 * Detect temporal drift from TCG + KWG data.
 *
 * Pure function — no Neo4j queries, no side effects.
 */
export function detectTemporalDrift(input: TemporalDriftInput): TemporalDriftOutput {
  const startTime = performance.now();
  const log = input.log ?? (() => {});
  const minStalenessDays = input.minStalenessDays ?? DEFAULT_MIN_STALENESS_DAYS;

  const { tcgOutput, kwgEntities, kwgMentions, workspaceRoot } = input;
  const signals: DriftSignal[] = [];

  // ── Pre-compute lookups ────────────────────────────────────────────────
  const fileLastModified = buildFileLastModifiedMap(tcgOutput);
  const fileCommitCount = buildFileCommitCountMap(tcgOutput);
  const hotspotMap = buildHotspotMap(tcgOutput);
  const ownershipMap = buildOwnershipMap(tcgOutput);
  const coChangeEdges = tcgOutput.coc.edges;
  const stlSignals = tcgOutput.stl.signals;

  log(`Temporal drift: ${tcgOutput.tcx.commits.length} commits, ${Object.keys(fileLastModified).length} files`);

  // ── Pass 1: Enhanced staleness ─────────────────────────────────────────
  log("Pass 1: enhanced staleness...");
  const stalenessSignals = detectEnhancedStaleness(
    stlSignals, hotspotMap, ownershipMap, fileCommitCount, minStalenessDays, log,
  );
  signals.push(...stalenessSignals);

  // ── Pass 2: Decision volatility ────────────────────────────────────────
  if (kwgEntities && kwgMentions && kwgMentions.length > 0) {
    log("Pass 2: decision volatility...");
    const volatilitySignals = detectDecisionVolatility(
      kwgEntities, kwgMentions, tcgOutput, log,
    );
    signals.push(...volatilitySignals);
  }

  // ── Pass 3: Correlated change lag ──────────────────────────────────────
  if (coChangeEdges.length > 0) {
    log("Pass 3: correlated change lag...");
    const lagSignals = detectCorrelatedChangeLag(
      coChangeEdges, fileLastModified, tcgOutput, log,
    );
    signals.push(...lagSignals);
  }

  // ── Pass 4: Abandoned code ─────────────────────────────────────────────
  if (kwgEntities && kwgEntities.length > 0) {
    log("Pass 4: abandoned code...");
    const abandonedSignals = detectAbandonedCode(
      kwgEntities, fileLastModified, log,
    );
    signals.push(...abandonedSignals);
  }

  const durationMs = Math.round(performance.now() - startTime);
  log(`Temporal drift: ${signals.length} signals (${durationMs}ms)`);

  return {
    signals,
    stats: {
      enabled: true,
      signalCount: signals.length,
      durationMs,
      metrics: {
        stalenessSignals: stalenessSignals.length,
        volatilitySignals: signals.filter(s => s.category === "temporal-volatile").length,
        lagSignals: signals.filter(s => s.category === "temporal-stale" && s.evidence.footprintSimilarity !== undefined).length,
        abandonedSignals: signals.filter(s => s.category === "abandoned-code").length,
        totalCommits: tcgOutput.tcx.commits.length,
        totalFiles: Object.keys(fileLastModified).length,
      },
    },
  };
}

// =============================================================================
// Pass 1: Enhanced Staleness
// =============================================================================

function detectEnhancedStaleness(
  stlSignals: StalenessSignal[],
  hotspotMap: Map<string, HotspotSignal>,
  ownershipMap: Map<string, OwnershipRecord>,
  fileCommitCount: Map<string, number>,
  minStalenessDays: number,
  log: (msg: string) => void,
): DriftSignal[] {
  const signals: DriftSignal[] = [];

  for (const stl of stlSignals) {
    if (stl.stalenessScore < minStalenessDays) continue;

    const hotspot = hotspotMap.get(stl.filePath);
    const ownership = ownershipMap.get(stl.filePath);
    const isHotspot = hotspot !== undefined && hotspot.zScore > 2.0;

    // Count code commits since doc was last updated
    let codeCommitsSinceDoc = 0;
    for (const related of stl.fresherRelatedFiles) {
      codeCommitsSinceDoc += fileCommitCount.get(related.filePath) ?? 0;
    }

    // Severity based on staleness + hotspot status
    let severity: DriftSignal["severity"];
    if (isHotspot && stl.stalenessScore > 90) {
      severity = "critical";
    } else if (stl.stalenessScore > 30) {
      severity = "warning";
    } else {
      severity = "info";
    }

    const hotspotStr = isHotspot ? `, code is hotspot (z=${hotspot!.zScore.toFixed(1)})` : "";
    const ownerStr = ownership?.primaryOwner ? `, owner: ${ownership.primaryOwner}` : "";

    signals.push({
      category: "temporal-stale",
      severity,
      detector: "temporal",
      message: `"${stl.filePath}" is ${stl.stalenessScore}d stale${hotspotStr}${ownerStr}, ${codeCommitsSinceDoc} code commits since doc update`,
      name: stl.filePath,
      files: [stl.filePath, ...stl.fresherRelatedFiles.map(f => f.filePath)],
      evidence: {
        docStalenessDays: stl.stalenessScore,
        codeCommitsSinceDocUpdate: codeCommitsSinceDoc,
        lastDocModified: stl.lastModified,
        lastCodeModified: stl.fresherRelatedFiles[0]?.lastModified,
        isHotspot,
        hotspotZScore: hotspot?.zScore,
        codeOwner: ownership?.primaryOwner,
      },
    });
  }

  log(`  → ${signals.length} staleness signals`);
  return signals;
}

// =============================================================================
// Pass 2: Decision Volatility
// =============================================================================

function detectDecisionVolatility(
  kwgEntities: KwgEntityForDrift[],
  kwgMentions: KwgMentionForDrift[],
  tcgOutput: TcgPipelineOutput,
  log: (msg: string) => void,
): DriftSignal[] {
  const signals: DriftSignal[] = [];

  // Find entities with "decision" qualifier
  const decisionEntities = kwgEntities.filter(e =>
    e.qualifiers.includes("decision"),
  );

  if (decisionEntities.length === 0) {
    log("  → 0 decision entities, skipping volatility check");
    return signals;
  }

  // Build commit index by file path
  const commitsByFile = buildCommitsByFileMap(tcgOutput);

  // Build mentions by entity
  const mentionsByEntity = new Map<string, KwgMentionForDrift[]>();
  for (const m of kwgMentions) {
    const lower = m.entityName.toLowerCase();
    if (!mentionsByEntity.has(lower)) mentionsByEntity.set(lower, []);
    mentionsByEntity.get(lower)!.push(m);
  }

  for (const entity of decisionEntities) {
    const entityMentions = mentionsByEntity.get(entity.name.toLowerCase()) ?? [];
    if (entityMentions.length === 0) continue;

    // For each doc file with mentions, count commits near the mention lines
    const docFiles = [...new Set(entityMentions.map(m => m.filePath))];
    let totalNearCommits = 0;

    for (const docFile of docFiles) {
      const fileMentions = entityMentions.filter(m => m.filePath === docFile);
      const fileCommits = commitsByFile.get(docFile) ?? [];

      // Count unique commits that Modified lines within ±MENTION_LINE_PROXIMITY
      // of any mention's startLine. Since we don't have per-line diff data in TCG,
      // we count total commits to the doc file as a proxy.
      // (A future enhancement could use git blame or per-hunk diffs.)
      totalNearCommits += fileCommits.length;
    }

    if (totalNearCommits >= VOLATILITY_WARN_THRESHOLD) {
      signals.push({
        category: "temporal-volatile",
        severity: "warning",
        detector: "temporal",
        message: `Decision "${entity.name}" has been modified ${totalNearCommits} times — may be unstable`,
        name: entity.name,
        files: docFiles,
        evidence: {
          mentionCount: entity.mentionCount,
          qualifiers: entity.qualifiers as DriftEvidence["qualifiers"],
          decisionVolatility: totalNearCommits,
        },
      });
    } else if (totalNearCommits >= VOLATILITY_INFO_THRESHOLD) {
      signals.push({
        category: "temporal-volatile",
        severity: "info",
        detector: "temporal",
        message: `Decision "${entity.name}" has been modified ${totalNearCommits} times`,
        name: entity.name,
        files: docFiles,
        evidence: {
          mentionCount: entity.mentionCount,
          qualifiers: entity.qualifiers as DriftEvidence["qualifiers"],
          decisionVolatility: totalNearCommits,
        },
      });
    }
  }

  log(`  → ${signals.length} decision volatility signals`);
  return signals;
}

// =============================================================================
// Pass 3: Correlated Change Lag
// =============================================================================

function detectCorrelatedChangeLag(
  coChangeEdges: CoChangeEdge[],
  fileLastModified: Record<string, string>,
  tcgOutput: TcgPipelineOutput,
  log: (msg: string) => void,
): DriftSignal[] {
  const signals: DriftSignal[] = [];
  const now = new Date();
  const windowMs = COCHANGE_LAG_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - windowMs);

  // Only consider strong co-change pairs involving a doc file
  const isDocFile = (fp: string) =>
    /\.(md|mdx|txt|rst|adoc)$/i.test(fp);

  // Build recent commit index: file → commits after cutoff
  const recentCommitsByFile = new Map<string, CommitRecord[]>();
  for (const commit of tcgOutput.tcx.commits) {
    const commitDate = new Date(commit.date);
    if (commitDate < cutoff) continue;
    for (const file of commit.files) {
      if (!recentCommitsByFile.has(file.filePath)) {
        recentCommitsByFile.set(file.filePath, []);
      }
      recentCommitsByFile.get(file.filePath)!.push(commit);
    }
  }

  for (const edge of coChangeEdges) {
    if (edge.jaccardScore < STRONG_COCHANGE_JACCARD) continue;

    // Identify doc ↔ code pair
    let docFile: string | undefined;
    let codeFile: string | undefined;

    if (isDocFile(edge.fileA) && !isDocFile(edge.fileB)) {
      docFile = edge.fileA;
      codeFile = edge.fileB;
    } else if (isDocFile(edge.fileB) && !isDocFile(edge.fileA)) {
      docFile = edge.fileB;
      codeFile = edge.fileA;
    } else {
      continue; // Skip code↔code or doc↔doc pairs
    }

    // Check: did the code file change recently without the doc?
    const recentCodeCommits = recentCommitsByFile.get(codeFile) ?? [];
    const recentDocCommits = recentCommitsByFile.get(docFile) ?? [];

    if (recentCodeCommits.length > 0 && recentDocCommits.length === 0) {
      signals.push({
        category: "temporal-stale",
        severity: "warning",
        detector: "temporal",
        message: `"${docFile}" co-changes with "${codeFile}" (Jaccard=${edge.jaccardScore.toFixed(2)}) but code was modified ${recentCodeCommits.length}× in the last ${COCHANGE_LAG_WINDOW_DAYS}d without updating the doc`,
        name: docFile,
        files: [docFile, codeFile],
        evidence: {
          docStalenessDays: daysBetween(fileLastModified[docFile], now.toISOString()),
          codeCommitsSinceDocUpdate: recentCodeCommits.length,
          lastDocModified: fileLastModified[docFile],
          lastCodeModified: fileLastModified[codeFile],
          footprintSimilarity: edge.jaccardScore, // reuse for co-change signal identification
        },
      });
    }
  }

  log(`  → ${signals.length} correlated change lag signals`);
  return signals;
}

// =============================================================================
// Pass 4: Abandoned Code
// =============================================================================

function detectAbandonedCode(
  kwgEntities: KwgEntityForDrift[],
  fileLastModified: Record<string, string>,
  log: (msg: string) => void,
): DriftSignal[] {
  const signals: DriftSignal[] = [];
  const now = new Date();

  // Find code file paths mentioned in KWG entities
  // KWG entity filePaths are typically doc files — we need to identify
  // code files that share entity names.
  // For v1: we flag code files (non-doc) in fileLastModified that haven't been
  // touched in >= ABANDONED_THRESHOLD_DAYS and are associated with KWG entities.
  const isDocFile = (fp: string) => /\.(md|mdx|txt|rst|adoc)$/i.test(fp);
  const isCodeFile = (fp: string) => !isDocFile(fp) && !/\.(json|yaml|yml|lock|toml)$/i.test(fp);

  // Collect code files that are old
  const abandonedCodeFiles: Array<{ filePath: string; daysSince: number }> = [];
  for (const [filePath, lastMod] of Object.entries(fileLastModified)) {
    if (!isCodeFile(filePath)) continue;
    const days = daysBetween(lastMod, now.toISOString());
    if (days >= ABANDONED_THRESHOLD_DAYS) {
      abandonedCodeFiles.push({ filePath, daysSince: days });
    }
  }

  if (abandonedCodeFiles.length === 0) {
    log("  → 0 abandoned code files");
    return signals;
  }

  // For each abandoned code file, check if any KWG entity references it
  // (entity.filePaths contains doc files that mention the entity, but
  // the entity name might match the code file name)
  const entityNames = new Set(kwgEntities.map(e => e.name.toLowerCase()));

  for (const { filePath, daysSince } of abandonedCodeFiles) {
    // Extract filename stem for matching
    const stem = filePath
      .replace(/^.*[\\/]/, "") // basename
      .replace(/\.[^.]+$/, "") // remove extension
      .toLowerCase();

    // Check if any entity name matches this file's stem
    if (entityNames.has(stem)) {
      // Find doc files that mention this entity
      const mentioningEntity = kwgEntities.find(
        e => e.name.toLowerCase() === stem,
      );
      const docFiles = mentioningEntity?.filePaths ?? [];

      signals.push({
        category: "abandoned-code",
        severity: "info",
        detector: "temporal",
        message: `"${filePath}" has not been modified in ${daysSince} days but is still referenced in docs`,
        name: filePath,
        files: [filePath, ...docFiles],
        evidence: {
          docStalenessDays: daysSince,
          lastCodeModified: fileLastModified[filePath],
          mentionCount: mentioningEntity?.mentionCount,
        },
      });
    }
  }

  log(`  → ${signals.length} abandoned code signals`);
  return signals;
}

// =============================================================================
// Utility: Build Lookup Maps
// =============================================================================

/** Build file → last modified date map from TCG output */
function buildFileLastModifiedMap(tcg: TcgPipelineOutput): Record<string, string> {
  const map: Record<string, string> = {};
  for (const commit of tcg.tcx.commits) {
    const commitDate = commit.date;
    for (const file of commit.files) {
      if (!map[file.filePath] || commitDate > map[file.filePath]) {
        map[file.filePath] = commitDate;
      }
    }
  }
  return map;
}

/** Build file → total commit count map */
function buildFileCommitCountMap(tcg: TcgPipelineOutput): Map<string, number> {
  const map = new Map<string, number>();
  for (const commit of tcg.tcx.commits) {
    for (const file of commit.files) {
      map.set(file.filePath, (map.get(file.filePath) ?? 0) + 1);
    }
  }
  return map;
}

/** Build file → HotspotSignal map */
function buildHotspotMap(tcg: TcgPipelineOutput): Map<string, HotspotSignal> {
  const map = new Map<string, HotspotSignal>();
  for (const h of tcg.hot.hotspots) {
    map.set(h.filePath, h);
  }
  return map;
}

/** Build file → OwnershipRecord map */
function buildOwnershipMap(tcg: TcgPipelineOutput): Map<string, OwnershipRecord> {
  const map = new Map<string, OwnershipRecord>();
  for (const o of tcg.own.ownership) {
    map.set(o.filePath, o);
  }
  return map;
}

/** Build file → CommitRecord[] map */
function buildCommitsByFileMap(tcg: TcgPipelineOutput): Map<string, CommitRecord[]> {
  const map = new Map<string, CommitRecord[]>();
  for (const commit of tcg.tcx.commits) {
    for (const file of commit.files) {
      if (!map.has(file.filePath)) map.set(file.filePath, []);
      map.get(file.filePath)!.push(commit);
    }
  }
  return map;
}

/** Calculate days between two ISO-8601 dates */
function daysBetween(dateA: string | undefined, dateB: string): number {
  if (!dateA) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(
    Math.abs(new Date(dateB).getTime() - new Date(dateA).getTime()) / msPerDay,
  );
}
