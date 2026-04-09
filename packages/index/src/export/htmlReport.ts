// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 10.1 Architecture Report — HTML Renderer
 *
 * Generates a self-contained HTML file with an interactive D3.js-powered
 * layered architecture visualization. Two views:
 *   - Layers view:     files positioned in inferred tier bands
 *   - Violations view: same layout, only violation edges visible
 *
 * D3 v7 loaded from CDN. All data is embedded inline as JSON.
 */

import type { ArchReportData } from "../types.js";

/**
 * Render an ArchReportData payload to a self-contained HTML string.
 */
export function renderArchReportHtml(data: ArchReportData): string {
  const json = JSON.stringify(data);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Architecture Report</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"><\/script>
<style>
${CSS}
</style>
</head>
<body>
<header id="header">
  <h1>Architecture Report</h1>
  <div id="controls">
    <input type="text" id="search" placeholder="Search files…" autocomplete="off">
    <div class="btn-group">
      <button class="btn active" data-view="layers">Layers</button>
      <button class="btn" data-view="violations">Violations</button>
      <button class="btn" data-view="communities">Communities</button>
      <button class="btn" data-view="dependencies">Dependencies</button>
    </div>
    <label class="toggle"><input type="checkbox" id="show-imports" checked> Imports</label>
    <label class="toggle"><input type="checkbox" id="show-violations" checked> Violations</label>
    <label class="toggle"><input type="checkbox" id="aggregate"> Aggregate dirs</label>
    <label class="toggle"><input type="checkbox" id="show-docs" checked> Docs</label>
    <select id="dep-root" class="dep-select" style="display:none">
      <option value="">Select root…</option>
    </select>
    <button class="btn" id="toggle-findings">Findings ▾</button>
  </div>
  <div id="summary"></div>
</header>
<div id="legend"></div>
<div id="main-area">
  <div id="chart"></div>
  <div id="findings" class="findings-hidden">
    <div id="findings-content"></div>
  </div>
</div>
<div id="tooltip"></div>
<script>
const DATA = ${json};
${RENDER_SCRIPT}
<\/script>
</body>
</html>`;
}

// ─── CSS ────────────────────────────────────────────────────────────────────

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  background: #fff; color: #24292f; overflow: hidden;
}
#header {
  padding: 10px 20px; border-bottom: 1px solid #d0d7de;
  display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  background: #f6f8fa; z-index: 10; position: relative;
}
#header h1 { font-size: 16px; font-weight: 600; white-space: nowrap; }
#controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
#search {
  padding: 4px 10px; border: 1px solid #d0d7de; border-radius: 6px;
  font-size: 13px; width: 180px; outline: none;
}
#search:focus { border-color: #0969da; box-shadow: 0 0 0 3px rgba(9,105,218,.15); }
.btn-group { display: flex; gap: 0; }
.btn {
  padding: 4px 12px; font-size: 12px; border: 1px solid #d0d7de;
  background: #fff; cursor: pointer; color: #24292f;
}
.btn:first-child { border-radius: 6px 0 0 6px; }
.btn:last-child { border-radius: 0 6px 6px 0; border-left: 0; }
.btn.active { background: #0969da; color: #fff; border-color: #0969da; }
.toggle { font-size: 12px; cursor: pointer; user-select: none; white-space: nowrap; }
.toggle input { cursor: pointer; vertical-align: -1px; margin-right: 3px; }
#summary {
  margin-left: auto; font-size: 11px; color: #656d76;
  display: flex; gap: 14px; white-space: nowrap;
}
.summary-item { display: flex; align-items: center; gap: 4px; }
.summary-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
#main-area { display: flex; flex-direction: column; height: calc(100vh - 49px); }
#chart { width: 100%; flex: 1; min-height: 0; }
#findings {
  border-top: 2px solid #d0d7de; background: #f6f8fa;
  overflow-y: auto; transition: max-height 0.25s ease;
}
#findings.findings-hidden { max-height: 0; border-top: none; overflow: hidden; }
#findings.findings-visible { max-height: 45vh; }
#findings-content {
  padding: 16px 24px;
}
#findings h2 { font-size: 14px; font-weight: 600; margin: 0 0 10px 0; }
#findings h3 { font-size: 13px; font-weight: 600; margin: 16px 0 8px 0; color: #24292f; }
#findings h3:first-child { margin-top: 0; }
.finding-table {
  width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 12px;
}
.finding-table th {
  text-align: left; padding: 4px 10px; background: #e1e4e8;
  font-weight: 600; border-bottom: 1px solid #d0d7de;
}
.finding-table td {
  padding: 4px 10px; border-bottom: 1px solid #eef1f5;
  vertical-align: top;
}
.finding-table tr:hover { background: #ddf4ff; cursor: pointer; }
.finding-table tr.severity-high td:first-child,
.finding-table tr.severity-critical td:first-child {
  border-left: 3px solid #cf222e;
}
.finding-table tr.severity-boundary td:first-child {
  border-left: 3px solid #bf8700;
}
.finding-none { font-size: 12px; color: #8b949e; margin: 4px 0; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 10px;
  font-size: 10px; font-weight: 600; margin-right: 4px; }
.badge-red { background: #ffebe9; color: #cf222e; }
.badge-yellow { background: #fff8c5; color: #9a6700; }
.badge-gray { background: #eef1f5; color: #656d76; }
#toggle-findings { margin-left: 4px; }
#legend {
  position: fixed; bottom: 16px; right: 16px; background: #fff;
  border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px;
  font-size: 11px; z-index: 20; box-shadow: 0 2px 8px rgba(0,0,0,.08);
  max-height: 40vh; overflow-y: auto;
}
#legend h3 { font-size: 12px; margin-bottom: 6px; font-weight: 600; }
.legend-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.legend-swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
.legend-line { width: 20px; height: 0; border-top-width: 2px; border-top-style: solid; flex-shrink: 0; }
#tooltip {
  position: fixed; display: none; background: #fff; border: 1px solid #d0d7de;
  border-radius: 8px; padding: 10px 14px; font-size: 12px;
  box-shadow: 0 4px 12px rgba(0,0,0,.12); max-width: 380px;
  z-index: 100; pointer-events: none; line-height: 1.5;
}
#tooltip strong { font-size: 13px; }
#tooltip .path { color: #656d76; word-break: break-all; }
#tooltip .metric { color: #24292f; }
.edge-import { stroke: #bbb; stroke-width: 0.5; fill: none; opacity: 0.15; }
.edge-layer-violation { stroke: #cf222e; stroke-width: 1.5; fill: none; opacity: 0.8; }
.edge-boundary-violation { stroke: #bf8700; stroke-width: 1.5; fill: none; opacity: 0.8;
  stroke-dasharray: 5 3; }
.edge-co-occurrence { stroke: #59a14f; stroke-width: 0.8; fill: none; opacity: 0.25; }
.edge-co-change { stroke: #b07aa1; stroke-width: 0.8; fill: none; opacity: 0.25;
  stroke-dasharray: 3 2; }
.dep-select {
  padding: 4px 8px; font-size: 12px; border: 1px solid #d0d7de;
  border-radius: 6px; background: #fff; outline: none; max-width: 200px;
}
.dep-select:focus { border-color: #0969da; box-shadow: 0 0 0 3px rgba(9,105,218,.15); }
.node { cursor: pointer; transition: opacity 0.15s; }
.node:hover { filter: brightness(0.85); }
.node-doc { stroke-dasharray: 3 2; }
.node-label { font-size: 9px; fill: #656d76; pointer-events: none;
  text-anchor: middle; dominant-baseline: hanging; }
.isolated-badge {
  font-size: 11px; fill: #8b949e; cursor: default;
}
.agg-count { font-size: 8px; fill: #fff; pointer-events: none;
  text-anchor: middle; dominant-baseline: central; font-weight: 600; }
`;

// ─── D3 Rendering Script ────────────────────────────────────────────────────

const RENDER_SCRIPT = `
(function() {
  'use strict';

  // ── Colour scales ────────────────────────────────────────────────
  const COMMUNITY_COLORS = [
    '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
    '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'
  ];
  const commColor = (id) => id < 0 ? '#d0d7de' : COMMUNITY_COLORS[id % COMMUNITY_COLORS.length];

  // ── Layer display name helper (prefers LLM name when available) ──
  const _layerNameMap = new Map();
  for (const l of DATA.layers) {
    _layerNameMap.set(l.index, l.llmName || l.label);
  }
  function layerDisplayName(indexOrLabel, fallbackLabel) {
    if (typeof indexOrLabel === 'number') return _layerNameMap.get(indexOrLabel) || fallbackLabel || 'unknown';
    return fallbackLabel || indexOrLabel || 'unknown';
  }
  const hasLlmNames = DATA.layers.some(l => l.llmName);

  // ── Dimensions ───────────────────────────────────────────────────
  const chartEl = document.getElementById('chart');
  const W = chartEl.clientWidth;
  const H = chartEl.clientHeight;
  const MARGIN = { top: 50, right: 30, bottom: 30, left: 30 };
  const innerW = W - MARGIN.left - MARGIN.right;
  const innerH = H - MARGIN.top - MARGIN.bottom;

  // ── Isolated file count ──────────────────────────────────────────
  const layeredFiles = new Set();
  for (const layer of DATA.layers) {
    for (const n of DATA.nodes) {
      if (n.layerIndex === layer.index) layeredFiles.add(n.filePath);
    }
  }
  // Files assigned to layer 0 with label "unknown" are isolated
  const isolatedCount = DATA.nodes.filter(n => n.layerLabel === 'unknown').length;

  // ── Summary ──────────────────────────────────────────────────────
  const sumEl = document.getElementById('summary');
  sumEl.innerHTML = [
    '<span class="summary-item">' + DATA.meta.totalFiles + ' files</span>',
    '<span class="summary-item">' + DATA.summary.totalLayers + ' layers</span>',
    '<span class="summary-item">' + DATA.summary.totalCommunities + ' communities</span>',
    isolatedCount > 0
      ? '<span class="summary-item"><span class="summary-dot" style="background:#d0d7de"></span>' +
        isolatedCount + ' isolated</span>'
      : '',
    DATA.summary.layerViolations > 0
      ? '<span class="summary-item"><span class="summary-dot" style="background:#cf222e"></span>' +
        DATA.summary.layerViolations + ' layer violations</span>'
      : '',
    DATA.summary.boundaryViolations > 0
      ? '<span class="summary-item"><span class="summary-dot" style="background:#bf8700"></span>' +
        DATA.summary.boundaryViolations + ' boundary violations</span>'
      : '',
  ].filter(Boolean).join('');

  // ── Legend ───────────────────────────────────────────────────────
  const legendEl = document.getElementById('legend');

  function updateLegend() {
    const html = [];

    if (currentView === 'communities') {
      html.push('<h3>Communities</h3>');
      for (const c of DATA.communities) {
        html.push(
          '<div class="legend-row"><span class="legend-swatch" style="background:' +
          commColor(c.id) + '"></span>' + c.label + ' (' + c.size + ')</div>'
        );
      }
      html.push('<h3 style="margin-top:8px">Node types</h3>');
      html.push('<div class="legend-row"><span class="legend-swatch" style="background:#4e79a7;border-radius:50%"></span>Source file</div>');
      html.push('<div class="legend-row"><span class="legend-swatch" style="background:#f0e6ff;border:1.5px dashed #8b5cf6;border-radius:50%"></span>Documentation</div>');
      html.push('<h3 style="margin-top:8px">Edges</h3>');
      html.push('<div class="legend-row"><span class="legend-line" style="border-color:#bbb"></span>Import</div>');
      html.push('<div class="legend-row"><span class="legend-line" style="border-color:#59a14f"></span>Doc-code link</div>');
      html.push('<div class="legend-row"><span class="legend-line" style="border-color:#b07aa1;border-top-style:dashed"></span>Git co-change</div>');
      html.push('<h3 style="margin-top:8px">Node size</h3>');
      html.push('<div class="legend-row">∝ hub degree</div>');
    } else if (currentView === 'dependencies') {
      html.push('<h3>Risk level</h3>');
      html.push('<div class="legend-row"><span class="legend-swatch" style="background:#59a14f"></span>Low</div>');
      html.push('<div class="legend-row"><span class="legend-swatch" style="background:#edc948"></span>Medium</div>');
      html.push('<div class="legend-row"><span class="legend-swatch" style="background:#e15759"></span>High</div>');
      html.push('<div class="legend-row"><span class="legend-swatch" style="background:#cf222e"></span>Critical</div>');
      html.push('<h3 style="margin-top:8px">Node size</h3>');
      html.push('<div class="legend-row">∝ import depth</div>');
    } else {
      html.push('<h3>Communities</h3>');
      for (const c of DATA.communities) {
        html.push(
          '<div class="legend-row"><span class="legend-swatch" style="background:' +
          commColor(c.id) + '"></span>' + c.label + ' (' + c.size + ')</div>'
        );
      }
      html.push('<h3 style="margin-top:8px">Edges</h3>');
      html.push('<div class="legend-row"><span class="legend-line" style="border-color:#bbb"></span>Import</div>');
      html.push('<div class="legend-row"><span class="legend-line" style="border-color:#cf222e"></span>Layer violation</div>');
      html.push('<div class="legend-row"><span class="legend-line" style="border-color:#bf8700;border-top-style:dashed"></span>Boundary violation</div>');
      html.push('<h3 style="margin-top:8px">Node size</h3>');
      html.push('<div class="legend-row">∝ transitive dependents</div>');
      if (hasLlmNames) {
        html.push('<h3 style="margin-top:8px">Layers</h3>');
        for (const l of DATA.layers) {
          if (l.llmName) {
            html.push('<div class="legend-row" title="' + (l.description || '') + '">#' + l.index + ' ' + l.llmName + '</div>');
          }
        }
      }
    }

    legendEl.innerHTML = html.join('');
  }

  // ── Directory aggregation helpers ────────────────────────────────
  // Compute parent directory (1 level above file)
  function parentDir(filePath) {
    const parts = filePath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
  }

  // Build aggregated nodes: group files by parent directory within the same layer
  function buildAggregated() {
    const groups = new Map(); // key: "layerIndex|dir" → { files: [], ... }
    for (const n of DATA.nodes) {
      const dir = parentDir(n.filePath);
      const key = n.layerIndex + '|' + dir;
      if (!groups.has(key)) {
        groups.set(key, { dir, layerIndex: n.layerIndex, files: [],
          totalDependents: 0, maxDepth: 0, hubDegree: 0,
          communityVotes: new Map(), risks: [] });
      }
      const g = groups.get(key);
      g.files.push(n);
      g.totalDependents += n.transitiveDependents;
      g.maxDepth = Math.max(g.maxDepth, n.maxDepth);
      g.hubDegree = Math.max(g.hubDegree, n.hubDegree);
      g.risks.push(n.risk);
      const cv = g.communityVotes.get(n.communityId) || 0;
      g.communityVotes.set(n.communityId, cv + 1);
    }

    const aggNodes = [];
    for (const [key, g] of groups) {
      // Majority community
      let bestComm = -1, bestCount = 0;
      for (const [cid, cnt] of g.communityVotes) {
        if (cnt > bestCount) { bestComm = cid; bestCount = cnt; }
      }
      const commLabel = g.files[0] ? g.files[0].communityLabel : 'ungrouped';
      const worstRisk = g.risks.includes('critical') ? 'critical' :
        g.risks.includes('high') ? 'high' :
        g.risks.includes('medium') ? 'medium' : 'low';
      aggNodes.push({
        id: key,
        filePath: g.dir,
        fileName: g.dir.split('/').pop() || g.dir,
        layerIndex: g.layerIndex,
        layerLabel: g.files[0].layerLabel,
        communityId: bestComm,
        communityLabel: commLabel,
        transitiveDependents: g.totalDependents,
        maxDepth: g.maxDepth,
        risk: worstRisk,
        hubDegree: g.hubDegree,
        fileCount: g.files.length,
        childPaths: g.files.map(f => f.filePath),
        isDoc: g.files.every(f => f.isDoc),
        _isAgg: true
      });
    }

    // Build aggregated edges: merge file-level edges into dir-level
    const edgeMap = new Map(); // "srcDir|tgtDir|type" → count
    const fileToAgg = new Map();
    for (const an of aggNodes) {
      for (const fp of an.childPaths) fileToAgg.set(fp, an.id);
    }
    const aggEdges = [];
    for (const e of DATA.edges) {
      const srcId = fileToAgg.get(e.source);
      const tgtId = fileToAgg.get(e.target);
      if (!srcId || !tgtId || srcId === tgtId) continue;
      const ekey = srcId + '|' + tgtId + '|' + e.type;
      if (!edgeMap.has(ekey)) {
        edgeMap.set(ekey, 0);
        aggEdges.push({ source: srcId, target: tgtId, type: e.type,
          violationType: e.violationType, reason: e.reason });
      }
      edgeMap.set(ekey, edgeMap.get(ekey) + 1);
    }

    // Build aggregated co-edges: merge file-level co-edges into dir-level
    const coEdgeMap = new Map();
    const aggCoEdges = [];
    for (const e of DATA.coEdges) {
      const srcId = fileToAgg.get(e.source);
      const tgtId = fileToAgg.get(e.target);
      if (!srcId || !tgtId || srcId === tgtId) continue;
      const ekey = srcId + '|' + tgtId + '|' + e.type;
      if (!coEdgeMap.has(ekey)) {
        coEdgeMap.set(ekey, { count: 0, totalWeight: 0 });
        aggCoEdges.push({ source: srcId, target: tgtId, type: e.type, weight: 0 });
      }
      const entry = coEdgeMap.get(ekey);
      entry.count++;
      entry.totalWeight += (e.weight || 0.5);
    }
    // Set averaged weights
    for (const ace of aggCoEdges) {
      const ekey = ace.source + '|' + ace.target + '|' + ace.type;
      const entry = coEdgeMap.get(ekey);
      ace.weight = entry.totalWeight / entry.count;
    }

    return { nodes: aggNodes, edges: aggEdges, coEdges: aggCoEdges };
  }

  // ── Layout engine ───────────────────────────────────────────────
  const NODE_SPACING = 28;
  const ROW_HEIGHT = 28;
  const PAD = 20;
  const availW = innerW - 2 * PAD;

  function layoutNodes(nodes) {
    const nodesPerRow = Math.max(1, Math.floor(availW / NODE_SPACING));

    // Group nodes by layer
    const byLayer = new Map();
    for (const n of nodes) {
      if (!byLayer.has(n.layerIndex)) byLayer.set(n.layerIndex, []);
      byLayer.get(n.layerIndex).push(n);
    }

    // Compute each layer's height based on row count
    const heights = new Map();
    let totalH = 0;
    for (const layer of DATA.layers) {
      const lnodes = byLayer.get(layer.index) || [];
      const rows = Math.max(1, Math.ceil(lnodes.length / nodesPerRow));
      const h = Math.max(50, rows * ROW_HEIGHT + 30);
      heights.set(layer.index, h);
      totalH += h;
    }

    const scale = totalH > 0 ? Math.max(1, innerH / totalH) : 1;

    // Compute cumulative Y positions (highest layer at top)
    const yMap = new Map();
    let cumY = MARGIN.top;
    const sorted = [...DATA.layers].sort((a, b) => b.index - a.index);
    for (const layer of sorted) {
      const h = (heights.get(layer.index) || 50) * scale;
      yMap.set(layer.index, { y: cumY, h });
      cumY += h;
    }

    // Position nodes within layers
    for (const [layerIdx, layerNodes] of byLayer) {
      layerNodes.sort((a, b) => a.communityId - b.communityId ||
        a.filePath.localeCompare(b.filePath));
      const count = layerNodes.length;
      const cols = Math.min(count, nodesPerRow);
      const colSpacing = cols > 1 ? Math.min(NODE_SPACING, availW / (cols - 1)) : 0;
      const startX = MARGIN.left + PAD + (availW - colSpacing * (cols - 1)) / 2;
      const lInfo = yMap.get(layerIdx) || { y: MARGIN.top, h: 50 };
      const rows = Math.ceil(count / cols);
      const startYOff = (lInfo.h - rows * ROW_HEIGHT) / 2 + ROW_HEIGHT / 2 + 10;

      layerNodes.forEach((n, i) => {
        n._x = startX + (i % cols) * colSpacing;
        n._y = lInfo.y + startYOff + Math.floor(i / cols) * ROW_HEIGHT;
      });
    }

    return { yMap, heights, scale };
  }

  // ── Rendering state ──────────────────────────────────────────────
  let currentNodes = DATA.nodes;
  let currentEdges = DATA.edges;
  let isAggregated = false;
  let currentZoom = 1;
  let currentView = 'layers';
  let layoutInfo = null;

  updateLegend();

  // Pre-build aggregated data
  const aggData = buildAggregated();

  // ── SVG setup ────────────────────────────────────────────────────
  const svg = d3.select('#chart').append('svg')
    .attr('width', W).attr('height', H);

  const g = svg.append('g');

  // Invisible background rect to capture clicks on empty space
  const bgRect = g.append('rect')
    .attr('width', W * 4).attr('height', H * 4)
    .attr('x', -W).attr('y', -H)
    .attr('fill', 'transparent')
    .style('pointer-events', 'all');

  bgRect.on('click', function() { resetHighlights(); });

  const layerG = g.append('g').attr('class', 'layers');
  const edgeG = g.append('g').attr('class', 'edges');
  const nodeG = g.append('g').attr('class', 'nodes');
  const labelG = g.append('g').attr('class', 'labels');

  // ── Central reset function ───────────────────────────────────────
  function resetHighlights() {
    nodeG.selectAll('circle')
      .attr('opacity', 1)
      .attr('stroke', function(d) {
        return (d.risk === 'high' || d.risk === 'critical') ? '#cf222e' : '#fff';
      })
      .attr('stroke-width', function(d) {
        return (d.risk === 'high' || d.risk === 'critical') ? 2 : 1;
      });
    labelG.selectAll('.node-label').attr('opacity', 1);
    applyEdgeFilters();
  }

  svg.call(d3.zoom()
    .scaleExtent([0.15, 8])
    .on('zoom', (e) => {
      g.attr('transform', e.transform);
      currentZoom = e.transform.k;
      updateLabels();
    }));

  // ── Edge path helper ─────────────────────────────────────────────
  function edgePath(s, t) {
    if (!s || !t) return null;
    const dy = t._y - s._y;
    if (Math.abs(dy) < 5) {
      return 'M' + s._x + ',' + s._y + ' L' + t._x + ',' + t._y;
    }
    const cy1 = s._y + dy * 0.35;
    const cy2 = t._y - dy * 0.35;
    return 'M' + s._x + ',' + s._y +
      ' C' + s._x + ',' + cy1 + ' ' + t._x + ',' + cy2 + ' ' + t._x + ',' + t._y;
  }

  function classForEdge(e) {
    if (e.type === 'layer-violation') return 'edge-layer-violation';
    if (e.type === 'boundary-violation') return 'edge-boundary-violation';
    if (e.type === 'co-occurrence') return 'edge-co-occurrence';
    if (e.type === 'co-change') return 'edge-co-change';
    return 'edge-import';
  }

  // ── Node radius helper ───────────────────────────────────────────
  function nodeRadius(d) {
    if (d._isAgg) {
      return Math.max(6, Math.min(22, 6 + Math.sqrt(d.fileCount) * 2.5));
    }
    if (currentView === 'communities') {
      return Math.max(3, Math.min(16, 3 + Math.sqrt(d.hubDegree) * 1.2));
    }
    if (currentView === 'dependencies') {
      return Math.max(3, Math.min(14, 3 + Math.sqrt(d.maxDepth) * 1.5));
    }
    return Math.max(3, Math.min(14, 3 + Math.sqrt(d.transitiveDependents) * 1.5));
  }

  // ── Risk color helper ────────────────────────────────────────────
  const RISK_COLORS = { low: '#59a14f', medium: '#edc948', high: '#e15759', critical: '#cf222e' };

  function nodeColor(d) {
    if (currentView === 'dependencies') return RISK_COLORS[d.risk] || RISK_COLORS.low;
    return commColor(d.communityId);
  }

  function nodeStroke(d) {
    if (currentView === 'dependencies') return '#fff';
    return (d.risk === 'high' || d.risk === 'critical') ? '#cf222e' : '#fff';
  }

  function nodeStrokeWidth(d) {
    if (currentView === 'dependencies') return 1;
    return (d.risk === 'high' || d.risk === 'critical') ? 2 : 1;
  }

  // ── Tooltip ──────────────────────────────────────────────────────
  const tooltipEl = document.getElementById('tooltip');

  function showTooltip(event, d) {
    let html;
    var lName = layerDisplayName(d.layerIndex, d.layerLabel);
    if (d._isAgg) {
      var dirInfo = DATA.directoryNames && DATA.directoryNames[d.filePath];
      var dirTitle = dirInfo ? '<strong>' + dirInfo.name + '</strong>' : '<strong>' + d.fileName + '/</strong>';
      var dirDesc = dirInfo ? '<span class="metric" style="font-style:italic">' + dirInfo.description + '</span><br>' : '';
      html =
        dirTitle + ' (' + d.fileCount + ' files)<br>' +
        '<span class="path">' + d.filePath + '</span><br>' +
        dirDesc + '<br>' +
        '<span class="metric">Layer: ' + lName + ' (#' + d.layerIndex + ')</span><br>' +
        '<span class="metric">Community: ' + d.communityLabel + '</span><br>' +
        '<span class="metric">Total dependents: ' + d.transitiveDependents +
        ' · Max depth: ' + d.maxDepth + '</span><br>' +
        '<span class="metric">Worst risk: ' + d.risk + '</span><br>' +
        '<span class="metric" style="margin-top:4px;display:block;color:#8b949e">' +
        d.childPaths.slice(0, 8).map(function(p) { return p.split('/').pop(); }).join(', ') +
        (d.childPaths.length > 8 ? ' …+' + (d.childPaths.length - 8) : '') + '</span>';
    } else if (currentView === 'dependencies') {
      html =
        '<strong>' + d.fileName + '</strong><br>' +
        '<span class="path">' + d.filePath + '</span><br><br>' +
        '<span class="metric">Depth: ' + d.maxDepth + ' · Risk: ' + d.risk + '</span><br>' +
        '<span class="metric">Dependents: ' + d.transitiveDependents + '</span><br>' +
        '<span class="metric">Layer: ' + lName + '</span>';
    } else if (currentView === 'communities') {
      var typeLabel = d.isDoc ? '📄 Documentation' : '💻 Source';
      html =
        '<strong>' + d.fileName + '</strong> <span class="metric">(' + typeLabel + ')</span><br>' +
        '<span class="path">' + d.filePath + '</span><br><br>' +
        '<span class="metric">Community: ' + d.communityLabel + '</span><br>' +
        '<span class="metric">Hub degree: ' + d.hubDegree + '</span><br>' +
        '<span class="metric">Dependents: ' + d.transitiveDependents +
        ' · Depth: ' + d.maxDepth + '</span>';
    } else {
      html =
        '<strong>' + d.fileName + '</strong><br>' +
        '<span class="path">' + d.filePath + '</span><br><br>' +
        '<span class="metric">Layer: ' + lName + ' (#' + d.layerIndex + ')</span><br>' +
        '<span class="metric">Community: ' + d.communityLabel + '</span><br>' +
        '<span class="metric">Depth: ' + d.maxDepth + ' · Dependents: ' + d.transitiveDependents + '</span><br>' +
        '<span class="metric">Risk: ' + d.risk + ' · Hub degree: ' + d.hubDegree + '</span>';
    }
    tooltipEl.innerHTML = html;
    tooltipEl.style.display = 'block';
    positionTooltip(event);
  }

  function positionTooltip(event) {
    let x = event.clientX + 14;
    let y = event.clientY + 14;
    if (x + 380 > window.innerWidth) x = event.clientX - 390;
    if (y + 200 > window.innerHeight) y = event.clientY - 210;
    tooltipEl.style.left = Math.max(0, x) + 'px';
    tooltipEl.style.top = Math.max(0, y) + 'px';
  }

  // ── Label visibility based on zoom ───────────────────────────────
  function updateLabels() {
    labelG.selectAll('.node-label')
      .attr('display', currentZoom >= 1.2 ? null : 'none');
  }

  // ── Full render (Layers / Violations) ──────────────────────────
  function renderLayers() {
    layoutInfo = layoutNodes(currentNodes);
    const { yMap } = layoutInfo;

    // Node lookup for edges
    const nMap = new Map();
    const idField = isAggregated ? 'id' : 'filePath';
    for (const n of currentNodes) nMap.set(n[idField], n);

    // ── Layer bands
    layerG.selectAll('*').remove();
    layerG.selectAll('.layer-band')
      .data(DATA.layers)
      .join('rect')
      .attr('x', MARGIN.left)
      .attr('width', innerW)
      .attr('y', d => (yMap.get(d.index) || {y:0}).y)
      .attr('height', d => (yMap.get(d.index) || {h:50}).h)
      .attr('fill', (_, i) => i % 2 === 0 ? '#f6f8fa' : '#eef1f5')
      .attr('stroke', '#e1e4e8')
      .attr('stroke-width', 0.5)
      .attr('rx', 4);

    layerG.selectAll('.layer-label')
      .data(DATA.layers)
      .join('text')
      .attr('x', MARGIN.left + 8)
      .attr('y', d => (yMap.get(d.index) || {y:0}).y + 16)
      .text(d => {
        var name = d.llmName || d.label;
        return name + ' (' + d.fileCount + ')';
      })
      .attr('fill', '#8b949e')
      .attr('font-size', '11px')
      .attr('font-weight', 500);

    // Layer description subtitle (5.1c)
    if (hasLlmNames) {
      layerG.selectAll('.layer-desc')
        .data(DATA.layers.filter(d => d.description))
        .join('text')
        .attr('class', 'layer-desc')
        .attr('x', MARGIN.left + 8)
        .attr('y', d => (yMap.get(d.index) || {y:0}).y + 28)
        .text(d => d.description)
        .attr('fill', '#adb5bd')
        .attr('font-size', '9px')
        .attr('font-style', 'italic');
    }

    if (isolatedCount > 0) {
      const lastLayer = DATA.layers.reduce((a, b) => a.index < b.index ? a : b, DATA.layers[0]);
      const lastInfo = yMap.get(lastLayer ? lastLayer.index : 0) || { y: MARGIN.top, h: 50 };
      const isoY = lastInfo.y + lastInfo.h + 20;
      layerG.append('text')
        .attr('class', 'isolated-badge')
        .attr('x', W / 2)
        .attr('y', isoY)
        .attr('text-anchor', 'middle')
        .text(isolatedCount + ' isolated files (no import edges)');
    }

    drawEdgesAndNodes(currentEdges, nMap);
  }

  // ── Communities view: force-directed layout ──────────────────────
  let simulation = null;

  function renderCommunities() {
    if (simulation) { simulation.stop(); simulation = null; }
    layerG.selectAll('*').remove();
    edgeG.selectAll('*').remove();
    nodeG.selectAll('*').remove();
    labelG.selectAll('*').remove();

    var showDocs = showDocsEl.checked;

    // Choose data source based on aggregation toggle
    var sourceNodes = isAggregated ? aggData.nodes : DATA.nodes;
    var sourceEdges = isAggregated ? aggData.edges : DATA.edges;
    var sourceCoEdges = isAggregated ? aggData.coEdges : DATA.coEdges;
    var idField = isAggregated ? 'id' : 'filePath';

    // Filter docs if toggle is off
    var filteredNodes = showDocs ? sourceNodes : sourceNodes.filter(function(n) { return !n.isDoc; });

    // Build node map
    var nodeMap = new Map();
    for (var i = 0; i < filteredNodes.length; i++) {
      var n = filteredNodes[i];
      nodeMap.set(n[idField] || n.filePath, n);
    }

    // Collect all edge endpoints to determine which nodes participate
    var coNodeIds = new Set();
    for (var i = 0; i < sourceCoEdges.length; i++) {
      var e = sourceCoEdges[i];
      if (e.source !== e.target) { coNodeIds.add(e.source); coNodeIds.add(e.target); }
    }
    for (var i = 0; i < sourceEdges.length; i++) {
      var e = sourceEdges[i];
      if (e.type === 'import' && e.source !== e.target) {
        coNodeIds.add(e.source); coNodeIds.add(e.target);
      }
    }

    // Build simulation nodes
    var simNodes = [];
    var simNodeMap = new Map();
    for (var id of coNodeIds) {
      var fileNode = nodeMap.get(id);
      if (!fileNode) continue;
      var node = Object.assign({}, fileNode, { _simId: id });
      simNodes.push(node);
      simNodeMap.set(id, node);
    }

    // Build simulation links (deduplicated)
    var simLinks = [];
    var linkSet = new Set();
    for (var i = 0; i < sourceCoEdges.length; i++) {
      var e = sourceCoEdges[i];
      if (e.source === e.target) continue;
      if (simNodeMap.has(e.source) && simNodeMap.has(e.target)) {
        var key = (e.source < e.target ? e.source + '|' + e.target : e.target + '|' + e.source) + '|' + e.type;
        if (!linkSet.has(key)) {
          linkSet.add(key);
          simLinks.push({ source: e.source, target: e.target, type: e.type, weight: e.weight || 0.5 });
        }
      }
    }
    for (var i = 0; i < sourceEdges.length; i++) {
      var e = sourceEdges[i];
      if (e.type !== 'import' || e.source === e.target) continue;
      if (simNodeMap.has(e.source) && simNodeMap.has(e.target)) {
        var key = (e.source < e.target ? e.source + '|' + e.target : e.target + '|' + e.source) + '|import';
        if (!linkSet.has(key)) {
          linkSet.add(key);
          simLinks.push({ source: e.source, target: e.target, type: 'import', weight: 1 });
        }
      }
    }

    const cx = W / 2;
    const cy = H / 2;

    // Initialise positions randomly
    simNodes.forEach(function(n) {
      n.x = cx + (Math.random() - 0.5) * W * 0.6;
      n.y = cy + (Math.random() - 0.5) * H * 0.6;
    });

    // D3 force simulation
    simulation = d3.forceSimulation(simNodes)
      .force('link', d3.forceLink(simLinks).id(function(d) { return d._simId; })
        .distance(function(d) { return d.weight > 0.5 ? 40 : 80; })
        .strength(function(d) { return Math.min(0.8, d.weight); }))
      .force('charge', d3.forceManyBody().strength(-60).distanceMax(300))
      .force('center', d3.forceCenter(cx, cy))
      .force('collide', d3.forceCollide().radius(function(d) { return nodeRadius(d) + 2; }))
      .alphaDecay(0.03);

    // Draw links
    const links = edgeG.selectAll('line')
      .data(simLinks)
      .join('line')
      .attr('class', classForEdge)
      .attr('stroke-width', function(d) { return Math.max(0.5, d.weight * 2); });

    // Draw nodes — doc files get dashed stroke + lighter fill
    const DOC_FILL = '#f0e6ff';
    const circles = nodeG.selectAll('circle')
      .data(simNodes)
      .join('circle')
      .attr('class', function(d) { return d.isDoc ? 'node node-doc' : 'node'; })
      .attr('r', nodeRadius)
      .attr('fill', function(d) { return d.isDoc ? DOC_FILL : commColor(d.communityId); })
      .attr('stroke', function(d) { return d.isDoc ? '#8b5cf6' : '#fff'; })
      .attr('stroke-width', function(d) { return d.isDoc ? 1.5 : 1; })
      .call(d3.drag()
        .on('start', function(event, d) {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', function(event, d) {
          d.fx = event.x; d.fy = event.y;
        })
        .on('end', function(event, d) {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        }));

    const labels = labelG.selectAll('.node-label')
      .data(simNodes)
      .join('text')
      .attr('class', 'node-label')
      .text(function(d) {
        if (d._isAgg && DATA.directoryNames && DATA.directoryNames[d.filePath]) {
          return DATA.directoryNames[d.filePath].name + ' (#' + d.layerIndex + ')';
        }
        return d._isAgg ? d.fileName + '/ (#' + d.layerIndex + ')' : d.fileName;
      })
      .attr('display', currentZoom >= 1.2 ? null : 'none');

    // Interactions
    circles.on('mouseenter', function(event, d) {
      showTooltip(event, d);
      links.attr('opacity', function(l) {
        return (l.source._simId === d._simId || l.target._simId === d._simId) ? 1 : 0.03;
      }).attr('stroke-width', function(l) {
        return (l.source._simId === d._simId || l.target._simId === d._simId) ? 2.5 : null;
      });
    });
    circles.on('mousemove', positionTooltip);
    circles.on('mouseleave', function() {
      tooltipEl.style.display = 'none';
      links.attr('opacity', null).attr('stroke-width', function(d) {
        return Math.max(0.5, d.weight * 2);
      });
    });

    simulation.on('tick', function() {
      links
        .attr('x1', function(d) { return d.source.x; })
        .attr('y1', function(d) { return d.source.y; })
        .attr('x2', function(d) { return d.target.x; })
        .attr('y2', function(d) { return d.target.y; });
      circles
        .attr('cx', function(d) { return d.x; })
        .attr('cy', function(d) { return d.y; });
      labels
        .attr('x', function(d) { return d.x; })
        .attr('y', function(d) { return d.y + nodeRadius(d) + 3; });
    });

  }

  // ── Dependencies view: radial tree from selected root ────────────
  function renderDependencies(rootPath) {
    if (simulation) { simulation.stop(); simulation = null; }
    layerG.selectAll('*').remove();
    edgeG.selectAll('*').remove();
    nodeG.selectAll('*').remove();
    labelG.selectAll('*').remove();

    if (!rootPath) {
      layerG.append('text')
        .attr('x', W / 2).attr('y', H / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#8b949e')
        .attr('font-size', '14px')
        .text('Select a root file to explore its dependency tree.');
      return;
    }

    // BFS from root following import edges (forward = dependencies)
    const forward = new Map();
    for (const e of DATA.edges) {
      if (e.type !== 'import') continue;
      if (!forward.has(e.source)) forward.set(e.source, []);
      forward.get(e.source).push(e.target);
    }

    // Build tree via BFS
    const visited = new Set();
    const treeNodes = [];
    const treeEdges = [];
    const queue = [{ path: rootPath, depth: 0, parent: null }];
    visited.add(rootPath);

    while (queue.length > 0) {
      const { path, depth, parent } = queue.shift();
      treeNodes.push({ path, depth, parent });
      if (parent !== null) {
        treeEdges.push({ source: parent, target: path });
      }
      const children = forward.get(path) || [];
      for (const child of children) {
        if (!visited.has(child)) {
          visited.add(child);
          queue.push({ path: child, depth: depth + 1, parent: path });
        }
      }
    }

    if (treeNodes.length <= 1) {
      layerG.append('text')
        .attr('x', W / 2).attr('y', H / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#8b949e')
        .attr('font-size', '14px')
        .text(rootPath.split('/').pop() + ' has no import dependencies.');
      return;
    }

    // Build D3 hierarchy
    const nodeMap = new Map();
    for (const tn of treeNodes) nodeMap.set(tn.path, { name: tn.path, children: [] });
    for (const tn of treeNodes) {
      if (tn.parent !== null) {
        const parentNode = nodeMap.get(tn.parent);
        if (parentNode) parentNode.children.push(nodeMap.get(tn.path));
      }
    }
    const rootNode = nodeMap.get(rootPath);
    const hierarchy = d3.hierarchy(rootNode);

    // Radial tree layout
    const radius = Math.min(W, H) / 2 - 80;
    const treeLayout = d3.tree()
      .size([2 * Math.PI, radius])
      .separation(function(a, b) { return (a.parent === b.parent ? 1 : 2) / a.depth; });

    treeLayout(hierarchy);

    const cx = W / 2;
    const cy = H / 2;

    // File node lookup for styling
    const fileNodeMap = new Map();
    for (const n of DATA.nodes) fileNodeMap.set(n.filePath, n);

    // Draw links
    edgeG.selectAll('path')
      .data(hierarchy.links())
      .join('path')
      .attr('class', 'edge-import')
      .attr('opacity', 0.4)
      .attr('stroke-width', 1)
      .attr('d', d3.linkRadial()
        .angle(function(d) { return d.x; })
        .radius(function(d) { return d.y; }))
      .attr('transform', 'translate(' + cx + ',' + cy + ')');

    // Draw nodes
    const descendants = hierarchy.descendants();
    const circles = nodeG.selectAll('circle')
      .data(descendants)
      .join('circle')
      .attr('class', 'node')
      .attr('cx', function(d) { return cx + d.y * Math.cos(d.x - Math.PI / 2); })
      .attr('cy', function(d) { return cy + d.y * Math.sin(d.x - Math.PI / 2); })
      .attr('r', function(d) {
        var fn = fileNodeMap.get(d.data.name);
        return fn ? Math.max(3, Math.min(14, 3 + Math.sqrt(fn.maxDepth) * 1.5)) : 4;
      })
      .attr('fill', function(d) {
        var fn = fileNodeMap.get(d.data.name);
        return fn ? (RISK_COLORS[fn.risk] || RISK_COLORS.low) : '#d0d7de';
      })
      .attr('stroke', '#fff')
      .attr('stroke-width', function(d) { return d.depth === 0 ? 3 : 1; });

    // Labels
    labelG.selectAll('.node-label')
      .data(descendants)
      .join('text')
      .attr('class', 'node-label')
      .attr('x', function(d) { return cx + d.y * Math.cos(d.x - Math.PI / 2); })
      .attr('y', function(d) {
        var fn = fileNodeMap.get(d.data.name);
        var r = fn ? Math.max(3, Math.min(14, 3 + Math.sqrt(fn.maxDepth) * 1.5)) : 4;
        return cy + d.y * Math.sin(d.x - Math.PI / 2) + r + 3;
      })
      .text(function(d) { return d.data.name.split('/').pop(); })
      .attr('display', currentZoom >= 1.5 ? null : 'none');

    // Root label always visible
    labelG.append('text')
      .attr('class', 'node-label')
      .attr('x', cx)
      .attr('y', cy + 18)
      .attr('fill', '#24292f')
      .attr('font-weight', '600')
      .attr('font-size', '11px')
      .attr('display', null)
      .text(rootPath.split('/').pop());

    // Interactions
    circles.on('mouseenter', function(event, d) {
      var fn = fileNodeMap.get(d.data.name) || {
        fileName: d.data.name.split('/').pop(), filePath: d.data.name,
        maxDepth: d.depth, risk: 'low', transitiveDependents: 0, layerLabel: '', hubDegree: 0,
        communityLabel: ''
      };
      fn.filePath = d.data.name;
      fn.fileName = d.data.name.split('/').pop();
      showTooltip(event, fn);
    });
    circles.on('mousemove', positionTooltip);
    circles.on('mouseleave', function() { tooltipEl.style.display = 'none'; });

    // Click a node to re-root the tree
    circles.on('click', function(event, d) {
      event.stopPropagation();
      depRootEl.value = d.data.name;
      renderDependencies(d.data.name);
    });
  }

  // ── Shared edge + node drawing for layer views ───────────────────
  function drawEdgesAndNodes(edges, nMap) {
    edgeG.selectAll('*').remove();
    const paths = edgeG.selectAll('path')
      .data(edges)
      .join('path')
      .attr('d', d => edgePath(nMap.get(d.source), nMap.get(d.target)))
      .attr('class', classForEdge);

    nodeG.selectAll('*').remove();
    const circles = nodeG.selectAll('circle')
      .data(currentNodes)
      .join('circle')
      .attr('class', 'node')
      .attr('cx', d => d._x)
      .attr('cy', d => d._y)
      .attr('r', nodeRadius)
      .attr('fill', d => nodeColor(d))
      .attr('stroke', d => nodeStroke(d))
      .attr('stroke-width', d => nodeStrokeWidth(d));

    if (isAggregated) {
      nodeG.selectAll('.agg-count')
        .data(currentNodes.filter(d => d.fileCount > 1))
        .join('text')
        .attr('class', 'agg-count')
        .attr('x', d => d._x)
        .attr('y', d => d._y)
        .text(d => d.fileCount);
    }

    labelG.selectAll('*').remove();
    labelG.selectAll('.node-label')
      .data(currentNodes)
      .join('text')
      .attr('class', 'node-label')
      .attr('x', d => d._x)
      .attr('y', d => d._y + nodeRadius(d) + 3)
      .text(d => {
        if (d._isAgg && DATA.directoryNames && DATA.directoryNames[d.filePath]) {
          return DATA.directoryNames[d.filePath].name;
        }
        return d._isAgg ? d.fileName + '/' : d.fileName;
      })
      .attr('display', currentZoom >= 1.2 ? null : 'none');

    circles.on('mouseenter', function(event, d) {
      showTooltip(event, d);
      const key = isAggregated ? d.id : d.filePath;
      paths.attr('opacity', function(e) {
        if (e.source === key || e.target === key) return 1;
        return this.classList.contains('edge-import') ? 0.03 : 0.1;
      }).attr('stroke-width', function(e) {
        if (e.source === key || e.target === key) return 2.5;
        return null;
      });
    });
    circles.on('mousemove', positionTooltip);
    circles.on('mouseleave', function() {
      tooltipEl.style.display = 'none';
      resetHighlights();
    });

    applyEdgeFilters();
  }

  // ── Master render dispatcher ─────────────────────────────────────
  function render() {
    if (currentView === 'communities') {
      renderCommunities();
    } else if (currentView === 'dependencies') {
      renderDependencies(depRootEl.value);
    } else {
      renderLayers();
    }
    attachEdgeTooltips();
  }

  // ── Edge filter logic (for layer/violation views) ──────────────
  const showImportsEl = document.getElementById('show-imports');
  const showViolationsEl = document.getElementById('show-violations');
  showImportsEl.addEventListener('change', applyEdgeFilters);
  showViolationsEl.addEventListener('change', applyEdgeFilters);

  function applyEdgeFilters() {
    if (currentView === 'communities' || currentView === 'dependencies') return;
    const showImp = showImportsEl.checked;
    const showVio = showViolationsEl.checked;
    const violationsOnly = currentView === 'violations';

    edgeG.selectAll('path').each(function(d) {
      const el = d3.select(this);
      const isViolation = d.type !== 'import';
      let visible = false;

      if (violationsOnly) {
        visible = isViolation && showVio;
      } else {
        if (isViolation) visible = showVio;
        else visible = showImp;
      }
      el.attr('display', visible ? null : 'none');
      if (visible) {
        el.attr('opacity', null).attr('stroke-width', null);
      }
    });
  }

  // ── Search ───────────────────────────────────────────────────────
  const searchEl = document.getElementById('search');
  searchEl.addEventListener('input', function() {
    const q = this.value.toLowerCase();
    if (q === '') {
      resetHighlights();
      return;
    }
    nodeG.selectAll('circle').attr('opacity', d => {
      const path = d.filePath || '';
      const name = d.fileName || '';
      return path.toLowerCase().includes(q) || name.toLowerCase().includes(q) ? 1 : 0.08;
    });
    labelG.selectAll('.node-label').attr('opacity', d => {
      const path = d.filePath || '';
      return path.toLowerCase().includes(q) ? 1 : 0.08;
    });
  });

  // ── View switching ───────────────────────────────────────────────
  const viewBtns = document.querySelectorAll('.btn[data-view]');
  const depRootEl = document.getElementById('dep-root');
  const aggEl = document.getElementById('aggregate');
  const showDocsEl = document.getElementById('show-docs');

  // Populate dependency root selector with files that have imports
  const filesWithImports = DATA.nodes
    .filter(function(n) {
      return DATA.edges.some(function(e) { return e.type === 'import' && e.source === n.filePath; });
    })
    .sort(function(a, b) { return a.filePath.localeCompare(b.filePath); });
  filesWithImports.forEach(function(n) {
    var opt = document.createElement('option');
    opt.value = n.filePath;
    opt.textContent = n.filePath;
    depRootEl.appendChild(opt);
  });

  depRootEl.addEventListener('change', function() {
    if (currentView === 'dependencies') render();
  });

  function updateControlsForView(view) {
    var showAgg = (view === 'layers' || view === 'violations' || view === 'communities');
    showImportsEl.parentElement.style.display = 'none';
    showViolationsEl.parentElement.style.display = 'none';
    aggEl.parentElement.style.display = showAgg ? '' : 'none';
    showDocsEl.parentElement.style.display = view === 'communities' ? '' : 'none';
    depRootEl.style.display = view === 'dependencies' ? '' : 'none';
  }

  viewBtns.forEach(btn => {
    btn.addEventListener('click', function() {
      viewBtns.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      currentView = this.dataset.view;
      updateControlsForView(currentView);
      updateLegend();
      if (currentView === 'layers' || currentView === 'violations') {
        if (isAggregated) {
          currentNodes = aggData.nodes;
          currentEdges = aggData.edges;
        } else {
          currentNodes = DATA.nodes;
          currentEdges = DATA.edges;
        }
      }
      render();
    });
  });

  // ── Aggregate toggle ────────────────────────────────────────────
  aggEl.addEventListener('change', function() {
    isAggregated = this.checked;
    if (currentView === 'layers' || currentView === 'violations') {
      if (isAggregated) {
        currentNodes = aggData.nodes;
        currentEdges = aggData.edges;
      } else {
        currentNodes = DATA.nodes;
        currentEdges = DATA.edges;
      }
    }
    render();
  });

  // ── Docs toggle ──────────────────────────────────────────────────
  showDocsEl.addEventListener('change', function() {
    if (currentView === 'communities') render();
  });

  // ── Findings panel ───────────────────────────────────────────────
  const findingsEl = document.getElementById('findings');
  const findingsContent = document.getElementById('findings-content');
  const toggleFindingsBtn = document.getElementById('toggle-findings');
  let findingsVisible = false;

  toggleFindingsBtn.addEventListener('click', function() {
    findingsVisible = !findingsVisible;
    findingsEl.className = findingsVisible ? 'findings-visible' : 'findings-hidden';
    toggleFindingsBtn.textContent = findingsVisible ? 'Findings ▴' : 'Findings ▾';
    // Re-render with new chart dimensions after panel animation settles
    setTimeout(function() {
      var newW = chartEl.clientWidth;
      var newH = chartEl.clientHeight;
      svg.attr('width', newW).attr('height', newH);
    }, 280);
  });

  function buildFindings() {
    const html = [];
    const layerViolations = DATA.edges.filter(function(e) { return e.type === 'layer-violation'; });
    const boundaryViolations = DATA.edges.filter(function(e) { return e.type === 'boundary-violation'; });
    const highRiskNodes = DATA.nodes.filter(function(n) { return n.risk === 'high' || n.risk === 'critical'; });

    // ── Layer Violations
    html.push('<h3><span class="badge badge-red">' + layerViolations.length + '</span> Layer Violations</h3>');
    if (layerViolations.length > 0) {
      html.push('<table class="finding-table"><thead><tr>');
      html.push('<th>Source</th><th>Target</th><th>Type</th><th>Reason</th>');
      html.push('</tr></thead><tbody>');
      layerViolations.forEach(function(v) {
        var srcName = v.source.split('/').pop();
        var tgtName = v.target.split('/').pop();
        var vtype = v.violationType === 'skip-layer' ? 'Skip-layer' : 'Reverse';
        html.push('<tr class="severity-high" data-source="' + v.source + '" data-target="' + v.target + '">');
        html.push('<td title="' + v.source + '">' + srcName + '</td>');
        html.push('<td title="' + v.target + '">' + tgtName + '</td>');
        html.push('<td>' + vtype + '</td>');
        html.push('<td>' + (v.reason || '') + '</td>');
        html.push('</tr>');
      });
      html.push('</tbody></table>');
    } else {
      html.push('<p class="finding-none">No layer violations detected.</p>');
    }

    // ── Boundary Violations
    html.push('<h3><span class="badge badge-yellow">' + boundaryViolations.length + '</span> Boundary Violations</h3>');
    if (boundaryViolations.length > 0) {
      html.push('<table class="finding-table"><thead><tr>');
      html.push('<th>Source</th><th>Target</th><th>Reason</th>');
      html.push('</tr></thead><tbody>');
      boundaryViolations.forEach(function(v) {
        var srcName = v.source.split('/').pop();
        var tgtName = v.target.split('/').pop();
        html.push('<tr class="severity-boundary" data-source="' + v.source + '" data-target="' + v.target + '">');
        html.push('<td title="' + v.source + '">' + srcName + '</td>');
        html.push('<td title="' + v.target + '">' + tgtName + '</td>');
        html.push('<td>' + (v.reason || '') + '</td>');
        html.push('</tr>');
      });
      html.push('</tbody></table>');
    } else {
      html.push('<p class="finding-none">No boundary violations detected.</p>');
    }

    // ── High Risk Files
    html.push('<h3><span class="badge badge-gray">' + highRiskNodes.length + '</span> High Risk Files</h3>');
    if (highRiskNodes.length > 0) {
      html.push('<table class="finding-table"><thead><tr>');
      html.push('<th>File</th><th>Risk</th><th>Dependents</th><th>Depth</th><th>Hub Degree</th>');
      html.push('</tr></thead><tbody>');
      highRiskNodes.sort(function(a, b) { return b.transitiveDependents - a.transitiveDependents; });
      highRiskNodes.forEach(function(n) {
        var sev = n.risk === 'critical' ? 'severity-high' : 'severity-high';
        html.push('<tr class="' + sev + '" data-source="' + n.filePath + '">');
        html.push('<td title="' + n.filePath + '">' + n.fileName + '</td>');
        html.push('<td>' + n.risk + '</td>');
        html.push('<td>' + n.transitiveDependents + '</td>');
        html.push('<td>' + n.maxDepth + '</td>');
        html.push('<td>' + n.hubDegree + '</td>');
        html.push('</tr>');
      });
      html.push('</tbody></table>');
    } else {
      html.push('<p class="finding-none">No high risk files detected.</p>');
    }

    findingsContent.innerHTML = html.join('');

    // ── Click-to-highlight: clicking a finding row highlights the node/edge in the graph
    findingsContent.querySelectorAll('tr[data-source]').forEach(function(row) {
      row.addEventListener('click', function() {
        var src = this.dataset.source;
        var tgt = this.dataset.target;
        // Highlight matching nodes
        nodeG.selectAll('circle').attr('opacity', function(d) {
          var fp = d.filePath || '';
          if (fp === src || fp === tgt) return 1;
          return 0.1;
        }).attr('stroke-width', function(d) {
          var fp = d.filePath || '';
          if (fp === src || fp === tgt) return 3;
          return null;
        });
        // Highlight matching edges
        edgeG.selectAll('path').attr('opacity', function(e) {
          if (e.source === src && (!tgt || e.target === tgt)) return 1;
          if (e.target === src && (!tgt || e.source === tgt)) return 1;
          return 0.03;
        }).attr('stroke-width', function(e) {
          if (e.source === src && (!tgt || e.target === tgt)) return 3;
          if (e.target === src && (!tgt || e.source === tgt)) return 3;
          return null;
        });
        // Close findings panel
        if (findingsVisible) {
          findingsVisible = false;
          findingsEl.className = 'findings-hidden';
          toggleFindingsBtn.textContent = 'Findings ▾';
          setTimeout(function() {
            svg.attr('width', chartEl.clientWidth).attr('height', chartEl.clientHeight);
          }, 280);
        }
      });
    });
  }

  buildFindings();

  // ── Edge tooltips (violation reason on hover) ────────────────────
  function attachEdgeTooltips() {
    edgeG.selectAll('path').on('mouseenter', function(event, d) {
      if (d.type === 'import') return;
      var label;
      if (d.type === 'layer-violation') label = 'Layer violation';
      else if (d.type === 'boundary-violation') label = 'Boundary violation';
      else if (d.type === 'co-occurrence') label = 'Co-occurrence';
      else if (d.type === 'co-change') label = 'Co-change';
      else return;
      var vtype = d.violationType ? ' (' + d.violationType + ')' : '';
      var weightStr = d.weight ? '<br><span class="metric">Weight: ' + d.weight.toFixed(2) + '</span>' : '';
      tooltipEl.innerHTML =
        '<strong>' + label + vtype + '</strong><br>' +
        '<span class="path">' + d.source + '</span><br>→ ' +
        '<span class="path">' + d.target + '</span>' +
        (d.reason ? '<br><br><span class="metric">' + d.reason + '</span>' : '') +
        weightStr;
      tooltipEl.style.display = 'block';
      positionTooltip(event);
      d3.select(this).attr('stroke-width', 3).attr('opacity', 1);
    });
    edgeG.selectAll('path').on('mousemove', positionTooltip);
    edgeG.selectAll('path').on('mouseleave', function() {
      tooltipEl.style.display = 'none';
      d3.select(this).attr('stroke-width', null).attr('opacity', null);
      applyEdgeFilters();
    });
  }

  // ── Initial render ───────────────────────────────────────────────
  render();

  // ── Resize handling ──────────────────────────────────────────────
  window.addEventListener('resize', function() {
    svg.attr('width', chartEl.clientWidth).attr('height', chartEl.clientHeight);
  });
})();
`;
