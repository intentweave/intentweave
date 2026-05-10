// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 18. Architecture Book — Multi-Chapter Interactive HTML Export
 *
 * Generates a self-contained HTML file with:
 *   - Chapter 0: Overview — §17 layer-band SVG (full interactive, via iframe)
 *                            + stats bar + layer-cards + rules table below
 *   - Chapters 1..N: Per-ADR — Cytoscape.js flow diagram (dagre LR layout)
 *                              + CARI overlay toggles + rule panel + violations
 *   - Chapter N+1: Violations — severity-sorted table
 *   - Chapter N+2: Coverage — per-layer doc coverage + hotspot files
 *
 * Cytoscape.js + dagre layout are loaded from CDN (unpkg.com).
 * TODO (18.4): inline the minified bundles for fully offline-capable export.
 */

import type {
  PrescriptiveReportData,
  PrescriptiveEdge,
  PrescriptiveElementNode,
} from "./prescriptiveReport.js";
import { renderPrescriptiveReportHtml } from "./prescriptiveReport.js";

export function renderArchitectureBookHtml(
  data: PrescriptiveReportData,
): string {
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  // Embed the §17 prescriptive SVG report — passed as a JSON string so the
  // client can set iframe.srcdoc without any HTML-attribute escaping issues.
  // Replace "</" with "<\/" so the browser HTML parser does not mistake the
  // "</script>" inside the embedded HTML for the closing tag of our script block.
  const prescriptiveHtml = renderPrescriptiveReportHtml(data);
  const prescriptiveJson = JSON.stringify(prescriptiveHtml).replace(
    /<\//g,
    "<\\/",
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Architecture Book</title>
<style>
${BOOK_CSS}
</style>
<!-- Cytoscape.js + dagre layout — TODO: inline for fully offline export (18.4) -->
<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script src="https://unpkg.com/dagre@0.8.5/dist/dagre.min.js"></script>
<script src="https://unpkg.com/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div class="sidebar-header">
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" style="flex-shrink:0">
        <rect x="1" y="1" width="9" height="9" rx="2" fill="#3b82f6" opacity="0.9"/>
        <rect x="12" y="1" width="9" height="9" rx="2" fill="#10b981" opacity="0.8"/>
        <rect x="1" y="12" width="9" height="9" rx="2" fill="#f59e0b" opacity="0.8"/>
        <rect x="12" y="12" width="9" height="9" rx="2" fill="#6366f1" opacity="0.8"/>
      </svg>
      <div>
        <div class="sidebar-title">Architecture Book</div>
        <div class="sidebar-meta" id="sidebar-meta"></div>
      </div>
    </div>
    <nav id="nav"></nav>
  </aside>
  <main id="content"></main>
</div>
<script>
const DATA = ${json};
const PRESCRIPTIVE_HTML = ${prescriptiveJson};
${architectureBookClientScript.toString()}
architectureBookClientScript();
</script>
</body>
</html>`;
}

// ── CSS ──────────────────────────────────────────────────────────────────────

const BOOK_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  background: #f3f6fb;
  color: #1f2937;
  height: 100vh;
  overflow: hidden;
}
#app {
  display: grid;
  grid-template-columns: 232px 1fr;
  height: 100vh;
}
/* ── Sidebar ── */
#sidebar {
  background: linear-gradient(180deg, #1e2533 0%, #232c3d 100%);
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid #1a2030;
}
.sidebar-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 12px 12px;
  border-bottom: 1px solid #2d3748;
}
.sidebar-title {
  font-size: 13px;
  font-weight: 700;
  color: #f1f5f9;
  line-height: 1.2;
}
.sidebar-meta {
  font-size: 10px;
  color: #64748b;
  margin-top: 2px;
}
#nav {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}
.nav-section {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #475569;
  padding: 10px 12px 4px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 0;
  transition: background 0.1s, color 0.1s;
  user-select: none;
  position: relative;
}
.nav-item:hover { background: #2d3748; color: #e2e8f0; }
.nav-item.active { background: #1e3a5f; color: #93c5fd; font-weight: 600; }
.nav-item .nav-icon {
  width: 16px; height: 16px; border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; flex-shrink: 0;
}
.nav-item .nav-badge {
  margin-left: auto;
  background: #991b1b;
  color: #fecaca;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 8px;
  min-width: 18px;
  text-align: center;
}
.nav-item .nav-badge.zero { background: #1e3a2a; color: #86efac; }
/* ── Main content ── */
#content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.chapter {
  display: none;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.chapter.active { display: flex; }
.chapter-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid #e2e8f0;
  background: #fff;
  flex-shrink: 0;
}
.chapter-title {
  font-size: 17px;
  font-weight: 700;
  margin: 0 0 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.chapter-subtitle {
  font-size: 12px;
  color: #64748b;
  margin: 0;
}
.chapter-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
/* ── Badges ── */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
}
.badge.high   { background: #fee2e2; color: #991b1b; }
.badge.medium { background: #fef3c7; color: #92400e; }
.badge.low    { background: #e5e7eb; color: #374151; }
.badge.info   { background: #dbeafe; color: #1e40af; }
.badge.ok     { background: #dcfce7; color: #166534; }
/* ── Layer cards (overview) ── */
.layer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.layer-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  position: relative;
}
.layer-card .lc-index {
  position: absolute;
  top: 8px; right: 10px;
  font-size: 10px; color: #9ca3af;
}
.layer-card .lc-name {
  font-size: 13px; font-weight: 700; margin: 0 0 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-right: 20px;
}
.layer-card .lc-meta {
  font-size: 11px; color: #6b7280; margin: 0 0 8px;
}
.layer-card .lc-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.layer-card .lc-rules {
  margin-top: 8px;
  font-size: 10px; color: #6b7280;
}
.layer-card .lc-rules span {
  display: inline-block;
  background: #f3f4f6; border: 1px solid #e5e7eb;
  border-radius: 4px; padding: 1px 6px; margin: 2px 2px 0 0;
}
/* ── ADR chapter layout ── */
.adr-layout {
  display: grid;
  grid-template-columns: 1fr 300px;
  grid-template-rows: 1fr auto;
  gap: 16px;
  height: 100%;
  min-height: 0;
}
.adr-graph-wrap {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  overflow: hidden;
  position: relative;
  min-height: 300px;
}
.adr-graph-wrap .cy-container {
  width: 100%; height: 100%;
}
.adr-graph-empty {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: #9ca3af; font-size: 13px;
  font-style: italic; padding: 24px;
  text-align: center;
}
.adr-side {
  display: flex; flex-direction: column; gap: 12px; overflow-y: auto;
}
.adr-panel {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
}
.adr-panel h3 { margin: 0 0 8px; font-size: 12px; color: #374151; text-transform: uppercase; letter-spacing: 0.04em; }
.adr-desc { font-size: 12px; color: #374151; line-height: 1.55; }
.adr-meta-row { font-size: 11px; color: #6b7280; margin-bottom: 4px; }
.adr-meta-row b { color: #374151; }
.adr-violations-list { list-style: none; margin: 0; padding: 0; }
.adr-violations-list li {
  font-size: 11px; padding: 5px 0;
  border-bottom: 1px solid #f3f4f6;
  line-height: 1.4;
}
.adr-violations-list li:last-child { border-bottom: none; }
.adr-violations-list .viol-file { font-family: ui-monospace, monospace; color: #1e40af; font-size: 10px; }
.adr-violations-list .viol-detail { color: #6b7280; font-size: 10px; }
.adr-violations-list .viol-more { color: #9ca3af; font-style: italic; font-size: 10px; }
.adr-violations-bottom {
  grid-column: 1 / -1;
}
/* ── CARI overlay controls ── */
.overlay-controls {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 6px 10px;
  background: #f8fafc;
  border-top: 1px solid #e2e8f0;
  font-size: 11px;
  flex-shrink: 0;
}
.overlay-controls label {
  display: flex; align-items: center; gap: 5px; cursor: pointer;
  user-select: none;
}
.overlay-controls .oc-sep { color: #d1d5db; }
/* ── Violations chapter ── */
.violations-table-wrap { overflow-x: auto; }
.violations-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
}
.violations-table th {
  text-align: left; padding: 8px 10px;
  background: #f8fafc; border-bottom: 2px solid #e2e8f0;
  font-size: 11px; font-weight: 700; color: #374151;
  white-space: nowrap;
}
.violations-table td {
  padding: 7px 10px; border-bottom: 1px solid #f3f4f6;
  vertical-align: top;
}
.violations-table tr:hover td { background: #f8fafc; }
.violations-table .td-file {
  font-family: ui-monospace, monospace; font-size: 10px; color: #1e40af;
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.violations-table .td-detail { color: #6b7280; font-size: 11px; }
.viol-section { margin-bottom: 24px; }
.viol-section h3 {
  font-size: 13px; font-weight: 700; margin: 0 0 8px;
  display: flex; align-items: center; gap: 8px;
}
/* ── Stats bar (overview) ── */
.stats-bar {
  display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px;
}
.stat-card {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
  padding: 10px 14px; min-width: 100px;
}
.stat-card .sc-val { font-size: 22px; font-weight: 800; color: #1f2937; line-height: 1; }
.stat-card .sc-lbl { font-size: 10px; color: #6b7280; margin-top: 3px; }
/* ── Cy graph legend ── */
.cy-legend {
  position: absolute; bottom: 10px; left: 10px;
  background: rgba(255,255,255,0.92); border: 1px solid #e2e8f0;
  border-radius: 6px; padding: 7px 10px; font-size: 10px; line-height: 1.8;
  pointer-events: none;
}
.cy-legend .leg-item { display: flex; align-items: center; gap: 5px; }
.cy-legend .leg-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
/* ── Coverage chapter ── */
.coverage-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
}
.coverage-table th {
  text-align: left; padding: 8px 10px;
  background: #f8fafc; border-bottom: 2px solid #e2e8f0;
  font-size: 11px; font-weight: 700; color: #374151;
  white-space: nowrap;
}
.coverage-table td {
  padding: 7px 10px; border-bottom: 1px solid #f3f4f6;
  vertical-align: top;
}
.coverage-table tr:hover td { background: #f8fafc; }
.cov-bar-wrap {
  width: 100px; height: 8px; background: #e5e7eb;
  border-radius: 4px; overflow: hidden; display: inline-block;
}
.cov-bar { height: 100%; border-radius: 4px; }
.hotspot-pill {
  display: inline-block; font-family: ui-monospace,monospace;
  font-size: 9px; background: #fff7ed; border: 1px solid #fed7aa;
  border-radius: 3px; padding: 1px 5px; margin: 1px 2px 0 0;
  color: #9a3412; max-width: 200px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
/* ── YAML snippet (18.1) ── */
.yaml-snippet {
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  padding: 8px 10px;
  margin: 6px 0 0;
  overflow-x: auto;
  color: #374151;
  white-space: pre;
  line-height: 1.5;
}
.yaml-snippet .yk { color: #1d4ed8; } /* key */
.yaml-snippet .yv { color: #166534; } /* value */
.yaml-snippet .yc { color: #9ca3af; } /* comment */
/* ── Back-link button (18.2) ── */
.btn-goto {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 600;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  margin-left: 8px;
  vertical-align: middle;
  line-height: 1.6;
}
.btn-goto:hover { background: #dbeafe; }
`;

// ── Client Script ─────────────────────────────────────────────────────────────

declare const DATA: PrescriptiveReportData;
declare const PRESCRIPTIVE_HTML: string;
declare const cytoscape: any;
declare const document: any;

function architectureBookClientScript() {
  const data = DATA;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function isGlob(name: string) {
    return name.includes("*") || name.includes("/");
  }
  function esc(s: string) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function sev(s: string) {
    if (s === "high") return `<span class="badge high">HIGH</span>`;
    if (s === "medium") return `<span class="badge medium">MED</span>`;
    return `<span class="badge low">LOW</span>`;
  }
  function shortPath(p: string, max = 42) {
    if (p.length <= max) return p;
    const parts = p.split("/");
    if (parts.length > 2) return "…/" + parts.slice(-2).join("/");
    return p.slice(-max);
  }

  // Community colour palette (20 distinct, cycles)
  const COMM_PALETTE = [
    "#fde68a",
    "#bfdbfe",
    "#bbf7d0",
    "#fecaca",
    "#ddd6fe",
    "#fed7aa",
    "#cffafe",
    "#fce7f3",
    "#d1fae5",
    "#e0f2fe",
    "#fef9c3",
    "#ede9fe",
    "#dcfce7",
    "#ffedd5",
    "#f0fdf4",
    "#fdf4ff",
    "#ecfdf5",
    "#fff7ed",
    "#f0f9ff",
    "#fefce8",
  ];

  // ── Build chapter index ───────────────────────────────────────────────────
  const ruleElements = new Map<
    string,
    Array<PrescriptiveElementNode & { layerIndex: number }>
  >();
  data.layers.forEach((layer) => {
    (layer.elements ?? []).forEach((el: any) => {
      if (!el.ruleId || isGlob(String(el.name))) return;
      const arr = ruleElements.get(String(el.ruleId)) ?? [];
      arr.push({ ...el, layerIndex: layer.index });
      ruleElements.set(String(el.ruleId), arr);
    });
  });

  const adrRuleIds = data.rules
    .filter((r) => ruleElements.has(r.id))
    .sort((a, b) => {
      const ord = { high: 0, medium: 1, low: 2 };
      return ord[a.severity] - ord[b.severity];
    })
    .map((r) => r.id);

  const totalViolations =
    data.meta.totalRuleViolations + data.meta.totalLayerViolations;
  const overlay = (data as any).cariOverlay as
    | {
        hotspot: Record<
          string,
          { score: number; churn: number; coverage: number }
        >;
        hubs: Record<string, { degree: number }>;
        communities: Record<string, { id: number; label: string }>;
        actualImports: Array<{ from: string; to: string }>;
      }
    | undefined;
  const layerCov = (data as any).layerCoverage as
    | Array<{
        layerIndex: number;
        layerName: string;
        fileCount: number;
        coveragePercent: number;
        rulesGoverning: string[];
        hotspotFiles: Array<{ filePath: string; churn: number; score: number }>;
      }>
    | undefined;

  // ── Build sidebar + chapters ──────────────────────────────────────────────
  const nav = document.getElementById("nav");
  const content = document.getElementById("content");
  const sidebarMeta = document.getElementById("sidebar-meta");
  sidebarMeta.textContent = data.meta.generated
    .replace("T", " ")
    .replace(/\..+/, "");

  const navItems: Array<{ el: any; chapterId: string }> = [];

  function activateChapter(id: string) {
    navItems.forEach(({ el, chapterId }) =>
      el.classList.toggle("active", chapterId === id),
    );
    document
      .querySelectorAll(".chapter")
      .forEach((c: any) => c.classList.toggle("active", c.id === id));
    const ch = document.getElementById(id);
    if (ch && ch.dataset.cyPending) {
      delete ch.dataset.cyPending;
      initCytoscape(id);
    }
  }

  function addNavItem(
    label: string,
    icon: string,
    chapterId: string,
    badge?: string,
    badgeZero = false,
  ) {
    const el = document.createElement("div");
    el.className = "nav-item";
    el.innerHTML =
      `<span class="nav-icon">${icon}</span>` +
      `<span>${esc(label)}</span>` +
      (badge !== undefined
        ? `<span class="nav-badge${badgeZero ? " zero" : ""}">${esc(badge)}</span>`
        : "");
    el.addEventListener("click", () => activateChapter(chapterId));
    nav.appendChild(el);
    navItems.push({ el, chapterId });
  }

  // ── Overview chapter ─────────────────────────────────────────────────────
  const overviewDiv = document.createElement("div");
  overviewDiv.id = "chapter-overview";
  overviewDiv.className = "chapter active";
  overviewDiv.innerHTML = buildOverviewHtml();
  // Inject the §17 SVG into the iframe via srcdoc (avoids attribute-escaping issues).
  const prescFrame = overviewDiv.querySelector("#prescriptive-iframe");
  if (prescFrame) prescFrame.srcdoc = PRESCRIPTIVE_HTML;
  content.appendChild(overviewDiv);

  const overviewSection = document.createElement("div");
  overviewSection.className = "nav-section";
  overviewSection.textContent = "Navigation";
  nav.appendChild(overviewSection);
  addNavItem("Overview", "🏛", "chapter-overview");

  // ── Per-ADR chapters ─────────────────────────────────────────────────────
  if (adrRuleIds.length > 0) {
    const adrSection = document.createElement("div");
    adrSection.className = "nav-section";
    adrSection.textContent = "Rules";
    nav.appendChild(adrSection);
  }

  adrRuleIds.forEach((ruleId) => {
    const rule = data.rules.find((r) => r.id === ruleId)!;
    const chapterId = "chapter-" + ruleId.replace(/[^a-z0-9]/gi, "-");
    const chDiv = document.createElement("div");
    chDiv.id = chapterId;
    chDiv.className = "chapter";
    chDiv.dataset.ruleId = ruleId;
    chDiv.dataset.cyPending = "1";
    chDiv.innerHTML = buildAdrChapterHtml(ruleId);
    content.appendChild(chDiv);

    const icon =
      rule.severity === "high"
        ? "🔴"
        : rule.severity === "medium"
          ? "🟡"
          : "🟢";
    const shortLabel = ruleId.length > 26 ? ruleId.slice(0, 24) + "…" : ruleId;
    addNavItem(
      shortLabel,
      icon,
      chapterId,
      rule.count > 0 ? String(rule.count) : "✓",
      rule.count === 0,
    );
  });

  // ── Reports section ───────────────────────────────────────────────────────
  const violSection = document.createElement("div");
  violSection.className = "nav-section";
  violSection.textContent = "Reports";
  nav.appendChild(violSection);

  // ── Violations chapter ───────────────────────────────────────────────────
  const violDiv = document.createElement("div");
  violDiv.id = "chapter-violations";
  violDiv.className = "chapter";
  violDiv.innerHTML = buildViolationsHtml();
  content.appendChild(violDiv);
  addNavItem(
    "All Violations",
    "⚠️",
    "chapter-violations",
    totalViolations > 0 ? String(totalViolations) : undefined,
  );

  // ── Coverage chapter (18.3) ───────────────────────────────────────────────
  const covDiv = document.createElement("div");
  covDiv.id = "chapter-coverage";
  covDiv.className = "chapter";
  covDiv.innerHTML = buildCoverageHtml();
  content.appendChild(covDiv);
  addNavItem("Coverage", "📊", "chapter-coverage");

  activateChapter("chapter-overview");

  // ── Overview HTML builder ─────────────────────────────────────────────────
  function buildOverviewHtml(): string {
    // ── Stats strip (thin bar above the SVG iframe) ────────────────────────
    const statsBar = `<div class="stats-bar" style="flex-shrink:0;padding:8px 16px;border-bottom:1px solid #e2e8f0;background:#fff">
      <div class="stat-card"><div class="sc-val">${data.layers.length}</div><div class="sc-lbl">Layers</div></div>
      <div class="stat-card"><div class="sc-val">${data.meta.totalFiles}</div><div class="sc-lbl">Total files</div></div>
      <div class="stat-card"><div class="sc-val" style="color:${data.meta.totalRuleViolations > 0 ? "#991b1b" : "#166534"}">${data.meta.totalRuleViolations}</div><div class="sc-lbl">Rule violations</div></div>
      <div class="stat-card"><div class="sc-val" style="color:${data.meta.totalLayerViolations > 0 ? "#991b1b" : "#166534"}">${data.meta.totalLayerViolations}</div><div class="sc-lbl">Layer violations</div></div>
      <div class="stat-card"><div class="sc-val">${data.rules.length}</div><div class="sc-lbl">Rules</div></div>
      <div class="stat-card"><div class="sc-val">${adrRuleIds.length}</div><div class="sc-lbl">ADR chapters</div></div>
    </div>`;

    return `<div class="chapter-header">
      <h1 class="chapter-title">🏛 Architecture Overview</h1>
      <p class="chapter-subtitle">Layer topology and rule conformance summary · ${data.meta.generated}</p>
    </div>
    ${statsBar}
    <div style="flex:1;min-height:0">
      <iframe
        id="prescriptive-iframe"
        style="width:100%;height:100%;border:none;display:block"
        title="§17 Prescriptive Architecture Diagram"
      ></iframe>
    </div>`;
  }

  // ── ADR chapter HTML builder ──────────────────────────────────────────────
  function buildAdrChapterHtml(ruleId: string): string {
    const rule = data.rules.find((r) => r.id === ruleId);
    const els = (ruleElements.get(ruleId) ?? [])
      .slice()
      .sort((a: any, b: any) => (a.flowSeq ?? 999) - (b.flowSeq ?? 999));
    const violations = (data.violations ?? [])
      .filter((v) => v.ruleId === ruleId)
      .slice(0, 20);
    const cyId = "cy-" + ruleId.replace(/[^a-z0-9]/gi, "-");

    // ── YAML config snippet (18.1) ──────────────────────────────────────────
    const ruleEdges = data.edges.filter((e: any) => e.ruleId === ruleId);
    const forbiddenKinds = [
      ...new Set(
        ruleEdges
          .filter((e: any) => e.type === "forbidden")
          .map((e: any) => e.kind ?? "import_pattern"),
      ),
    ];
    const allowedKinds = [
      ...new Set(
        ruleEdges
          .filter((e: any) => e.type === "allowed")
          .map((e: any) => e.kind ?? "import_pattern"),
      ),
    ];
    const yamlLines: string[] = [];
    yamlLines.push("- id: " + ruleId);
    if (rule?.severity) yamlLines.push("  severity: " + rule.severity);
    if (rule?.adr) yamlLines.push("  adr: " + rule.adr);
    if (rule?.description) {
      const d = rule.description.split("\n")[0].trimEnd();
      yamlLines.push("  description: |");
      yamlLines.push("    " + (d.length > 90 ? d.slice(0, 90) + "…" : d));
    }
    if (els.length > 0) {
      yamlLines.push("  expresses:");
      yamlLines.push("    elements:");
      els.slice(0, 6).forEach((el: any) => {
        yamlLines.push('      - name: "' + el.name + '"');
        yamlLines.push("        kind: " + el.kind);
      });
      if (els.length > 6)
        yamlLines.push("      # … " + (els.length - 6) + " more");
    }
    if (forbiddenKinds.length > 0) {
      yamlLines.push("  forbidden:");
      forbiddenKinds.forEach((k) => yamlLines.push("    - kind: " + k));
    }
    if (allowedKinds.length > 0) {
      yamlLines.push("  allowed:");
      allowedKinds.forEach((k) => yamlLines.push("    - kind: " + k));
    }
    const yamlSnippet = esc(yamlLines.join("\n"));

    const titleSuffix = rule?.adr ? ` · ${rule.adr}` : "";
    const hasOverlay =
      overlay &&
      (Object.keys(overlay.hotspot).length > 0 ||
        Object.keys(overlay.hubs).length > 0 ||
        Object.keys(overlay.communities).length > 0 ||
        overlay.actualImports.length > 0);

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">
        ${rule ? sev(rule.severity) : ""}
        ${esc(ruleId)}${titleSuffix ? `<span style="font-weight:400;font-size:13px;color:#6b7280">${esc(titleSuffix)}</span>` : ""}
      </h1>
      <p class="chapter-subtitle">${rule?.count ? `${rule.count} active violation${rule.count !== 1 ? "s" : ""}` : "✓ No violations"} · ${els.length} flow element${els.length !== 1 ? "s" : ""}</p>
    </div>
    <div class="chapter-body" style="display:flex;flex-direction:column;gap:12px;padding:12px 14px">
      <div class="adr-layout">
        <div class="adr-graph-wrap" id="graph-wrap-${ruleId.replace(/[^a-z0-9]/gi, "-")}">
          ${
            els.length === 0
              ? `<div class="adr-graph-empty">No <code>expresses.elements</code> declared for this rule.<br>Add them to <code>rules.yaml</code> to visualize the flow.</div>`
              : `<div class="cy-container" id="${cyId}" style="width:100%;height:100%"></div>
               <div class="cy-legend">
                 <div class="leg-item"><div class="leg-dot" style="background:#0284c7;border:2px solid #7dd3fc"></div> Flow element</div>
                 <div class="leg-item"><div class="leg-dot" style="background:#dcfce7;border:2px solid #86efac"></div> Allowed flow</div>
                 <div class="leg-item"><div class="leg-dot" style="background:#fee2e2;border:2px solid #fca5a5"></div> Forbidden flow</div>
                 ${hasOverlay ? `<div class="leg-item"><div class="leg-dot" style="background:#d1d5db;border:1px dashed #9ca3af"></div> Actual import</div>` : ""}
               </div>`
          }
          ${
            els.length > 0 && hasOverlay
              ? `<div class="overlay-controls" id="oc-${ruleId.replace(/[^a-z0-9]/gi, "-")}">
            <span style="font-weight:600;color:#374151;margin-right:4px">Overlays:</span>
            ${overlay && Object.keys(overlay.hotspot).length > 0 ? `<label><input type="checkbox" data-cy="${cyId}" data-overlay="hotspot"> 🔥 Churn</label>` : ""}
            ${overlay && Object.keys(overlay.hubs).length > 0 ? `<label><input type="checkbox" data-cy="${cyId}" data-overlay="hubs"> ◎ Hub</label>` : ""}
            ${overlay && Object.keys(overlay.communities).length > 0 ? `<label><input type="checkbox" data-cy="${cyId}" data-overlay="communities"> 🎨 Community</label>` : ""}
            ${overlay && overlay.actualImports.length > 0 ? `<label><input type="checkbox" data-cy="${cyId}" data-overlay="imports"> ↔ Imports</label>` : ""}
            ${rule && rule.count > 0 ? `<label><input type="checkbox" data-cy="${cyId}" data-overlay="violations"> ❗ Violations</label>` : ""}
          </div>`
              : ""
          }
        </div>
        <div class="adr-side">
          <div class="adr-panel">
            <h3>Rule</h3>
            ${rule?.description ? `<p class="adr-desc">${esc(rule.description)}</p>` : ""}
            <div class="adr-meta-row"><b>ID:</b> ${esc(ruleId)}</div>
            ${rule?.severity ? `<div class="adr-meta-row"><b>Severity:</b> ${sev(rule.severity)}</div>` : ""}
            ${rule?.adr ? `<div class="adr-meta-row"><b>ADR:</b> ${esc(rule.adr)}</div>` : ""}
            <div class="adr-meta-row"><b>Violations:</b> ${rule?.count ?? 0}</div>
            <details style="margin-top:10px">
              <summary style="font-size:10px;color:#64748b;cursor:pointer;user-select:none">📄 YAML config</summary>
              <pre class="yaml-snippet">${yamlSnippet}</pre>
            </details>
          </div>
          ${
            els.length > 0
              ? `<div class="adr-panel">
            <h3>Flow Elements</h3>
            ${els
              .map((el: any, i: number) => {
                const layerShort =
                  el.layerName?.replace(/^(packages|apps)\//, "") ?? "";
                const hot = overlay?.hotspot[el.name];
                const hub = overlay?.hubs[el.name];
                const comm = overlay?.communities[el.name];
                const indicators = [
                  hot && hot.score > 0.3
                    ? `<span title="Churn score ${Math.round(hot.score * 100)}%" style="color:#b45309">🔥</span>`
                    : "",
                  hub && hub.degree > 0.5
                    ? `<span title="Hub degree ${Math.round(hub.degree * 100)}%" style="color:#1d4ed8">◎</span>`
                    : "",
                  comm
                    ? `<span title="Community: ${esc(comm.label)}" style="color:#7c3aed">●</span>`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return `<div style="font-size:11px;padding:4px 0;border-bottom:1px solid #f3f4f6">
                <span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:#0284c7;color:#fff;font-size:7px;font-weight:700;text-align:center;line-height:16px;margin-right:5px">${i + 1}</span>
                <b>${esc(String(el.name))}</b>
                ${indicators}
                <span style="font-size:10px;color:#64748b"> — ${esc(el.kind)}</span>
                ${layerShort ? `<div style="font-size:10px;color:#94a3b8;padding-left:21px">${esc(layerShort)}</div>` : ""}
              </div>`;
              })
              .join("")}
          </div>`
              : ""
          }
          ${
            violations.length > 0
              ? `<div class="adr-panel">
            <h3>Top Violations</h3>
            <ul class="adr-violations-list">
              ${violations
                .slice(0, 8)
                .map(
                  (v) =>
                    `<li>
                  <div class="viol-file">${esc(shortPath(v.filePath))}</div>
                  ${v.line ? `<div class="viol-detail">Line ${v.line}${v.symbol ? ` · ${esc(v.symbol)}` : ""}</div>` : ""}
                  ${v.detail ? `<div class="viol-detail">${esc(v.detail.slice(0, 80))}</div>` : ""}
                </li>`,
                )
                .join("")}
              ${violations.length > 8 ? `<li class="viol-more">…and ${violations.length - 8} more. See All Violations.</li>` : ""}
            </ul>
          </div>`
              : violations.length === 0 && rule?.count
                ? `<div class="adr-panel">
            <h3>Violations</h3>
            <p style="font-size:11px;color:#6b7280">Run <code>iw index rules-check --json</code> for detailed violation output.</p>
          </div>`
                : ""
          }
        </div>
      </div>
    </div>`;
    return h;
  }

  // ── Violations chapter ───────────────────────────────────────────────────
  function buildViolationsHtml(): string {
    const violations = data.violations ?? [];
    const byRule = new Map<string, typeof violations>();
    violations.forEach((v) => {
      const arr = byRule.get(v.ruleId) ?? [];
      arr.push(v);
      byRule.set(v.ruleId, arr);
    });
    const sortedRules = [...data.rules]
      .filter((r) => r.count > 0)
      .sort((a, b) => {
        const ord = { high: 0, medium: 1, low: 2 };
        return ord[a.severity] - ord[b.severity] || b.count - a.count;
      });

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">⚠️ All Violations</h1>
      <p class="chapter-subtitle">${data.meta.totalRuleViolations} rule violation${data.meta.totalRuleViolations !== 1 ? "s" : ""} · ${data.meta.totalLayerViolations} layer violation${data.meta.totalLayerViolations !== 1 ? "s" : ""}</p>
    </div>
    <div class="chapter-body">`;

    if (sortedRules.length === 0) {
      h += `<div style="padding:32px;text-align:center;color:#6b7280;font-size:14px">
        <div style="font-size:32px;margin-bottom:8px">✅</div>
        No active rule violations — all rules pass.
      </div>`;
    } else {
      sortedRules.forEach((rule) => {
        const ruleViols = byRule.get(rule.id) ?? [];
        const violChId = "chapter-" + rule.id.replace(/[^a-z0-9]/gi, "-");
        const hasAdrCh = adrRuleIds.includes(rule.id);
        h += `<div class="viol-section">
          <h3>${sev(rule.severity)} ${esc(rule.id)} ${rule.adr ? `<span style="font-weight:400;font-size:11px;color:#6b7280">${esc(rule.adr)}</span>` : ""}
            <span style="font-size:11px;font-weight:400;color:#6b7280">&nbsp;· ${rule.count} violation${rule.count !== 1 ? "s" : ""}</span>
            ${hasAdrCh ? `<button class="btn-goto" onclick="activateChapter('${violChId}')">↗ ADR chapter</button>` : ""}
          </h3>`;
        if (rule.description) {
          h += `<p style="font-size:12px;color:#6b7280;margin:0 0 10px">${esc(rule.description)}</p>`;
        }
        if (ruleViols.length > 0) {
          h += `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
            <th>File</th><th>Line</th><th>Symbol</th><th>Detail</th>
          </tr></thead><tbody>`;
          ruleViols.forEach((v) => {
            h += `<tr>
              <td class="td-file" title="${esc(v.filePath)}">${esc(shortPath(v.filePath))}</td>
              <td style="font-size:10px;white-space:nowrap">${v.line ?? "—"}</td>
              <td style="font-family:ui-monospace,monospace;font-size:10px">${v.symbol ? esc(v.symbol) : "—"}</td>
              <td class="td-detail">${esc(v.detail.slice(0, 120))}${v.detail.length > 120 ? "…" : ""}</td>
            </tr>`;
          });
          h += `</tbody></table></div>`;
          if (rule.count > ruleViols.length) {
            h += `<p style="font-size:11px;color:#9ca3af;margin:4px 0 0">Showing ${ruleViols.length} of ${rule.count} violations. Run <code>iw index rules-check</code> for full output.</p>`;
          }
        } else {
          h += `<p style="font-size:11px;color:#9ca3af">Rebuild with <code>--book</code> after a fresh <code>iw index rules-check</code> for detailed violation output.</p>`;
        }
        h += `</div>`;
      });
    }
    h += `</div>`;
    return h;
  }

  // ── Coverage chapter (18.3) ───────────────────────────────────────────────
  function buildCoverageHtml(): string {
    const covData = layerCov ?? [];
    const sorted = [...covData].sort((a, b) => b.layerIndex - a.layerIndex);

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">📊 Coverage</h1>
      <p class="chapter-subtitle">Per-layer documentation and rule coverage · driven by CARI moduleCoverage + hotspotPriority</p>
    </div>
    <div class="chapter-body">`;

    if (sorted.length === 0) {
      h += `<div style="padding:32px;text-align:center;color:#6b7280;font-size:14px">
        <div style="font-size:28px;margin-bottom:8px">📋</div>
        No coverage data available. Run <code>iw index build --depth full</code> first.
      </div>`;
    } else {
      h += `<div class="violations-table-wrap"><table class="coverage-table"><thead><tr>
        <th>Layer</th><th>#</th><th>Files</th><th>Doc Coverage</th><th>Rules</th><th>Top Hotspots</th>
      </tr></thead><tbody>`;
      sorted.forEach((lc) => {
        const barColor =
          lc.coveragePercent >= 70
            ? "#22c55e"
            : lc.coveragePercent >= 40
              ? "#f59e0b"
              : "#ef4444";
        const ruleChips =
          lc.rulesGoverning
            .map(
              (r) =>
                `<span style="display:inline-block;font-size:9px;background:#e0f2fe;border:1px solid #bae6fd;border-radius:3px;padding:1px 5px;margin:1px 2px 0 0;color:#0c4a6e">${esc(r)}</span>`,
            )
            .join("") || "—";
        const hotspots =
          lc.hotspotFiles
            .map(
              (f) =>
                `<span class="hotspot-pill" title="${esc(f.filePath)} · churn ${f.churn}">${esc(shortPath(f.filePath, 30))}</span>`,
            )
            .join("") || "—";
        h += `<tr>
          <td style="font-weight:600">${esc(lc.layerName.replace(/^(packages|apps)\//, ""))}</td>
          <td style="font-size:10px;color:#9ca3af">#${lc.layerIndex}</td>
          <td style="text-align:right">${lc.fileCount}</td>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="cov-bar-wrap"><div class="cov-bar" style="width:${lc.coveragePercent}%;background:${barColor}"></div></div>
              <span style="font-size:11px;font-weight:600;color:${barColor}">${lc.coveragePercent}%</span>
            </div>
          </td>
          <td>${ruleChips}</td>
          <td>${hotspots}</td>
        </tr>`;
      });
      h += `</tbody></table></div>`;

      // Coverage tips
      const lowCov = sorted.filter(
        (lc) => lc.fileCount > 0 && lc.coveragePercent < 40,
      );
      if (lowCov.length > 0) {
        h += `<div style="margin-top:16px;padding:12px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:12px">
          <b style="color:#92400e">⚠ Low-coverage layers</b>
          <ul style="margin:8px 0 0;padding-left:20px;color:#78350f">
            ${lowCov.map((lc) => `<li>${esc(lc.layerName)} — ${lc.coveragePercent}% (${lc.fileCount} files). Run <code>iw index hotspot-priority</code> to prioritize.</li>`).join("")}
          </ul>
        </div>`;
      }
    }

    h += `</div>`;
    return h;
  }

  // ── Cytoscape initializer ─────────────────────────────────────────────────
  const cyInstances = new Map<string, any>();
  // Track which overlay checkbox states are active per cyId
  const overlayState = new Map<string, Set<string>>();

  function initCytoscape(chapterId: string) {
    if (typeof cytoscape === "undefined") return;
    const ch = document.getElementById(chapterId);
    if (!ch) return;
    const ruleId = ch.dataset.ruleId;
    if (!ruleId) return;
    const cyId = "cy-" + ruleId.replace(/[^a-z0-9]/gi, "-");
    const container = document.getElementById(cyId);
    if (!container) return;

    const els = (ruleElements.get(ruleId) ?? [])
      .slice()
      .sort((a: any, b: any) => (a.flowSeq ?? 999) - (b.flowSeq ?? 999));
    if (els.length === 0) return;

    const nodes = els.map((el: any) => ({
      data: {
        id: el.name,
        label: el.name,
        step: el.flowSeq != null && el.flowSeq < 999 ? el.flowSeq + 1 : null,
        kind: el.kind,
        layerName: (el.layerName ?? "").replace(/^(packages|apps)\//, ""),
        layerIndex: el.layerIndex,
      },
    }));

    const ruleEdges = data.edges.filter(
      (e: PrescriptiveEdge) =>
        e.ruleId === ruleId &&
        e.fromElementName &&
        e.toElementName &&
        !isGlob(String(e.fromElementName)) &&
        !isGlob(String(e.toElementName)),
    );
    const seenEdge = new Set<string>();
    const edges = ruleEdges
      .map((e: PrescriptiveEdge, i: number) => {
        const k = `${e.fromElementName}->${e.toElementName}`;
        if (seenEdge.has(k)) return null;
        seenEdge.add(k);
        return {
          data: {
            id: "e" + i,
            source: e.fromElementName,
            target: e.toElementName,
            edgeType: e.type,
            flowKind: e.flowKind ?? "",
            overlayType: "intent",
          },
        };
      })
      .filter(Boolean);

    if (edges.length === 0 && els.length > 1) {
      for (let i = 0; i < els.length - 1; i++) {
        edges.push({
          data: {
            id: "seq" + i,
            source: els[i].name,
            target: els[i + 1].name,
            edgeType: "allowed",
            flowKind: "flow",
            overlayType: "intent",
          },
        });
      }
    }

    try {
      if ((globalThis as any).cytoscapeDagre) {
        cytoscape.use((globalThis as any).cytoscapeDagre);
      }
    } catch {
      /* already registered */
    }

    const cy = cytoscape({
      container,
      elements: [...nodes, ...edges],
      style: buildCyStyle(false),
      layout: {
        name:
          typeof (globalThis as any).cytoscapeDagre !== "undefined" ||
          typeof (globalThis as any).dagre !== "undefined"
            ? "dagre"
            : "grid",
        rankDir: "LR",
        nodeSep: 60,
        rankSep: 80,
        padding: 24,
      },
    });
    cy.fit(undefined, 24);
    cyInstances.set(chapterId, cy);
    overlayState.set(cyId, new Set());

    // Wire overlay checkboxes
    document.querySelectorAll(`input[data-cy="${cyId}"]`).forEach((cb: any) => {
      cb.addEventListener("change", () => {
        const state = overlayState.get(cyId) ?? new Set();
        if (cb.checked) state.add(cb.dataset.overlay);
        else state.delete(cb.dataset.overlay);
        overlayState.set(cyId, state);
        applyOverlays(cy, cyId, ruleId, state);
      });
    });
  }

  // Build Cytoscape style array; base styles only.
  function buildCyStyle(_hasImports: boolean) {
    return [
      {
        selector: "node",
        style: {
          "background-color": "#f0f9ff",
          "border-color": "#7dd3fc",
          "border-width": 2,
          label: "data(label)",
          "text-valign": "bottom",
          "text-halign": "center",
          "font-size": "10px",
          "font-weight": "600",
          color: "#0c4a6e",
          width: 40,
          height: 40,
          shape: "roundrectangle",
          padding: "6px",
          "text-margin-y": 4,
        },
      },
      {
        selector: "node[step]",
        style: {
          "background-color": "#0284c7",
          "border-color": "#0369a1",
          color: "#fff",
        },
      },
      {
        selector: 'edge[overlayType = "import"]',
        style: {
          "line-color": "#9ca3af",
          "target-arrow-color": "#9ca3af",
          "line-style": "dashed",
          "line-dash-pattern": [4, 4],
          width: 1.5,
          "z-index": 1,
          label: "",
        },
      },
      {
        selector: 'edge[edgeType = "forbidden"][overlayType != "import"]',
        style: {
          "line-color": "#dc2626",
          "target-arrow-color": "#dc2626",
          "line-style": "dashed",
          "line-dash-pattern": [6, 3],
          width: 2,
        },
      },
      {
        selector: 'edge[edgeType = "allowed"][overlayType != "import"]',
        style: {
          "line-color": "#0284c7",
          "target-arrow-color": "#0284c7",
          width: 2,
        },
      },
      {
        selector: "edge",
        style: {
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "font-size": "9px",
          color: "#64748b",
          label: "data(flowKind)",
          "text-rotation": "autorotate",
          "z-index": 5,
        },
      },
    ];
  }

  // Apply/remove CARI overlays on a live Cytoscape instance.
  function applyOverlays(
    cy: any,
    cyId: string,
    ruleId: string,
    active: Set<string>,
  ) {
    const nodeNames = new Set(cy.nodes().map((n: any) => n.id()));

    // ── hotspot overlay (node background: white→orange→red) ──
    cy.nodes().forEach((n: any) => {
      const name = n.id();
      const hot = active.has("hotspot") ? overlay?.hotspot[name] : undefined;
      if (hot) {
        const r = Math.round(255);
        const g = Math.round(255 * (1 - hot.score) * 0.6);
        const b = Math.round(255 * (1 - hot.score) * 0.4);
        n.style("background-color", `rgb(${r},${g},${b})`);
        n.style("border-color", hot.score > 0.7 ? "#dc2626" : "#f97316");
      } else if (!active.has("communities") && !active.has("violations")) {
        n.style(
          "background-color",
          active.has("violations") ? n.style("background-color") : "#f0f9ff",
        );
        n.style("border-color", "#7dd3fc");
      }
    });

    // ── hub overlay (border width 2–6px) ──
    cy.nodes().forEach((n: any) => {
      const hub = active.has("hubs") ? overlay?.hubs[n.id()] : undefined;
      if (hub) {
        n.style("border-width", 2 + hub.degree * 4);
      } else if (!active.has("hotspot")) {
        n.style("border-width", 2);
      }
    });

    // ── community overlay (node background colour) ──
    cy.nodes().forEach((n: any) => {
      const comm = active.has("communities")
        ? overlay?.communities[n.id()]
        : undefined;
      if (comm && !active.has("hotspot") && !active.has("violations")) {
        n.style(
          "background-color",
          COMM_PALETTE[comm.id % COMM_PALETTE.length],
        );
        n.style("border-color", "#a78bfa");
      }
    });

    // ── violations overlay (node badge-like red tint, violating edges solid red) ──
    if (active.has("violations")) {
      const ruleViols = (data.violations ?? []).filter(
        (v) => v.ruleId === ruleId,
      );
      const violFiles = new Set(ruleViols.map((v) => v.filePath));
      cy.nodes().forEach((n: any) => {
        // crude match: node name appears in any violation file path
        const isViol = ruleViols.some(
          (v) =>
            v.filePath.includes(n.id()) ||
            (v.symbol && v.symbol.includes(n.id())),
        );
        if (isViol) {
          n.style("background-color", "#fee2e2");
          n.style("border-color", "#dc2626");
          n.style("border-width", 3);
        }
      });
    }

    // ── actual imports overlay ──
    // Remove any existing import edges first
    cy.edges('[overlayType = "import"]').remove();
    if (active.has("imports") && overlay && overlay.actualImports.length > 0) {
      const importEdges = overlay.actualImports
        .filter((imp) => nodeNames.has(imp.from) && nodeNames.has(imp.to))
        .map((imp, i) => ({
          data: {
            id: "imp" + i,
            source: imp.from,
            target: imp.to,
            edgeType: "allowed",
            overlayType: "import",
            flowKind: "",
          },
        }));
      if (importEdges.length > 0) {
        cy.add(importEdges);
      }
    }
  }
}
