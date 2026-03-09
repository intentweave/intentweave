// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * ImpactGraph — D3 radial force-directed graph for impact / blast-radius
 * analysis.
 *
 * Visual design:
 *   - Center node is large and distinct (the "changed" entity)
 *   - Concentric rings for depth 1 (direct) and depth 2 (ripple) entities
 *   - Nodes color-coded by kind (decision, risk, concept, affected, …)
 *   - Depth rings drawn as translucent circles in the background
 *   - Curved edge paths with predicate labels
 *   - Interactive: zoom / pan / drag nodes / click to inspect
 */

import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { ImpactGraphData, InsightNode, NodeKind } from "../types.js";
import { NODE_COLORS, PREDICATE_LABELS } from "../types.js";

// ── Layout constants ─────────────────────────────────────────────────────────

/** Radius per depth ring. */
const RING_RADIUS = 180;
const CENTER_RADIUS = 28;
const NODE_RADIUS_DEFAULT = 18;
const NODE_RADIUS_SMALL = 14;
const FONT_SIZE = 11;
const MAX_LABEL_LEN = 22;

// ── Simulation node type ─────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  kind: NodeKind;
  depth: number;
  confidence?: number;
  r: number; // computed node radius
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  label: string;
}

// ── Component ────────────────────────────────────────────────────────────────

interface ImpactGraphProps {
  data: ImpactGraphData;
  selectedNodeId?: string;
  onNodeClick?: (node: InsightNode) => void;
}

export function ImpactGraph({
  data,
  selectedNodeId,
  onNodeClick,
}: ImpactGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

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

    const simNodes: SimNode[] = data.nodes.map((n) => {
      const depth = n.depth ?? (n.id === data.centerId ? 0 : 1);
      const isCenter = depth === 0;
      const r = isCenter
        ? CENTER_RADIUS
        : depth === 1
          ? NODE_RADIUS_DEFAULT
          : NODE_RADIUS_SMALL;
      const truncated =
        n.label.length > MAX_LABEL_LEN
          ? n.label.slice(0, MAX_LABEL_LEN - 1) + "…"
          : n.label;

      // Scatter initial positions on the appropriate ring
      const angle = Math.random() * Math.PI * 2;
      const ringR = depth * RING_RADIUS;
      return {
        id: n.id,
        label: truncated,
        kind: n.kind,
        depth,
        confidence: n.confidence,
        r,
        x: cx + (isCenter ? 0 : Math.cos(angle) * ringR + (Math.random() - 0.5) * 40),
        y: cy + (isCenter ? 0 : Math.sin(angle) * ringR + (Math.random() - 0.5) * 40),
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
      .scaleExtent([0.15, 4])
      .on("zoom", (event) => g.attr("transform", event.transform));

    svg.call(zoom);

    // ── Depth ring backgrounds ─────────────────────────────────────────────
    const maxDepth = data.maxDepth || 2;
    const ringGroup = g.append("g").attr("class", "depth-rings");

    for (let d = maxDepth; d >= 1; d--) {
      ringGroup
        .append("circle")
        .attr("cx", cx)
        .attr("cy", cy)
        .attr("r", d * RING_RADIUS + 60)
        .attr("fill", "none")
        .attr("stroke", d === 1 ? "rgba(99, 102, 241, 0.15)" : "rgba(99, 102, 241, 0.08)")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", d === 1 ? "none" : "4 4");

      // Ring label
      ringGroup
        .append("text")
        .attr("x", cx)
        .attr("y", cy - d * RING_RADIUS - 66)
        .attr("text-anchor", "middle")
        .attr("fill", "rgba(148, 163, 184, 0.4)")
        .attr("font-size", 10)
        .text(d === 1 ? "Direct impact" : `${d}-hop ripple`);
    }

    // ── Arrow marker ───────────────────────────────────────────────────────
    svg
      .append("defs")
      .append("marker")
      .attr("id", "impact-arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 22)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#475569");

    // ── Edges ──────────────────────────────────────────────────────────────
    const linkGroup = g.append("g").attr("class", "links");

    const linkSel = linkGroup
      .selectAll<SVGPathElement, SimLink>("path")
      .data(simLinks)
      .join("path")
      .attr("stroke", "#475569")
      .attr("stroke-width", 1.2)
      .attr("fill", "none")
      .attr("marker-end", "url(#impact-arrow)")
      .attr("opacity", 0.6);

    // Edge labels
    const edgeLabelSel = linkGroup
      .selectAll<SVGTextElement, SimLink>("text")
      .data(simLinks)
      .join("text")
      .attr("font-size", 9)
      .attr("fill", "#64748b")
      .attr("text-anchor", "middle")
      .attr("dy", -4)
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
        if (original && onNodeClick) onNodeClick(original);
      });

    // Outer glow for center node
    nodeSel
      .filter((d) => d.depth === 0)
      .append("circle")
      .attr("r", (d) => d.r + 8)
      .attr("fill", "none")
      .attr("stroke", NODE_COLORS.center)
      .attr("stroke-width", 2)
      .attr("opacity", 0.3)
      .attr("stroke-dasharray", "4 3");

    // Node circle
    nodeSel
      .append("circle")
      .attr("r", (d) => d.r)
      .attr("fill", (d) => {
        const color = NODE_COLORS[d.kind] ?? "#6b7280";
        // Dim ripple nodes slightly
        return d.depth >= 2 ? color + "AA" : color;
      })
      .attr("stroke", (d) =>
        d.id === selectedNodeId ? "#fff" : "rgba(30, 41, 59, 0.8)",
      )
      .attr("stroke-width", (d) => (d.id === selectedNodeId ? 2.5 : 1.5));

    // Confidence ring (outer arc for depth 0-1 nodes)
    nodeSel
      .filter((d) => d.confidence != null && d.confidence < 1 && d.depth < 2)
      .append("circle")
      .attr("r", (d) => d.r + 3)
      .attr("fill", "none")
      .attr("stroke", (d) => NODE_COLORS[d.kind] ?? "#6b7280")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", (d) => {
        const circumference = Math.PI * 2 * (d.r + 3);
        const filled = circumference * (d.confidence ?? 1);
        return `${filled} ${circumference - filled}`;
      })
      .attr("opacity", 0.5);

    // Label
    nodeSel
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => d.r + 14)
      .attr("font-size", (d) => (d.depth === 0 ? FONT_SIZE + 1 : FONT_SIZE))
      .attr("font-weight", (d) => (d.depth === 0 ? "600" : "400"))
      .attr("fill", (d) => (d.depth === 0 ? "#e2e8f0" : "#94a3b8"))
      .text((d) => d.label);

    // Depth badge for center
    nodeSel
      .filter((d) => d.depth === 0)
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", 4)
      .attr("font-size", 14)
      .attr("fill", "#fff")
      .attr("font-weight", "600")
      .text("⊕");

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
    const simulation = d3
      .forceSimulation(simNodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(120)
          .strength(0.3),
      )
      .force("charge", d3.forceManyBody().strength(-300))
      .force("collision", d3.forceCollide<SimNode>().radius((d) => d.r + 12))
      .force(
        "radial",
        d3
          .forceRadial<SimNode>(
            (d) => d.depth * RING_RADIUS,
            cx,
            cy,
          )
          .strength((d) => (d.depth === 0 ? 1 : 0.6)),
      )
      .on("tick", tick);

    function tick() {
      // Update edges as quadratic bezier curves
      linkSel.attr("d", (d) => {
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        const dx = (t.x ?? 0) - (s.x ?? 0);
        const dy = (t.y ?? 0) - (s.y ?? 0);
        const dr = Math.sqrt(dx * dx + dy * dy) * 0.8;
        return `M${s.x},${s.y}A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
      });

      // Update edge labels at midpoint
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

      // Update nodes
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    }

    // ── Initial zoom to fit ────────────────────────────────────────────────
    const totalRadius = (maxDepth + 1) * RING_RADIUS + 100;
    const scale = Math.min(
      width / (totalRadius * 2),
      height / (totalRadius * 2),
      1,
    );
    const initialTransform = d3.zoomIdentity
      .translate(width / 2 - cx * scale, height / 2 - cy * scale)
      .scale(scale);
    svg.call(zoom.transform, initialTransform);

    // ── Cleanup ────────────────────────────────────────────────────────────
    return () => {
      simulation.stop();
    };
  }, [data, selectedNodeId, onNodeClick]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <svg
        ref={svgRef}
        className="w-full h-full"
        style={{ background: "transparent" }}
      />
    </div>
  );
}
