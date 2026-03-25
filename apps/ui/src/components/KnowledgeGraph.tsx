// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeGraph — D3 force-directed visualization of the full session KG.
 *
 * Visual design:
 *   - All Canon:Entity nodes shown, colored by entity type (via NodeKind)
 *   - Node size scales with connectivity (more connections = larger)
 *   - Edge labels show canonical predicates
 *   - Stats overlay shows total entities / relationships / current subset
 *   - Interactive: zoom / pan / drag / click to inspect
 */

import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { InsightNode, KnowledgeGraphData, NodeKind } from "../types.js";
import {
  NODE_COLORS,
  PREDICATE_LABELS,
  EDGE_SEVERITY_COLORS,
  predicateSeverity,
} from "../types.js";

// ── Layout constants ─────────────────────────────────────────────────────────

const NODE_RADIUS_MIN = 10;
const NODE_RADIUS_MAX = 30;
const FONT_SIZE = 10;
const MAX_LABEL_LEN = 18;

// ── Simulation node type ─────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  kind: NodeKind;
  entityType?: string;
  connectionCount: number;
  r: number;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  label: string;
}

// ── Data shape ───────────────────────────────────────────────────────────────
// KnowledgeGraphData is imported from types.ts by App.tsx — not re-exported here

// ── Component ────────────────────────────────────────────────────────────────

interface KnowledgeGraphProps {
  data: KnowledgeGraphData;
  selectedNodeId?: string;
  onNodeClick?: (node: InsightNode) => void;
  /** When set, dims everything except these node IDs (lineage highlighting). */
  highlightedNodeIds?: Set<string>;
}

export function KnowledgeGraph({
  data,
  selectedNodeId,
  onNodeClick,
  highlightedNodeIds,
}: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Stable refs for volatile props — avoids full D3 rebuild on select/highlight
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const selectedIdRef = useRef(selectedNodeId);
  selectedIdRef.current = selectedNodeId;
  const highlightIdsRef = useRef(highlightedNodeIds);
  highlightIdsRef.current = highlightedNodeIds;
  const applyStylesRef = useRef<(() => void) | null>(null);

  // ── Heavy D3 setup — only re-runs when data changes ─────────────────────
  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !data.nodes.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const { width, height } = containerRef.current.getBoundingClientRect();
    svg.attr("width", width).attr("height", height);

    const cx = width / 2;
    const cy = height / 2;

    // ── Prepare data ───────────────────────────────────────────────────────
    const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

    // Compute connection count for sizing
    const connectionMap = new Map<string, number>();
    for (const e of data.edges) {
      connectionMap.set(e.source, (connectionMap.get(e.source) ?? 0) + 1);
      connectionMap.set(e.target, (connectionMap.get(e.target) ?? 0) + 1);
    }
    const maxConn = Math.max(...connectionMap.values(), 1);

    const simNodes: SimNode[] = data.nodes.map((n) => {
      const connCount = connectionMap.get(n.id) ?? 0;
      const fraction = maxConn > 1 ? connCount / maxConn : 0.5;
      const r =
        NODE_RADIUS_MIN + fraction * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
      const truncated =
        n.label.length > MAX_LABEL_LEN
          ? n.label.slice(0, MAX_LABEL_LEN - 1) + "…"
          : n.label;

      // Scatter initial positions in a disc
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * Math.min(width, height) * 0.3;
      return {
        id: n.id,
        label: truncated,
        kind: n.kind,
        entityType: n.entityType ?? undefined,
        connectionCount: connCount,
        r,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
      };
    });

    const simNodeMap = new Map(simNodes.map((n) => [n.id, n]));

    const simLinks: SimLink[] = data.edges
      .filter((e) => simNodeMap.has(e.source) && simNodeMap.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
        label:
          PREDICATE_LABELS[e.label] ?? e.label.toLowerCase().replace(/_/g, " "),
      }));

    // ── Zoom ───────────────────────────────────────────────────────────────
    const g = svg.append("g");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.08, 5])
      .on("zoom", (event) => g.attr("transform", event.transform));

    svg.call(zoom);

    // ── Defs ───────────────────────────────────────────────────────────────
    const defs = svg.append("defs");

    // Arrow markers by severity
    for (const [sev, color] of Object.entries(EDGE_SEVERITY_COLORS)) {
      defs
        .append("marker")
        .attr("id", `kg-arrow-${sev}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 18)
        .attr("refY", 0)
        .attr("markerWidth", 5)
        .attr("markerHeight", 5)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", color);
    }

    // Glow filter (always present — referenced dynamically by applyStyles)
    defs
      .append("filter")
      .attr("id", "kg-lineage-glow")
      .append("feDropShadow")
      .attr("dx", 0)
      .attr("dy", 0)
      .attr("stdDeviation", 4)
      .attr("flood-color", "#818cf8")
      .attr("flood-opacity", 0.7);

    // ── Edges ──────────────────────────────────────────────────────────────
    const linkGroup = g.append("g").attr("class", "links");

    const linkSel = linkGroup
      .selectAll<SVGPathElement, SimLink>("path")
      .data(simLinks)
      .join("path")
      .attr("stroke", (d) => {
        const sev = predicateSeverity(d.label);
        return EDGE_SEVERITY_COLORS[sev];
      })
      .attr("stroke-width", (d) => {
        const sev = predicateSeverity(d.label);
        return sev === "critical" ? 1.8 : sev === "warning" ? 1.3 : 1;
      })
      .attr("fill", "none")
      .attr(
        "marker-end",
        (d) => `url(#kg-arrow-${predicateSeverity(d.label)})`,
      ); // opacity set by applyStyles
    // Edge labels (visibility controlled by applyStyles for large graphs)
    const showAllEdgeLabels = data.edges.length <= 60;
    const edgeLabelSel = linkGroup
      .selectAll<SVGTextElement, SimLink>("text")
      .data(simLinks)
      .join("text")
      .attr("font-size", 8)
      .attr("fill", (d) => {
        const sev = predicateSeverity(d.label);
        return sev === "critical"
          ? "#fca5a5"
          : sev === "warning"
            ? "#fcd34d"
            : "#475569";
      })
      .attr("text-anchor", "middle")
      .attr("dy", -3)
      .text((d) => d.label);

    // ── Nodes ──────────────────────────────────────────────────────────────
    const nodeGroup = g.append("g").attr("class", "nodes");

    const nodeSel = nodeGroup
      .selectAll<SVGGElement, SimNode>("g")
      .data(simNodes, (d) => d.id)
      .join("g")
      .attr("cursor", "pointer")
      .on("click", (_event, d) => {
        const original = nodeById.get(d.id);
        if (original && onNodeClickRef.current)
          onNodeClickRef.current(original);
      });

    // Node circle (fill / stroke / filter set by applyStyles)
    nodeSel.append("circle").attr("r", (d) => d.r);

    // Entity type badge (small text inside large nodes)
    nodeSel
      .filter((d) => d.r >= 20 && d.entityType != null)
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", 3)
      .attr("font-size", 8)
      .attr("fill", "rgba(255,255,255,0.6)")
      .attr("pointer-events", "none")
      .text((d) => d.entityType ?? "");

    // Label (fill set by applyStyles)
    nodeSel
      .append("text")
      .attr("class", "kg-label")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => d.r + 12)
      .attr("font-size", (d) =>
        d.connectionCount > maxConn * 0.4 ? FONT_SIZE + 1 : FONT_SIZE,
      )
      .attr("font-weight", (d) =>
        d.connectionCount > maxConn * 0.4 ? "600" : "400",
      )
      .attr("pointer-events", "none")
      .text((d) => d.label);

    // ── Drag ───────────────────────────────────────────────────────────────
    const drag = d3
      .drag<SVGGElement, SimNode>()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeSel.call(drag);

    // ── Simulation ─────────────────────────────────────────────────────────
    const linkDistance = data.nodes.length > 80 ? 80 : 120;
    const chargeStrength = data.nodes.length > 80 ? -150 : -250;

    const simulation = d3
      .forceSimulation(simNodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(linkDistance)
          .strength(0.4),
      )
      .force("charge", d3.forceManyBody().strength(chargeStrength))
      .force(
        "collision",
        d3.forceCollide<SimNode>().radius((d) => d.r + 8),
      )
      .force("center", d3.forceCenter(cx, cy).strength(0.05))
      .on("tick", tick);

    function tick() {
      linkSel.attr("d", (d) => {
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        const dx = (t.x ?? 0) - (s.x ?? 0);
        const dy = (t.y ?? 0) - (s.y ?? 0);
        const dr = Math.sqrt(dx * dx + dy * dy) * 0.8;
        return `M${s.x},${s.y}A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
      });

      edgeLabelSel
        .attr("x", (d) => {
          const s = d.source as SimNode;
          const t = d.target as SimNode;
          return ((s.x ?? 0) + (t.x ?? 0)) / 2;
        })
        .attr("y", (d) => {
          const s = d.source as SimNode;
          const t = d.target as SimNode;
          return ((s.y ?? 0) + (t.y ?? 0)) / 2;
        });

      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    }

    // ── Initial zoom to fit ────────────────────────────────────────────────
    // Let the simulation settle slightly, then fit
    simulation.tick(50);
    tick();

    const xs = simNodes.map((n) => n.x ?? cx);
    const ys = simNodes.map((n) => n.y ?? cy);
    const minX = Math.min(...xs) - 60;
    const maxX = Math.max(...xs) + 60;
    const minY = Math.min(...ys) - 60;
    const maxY = Math.max(...ys) + 60;
    const graphW = maxX - minX || 1;
    const graphH = maxY - minY || 1;
    const scale = Math.min(width / graphW, height / graphH, 1.2) * 0.9;
    const tX = width / 2 - ((minX + maxX) / 2) * scale;
    const tY = height / 2 - ((minY + maxY) / 2) * scale;

    svg.call(zoom.transform, d3.zoomIdentity.translate(tX, tY).scale(scale));

    // Restart simulation for interactivity
    simulation.alpha(0.5).restart();

    // ── Style-update function (called on selection / highlight change) ────
    function applyStyles() {
      const sel = selectedIdRef.current;
      const hlIds = highlightIdsRef.current;
      const hasHl = hlIds != null && hlIds.size > 0;
      const isHl = (id: string) => !hasHl || hlIds!.has(id);
      const isEdgeHl = (s: string, t: string) =>
        !hasHl || (hlIds!.has(s) && hlIds!.has(t));

      nodeSel
        .select("circle")
        .attr("fill", (d) => {
          const color = NODE_COLORS[d.kind] ?? "#6b7280";
          return isHl(d.id) ? color + "CC" : color + "18";
        })
        .attr("stroke", (d) => {
          if (d.id === sel) return "#fff";
          if (hasHl && isHl(d.id)) return "#818cf8";
          return (NODE_COLORS[d.kind] ?? "#6b7280") + "66";
        })
        .attr("stroke-width", (d) => {
          if (d.id === sel) return 2.5;
          if (hasHl && isHl(d.id)) return 2;
          return 1;
        })
        .attr("filter", (d) =>
          hasHl && isHl(d.id) ? "url(#kg-lineage-glow)" : null,
        );

      nodeSel.select(".kg-label").attr("fill", (d) => {
        if (!isHl(d.id)) return "#334155";
        return d.connectionCount > maxConn * 0.4 ? "#e2e8f0" : "#94a3b8";
      });

      linkSel.attr("opacity", (d) => {
        const sId =
          typeof d.source === "string" ? d.source : (d.source as SimNode).id;
        const tId =
          typeof d.target === "string" ? d.target : (d.target as SimNode).id;
        if (!isEdgeHl(sId, tId)) return 0.06;
        const sev = predicateSeverity(d.label);
        return sev === "critical" ? 0.8 : sev === "warning" ? 0.6 : 0.35;
      });

      edgeLabelSel.attr("opacity", (d) => {
        if (showAllEdgeLabels) return 1;
        const sId =
          typeof d.source === "string" ? d.source : (d.source as SimNode).id;
        const tId =
          typeof d.target === "string" ? d.target : (d.target as SimNode).id;
        return isEdgeHl(sId, tId) ? 1 : 0;
      });
    }

    applyStylesRef.current = applyStyles;
    applyStyles();

    return () => {
      simulation.stop();
    };
  }, [data]);

  // ── Lightweight style update on selection / highlight change ──────────
  useEffect(() => {
    applyStylesRef.current?.();
  }, [selectedNodeId, highlightedNodeIds]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <svg
        ref={svgRef}
        className="w-full h-full"
        style={{ background: "transparent" }}
      />
      {/* Stats overlay */}
      <div className="absolute top-3 left-3 bg-slate-900/90 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-400 pointer-events-none">
        <div className="flex items-center gap-3">
          <span>
            <span className="text-emerald-400 font-medium">
              {data.nodes.length}
            </span>
            {" / "}
            {data.totalEntities} entities
          </span>
          <span className="text-slate-700">|</span>
          <span>
            <span className="text-indigo-400 font-medium">
              {data.edges.length}
            </span>
            {" / "}
            {data.totalRelationships} relationships
          </span>
        </div>
      </div>
    </div>
  );
}
