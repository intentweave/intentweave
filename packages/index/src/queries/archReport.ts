// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 10.1 Architecture Report — Data Collector
 *
 * Aggregates data from multiple CARI queries (layersInfer, communities,
 * dependencyDepth, boundaryViolations, hubs) into a single ArchReportData
 * payload. This payload is consumed by the HTML renderer to produce a
 * self-contained architecture visualization.
 */

import type Database from "better-sqlite3";
import type {
  ArchReportData,
  ArchReportNode,
  ArchReportEdge,
  NamedLayer,
  NamedDirectory,
} from "../types.js";
import { openIndex, buildImportGraph } from "./shared.js";
import { layersInferFromDb } from "./layersInfer.js";
import { communitiesFromDb } from "./communities.js";
import { dependencyDepthFromDb } from "./dependencyDepth.js";
import { boundaryViolationsFromDb } from "./boundaryViolations.js";
import { hubsFromDb } from "./hubs.js";

/** Options for architecture report generation. */
export interface ArchReportOptions {
  /** Pre-computed LLM layer names from nameLayers() */
  layerNames?: NamedLayer[];
  /** Pre-computed LLM directory names from nameLayers() */
  directoryNames?: NamedDirectory[];
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function archReport(dbPath: string, options?: ArchReportOptions): ArchReportData {
  const db = openIndex(dbPath);
  try {
    return archReportFromDb(db, options);
  } finally {
    db.close();
  }
}

export function archReportFromDb(db: Database.Database, options?: ArchReportOptions): ArchReportData {
  // 1. Gather data from underlying queries
  const layers = layersInferFromDb(db);
  const comms = communitiesFromDb(db);
  const depth = dependencyDepthFromDb(db);
  const boundaries = boundaryViolationsFromDb(db);
  const hubData = hubsFromDb(db);
  const importGraph = buildImportGraph(db);

  // 2. Build lookup maps

  // file → layer
  const fileToLayer = new Map<string, { index: number; label: string }>();
  for (const layer of layers.layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, { index: layer.index, label: layer.label });
    }
  }

  // file → community (from community members whose name matches a file path)
  const fileToCommunity = new Map<string, { id: number; label: string }>();
  for (const comm of comms.communities) {
    for (const member of comm.members) {
      // Members from imports/co_changes use file paths as names
      if (importGraph.allFiles.has(member.name)) {
        fileToCommunity.set(member.name, { id: comm.id, label: comm.label });
      }
      // Members from symbols have filePath set
      if (member.filePath && !fileToCommunity.has(member.filePath)) {
        fileToCommunity.set(member.filePath, {
          id: comm.id,
          label: comm.label,
        });
      }
    }
  }

  // file → depth entry
  const fileToDepth = new Map<
    string,
    {
      transitiveDependents: number;
      maxDepth: number;
      risk: "low" | "medium" | "high" | "critical";
    }
  >();
  for (const entry of depth.files) {
    fileToDepth.set(entry.filePath, {
      transitiveDependents: entry.transitiveDependents,
      maxDepth: entry.maxDepth,
      risk: entry.risk,
    });
  }

  // file → hub total degree
  const fileToHub = new Map<string, number>();
  for (const hub of hubData.hubs) {
    if (hub.filePath) {
      fileToHub.set(hub.filePath, hub.totalDegree);
    }
  }

  // 3. Collect the union of all files (code + docs)
  const allFiles = new Set<string>();
  for (const f of importGraph.allFiles) allFiles.add(f);
  for (const layer of layers.layers) {
    for (const f of layer.files) allFiles.add(f);
  }

  // Also include doc files that have annotations linking to code symbols
  const docFiles = new Set<string>();
  const docRows = db
    .prepare(
      `SELECT DISTINCT f.path FROM files f
       WHERE f.is_doc = 1
       AND EXISTS (
         SELECT 1 FROM annotations a
         WHERE a.doc_path = f.path AND a.symbol_id IS NOT NULL
       )`,
    )
    .all() as Array<{ path: string }>;
  for (const row of docRows) {
    docFiles.add(row.path);
    allFiles.add(row.path);
  }

  // 4. Build nodes
  const nodes: ArchReportNode[] = [];
  for (const filePath of allFiles) {
    const layer = fileToLayer.get(filePath) ?? { index: 0, label: "unknown" };
    const comm = fileToCommunity.get(filePath) ?? {
      id: -1,
      label: "ungrouped",
    };
    const d = fileToDepth.get(filePath);
    nodes.push({
      filePath,
      fileName: filePath.split("/").pop() ?? filePath,
      layerIndex: layer.index,
      layerLabel: layer.label,
      communityId: comm.id,
      communityLabel: comm.label,
      transitiveDependents: d?.transitiveDependents ?? 0,
      maxDepth: d?.maxDepth ?? 0,
      risk: d?.risk ?? "low",
      hubDegree: fileToHub.get(filePath) ?? 0,
      isDoc: docFiles.has(filePath),
    });
  }

  // 5. Build edges — import edges
  const edges: ArchReportEdge[] = [];
  for (const [source, targets] of importGraph.forward) {
    for (const target of targets) {
      edges.push({ source, target, type: "import" });
    }
  }

  // 6. Detect layer violations inline (avoids needing a YAML config)
  let layerViolationCount = 0;
  for (const [source, targets] of importGraph.forward) {
    const srcLayer = fileToLayer.get(source);
    if (srcLayer == null) continue;
    for (const target of targets) {
      const tgtLayer = fileToLayer.get(target);
      if (tgtLayer == null) continue;
      if (srcLayer.index < tgtLayer.index) {
        // Lower layer importing from higher layer → reverse violation
        edges.push({
          source,
          target,
          type: "layer-violation",
          violationType: "reverse",
          reason: `${srcLayer.label} (${srcLayer.index}) → ${tgtLayer.label} (${tgtLayer.index})`,
        });
        layerViolationCount++;
      }
    }
  }

  // 7. Boundary violation edges
  for (const v of boundaries.violations) {
    edges.push({
      source: v.sourceFile,
      target: v.targetFile,
      type: "boundary-violation",
      reason: v.reason,
    });
  }

  // 8. Build layer / community summaries
  const nameMap = new Map(
    (options?.layerNames ?? []).map((n) => [n.index, n]),
  );
  const layerSummary = layers.layers.map((l) => {
    const named = nameMap.get(l.index);
    return {
      index: l.index,
      label: l.label,
      fileCount: l.files.length,
      ...(named ? { llmName: named.name, description: named.description } : {}),
    };
  });

  const communityIds = new Set(nodes.map((n) => n.communityId));
  const commSummary = comms.communities
    .filter((c) => communityIds.has(c.id))
    .map((c) => ({ id: c.id, label: c.label, size: c.size }));

  // 9. Build file-level co-occurrence + co-change edges for Communities view
  const coEdges: ArchReportEdge[] = [];

  // Doc-code co-occurrence: docs that reference symbols in code files
  // Produces file-to-file edges (doc → code file) weighted by shared symbol count
  const docCodeRows = db
    .prepare(
      `SELECT s.file_path AS code_file, a.doc_path AS doc_file,
              COUNT(DISTINCT s.id) AS shared
       FROM symbols s
       JOIN annotations a ON a.symbol_id = s.id AND a.symbol_id IS NOT NULL
       WHERE s.file_path != a.doc_path
       GROUP BY s.file_path, a.doc_path
       HAVING shared >= 2
       ORDER BY shared DESC LIMIT 500`,
    )
    .all() as Array<{ code_file: string; doc_file: string; shared: number }>;
  const maxShared = docCodeRows.length > 0 ? docCodeRows[0].shared : 1;
  for (const row of docCodeRows) {
    coEdges.push({
      source: row.code_file,
      target: row.doc_file,
      type: "co-occurrence",
      weight: row.shared / maxShared,
    });
  }

  // Co-changes (file pairs from git history)
  const coChangeRows = db
    .prepare(
      `SELECT file_a, file_b, jaccard FROM co_changes
       WHERE jaccard > 0.1 ORDER BY jaccard DESC LIMIT 500`,
    )
    .all() as Array<{ file_a: string; file_b: string; jaccard: number }>;
  for (const row of coChangeRows) {
    coEdges.push({
      source: row.file_a,
      target: row.file_b,
      type: "co-change",
      weight: row.jaccard,
    });
  }

  // Build directory name map from LLM output
  const dirNames: Record<string, { name: string; description: string }> | undefined =
    options?.directoryNames?.length
      ? Object.fromEntries(
          options.directoryNames.map((d) => [
            d.path,
            { name: d.name, description: d.description },
          ]),
        )
      : undefined;

  return {
    meta: {
      generated: new Date().toISOString(),
      totalFiles: allFiles.size,
    },
    nodes,
    edges,
    coEdges,
    layers: layerSummary,
    communities: commSummary,
    ...(dirNames ? { directoryNames: dirNames } : {}),
    summary: {
      totalLayers: layers.layers.length,
      totalCommunities: commSummary.length,
      layerViolations: layerViolationCount,
      boundaryViolations: boundaries.totalViolations,
      highRiskFiles: nodes.filter(
        (n) => n.risk === "high" || n.risk === "critical",
      ).length,
    },
  };
}
