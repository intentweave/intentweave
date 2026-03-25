// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KWG+ (Keyword Graph Plus) builder — unified KWG + TCG + Drift view.
 *
 * Layers:
 *   1. KWG base       — KWEntity, KWDoc, KWCluster (Phase A)
 *   2. TCG overlay     — TCGFile, TCGCommit, TCGAuthor (Phase B)
 *   3. SCG overlay     — SCG:File, SCG:Symbol (Phase E)
 *   4. Cross-layer     — KWDoc ↔ TCGFile ↔ SCG:File same-file links
 *   5. Drift signals   — DriftSignal nodes (Phase C)
 *
 * Each layer is independently queried; if a layer is empty (not yet persisted),
 * the builder gracefully returns what is available.
 *
 * @see LAYERED-GRAPH-ARCHITECTURE.md
 * @version 0.1
 */

import type {
  InsightNode,
  InsightEdge,
  InsightResponse,
  KnowledgeGraphData,
  NodeKind,
} from "./types.js";

// ── Runner interface ─────────────────────────────────────────────────────────

interface CypherRunner {
  run: (
    cypher: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>[]>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuildKwgPlusGraphOpts {
  runner: CypherRunner;
  sessionId: string;
  question?: string;
  maxNodes?: number;
}

export async function buildKwgPlusGraph(
  opts: BuildKwgPlusGraphOpts,
): Promise<InsightResponse> {
  const { runner, sessionId, question, maxNodes = 200 } = opts;
  const t0 = Date.now();

  const nodeMap = new Map<string, InsightNode>();
  const edges: InsightEdge[] = [];

  // ── 1. KWG Layer — entities, docs, clusters ─────────────────────────────
  await fetchKwgLayer(runner, sessionId, question, maxNodes, nodeMap, edges);

  // ── 2. TCG Layer — files, commits, authors ──────────────────────────────
  const tcgStats = await fetchTcgLayer(
    runner,
    sessionId,
    maxNodes,
    nodeMap,
    edges,
  );

  // ── 3. SCG Layer — code files, symbols ─────────────────────────────────
  const scgStats = await fetchScgLayer(
    runner,
    sessionId,
    maxNodes,
    nodeMap,
    edges,
  );

  // ── 4. Cross-layer links — KWDoc ↔ TCGFile ↔ SCG:File by file path ────
  await fetchCrossLayerLinks(runner, sessionId, nodeMap, edges);

  // ── 5. Drift signals (Phase C) ─────────────────────────────────────────
  const driftStats = await fetchDriftLayer(
    runner,
    sessionId,
    maxNodes,
    nodeMap,
    edges,
  );

  // ── 5. Compute depth from connectivity ──────────────────────────────────
  const nodes = [...nodeMap.values()];
  const maxConn = Math.max(...nodes.map((n) => n.connections?.length ?? 0), 1);
  for (const n of nodes) {
    const cc = n.connections?.length ?? 0;
    n.depth = cc > maxConn * 0.6 ? 0 : cc > maxConn * 0.2 ? 1 : 2;
  }

  // ── 6. Count totals ────────────────────────────────────────────────────
  const totalEntities = await countTotalKwg(runner, sessionId);
  const totalRelationships = edges.length;

  const layerInfo: string[] = ["KWG"];
  if (tcgStats.nodeCount > 0) layerInfo.push(`TCG(${tcgStats.nodeCount})`);
  if (scgStats.nodeCount > 0) layerInfo.push(`SCG(${scgStats.nodeCount})`);
  if (driftStats.nodeCount > 0)
    layerInfo.push(`Drift(${driftStats.nodeCount})`);

  const title = question
    ? `KWG+: "${question}" [${layerInfo.join("+")}]`
    : `KWG+ Overview [${layerInfo.join("+")}]`;

  const data: KnowledgeGraphData = {
    nodes,
    edges,
    totalEntities,
    totalRelationships,
  };

  return {
    vizType: "knowledge-graph",
    title,
    data,
    meta: {
      session: sessionId,
      entityCount: nodes.length,
      edgeCount: edges.length,
      queryTimeMs: Date.now() - t0,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 1: KWG (reuses logic from kwg-graph.ts)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchKwgLayer(
  runner: CypherRunner,
  sessionId: string,
  question: string | undefined,
  maxNodes: number,
  nodeMap: Map<string, InsightNode>,
  edges: InsightEdge[],
): Promise<void> {
  // Fetch entities — keyword-filtered or top-connected
  let entityRows: Record<string, unknown>[];

  if (question && question.trim().length > 0) {
    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    if (keywords.length > 0) {
      const kwFilter = keywords
        .map((kw) => `toLower(e.name) CONTAINS "${kw.replace(/"/g, '\\"')}"`)
        .join(" OR ");

      entityRows = await runner.run(
        `MATCH (e:KWEntity {session_id: $sid})
         WHERE ${kwFilter}
         OPTIONAL MATCH ()-[r]->(e)
         WITH e, count(r) AS rels ORDER BY rels DESC LIMIT $limit
         RETURN e.name AS name, e.type AS type, e.mentionCount AS mentionCount,
                e.qualifiers AS qualifiers, e.predominantSource AS predominantSource,
                e.filePaths AS filePaths`,
        { sid: sessionId, limit: maxNodes },
      );
    } else {
      entityRows = [];
    }

    if (entityRows.length === 0) {
      entityRows = await runner.run(
        `MATCH (e:KWEntity {session_id: $sid})
         OPTIONAL MATCH ()-[r]->(e)
         WITH e, count(r) AS rels ORDER BY rels DESC LIMIT $limit
         RETURN e.name AS name, e.type AS type, e.mentionCount AS mentionCount,
                e.qualifiers AS qualifiers, e.predominantSource AS predominantSource,
                e.filePaths AS filePaths`,
        { sid: sessionId, limit: maxNodes },
      );
    }
  } else {
    entityRows = await runner.run(
      `MATCH (e:KWEntity {session_id: $sid})
       OPTIONAL MATCH ()-[r]->(e)
       WITH e, count(r) AS rels ORDER BY rels DESC LIMIT $limit
       RETURN e.name AS name, e.type AS type, e.mentionCount AS mentionCount,
              e.qualifiers AS qualifiers, e.predominantSource AS predominantSource,
              e.filePaths AS filePaths`,
      { sid: sessionId, limit: maxNodes },
    );
  }

  const entityNames = new Set<string>();

  for (const r of entityRows) {
    const name = r.name as string;
    if (!name) continue;
    const id = `kwent:${name}`;
    entityNames.add(name);
    const mentionCount = (r.mentionCount as number) ?? 1;
    const confidence = Math.min(mentionCount / 20, 1.0);

    nodeMap.set(id, {
      id,
      label: name,
      kind: "concept",
      entityType: (r.type as string) ?? "keyword",
      confidence,
      aliases: r.qualifiers as string[] | undefined,
      rawTriples: [],
      connections: [],
    });
  }

  if (entityNames.size === 0) return;

  const nameList = [...entityNames]
    .map((n) => `"${n.replace(/"/g, '\\"')}"`)
    .join(", ");

  // KWDoc nodes
  const docRows = await runner.run(
    `MATCH (d:KWDoc {session_id: $sid})-[:KW_MENTIONS]->(e:KWEntity {session_id: $sid})
     WHERE e.name IN [${nameList}]
     WITH DISTINCT d
     RETURN d.filePath AS docPath, d.entityCount AS entityCount, d.mentionCount AS mentionCount
     LIMIT 500`,
    { sid: sessionId },
  );

  for (const r of docRows) {
    const docPath = r.docPath as string;
    if (!docPath) continue;
    const docId = `kwdoc:${docPath}`;
    if (!nodeMap.has(docId)) {
      const label = docPath.split("/").pop() ?? docPath;
      nodeMap.set(docId, {
        id: docId,
        label,
        kind: "topic",
        entityType: "document",
        sourceDoc: docPath,
        rawTriples: [],
        connections: [],
      });
    }
  }

  // KW_MENTIONS edges
  const mentionRows = await runner.run(
    `MATCH (d:KWDoc {session_id: $sid})-[:KW_MENTIONS]->(e:KWEntity {session_id: $sid})
     WHERE e.name IN [${nameList}]
     RETURN d.filePath AS docPath, e.name AS entityName`,
    { sid: sessionId },
  );

  for (const r of mentionRows) {
    const docId = `kwdoc:${r.docPath as string}`;
    const entId = `kwent:${r.entityName as string}`;
    if (nodeMap.has(docId) && nodeMap.has(entId)) {
      edges.push({ source: docId, target: entId, label: "MENTIONS" });
      addConnection(nodeMap, docId, entId, "MENTIONS");
    }
  }

  // CO_OCCURS edges
  const cooccurRows = await runner.run(
    `MATCH (a:KWEntity {session_id: $sid})-[r:CO_OCCURS]->(b:KWEntity {session_id: $sid})
     WHERE a.name IN [${nameList}] AND b.name IN [${nameList}]
     RETURN a.name AS entityA, b.name AS entityB, r.count AS count, r.score AS score
     ORDER BY r.score DESC
     LIMIT 500`,
    { sid: sessionId },
  );

  for (const r of cooccurRows) {
    const srcId = `kwent:${r.entityA as string}`;
    const tgtId = `kwent:${r.entityB as string}`;
    if (nodeMap.has(srcId) && nodeMap.has(tgtId)) {
      edges.push({ source: srcId, target: tgtId, label: "CO_OCCURS" });
      addConnection(nodeMap, srcId, tgtId, "CO_OCCURS");
    }
  }

  // KWCluster nodes + MEMBER_OF
  const clusterRows = await runner.run(
    `MATCH (e:KWEntity {session_id: $sid})-[:MEMBER_OF]->(c:KWCluster {session_id: $sid})
     WHERE e.name IN [${nameList}]
     WITH DISTINCT c, count(e) AS visibleMembers
     OPTIONAL MATCH (c)-[:REPRESENTED_BY]->(env:KWEntity {session_id: $sid})
     RETURN c.clusterId AS clusterId, c.label AS label, c.memberCount AS memberCount,
            visibleMembers, env.name AS envelope
     LIMIT 100`,
    { sid: sessionId },
  );

  for (const r of clusterRows) {
    const cId = r.clusterId as string;
    if (!cId) continue;
    const nodeId = `kwcluster:${cId}`;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId,
        label: (r.label as string) ?? `Cluster ${cId}`,
        kind: "rationale",
        entityType: "cluster",
        confidence: Math.min(((r.memberCount as number) ?? 2) / 10, 1.0),
        rawTriples: [],
        connections: [],
      });
    }
  }

  const memberRows = await runner.run(
    `MATCH (e:KWEntity {session_id: $sid})-[:MEMBER_OF]->(c:KWCluster {session_id: $sid})
     WHERE e.name IN [${nameList}]
     RETURN e.name AS entityName, c.clusterId AS clusterId`,
    { sid: sessionId },
  );

  for (const r of memberRows) {
    const entId = `kwent:${r.entityName as string}`;
    const cId = `kwcluster:${r.clusterId as string}`;
    if (nodeMap.has(entId) && nodeMap.has(cId)) {
      edges.push({ source: entId, target: cId, label: "MEMBER_OF" });
      addConnection(nodeMap, entId, cId, "MEMBER_OF");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 2: TCG (Temporal Code Graph)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchTcgLayer(
  runner: CypherRunner,
  sessionId: string,
  maxNodes: number,
  nodeMap: Map<string, InsightNode>,
  edges: InsightEdge[],
): Promise<{ nodeCount: number }> {
  let nodeCount = 0;

  // TCGFile — top files by change frequency
  const fileRows = await runner.run(
    `MATCH (f:TCGFile {session_id: $sid})
     OPTIONAL MATCH (c:TCGCommit {session_id: $sid})-[:MODIFIED]->(f)
     WITH f, count(c) AS changeCount ORDER BY changeCount DESC
     LIMIT $limit
     RETURN f.filePath AS filePath, f.staleness AS staleness,
            f.hotspot AS hotspot, changeCount`,
    { sid: sessionId, limit: Math.min(maxNodes, 100) },
  );

  for (const r of fileRows) {
    const fp = r.filePath as string;
    if (!fp) continue;
    const id = `tcgfile:${fp}`;
    const label = fp.split("/").pop() ?? fp;
    nodeMap.set(id, {
      id,
      label: `📄 ${label}`,
      kind: "file",
      entityType: "file",
      sourceDoc: fp,
      confidence: Math.min(((r.changeCount as number) ?? 1) / 10, 1.0),
      rawTriples: [],
      connections: [],
    });
    nodeCount++;
  }

  if (nodeCount === 0) return { nodeCount };

  // TCGCommit — recent commits
  const commitRows = await runner.run(
    `MATCH (c:TCGCommit {session_id: $sid})
     RETURN c.hash AS hash, c.message AS message, c.date AS date,
            c.authorName AS authorName
     ORDER BY c.date DESC LIMIT 20`,
    { sid: sessionId },
  );

  for (const r of commitRows) {
    const hash = r.hash as string;
    if (!hash) continue;
    const id = `tcgcommit:${hash}`;
    const shortHash = hash.substring(0, 7);
    const msg = ((r.message as string) ?? "").substring(0, 40);
    nodeMap.set(id, {
      id,
      label: `⊙ ${shortHash}: ${msg}`,
      kind: "commit",
      entityType: "commit",
      confidence: 0.8,
      createdAt: r.date as string | undefined,
      rawTriples: [],
      connections: [],
    });
    nodeCount++;
  }

  // TCGAuthor
  const authorRows = await runner.run(
    `MATCH (a:TCGAuthor {session_id: $sid})
     RETURN a.email AS email, a.name AS name
     LIMIT 20`,
    { sid: sessionId },
  );

  for (const r of authorRows) {
    const email = r.email as string;
    if (!email) continue;
    const id = `tcgauthor:${email}`;
    nodeMap.set(id, {
      id,
      label: `👤 ${(r.name as string) ?? email}`,
      kind: "author",
      entityType: "author",
      confidence: 0.9,
      rawTriples: [],
      connections: [],
    });
    nodeCount++;
  }

  // MODIFIED edges (commit → file)
  const modRows = await runner.run(
    `MATCH (c:TCGCommit {session_id: $sid})-[:MODIFIED]->(f:TCGFile {session_id: $sid})
     RETURN c.hash AS hash, f.filePath AS filePath
     LIMIT 500`,
    { sid: sessionId },
  );

  for (const r of modRows) {
    const srcId = `tcgcommit:${r.hash as string}`;
    const tgtId = `tcgfile:${r.filePath as string}`;
    if (nodeMap.has(srcId) && nodeMap.has(tgtId)) {
      edges.push({ source: srcId, target: tgtId, label: "MODIFIED" });
      addConnection(nodeMap, srcId, tgtId, "MODIFIED");
    }
  }

  // AUTHORED_BY edges (commit → author)
  const authEdgeRows = await runner.run(
    `MATCH (c:TCGCommit {session_id: $sid})-[:AUTHORED_BY]->(a:TCGAuthor {session_id: $sid})
     RETURN c.hash AS hash, a.email AS email
     LIMIT 100`,
    { sid: sessionId },
  );

  for (const r of authEdgeRows) {
    const srcId = `tcgcommit:${r.hash as string}`;
    const tgtId = `tcgauthor:${r.email as string}`;
    if (nodeMap.has(srcId) && nodeMap.has(tgtId)) {
      edges.push({ source: srcId, target: tgtId, label: "AUTHORED_BY" });
      addConnection(nodeMap, srcId, tgtId, "AUTHORED_BY");
    }
  }

  // CO_CHANGED_WITH edges (file ↔ file)
  const cochangeRows = await runner.run(
    `MATCH (a:TCGFile {session_id: $sid})-[r:CO_CHANGED_WITH]->(b:TCGFile {session_id: $sid})
     RETURN a.filePath AS pathA, b.filePath AS pathB, r.count AS count
     ORDER BY r.count DESC LIMIT 200`,
    { sid: sessionId },
  );

  for (const r of cochangeRows) {
    const srcId = `tcgfile:${r.pathA as string}`;
    const tgtId = `tcgfile:${r.pathB as string}`;
    if (nodeMap.has(srcId) && nodeMap.has(tgtId)) {
      edges.push({ source: srcId, target: tgtId, label: "CO_CHANGED" });
      addConnection(nodeMap, srcId, tgtId, "CO_CHANGED");
    }
  }

  return { nodeCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 3: SCG (Static Code Graph)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchScgLayer(
  runner: CypherRunner,
  sessionId: string,
  maxNodes: number,
  nodeMap: Map<string, InsightNode>,
  edges: InsightEdge[],
): Promise<{ nodeCount: number }> {
  let nodeCount = 0;

  // SCG:File — top files by symbol count
  const fileRows = await runner.run(
    `MATCH (f:SCG:File {session_id: $sid})
     RETURN f.filePath AS filePath, f.language AS language,
            f.symbolCount AS symbolCount
     ORDER BY f.symbolCount DESC
     LIMIT $limit`,
    { sid: sessionId, limit: Math.min(maxNodes, 100) },
  );

  for (const r of fileRows) {
    const fp = r.filePath as string;
    if (!fp) continue;
    const id = `scgfile:${fp}`;
    const label = fp.split("/").pop() ?? fp;
    nodeMap.set(id, {
      id,
      label: `📁 ${label}`,
      kind: "file",
      entityType: "code-file",
      sourceDoc: fp,
      confidence: Math.min(((r.symbolCount as number) ?? 1) / 30, 1.0),
      rawTriples: [],
      connections: [],
    });
    nodeCount++;
  }

  if (nodeCount === 0) return { nodeCount };

  // SCG:Symbol — top-level exported classes, functions, interfaces
  const symbolRows = await runner.run(
    `MATCH (f:SCG:File {session_id: $sid})-[:SCG_CONTAINS]->(s:SCG:Symbol {session_id: $sid})
     WHERE s.export = 'exported' AND s.kind IN ['function', 'class', 'interface', 'type', 'enum']
     RETURN s.symbolId AS symbolId, s.name AS name, s.kind AS kind,
            s.filePath AS filePath, s.export AS exportStatus,
            s.startLine AS startLine
     ORDER BY s.name
     LIMIT $limit`,
    { sid: sessionId, limit: Math.min(maxNodes, 200) },
  );

  for (const r of symbolRows) {
    const symId = r.symbolId as string;
    if (!symId) continue;
    const id = `scgsym:${symId}`;
    const kind = r.kind as string;
    const icon =
      kind === "class"
        ? "◆"
        : kind === "interface"
          ? "◇"
          : kind === "function"
            ? "ƒ"
            : "▸";
    nodeMap.set(id, {
      id,
      label: `${icon} ${r.name as string}`,
      kind: "symbol",
      entityType: kind,
      sourceDoc: r.filePath as string,
      confidence: 0.9,
      rawTriples: [],
      connections: [],
    });
    nodeCount++;
  }

  // SCG_CONTAINS edges (file → symbol)
  for (const r of symbolRows) {
    const symId = r.symbolId as string;
    const fp = r.filePath as string;
    if (!symId || !fp) continue;
    const fileNodeId = `scgfile:${fp}`;
    const symNodeId = `scgsym:${symId}`;
    if (nodeMap.has(fileNodeId) && nodeMap.has(symNodeId)) {
      edges.push({
        source: fileNodeId,
        target: symNodeId,
        label: "SCG_CONTAINS",
      });
      addConnection(nodeMap, fileNodeId, symNodeId, "SCG_CONTAINS");
    }
  }

  return { nodeCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 4: Cross-layer links (KWDoc ↔ TCGFile ↔ SCG:File by file path)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchCrossLayerLinks(
  runner: CypherRunner,
  sessionId: string,
  nodeMap: Map<string, InsightNode>,
  edges: InsightEdge[],
): Promise<void> {
  // ── A. Collect loaded nodes by layer ───────────────────────────────────
  const kwDocPaths = [...nodeMap.values()]
    .filter((n) => n.kind === "topic" && n.sourceDoc)
    .map((n) => n.sourceDoc!);

  const tcgFilePaths = [...nodeMap.values()]
    .filter((n) => n.kind === "file" && n.entityType === "file" && n.sourceDoc)
    .map((n) => n.sourceDoc!);

  const scgFilePaths = [...nodeMap.values()]
    .filter(
      (n) => n.kind === "file" && n.entityType === "code-file" && n.sourceDoc,
    )
    .map((n) => n.sourceDoc!);

  const tcgByPath = new Map(
    [...nodeMap.entries()]
      .filter(
        ([_, n]) => n.kind === "file" && n.entityType === "file" && n.sourceDoc,
      )
      .map(([id, n]) => [n.sourceDoc!, id] as const),
  );
  const scgByPath = new Map(
    [...nodeMap.entries()]
      .filter(
        ([_, n]) =>
          n.kind === "file" && n.entityType === "code-file" && n.sourceDoc,
      )
      .map(([id, n]) => [n.sourceDoc!, id] as const),
  );

  // ── B. In-memory file-path matches ─────────────────────────────────────
  for (const [path, tcgId] of tcgByPath) {
    // KWDoc ↔ TCGFile
    const kwDocId = `kwdoc:${path}`;
    if (nodeMap.has(kwDocId)) {
      edges.push({ source: kwDocId, target: tcgId, label: "SAME_FILE" });
      addConnection(nodeMap, kwDocId, tcgId, "SAME_FILE");
    }
    // TCGFile ↔ SCG:File
    const scgId = scgByPath.get(path);
    if (scgId) {
      edges.push({ source: tcgId, target: scgId, label: "SAME_FILE" });
      addConnection(nodeMap, tcgId, scgId, "SAME_FILE");
    }
  }

  // ── C. Cypher-based bridge: inject file nodes for cross-layer overlap ──
  // Each layer independently selects top-N nodes. This creates disjoint sets
  // with minimal path overlap. We query Neo4j for the top overlapping paths
  // and inject missing nodes so SAME_FILE edges can form.

  // C1: TCGFile ↔ SCG:File bridge — find top overlapping paths
  const bridgeRows = await runner.run(
    `MATCH (t:TCGFile {session_id: $sid}), (s:SCG:File {session_id: $sid})
     WHERE t.filePath = s.filePath
     RETURN t.filePath AS filePath, s.symbolCount AS symbolCount
     ORDER BY s.symbolCount DESC
     LIMIT 25`,
    { sid: sessionId },
  );

  for (const r of bridgeRows) {
    const fp = r.filePath as string;
    if (!fp) continue;
    const tcgId = `tcgfile:${fp}`;
    const scgId = `scgfile:${fp}`;

    // Inject missing TCGFile node
    if (!nodeMap.has(tcgId)) {
      const label = fp.split("/").pop() ?? fp;
      nodeMap.set(tcgId, {
        id: tcgId,
        label: `📄 ${label}`,
        kind: "file",
        entityType: "file",
        sourceDoc: fp,
        confidence: 0.5,
        rawTriples: [],
        connections: [],
      });
    }
    // Inject missing SCG:File node
    if (!nodeMap.has(scgId)) {
      const label = fp.split("/").pop() ?? fp;
      nodeMap.set(scgId, {
        id: scgId,
        label: `📁 ${label}`,
        kind: "file",
        entityType: "code-file",
        sourceDoc: fp,
        confidence: 0.5,
        rawTriples: [],
        connections: [],
      });
    }
    // Create SAME_FILE edge (avoid duplicates from in-memory matching)
    const alreadyLinked = edges.some(
      (e) =>
        e.label === "SAME_FILE" &&
        ((e.source === tcgId && e.target === scgId) ||
          (e.source === scgId && e.target === tcgId)),
    );
    if (!alreadyLinked) {
      edges.push({ source: tcgId, target: scgId, label: "SAME_FILE" });
      addConnection(nodeMap, tcgId, scgId, "SAME_FILE");
    }
  }

  // C2: KWDoc ↔ TCGFile bridge — ensure docs link to git files
  if (kwDocPaths.length > 0) {
    const docPathList = kwDocPaths
      .map((p) => `"${p.replace(/"/g, '\\"')}"`)
      .join(", ");

    const docBridgeRows = await runner.run(
      `MATCH (t:TCGFile {session_id: $sid})
       WHERE t.filePath IN [${docPathList}]
       RETURN t.filePath AS filePath`,
      { sid: sessionId },
    );

    for (const r of docBridgeRows) {
      const fp = r.filePath as string;
      if (!fp) continue;
      const tcgId = `tcgfile:${fp}`;
      const kwDocId = `kwdoc:${fp}`;

      if (!nodeMap.has(tcgId)) {
        const label = fp.split("/").pop() ?? fp;
        nodeMap.set(tcgId, {
          id: tcgId,
          label: `📄 ${label}`,
          kind: "file",
          entityType: "file",
          sourceDoc: fp,
          confidence: 0.5,
          rawTriples: [],
          connections: [],
        });
      }
      if (nodeMap.has(kwDocId)) {
        const alreadyLinked = edges.some(
          (e) =>
            e.label === "SAME_FILE" &&
            ((e.source === kwDocId && e.target === tcgId) ||
              (e.source === tcgId && e.target === kwDocId)),
        );
        if (!alreadyLinked) {
          edges.push({ source: kwDocId, target: tcgId, label: "SAME_FILE" });
          addConnection(nodeMap, kwDocId, tcgId, "SAME_FILE");
        }
      }
    }
  }

  // ── D. KWEntity ↔ SCG:Symbol name-based grounding (Cypher-backed) ─────
  // Query Neo4j for KWEntity → SCG:Symbol name matches, injecting bridge
  // nodes for any matches not already in the graph. Limited to meaningful
  // code kinds (class, interface, function, type, enum — not properties).
  const kwEntNames = [...nodeMap.values()]
    .filter((n) => n.id.startsWith("kwent:"))
    .map((n) => n.label);

  if (kwEntNames.length > 0) {
    const nameList = kwEntNames
      .map((n) => `"${n.replace(/"/g, '\\"')}"`)
      .join(", ");

    const groundingRows = await runner.run(
      `MATCH (e:KWEntity {session_id: $sid}), (s:SCG:Symbol {session_id: $sid})
       WHERE toLower(e.name) IN [${nameList.toLowerCase()}]
         AND toLower(e.name) = toLower(s.name)
         AND s.kind IN ['class', 'interface', 'function', 'type', 'enum']
         AND s.export = 'exported'
       RETURN e.name AS entityName, s.symbolId AS symbolId, s.name AS symbolName,
              s.kind AS symbolKind, s.filePath AS filePath
       LIMIT 30`,
      { sid: sessionId },
    );

    for (const r of groundingRows) {
      const entId = `kwent:${r.entityName as string}`;
      const symId = `scgsym:${r.symbolId as string}`;

      // Inject missing symbol node
      if (!nodeMap.has(symId)) {
        const kind = r.symbolKind as string;
        const icon =
          kind === "class"
            ? "◆"
            : kind === "interface"
              ? "◇"
              : kind === "function"
                ? "ƒ"
                : "▸";
        nodeMap.set(symId, {
          id: symId,
          label: `${icon} ${r.symbolName as string}`,
          kind: "symbol",
          entityType: kind,
          sourceDoc: r.filePath as string,
          confidence: 0.9,
          rawTriples: [],
          connections: [],
        });
      }

      if (nodeMap.has(entId)) {
        edges.push({ source: entId, target: symId, label: "GROUNDED_IN" });
        addConnection(nodeMap, entId, symId, "GROUNDED_IN");
      }
    }
  }

  // (Section E removed — drift linking handled in fetchDriftLayer which runs after this)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 4: Drift signals (Phase C)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchDriftLayer(
  runner: CypherRunner,
  sessionId: string,
  maxNodes: number,
  nodeMap: Map<string, InsightNode>,
  edges: InsightEdge[],
): Promise<{ nodeCount: number }> {
  let nodeCount = 0;

  // Query DriftSignal nodes — actual schema: name, files[], message, category, detector, severity
  const signalRows = await runner.run(
    `MATCH (d:DriftSignal {session_id: $sid})
     RETURN d.id AS id, d.name AS name, d.detector AS detector,
            d.severity AS severity, d.message AS message,
            d.category AS category, d.files AS files
     ORDER BY CASE d.severity
       WHEN 'critical' THEN 0
       WHEN 'warning' THEN 1
       ELSE 2
     END
     LIMIT $limit`,
    { sid: sessionId, limit: Math.min(maxNodes, 50) },
  );

  for (const r of signalRows) {
    const id = `drift:${r.id as string}`;
    const severity = (r.severity as string) ?? "info";
    const detector = (r.detector as string) ?? "unknown";
    const name = (r.name as string) ?? "";
    const message = (r.message as string) ?? `${detector} drift`;

    const icon =
      severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "🔵";

    nodeMap.set(id, {
      id,
      label: `${icon} ${(name || message).substring(0, 40)}`,
      kind: "drift",
      entityType: detector,
      confidence:
        severity === "critical" ? 1.0 : severity === "warning" ? 0.7 : 0.4,
      rawTriples: [],
      connections: [],
    });
    nodeCount++;

    // Link drift signal to SCG symbol by matching name → scgsym: nodes
    if (name) {
      const symId = [...nodeMap.keys()].find(
        (k) => k.startsWith("scgsym:") && nodeMap.get(k)!.label === name,
      );
      if (symId) {
        edges.push({ source: id, target: symId, label: "DRIFTED" });
        addConnection(nodeMap, id, symId, "DRIFTED");
      }
    }

    // Link drift signal to TCG/SCG file nodes by matching files[] paths
    const files = r.files as string[] | null;
    if (files && Array.isArray(files)) {
      for (const fp of files) {
        // Try TCG file first, then SCG file, then inject SCG file as bridge
        const tcgId = `tcgfile:${fp}`;
        const scgId = `scgfile:${fp}`;
        if (nodeMap.has(tcgId)) {
          edges.push({ source: id, target: tcgId, label: "DRIFTED_FILE" });
          addConnection(nodeMap, id, tcgId, "DRIFTED_FILE");
        } else if (nodeMap.has(scgId)) {
          edges.push({ source: id, target: scgId, label: "DRIFTED_FILE" });
          addConnection(nodeMap, id, scgId, "DRIFTED_FILE");
        } else {
          // Inject SCG file as bridge node so drift connects to the graph
          const fileName = fp.split("/").pop() ?? fp;
          nodeMap.set(scgId, {
            id: scgId,
            label: `📄 ${fileName}`,
            kind: "file",
            entityType: "file",
            sourceDoc: fp,
            confidence: 0.8,
            rawTriples: [],
            connections: [],
          });
          edges.push({ source: id, target: scgId, label: "DRIFTED_FILE" });
          addConnection(nodeMap, id, scgId, "DRIFTED_FILE");
        }
      }
    }
  }

  return { nodeCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function countTotalKwg(
  runner: CypherRunner,
  sessionId: string,
): Promise<number> {
  const result = await runner.run(
    `MATCH (e:KWEntity {session_id: $sid}) RETURN count(e) AS cnt`,
    { sid: sessionId },
  );
  return (result[0]?.cnt as number) ?? 0;
}

function addConnection(
  nodeMap: Map<string, InsightNode>,
  sourceId: string,
  targetId: string,
  predicate: string,
): void {
  const srcNode = nodeMap.get(sourceId);
  const tgtNode = nodeMap.get(targetId);
  if (srcNode) {
    srcNode.connections = srcNode.connections ?? [];
    srcNode.connections.push({
      targetId,
      targetLabel: tgtNode?.label ?? targetId,
      predicate,
      direction: "outgoing",
    });
  }
  if (tgtNode) {
    tgtNode.connections = tgtNode.connections ?? [];
    tgtNode.connections.push({
      targetId: sourceId,
      targetLabel: srcNode?.label ?? sourceId,
      predicate,
      direction: "incoming",
    });
  }
}
