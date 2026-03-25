// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * DecisionTimeline — horizontal timeline view with swim lanes per source document.
 *
 * Visual design:
 *   - Horizontal time axis (left = oldest, right = newest)
 *   - Swim lanes grouped by source document (artifactId)
 *   - Decision nodes placed on the time axis
 *   - Options / rationale branch vertically below each decision
 *   - Color-coded by node kind (same palette as force graph)
 *   - Click nodes to inspect details
 */

import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type {
  DecisionTreeData,
  InsightNode,
  InsightEdge,
  NodeKind,
} from "../types.js";
import { NODE_COLORS, PREDICATE_LABELS } from "../types.js";

// ── Layout constants ─────────────────────────────────────────────────────────

const MARGIN = { top: 60, right: 40, bottom: 40, left: 200 };
const LANE_HEIGHT = 180;
const LANE_PADDING = 20;
const NODE_WIDTH = 140;
const NODE_HEIGHT = 32;
const NODE_RX = 8;
const BRANCH_OFFSET_Y = 48; // vertical offset for child nodes below decision
const BRANCH_SPACING_Y = 38;
const FONT_SIZE = 11;
const MAX_LABEL_LEN = 20;
const CHAR_WIDTH = 6.5;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a date from various formats (ISO, Neo4j datetime string). */
function parseDate(s: string | undefined | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Truncate a label to a maximum length. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── Component ────────────────────────────────────────────────────────────────

interface DecisionTimelineProps {
  data: DecisionTreeData;
  selectedNodeId?: string;
  onNodeClick?: (node: InsightNode) => void;
}

export function DecisionTimeline({
  data,
  selectedNodeId,
  onNodeClick,
}: DecisionTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !data.nodes.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const { width: containerWidth, height: containerHeight } =
      containerRef.current.getBoundingClientRect();

    // ── Separate decisions from children ─────────────────────────────────
    const rootId = data.rootId;
    const decisions = data.nodes.filter(
      (n) => n.kind === "decision" && n.id !== rootId,
    );

    // Build adjacency: decision → children (via edges, excluding root edges)
    const childrenOf = new Map<
      string,
      { node: InsightNode; predicate: string }[]
    >();
    const decisionIds = new Set(decisions.map((d) => d.id));
    const nodeById = new Map(data.nodes.map((n) => [n.id, n]));

    for (const edge of data.edges) {
      if (edge.source === rootId) continue; // skip root→decision edges
      if (!decisionIds.has(edge.source)) continue;
      const target = nodeById.get(edge.target);
      if (!target || decisionIds.has(target.id)) continue;
      let list = childrenOf.get(edge.source);
      if (!list) {
        list = [];
        childrenOf.set(edge.source, list);
      }
      list.push({ node: target, predicate: edge.label });
    }

    // ── Compute time domain ──────────────────────────────────────────────
    // Use createdAt if available, fall back to temporalOrder, then index
    const decisionDates: { decision: InsightNode; date: Date }[] = [];
    let hasRealDates = false;

    for (const d of decisions) {
      const parsed = parseDate(d.createdAt);
      if (parsed) {
        decisionDates.push({ decision: d, date: parsed });
        hasRealDates = true;
      } else {
        // Fall back to a synthetic date using temporalOrder or index
        const idx = d.temporalOrder ?? decisions.indexOf(d) + 1;
        decisionDates.push({
          decision: d,
          date: new Date(2025, 0, idx), // synthetic: Jan 1 + order
        });
      }
    }

    // Sort by date
    decisionDates.sort((a, b) => a.date.getTime() - b.date.getTime());

    // ── Swim lanes by source document ────────────────────────────────────
    const laneLabels: string[] = [];
    const laneMap = new Map<string, number>();

    for (const { decision } of decisionDates) {
      const doc = decision.sourceDoc ?? "Unknown source";
      if (!laneMap.has(doc)) {
        laneMap.set(doc, laneLabels.length);
        laneLabels.push(doc);
      }
    }

    const laneCount = Math.max(laneLabels.length, 1);

    // ── Scales ───────────────────────────────────────────────────────────
    const timeDomain = d3.extent(decisionDates, (d) => d.date) as [Date, Date];
    // Add padding to time domain
    const timeRange = timeDomain[1].getTime() - timeDomain[0].getTime();
    const pad = Math.max(timeRange * 0.05, 86400000); // min 1 day
    const xMin = new Date(timeDomain[0].getTime() - pad);
    const xMax = new Date(timeDomain[1].getTime() + pad);

    const totalHeight = MARGIN.top + laneCount * LANE_HEIGHT + MARGIN.bottom;
    const innerWidth = Math.max(
      containerWidth - MARGIN.left - MARGIN.right,
      600,
    );

    svg
      .attr("width", containerWidth)
      .attr("height", Math.max(totalHeight, containerHeight));

    const xScale = d3.scaleTime().domain([xMin, xMax]).range([0, innerWidth]);

    // ── Zoom ─────────────────────────────────────────────────────────────
    const g = svg
      .append("g")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 5])
      .translateExtent([
        [-MARGIN.left, -MARGIN.top],
        [containerWidth + 200, totalHeight + 200],
      ])
      .on("zoom", (event) => g.attr("transform", event.transform));

    svg.call(zoom);

    // Set initial transform to include margins
    svg.call(
      zoom.transform,
      d3.zoomIdentity.translate(MARGIN.left, MARGIN.top),
    );

    // ── Swim lane backgrounds ────────────────────────────────────────────
    const laneGroup = g.append("g").attr("class", "lanes");

    for (let i = 0; i < laneCount; i++) {
      const y = i * LANE_HEIGHT;
      // Lane background
      laneGroup
        .append("rect")
        .attr("x", -MARGIN.left)
        .attr("y", y)
        .attr("width", innerWidth + MARGIN.left + MARGIN.right)
        .attr("height", LANE_HEIGHT)
        .attr("fill", i % 2 === 0 ? "#0f172a" : "#111827")
        .attr("stroke", "#1e293b")
        .attr("stroke-width", 0.5);

      // Lane label
      laneGroup
        .append("text")
        .text(truncate(laneLabels[i] ?? "Unknown", 28))
        .attr("x", -MARGIN.left + 12)
        .attr("y", y + 20)
        .attr("fill", "#64748b")
        .attr("font-size", 10)
        .attr("font-weight", 600);
    }

    // ── Time axis ────────────────────────────────────────────────────────
    const axisGroup = g
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0, -30)`);

    const timeAxis = hasRealDates
      ? d3
          .axisTop(xScale)
          .ticks(Math.min(Math.floor(innerWidth / 120), 12))
          .tickFormat((d) => d3.timeFormat("%b %d, %Y")(d as Date))
      : d3
          .axisTop(xScale)
          .ticks(decisions.length)
          .tickFormat((_d, i) => `Step ${i + 1}`);

    axisGroup.call(timeAxis);
    axisGroup.selectAll("text").attr("fill", "#94a3b8").attr("font-size", 10);
    axisGroup.selectAll("line").attr("stroke", "#334155");
    axisGroup.select(".domain").attr("stroke", "#334155");

    // ── Vertical grid lines ──────────────────────────────────────────────
    const gridGroup = g.append("g").attr("class", "grid");
    const ticks = xScale.ticks(Math.min(Math.floor(innerWidth / 120), 12));
    for (const tick of ticks) {
      gridGroup
        .append("line")
        .attr("x1", xScale(tick))
        .attr("x2", xScale(tick))
        .attr("y1", 0)
        .attr("y2", laneCount * LANE_HEIGHT)
        .attr("stroke", "#1e293b")
        .attr("stroke-dasharray", "3,3");
    }

    // ── Place decision nodes ─────────────────────────────────────────────
    const nodesGroup = g.append("g").attr("class", "nodes");
    const edgesGroup = g.append("g").attr("class", "edges");

    for (const { decision, date } of decisionDates) {
      const laneIdx = laneMap.get(decision.sourceDoc ?? "Unknown source") ?? 0;
      const x = xScale(date);
      const y = laneIdx * LANE_HEIGHT + LANE_PADDING + 20;

      const label = truncate(decision.label, MAX_LABEL_LEN);
      const w = Math.max(label.length * CHAR_WIDTH + 24, NODE_WIDTH);

      // Decision node
      const nodeG = nodesGroup
        .append("g")
        .attr("transform", `translate(${x}, ${y})`)
        .attr("class", "timeline-node")
        .style("cursor", "pointer");

      nodeG
        .append("rect")
        .attr("rx", NODE_RX)
        .attr("ry", NODE_RX)
        .attr("width", w)
        .attr("height", NODE_HEIGHT)
        .attr("x", -w / 2)
        .attr("y", -NODE_HEIGHT / 2)
        .attr("fill", NODE_COLORS.decision + "1A")
        .attr("stroke", NODE_COLORS.decision)
        .attr("stroke-width", decision.id === selectedNodeId ? 3.5 : 2)
        .attr(
          "filter",
          decision.id === selectedNodeId
            ? "drop-shadow(0 0 6px rgba(99,102,241,0.6))"
            : "none",
        );

      // Kind dot
      nodeG
        .append("circle")
        .attr("cx", -w / 2 + 12)
        .attr("cy", 0)
        .attr("r", 3.5)
        .attr("fill", NODE_COLORS.decision);

      // Label
      nodeG
        .append("text")
        .text(label)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("x", 3)
        .attr("fill", NODE_COLORS.decision)
        .attr("font-size", FONT_SIZE)
        .attr("font-weight", 500);

      // Temporal order badge
      if (decision.temporalOrder != null) {
        nodeG
          .append("circle")
          .attr("cx", w / 2 - 2)
          .attr("cy", -NODE_HEIGHT / 2 + 2)
          .attr("r", 8)
          .attr("fill", "#6366f1")
          .attr("stroke", "#1e1b4b")
          .attr("stroke-width", 1.5);
        nodeG
          .append("text")
          .text(`#${decision.temporalOrder}`)
          .attr("x", w / 2 - 2)
          .attr("y", -NODE_HEIGHT / 2 + 2)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("fill", "#e0e7ff")
          .attr("font-size", 8)
          .attr("font-weight", 700);
      }

      // Click handler
      nodeG.on("click", () => {
        if (onNodeClick) onNodeClick(decision);
      });

      // Tooltip
      nodeG.append("title").text(() => {
        const parts = [decision.label, `Kind: ${decision.kind}`];
        if (decision.confidence != null)
          parts.push(`Confidence: ${(decision.confidence * 100).toFixed(0)}%`);
        if (decision.sourceDoc) parts.push(`Source: ${decision.sourceDoc}`);
        return parts.join("\n");
      });

      // ── Child nodes (options, chosen, rejected, rationale, risk) ──────
      const children = childrenOf.get(decision.id) ?? [];
      children.forEach(({ node: child, predicate }, ci) => {
        const childY = y + BRANCH_OFFSET_Y + ci * BRANCH_SPACING_Y;
        const childLabel = truncate(child.label, MAX_LABEL_LEN);
        const childW = Math.max(childLabel.length * CHAR_WIDTH + 24, 100);
        const color = NODE_COLORS[child.kind] ?? NODE_COLORS.concept;

        // Vertical connector line
        edgesGroup
          .append("path")
          .attr(
            "d",
            `M${x},${y + NODE_HEIGHT / 2} L${x},${childY - NODE_HEIGHT / 2}`,
          )
          .attr("stroke", "#475569")
          .attr("stroke-width", 1.2)
          .attr("stroke-dasharray", "4,2")
          .attr("fill", "none");

        // Predicate label on connector
        if (predicate) {
          edgesGroup
            .append("text")
            .text(
              PREDICATE_LABELS[predicate] ??
                predicate.toLowerCase().replace(/_/g, " "),
            )
            .attr("x", x + 6)
            .attr("y", (y + NODE_HEIGHT / 2 + childY - NODE_HEIGHT / 2) / 2)
            .attr("fill", "#475569")
            .attr("font-size", 9)
            .attr("dominant-baseline", "central");
        }

        // Child node
        const childG = nodesGroup
          .append("g")
          .attr("transform", `translate(${x}, ${childY})`)
          .attr("class", "timeline-node")
          .style("cursor", "pointer");

        childG
          .append("rect")
          .attr("rx", NODE_RX)
          .attr("ry", NODE_RX)
          .attr("width", childW)
          .attr("height", NODE_HEIGHT)
          .attr("x", -childW / 2)
          .attr("y", -NODE_HEIGHT / 2)
          .attr("fill", color + "1A")
          .attr("stroke", color)
          .attr("stroke-width", child.id === selectedNodeId ? 3.5 : 2)
          .attr(
            "filter",
            child.id === selectedNodeId
              ? "drop-shadow(0 0 6px rgba(99,102,241,0.6))"
              : "none",
          );

        childG
          .append("circle")
          .attr("cx", -childW / 2 + 12)
          .attr("cy", 0)
          .attr("r", 3)
          .attr("fill", color);

        childG
          .append("text")
          .text(childLabel)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("x", 3)
          .attr("fill", color)
          .attr("font-size", FONT_SIZE - 1)
          .attr("font-weight", 400);

        childG.on("click", () => {
          if (onNodeClick) onNodeClick(child);
        });

        childG.append("title").text(() => {
          const parts = [child.label, `Kind: ${child.kind}`];
          if (child.confidence != null)
            parts.push(`Confidence: ${(child.confidence * 100).toFixed(0)}%`);
          return parts.join("\n");
        });
      });
    }
  }, [data, selectedNodeId, onNodeClick]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-auto bg-slate-950"
    >
      <svg ref={svgRef} className="min-w-full" />
    </div>
  );
}
