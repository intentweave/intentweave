// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * DecisionTree — D3 force-directed graph with hierarchical gravity.
 *
 * Visual design:
 *   - Rounded-rect nodes color-coded by kind (decision, chosen, rejected, …)
 *   - Curved edge paths with predicate labels
 *   - Interactive: zoom / pan / drag nodes
 *   - Hierarchical Y-force: topic → decision → options → rationale/risk
 */

import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { DecisionTreeData, InsightNode, NodeKind } from "../types.js";
import { NODE_COLORS, PREDICATE_LABELS } from "../types.js";

// ── Layout constants ─────────────────────────────────────────────────────────

/** Vertical depth bands for hierarchical gravity. */
const DEPTH: Record<NodeKind, number> = {
  topic: 0,
  decision: 1,
  chosen: 2,
  rejected: 2,
  option: 2,
  concept: 3,
  rationale: 3,
  risk: 3,
};

const BAND_HEIGHT = 160;
const NODE_HEIGHT = 36;
const NODE_RX = 10;
const FONT_SIZE = 12;
const MAX_LABEL_LEN = 28;
const CHAR_WIDTH = 7; // approximate monospace-equivalent width

// ── Simulation node type ─────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  kind: NodeKind;
  confidence?: number;
  temporalOrder?: number;
  w: number; // computed rect width
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  label: string;
}

// ── Component ────────────────────────────────────────────────────────────────

interface DecisionTreeProps {
  data: DecisionTreeData;
  selectedNodeId?: string;
  onNodeClick?: (node: InsightNode) => void;
}

export function DecisionTree({
  data,
  selectedNodeId,
  onNodeClick,
}: DecisionTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !data.nodes.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const { width, height } = containerRef.current.getBoundingClientRect();
    svg.attr("width", width).attr("height", height);

    // ── Prepare data ───────────────────────────────────────────────────────
    const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

    const simNodes: SimNode[] = data.nodes.map((n) => {
      const truncated =
        n.label.length > MAX_LABEL_LEN
          ? n.label.slice(0, MAX_LABEL_LEN - 1) + "…"
          : n.label;
      const w = Math.max(truncated.length * CHAR_WIDTH + 28, 90);
      return {
        id: n.id,
        label: truncated,
        kind: n.kind,
        confidence: n.confidence,
        temporalOrder: n.temporalOrder,
        w,
        x: width / 2 + (Math.random() - 0.5) * 200,
        y: (DEPTH[n.kind] ?? 2) * BAND_HEIGHT + 80 + (Math.random() - 0.5) * 40,
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

    // ── Arrow marker ───────────────────────────────────────────────────────
    svg
      .append("defs")
      .append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 20)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L10,0L0,4")
      .attr("fill", "#475569");

    // ── Force simulation ───────────────────────────────────────────────────
    const simulation = d3
      .forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(140)
          .strength(0.4),
      )
      .force("charge", d3.forceManyBody().strength(-400))
      .force(
        "y",
        d3
          .forceY<SimNode>((d) => (DEPTH[d.kind] ?? 2) * BAND_HEIGHT + 80)
          .strength(0.35),
      )
      .force("x", d3.forceX<SimNode>(width / 2).strength(0.04))
      .force(
        "collision",
        d3.forceCollide<SimNode>().radius((d) => d.w / 2 + 12),
      )
      .alphaDecay(0.02);

    // ── Draw edges (paths) ─────────────────────────────────────────────────
    const linkGroup = g.append("g").attr("class", "links");

    const linkPaths = linkGroup
      .selectAll<SVGPathElement, SimLink>("path")
      .data(simLinks)
      .join("path")
      .attr("stroke", "#475569")
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", 0.5)
      .attr("fill", "none")
      .attr("marker-end", "url(#arrow)");

    // Edge labels
    const linkLabels = linkGroup
      .selectAll<SVGTextElement, SimLink>("text")
      .data(simLinks.filter((l) => l.label))
      .join("text")
      .text((d) => d.label)
      .attr("font-size", 10)
      .attr("fill", "#64748b")
      .attr("text-anchor", "middle")
      .attr("dy", -6);

    // ── Draw nodes ─────────────────────────────────────────────────────────
    const nodeGroup = g
      .append("g")
      .attr("class", "nodes")
      .selectAll<SVGGElement, SimNode>("g")
      .data(simNodes)
      .join("g")
      .attr("class", "node-group")
      .call(
        d3
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
          }),
      );

    // Click handler for node selection
    nodeGroup.on("click", (_event, d) => {
      const orig = data.nodes.find((n) => n.id === d.id);
      if (orig && onNodeClick) onNodeClick(orig);
    });
    nodeGroup.style("cursor", "pointer");

    // Rect background
    nodeGroup
      .append("rect")
      .attr("rx", NODE_RX)
      .attr("ry", NODE_RX)
      .attr("width", (d) => d.w)
      .attr("height", NODE_HEIGHT)
      .attr("x", (d) => -d.w / 2)
      .attr("y", -NODE_HEIGHT / 2)
      .attr("fill", (d) => NODE_COLORS[d.kind] + "1A") // ~10% opacity
      .attr("stroke", (d) => NODE_COLORS[d.kind])
      .attr("stroke-width", (d) => (d.id === selectedNodeId ? 3.5 : 2));

    // Selection glow filter
    if (selectedNodeId) {
      const selNode = nodeGroup.filter((d) => d.id === selectedNodeId);
      selNode
        .select("rect")
        .attr("filter", "drop-shadow(0 0 6px rgba(99,102,241,0.6))");
    }

    // Kind indicator dot
    nodeGroup
      .append("circle")
      .attr("cx", (d) => -d.w / 2 + 14)
      .attr("cy", 0)
      .attr("r", 4)
      .attr("fill", (d) => NODE_COLORS[d.kind]);

    // Label text
    nodeGroup
      .append("text")
      .text((d) => d.label)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("x", 4) // shift right slightly to account for dot
      .attr("fill", (d) => NODE_COLORS[d.kind])
      .attr("font-size", FONT_SIZE)
      .attr("font-weight", 500);

    // Temporal order badge (top-right corner on decision nodes)
    const temporalNodes = nodeGroup.filter(
      (d) => d.temporalOrder != null && d.kind === "decision",
    );
    temporalNodes
      .append("circle")
      .attr("cx", (d) => d.w / 2 - 2)
      .attr("cy", -NODE_HEIGHT / 2 + 2)
      .attr("r", 9)
      .attr("fill", "#6366f1")
      .attr("stroke", "#1e1b4b")
      .attr("stroke-width", 1.5);
    temporalNodes
      .append("text")
      .text((d) => `#${d.temporalOrder}`)
      .attr("x", (d) => d.w / 2 - 2)
      .attr("y", -NODE_HEIGHT / 2 + 2)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("fill", "#e0e7ff")
      .attr("font-size", 9)
      .attr("font-weight", 700);

    // Tooltip on hover
    nodeGroup.append("title").text((d) => {
      const orig = data.nodes.find((n) => n.id === d.id);
      const parts = [orig?.label ?? d.label, `Kind: ${d.kind}`];
      if (d.confidence != null)
        parts.push(`Confidence: ${(d.confidence * 100).toFixed(0)}%`);
      if (orig?.description) parts.push(orig.description);
      return parts.join("\n");
    });

    // ── Tick ──────────────────────────────────────────────────────────────
    simulation.on("tick", () => {
      linkPaths.attr("d", (d) => {
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        const dx = t.x! - s.x!;
        const dy = t.y! - s.y!;
        const dr = Math.sqrt(dx * dx + dy * dy) * 1.5; // curvature
        return `M${s.x},${s.y}A${dr},${dr} 0 0,1 ${t.x},${t.y}`;
      });

      linkLabels.attr("x", (d) => {
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        return (s.x! + t.x!) / 2;
      });
      linkLabels.attr("y", (d) => {
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        return (s.y! + t.y!) / 2;
      });

      nodeGroup.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    // ── Initial zoom to fit ────────────────────────────────────────────────
    simulation.on("end", () => {
      const bounds = (g.node() as SVGGElement).getBBox();
      if (bounds.width === 0) return;

      const padding = 60;
      const scale = Math.min(
        (width - padding * 2) / bounds.width,
        (height - padding * 2) / bounds.height,
        1.2,
      );
      const tx = width / 2 - (bounds.x + bounds.width / 2) * scale;
      const ty = height / 2 - (bounds.y + bounds.height / 2) * scale;

      svg
        .transition()
        .duration(500)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    });

    return () => {
      simulation.stop();
    };
  }, [data, selectedNodeId, onNodeClick]);

  return (
    <div ref={containerRef} className="insight-canvas w-full h-full">
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
}
