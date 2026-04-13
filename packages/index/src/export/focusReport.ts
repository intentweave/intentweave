// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused Architecture Report — SVG via Graphviz WASM
 *
 * Renders a FocusResult as an interactive HTML page with a Graphviz-generated
 * SVG graph. Layers are rendered as DOT subgraph clusters, edge types are
 * color-coded, and the target node is highlighted.
 *
 * The HTML wrapper provides pan/zoom, tooltips, a legend, and a details panel.
 */

import { instance } from "@viz-js/viz";
import type { FocusResult, FocusNode, FocusEdge } from "../types.js";

/* ── Insights analysis ────────────────────────────────────────────── */

interface ClusterInsight {
  label: string;
  files: string[];
  role: string;
  avgHop: number;
}

interface HubInsight {
  name: string;
  filePath: string;
  dependents: number;
  risk: "high" | "medium" | "low";
}

interface FocusInsights {
  /** What the target is and where it sits */
  targetSummary: string;
  /** Distinct layers with derived roles */
  clusters: ClusterInsight[];
  /** High-connectivity nodes (potential risk) */
  hubs: HubInsight[];
  /** Data flow direction summary */
  flowSummary: string;
  /** Reading guide (how to interpret the graph) */
  readingGuide: string[];
  /** Key observations / warnings */
  observations: string[];
}

/**
 * Derive structural insights from a FocusResult — no LLM needed.
 * Exported so it can be reused by the CLI --explain flow.
 */
export function analyzeFocusInsights(result: FocusResult): FocusInsights {
  const targetNodes = result.nodes.filter((n) => n.isTarget);
  const targetName =
    targetNodes.map((n) => n.name).join(", ") || result.target;
  const targetLayer =
    targetNodes[0]?.layerLabel ?? "unknown";

  // ── Cluster insights ──────────────────────────────────────────
  const layerMap = new Map<string, FocusNode[]>();
  for (const n of result.nodes) {
    const key = n.layerLabel;
    if (!layerMap.has(key)) layerMap.set(key, []);
    layerMap.get(key)!.push(n);
  }

  const clusters: ClusterInsight[] = [];
  for (const [label, nodes] of layerMap) {
    const avgHop =
      nodes.reduce((sum, n) => sum + n.hopDistance, 0) / nodes.length;
    const role = deriveClusterRole(label, nodes, avgHop, result.edges);
    clusters.push({
      label,
      files: nodes.map((n) => n.name),
      role,
      avgHop,
    });
  }
  // Sort by avg hop (closest first)
  clusters.sort((a, b) => a.avgHop - b.avgHop);

  // ── Hub detection ─────────────────────────────────────────────
  const hubThreshold = Math.max(
    5,
    Math.round(result.nodes.length * 0.3),
  );
  const hubs: HubInsight[] = result.nodes
    .filter((n) => n.dependents >= hubThreshold)
    .sort((a, b) => b.dependents - a.dependents)
    .map((n) => ({
      name: n.name,
      filePath: n.filePath,
      dependents: n.dependents,
      risk:
        n.dependents >= hubThreshold * 2
          ? ("high" as const)
          : n.dependents >= hubThreshold
            ? ("medium" as const)
            : ("low" as const),
    }));

  // ── Flow summary ──────────────────────────────────────────────
  const importEdges = result.edges.filter((e) => e.type === "import");
  const maxHop = Math.max(...result.nodes.map((n) => n.hopDistance), 0);
  const entryNodes = result.nodes
    .filter(
      (n) =>
        !importEdges.some((e) => e.target === n.filePath) &&
        importEdges.some((e) => e.source === n.filePath),
    )
    .map((n) => n.name);
  const leafNodes = result.nodes
    .filter(
      (n) =>
        !importEdges.some((e) => e.source === n.filePath) &&
        importEdges.some((e) => e.target === n.filePath),
    )
    .map((n) => n.name);

  const flowSummary = buildFlowSummary(
    targetName,
    entryNodes,
    leafNodes,
    maxHop,
    result,
  );

  // ── Target summary ────────────────────────────────────────────
  const targetDeps = targetNodes[0]?.dependents ?? 0;
  const targetSummary =
    `<strong>${escapeHtml(targetName)}</strong> sits in the <em>${escapeHtml(targetLayer)}</em> layer` +
    ` with ${targetDeps} transitive dependent${targetDeps !== 1 ? "s" : ""}.` +
    ` This ${result.hops}-hop view shows ${result.nodes.length} files` +
    ` (of ${result.totalNeighborhood} in the full neighbourhood)` +
    ` connected by ${result.edges.length} relationships.`;

  // ── Reading guide ─────────────────────────────────────────────
  const readingGuide = [
    "Coloured boxes are <strong>architectural layers</strong> — files grouped by their position in the import hierarchy.",
    "The <strong>⭐ yellow node</strong> is your target. Arrows point from a file to its dependencies.",
    "<strong>Solid dark arrows</strong> are import dependencies (A → B means A imports B).",
  ];
  const coChangeCount = result.edges.filter(
    (e) => e.type === "co_change",
  ).length;
  const docCount = result.edges.filter(
    (e) => e.type === "doc_cooc",
  ).length;
  if (coChangeCount > 0) {
    readingGuide.push(
      `<strong>Dashed orange lines</strong> are co-change signals — files that tend to change together in git (${coChangeCount} found).`,
    );
  }
  if (docCount > 0) {
    readingGuide.push(
      `<strong>Dotted blue lines</strong> are documentation co-mentions — files discussed together in docs (${docCount} found).`,
    );
  }
  readingGuide.push(
    "Click any node to see its details. Use scroll to zoom, drag to pan.",
  );

  // ── Observations ──────────────────────────────────────────────
  const observations: string[] = [];

  if (hubs.length > 0) {
    const hubNames = hubs.map(
      (h) =>
        `<strong>${escapeHtml(h.name)}</strong> (${h.dependents} deps)`,
    );
    observations.push(
      `⚠️ Hub nodes detected: ${hubNames.join(", ")}. Changes here ripple widely — consider if they should be split.`,
    );
  }

  if (result.totalNeighborhood > result.nodes.length) {
    observations.push(
      `The full ${result.hops}-hop neighbourhood has ${result.totalNeighborhood} nodes but only ${result.nodes.length} are shown. Increase <code>--max-nodes</code> to see more.`,
    );
  }

  const uniqueLayers = new Set(result.nodes.map((n) => n.layerIndex));
  if (uniqueLayers.size === 1) {
    observations.push(
      "All files are in the same architectural layer — this suggests tight horizontal coupling.",
    );
  }

  // Check for up-import violations (lower layer importing higher)
  const upImports = importEdges.filter((e) => {
    const srcNode = result.nodes.find((n) => n.filePath === e.source);
    const tgtNode = result.nodes.find((n) => n.filePath === e.target);
    return (
      srcNode && tgtNode && srcNode.layerIndex < tgtNode.layerIndex
    );
  });
  if (upImports.length > 0) {
    observations.push(
      `🔄 ${upImports.length} upward import${upImports.length > 1 ? "s" : ""} detected — lower layers importing from higher layers. This may indicate architectural boundary violations.`,
    );
  }

  if (entryNodes.length > 0 && leafNodes.length > 0) {
    observations.push(
      `📊 Data flows from entry points (${entryNodes.slice(0, 3).map((n) => `<strong>${escapeHtml(n)}</strong>`).join(", ")}) down to leaf modules (${leafNodes.slice(0, 3).map((n) => `<strong>${escapeHtml(n)}</strong>`).join(", ")}).`,
    );
  }

  return {
    targetSummary,
    clusters,
    hubs,
    flowSummary,
    readingGuide,
    observations,
  };
}

function deriveClusterRole(
  label: string,
  nodes: FocusNode[],
  avgHop: number,
  edges: FocusEdge[],
): string {
  // Derive a human-readable role from file names and structural position
  const names = nodes.map((n) => n.name.toLowerCase());
  const hasTarget = nodes.some((n) => n.isTarget);

  // Count how many import edges originate from vs arrive at this cluster
  const filePaths = new Set(nodes.map((n) => n.filePath));
  const importEdges = edges.filter((e) => e.type === "import");
  const outbound = importEdges.filter((e) => filePaths.has(e.source)).length;
  const inbound = importEdges.filter((e) => filePaths.has(e.target)).length;

  const parts: string[] = [];

  if (hasTarget) parts.push("Contains the target entity.");

  // Pattern-match common file name conventions
  if (names.some((n) => /type|interface|model|schema/.test(n))) {
    parts.push("Provides type definitions and contracts.");
  }
  if (names.some((n) => /context|config|env/.test(n))) {
    parts.push("Manages shared runtime context or configuration.");
  }
  if (names.some((n) => /cache|store|persist/.test(n))) {
    parts.push("Handles caching and state persistence.");
  }
  if (names.some((n) => /stage|step|pipe|transform/.test(n))) {
    parts.push("Contains processing stages or pipeline steps.");
  }
  if (names.some((n) => /loader|parser|read/.test(n))) {
    parts.push("Loads or parses input data.");
  }
  if (names.some((n) => /registry|plugin|provider/.test(n))) {
    parts.push("Registry or provider pattern — manages available services.");
  }

  // Structural role
  if (inbound > outbound * 1.5) {
    parts.push("Heavily depended-upon (foundation role).");
  } else if (outbound > inbound * 1.5) {
    parts.push("Orchestrates — depends on many, depended on by few.");
  }

  if (parts.length === 0) {
    parts.push(
      `${nodes.length} file${nodes.length !== 1 ? "s" : ""} at ~hop ${avgHop.toFixed(1)} from target.`,
    );
  }

  return parts.join(" ");
}

function buildFlowSummary(
  targetName: string,
  entryNodes: string[],
  leafNodes: string[],
  maxHop: number,
  result: FocusResult,
): string {
  const parts: string[] = [];

  if (entryNodes.length > 0) {
    parts.push(
      `Entry points (${entryNodes.slice(0, 3).join(", ")}) invoke the target or its neighbours.`,
    );
  }

  parts.push(
    `<strong>${escapeHtml(targetName)}</strong> connects to ${result.nodes.length - 1} modules across ${maxHop + 1} hop levels.`,
  );

  if (leafNodes.length > 0) {
    parts.push(
      `Foundation modules (${leafNodes.slice(0, 3).join(", ")}) are imported but import nothing from this subgraph.`,
    );
  }

  return parts.join(" ");
}

/* ── Color palette ────────────────────────────────────────────────── */

const LAYER_COLORS = [
  "#e8f5e9", // 0 - foundation (light green)
  "#e3f2fd", // 1 - core (light blue)
  "#fff3e0", // 2 - interface (light orange)
  "#fce4ec", // 3 - entry (light pink)
  "#f3e5f5", // 4 - (light purple)
  "#e0f7fa", // 5 - (light teal)
  "#fff9c4", // 6 - (light yellow)
  "#f1f8e9", // 7 - (light lime)
];

const LAYER_BORDER_COLORS = [
  "#4caf50", "#2196f3", "#ff9800", "#e91e63",
  "#9c27b0", "#00bcd4", "#ffc107", "#8bc34a",
];

const EDGE_COLORS = {
  import: "#455a64",
  co_change: "#e65100",
  doc_cooc: "#1565c0",
};

/* ── DOT generation ───────────────────────────────────────────────── */

function escapeDot(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function nodeId(filePath: string): string {
  return `n_${filePath.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function buildDot(result: FocusResult): string {
  // Count edges per node to compute edge weights for layout hints
  const edgeCount = new Map<string, number>();
  for (const e of result.edges) {
    edgeCount.set(e.source, (edgeCount.get(e.source) ?? 0) + 1);
    edgeCount.set(e.target, (edgeCount.get(e.target) ?? 0) + 1);
  }

  const lines: string[] = [
    "digraph focus {",
    '  graph [rankdir=TB, fontname="Inter, Helvetica, Arial, sans-serif", fontsize=12, bgcolor="transparent"',
    "    pad=0.4, nodesep=0.5, ranksep=0.8,",
    "    splines=ortho, concentrate=true, newrank=true, compound=true,",
    "    ordering=out];",
    '  node [shape=box, style="filled,rounded", fontname="Inter, Helvetica, Arial, sans-serif", fontsize=11, margin="0.15,0.08"];',
    '  edge [fontname="Inter, Helvetica, Arial, sans-serif", fontsize=9];',
    "",
  ];

  // Group nodes by layer
  const layerGroups = new Map<number, FocusNode[]>();
  for (const node of result.nodes) {
    const key = node.layerIndex;
    if (!layerGroups.has(key)) layerGroups.set(key, []);
    layerGroups.get(key)!.push(node);
  }

  // Sort layers descending (highest layer = top of graph)
  const sortedLayers = [...layerGroups.entries()].sort(
    ([a], [b]) => b - a,
  );

  for (const [layerIdx, nodes] of sortedLayers) {
    const bgColor = LAYER_COLORS[layerIdx % LAYER_COLORS.length] ?? "#f5f5f5";
    const borderColor =
      LAYER_BORDER_COLORS[layerIdx % LAYER_BORDER_COLORS.length] ?? "#999";
    const layerLabel =
      nodes[0]?.layerLabel && nodes[0].layerLabel !== "unknown"
        ? nodes[0].layerLabel
        : layerIdx === -1
          ? "Unassigned"
          : `Layer ${layerIdx}`;

    lines.push(
      `  subgraph cluster_layer_${layerIdx === -1 ? "unassigned" : layerIdx} {`,
      `    label="${escapeDot(layerLabel)}";`,
      `    style=filled;`,
      `    color="${borderColor}";`,
      `    fillcolor="${bgColor}";`,
      `    fontsize=13;`,
      `    fontcolor="${borderColor}";`,
      "",
    );

    for (const node of nodes) {
      const id = nodeId(node.filePath);
      const label = node.isTarget ? `⭐ ${node.name}` : node.name;
      const fillColor = node.isTarget ? "#fff176" : "#ffffff";
      const penWidth = node.isTarget ? "2.5" : "1";
      const borderClr = node.isTarget ? "#f57f17" : "#90a4ae";

      const tooltip = [
        node.filePath,
        `Community: ${node.communityLabel}`,
        `Dependents: ${node.dependents}`,
        `Hop: ${node.hopDistance}`,
      ].join("\\n");

      lines.push(
        `    ${id} [label="${escapeDot(label)}", fillcolor="${fillColor}", color="${borderClr}", penwidth=${penWidth}, tooltip="${tooltip}"];`,
      );
    }

    lines.push("  }", "");
  }

  // Build a lookup for node layer index (for edge weight hints)
  const nodeLayer = new Map<string, number>();
  for (const node of result.nodes) {
    nodeLayer.set(node.filePath, node.layerIndex);
  }

  // Edges — weight by structural importance for better layout
  for (const edge of result.edges) {
    const src = nodeId(edge.source);
    const tgt = nodeId(edge.target);

    // Edges crossing fewer layers get higher weight → stay close together
    const srcLayer = nodeLayer.get(edge.source) ?? 0;
    const tgtLayer = nodeLayer.get(edge.target) ?? 0;
    const layerDist = Math.abs(srcLayer - tgtLayer);

    if (edge.type === "import") {
      const w = layerDist <= 1 ? 5 : layerDist <= 2 ? 2 : 1;
      lines.push(
        `  ${src} -> ${tgt} [color="${EDGE_COLORS.import}", penwidth=1.5, weight=${w}];`,
      );
    } else if (edge.type === "co_change") {
      const label = edge.weight < 1 ? edge.weight.toFixed(2) : "";
      lines.push(
        `  ${src} -> ${tgt} [color="${EDGE_COLORS.co_change}", style=dashed, penwidth=1.2, arrowhead=none, weight=1, label="${label}", fontcolor="${EDGE_COLORS.co_change}"];`,
      );
    } else if (edge.type === "doc_cooc") {
      lines.push(
        `  ${src} -> ${tgt} [color="${EDGE_COLORS.doc_cooc}", style=dotted, penwidth=1, arrowhead=none, weight=1];`,
      );
    }
  }

  lines.push("}");
  return lines.join("\n");
}

/* ── Flow view DOT ────────────────────────────────────────────────── */

/**
 * Render a linearised data/control flow through the target.
 * Topological sort of import edges → left-to-right chain.
 * Only shows the main flow path (nodes on paths through the target).
 */
function buildFlowDot(result: FocusResult): string {
  const importEdges = result.edges.filter((e) => e.type === "import");
  const allFiles = new Set(result.nodes.map((n) => n.filePath));

  // Build adjacency for topological sort (forward = source→target = caller→dependency)
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const f of allFiles) {
    adj.set(f, []);
    inDeg.set(f, 0);
  }
  for (const e of importEdges) {
    if (allFiles.has(e.source) && allFiles.has(e.target)) {
      adj.get(e.source)!.push(e.target);
      inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    }
  }

  // Topological sort (Kahn's algorithm)
  const sorted: string[] = [];
  const queue = [...allFiles].filter((f) => (inDeg.get(f) ?? 0) === 0);
  while (queue.length > 0) {
    const f = queue.shift()!;
    sorted.push(f);
    for (const dep of adj.get(f) ?? []) {
      const newDeg = (inDeg.get(dep) ?? 1) - 1;
      inDeg.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }
  // Add any remaining (cycles) at the end
  for (const f of allFiles) {
    if (!sorted.includes(f)) sorted.push(f);
  }

  // Filter to nodes on paths through the target
  const targetFiles = new Set(
    result.nodes.filter((n) => n.isTarget).map((n) => n.filePath),
  );

  // Forward reachability from target
  const fwdReachable = new Set<string>();
  const fwdQueue = [...targetFiles];
  while (fwdQueue.length > 0) {
    const f = fwdQueue.pop()!;
    if (fwdReachable.has(f)) continue;
    fwdReachable.add(f);
    for (const dep of adj.get(f) ?? []) fwdQueue.push(dep);
  }

  // Reverse reachability to target
  const revAdj = new Map<string, string[]>();
  for (const f of allFiles) revAdj.set(f, []);
  for (const e of importEdges) {
    if (allFiles.has(e.source) && allFiles.has(e.target)) {
      revAdj.get(e.target)!.push(e.source);
    }
  }
  const revReachable = new Set<string>();
  const revQueue = [...targetFiles];
  while (revQueue.length > 0) {
    const f = revQueue.pop()!;
    if (revReachable.has(f)) continue;
    revReachable.add(f);
    for (const dep of revAdj.get(f) ?? []) revQueue.push(dep);
  }

  // Only keep nodes reachable both ways (on a path through target)
  const flowFiles = sorted.filter(
    (f) => fwdReachable.has(f) || revReachable.has(f),
  );

  const nodeMap = new Map(result.nodes.map((n) => [n.filePath, n]));

  const lines: string[] = [
    "digraph flow {",
    '  graph [rankdir=LR, fontname="Inter, Helvetica, Arial, sans-serif", fontsize=12, bgcolor="transparent",',
    "    pad=0.4, nodesep=0.4, ranksep=0.7, splines=ortho];",
    '  node [shape=box, style="filled,rounded", fontname="Inter, Helvetica, Arial, sans-serif", fontsize=11, margin="0.12,0.06"];',
    '  edge [fontname="Inter, Helvetica, Arial, sans-serif", fontsize=9, color="' + EDGE_COLORS.import + '", penwidth=1.5];',
    "",
  ];

  // Group by hop distance for rank alignment
  const hopGroups = new Map<number, string[]>();
  for (const f of flowFiles) {
    const hop = nodeMap.get(f)?.hopDistance ?? 0;
    if (!hopGroups.has(hop)) hopGroups.set(hop, []);
    hopGroups.get(hop)!.push(f);
  }

  // Add rank constraints
  for (const [hop, files] of [...hopGroups.entries()].sort(([a], [b]) => a - b)) {
    if (files.length > 1) {
      lines.push(`  { rank=same; ${files.map(nodeId).join("; ")}; }`);
    }
  }
  lines.push("");

  // Nodes
  for (const f of flowFiles) {
    const node = nodeMap.get(f);
    if (!node) continue;
    const id = nodeId(f);
    const label = node.isTarget ? `⭐ ${node.name}` : node.name;
    const fillColor = node.isTarget
      ? "#fff176"
      : node.hopDistance === 0 ? "#fff176" : `hsl(210, 30%, ${85 + node.hopDistance * 3}%)`;
    const borderClr = node.isTarget ? "#f57f17" : "#78909c";
    const penWidth = node.isTarget ? "2.5" : "1";
    lines.push(
      `  ${id} [label="${escapeDot(label)}", fillcolor="${fillColor}", color="${borderClr}", penwidth=${penWidth}];`,
    );
  }
  lines.push("");

  // Edges (only import, only within flow set)
  const flowSet = new Set(flowFiles);
  for (const e of importEdges) {
    if (flowSet.has(e.source) && flowSet.has(e.target)) {
      lines.push(`  ${nodeId(e.source)} -> ${nodeId(e.target)};`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}

/* ── Abstract view DOT ────────────────────────────────────────────── */

/**
 * Render an abstracted view: nodes collapsed by community into meta-nodes.
 * Inter-community edges show import count.
 */
function buildAbstractDot(result: FocusResult): string {
  // Group nodes by community
  const communities = new Map<number, FocusNode[]>();
  for (const node of result.nodes) {
    const cid = node.communityId;
    if (!communities.has(cid)) communities.set(cid, []);
    communities.get(cid)!.push(node);
  }

  // Compute inter-community edge counts
  const nodeCommMap = new Map<string, number>();
  for (const node of result.nodes) {
    nodeCommMap.set(node.filePath, node.communityId);
  }

  const interEdges = new Map<string, { count: number; types: Set<string> }>();
  for (const edge of result.edges) {
    const srcComm = nodeCommMap.get(edge.source);
    const tgtComm = nodeCommMap.get(edge.target);
    if (srcComm === undefined || tgtComm === undefined) continue;
    if (srcComm === tgtComm) continue;

    const key = `${srcComm}→${tgtComm}`;
    if (!interEdges.has(key)) {
      interEdges.set(key, { count: 0, types: new Set() });
    }
    const entry = interEdges.get(key)!;
    entry.count++;
    entry.types.add(edge.type);
  }

  // Build DOT
  const lines: string[] = [
    "digraph abstract {",
    '  graph [rankdir=TB, fontname="Inter, Helvetica, Arial, sans-serif", fontsize=14, bgcolor="transparent",',
    "    pad=0.6, nodesep=0.8, ranksep=1.0, splines=true];",
    '  node [shape=record, style="filled,rounded", fontname="Inter, Helvetica, Arial, sans-serif", fontsize=12, margin="0.2,0.12"];',
    '  edge [fontname="Inter, Helvetica, Arial, sans-serif", fontsize=10];',
    "",
  ];

  // Community meta-nodes
  for (const [cid, nodes] of [...communities.entries()].sort(([a], [b]) => a - b)) {
    const id = `comm_${cid === -1 ? "ungrouped" : cid}`;
    const hasTarget = nodes.some((n) => n.isTarget);
    const targetNode = nodes.find((n) => n.isTarget);

    // Derive a short label from community label or common path prefix
    const commLabel = nodes[0]?.communityLabel ?? "ungrouped";
    const shortLabel = deriveShortLabel(commLabel, nodes);

    // List key files (target first, then by dependents)
    const sortedNodes = [...nodes].sort((a, b) => {
      if (a.isTarget) return -1;
      if (b.isTarget) return 1;
      return b.dependents - a.dependents;
    });
    const fileList = sortedNodes
      .slice(0, 5)
      .map((n) => (n.isTarget ? `⭐ ${n.name}` : n.name))
      .join("\\l");
    const moreCount = nodes.length > 5 ? nodes.length - 5 : 0;
    const moreLabel = moreCount > 0 ? `\\l+${moreCount} more` : "";

    const avgHop =
      nodes.reduce((s, n) => s + n.hopDistance, 0) / nodes.length;
    const totalDeps = nodes.reduce((s, n) => s + n.dependents, 0);

    const fillColor = hasTarget ? "#fff9c4" : LAYER_COLORS[cid % LAYER_COLORS.length] ?? "#f5f5f5";
    const borderClr = hasTarget ? "#f57f17" : LAYER_BORDER_COLORS[cid % LAYER_BORDER_COLORS.length] ?? "#999";
    const penWidth = hasTarget ? "2.5" : "1.5";

    const label = `{${escapeDot(shortLabel)} (${nodes.length})|${fileList}${moreLabel}\\l|deps: ${totalDeps} · hop: ${avgHop.toFixed(1)}}`;

    lines.push(
      `  ${id} [label="${label}", fillcolor="${fillColor}", color="${borderClr}", penwidth=${penWidth}];`,
    );
  }
  lines.push("");

  // Inter-community edges
  for (const [key, data] of interEdges) {
    const [srcStr, tgtStr] = key.split("→");
    const src = `comm_${srcStr === "-1" ? "ungrouped" : srcStr}`;
    const tgt = `comm_${tgtStr === "-1" ? "ungrouped" : tgtStr}`;

    const hasImport = data.types.has("import");
    const hasCoChange = data.types.has("co_change");

    const color = hasImport ? EDGE_COLORS.import : hasCoChange ? EDGE_COLORS.co_change : EDGE_COLORS.doc_cooc;
    const style = hasImport ? "solid" : hasCoChange ? "dashed" : "dotted";
    const label = data.count > 1 ? `${data.count}` : "";

    lines.push(
      `  ${src} -> ${tgt} [label="${label}", color="${color}", style=${style}, penwidth=2, fontcolor="${color}"];`,
    );
  }

  lines.push("}");
  return lines.join("\n");
}

function deriveShortLabel(commLabel: string, nodes: FocusNode[]): string {
  // Try to extract a meaningful short label from the community label
  // Community labels are often like "packages/analyzer/src/agg/lx.ts"
  const parts = commLabel.split("/");
  if (parts.length >= 2) {
    // Find common prefix among node file paths
    const paths = nodes.map((n) => n.filePath);
    const commonPrefix = findCommonPrefix(paths);
    if (commonPrefix.length > 3) {
      // Use last 2 meaningful segments
      const segments = commonPrefix.split("/").filter(Boolean);
      return segments.slice(-2).join("/") || commLabel;
    }
    return parts.slice(-2).join("/").replace(/\.ts$/, "") || commLabel;
  }
  return commLabel || "ungrouped";
}

function findCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) return paths[0]!;
  let prefix = paths[0]!;
  for (let i = 1; i < paths.length; i++) {
    while (!paths[i]!.startsWith(prefix)) {
      prefix = prefix.substring(0, prefix.lastIndexOf("/"));
      if (!prefix) return "";
    }
  }
  return prefix;
}

/* ── HTML wrapper ─────────────────────────────────────────────────── */

const CSS = /* css */ `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Inter", "Helvetica Neue", Arial, sans-serif;
    background: #fafafa;
    color: #263238;
    overflow: hidden;
    height: 100vh;
  }
  #header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    background: #fff; border-bottom: 1px solid #e0e0e0;
    padding: 12px 24px;
    display: flex; align-items: center; gap: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  #header h1 { font-size: 18px; font-weight: 600; white-space: nowrap; }
  #header .meta { font-size: 13px; color: #78909c; }
  #legend {
    display: flex; gap: 16px; margin-left: auto; font-size: 12px;
    align-items: center;
  }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-line {
    width: 24px; height: 3px; border-radius: 1px;
  }
  .legend-line.import { background: ${EDGE_COLORS.import}; }
  .legend-line.co-change { background: ${EDGE_COLORS.co_change}; border-style: dashed; height: 0; border-top: 3px dashed ${EDGE_COLORS.co_change}; }
  .legend-line.doc-cooc { background: ${EDGE_COLORS.doc_cooc}; border-style: dotted; height: 0; border-top: 3px dotted ${EDGE_COLORS.doc_cooc}; }

  #graph-container {
    position: absolute; top: 56px; bottom: 0; left: 0; right: 0;
    overflow: hidden; cursor: grab;
  }
  #graph-container:active { cursor: grabbing; }

  #controls {
    position: fixed; bottom: 20px; right: 20px; z-index: 100;
    display: flex; gap: 8px;
  }
  #controls button {
    width: 36px; height: 36px; border-radius: 8px;
    border: 1px solid #cfd8dc; background: #fff;
    font-size: 18px; cursor: pointer; display: flex;
    align-items: center; justify-content: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    transition: background 0.15s;
  }
  #controls button:hover { background: #eceff1; }

  #details {
    position: fixed; bottom: 20px; left: 20px; z-index: 100;
    background: #fff; border: 1px solid #e0e0e0;
    border-radius: 8px; padding: 12px 16px;
    font-size: 12px; max-width: 320px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    display: none;
  }
  #details h3 { font-size: 14px; margin-bottom: 6px; }
  #details .detail-row { margin: 3px 0; color: #546e7a; }
  #details .detail-label { font-weight: 600; color: #37474f; }

  /* ── Insights panel ─────────────────────────────────── */
  #insights-toggle {
    position: fixed; top: 64px; right: 16px; z-index: 110;
    background: #fff; border: 1px solid #cfd8dc;
    border-radius: 8px; padding: 6px 14px;
    font-size: 13px; font-weight: 500; cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    transition: background 0.15s;
  }
  #insights-toggle:hover { background: #eceff1; }

  #insights-panel {
    position: fixed; top: 56px; right: 0; bottom: 0; z-index: 105;
    width: 380px; background: #fff;
    border-left: 1px solid #e0e0e0;
    overflow-y: auto; padding: 16px 20px 32px;
    box-shadow: -2px 0 8px rgba(0,0,0,0.06);
    transform: translateX(100%);
    transition: transform 0.25s ease;
    font-size: 13px; line-height: 1.55;
  }
  #insights-panel.open { transform: translateX(0); }

  #insights-panel h2 {
    font-size: 16px; font-weight: 600; margin: 0 0 12px;
    padding-bottom: 8px; border-bottom: 1px solid #e0e0e0;
  }
  #insights-panel h3 {
    font-size: 14px; font-weight: 600; margin: 16px 0 6px;
    color: #37474f;
  }
  #insights-panel p { margin: 4px 0 8px; color: #455a64; }
  #insights-panel ul { margin: 4px 0 12px; padding-left: 20px; }
  #insights-panel li { margin: 3px 0; color: #546e7a; }
  #insights-panel .cluster-card {
    background: #f5f7fa; border-radius: 6px; padding: 10px 14px;
    margin: 6px 0; border-left: 3px solid #90a4ae;
  }
  #insights-panel .cluster-card h4 {
    font-size: 13px; font-weight: 600; margin: 0 0 4px; color: #263238;
  }
  #insights-panel .cluster-card .role { color: #546e7a; font-size: 12px; }
  #insights-panel .cluster-card .files {
    font-size: 11px; color: #78909c; margin-top: 4px;
  }
  #insights-panel .hub-badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 600; margin-right: 4px;
  }
  #insights-panel .hub-badge.high { background: #ffcdd2; color: #c62828; }
  #insights-panel .hub-badge.medium { background: #fff3e0; color: #e65100; }
  #insights-panel .hub-badge.low { background: #e8f5e9; color: #2e7d32; }
  #insights-panel .observation {
    background: #fafafa; border-radius: 6px; padding: 8px 12px;
    margin: 4px 0; border-left: 3px solid #ffc107;
    font-size: 12px; color: #37474f;
  }
  #insights-panel .reading-item {
    margin: 4px 0; padding: 4px 0;
    font-size: 12px; color: #546e7a;
  }
  #insights-panel code {
    background: #eceff1; padding: 1px 5px; border-radius: 3px;
    font-size: 11px; font-family: "SF Mono", "Menlo", monospace;
  }
  #insights-panel .llm-section {
    margin-top: 20px; padding-top: 16px;
    border-top: 1px solid #e0e0e0;
  }
  #insights-panel .llm-narrative {
    background: #f8f9ff; border-radius: 6px; padding: 12px 16px;
    border-left: 3px solid #5c6bc0; font-size: 13px; line-height: 1.6;
    color: #37474f; white-space: pre-wrap;
  }

  /* ── View tabs ──────────────────────────────────── */
  #view-tabs { display: flex; gap: 4px; margin-left: 8px; }
  .view-tab {
    padding: 4px 12px; border-radius: 6px;
    border: 1px solid #cfd8dc; background: #f5f5f5;
    font-size: 12px; font-weight: 500; cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    white-space: nowrap;
  }
  .view-tab:hover { background: #eceff1; }
  .view-tab.active {
    background: #263238; color: #fff;
    border-color: #263238;
  }
  .view-pane { display: none; width: 100%; height: 100%; }
  .view-pane.active { display: block; }
  .view-pane svg {
    position: absolute;
    transform-origin: 0 0;
  }
`;

const SCRIPT = /* js */ `
(function() {
  const container = document.getElementById('graph-container');
  const details = document.getElementById('details');

  // ── View management ───────────────────────────────
  var currentView = 'full';
  var viewStates = { full: null, flow: null, abstract: null };

  function getActiveSvg() {
    var pane = container.querySelector('.view-pane.active');
    return pane ? pane.querySelector('svg') : null;
  }

  function initViewSvg(svg) {
    if (!svg) return;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = 'auto';
    svg.style.height = 'auto';
  }

  // Init all SVGs
  container.querySelectorAll('.view-pane svg').forEach(initViewSvg);

  // ── Pan & Zoom ────────────────────────────────────
  var scale = 1, panX = 0, panY = 0;
  var dragging = false, startX = 0, startY = 0;

  function saveViewState() {
    viewStates[currentView] = { scale: scale, panX: panX, panY: panY };
  }

  function loadViewState(view) {
    var state = viewStates[view];
    if (state) {
      scale = state.scale; panX = state.panX; panY = state.panY;
      applyTransform();
    } else {
      setTimeout(fitToScreen, 50);
    }
  }

  function fitToScreen() {
    var svg = getActiveSvg();
    if (!svg) return;
    var cw = container.clientWidth, ch = container.clientHeight;
    var sw = svg.viewBox.baseVal.width || svg.getBBox().width;
    var sh = svg.viewBox.baseVal.height || svg.getBBox().height;
    scale = Math.min(cw / sw, ch / sh) * 0.9;
    panX = (cw - sw * scale) / 2;
    panY = (ch - sh * scale) / 2;
    applyTransform();
    saveViewState();
  }

  function applyTransform() {
    var svg = getActiveSvg();
    if (!svg) return;
    svg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  }

  container.addEventListener('wheel', function(e) {
    e.preventDefault();
    var rect = container.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var factor = e.deltaY < 0 ? 1.12 : 0.89;
    var newScale = Math.max(0.1, Math.min(10, scale * factor));
    panX = mx - (mx - panX) * (newScale / scale);
    panY = my - (my - panY) * (newScale / scale);
    scale = newScale;
    applyTransform();
  }, { passive: false });

  container.addEventListener('mousedown', function(e) {
    dragging = true; startX = e.clientX - panX; startY = e.clientY - panY;
  });
  window.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    panX = e.clientX - startX; panY = e.clientY - startY;
    applyTransform();
  });
  window.addEventListener('mouseup', function() { dragging = false; });

  // Zoom buttons
  document.getElementById('zoom-in').onclick = function() {
    scale = Math.min(10, scale * 1.3); applyTransform();
  };
  document.getElementById('zoom-out').onclick = function() {
    scale = Math.max(0.1, scale * 0.7); applyTransform();
  };
  document.getElementById('zoom-fit').onclick = fitToScreen;

  // ── Tab switching ─────────────────────────────────
  document.querySelectorAll('.view-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var view = tab.dataset.view;
      if (view === currentView) return;

      saveViewState();

      // Update tab active state
      document.querySelectorAll('.view-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');

      // Switch panes
      container.querySelectorAll('.view-pane').forEach(function(p) { p.classList.remove('active'); });
      var pane = container.querySelector('.view-pane[data-view="' + view + '"]');
      if (pane) pane.classList.add('active');

      currentView = view;
      loadViewState(view);
      details.style.display = 'none';
    });
  });

  // ── Node click → details panel ────────────────────
  var DATA = window.__FOCUS_DATA__;
  var nodeMap = {};
  DATA.nodes.forEach(function(n) { nodeMap[n.name] = n; });

  function bindNodeClicks(svg) {
    if (!svg) return;
    svg.querySelectorAll('.node').forEach(function(el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        var title = el.querySelector('title');
        if (!title) return;
        var id = title.textContent;
        var node = null;
        DATA.nodes.forEach(function(n) {
          var nid = 'n_' + n.filePath.replace(/[^a-zA-Z0-9]/g, '_');
          if (nid === id) node = n;
        });
        if (!node) return;
        details.style.display = 'block';
        details.innerHTML =
          '<h3>' + (node.isTarget ? '⭐ ' : '') + node.name + '</h3>' +
          '<div class="detail-row"><span class="detail-label">File:</span> ' + node.filePath + '</div>' +
          '<div class="detail-row"><span class="detail-label">Layer:</span> ' + node.layerLabel + ' (L' + node.layerIndex + ')</div>' +
          '<div class="detail-row"><span class="detail-label">Community:</span> ' + node.communityLabel + '</div>' +
          '<div class="detail-row"><span class="detail-label">Dependents:</span> ' + node.dependents + '</div>' +
          '<div class="detail-row"><span class="detail-label">Hop distance:</span> ' + node.hopDistance + '</div>';
      });
    });
  }

  // Bind clicks on all view SVGs
  container.querySelectorAll('.view-pane svg').forEach(bindNodeClicks);

  container.addEventListener('click', function(e) {
    if (e.target === container || e.target.closest('.view-pane') === e.target) {
      details.style.display = 'none';
    }
  });

  // ── Init ──────────────────────────────────────────
  setTimeout(fitToScreen, 50);
  window.addEventListener('resize', fitToScreen);

  // ── Insights panel toggle ─────────────────────────
  var panel = document.getElementById('insights-panel');
  var toggle = document.getElementById('insights-toggle');
  if (toggle && panel) {
    toggle.addEventListener('click', function() {
      var isOpen = panel.classList.toggle('open');
      toggle.textContent = isOpen ? '✕ Close' : '📋 Insights';
      container.style.right = isOpen ? '380px' : '0';
      setTimeout(fitToScreen, 300);
    });
    // Open by default
    panel.classList.add('open');
    toggle.textContent = '✕ Close';
    container.style.right = '380px';
  }
})();
`;

/* ── Public API ───────────────────────────────────────────────────── */

/**
 * Render a FocusResult as an interactive HTML page with Graphviz SVG.
 * Returns a self-contained HTML string.
 *
 * @param result - The focus subgraph data.
 * @param options - Optional: `narrative` from LLM for the --explain panel.
 */
export async function renderFocusReportHtml(
  result: FocusResult,
  options?: { narrative?: string },
): Promise<string> {
  const viz = await instance();

  function renderDot(dot: string): string {
    return viz
      .renderString(dot, { format: "svg", engine: "dot" })
      .replace(/<\?xml[^?]*\?>\s*/i, "")
      .replace(/<!DOCTYPE[^>]*>\s*/i, "")
      .replace(/<!--[^-]*-->\s*/i, "");
  }

  const svgFull = renderDot(buildDot(result));
  const svgFlow = renderDot(buildFlowDot(result));
  const svgAbstract = renderDot(buildAbstractDot(result));

  const importCount = result.edges.filter((e) => e.type === "import").length;
  const coChangeCount = result.edges.filter(
    (e) => e.type === "co_change",
  ).length;
  const docCount = result.edges.filter((e) => e.type === "doc_cooc").length;

  const json = JSON.stringify(result);

  // ── Compute insights ──────────────────────────────────────────
  const insights = analyzeFocusInsights(result);
  const narrative = options?.narrative;

  const insightsHtml = buildInsightsHtml(insights, narrative);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Focus: ${escapeHtml(result.target)} — IntentWeave Architecture</title>
<style>${CSS}</style>
</head>
<body>
<div id="header">
  <h1>🔍 ${escapeHtml(result.target)}</h1>
  <span class="meta">${result.nodes.length} nodes · ${result.edges.length} edges · ${result.hops}-hop view</span>
  <span class="meta">${importCount} imports${coChangeCount ? ` · ${coChangeCount} co-changes` : ""}${docCount ? ` · ${docCount} doc links` : ""}</span>
  <div id="view-tabs">
    <button class="view-tab active" data-view="full" title="Full dependency graph with all edge types">📊 Full Graph</button>
    <button class="view-tab" data-view="flow" title="Linearised import flow through the target">🔀 Flow</button>
    <button class="view-tab" data-view="abstract" title="Nodes collapsed by community into meta-groups">🏗️ Abstract</button>
  </div>
  <div id="legend">
    <div class="legend-item"><div class="legend-line import"></div> Import</div>
    ${coChangeCount ? '<div class="legend-item"><div class="legend-line co-change"></div> Co-change</div>' : ""}
    ${docCount ? '<div class="legend-item"><div class="legend-line doc-cooc"></div> Doc mention</div>' : ""}
  </div>
</div>
<div id="graph-container">
  <div class="view-pane active" data-view="full">${svgFull}</div>
  <div class="view-pane" data-view="flow">${svgFlow}</div>
  <div class="view-pane" data-view="abstract">${svgAbstract}</div>
</div>
<button id="insights-toggle" title="Toggle insights panel">📋 Insights</button>
${insightsHtml}
<div id="details"></div>
<div id="controls">
  <button id="zoom-in" title="Zoom in">+</button>
  <button id="zoom-out" title="Zoom out">−</button>
  <button id="zoom-fit" title="Fit to screen">⊡</button>
</div>
<script>window.__FOCUS_DATA__ = ${json};</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildInsightsHtml(
  insights: FocusInsights,
  narrative?: string,
): string {
  const sections: string[] = [];

  // Summary
  sections.push(`<h2>Architecture Insights</h2>`);
  sections.push(`<p>${insights.targetSummary}</p>`);

  // Reading guide
  sections.push(`<h3>📖 How to Read This Diagram</h3>`);
  for (const item of insights.readingGuide) {
    sections.push(`<div class="reading-item">• ${item}</div>`);
  }

  // Flow summary
  sections.push(`<h3>🔀 Data Flow</h3>`);
  sections.push(`<p>${insights.flowSummary}</p>`);

  // Clusters
  sections.push(`<h3>📦 Layer Breakdown</h3>`);
  for (const cluster of insights.clusters) {
    const fileList = cluster.files.slice(0, 8).join(", ");
    const more =
      cluster.files.length > 8
        ? ` +${cluster.files.length - 8} more`
        : "";
    sections.push(`<div class="cluster-card">
      <h4>${escapeHtml(cluster.label)}</h4>
      <div class="role">${cluster.role}</div>
      <div class="files">${escapeHtml(fileList)}${more}</div>
    </div>`);
  }

  // Hubs
  if (insights.hubs.length > 0) {
    sections.push(`<h3>🎯 Hub Nodes</h3>`);
    for (const hub of insights.hubs) {
      sections.push(
        `<p><span class="hub-badge ${hub.risk}">${hub.risk}</span> ` +
          `<strong>${escapeHtml(hub.name)}</strong> — ${hub.dependents} transitive dependents</p>`,
      );
    }
  }

  // Observations
  if (insights.observations.length > 0) {
    sections.push(`<h3>💡 Key Observations</h3>`);
    for (const obs of insights.observations) {
      sections.push(`<div class="observation">${obs}</div>`);
    }
  }

  // LLM narrative (if provided via --explain)
  if (narrative) {
    sections.push(`<div class="llm-section">`);
    sections.push(`<h3>🤖 AI Architecture Narrative</h3>`);
    sections.push(
      `<div class="llm-narrative">${escapeHtml(narrative)}</div>`,
    );
    sections.push(`</div>`);
  }

  return `<div id="insights-panel">${sections.join("\n")}</div>`;
}

/**
 * Export DOT source for external rendering (debugging / advanced usage).
 */
export function renderFocusDot(result: FocusResult): string {
  return buildDot(result);
}
