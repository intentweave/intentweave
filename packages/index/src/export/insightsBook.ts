// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * §18. Insights Book — Multi-Chapter Interactive HTML Export
 *
 * Generates a self-contained HTML file with:
 *   - Chapter 0: Overview — §17 layer-band SVG (full interactive, via iframe)
 *                            + stats bar
 *   - Chapters 1..N: Per-ADR — pure-SVG LR flow diagram (Sugiyama-style layout)
 *                              + CARI overlay toggles + rule panel + YAML snippet
 *   - Chapter N+1: Violations — severity-sorted table with ADR back-links
 *   - Chapter N+2: Coverage — per-layer doc coverage + hotspot files
 *
 * Zero external CDN dependencies — all rendering uses inline SVG.
 */

import type {
  PrescriptiveReportData,
  InsightsBookData,
  PrescriptiveEdge,
  PrescriptiveElementNode,
} from "./prescriptiveReport.js";
import { renderPrescriptiveReportHtml } from "./prescriptiveReport.js";
import { readFileSync } from "fs";

/** Load a vendor JS bundle and return an inline `<script>` tag, or a CDN fallback. */
function vendorScriptTag(filename: string, cdnUrl: string): string {
  try {
    // Works both with tsx (src/) and compiled dist/ via postbuild copy
    const vendorUrl = new URL(`./vendor/${filename}`, import.meta.url);
    const content = readFileSync(vendorUrl, "utf-8").replace(
      /<\/script>/gi,
      "<\\/script>",
    );
    return `<script>${content}</script>`;
  } catch {
    return `<script src="${cdnUrl}"></script>`;
  }
}

export function renderInsightsBookHtml(
  data: InsightsBookData,
  archReportHtml?: string,
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
  // Embed the §10.1 interactive D3 arch report (from iw index export --html).
  const archJson = archReportHtml
    ? JSON.stringify(archReportHtml).replace(/<\//g, "<\\/")
    : "null";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IntentWeave · Insights</title>
<style>
${INSIGHTS_CSS}
</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div class="sidebar-header">
      <a href="https://intentweave.org" target="_blank" rel="noopener" class="iw-logo" title="IntentWeave">
        <svg width="28" height="28" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="iw-grad-bands" gradientUnits="userSpaceOnUse" x1="-160" y1="0" x2="160" y2="0">
              <stop offset="0%" stop-color="#d1fae5"/><stop offset="25%" stop-color="#86efac"/>
              <stop offset="60%" stop-color="#4ade80"/><stop offset="100%" stop-color="#15803d"/>
            </linearGradient>
            <linearGradient id="iw-grad-ring" gradientUnits="userSpaceOnUse" x1="-160" y1="0" x2="160" y2="0">
              <stop offset="0%" stop-color="#4ade80"/><stop offset="50%" stop-color="#16a34a"/>
              <stop offset="100%" stop-color="#064e3b"/>
            </linearGradient>
            <filter id="iw-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#020805" flood-opacity="0.45"/>
            </filter>
            <clipPath id="iw-clip-bl"><rect x="-80" y="-15" width="80" height="180"/></clipPath>
            <rect id="iw-v1" x="-58" y="-140" width="36" height="280" rx="18"/>
            <rect id="iw-v2" x="22" y="-140" width="36" height="280" rx="18"/>
            <rect id="iw-h1" x="-140" y="-58" width="280" height="36" rx="18"/>
            <rect id="iw-h2" x="-140" y="22" width="280" height="36" rx="18"/>
          </defs>
          <g transform="translate(250 250) rotate(45)">
            <circle cx="0" cy="0" r="115" stroke-width="36" fill="none" stroke="url(#iw-grad-ring)" filter="url(#iw-shadow)"/>
            <use href="#iw-v1" fill="url(#iw-grad-bands)" filter="url(#iw-shadow)"/>
            <use href="#iw-h1" fill="url(#iw-grad-bands)" filter="url(#iw-shadow)"/>
            <use href="#iw-v2" fill="url(#iw-grad-bands)" filter="url(#iw-shadow)"/>
            <use href="#iw-h2" fill="url(#iw-grad-bands)" filter="url(#iw-shadow)"/>
            <g clip-path="url(#iw-clip-bl)"><use href="#iw-v1" fill="url(#iw-grad-bands)" filter="url(#iw-shadow)"/></g>
          </g>
        </svg>
      </a>
      <div style="min-width:0">
        <div class="sidebar-brand">IntentWeave</div>
        <div class="sidebar-title">Insights Book</div>
      </div>
    </div>
    <nav id="nav"></nav>
    <!-- 19.2 Global Search button -->
    <button id="gs-btn" aria-label="Search (Cmd+K)">
      <span>🔍</span> Search
      <span class="gs-kbd">⌘K</span>
    </button>
    <div class="sidebar-footer">
      <div class="sidebar-footer-tagline">From code graph to intent graph</div>
      <div class="sidebar-meta" id="sidebar-meta"></div>
    </div>
  </aside>
  <main id="content"></main>
</div>
<script>
const DATA = ${json};
const PRESCRIPTIVE_HTML = ${prescriptiveJson};
const ARCH_REPORT_HTML = ${archJson};
${insightsBookClientScript.toString()}
insightsBookClientScript();
</script>
<!-- 19.2 Global Search overlay -->
<dialog id="gs-overlay" aria-label="Search">
  <div id="gs-input-wrap">
    <span style="font-size:16px">🔍</span>
    <input id="gs-input" type="text" placeholder="Search chapters, violations, rules, files…" autocomplete="off" spellcheck="false">
    <kbd style="font-size:10px;color:#9ca3af;cursor:pointer" id="gs-close">Esc</kbd>
  </div>
  <div id="gs-results"><div class="gs-empty">Start typing to search…</div></div>
</dialog>
</body>
</html>`;
}

// ── CSS ──────────────────────────────────────────────────────────────────────

const INSIGHTS_CSS = `
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
  background: #0f131b;
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid #1f2937;
}
.sidebar-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 12px 12px;
  border-bottom: 1px solid #1f2937;
}
.iw-logo { display:flex; flex-shrink:0; text-decoration:none; }
.iw-logo:hover svg { opacity:0.85; }
.sidebar-brand {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #4ade80;
  line-height: 1.1;
  text-transform: uppercase;
}
.sidebar-title {
  font-size: 13px;
  font-weight: 700;
  color: #f1f5f9;
  line-height: 1.2;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sidebar-footer {
  padding: 10px 12px;
  border-top: 1px solid #1f2937;
  flex-shrink: 0;
}
.sidebar-footer-tagline {
  font-size: 9px;
  color: #4ade80;
  font-style: italic;
  letter-spacing: 0.02em;
  margin-bottom: 3px;
}
.sidebar-meta {
  font-size: 9px;
  color: #475569;
}
/* ── Global Search overlay (19.2) ── */
#gs-btn {
  display:flex; align-items:center; gap:6px;
  width:calc(100% - 24px); margin:8px 12px 4px; padding:6px 10px;
  background:rgba(255,255,255,0.05); border:1px solid #334155; border-radius:6px;
  color:#94a3b8; font-size:11px; cursor:pointer; text-align:left;
  transition:background 0.15s,border-color 0.15s;
}
#gs-btn:hover { background:rgba(74,222,128,0.08); border-color:#4ade80; color:#bbf7d0; }
#gs-btn .gs-kbd { margin-left:auto; font-size:9px; background:#1e293b; border:1px solid #334155; border-radius:3px; padding:1px 5px; }
#gs-overlay { padding:0; border:none; border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,0.35); width:min(600px,92vw); max-height:70vh; overflow:hidden; }
#gs-overlay::backdrop { background:rgba(0,0,0,0.55); backdrop-filter:blur(2px); }
#gs-input-wrap { padding:12px 14px; border-bottom:1px solid #e2e8f0; display:flex; align-items:center; gap:8px; }
#gs-input { flex:1; border:none; outline:none; font-size:14px; color:#1f2937; background:transparent; }
#gs-results { overflow-y:auto; max-height:calc(70vh - 56px); }
.gs-empty { padding:24px; text-align:center; color:#9ca3af; font-size:13px; }
.gs-group { padding:8px 14px 2px; font-size:9px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#9ca3af; }
.gs-item { display:flex; align-items:baseline; gap:10px; padding:8px 14px; cursor:pointer; border-left:3px solid transparent; }
.gs-item:hover { background:#f0f9ff; border-left-color:#3b82f6; }
.gs-item .gs-icon { font-size:12px; flex-shrink:0; }
.gs-item .gs-title { font-size:12px; font-weight:600; color:#1f2937; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gs-item .gs-sub { font-size:10px; color:#6b7280; flex-shrink:0; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
.nav-item:hover { background: rgba(74,222,128,0.08); color: #bbf7d0; }
.nav-item.active { background: rgba(74,222,128,0.15); color: #4ade80; font-weight: 600; border-left: 2px solid #4ade80; }
.nav-item.sub { padding-left: 24px; font-size: 10px; color: #64748b; }
.nav-item.sub:hover { background: rgba(74,222,128,0.05); color: #94a3b8; }
.nav-item.sub.active { background: rgba(74,222,128,0.10); color: #4ade80; border-left: 2px solid #4ade80; }
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
.violations-table .td-file.viol-src-link { cursor: pointer; border-bottom: 1px dashed #7dd3fc; }
.violations-table .td-file.viol-src-link:hover { color: #1d4ed8; background: #eff6ff; border-radius: 3px; }
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
/* ── Executive Summary (Phase 2) ── */
.exec-domain-row {
  display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px;
}
.exec-domain-pill {
  flex: 1; min-width: 110px;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
  padding: 14px 18px; display: flex; flex-direction: column; align-items: center;
}
.exec-domain-pill .edp-count { font-size: 26px; font-weight: 800; line-height: 1; }
.exec-domain-pill .edp-label { font-size: 10px; color: #6b7280; margin-top: 4px; text-align: center; }
.action-card {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
  padding: 12px 14px; display: flex; align-items: flex-start; gap: 10px;
}
.action-card .ac-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
.action-card .ac-body { flex: 1; min-width: 0; }
.action-card .ac-title { font-size: 12px; font-weight: 700; color: #1f2937; }
.action-card .ac-detail { font-size: 11px; color: #6b7280; margin-top: 3px; line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.action-card .ac-link { margin-top: 6px; }
.quick-links-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px;
  margin-top: 4px;
}
.quick-link-card {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
  padding: 10px 12px; cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600; color: #374151;
  transition: background 0.1s, border-color 0.1s;
}
.quick-link-card:hover { background: #f0fdf4; border-color: #86efac; color: #166534; }
.quick-link-card .qlc-icon { font-size: 15px; }
.quick-link-card .qlc-badge {
  margin-left: auto; font-size: 9px; font-weight: 700;
  padding: 1px 5px; border-radius: 999px;
  background: #fee2e2; color: #991b1b;
}
.quick-link-card .qlc-badge.ok { background: #dcfce7; color: #166534; }
/* ── Recommendations chapter (Phase 2) ── */
.reco-list { display: flex; flex-direction: column; gap: 8px; }
.reco-card {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
  padding: 10px 14px; display: flex; align-items: flex-start; gap: 10px;
}
.reco-card .reco-num {
  width: 26px; height: 26px; border-radius: 50%;
  background: #f3f4f6; color: #6b7280; font-size: 10px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px;
}
.reco-card .reco-body { flex: 1; min-width: 0; }
.reco-card .reco-title { font-size: 12px; font-weight: 700; color: #1f2937; }
.reco-card .reco-file {
  font-family: ui-monospace,monospace; font-size: 10px; color: #1e40af;
  margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.reco-card .reco-detail { font-size: 11px; color: #6b7280; margin-top: 3px; line-height: 1.5; }
.reco-card .reco-footer { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
/* ── Domain group sections (violations chapter) ── */
.domain-group { margin-bottom: 28px; }
.domain-group-header {
  display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
  padding-bottom: 8px; border-bottom: 2px solid #e2e8f0;
}
.domain-group-header h2 {
  font-size: 15px; font-weight: 800; margin: 0; color: #1f2937;
}
.dormant-rule-chip {
  display: inline-flex; align-items: center; gap: 5px;
  background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px;
  padding: 4px 10px; margin: 3px 4px 3px 0; font-size: 11px; color: #166534;
}
`;

// ── Client Script ─────────────────────────────────────────────────────────────

declare const DATA: InsightsBookData;
declare const PRESCRIPTIVE_HTML: string;
declare const ARCH_REPORT_HTML: string | null;
declare const document: any;

function insightsBookClientScript() {
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
  function slugId(s: string) {
    return String(s)
      .replace(/[^a-z0-9]/gi, "-")
      .toLowerCase();
  }
  function ruleCardDomId(ruleId: string) {
    return "rule-card-" + slugId(ruleId);
  }

  function parseMermaidEdges(
    src: string,
  ): Array<{ from: string; to: string; label?: string }> {
    const edges: Array<{ from: string; to: string; label?: string }> = [];
    const lines = String(src || "").split(/\r?\n/);
    const clean = (s: string) =>
      s
        .trim()
        .replace(/^\[|\]$/g, "")
        .replace(/^\(|\)$/g, "")
        .replace(/^\{|\}$/g, "");

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("%%")) continue;

      // sequenceDiagram: A->>B: label
      const seq = line.match(
        /^([\w.-]+)\s*[-=]+>{1,2}\s*([\w.-]+)\s*(?::\s*(.+))?$/,
      );
      if (seq) {
        edges.push({
          from: clean(seq[1]),
          to: clean(seq[2]),
          label: seq[3]?.trim(),
        });
        continue;
      }

      // flowchart/stateDiagram: A --> B / A -->|label| B
      const flow = line.match(
        /^([^\s]+)\s*-+\.?-*>\s*(?:\|([^|]+)\|\s*)?([^\s]+)$/,
      );
      if (flow) {
        edges.push({
          from: clean(flow[1]),
          to: clean(flow[3]),
          label: flow[2]?.trim(),
        });
      }
    }
    return edges;
  }

  function renderMermaidPreview(src: string): string {
    const edges = parseMermaidEdges(src);
    if (edges.length === 0) {
      return `<div style="font-size:11px;color:#6b7280">No parseable edges found.</div>`;
    }
    let h = `<div style="display:flex;flex-direction:column;gap:8px">`;
    edges.slice(0, 24).forEach((e, idx) => {
      h += `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px">
        <span style="font:600 11px ui-monospace,monospace;background:#ecfeff;color:#155e75;border:1px solid #a5f3fc;border-radius:999px;padding:2px 7px">${esc(e.from)}</span>
        <span style="font-size:11px;color:#64748b">→</span>
        <span style="font:600 11px ui-monospace,monospace;background:#eff6ff;color:#1e3a8a;border:1px solid #bfdbfe;border-radius:999px;padding:2px 7px">${esc(e.to)}</span>
        ${e.label ? `<span style="font-size:11px;color:#6b7280">${esc(e.label)}</span>` : ""}
        <span style="margin-left:auto;font-size:10px;color:#9ca3af">#${idx + 1}</span>
      </div>`;
    });
    if (edges.length > 24) {
      h += `<div style="font-size:11px;color:#9ca3af">Showing 24 of ${edges.length} edges.</div>`;
    }
    h += `</div>`;
    return h;
  }

  function splitCypherClauses(
    query: string,
  ): Array<{ key: string; value: string }> {
    const text = String(query || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return [];

    const parts: Array<{ key: string; value: string }> = [];
    const re =
      /\b(OPTIONAL\s+MATCH|DETACH\s+DELETE|ORDER\s+BY|UNION\s+ALL|MATCH|WHERE|WITH|RETURN|UNION|CALL|UNWIND|MERGE|CREATE|SET|DELETE|LIMIT|SKIP)\b/gi;
    const hits: Array<{ key: string; idx: number; len: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({
        key: m[1].toUpperCase().replace(/\s+/g, " "),
        idx: m.index,
        len: m[0].length,
      });
    }
    if (hits.length === 0) return [];
    for (let i = 0; i < hits.length; i++) {
      const start = hits[i];
      const end = i + 1 < hits.length ? hits[i + 1].idx : text.length;
      const value = text.slice(start.idx + start.len, end).trim();
      parts.push({ key: start.key, value });
    }
    return parts;
  }

  function initRulesCatalogFilters() {
    const chapter = document.getElementById("chapter-rules-catalog");
    if (!chapter || chapter.dataset.filtersInit === "1") return;

    const domainSel = chapter.querySelector("#rules-filter-domain") as any;
    const severitySel = chapter.querySelector("#rules-filter-severity") as any;
    const hasMermaid = chapter.querySelector("#rules-filter-mermaid") as any;
    const hasCypher = chapter.querySelector("#rules-filter-cypher") as any;
    const clearBtn = chapter.querySelector("#rules-filter-clear") as any;
    const countEl = chapter.querySelector("#rules-filter-count") as any;
    const cards = Array.from(chapter.querySelectorAll(".rules-card")) as any[];

    const applyFilters = () => {
      const dom = String(domainSel?.value ?? "all");
      const sev = String(severitySel?.value ?? "all");
      const needMermaid = Boolean(hasMermaid?.checked);
      const needCypher = Boolean(hasCypher?.checked);

      let visible = 0;
      cards.forEach((card) => {
        const cardDom = String(card.dataset.domain ?? "structural");
        const cardSev = String(card.dataset.severity ?? "low");
        const cardMermaid = card.dataset.hasMermaid === "1";
        const cardCypher = card.dataset.hasCypher === "1";
        const ok =
          (dom === "all" || cardDom === dom) &&
          (sev === "all" || cardSev === sev) &&
          (!needMermaid || cardMermaid) &&
          (!needCypher || cardCypher);
        card.style.display = ok ? "block" : "none";
        if (ok) visible += 1;
      });
      if (countEl) countEl.textContent = `${visible}/${cards.length} rules`;
    };

    [domainSel, severitySel, hasMermaid, hasCypher].forEach((el) => {
      if (!el) return;
      el.addEventListener("change", applyFilters);
    });
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        if (domainSel) domainSel.value = "all";
        if (severitySel) severitySel.value = "all";
        if (hasMermaid) hasMermaid.checked = false;
        if (hasCypher) hasCypher.checked = false;
        applyFilters();
      });
    }

    applyFilters();
    chapter.dataset.filtersInit = "1";
  }

  function jumpToRuleCatalog(ruleId: string) {
    activateChapter("chapter-rules-catalog");
    initRulesCatalogFilters();

    const chapter = document.getElementById("chapter-rules-catalog");
    if (!chapter) return;

    const card = chapter.querySelector(`#${ruleCardDomId(ruleId)}`) as any;
    if (!card) return;

    chapter.querySelectorAll(".rules-card").forEach((el: any) => {
      el.style.outline = "";
      el.style.boxShadow = "";
    });

    card.scrollIntoView({ behavior: "smooth", block: "start" });
    card.style.outline = "2px solid #38bdf8";
    card.style.boxShadow = "0 0 0 4px rgba(56,189,248,0.25)";
    setTimeout(() => {
      card.style.outline = "";
      card.style.boxShadow = "";
    }, 1800);
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
  const rulesCatalog = (data as any).rulesCatalog as
    | {
        configPath?: string;
        rawYaml?: string;
        rules?: Array<{
          id: string;
          description?: string;
          adr?: string;
          severity?: "high" | "medium" | "low";
          domain?: "structural" | "behavioral" | "documentary";
          mode?: "error" | "warn";
          sourceType?: "mermaid_inline" | "mermaid_file";
          sourceFile?: string;
          sourceBlockId?: string;
          mermaid?: string;
          forbidden?: unknown[];
        }>;
      }
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
    if (ch && ch.dataset.flowPending) {
      delete ch.dataset.flowPending;
      initFlowDiagram(id);
    }
    if (ch && ch.dataset.cgPending) {
      delete ch.dataset.cgPending;
      initCallGraph(id);
    }
  }
  // Expose activateChapter globally for inline onclick handlers
  (globalThis as any).activateChapter = activateChapter;
  (globalThis as any).jumpToRuleCatalog = jumpToRuleCatalog;

  function addNavItem(
    label: string,
    icon: string,
    chapterId: string,
    badge?: string,
    badgeZero = false,
  ) {
    const el = document.createElement("div");
    el.className = "nav-item";
    el.dataset.chapter = chapterId;
    el.dataset.label = label;
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

  // ── Shared source-viewer syntax highlighter ────────────────────────────
  function highlightLine(raw: string, lang: string): string {
    function e(t: string): string {
      return t
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    const trimmed = raw.trimStart();
    // Full-line comment
    const fullComment =
      (lang !== "python" &&
        (trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*"))) ||
      (lang === "python" && trimmed.startsWith("#")) ||
      (lang === "swift" && trimmed.startsWith("//"));
    if (fullComment) return `<span class="src-comment">${e(raw)}</span>`;
    // Trailing // comment (TS/JS/Swift/Go — skip Python, handled above)
    if (lang !== "python") {
      let inStr: string | null = null;
      let esc2 = false;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (esc2) {
          esc2 = false;
          continue;
        }
        if (ch === "\\" && inStr) {
          esc2 = true;
          continue;
        }
        if (!inStr && (ch === '"' || ch === "'" || ch === "`")) {
          inStr = ch;
          continue;
        }
        if (inStr && ch === inStr) {
          inStr = null;
          continue;
        }
        if (!inStr && ch === "/" && raw[i + 1] === "/") {
          return `${e(raw.slice(0, i))}<span class="src-comment">${e(raw.slice(i))}</span>`;
        }
      }
    }
    return e(raw);
  }

  // ── Layer Architecture chapter ──────────────────────────────────────────
  const overviewDiv = document.createElement("div");
  overviewDiv.id = "chapter-layers";
  overviewDiv.className = "chapter active";
  overviewDiv.innerHTML = buildOverviewHtml();
  // Inject the §17 SVG into the iframe via srcdoc (avoids attribute-escaping issues).
  const prescFrame = overviewDiv.querySelector("#prescriptive-iframe");
  if (prescFrame) prescFrame.srcdoc = PRESCRIPTIVE_HTML;
  content.appendChild(overviewDiv);

  // ── Control & Data Flow chapter ───────────────────────────────────────────
  const flowDiv = document.createElement("div");
  flowDiv.id = "chapter-flow";
  flowDiv.className = "chapter";
  flowDiv.innerHTML = buildFlowOverviewHtml();
  content.appendChild(flowDiv);

  // ── Arch Graph chapter (§10.1 D3 interactive, from iw index export --html) ─
  if (ARCH_REPORT_HTML) {
    const archDiv = document.createElement("div");
    archDiv.id = "chapter-arch-graph";
    archDiv.className = "chapter";
    archDiv.style.cssText = "padding:0;overflow:hidden;";
    archDiv.innerHTML = `<iframe style="width:100%;height:100%;border:none;" sandbox="allow-scripts allow-same-origin"><\/iframe>`;
    const archFrame = archDiv.querySelector("iframe");
    if (archFrame) (archFrame as any).srcdoc = ARCH_REPORT_HTML;
    content.appendChild(archDiv);
  }

  // ── Precompute cross-domain data for Phase 2 summary chapters ────────────
  function deriveDocViolations(): Array<{
    severity: string;
    ruleId: string;
    filePath: string;
    detail: string;
    chapterId: string;
  }> {
    const doc = (data as any).documentation;
    if (!doc) return [];
    const viols: Array<{
      severity: string;
      ruleId: string;
      filePath: string;
      detail: string;
      chapterId: string;
    }> = [];
    (doc.orphanedSections ?? []).forEach((s: any) =>
      viols.push({
        severity: "medium",
        ruleId: "doc.orphaned-section",
        filePath: s.docPath,
        detail: `Section "${s.heading.slice(0, 60)}" has ${s.ungroundedMentions} ungrounded mention(s)`,
        chapterId: "chapter-documentation",
      }),
    );
    (doc.terminology ?? []).forEach((t: any) =>
      viols.push({
        severity:
          t.severity === "critical"
            ? "high"
            : t.severity === "warning"
              ? "medium"
              : "low",
        ruleId: "doc.terminology",
        filePath: t.filePath,
        detail: `"${t.symbolName}" has ${t.variants.length} naming variants`,
        chapterId: "chapter-documentation",
      }),
    );
    (doc.docCompleteness ?? [])
      .filter((d: any) => d.completenessPercent < 40)
      .forEach((d: any) =>
        viols.push({
          severity: "medium",
          ruleId: "doc.completeness.low",
          filePath: d.docPath,
          detail: `Doc is ${d.completenessPercent}% complete (${d.coveredExports}/${d.totalRelevantExports} exports covered)`,
          chapterId: "chapter-documentation",
        }),
      );
    return viols;
  }
  const docViols = deriveDocViolations();
  const allViolations = data.violations ?? [];
  // Structural = rule/layer violations that are not behavioral
  const structViols = allViolations.filter(
    (v) => !v.ruleDomain || v.ruleDomain === "structural",
  );
  // Behavioral = Mermaid-derived violations (Phase 3)
  const behavViols = allViolations.filter((v) => v.ruleDomain === "behavioral");
  const dormantRules = (data.rules ?? []).filter((r) => r.count === 0);

  // ── Executive Summary chapter (Phase 2) ─────────────────────────────────
  const execSummaryDiv = document.createElement("div");
  execSummaryDiv.id = "chapter-executive-summary";
  execSummaryDiv.className = "chapter";
  execSummaryDiv.innerHTML = buildExecutiveSummaryHtml();
  content.appendChild(execSummaryDiv);

  // ── Recommendations chapter (Phase 2) ────────────────────────────────────
  const recoDiv = document.createElement("div");
  recoDiv.id = "chapter-recommendations";
  recoDiv.className = "chapter";
  recoDiv.innerHTML = buildRecommendationsHtml();
  content.appendChild(recoDiv);

  // ── Summary nav section ──────────────────────────────────────────────────
  const summaryNavSection = document.createElement("div");
  summaryNavSection.className = "nav-section";
  summaryNavSection.textContent = "Summary";
  nav.appendChild(summaryNavSection);
  const totalCrossIssues =
    structViols.length + behavViols.length + docViols.length;
  addNavItem(
    "Executive Summary",
    "📋",
    "chapter-executive-summary",
    totalCrossIssues > 0 ? String(totalCrossIssues) : undefined,
    totalCrossIssues === 0,
  );
  addNavItem("Recommendations", "🎯", "chapter-recommendations");

  // ── Intent section — what was declared ───────────────────────────────────
  const intentNavSection = document.createElement("div");
  intentNavSection.className = "nav-section";
  intentNavSection.textContent = "Intent";
  nav.appendChild(intentNavSection);

  // ── Rules Catalog chapter ─────────────────────────────────────────────────
  if (rulesCatalog?.rawYaml || (rulesCatalog?.rules?.length ?? 0) > 0) {
    const rulesDiv = document.createElement("div");
    rulesDiv.id = "chapter-rules-catalog";
    rulesDiv.className = "chapter";
    rulesDiv.innerHTML = buildRulesCatalogHtml();
    content.appendChild(rulesDiv);
    initRulesCatalogFilters();
    addNavItem(
      "Rules Catalog",
      "📚",
      "chapter-rules-catalog",
      rulesCatalog?.rules?.length
        ? String(rulesCatalog.rules.length)
        : undefined,
      (rulesCatalog?.rules?.length ?? 0) === 0,
    );
  }

  // ── Per-ADR behavioral flow chapters (sub-items under Intent) ─────────────
  adrRuleIds.forEach((ruleId) => {
    const rule = data.rules.find((r) => r.id === ruleId)!;
    const chapterId = "chapter-" + ruleId.replace(/[^a-z0-9]/gi, "-");
    const chDiv = document.createElement("div");
    chDiv.id = chapterId;
    chDiv.className = "chapter";
    chDiv.dataset.ruleId = ruleId;
    chDiv.dataset.flowPending = "1";
    chDiv.innerHTML = buildAdrChapterHtml(ruleId);
    content.appendChild(chDiv);

    const icon =
      rule.severity === "high"
        ? "🔴"
        : rule.severity === "medium"
          ? "🟡"
          : "🟢";
    const shortLabel = ruleId.length > 26 ? ruleId.slice(0, 24) + "…" : ruleId;
    const subEl = document.createElement("div");
    subEl.className = "nav-item sub";
    subEl.innerHTML =
      `<span class="nav-icon">${icon}</span>` +
      `<span>${esc(shortLabel)}</span>` +
      (rule.count > 0
        ? `<span class="nav-badge">${rule.count}</span>`
        : `<span class="nav-badge zero">✓</span>`);
    subEl.addEventListener("click", () => activateChapter(chapterId));
    nav.appendChild(subEl);
    navItems.push({ el: subEl, chapterId });
  });

  // ── Layer Architecture ────────────────────────────────────────────────────
  addNavItem("Layer Architecture", "🏛", "chapter-layers");

  // ── Evidence section — what was observed ─────────────────────────────────
  const evidenceNavSection = document.createElement("div");
  evidenceNavSection.className = "nav-section";
  evidenceNavSection.textContent = "Evidence";
  nav.appendChild(evidenceNavSection);

  // ── Documentation chapter (doc → code explorer) ───────────────────────────
  const dmData = (data as any).docMap;
  if (dmData && dmData.docs?.length > 0) {
    const dmDiv = document.createElement("div");
    dmDiv.id = "chapter-doc-map";
    dmDiv.className = "chapter";
    dmDiv.innerHTML = buildDocMapHtml();
    content.appendChild(dmDiv);
    setupDocMapChapter(dmDiv, dmData);
    const srcFiles = (dmData as any).sourceFiles as
      | Record<string, string>
      | undefined;
    if (srcFiles && Object.keys(srcFiles).length > 0) {
      setupARGlassesChapter(dmDiv, dmData);
    }
    const hotCount = dmData.hotSymbols?.length ?? 0;
    const srcCount2 = srcFiles ? Object.keys(srcFiles).length : 0;
    const badge =
      hotCount > 0
        ? String(hotCount) + " hot"
        : String(dmData.docs.length) + "+" + String(srcCount2);
    addNavItem("Documentation", "🗺", "chapter-doc-map", badge);
  }

  // ── Architecture Graph chapter ─────────────────────────────────────────────
  if (ARCH_REPORT_HTML) {
    addNavItem("Architecture", "🔬", "chapter-arch-graph");
  }

  // ── Code Structure chapter (dep depth · hubs · communities) ──────────────
  if ((data as any).hotspots) {
    const csDiv = document.createElement("div");
    csDiv.id = "chapter-code-structure";
    csDiv.className = "chapter";
    csDiv.innerHTML = buildCodeStructureHtml();
    content.appendChild(csDiv);
    addNavItem("Code Structure", "📐", "chapter-code-structure");
  }

  // ── Code Health chapter ────────────────────────────────────────────────────
  if ((data as any).codeHealth) {
    const chDiv2 = document.createElement("div");
    chDiv2.id = "chapter-code-health";
    chDiv2.className = "chapter";
    chDiv2.innerHTML = buildCodeHealthHtml();
    content.appendChild(chDiv2);
    const ch = (data as any).codeHealth as {
      cloneGroups: any[];
      structuralCloneGroups: any[];
      circularCycles: any[];
      unusedExports: any[];
      boundaryViolations: any[];
    };
    const issueCount =
      ch.cloneGroups.length +
      ch.circularCycles.length +
      ch.boundaryViolations.length;
    addNavItem(
      "Code Health",
      "🩺",
      "chapter-code-health",
      issueCount > 0 ? String(issueCount) : undefined,
    );
  }

  // ── Weave section — where intent and evidence meet ────────────────────────
  const weaveNavSection = document.createElement("div");
  weaveNavSection.className = "nav-section";
  weaveNavSection.textContent = "Weave";
  nav.appendChild(weaveNavSection);

  // ── Violations chapter ─────────────────────────────────────────────────────
  const violDiv = document.createElement("div");
  violDiv.id = "chapter-violations";
  violDiv.className = "chapter";
  violDiv.innerHTML = buildViolationsHtml();
  content.appendChild(violDiv);
  addNavItem(
    "Violations",
    "⚠️",
    "chapter-violations",
    totalViolations > 0 ? String(totalViolations) : undefined,
  );

  // ── Priority Files chapter (high-churn × low-coverage) ────────────────────
  if ((data as any).hotspots) {
    const pfDiv = document.createElement("div");
    pfDiv.id = "chapter-priority-files";
    pfDiv.className = "chapter";
    pfDiv.innerHTML = buildPriorityFilesHtml();
    content.appendChild(pfDiv);
    addNavItem("Priority Files", "🔥", "chapter-priority-files");
  }

  // ── Coverage chapter ───────────────────────────────────────────────────────
  const covDiv = document.createElement("div");
  covDiv.id = "chapter-coverage";
  covDiv.className = "chapter";
  covDiv.innerHTML = buildCoverageHtml();
  content.appendChild(covDiv);
  addNavItem("Coverage", "📊", "chapter-coverage");

  // ── Documentation Quality chapter ─────────────────────────────────────────
  if ((data as any).documentation) {
    const docDiv = document.createElement("div");
    docDiv.id = "chapter-documentation";
    docDiv.className = "chapter";
    docDiv.innerHTML = buildDocInsightsHtml();
    content.appendChild(docDiv);
    const docData = (data as any).documentation as {
      orphanedSections: any[];
      terminology: any[];
    };
    const docIssues =
      docData.orphanedSections.length + docData.terminology.length;
    addNavItem(
      "Doc Quality",
      "📝",
      "chapter-documentation",
      docIssues > 0 ? String(docIssues) : undefined,
    );
  }

  // ── Living Score chapter ───────────────────────────────────────────────────
  if ((data as any).livingScore) {
    const lsDiv = document.createElement("div");
    lsDiv.id = "chapter-living-score";
    lsDiv.className = "chapter";
    lsDiv.innerHTML = buildLivingScoreHtml();
    content.appendChild(lsDiv);
    const ls = (data as any).livingScore as { grade: string; score: number };
    addNavItem(
      "Living Score",
      "📈",
      "chapter-living-score",
      `${ls.grade} · ${Math.round(ls.score)}`,
    );
  }

  // ── Tech Debt chapter (19.8b) ──────────────────────────────────────────────
  if ((data as any).hotspots?.todos) {
    const tdDiv = document.createElement("div");
    tdDiv.id = "chapter-tech-debt";
    tdDiv.className = "chapter";
    tdDiv.innerHTML = buildTechDebtHtml();
    content.appendChild(tdDiv);
    const tdCount = ((data as any).hotspots.todos as { totalCount: number })
      .totalCount;
    addNavItem(
      "Tech Debt",
      "🔧",
      "chapter-tech-debt",
      tdCount > 0 ? String(tdCount) : undefined,
    );
  }

  // ── Surprising Links chapter (19.7) ────────────────────────────────────────
  if ((data as any).hotspots?.surprises?.length) {
    const srpDiv = document.createElement("div");
    srpDiv.id = "chapter-surprises";
    srpDiv.className = "chapter";
    srpDiv.innerHTML = buildSurprisesHtml();
    content.appendChild(srpDiv);
    const srpCount = ((data as any).hotspots.surprises as any[]).length;
    addNavItem("Surprising Links", "🔗", "chapter-surprises", String(srpCount));
  }

  // ── Rule Coverage chapter (19.6) ───────────────────────────────────────────
  if ((data as any).ruleCoverage) {
    const rcDiv = document.createElement("div");
    rcDiv.id = "chapter-rule-coverage";
    rcDiv.className = "chapter";
    rcDiv.innerHTML = buildRuleCoverageHtml();
    content.appendChild(rcDiv);
    const rcData = (data as any).ruleCoverage as { uncovered: any[] };
    addNavItem(
      "Rule Coverage",
      "🎯",
      "chapter-rule-coverage",
      rcData.uncovered.length > 0 ? String(rcData.uncovered.length) : undefined,
    );
  }

  // ── Design Rationale chapter (19.8a) ───────────────────────────────────────
  if ((data as any).documentation?.rationale?.length) {
    const drDiv = document.createElement("div");
    drDiv.id = "chapter-rationale";
    drDiv.className = "chapter";
    drDiv.innerHTML = buildDesignRationaleHtml();
    content.appendChild(drDiv);
    const rationaleCount = ((data as any).documentation.rationale as any[])
      .length;
    addNavItem(
      "Design Rationale",
      "💡",
      "chapter-rationale",
      String(rationaleCount),
    );
  }

  // ── Test Coverage chapter (19.8c) ───────────────────────────────────────────
  if ((data as any).testCoverage) {
    const tcDiv = document.createElement("div");
    tcDiv.id = "chapter-test-coverage";
    tcDiv.className = "chapter";
    tcDiv.innerHTML = buildTestCoverageHtml();
    content.appendChild(tcDiv);
    const tc = (data as any).testCoverage as {
      coveragePercent: number;
      untested: any[];
    };
    const tcBadge =
      tc.untested.length > 0 ? String(tc.untested.length) : undefined;
    addNavItem("Test Coverage", "🧪", "chapter-test-coverage", tcBadge);
  }

  // ── Call Graph chapter (19.1) ──────────────────────────────────────────────
  if ((data as any).callGraph?.callsTableActive) {
    const cgDiv = document.createElement("div");
    cgDiv.id = "chapter-call-graph";
    cgDiv.className = "chapter";
    cgDiv.dataset.cgPending = "1";
    cgDiv.innerHTML = buildCallGraphHtml();
    content.appendChild(cgDiv);
    const cgTotal: number = (data as any).callGraph?.total ?? 0;
    addNavItem(
      "Call Graph",
      "📞",
      "chapter-call-graph",
      cgTotal > 0 ? cgTotal.toLocaleString() : undefined,
    );
  }

  activateChapter("chapter-executive-summary");

  // ── Wire violation file-cell clicks → AR source viewer (19.3) ────────────
  // Delegated: all .viol-src-link cells across all violation tables
  document.addEventListener("click", (e: any) => {
    const cell = e.target.closest(".viol-src-link[data-src]");
    if (!cell) return;
    const srcPath: string = cell.dataset.src ?? "";
    if (!srcPath) return;
    // Navigate to the Documentation chapter (which hosts the AR source viewer)
    activateChapter("chapter-doc-map");
    // Open in AR source viewer if available
    const openFn = (globalThis as any).__openARSourceFile;
    if (typeof openFn === "function") {
      // Brief delay to allow chapter activation to render
      setTimeout(() => openFn(srcPath), 30);
    }
  });

  // ── Global Search (19.2) ─────────────────────────────────────────────────
  (function setupGlobalSearch() {
    const overlay = document.getElementById("gs-overlay") as any;
    const input = document.getElementById("gs-input") as any;
    const results = document.getElementById("gs-results") as any;
    const btn = document.getElementById("gs-btn") as any;
    const closeBtn = document.getElementById("gs-close") as any;
    if (!overlay || !input || !results) return;

    // Build in-memory search index at setup time
    type SearchItem = {
      icon: string;
      title: string;
      sub: string;
      chapterId: string;
      group: string;
    };
    const idx: SearchItem[] = [];

    // Nav chapters from DOM
    document.querySelectorAll(".nav-item[data-chapter]").forEach((el: any) => {
      idx.push({
        icon: el.querySelector(".nav-icon")?.textContent ?? "📄",
        title: el.dataset.label ?? el.textContent.trim(),
        sub: "Chapter",
        chapterId: el.dataset.chapter,
        group: "Chapters",
      });
    });
    // Violations
    if ((DATA as any).violations) {
      for (const v of (DATA as any).violations as any[]) {
        idx.push({
          icon: "⚠️",
          title: v.ruleId ?? "Violation",
          sub: (v.filePath ?? "").split("/").pop() ?? "",
          chapterId: "chapter-violations",
          group: "Violations",
        });
      }
    }
    // Rules catalog
    if ((DATA as any).rulesCatalog?.rules) {
      for (const r of (DATA as any).rulesCatalog.rules as any[]) {
        idx.push({
          icon: "📐",
          title: r.id,
          sub: r.description ?? "",
          chapterId: "chapter-rules-catalog",
          group: "Rules",
        });
      }
    }
    // Source files
    if ((DATA as any).docMap?.sourceFiles) {
      for (const fp of Object.keys((DATA as any).docMap.sourceFiles)) {
        idx.push({
          icon: "📁",
          title: fp.split("/").pop() ?? fp,
          sub: fp,
          chapterId: "chapter-doc-map",
          group: "Files",
        });
      }
    }

    function openOverlay() {
      overlay.showModal();
      input.value = "";
      results.innerHTML = `<div class="gs-empty">Start typing to search…</div>`;
      setTimeout(() => input.focus(), 20);
    }
    function closeOverlay() {
      overlay.close();
    }

    btn?.addEventListener("click", openOverlay);
    closeBtn?.addEventListener("click", closeOverlay);
    overlay.addEventListener("click", (e: any) => {
      if (e.target === overlay) closeOverlay();
    });

    // Cmd+K / Ctrl+K
    document.addEventListener("keydown", (e: any) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openOverlay();
      }
      if (e.key === "Escape" && overlay.open) closeOverlay();
    });

    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        results.innerHTML = `<div class="gs-empty">Start typing to search…</div>`;
        return;
      }
      const matches = idx
        .filter(
          (i) =>
            i.title.toLowerCase().includes(q) ||
            i.sub.toLowerCase().includes(q),
        )
        .slice(0, 40);
      if (!matches.length) {
        results.innerHTML = `<div class="gs-empty">No results for "${q}"</div>`;
        return;
      }

      // Group results
      const grouped = new Map<string, SearchItem[]>();
      for (const m of matches) {
        const arr = grouped.get(m.group) ?? [];
        arr.push(m);
        grouped.set(m.group, arr);
      }
      let html = "";
      for (const [grp, items] of grouped) {
        html += `<div class="gs-group">${grp}</div>`;
        for (const item of items.slice(0, 8)) {
          html += `<div class="gs-item" data-chapter="${item.chapterId}">
            <span class="gs-icon">${item.icon}</span>
            <span class="gs-title">${item.title}</span>
            <span class="gs-sub">${item.sub}</span>
          </div>`;
        }
      }
      results.innerHTML = html;

      // Click navigates
      results.querySelectorAll(".gs-item[data-chapter]").forEach((el: any) => {
        el.addEventListener("click", () => {
          activateChapter(el.dataset.chapter);
          closeOverlay();
        });
      });

      // Arrow key navigation
      results
        .querySelectorAll(".gs-item")
        .forEach((el: any, i: number, all: any) => {
          el.addEventListener("keydown", (e: any) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              all[i + 1]?.focus();
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              (i > 0 ? all[i - 1] : input).focus();
            }
            if (e.key === "Enter") {
              el.click();
            }
          });
          el.tabIndex = 0;
        });
    });

    // Arrow down from input into first result
    input.addEventListener("keydown", (e: any) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        (results.querySelector(".gs-item") as any)?.focus();
      }
    });
  })();

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
      <h1 class="chapter-title">🏛 Layer Architecture</h1>
      <p class="chapter-subtitle">Declared layer topology and rule conformance · ${data.meta.generated}</p>
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

  // ── Control & Data Flow overview HTML builder ─────────────────────────────
  function buildFlowOverviewHtml(): string {
    const totalFlowViolations = data.rules.reduce(
      (s, r) => s + (r.count ?? 0),
      0,
    );
    const ruleRows = data.rules
      .map((r) => {
        const sev =
          r.severity === "high"
            ? `<span class="badge high">HIGH</span>`
            : r.severity === "medium"
              ? `<span class="badge medium">MED</span>`
              : `<span class="badge low">LOW</span>`;
        const chapterId = "chapter-" + r.id.replace(/[^a-z0-9]/gi, "-");
        const hasChapter = adrRuleIds.includes(r.id);
        const link = hasChapter
          ? `<span class="btn-goto" onclick="activateChapter('${chapterId}')">View flow →</span>`
          : "";
        const countBadge =
          r.count > 0
            ? `<span class="badge high">${r.count}</span>`
            : `<span class="badge ok">✓ OK</span>`;
        return `<tr>
        <td>${sev}</td>
        <td style="font-weight:600">${esc(r.id)}</td>
        <td style="color:#6b7280;font-size:11px">${esc(r.description?.split("\n")[0].slice(0, 80) ?? "")}</td>
        <td>${countBadge}</td>
        <td>${link}</td>
      </tr>`;
      })
      .join("");
    const emptyState =
      data.rules.length === 0
        ? `<p style="color:#6b7280;font-style:italic;padding:24px 0">No flow rules defined. Add rules to <code>.iw/rules.yaml</code> to describe control and data flows.</p>`
        : "";
    return `<div class="chapter-header">
      <h1 class="chapter-title">🔀 Control & Data Flow</h1>
      <p class="chapter-subtitle">Defined flow rules · ${adrRuleIds.length} interactive flow(s) · ${totalFlowViolations} violation(s)</p>
    </div>
    <div class="chapter-body">
      ${emptyState}
      ${
        data.rules.length > 0
          ? `
      <table class="violations-table" style="margin-bottom:24px">
        <thead><tr>
          <th>Severity</th><th>Rule ID</th><th>Description</th><th>Violations</th><th></th>
        </tr></thead>
        <tbody>${ruleRows}</tbody>
      </table>
      <p style="font-size:11px;color:#6b7280">Click <em>View flow</em> to open the interactive flow diagram for that rule. Sub-items in the sidebar provide direct access to each flow.</p>
      `
          : ""
      }
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
    const catalogRuleIds = new Set(
      (rulesCatalog?.rules ?? []).map((r) => r.id),
    );
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

    const structTotal =
      data.meta.totalRuleViolations + data.meta.totalLayerViolations;

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">⚠️ All Violations</h1>
      <p class="chapter-subtitle">${structTotal} structural · ${behavViols.length} behavioral · ${docViols.length} documentary</p>
    </div>
    <div class="chapter-body">`;

    // ── Structural Domain ─────────────────────────────────────────────────
    h += `<div class="domain-group">
      <div class="domain-group-header">
        <span style="font-size:18px">🔧</span>
        <h2>Structural</h2>
        <span style="margin-left:4px;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${structTotal === 0 ? "#dcfce7" : "#fee2e2"};color:${structTotal === 0 ? "#166534" : "#991b1b"}">${structTotal}</span>
        <span style="font-size:11px;color:#6b7280;margin-left:4px">rule violations + layer boundary violations</span>
      </div>`;
    if (sortedRules.length === 0 && data.meta.totalLayerViolations === 0) {
      h += `<div style="padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">✅ No structural violations. All rules pass.</div>`;
    } else {
      sortedRules.forEach((rule) => {
        const ruleViols = byRule.get(rule.id) ?? [];
        const violChId = "chapter-" + rule.id.replace(/[^a-z0-9]/gi, "-");
        const hasAdrCh = adrRuleIds.includes(rule.id);
        const hasRuleCard = catalogRuleIds.has(rule.id);
        h += `<div class="viol-section">
          <h3>${sev(rule.severity)} ${esc(rule.id)} ${rule.adr ? `<span style="font-weight:400;font-size:11px;color:#6b7280">${esc(rule.adr)}</span>` : ""}
            <span style="font-size:11px;font-weight:400;color:#6b7280">&nbsp;· ${rule.count} violation${rule.count !== 1 ? "s" : ""}</span>
            ${hasRuleCard ? `<button class="btn-goto" onclick="jumpToRuleCatalog('${esc(rule.id)}')">↗ Rule card</button>` : ""}
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
              <td class="td-file viol-src-link" data-src="${esc(v.filePath)}" title="${esc(v.filePath)} (click to open in source viewer)">${esc(shortPath(v.filePath))}</td>
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
      if (data.meta.totalLayerViolations > 0) {
        h += `<div class="viol-section">
          <h3><span class="badge high">HIGH</span> Layer Boundary Violations
            <span style="font-size:11px;font-weight:400;color:#6b7280">&nbsp;· ${data.meta.totalLayerViolations} violation${data.meta.totalLayerViolations !== 1 ? "s" : ""}</span>
          </h3>
          <p style="font-size:12px;color:#6b7280;margin:0 0 8px">Files importing across layer boundaries in the wrong direction.</p>
          <p style="font-size:11px;color:#9ca3af">Run <code>iw index layers-check</code> for the full list, or open the Layer Architecture chapter for a visual overview.</p>
          <button class="btn-goto" style="margin-left:0;margin-top:8px" onclick="activateChapter('chapter-layers')">View Layer Architecture →</button>
        </div>`;
      }
    }
    h += `</div>`;

    // ── Behavioral Domain ──────────────────────────────────────────────────
    const behavCount = behavViols.length;
    h += `<div class="domain-group">
      <div class="domain-group-header">
        <span style="font-size:18px">🔀</span>
        <h2>Behavioral</h2>
        <span style="margin-left:4px;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${behavCount === 0 ? "#dcfce7" : "#fee2e2"};color:${behavCount === 0 ? "#166534" : "#991b1b"}">${behavCount}</span>
        <span style="font-size:11px;color:#6b7280;margin-left:4px">Mermaid call-path and sequence rule violations</span>
      </div>`;
    if (behavCount === 0) {
      h += `<div style="padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">
        ✅ No behavioral violations detected.
        <span style="color:#9ca3af;margin-left:4px">Add a <code>domain: behavioral</code> rule with a <code>mermaid:</code> block to <code>.iw/rules.yaml</code> to enforce call sequences.</span>
      </div>`;
    } else {
      // Group by ruleId
      const behavByRule = new Map<string, typeof behavViols>();
      behavViols.forEach((v) => {
        const arr = behavByRule.get(v.ruleId) ?? [];
        arr.push(v);
        behavByRule.set(v.ruleId, arr);
      });
      behavByRule.forEach((viols, ruleId) => {
        const confidence = viols[0]?.confidence;
        const mode = viols[0]?.ruleMode ?? "warn";
        const sevLabel = sev(viols[0]?.severity ?? "medium");
        const hasRuleCard = catalogRuleIds.has(ruleId);
        h += `<div class="viol-section">
          <h3>${sevLabel} ${esc(ruleId)}
            <span style="font-size:11px;font-weight:400;color:#6b7280">&nbsp;· ${viols.length} violation${viols.length !== 1 ? "s" : ""}</span>
            ${hasRuleCard ? `<button class="btn-goto" onclick="jumpToRuleCatalog('${esc(ruleId)}')">↗ Rule card</button>` : ""}
            ${mode === "warn" ? `<span style="font-size:10px;padding:1px 6px;border-radius:999px;background:#fef3c7;color:#92400e;margin-left:6px">WARN</span>` : ""}
            ${confidence !== undefined ? `<span style="font-size:10px;padding:1px 6px;border-radius:999px;background:#f3f4f6;color:#6b7280;margin-left:4px">conf ${confidence.toFixed(2)}</span>` : ""}
          </h3>
          <div class="violations-table-wrap"><table class="violations-table"><thead><tr>
            <th>File</th><th>Symbol</th><th>Detail</th>
          </tr></thead><tbody>`;
        viols.slice(0, 20).forEach((v) => {
          h += `<tr>
            <td class="td-file viol-src-link" data-src="${esc(v.filePath)}" title="${esc(v.filePath)} (click to open in source viewer)">${esc(shortPath(v.filePath))}</td>
            <td style="font-family:ui-monospace,monospace;font-size:10px">${v.symbol ? esc(v.symbol) : "—"}</td>
            <td class="td-detail">${esc(v.detail.slice(0, 150))}${v.detail.length > 150 ? "…" : ""}</td>
          </tr>`;
        });
        h += `</tbody></table></div>`;
        if (viols.length > 20) {
          h += `<p style="font-size:11px;color:#9ca3af;margin:4px 0 0">Showing 20 of ${viols.length}. Run <code>iw intent check --domain behavioral</code> for full output.</p>`;
        }
        h += `</div>`;
      });
    }
    h += `</div>`;

    // ── Documentary Domain ────────────────────────────────────────────────
    h += `<div class="domain-group">
      <div class="domain-group-header">
        <span style="font-size:18px">📝</span>
        <h2>Documentary</h2>
        <span style="margin-left:4px;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${docViols.length === 0 ? "#dcfce7" : "#fff7ed"};color:${docViols.length === 0 ? "#166534" : "#92400e"}">${docViols.length}</span>
        <span style="font-size:11px;color:#6b7280;margin-left:4px">coverage, completeness &amp; terminology violations</span>
        <button class="btn-goto" onclick="activateChapter('chapter-documentation')" style="margin-left:auto">↗ Documentation chapter</button>
      </div>`;
    if (docViols.length === 0) {
      h += `<div style="padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">✅ No documentary violations detected.</div>`;
    } else {
      // Group by ruleId
      const docByRule = new Map<string, typeof docViols>();
      docViols.forEach((v) => {
        const arr = docByRule.get(v.ruleId) ?? [];
        arr.push(v);
        docByRule.set(v.ruleId, arr);
      });
      const docRuleLabels: Record<string, string> = {
        "doc.orphaned-section": "Orphaned Doc Sections",
        "doc.terminology": "Terminology Inconsistencies",
        "doc.completeness.low": "Incomplete Documents",
        "doc.coverage.low": "Low-Coverage Modules",
      };
      docByRule.forEach((viols, ruleId) => {
        const label = docRuleLabels[ruleId] ?? ruleId;
        const topSev = viols.some((v) => v.severity === "high")
          ? "high"
          : viols.some((v) => v.severity === "medium")
            ? "medium"
            : "low";
        const hasRuleCard = catalogRuleIds.has(ruleId);
        h += `<div class="viol-section">
          <h3>${sev(topSev)} ${esc(label)}
            <span style="font-size:11px;font-weight:400;color:#6b7280">&nbsp;· ${viols.length} violation${viols.length !== 1 ? "s" : ""}</span>
            ${hasRuleCard ? `<button class="btn-goto" onclick="jumpToRuleCatalog('${esc(ruleId)}')">↗ Rule card</button>` : ""}
          </h3>
          <div class="violations-table-wrap"><table class="violations-table"><thead><tr>
            <th>Severity</th><th>File</th><th>Detail</th>
          </tr></thead><tbody>`;
        viols.slice(0, 20).forEach((v) => {
          h += `<tr>
            <td>${sev(v.severity)}</td>
            <td class="td-file viol-src-link" data-src="${esc(v.filePath)}" title="${esc(v.filePath)} (click to open in source viewer)">${esc(shortPath(v.filePath))}</td>
            <td class="td-detail">${esc(v.detail)}</td>
          </tr>`;
        });
        h += `</tbody></table></div>`;
        if (viols.length > 20) {
          h += `<p style="font-size:11px;color:#9ca3af;margin:4px 0 0">Showing 20 of ${viols.length} violations. See Documentation chapter for full details.</p>`;
        }
        h += `</div>`;
      });
    }
    h += `</div>`;

    // ── Dormant Rules ────────────────────────────────────────────────────
    if (dormantRules.length > 0) {
      h += `<div style="margin-top:8px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
        <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:8px">🔕 Dormant Rules <span style="font-size:11px;font-weight:400;color:#9ca3af">(currently passing — ${dormantRules.length} rule${dormantRules.length !== 1 ? "s" : ""})</span></div>
        <p style="font-size:11px;color:#6b7280;margin:0 0 8px">These rules have zero violations. They may be correctly satisfied, or possibly stale / too permissive.</p>
        <div style="display:flex;flex-wrap:wrap">`;
      dormantRules.forEach((r) => {
        h += `<span class="dormant-rule-chip">✓ ${esc(r.id)}</span>`;
      });
      h += `</div></div>`;
    }

    h += `</div>`;
    return h;
  }

  // ── Rules Catalog chapter ───────────────────────────────────────────────
  function buildRulesCatalogHtml(): string {
    const rules = rulesCatalog?.rules ?? [];
    const bySeverity = { high: 0, medium: 0, low: 0 };
    const byDomain = { structural: 0, behavioral: 0, documentary: 0 };
    let mermaidCount = 0;
    let cypherCount = 0;

    for (const r of rules) {
      const sev = r.severity ?? "low";
      if (sev === "high" || sev === "medium" || sev === "low") {
        bySeverity[sev] += 1;
      }
      const dom = (r.domain ?? "structural") as
        | "structural"
        | "behavioral"
        | "documentary";
      if (dom in byDomain) byDomain[dom] += 1;
      if (r.mermaid) mermaidCount += 1;
      for (const f of r.forbidden ?? []) {
        if (f && String((f as any).type) === "cypher") cypherCount += 1;
      }
    }

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">📚 Rules Catalog</h1>
      <p class="chapter-subtitle">Full text of intent rules, with Mermaid and Cypher blocks rendered for review</p>
    </div>
    <div class="chapter-body">`;

    h += `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      <span class="badge info">rules ${rules.length}</span>
      <span class="badge high">high ${bySeverity.high}</span>
      <span class="badge medium">medium ${bySeverity.medium}</span>
      <span class="badge low">low ${bySeverity.low}</span>
      <span class="badge info">structural ${byDomain.structural}</span>
      <span class="badge" style="background:#f3e8ff;color:#6b21a8">behavioral ${byDomain.behavioral}</span>
      <span class="badge" style="background:#ecfeff;color:#155e75">documentary ${byDomain.documentary}</span>
      <span class="badge" style="background:#dcfce7;color:#166534">mermaid ${mermaidCount}</span>
      <span class="badge" style="background:#fef3c7;color:#92400e">cypher ${cypherCount}</span>
    </div>`;

    h += `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">
      <span style="font-size:11px;font-weight:700;color:#334155">Filter</span>
      <label style="font-size:11px;color:#475569">Domain
        <select id="rules-filter-domain" style="margin-left:4px;font-size:11px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px;background:#fff">
          <option value="all">all</option>
          <option value="structural">structural</option>
          <option value="behavioral">behavioral</option>
          <option value="documentary">documentary</option>
        </select>
      </label>
      <label style="font-size:11px;color:#475569">Severity
        <select id="rules-filter-severity" style="margin-left:4px;font-size:11px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px;background:#fff">
          <option value="all">all</option>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#475569"><input id="rules-filter-mermaid" type="checkbox">has Mermaid</label>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#475569"><input id="rules-filter-cypher" type="checkbox">has Cypher</label>
      <button id="rules-filter-clear" class="btn-goto" style="margin-left:4px">Reset</button>
      <span id="rules-filter-count" style="margin-left:auto;font-size:11px;color:#64748b">${rules.length}/${rules.length} rules</span>
    </div>`;

    if (rules.length === 0 && !rulesCatalog?.rawYaml) {
      h += `<div style="padding:18px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;color:#6b7280;font-size:13px">
        No rules catalog was bundled. Add <code>.iw/rules.yaml</code> and rebuild with <code>iw index export --book</code>.
      </div>`;
      h += `</div>`;
      return h;
    }

    const sorted = [...rules].sort((a, b) => {
      const ord = { high: 0, medium: 1, low: 2 } as const;
      const sa = ord[(a.severity ?? "low") as "high" | "medium" | "low"];
      const sb = ord[(b.severity ?? "low") as "high" | "medium" | "low"];
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });

    for (const rule of sorted) {
      const dom = rule.domain ?? "structural";
      const mode = rule.mode ?? "error";
      const forbidden = rule.forbidden ?? [];
      const hasMermaid = Boolean(rule.mermaid);
      const cypherBlocks = forbidden
        .filter((f) => String((f as any).type) === "cypher")
        .map((f) => String((f as any).query ?? "").trim())
        .filter(Boolean);
      const hasCypher = cypherBlocks.length > 0;

      h += `<div class="rules-card" id="${ruleCardDomId(rule.id)}" data-rule-id="${esc(rule.id)}" data-domain="${esc(dom)}" data-severity="${esc(rule.severity ?? "low")}" data-has-mermaid="${hasMermaid ? "1" : "0"}" data-has-cypher="${hasCypher ? "1" : "0"}" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          ${sev(rule.severity ?? "low")}
          <span class="badge info" style="text-transform:uppercase">${esc(dom)}</span>
          <span class="badge ${mode === "warn" ? "medium" : "ok"}">${mode.toUpperCase()}</span>
          <span style="font:700 12px ui-monospace,monospace;color:#0f172a">${esc(rule.id)}</span>
          ${rule.adr ? `<span class="badge" style="background:#e0f2fe;color:#0c4a6e">${esc(rule.adr)}</span>` : ""}
        </div>
        ${rule.description ? `<div style="font-size:12px;color:#374151;line-height:1.5;margin-bottom:8px">${esc(rule.description)}</div>` : ""}`;

      if (rule.sourceType) {
        h += `<div style="font-size:11px;color:#64748b;margin-bottom:8px">
          Source: <b>${esc(rule.sourceType)}</b>
          ${rule.sourceFile ? ` · file <code>${esc(rule.sourceFile)}</code>` : ""}
          ${rule.sourceBlockId ? ` · block <code>${esc(rule.sourceBlockId)}</code>` : ""}
        </div>`;
      }

      if (rule.mermaid) {
        h += `<div style="margin:8px 0 10px;padding:10px;border:1px solid #bbf7d0;background:#f0fdf4;border-radius:8px">
          <div style="font-size:11px;font-weight:700;color:#166534;margin-bottom:7px">Mermaid Render</div>
          ${renderMermaidPreview(rule.mermaid)}
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:11px;color:#166534">Show Mermaid source</summary>
            <pre style="margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,monospace;background:#052e16;color:#dcfce7;border-radius:8px;padding:10px">${esc(rule.mermaid)}</pre>
          </details>
        </div>`;
      }

      if (cypherBlocks.length > 0) {
        cypherBlocks.forEach((query, idx) => {
          const clauses = splitCypherClauses(query);
          h += `<div style="margin:8px 0 10px;padding:10px;border:1px solid #fde68a;background:#fffbeb;border-radius:8px">
            <div style="font-size:11px;font-weight:700;color:#92400e;margin-bottom:7px">Cypher Render${cypherBlocks.length > 1 ? ` #${idx + 1}` : ""}</div>`;
          if (clauses.length > 0) {
            h += `<div style="display:grid;grid-template-columns:120px 1fr;gap:6px 8px;font-size:11px;margin-bottom:8px">`;
            clauses.forEach((c) => {
              h += `<div style="font:700 10px ui-monospace,monospace;color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:4px 6px;align-self:start">${esc(c.key)}</div>
                <div style="font:500 11px ui-monospace,monospace;color:#78350f;line-height:1.45;background:#fff;border:1px solid #fde68a;border-radius:6px;padding:4px 6px">${esc(c.value || "(empty)")}</div>`;
            });
            h += `</div>`;
          }
          h += `<details>
            <summary style="cursor:pointer;font-size:11px;color:#92400e">Show Cypher source</summary>
            <pre style="margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,monospace;background:#422006;color:#fef3c7;border-radius:8px;padding:10px">${esc(query)}</pre>
          </details>
          </div>`;
        });
      }

      if (forbidden.length > 0) {
        h += `<details>
          <summary style="cursor:pointer;font-size:11px;color:#475569">Show forbidden clauses (${forbidden.length})</summary>
          <div style="margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;overflow:auto">
            <table style="width:100%;border-collapse:collapse;font-size:11px;background:#fff">
              <thead><tr style="background:#f8fafc">
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0">Type</th>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0">Scope / Pattern</th>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0">Notes</th>
              </tr></thead><tbody>`;
        forbidden.forEach((f) => {
          const type = String((f as any).type ?? "-");
          const scope = String((f as any).in ?? "all");
          const pattern =
            (f as any).pattern ??
            (f as any).callee ??
            (f as any).chain ??
            (f as any).value_pattern ??
            (f as any).root ??
            "—";
          const notesBits: string[] = [];
          if ((f as any).target_layer)
            notesBits.push(`target_layer=${String((f as any).target_layer)}`);
          if ((f as any).context_import)
            notesBits.push(
              `context_import=${String((f as any).context_import)}`,
            );
          if ((f as any).context_access)
            notesBits.push(
              `context_access=${String((f as any).context_access)}`,
            );
          if ((f as any).min_depth !== undefined)
            notesBits.push(`min_depth=${String((f as any).min_depth)}`);
          if ((f as any).except_symbol)
            notesBits.push(
              `except_symbol=${JSON.stringify((f as any).except_symbol)}`,
            );
          const notes = notesBits.length ? notesBits.join("; ") : "—";
          h += `<tr>
            <td style="padding:6px 8px;border-top:1px solid #f1f5f9;font:600 10px ui-monospace,monospace">${esc(type)}</td>
            <td style="padding:6px 8px;border-top:1px solid #f1f5f9;font:500 10px ui-monospace,monospace">in=${esc(scope)} · ${esc(String(pattern))}</td>
            <td style="padding:6px 8px;border-top:1px solid #f1f5f9;color:#64748b">${esc(notes)}</td>
          </tr>`;
        });
        h += `</tbody></table>
          </div>
        </details>`;
      }

      h += `</div>`;
    }

    if (rulesCatalog?.rawYaml) {
      h += `<details style="margin-top:12px" open>
        <summary style="cursor:pointer;font-size:12px;font-weight:700;color:#334155">Full rules.yaml text${rulesCatalog.configPath ? ` · <span style="font-weight:500;color:#64748b">${esc(rulesCatalog.configPath)}</span>` : ""}</summary>
        <pre style="margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,monospace;background:#0b1220;color:#dbeafe;border-radius:10px;padding:12px;border:1px solid #1e293b;max-height:420px;overflow:auto">${esc(rulesCatalog.rawYaml)}</pre>
      </details>`;
    }

    h += `</div>`;
    return h;
  }

  // ── Documentation Map chapter ─────────────────────────────────────────────
  function buildDocMapHtml(): string {
    const dm = (data as any).docMap as
      | {
          docs: Array<{
            path: string;
            content: string;
            uniqueSymbols: number;
            uniqueSourceFiles: number;
            referencedPackages: string[];
            topAnnotations: Array<{
              symbolName: string;
              symbolKind: string;
              symbolFile: string;
              symbolLine: number;
              confidence: number;
              docLine: number;
              text: string;
              source: string;
            }>;
          }>;
          totalAnnotations: number;
          hotSymbols: Array<{
            name: string;
            kind: string;
            file: string;
            docCount: number;
            docs: string[];
          }>;
        }
      | undefined;
    if (!dm || dm.docs.length === 0) {
      return `<div class="chapter-header">
        <h1 class="chapter-title">🗺 Documentation Map</h1>
        <p class="chapter-subtitle">No documentation data available — run <code>iw index build</code> first</p>
      </div>`;
    }

    const { docs, totalAnnotations, hotSymbols } = dm;
    const totalDocFiles = docs.length;
    const allPkgs = new Set<string>();
    docs.forEach((d) =>
      d.referencedPackages.forEach((p: string) => allPkgs.add(p)),
    );

    function docTitle(docPath: string): string {
      const base = docPath.split("/").pop() ?? docPath;
      return base.replace(/\.md$/i, "").replace(/[-_]/g, " ");
    }

    // Two-panel layout: split sidebar (docs top / source bottom) + shared viewer.
    const srcCount = Object.keys((dm as any)?.sourceFiles ?? {}).length;
    const subtitle =
      srcCount > 0
        ? `${totalDocFiles} doc files · ${srcCount} source files · ${totalAnnotations.toLocaleString()} annotations · powered by CARI`
        : `${totalDocFiles} doc files · ${totalAnnotations.toLocaleString()} annotations · ${allPkgs.size} packages referenced · powered by CARI`;
    return `<div class="chapter-header">
      <h1 class="chapter-title">🗺 Documentation &amp; Source</h1>
      <p class="chapter-subtitle">${subtitle}</p>
    </div>
    <div id="docmap-layout" style="display:grid;grid-template-columns:260px 1fr;height:calc(100vh - 168px);min-height:500px;overflow:hidden;border:1px solid #e2e8f0;border-radius:10px;background:#fff;margin-top:16px">
      <div id="docmap-sidebar" style="border-right:1px solid #e2e8f0;background:#f8fafc;display:flex;flex-direction:column;overflow:hidden">
        <div id="docmap-docs-section" style="flex:0 0 50%;overflow-y:auto;border-bottom:2px solid #cbd5e1;min-height:0;display:flex;flex-direction:column">
          <div style="padding:4px 10px 3px;font-size:9px;font-weight:800;color:#475569;background:#f1f5f9;border-bottom:1px solid #e2e8f0;letter-spacing:0.07em;text-transform:uppercase;flex-shrink:0">📄 Docs</div>
        </div>
        <div id="docmap-src-section" style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0">
          <div style="padding:4px 10px 3px;font-size:9px;font-weight:800;color:#0369a1;background:#f0f9ff;border-bottom:1px solid #bae6fd;letter-spacing:0.07em;text-transform:uppercase;flex-shrink:0">🔍 Source</div>
        </div>
      </div>
      <div id="docmap-viewer" style="display:flex;flex-direction:column;overflow:hidden;position:relative"></div>
    </div>`;
  }

  // ── AR Evidence Glasses chapter HTML builder ──────────────────────────────
  function buildARGlassesHtml(): string {
    const dm = (data as any).docMap;
    const srcCount = Object.keys(
      (dm?.sourceFiles as Record<string, string>) ?? {},
    ).length;
    const totalAnns: number = dm?.totalAnnotations ?? 0;
    return `<div class="chapter-header">
      <h1 class="chapter-title">🔍 AR Evidence Glasses</h1>
      <p class="chapter-subtitle">${srcCount} source files · ${totalAnns.toLocaleString()} annotations · source-first evidence exploration · powered by CARI</p>
    </div>
    <div id="ar-layout" style="display:grid;grid-template-columns:260px 1fr;height:calc(100vh - 168px);min-height:500px;overflow:hidden;border:1px solid #e2e8f0;border-radius:10px;background:#fff;margin-top:16px">
      <div id="ar-sidebar" style="border-right:1px solid #e2e8f0;overflow:hidden;background:#f8fafc;display:flex;flex-direction:column"></div>
      <div id="ar-viewer" style="display:flex;flex-direction:column;overflow:hidden;position:relative;background:#fff"></div>
    </div>`;
  }

  // ── Documentation Map interactive setup (runs after innerHTML is set) ─────
  function setupDocMapChapter(container: any, dm: any): void {
    const sidebar = container.querySelector("#docmap-docs-section");
    const viewer = container.querySelector("#docmap-viewer");
    if (!sidebar || !viewer || !dm?.docs?.length) return;

    // Local helpers
    function docTitle(docPath: string): string {
      const base = docPath.split("/").pop() ?? docPath;
      return base.replace(/\.md$/i, "").replace(/[-_]/g, " ");
    }
    function shortPkg(pkg: string): string {
      return pkg.replace("packages/", "").replace("apps/", "app:");
    }
    function pkgColor(pkg: string): string {
      const palette = [
        "#dbeafe:#1d4ed8",
        "#fce7f3:#9d174d",
        "#dcfce7:#15803d",
        "#fff7ed:#9a3412",
        "#f3e8ff:#7c3aed",
        "#e0f2fe:#0284c7",
        "#fef9c3:#92400e",
        "#ffedd5:#c2410c",
        "#f0fdf4:#166534",
        "#fdf4ff:#86198f",
        "#ecfeff:#0e7490",
        "#fafaf9:#44403c",
      ];
      let hh = 0;
      for (let i = 0; i < pkg.length; i++)
        hh = (hh * 31 + pkg.charCodeAt(i)) & 0xffff;
      const pair = palette[hh % palette.length];
      const [bg, fg] = pair.split(":");
      return `background:${bg};color:${fg}`;
    }

    // Inject doc-map specific styles once
    if (!document.getElementById("docmap-styles")) {
      const s = document.createElement("style");
      s.id = "docmap-styles";
      s.textContent = `
        .dm-nav-item { padding:10px 14px; cursor:pointer; border-left:3px solid transparent;
          transition:background 0.12s,border-color 0.12s; }
        .dm-nav-item:hover { background:#f1f5f9; }
        .dm-nav-item.active { background:#eff6ff; border-left-color:#3b82f6; }
        .dm-nav-item .dm-nav-title { font-size:12px;font-weight:700;color:#1e293b;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .dm-nav-item .dm-nav-path { font-size:10px;color:#94a3b8;margin-top:1px;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .dm-nav-item .dm-nav-badges { display:flex;gap:4px;margin-top:4px;flex-wrap:wrap; }
        .dm-md { font-size:13px;line-height:1.75;color:#1f2937;padding:20px 28px 32px;
          overflow-y:auto;flex:1;min-height:0; }
        .dm-md h1 { font-size:1.5em;font-weight:800;border-bottom:2px solid #e2e8f0;
          padding-bottom:8px;margin:0 0 20px; }
        .dm-md h2 { font-size:1.2em;font-weight:700;border-bottom:1px solid #f1f5f9;
          padding-bottom:6px;margin:28px 0 12px; }
        .dm-md h3 { font-size:1.05em;font-weight:700;margin:20px 0 8px;color:#374151; }
        .dm-md h4,h5,h6 { font-size:0.95em;font-weight:700;margin:16px 0 6px;color:#6b7280; }
        .dm-md p { margin:0 0 12px; }
        .dm-md ul,ol { padding-left:24px;margin:0 0 12px; }
        .dm-md li { margin:2px 0; }
        .dm-md pre { background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;
          padding:14px 16px;overflow-x:auto;margin:12px 0;font-size:12px;line-height:1.5; }
        .dm-md pre code { background:none;border:none;padding:0;font-size:inherit; }
        .dm-md code { background:#f1f5f9;border-radius:4px;padding:1px 5px;
          font-family:ui-monospace,monospace;font-size:0.88em;color:#0f172a; }
        .dm-md blockquote { border-left:4px solid #e2e8f0;margin:12px 0;padding:6px 16px;
          color:#6b7280;font-style:italic;background:#f8fafc;border-radius:0 6px 6px 0; }
        .dm-md table { border-collapse:collapse;width:100%;margin:12px 0;font-size:12px; }
        .dm-md th { background:#f8fafc;font-weight:700;padding:6px 10px;
          border:1px solid #e2e8f0;text-align:left; }
        .dm-md td { padding:5px 10px;border:1px solid #e2e8f0; }
        .dm-md tr:nth-child(even) td { background:#fafafa; }
        .dm-md hr { border:none;border-top:1px solid #e2e8f0;margin:20px 0; }
        .dm-md strong { font-weight:700; }
        .dm-md a { color:#3b82f6;text-decoration:none; }
        .dm-md a:hover { text-decoration:underline; }
        .dm-md a.dm-doc-link { color:#7c3aed;border-bottom:1px dashed #a78bfa;cursor:pointer; }
        .dm-md a.dm-doc-link:hover { background:#f5f3ff;border-radius:2px; }
        .dm-md a.dm-src-link { color:#0369a1;border-bottom:1px dashed #7dd3fc;cursor:pointer; }
        .dm-md a.dm-src-link:hover { background:#f0f9ff;border-radius:2px; }
        .dm-src-body { margin:0;padding:20px 28px;font-size:11px;line-height:1.7;
          background:#0f172a;color:#e2e8f0;overflow:auto;flex:1;min-height:0;
          font-family:ui-monospace,monospace; }
        .src-ln { display:inline-block;min-width:36px;color:#475569;user-select:none;
          padding-right:16px;text-align:right; }
        .src-ln-hi { background:#854d0e;color:#fef9c3;border-radius:3px; }
        .src-gutter-dot { display:inline-block;width:14px;color:#22c55e;font-size:8px;
          text-align:center;cursor:pointer;flex-shrink:0;border-radius:2px;transition:color 0.1s,background 0.1s; }
        .src-gutter-dot:hover { color:#16a34a;background:rgba(34,197,94,0.15); }
        .src-gutter-dot-active { color:#f97316;background:rgba(249,115,22,0.15); }
        .src-gutter-empty { display:inline-block;width:14px; }
        .src-comment { color:#6a9955; }
        .src-sym-link { cursor:pointer;border-radius:2px;transition:background 0.1s;
          text-decoration:underline dotted;text-decoration-color:#22c55e;text-underline-offset:2px; }
        .src-sym-link:hover { background:rgba(34,197,94,0.18); }
        .src-sym-link-active { background:rgba(249,115,22,0.2);text-decoration-color:#f97316; }
        mark.src-ann-highlight { background:#fef3c7;color:#92400e;font-weight:600;border-radius:2px;
          padding:0 1px;border:none;cursor:pointer; }
        mark.src-ann-highlight:hover { background:#fde68a; }
        mark.src-ann-highlight-active { background:#fed7aa;outline:1px solid #f97316; }
        .src-split { display:flex;flex:1;min-height:0;overflow:hidden; }
        .src-refs-panel { width:260px;flex-shrink:0;background:#f8fafc;border-left:1px solid #e2e8f0;
          overflow-y:auto;display:flex;flex-direction:column;font-size:11px; }
        .src-refs-title { padding:10px 14px 6px;font-size:12px;font-weight:800;color:#1e293b;
          border-bottom:1px solid #e2e8f0;letter-spacing:0.02em; }
        .src-refs-section { padding:8px 14px 4px;font-size:10px;font-weight:700;color:#64748b;
          text-transform:uppercase;letter-spacing:0.06em;background:#f1f5f9; }
        .src-ref-doc-item { padding:8px 14px;border-bottom:1px solid #f1f5f9;cursor:pointer;
          transition:background 0.12s; }
        .src-ref-doc-item:hover { background:#eff6ff; }
        .src-ref-doc-name { font-weight:700;color:#1e293b;font-size:11px;margin-bottom:1px; }
        .src-ref-doc-path { font-size:9px;color:#94a3b8;margin-bottom:3px;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .src-ref-symbols { display:flex;flex-wrap:wrap;gap:2px;margin-bottom:2px; }
        .src-ref-symbols code { font-size:9px;background:#dbeafe;color:#1d4ed8;
          padding:0 4px;border-radius:3px;font-family:ui-monospace,monospace; }
        .src-ref-lines { font-size:9px;color:#94a3b8; }
        .src-ln-ref { color:#0369a1;cursor:pointer;text-decoration:underline dotted; }
        .src-ln-ref:hover { color:#1d4ed8; }
        .src-ref-violation { padding:6px 14px;border-bottom:1px solid #fef2f2; }
        .src-ref-rule { padding:6px 14px;border-bottom:1px solid #f3e8ff; }
        .src-refs-empty { padding:16px 14px;color:#94a3b8;font-size:11px;line-height:1.5; }
        .dm-src-view { display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden; }
        .ann-mark { background:#fef3c7;border-bottom:2px solid #f59e0b;border-radius:3px;
          cursor:pointer;transition:background 0.1s;position:relative; }
        .ann-mark:hover { background:#fde68a; }
        .ann-mark.cs { background:#dbeafe;border-bottom-color:#3b82f6; }
        .ann-mark.cs:hover { background:#bfdbfe; }
        .ann-mark.ann-prose-token { background:#f0fdf4;border-bottom-color:#22c55e; }
        .ann-mark.ann-prose-token:hover { background:#dcfce7; }
        span.ann-code-token { display:inline;padding:0 1px;border-radius:2px; }
        #ann-tooltip { position:fixed;z-index:9999;background:#1e293b;color:#f1f5f9;
          font-size:11px;border-radius:8px;padding:8px 12px;pointer-events:none;
          max-width:320px;line-height:1.5;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:none; }
        .dm-doc-header { padding:20px 28px 16px;border-bottom:1px solid #f1f5f9;background:#fff;
          position:sticky;top:0;z-index:10; }
        .dm-filter-bar { padding:8px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;
          display:flex;align-items:center;gap:8px; }
        .dm-filter-input { flex:1;padding:4px 8px;font-size:11px;border:1px solid #d1d5db;
          border-radius:6px;outline:none; }
        .dm-filter-input:focus { border-color:#3b82f6; }
      `;
      document.head.appendChild(s);
    }

    // Shared tooltip element
    let annTooltip = document.getElementById("ann-tooltip");
    if (!annTooltip) {
      annTooltip = document.createElement("div");
      annTooltip.id = "ann-tooltip";
      document.body.appendChild(annTooltip);
    }

    function escHtml(t: string): string {
      return t
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // ── Markdown renderer ──────────────────────────────────────────────────
    function renderMarkdown(raw: string): string {
      if (!raw) return "<p><em>No content available.</em></p>";
      const lines = raw.split("\n");
      const out: string[] = [];
      let inFence = false;
      let fenceLang = "";
      let inTable = false;
      let listStack: string[] = []; // 'ul' | 'ol'

      function closeList(): void {
        while (listStack.length) {
          out.push(`</${listStack.pop()}>`);
        }
      }

      function processInline(text: string): string {
        // Escape HTML first (except already-escaped entities)
        text = text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        // Inline code (must come before bold/italic)
        text = text.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
        // Bold
        text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
        // Italic — underscores must be at word boundaries, not inside identifiers like cari_retrieve
        text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
        text = text.replace(
          /(^|[\s([.,!?;:"'])_([^_\s][^_]*)_([\s)\].,!?;:"']|$)/g,
          "$1<em>$2</em>$3",
        );
        // Links — internal doc links get data-doc attribute; source file links get data-src; external open in new tab
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => {
          if (u.startsWith("http") || u.startsWith("#")) {
            return `<a href="${escHtml(u)}" target="_blank" rel="noopener">${t}</a>`;
          }
          const SRC_EXT =
            /\.(ts|tsx|js|jsx|py|swift|go|rs|rb|java|c|cpp|h|cs|kt|sh|yaml|yml|json|toml)$/i;
          if (SRC_EXT.test(u)) {
            return `<a href="#" data-src="${escHtml(u)}" class="dm-src-link">${t}</a>`;
          }
          if (u.endsWith(".md") || u.endsWith(".txt") || u.endsWith(".rst")) {
            return `<a href="#" data-doc="${escHtml(u)}" class="dm-doc-link">${t}</a>`;
          }
          return `<a href="${escHtml(u)}" target="_blank" rel="noopener">${t}</a>`;
        });
        return text;
      }

      for (let i = 0; i < lines.length; i++) {
        const raw_line = lines[i];
        const line = raw_line;

        // Fenced code blocks
        if (!inFence && line.match(/^```/)) {
          closeList();
          if (inTable) {
            out.push("</tbody></table>");
            inTable = false;
          }
          fenceLang = line.slice(3).trim();
          out.push(`<pre><code class="lang-${escHtml(fenceLang)}">`);
          inFence = true;
          continue;
        }
        if (inFence) {
          if (line.match(/^```/)) {
            out.push("</code></pre>");
            inFence = false;
          } else {
            out.push(escHtml(line));
          }
          continue;
        }

        // Horizontal rule
        if (line.match(/^(\s*[-*_]){3,}\s*$/)) {
          closeList();
          if (inTable) {
            out.push("</tbody></table>");
            inTable = false;
          }
          out.push("<hr>");
          continue;
        }

        // Headings
        const hm = line.match(/^(#{1,6})\s+(.*)/);
        if (hm) {
          closeList();
          if (inTable) {
            out.push("</tbody></table>");
            inTable = false;
          }
          const level = hm[1].length;
          const id = hm[2]
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .replace(/\s+/g, "-");
          out.push(
            `<h${level} id="${escHtml(id)}">${processInline(hm[2])}</h${level}>`,
          );
          continue;
        }

        // Blockquote
        if (line.match(/^>\s/)) {
          closeList();
          if (inTable) {
            out.push("</tbody></table>");
            inTable = false;
          }
          out.push(`<blockquote>${processInline(line.slice(2))}</blockquote>`);
          continue;
        }

        // Table rows
        if (line.includes("|") && line.trim().startsWith("|")) {
          closeList();
          if (line.match(/^\|[\s\-:|]+\|/)) {
            // Separator row — already in table
            continue;
          }
          const cells = line
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim());
          if (!inTable) {
            out.push(
              "<table><thead><tr>" +
                cells.map((c) => `<th>${processInline(c)}</th>`).join("") +
                "</tr></thead><tbody>",
            );
            inTable = true;
          } else {
            out.push(
              "<tr>" +
                cells.map((c) => `<td>${processInline(c)}</td>`).join("") +
                "</tr>",
            );
          }
          continue;
        } else if (inTable) {
          out.push("</tbody></table>");
          inTable = false;
        }

        // Ordered list
        const olm = line.match(/^(\s*)\d+\.\s+(.*)/);
        if (olm) {
          const depth = Math.floor(olm[1].length / 2);
          while (listStack.length > depth + 1)
            out.push(`</${listStack.pop()}>`);
          if (
            listStack.length === 0 ||
            listStack[listStack.length - 1] !== "ol"
          ) {
            out.push("<ol>");
            listStack.push("ol");
          }
          out.push(`<li>${processInline(olm[2])}</li>`);
          continue;
        }

        // Unordered list
        const ulm = line.match(/^(\s*)[-*+]\s+(.*)/);
        if (ulm) {
          const depth = Math.floor(ulm[1].length / 2);
          while (listStack.length > depth + 1)
            out.push(`</${listStack.pop()}>`);
          if (
            listStack.length === 0 ||
            listStack[listStack.length - 1] !== "ul"
          ) {
            out.push("<ul>");
            listStack.push("ul");
          }
          out.push(`<li>${processInline(ulm[2])}</li>`);
          continue;
        }

        // Empty line
        if (line.trim() === "") {
          closeList();
          continue;
        }

        // Paragraph
        closeList();
        out.push(`<p>${processInline(line)}</p>`);
      }

      closeList();
      if (inTable) out.push("</tbody></table>");
      return out.join("\n");
    }

    // ── Annotation highlight injection ────────────────────────────────────
    function applyDocHighlights(
      mdBody: any,
      anns: any[],
      tooltipEl: any,
    ): void {
      if (!anns?.length) return;

      // Build normalized text → annotation list lookup
      const byText = new Map<string, any[]>();
      for (const ann of anns) {
        const key = ann.text.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (key.length < 3) continue; // skip trivially short tokens
        if (!byText.has(key)) byText.set(key, []);
        byText.get(key)!.push(ann);
      }

      function attachTooltip(el: any, annsForEl: any[]): void {
        el.addEventListener("mouseenter", (evt: any) => {
          // Deduplicate by symbol identity (same name + file + line = same symbol)
          const seen = new Set<string>();
          const top3 = annsForEl
            .filter((a) => {
              const key = `${a.symbolName}|${a.symbolFile}|${a.symbolLine}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, 3);
          const rows = top3
            .map((a) => {
              const shortFile = a.symbolFile.split("/").slice(-2).join("/");
              const conf = Math.round(a.confidence * 100);
              return `<div style="margin-top:4px;padding-top:4px;border-top:1px solid #334155">
              <span style="font-family:ui-monospace,monospace;font-size:11px;color:#93c5fd">${escHtml(a.symbolName)}</span>
              <span style="color:#64748b;font-size:10px"> ${escHtml(a.symbolKind)}</span><br>
              <span style="color:#94a3b8;font-size:10px">${escHtml(shortFile)}:${a.symbolLine}</span>
              <span style="float:right;color:${conf >= 90 ? "#4ade80" : conf >= 70 ? "#fbbf24" : "#94a3b8"};font-size:10px">${conf}%</span>
            </div>`;
            })
            .join("");
          tooltipEl.innerHTML = `<div style="font-weight:700;color:#e2e8f0">${escHtml(annsForEl[0].text)}</div>${rows}`;
          tooltipEl.style.display = "block";
          tooltipEl.style.left = evt.clientX + 14 + "px";
          tooltipEl.style.top = evt.clientY + 14 + "px";
        });
        el.addEventListener("mousemove", (evt: any) => {
          tooltipEl.style.left = evt.clientX + 14 + "px";
          tooltipEl.style.top = evt.clientY + 14 + "px";
        });
        el.addEventListener("mouseleave", () => {
          tooltipEl.style.display = "none";
        });
      }

      // Highlight inline <code> spans (single-token, not inside <pre>)
      mdBody
        .querySelectorAll("p code, li code, td code, th code, blockquote code")
        .forEach((el: any) => {
          const norm = el.textContent.toLowerCase().replace(/[^a-z0-9]/g, "");

          // 1) Exact full-text match (e.g. `isInSkg ? -20` ↔ annotation text "isinskg ? -20")
          let lookupKey: string | null = byText.has(norm) ? norm : null;

          // 2) Leading-identifier match: `coOccurrenceDegree × 2.0` → extract "coOccurrenceDegree"
          if (lookupKey === null) {
            const leadIdent = el.textContent.match(
              /^[a-zA-Z_$][a-zA-Z0-9_$]*/,
            )?.[0];
            if (leadIdent) {
              const leadKey = leadIdent.toLowerCase().replace(/[^a-z0-9]/g, "");
              if (leadKey.length >= 4 && byText.has(leadKey))
                lookupKey = leadKey;
            }
          }

          if (lookupKey !== null) {
            const matching = byText.get(lookupKey)!;
            const isCodeSpan = matching.some((a) => a.source === "code-span");
            el.classList.add("ann-mark");
            if (isCodeSpan) el.classList.add("cs");
            attachTooltip(el, matching);
          }
        });

      // Highlight identifier tokens inside fenced code blocks (<pre><code>)
      // Tokenize by identifier boundaries; wrap annotated tokens in <span> highlights
      mdBody.querySelectorAll("pre code").forEach((el: any) => {
        // Split into (identifier | non-identifier) alternating parts
        const parts: string[] = el.textContent.split(
          /(\b[a-zA-Z_$][a-zA-Z0-9_$]*\b)/,
        );
        let changed = false;
        const html = parts
          .map((part: string, i: number) => {
            // Odd-index parts are the captured identifier groups
            if (i % 2 === 1 && part.length >= 4) {
              const key = part.toLowerCase();
              if (byText.has(key)) {
                changed = true;
                return `<span class="ann-mark cs ann-code-token" data-ak="${escHtml(key)}">${escHtml(part)}</span>`;
              }
            }
            return escHtml(part);
          })
          .join("");
        if (changed) {
          el.innerHTML = html;
          el.querySelectorAll(".ann-code-token").forEach((span: any) => {
            const annsForSpan = byText.get(span.dataset.ak);
            if (annsForSpan) attachTooltip(span, annsForSpan);
          });
        }
      });

      // Highlight <strong> spans (bold annotations)
      mdBody.querySelectorAll("strong").forEach((el: any) => {
        const norm = el.textContent.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (byText.has(norm)) {
          const matching = byText.get(norm)!;
          el.classList.add("ann-mark");
          attachTooltip(el, matching);
        }
      });

      // Scan plain prose text nodes for symbols already in byText.
      // This catches identifiers like `crossLayerLinker` or `triageAnalyzer` that
      // appear as code-span/identifier annotations in this doc but are also mentioned
      // in plain prose without backticks.
      if (byText.size > 0) {
        // Collect text nodes that are NOT inside code/pre/strong/a/.ann-mark
        const textNodes: any[] = [];
        const walker = document.createTreeWalker(
          mdBody,
          4, // NodeFilter.SHOW_TEXT
          {
            acceptNode(node: any) {
              let p = node.parentElement;
              while (p && p !== mdBody) {
                const tag = p.tagName.toLowerCase();
                if (
                  tag === "code" ||
                  tag === "pre" ||
                  tag === "strong" ||
                  tag === "a"
                ) {
                  return 2; // NodeFilter.FILTER_REJECT
                }
                if (p.classList && p.classList.contains("ann-mark")) {
                  return 2; // NodeFilter.FILTER_REJECT
                }
                p = p.parentElement;
              }
              return node.textContent && node.textContent.trim().length >= 4
                ? 1 // NodeFilter.FILTER_ACCEPT
                : 3; // NodeFilter.FILTER_SKIP
            },
          },
        );
        let tn: any;
        while ((tn = walker.nextNode())) textNodes.push(tn);

        textNodes.forEach((textNode: any) => {
          const parts = textNode.textContent.split(
            /(\b[a-zA-Z_$][a-zA-Z0-9_$]*\b)/,
          );
          let changed = false;
          const html = parts
            .map((part: string, i: number) => {
              if (i % 2 === 1 && part.length >= 4) {
                const key = part.toLowerCase().replace(/[^a-z0-9]/g, "");
                if (key.length >= 4 && byText.has(key)) {
                  changed = true;
                  return `<span class="ann-mark ann-prose-token" data-ak="${escHtml(key)}">${escHtml(part)}</span>`;
                }
              }
              return escHtml(part);
            })
            .join("");
          if (changed) {
            const wrapper = document.createElement("span");
            wrapper.innerHTML = html;
            textNode.parentNode.replaceChild(wrapper, textNode);
          }
        });

        // Attach tooltips to prose tokens
        mdBody.querySelectorAll(".ann-prose-token").forEach((span: any) => {
          const key = span.dataset.ak;
          const anns = byText.get(key);
          if (anns) attachTooltip(span, anns);
        });
      }
    }

    // ── Render a doc page into the viewer ─────────────────────────────────
    function renderDocPage(doc: any): void {
      const pkgPills = doc.referencedPackages
        .slice(0, 10)
        .map(
          (pkg: string) =>
            `<span style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:10px;font-weight:600;margin:1px;${pkgColor(pkg)}">${escHtml(shortPkg(pkg))}</span>`,
        )
        .join("");
      const morePkgs =
        doc.referencedPackages.length > 10
          ? `<span style="font-size:10px;color:#9ca3af"> +${doc.referencedPackages.length - 10}</span>`
          : "";
      const codeSpanCount = doc.topAnnotations.filter(
        (a: any) => a.source === "code-span",
      ).length;
      const boldCount = doc.topAnnotations.filter(
        (a: any) => a.source === "bold",
      ).length;

      const header = `<div class="dm-doc-header">
        <div style="display:flex;align-items:flex-start;gap:12px">
          <div style="flex:1;min-width:0">
            <h2 style="margin:0 0 2px;font-size:16px;font-weight:800;color:#1e293b">${escHtml(docTitle(doc.path))}</h2>
            <div style="font-size:10px;color:#94a3b8;margin-bottom:6px">${escHtml(doc.path)}</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
              ${pkgPills}${morePkgs}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex-shrink:0">
            <span style="font-size:11px;background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:999px;font-weight:600">${doc.uniqueSymbols} symbols</span>
            <span style="font-size:11px;background:#f3e8ff;color:#7c3aed;padding:2px 8px;border-radius:999px;font-weight:600">${doc.uniqueSourceFiles} src files</span>
          </div>
        </div>
        ${
          doc.topAnnotations.length > 0
            ? `<div style="margin-top:8px;font-size:10px;color:#64748b">
          <span style="margin-right:8px">🔵 ${codeSpanCount} code-span highlights</span>
          <span>🟡 ${boldCount} bold highlights</span>
        </div>`
            : ""
        }
      </div>`;

      const mdHtml = renderMarkdown(doc.content || "");
      viewer.innerHTML = header + `<div class="dm-md">${mdHtml}</div>`;
      applyDocHighlights(
        viewer.querySelector(".dm-md"),
        doc.topAnnotations,
        annTooltip,
      );

      // Internal doc-link click handler: navigate to the target doc in the sidebar
      viewer.querySelectorAll(".dm-doc-link").forEach((a: any) => {
        a.addEventListener("click", (e: any) => {
          e.preventDefault();
          const rawHref = a.dataset.doc ?? "";
          // Normalise: strip leading ./ and resolve relative to current doc directory
          const base = doc.path.includes("/")
            ? doc.path.replace(/\/[^/]+$/, "/")
            : "";
          const candidates = [
            rawHref,
            base + rawHref,
            rawHref.replace(/^\.\//, ""),
            (base + rawHref).replace(/^\.\//, ""),
          ];
          const target = dm.docs.find((d: any) =>
            candidates.some(
              (c) =>
                d.path === c || d.path.endsWith("/" + c) || c.endsWith(d.path),
            ),
          );
          if (!target) return;
          // Click the matching nav item to trigger full navigation + highlight
          const idx = dm.docs.indexOf(target);
          const navItem = navList.querySelector(`[data-idx="${idx}"]`) as any;
          if (navItem) navItem.click();
        });
      });

      // Source file link click handler: render the source inline in the viewer
      viewer.querySelectorAll(".dm-src-link").forEach((a: any) => {
        a.addEventListener("click", (e: any) => {
          e.preventDefault();
          const rawHref = a.dataset.src ?? "";
          const base = doc.path.includes("/")
            ? doc.path.replace(/\/[^/]+$/, "/")
            : "";
          const candidates = [
            rawHref,
            (base + rawHref).replace(/\/\.\//, "/"),
            rawHref.replace(/^\.\//, ""),
            base + rawHref.replace(/^\.\//, ""),
          ];
          const key = Object.keys(dm.sourceFiles ?? {}).find((k: string) =>
            candidates.some((c) => k === c || c.endsWith(k) || k.endsWith(c)),
          );
          if (!key) return;
          openSourceFile(key, undefined);
        });
      });

      // Build annotation lookup: normalised text key → first annotation with a symbolFile
      const annByKey = new Map<string, any>();
      for (const ann of doc.topAnnotations) {
        if (!ann.symbolFile) continue;
        const k = ann.text.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (k.length >= 3 && !annByKey.has(k)) annByKey.set(k, ann);
      }

      // Make highlighted code symbols clickable if their source file is loaded
      viewer.querySelectorAll(".ann-mark").forEach((el: any) => {
        // Key stored in data-ak (code-token / prose-token) or derive from text
        const key =
          el.dataset.ak ??
          el.textContent.toLowerCase().replace(/[^a-z0-9]/g, "");
        const ann = annByKey.get(key);
        if (!ann || !ann.symbolFile) return;
        if (!dm.sourceFiles || !(ann.symbolFile in dm.sourceFiles)) return;
        el.style.cursor = "pointer";
        el.title = `Click to view ${ann.symbolFile.split("/").pop()}`;
        el.addEventListener("click", (e: any) => {
          e.stopPropagation();
          openSourceFile(ann.symbolFile, ann.symbolLine);
        });
      });

      // Source file pills below the doc header
      const uniqueSrcFiles = [
        ...new Set(
          doc.topAnnotations
            .filter(
              (a: any) =>
                a.symbolFile &&
                dm.sourceFiles &&
                a.symbolFile in dm.sourceFiles,
            )
            .map((a: any) => a.symbolFile as string),
        ),
      ].slice(0, 12) as string[];
      if (uniqueSrcFiles.length > 0) {
        const pillsRow = document.createElement("div");
        pillsRow.style.cssText =
          "padding:6px 20px 4px;display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #f1f5f9";
        pillsRow.innerHTML =
          `<span style="font-size:10px;color:#94a3b8;margin-right:2px;line-height:20px">📄 src:</span>` +
          uniqueSrcFiles
            .map(
              (f: string) =>
                `<button class="dm-srcfile-pill" data-file="${escHtml(f)}" style="font-size:10px;font-family:ui-monospace,monospace;background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1;border-radius:4px;padding:1px 7px;cursor:pointer;white-space:nowrap">${escHtml(f.split("/").pop() ?? f)}</button>`,
            )
            .join("");
        const header = viewer.querySelector(".dm-doc-header");
        if (header && header.parentNode)
          header.parentNode.insertBefore(pillsRow, header.nextSibling);
        pillsRow.querySelectorAll(".dm-srcfile-pill").forEach((btn: any) => {
          btn.addEventListener("click", () =>
            openSourceFile(btn.dataset.file, undefined),
          );
        });
      }

      // ── Open a source file in the viewer (AR split view) ────────────────
      function openSourceFile(
        srcPath: string,
        targetLine: number | undefined,
      ): void {
        const srcContent: string = (dm as any).sourceFiles[srcPath] ?? "";
        const ext = (srcPath.split(".").pop() ?? "").toLowerCase();
        const lang =
          ext === "ts" || ext === "tsx"
            ? "typescript"
            : ext === "js" || ext === "jsx"
              ? "javascript"
              : ext === "py"
                ? "python"
                : ext === "swift"
                  ? "swift"
                  : ext;
        const lines = srcContent.split("\n");
        const lineCount = lines.length;

        // ── Back-links: which docs reference symbols in this source file ──
        const backLinksByDoc = new Map<string, any[]>();
        for (const d of (dm as any).docs) {
          for (const ann of d.topAnnotations) {
            if (ann.symbolFile === srcPath) {
              const arr = backLinksByDoc.get(d.path) ?? [];
              arr.push(ann);
              backLinksByDoc.set(d.path, arr);
            }
          }
        }

        // ── lineToAnns: line number → [{docPath, ann}] ────────────────────
        const lineToAnns = new Map<
          number,
          Array<{ docPath: string; ann: any }>
        >();
        for (const [docPath, anns] of backLinksByDoc.entries()) {
          for (const ann of anns) {
            if (!ann.symbolLine) continue;
            const bucket = lineToAnns.get(ann.symbolLine) ?? [];
            bucket.push({ docPath, ann });
            lineToAnns.set(ann.symbolLine, bucket);
          }
        }

        // ── lineToSymbols: line number → symbol names (for injection) ────
        const lineToSymbols = new Map<number, string[]>();
        for (const [lineNo, entries] of lineToAnns.entries()) {
          const syms = [
            ...new Set(entries.map((e) => e.ann.symbolName).filter(Boolean)),
          ];
          if (syms.length) lineToSymbols.set(lineNo, syms);
        }

        // ── Annotated line set for gutter dots ────────────────────────────
        const annotatedLines = new Set<number>(lineToAnns.keys());

        // ── Violations touching this file ─────────────────────────────────
        const DATA_global = (globalThis as any).DATA;
        const allViolations: any[] = DATA_global?.violations ?? [];
        const fileViolations = allViolations.filter(
          (v: any) =>
            v.filePath &&
            (v.filePath === srcPath ||
              srcPath.startsWith(v.filePath + "/") ||
              v.filePath.startsWith(srcPath.replace(/\/[^/]+$/, ""))),
        );

        // ── Rules whose 'in' patterns match this file ─────────────────────
        const allRules: any[] = DATA_global?.rulesCatalog?.rules ?? [];
        const governingRules = allRules.filter((r: any) =>
          (r.forbidden ?? []).some((f: any) => {
            if (!f.in) return false;
            const prefix = f.in.replace(/\/\*\*$/, "");
            return srcPath.startsWith(prefix + "/") || srcPath === prefix;
          }),
        );

        // ── Helper: render refs panel content (all or filtered to a line) ─
        function renderRefsContent(filterLine: number | null): string {
          let html = "";
          const filteredByDoc =
            filterLine !== null
              ? (() => {
                  const m = new Map<string, any[]>();
                  const entries = lineToAnns.get(filterLine) ?? [];
                  for (const { docPath, ann } of entries) {
                    const arr = m.get(docPath) ?? [];
                    arr.push(ann);
                    m.set(docPath, arr);
                  }
                  return m;
                })()
              : backLinksByDoc;

          if (filteredByDoc.size > 0) {
            const label =
              filterLine !== null
                ? `📄 ${filteredByDoc.size} doc${filteredByDoc.size !== 1 ? "s" : ""} — line ${filterLine}`
                : `📄 Referenced by ${filteredByDoc.size} doc${filteredByDoc.size !== 1 ? "s" : ""}`;
            html += `<div class="src-refs-section">${label}</div>`;
            for (const [docPath, anns] of filteredByDoc.entries()) {
              const uniqueSymbols = [
                ...new Set(anns.map((a: any) => a.symbolName)),
              ].slice(0, 4);
              const docLines = [
                ...new Set(anns.map((a: any) => a.symbolLine).filter(Boolean)),
              ]
                .sort((a: any, b: any) => a - b)
                .slice(0, 4);
              html += `<div class="src-ref-doc-item" data-doc="${escHtml(docPath)}">
                <div class="src-ref-doc-name">${escHtml(docTitle(docPath))}</div>
                <div class="src-ref-doc-path">${escHtml(docPath)}</div>
                <div class="src-ref-symbols">${uniqueSymbols.map((s: string) => `<code>${escHtml(s)}</code>`).join(" ")}</div>
                ${docLines.length > 0 ? `<div class="src-ref-lines">lines: ${docLines.map((l: number) => `<a class="src-ln-ref" data-line="${l}">:${l}</a>`).join(" ")}</div>` : ""}
              </div>`;
            }
          } else if (filterLine !== null) {
            html += `<div class="src-refs-empty" style="padding:10px 14px">No docs reference line ${filterLine}.</div>`;
          } else {
            html += `<div class="src-refs-empty">No documentation references found.<br><span style="font-size:10px;color:#94a3b8">Add mentions of exported symbols in .md files to create links.</span></div>`;
          }

          // Violations + governing rules always shown (not filtered by line)
          if (fileViolations.length > 0) {
            html += `<div class="src-refs-section">⚠ ${fileViolations.length} violation${fileViolations.length !== 1 ? "s" : ""}</div>`;
            for (const v of fileViolations.slice(0, 8)) {
              const domainColor =
                v.ruleDomain === "structural"
                  ? "#7c3aed"
                  : v.ruleDomain === "behavioral"
                    ? "#0369a1"
                    : "#374151";
              html += `<div class="src-ref-violation">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                  <code style="font-size:10px;color:${escHtml(domainColor)}">${escHtml(v.ruleId)}</code>
                  <span style="font-size:9px;background:#fee2e2;color:#991b1b;border-radius:3px;padding:1px 4px;font-weight:700">${escHtml(v.severity?.toUpperCase() ?? "")}</span>
                </div>
                <div style="font-size:10px;color:#64748b;line-height:1.4">${escHtml(v.detail ?? "")}</div>
              </div>`;
            }
          }
          if (governingRules.length > 0) {
            html += `<div class="src-refs-section">📋 Governed by ${governingRules.length} rule${governingRules.length !== 1 ? "s" : ""}</div>`;
            for (const r of governingRules.slice(0, 5)) {
              html += `<div class="src-ref-rule">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                  <code style="font-size:10px;color:#7c3aed">${escHtml(r.id)}</code>
                  <span style="font-size:9px;background:#f3e8ff;color:#6b21a8;border-radius:3px;padding:1px 4px;font-weight:700">${escHtml((r.severity ?? "").toUpperCase())}</span>
                </div>
                <div style="font-size:10px;color:#64748b;line-height:1.4;max-height:44px;overflow:hidden">${escHtml((r.description ?? "").trim().slice(0, 120))}${(r.description ?? "").length > 120 ? "…" : ""}</div>
              </div>`;
            }
          }
          return html;
        }

        // ── Header ────────────────────────────────────────────────────────
        const srcHeader = `<div class="dm-doc-header">
          <div style="display:flex;align-items:flex-start;gap:12px">
            <div style="flex:1;min-width:0">
              <h2 style="margin:0 0 2px;font-size:16px;font-weight:800;color:#1e293b">
                ${escHtml(srcPath.split("/").pop() ?? srcPath)}
              </h2>
              <div style="font-size:10px;color:#94a3b8;margin-bottom:6px">${escHtml(srcPath)}</div>
              <button class="btn-goto" id="src-back-btn" style="margin-left:0">
                ← Back to ${escHtml(docTitle(doc.path))}
              </button>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex-shrink:0">
              <span style="font-size:11px;background:#f3e8ff;color:#7c3aed;padding:2px 8px;border-radius:999px;font-weight:600">${lineCount} lines</span>
              ${backLinksByDoc.size > 0 ? `<span style="font-size:11px;background:#dcfce7;color:#166534;padding:2px 8px;border-radius:999px;font-weight:600">↑ ${backLinksByDoc.size} docs</span>` : ""}
              ${fileViolations.length > 0 ? `<span style="font-size:11px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:999px;font-weight:600">⚠ ${fileViolations.length} issues</span>` : ""}
            </div>
          </div>
        </div>`;

        // ── Code with clickable gutter dots ───────────────────────────────
        const linesHtml = lines
          .map((ln, i) => {
            const lineNo = i + 1;
            const isTarget = targetLine !== undefined && lineNo === targetLine;
            const isAnnotated = annotatedLines.has(lineNo);
            const nDocs = isAnnotated
              ? (lineToAnns.get(lineNo)?.length ?? 0)
              : 0;
            const dot = isAnnotated
              ? `<span class="src-gutter-dot" data-line="${lineNo}" title="Click to filter: ${nDocs} reference${nDocs !== 1 ? "s" : ""} on this line">●</span>`
              : `<span class="src-gutter-empty"></span>`;
            return `${dot}<span class="src-ln${isTarget ? " src-ln-hi" : ""}" id="src-line-${lineNo}">${lineNo}</span>${highlightLine(ln, lang)}`;
          })
          .join("\n");

        // ── Refs panel HTML ───────────────────────────────────────────────
        const refsHtml = `<div class="src-refs-panel" id="src-refs-panel">
          <div class="src-refs-title" id="src-refs-title">
            <span>🔗 Evidence Links</span>
            <button id="src-refs-reset" style="display:none;font-size:9px;border:none;background:#e2e8f0;color:#374151;border-radius:3px;padding:1px 6px;cursor:pointer;float:right;margin-top:1px">show all</button>
          </div>
          <div id="src-refs-body">${renderRefsContent(null)}</div>
        </div>`;

        viewer.innerHTML = `<div class="dm-src-view">${srcHeader}<div class="src-split"><pre class="dm-src-body lang-${escHtml(lang)}" id="src-pre"><code id="src-code">${linesHtml}</code></pre>${refsHtml}</div></div>`;

        // ── Inject clickable symbol spans into rendered code ──────────────
        // After innerHTML is set, walk each annotated line's text nodes and
        // wrap the first matching symbol name in a <span class="src-sym-link">
        const codeEl = viewer.querySelector("#src-code");
        if (codeEl && lineToSymbols.size > 0) {
          // The code is rendered as one flat text node stream separated by \n
          // Split into line nodes using the src-line spans as anchors
          for (const [lineNo, syms] of lineToSymbols.entries()) {
            const lineSpan = viewer.querySelector(`#src-line-${lineNo}`);
            if (!lineSpan) continue;
            // The text content of this line is in text node(s) immediately after the lineSpan
            // Collect text node(s) up to the next \n
            const textNode = lineSpan.nextSibling;
            if (!textNode || textNode.nodeType !== 3) continue; // TEXT_NODE = 3
            const raw = textNode.textContent ?? "";
            // Try each symbol — pick the shortest-length first to avoid partial matches
            const sorted = [...syms].sort((a, b) => b.length - a.length);
            let replaced = false;
            for (const sym of sorted) {
              if (sym.length < 2) continue;
              // Word-boundary aware: find sym as a token (preceded/followed by non-word char)
              const idx = raw.search(
                new RegExp(
                  "(?<![\\w$])" +
                    sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                    "(?![\\w$])",
                ),
              );
              if (idx < 0) continue;
              // Split text node: [before][span][after]
              const before = raw.slice(0, idx);
              const after = raw.slice(idx + sym.length);
              const symSpan = document.createElement("span");
              symSpan.className = "src-sym-link";
              symSpan.dataset.line = String(lineNo);
              symSpan.dataset.sym = sym;
              symSpan.title = `Click to filter references for "${sym}"`;
              symSpan.textContent = sym;
              const parent = lineSpan.parentNode;
              if (!parent) break;
              const beforeNode = document.createTextNode(before);
              const afterNode = document.createTextNode(after);
              parent.insertBefore(beforeNode, textNode);
              parent.insertBefore(symSpan, textNode);
              parent.insertBefore(afterNode, textNode);
              parent.removeChild(textNode);
              replaced = true;
              break; // one symbol per line is enough
            }
            void replaced;
          }
        }

        // ── Active filter state ───────────────────────────────────────────
        let activeFilterLine: number | null = null;
        const refsBody = viewer.querySelector("#src-refs-body");
        const refsReset = viewer.querySelector("#src-refs-reset");

        function applyLineFilter(lineNo: number | null): void {
          activeFilterLine = lineNo;
          if (refsBody) refsBody.innerHTML = renderRefsContent(lineNo);
          if (refsReset)
            (refsReset as any).style.display =
              lineNo !== null ? "inline" : "none";
          // Highlight the active gutter dot
          viewer.querySelectorAll(".src-gutter-dot").forEach((d: any) => {
            d.classList.toggle(
              "src-gutter-dot-active",
              lineNo !== null && parseInt(d.dataset.line, 10) === lineNo,
            );
          });
          // Highlight the active symbol link
          viewer.querySelectorAll(".src-sym-link").forEach((s: any) => {
            s.classList.toggle(
              "src-sym-link-active",
              lineNo !== null && parseInt(s.dataset.line, 10) === lineNo,
            );
          });
          wireRefsPanel();
        }

        function wireRefsPanel(): void {
          // Doc item click → navigate to doc
          (refsBody ?? viewer)
            .querySelectorAll(".src-ref-doc-item")
            .forEach((item: any) => {
              item.addEventListener("click", (e: any) => {
                if (e.target.classList.contains("src-ln-ref")) return;
                const targetDoc = (dm as any).docs.find(
                  (d: any) => d.path === item.dataset.doc,
                );
                if (!targetDoc) return;
                const idx = (dm as any).docs.indexOf(targetDoc);
                const navItem = navList.querySelector(`[data-idx="${idx}"]`);
                if (navItem) (navItem as any).click();
              });
            });
          // Line-ref links → scroll code
          (refsBody ?? viewer)
            .querySelectorAll(".src-ln-ref")
            .forEach((a: any) => {
              a.addEventListener("click", (e: any) => {
                e.stopPropagation();
                const ln = parseInt(a.dataset.line, 10);
                const el = viewer.querySelector(`#src-line-${ln}`);
                if (el) (el as any).scrollIntoView({ block: "center" });
              });
            });
        }

        // Wire back button
        const backBtn = viewer.querySelector("#src-back-btn");
        if (backBtn)
          backBtn.addEventListener("click", () => renderDocPage(doc));

        // Wire reset button
        if (refsReset)
          refsReset.addEventListener("click", () => applyLineFilter(null));

        // Wire gutter dots → filter
        viewer.querySelectorAll(".src-gutter-dot").forEach((dot: any) => {
          dot.addEventListener("click", () => {
            const lineNo = parseInt(dot.dataset.line, 10);
            if (activeFilterLine === lineNo)
              applyLineFilter(null); // toggle off
            else applyLineFilter(lineNo);
          });
        });

        // Wire symbol links → filter
        viewer.querySelectorAll(".src-sym-link").forEach((span: any) => {
          span.addEventListener("click", () => {
            const lineNo = parseInt(span.dataset.line, 10);
            if (activeFilterLine === lineNo) applyLineFilter(null);
            else applyLineFilter(lineNo);
          });
        });

        // Initial refs panel wiring
        wireRefsPanel();

        // Scroll to the target line after render
        if (targetLine !== undefined) {
          const targetEl = viewer.querySelector(`#src-line-${targetLine}`);
          if (targetEl)
            setTimeout(
              () => (targetEl as any).scrollIntoView({ block: "center" }),
              50,
            );
        }
      }
    }

    // ── Build filter bar + sidebar ─────────────────────────────────────────
    const filterBar = document.createElement("div");
    filterBar.className = "dm-filter-bar";
    filterBar.innerHTML = `<input class="dm-filter-input" type="text" placeholder="Filter docs…">`;
    sidebar.appendChild(filterBar);
    const filterInput = filterBar.querySelector(".dm-filter-input");

    const navList = document.createElement("div");
    sidebar.appendChild(navList);

    function buildNavItems(docs: any[]): void {
      navList.innerHTML = "";
      docs.forEach((doc: any) => {
        // Store the real dm.docs index so refs-panel cross-nav selector still matches
        const realIdx = dm.docs.indexOf(doc);
        const item = document.createElement("div");
        item.className = "dm-nav-item";
        item.dataset.idx = String(realIdx);
        item.innerHTML = `
          <div class="dm-nav-title">${escHtml(docTitle(doc.path))}</div>
          <div class="dm-nav-path">${escHtml(doc.path)}</div>
          <div class="dm-nav-badges">
            <span style="font-size:9px;background:#dbeafe;color:#1d4ed8;padding:1px 5px;border-radius:999px;font-weight:600">${doc.uniqueSymbols}↗</span>
            <span style="font-size:9px;background:#f3e8ff;color:#7c3aed;padding:1px 5px;border-radius:999px;font-weight:600">${doc.uniqueSourceFiles} src</span>
            <span style="font-size:9px;background:${doc.topAnnotations?.length > 0 ? "#fef3c7" : "#f1f5f9"};color:${doc.topAnnotations?.length > 0 ? "#92400e" : "#6b7280"};padding:1px 5px;border-radius:999px;font-weight:600">${doc.topAnnotations?.length || 0} hl</span>
          </div>`;
        item.addEventListener("click", () => {
          navList
            .querySelectorAll(".dm-nav-item")
            .forEach((el: any) => el.classList.remove("active"));
          item.classList.add("active");
          renderDocPage(doc);
        });
        navList.appendChild(item);
      });
      // Select first item
      const first = navList.querySelector(".dm-nav-item");
      if (first) (first as any).classList.add("active");
    }

    // Source-file extensions that belong in the Source section, not the Docs section
    const SRC_DOC_EXT =
      /\.(ts|tsx|js|jsx|mjs|cjs|py|swift|go|java|kt|cs|rs|rb|c|cpp|h)$/i;
    const docsOnly = dm.docs.filter((d: any) => !SRC_DOC_EXT.test(d.path));

    buildNavItems(docsOnly);
    if (docsOnly.length > 0) renderDocPage(docsOnly[0]);

    // Filter docs
    filterInput.addEventListener("input", () => {
      const q = filterInput.value.toLowerCase();
      const filtered = q
        ? docsOnly.filter(
            (d: any) =>
              d.path.toLowerCase().includes(q) ||
              docTitle(d.path).toLowerCase().includes(q),
          )
        : docsOnly;
      buildNavItems(filtered);
      if (filtered.length > 0) renderDocPage(filtered[0]);
    });
  }

  // ── AR Evidence Glasses interactive setup ─────────────────────────────────
  function setupARGlassesChapter(container: any, dm: any): void {
    const sidebar = container.querySelector("#docmap-src-section");
    const viewer = container.querySelector("#docmap-viewer");
    if (!sidebar || !viewer || !dm?.sourceFiles) return;

    // AR-specific styles (shared src-viewer styles come from docmap-styles)
    if (!document.getElementById("ar-glasses-styles")) {
      const s = document.createElement("style");
      s.id = "ar-glasses-styles";
      s.textContent = `
        .ar-group-header { padding:5px 12px 4px;font-size:9px;font-weight:700;color:#64748b;
          text-transform:uppercase;letter-spacing:0.07em;background:#f1f5f9;
          border-bottom:1px solid #e2e8f0;border-top:1px solid #e2e8f0; }
        .ar-file-item { padding:7px 12px;border-bottom:1px solid #f5f5f5;cursor:pointer;
          transition:background 0.1s;border-left:3px solid transparent; }
        .ar-file-item:hover { background:#f8fafc; }
        .ar-file-item.active { background:#eff6ff;border-left-color:#3b82f6; }
        .ar-file-name { font-size:11px;font-weight:700;color:#1e293b;
          font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .ar-file-path { font-size:9px;color:#94a3b8;margin-top:1px;white-space:nowrap;
          overflow:hidden;text-overflow:ellipsis; }
        .ar-file-badges { display:flex;gap:3px;margin-top:3px;flex-wrap:wrap; }
        .ar-welcome { padding:40px 28px;color:#94a3b8;text-align:center; }
        .ar-welcome h3 { font-size:20px;color:#64748b;margin:0 0 10px; }
        .ar-welcome p { font-size:13px;line-height:1.6;margin:0; }
      `;
      document.head.appendChild(s);
    }
    // Also ensure docmap-styles are present (needed for src viewer CSS)
    if (!document.getElementById("docmap-styles")) {
      // Trigger injection by temporarily calling setupDocMapChapter on a dummy element
      // (styles are actually injected by the docmap chapter being opened first normally)
      // Fall back: inject the minimal needed styles inline
      const s2 = document.createElement("style");
      s2.id = "docmap-styles";
      s2.textContent = `
        .dm-doc-header { padding:16px 20px 12px;border-bottom:1px solid #f1f5f9;background:#fff;flex-shrink:0; }
        .dm-src-view { display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden; }
        .dm-src-body { margin:0;padding:16px 20px;font-size:11px;line-height:1.7;background:#0f172a;
          color:#e2e8f0;overflow:auto;flex:1;min-height:0;font-family:ui-monospace,monospace; }
        .src-ln { display:inline-block;min-width:36px;color:#475569;user-select:none;padding-right:14px;text-align:right; }
        .src-ln-hi { background:#854d0e;color:#fef9c3;border-radius:3px; }
        .src-gutter-dot { display:inline-block;width:14px;color:#22c55e;font-size:8px;text-align:center;
          cursor:pointer;border-radius:2px;transition:color 0.1s,background 0.1s; }
        .src-gutter-dot:hover { color:#16a34a;background:rgba(34,197,94,0.15); }
        .src-gutter-dot-active { color:#f97316;background:rgba(249,115,22,0.15); }
        .src-gutter-empty { display:inline-block;width:14px; }
        .src-comment { color:#6a9955; }
        .src-sym-link { cursor:pointer;border-radius:2px;text-decoration:underline dotted;
          text-decoration-color:#22c55e;text-underline-offset:2px;transition:background 0.1s; }
        .src-sym-link:hover { background:rgba(34,197,94,0.18); }
        .src-sym-link-active { background:rgba(249,115,22,0.2);text-decoration-color:#f97316; }
        mark.src-ann-highlight { background:#fef3c7;color:#92400e;font-weight:600;border-radius:2px;
          padding:0 1px;border:none;cursor:pointer; }
        mark.src-ann-highlight:hover { background:#fde68a; }
        mark.src-ann-highlight-active { background:#fed7aa;outline:1px solid #f97316; }
        .src-split { display:flex;flex:1;min-height:0;overflow:hidden; }
        .src-refs-panel { width:260px;flex-shrink:0;background:#f8fafc;border-left:1px solid #e2e8f0;
          overflow-y:auto;display:flex;flex-direction:column;font-size:11px; }
        .src-refs-title { padding:10px 14px 6px;font-size:12px;font-weight:800;color:#1e293b;
          border-bottom:1px solid #e2e8f0; }
        .src-refs-section { padding:8px 14px 4px;font-size:10px;font-weight:700;color:#64748b;
          text-transform:uppercase;letter-spacing:0.06em;background:#f1f5f9; }
        .src-ref-doc-item { padding:8px 14px;border-bottom:1px solid #f1f5f9;cursor:pointer;transition:background 0.12s; }
        .src-ref-doc-item:hover { background:#eff6ff; }
        .src-ref-doc-name { font-weight:700;color:#1e293b;font-size:11px;margin-bottom:1px; }
        .src-ref-doc-path { font-size:9px;color:#94a3b8;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .src-ref-symbols { display:flex;flex-wrap:wrap;gap:2px;margin-bottom:2px; }
        .src-ref-symbols code { font-size:9px;background:#dbeafe;color:#1d4ed8;padding:0 4px;border-radius:3px;font-family:ui-monospace,monospace; }
        .src-ref-lines { font-size:9px;color:#94a3b8; }
        .src-ln-ref { color:#0369a1;cursor:pointer;text-decoration:underline dotted; }
        .src-ln-ref:hover { color:#1d4ed8; }
        .src-ref-violation { padding:6px 14px;border-bottom:1px solid #fef2f2; }
        .src-ref-rule { padding:6px 14px;border-bottom:1px solid #f3e8ff; }
        .src-refs-empty { padding:16px 14px;color:#94a3b8;font-size:11px;line-height:1.5; }
      `;
      document.head.appendChild(s2);
    }

    function escHtml(t: string): string {
      return t
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function docTitle(p: string): string {
      return (p.split("/").pop() ?? p)
        .replace(/\.md$/i, "")
        .replace(/[-_]/g, " ");
    }

    // ── Build allBackLinks: srcPath → [{docPath, ann}] ────────────────────
    const allBackLinks = new Map<
      string,
      Array<{ docPath: string; ann: any }>
    >();
    for (const d of dm.docs) {
      for (const ann of d.topAnnotations) {
        if (!ann.symbolFile || !(ann.symbolFile in (dm.sourceFiles as any)))
          continue;
        const bucket = allBackLinks.get(ann.symbolFile) ?? [];
        bucket.push({ docPath: d.path, ann });
        allBackLinks.set(ann.symbolFile, bucket);
      }
    }

    // ── Build selfAnnotations: srcPath → (docLine → ann[]) ──────────────────
    // Source files processed by the source-comment KWX pass appear in dm.docs with
    // doc_path = the source file itself. Keyed by docLine so we can place gutter dots
    // on comment lines that matched symbols.
    const _srcExtRe =
      /\.(ts|tsx|js|jsx|mjs|cjs|py|swift|go|java|kt|cs|rs|rb|c|cpp|h)$/i;
    const selfAnnotations = new Map<string, Map<number, any[]>>();
    for (const d of dm.docs) {
      if (!_srcExtRe.test(d.path)) continue;
      const lineMap = new Map<number, any[]>();
      for (const ann of d.topAnnotations) {
        if (!ann.docLine || !ann.symbolName) continue;
        const bucket = lineMap.get(ann.docLine) ?? [];
        bucket.push(ann);
        lineMap.set(ann.docLine, bucket);
      }
      if (lineMap.size > 0) selfAnnotations.set(d.path, lineMap);
    }

    const DATA_global = (globalThis as any).DATA;
    const allViolations: any[] = DATA_global?.violations ?? [];
    const allRules: any[] = DATA_global?.rulesCatalog?.rules ?? [];

    // ── Build global call-edge index from pre-computed traces (19.5) ──────
    interface CallEdge {
      fromFile: string;
      fromName: string;
      toFile: string;
      toName: string;
      line: number | null;
    }
    const cgEdgeSet = new Set<string>();
    const cgCallersOf = new Map<string, CallEdge[]>(); // file → who calls into it
    const cgCalleesOf = new Map<string, CallEdge[]>(); // file → what it calls
    const cgTraces: any[] = DATA_global?.callGraph?.traces ?? [];
    for (const t of cgTraces) {
      const edges: any[] = [
        ...(t.forward?.edges ?? []),
        ...(t.backward?.edges ?? []),
      ];
      for (const e of edges) {
        const key = `${e.fromFile}:${e.fromCallerName ?? ""}→${e.toFile}:${e.toCalleeName ?? ""}`;
        if (cgEdgeSet.has(key)) continue;
        cgEdgeSet.add(key);
        const edge: CallEdge = {
          fromFile: e.fromFile,
          fromName: e.fromCallerName ?? "",
          toFile: e.toFile,
          toName: e.toCalleeName ?? "",
          line: e.callerLine ?? null,
        };
        const callers = cgCallersOf.get(e.toFile) ?? [];
        callers.push(edge);
        cgCallersOf.set(e.toFile, callers);
        const callees = cgCalleesOf.get(e.fromFile) ?? [];
        callees.push(edge);
        cgCalleesOf.set(e.fromFile, callees);
      }
    }

    // Per-file stats
    const allFiles = Object.keys(dm.sourceFiles as Record<string, string>);
    const fileDocCount = new Map<string, number>();
    const fileViolCount = new Map<string, number>();
    for (const srcPath of allFiles) {
      const links = allBackLinks.get(srcPath) ?? [];
      fileDocCount.set(srcPath, new Set(links.map((l: any) => l.docPath)).size);
      fileViolCount.set(
        srcPath,
        allViolations.filter(
          (v: any) =>
            v.filePath &&
            (v.filePath === srcPath || srcPath.startsWith(v.filePath + "/")),
        ).length,
      );
    }

    // Sort: by doc count desc, then name
    const sortedFiles = [...allFiles].sort((a, b) => {
      const da = fileDocCount.get(a) ?? 0;
      const db = fileDocCount.get(b) ?? 0;
      if (db !== da) return db - da;
      return a.localeCompare(b);
    });

    // Group by package (top 2 path segments)
    function getGroup(p: string): string {
      const parts = p.split("/");
      if (parts[0] === "packages" || parts[0] === "apps")
        return parts.slice(0, 2).join("/");
      return parts[0];
    }

    // Search bar
    const searchBar = document.createElement("div");
    searchBar.style.cssText =
      "padding:8px 10px;border-bottom:1px solid #e2e8f0;background:#fff;flex-shrink:0";
    searchBar.innerHTML = `<input id="ar-search-input" type="text" placeholder="Filter ${allFiles.length} source files…" style="width:100%;padding:4px 8px;font-size:11px;border:1px solid #d1d5db;border-radius:6px;outline:none;box-sizing:border-box">`;
    sidebar.appendChild(searchBar);

    const fileList = document.createElement("div");
    fileList.style.cssText = "overflow-y:auto;flex:1;min-height:0";
    sidebar.appendChild(fileList);

    let activeFilePath: string | null = null;

    function buildFileList(files: string[]): void {
      fileList.innerHTML = "";
      const groups = new Map<string, string[]>();
      for (const f of files) {
        const g = getGroup(f);
        const arr = groups.get(g) ?? [];
        arr.push(f);
        groups.set(g, arr);
      }
      for (const [group, gFiles] of groups.entries()) {
        const gh = document.createElement("div");
        gh.className = "ar-group-header";
        gh.textContent = group + "  (" + gFiles.length + ")";
        fileList.appendChild(gh);
        for (const srcPath of gFiles) {
          const dc = fileDocCount.get(srcPath) ?? 0;
          const vc = fileViolCount.get(srcPath) ?? 0;
          const filename = srcPath.split("/").pop() ?? srcPath;
          const subPath = srcPath.slice(group.length + 1);
          const item = document.createElement("div");
          item.className =
            "ar-file-item" + (srcPath === activeFilePath ? " active" : "");
          item.dataset.path = srcPath;
          item.innerHTML = `
            <div class="ar-file-name">${escHtml(filename)}</div>
            <div class="ar-file-path">${escHtml(subPath)}</div>
            <div class="ar-file-badges">
              ${
                dc > 0
                  ? `<span style="font-size:9px;background:#dcfce7;color:#166534;padding:1px 5px;border-radius:999px;font-weight:600">↑ ${dc} doc${dc !== 1 ? "s" : ""}</span>`
                  : `<span style="font-size:9px;background:#f1f5f9;color:#94a3b8;padding:1px 4px;border-radius:999px">no refs</span>`
              }
              ${vc > 0 ? `<span style="font-size:9px;background:#fee2e2;color:#991b1b;padding:1px 5px;border-radius:999px;font-weight:600">⚠ ${vc}</span>` : ""}
            </div>`;
          item.addEventListener("click", () => {
            fileList
              .querySelectorAll(".ar-file-item")
              .forEach((el: any) => el.classList.remove("active"));
            item.classList.add("active");
            openARSourceFile(srcPath);
          });
          fileList.appendChild(item);
        }
      }
    }

    buildFileList(sortedFiles);

    // Wire search
    const searchInput = searchBar.querySelector("#ar-search-input");
    if (searchInput) {
      (searchInput as any).addEventListener("input", () => {
        const q = (searchInput as any).value.toLowerCase();
        const filtered = q
          ? sortedFiles.filter((f: string) => f.toLowerCase().includes(q))
          : sortedFiles;
        buildFileList(filtered);
        const first = fileList.querySelector(".ar-file-item");
        if (first) {
          (first as any).classList.add("active");
          openARSourceFile((first as any).dataset.path);
        } else {
          viewer.innerHTML = `<div class="ar-welcome"><h3>🔍</h3><p>No files match "${escHtml(q)}"</p></div>`;
        }
      });
    }

    // Auto-open most-referenced file on load
    const firstItem = fileList.querySelector(".ar-file-item");
    if (firstItem) {
      openARSourceFile((firstItem as any).dataset.path);
    } else {
      viewer.innerHTML = `<div class="ar-welcome"><h3>🔍 AR Evidence Glasses</h3><p>No source files indexed.<br>Run <code>iw index build</code> to populate.</p></div>`;
    }

    // ── Open a source file in AR standalone mode ──────────────────────────
    function openARSourceFile(srcPath: string): void {
      activeFilePath = srcPath;
      const srcContent: string = (dm.sourceFiles as any)[srcPath] ?? "";
      if (!srcContent) {
        viewer.innerHTML = `<div class="ar-welcome"><p style="color:#ef4444">Content not available for<br><code>${escHtml(srcPath)}</code></p></div>`;
        return;
      }
      const ext = (srcPath.split(".").pop() ?? "").toLowerCase();
      const lang =
        ext === "ts" || ext === "tsx"
          ? "typescript"
          : ext === "js" || ext === "jsx"
            ? "javascript"
            : ext === "py"
              ? "python"
              : ext === "swift"
                ? "swift"
                : ext;
      const lines = srcContent.split("\n");
      const lineCount = lines.length;

      // Back-links for this file
      const backLinksByDoc = new Map<string, any[]>();
      for (const { docPath, ann } of allBackLinks.get(srcPath) ?? []) {
        const arr = backLinksByDoc.get(docPath) ?? [];
        arr.push(ann);
        backLinksByDoc.set(docPath, arr);
      }

      // lineToAnns — symbol definition lines referenced by docs
      const lineToAnns = new Map<
        number,
        Array<{ docPath: string; ann: any }>
      >();
      for (const { docPath, ann } of allBackLinks.get(srcPath) ?? []) {
        if (!ann.symbolLine) continue;
        const bucket = lineToAnns.get(ann.symbolLine) ?? [];
        bucket.push({ docPath, ann });
        lineToAnns.set(ann.symbolLine, bucket);
      }
      // Augment with self-annotation comment lines (source-comment KWX pass).
      // Nudge past structural comment markers (/**  */  * ) and blank lines so
      // the gutter dot lands on a visible content line, not on /** or */.
      // Map each mentioned symbol to its real cross-doc backlinks so the refs
      // panel shows actual .md documentation files, not the source file itself.
      const _structuralLine = /^\s*($|\*\/|\/\*\*?|\*\s*$)/;
      const selfCommentLines = selfAnnotations.get(srcPath);
      if (selfCommentLines) {
        // Index cross-doc backlinks by symbolName for fast lookup
        const backLinksBySymName = new Map<
          string,
          Array<{ docPath: string; ann: any }>
        >();
        for (const ref of allBackLinks.get(srcPath) ?? []) {
          if (!ref.ann.symbolName) continue;
          const arr = backLinksBySymName.get(ref.ann.symbolName) ?? [];
          arr.push(ref);
          backLinksBySymName.set(ref.ann.symbolName, arr);
        }
        for (const [docLine, anns] of selfCommentLines.entries()) {
          let targetLine = docLine;
          while (
            targetLine <= lines.length &&
            _structuralLine.test(lines[targetLine - 1] ?? "")
          ) {
            targetLine++;
          }
          if (targetLine > lines.length) targetLine = docLine; // fallback
          for (const ann of anns) {
            if (!ann.symbolName) continue;
            const crossRefs = backLinksBySymName.get(ann.symbolName) ?? [];
            for (const ref of crossRefs) {
              const bucket = lineToAnns.get(targetLine) ?? [];
              bucket.push(ref);
              lineToAnns.set(targetLine, bucket);
            }
          }
        }
      }

      // lineToSymbols
      const lineToSymbols = new Map<number, string[]>();
      for (const [lineNo, entries] of lineToAnns.entries()) {
        const syms = [
          ...new Set(entries.map((e) => e.ann.symbolName).filter(Boolean)),
        ];
        if (syms.length) lineToSymbols.set(lineNo, syms);
      }
      const annotatedLines = new Set<number>(lineToAnns.keys());

      // Violations + rules
      const fileViolations = allViolations.filter(
        (v: any) =>
          v.filePath &&
          (v.filePath === srcPath ||
            srcPath.startsWith(v.filePath + "/") ||
            v.filePath.startsWith(srcPath.replace(/\/[^/]+$/, ""))),
      );
      const governingRules = allRules.filter((r: any) =>
        (r.forbidden ?? []).some((f: any) => {
          if (!f.in) return false;
          const prefix = f.in.replace(/\/\*\*$/, "");
          return srcPath.startsWith(prefix + "/") || srcPath === prefix;
        }),
      );

      // Refs panel content renderer
      function renderRefsContent(filterLine: number | null): string {
        let html = "";
        const filteredByDoc =
          filterLine !== null
            ? (() => {
                const m = new Map<string, any[]>();
                for (const { docPath, ann } of lineToAnns.get(filterLine) ??
                  []) {
                  const arr = m.get(docPath) ?? [];
                  arr.push(ann);
                  m.set(docPath, arr);
                }
                return m;
              })()
            : backLinksByDoc;

        if (filteredByDoc.size > 0) {
          const label =
            filterLine !== null
              ? `📄 ${filteredByDoc.size} doc${filteredByDoc.size !== 1 ? "s" : ""} — line ${filterLine}`
              : `📄 Referenced by ${filteredByDoc.size} doc${filteredByDoc.size !== 1 ? "s" : ""}`;
          html += `<div class="src-refs-section">${label}</div>`;
          for (const [docPath, anns] of filteredByDoc.entries()) {
            const uniqueSymbols = [
              ...new Set(anns.map((a: any) => a.symbolName)),
            ].slice(0, 4);
            const docLines = [
              ...new Set(anns.map((a: any) => a.symbolLine).filter(Boolean)),
            ]
              .sort((a: any, b: any) => a - b)
              .slice(0, 4);
            const primarySym = uniqueSymbols[0] ?? "";
            html += `<div class="src-ref-doc-item" data-doc="${escHtml(docPath)}" data-sym="${escHtml(primarySym)}">
              <div class="src-ref-doc-name">${escHtml(docTitle(docPath))}</div>
              <div class="src-ref-doc-path">${escHtml(docPath)}</div>
              <div class="src-ref-symbols">${uniqueSymbols.map((s: string) => `<code>${escHtml(s)}</code>`).join(" ")}</div>
              ${docLines.length > 0 ? `<div class="src-ref-lines">lines: ${docLines.map((l: number) => `<a class="src-ln-ref" data-line="${l}">:${l}</a>`).join(" ")}</div>` : ""}
            </div>`;
          }
        } else if (filterLine !== null) {
          html += `<div class="src-refs-empty" style="padding:10px 14px">No docs reference line ${filterLine}.</div>`;
        } else {
          html += `<div class="src-refs-empty">No documentation references.<br><span style="font-size:10px;color:#94a3b8">Export symbols from this file and mention them in .md files to create evidence links.</span></div>`;
        }
        if (fileViolations.length > 0) {
          html += `<div class="src-refs-section">⚠ ${fileViolations.length} violation${fileViolations.length !== 1 ? "s" : ""}</div>`;
          for (const v of fileViolations.slice(0, 8)) {
            const dc =
              v.ruleDomain === "structural"
                ? "#7c3aed"
                : v.ruleDomain === "behavioral"
                  ? "#0369a1"
                  : "#374151";
            html += `<div class="src-ref-violation">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                <code style="font-size:10px;color:${escHtml(dc)}">${escHtml(v.ruleId)}</code>
                <span style="font-size:9px;background:#fee2e2;color:#991b1b;border-radius:3px;padding:1px 4px;font-weight:700">${escHtml(v.severity?.toUpperCase() ?? "")}</span>
              </div>
              <div style="font-size:10px;color:#64748b;line-height:1.4">${escHtml(v.detail ?? "")}</div>
            </div>`;
          }
        }
        if (governingRules.length > 0) {
          html += `<div class="src-refs-section">📋 Governed by ${governingRules.length} rule${governingRules.length !== 1 ? "s" : ""}</div>`;
          for (const r of governingRules.slice(0, 5)) {
            html += `<div class="src-ref-rule">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                <code style="font-size:10px;color:#7c3aed">${escHtml(r.id)}</code>
                <span style="font-size:9px;background:#f3e8ff;color:#6b21a8;border-radius:3px;padding:1px 4px;font-weight:700">${escHtml((r.severity ?? "").toUpperCase())}</span>
              </div>
              <div style="font-size:10px;color:#64748b;line-height:1.4;max-height:44px;overflow:hidden">${escHtml((r.description ?? "").trim().slice(0, 120))}${(r.description ?? "").length > 120 ? "…" : ""}</div>
            </div>`;
          }
        }
        return html;
      }

      // Header (no back button — sidebar handles navigation)
      const srcHeader = `<div class="dm-doc-header">
        <div style="display:flex;align-items:flex-start;gap:12px">
          <div style="flex:1;min-width:0">
            <h2 style="margin:0 0 2px;font-size:16px;font-weight:800;color:#1e293b">${escHtml(srcPath.split("/").pop() ?? srcPath)}</h2>
            <div style="font-size:10px;color:#94a3b8">${escHtml(srcPath)}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex-shrink:0">
            <span style="font-size:11px;background:#f3e8ff;color:#7c3aed;padding:2px 8px;border-radius:999px;font-weight:600">${lineCount} lines</span>
            ${backLinksByDoc.size > 0 ? `<span style="font-size:11px;background:#dcfce7;color:#166534;padding:2px 8px;border-radius:999px;font-weight:600">↑ ${backLinksByDoc.size} doc${backLinksByDoc.size !== 1 ? "s" : ""}</span>` : ""}
            ${fileViolations.length > 0 ? `<span style="font-size:11px;background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:999px;font-weight:600">⚠ ${fileViolations.length}</span>` : ""}
          </div>
        </div>
      </div>`;

      // Code lines
      const linesHtml = lines
        .map((ln, i) => {
          const lineNo = i + 1;
          const isAnnotated = annotatedLines.has(lineNo);
          const nDocs = isAnnotated ? (lineToAnns.get(lineNo)?.length ?? 0) : 0;
          const dot = isAnnotated
            ? `<span class="src-gutter-dot" data-line="${lineNo}" title="Click to filter: ${nDocs} ref${nDocs !== 1 ? "s" : ""} on line ${lineNo}">●</span>`
            : `<span class="src-gutter-empty"></span>`;
          return `${dot}<span class="src-ln" id="ar-ln-${lineNo}">${lineNo}</span>${highlightLine(ln, lang)}`;
        })
        .join("\n");

      // Build call-graph panel for current file (19.5)
      function renderCallGraphContent(file: string): string {
        const callers = cgCallersOf.get(file) ?? [];
        const callees = cgCalleesOf.get(file) ?? [];
        if (callers.length === 0 && callees.length === 0) {
          return `<div class="src-refs-empty">No call graph data for this file.<br><span style="font-size:10px;color:#94a3b8">Run <code>iw index build</code> on a TypeScript codebase to populate.</span></div>`;
        }
        let html = "";
        if (callers.length > 0) {
          html += `<div class="src-refs-section">▲ Called by (${callers.length})</div>`;
          const seen = new Set<string>();
          for (const e of callers.slice(0, 20)) {
            const k = `${e.fromFile}:${e.fromName}`;
            if (seen.has(k)) continue;
            seen.add(k);
            html += `<div class="src-ref-doc-item" style="cursor:default">
              <div class="src-ref-doc-name" style="color:#ec4899">${escHtml(e.fromName || "(anon)")}</div>
              <div class="src-ref-doc-path">${escHtml(shortPath(e.fromFile, 40))}</div>
              ${e.line ? `<div class="src-ref-lines">line ${e.line}</div>` : ""}
            </div>`;
          }
        }
        if (callees.length > 0) {
          html += `<div class="src-refs-section">▼ Calls into (${callees.length})</div>`;
          const seen = new Set<string>();
          for (const e of callees.slice(0, 20)) {
            const k = `${e.toFile}:${e.toName}`;
            if (seen.has(k)) continue;
            seen.add(k);
            html += `<div class="src-ref-doc-item" style="cursor:default">
              <div class="src-ref-doc-name" style="color:#0ea5e9">${escHtml(e.toName || "(anon)")}</div>
              <div class="src-ref-doc-path">${escHtml(shortPath(e.toFile, 40))}</div>
            </div>`;
          }
        }
        return html;
      }

      const refsHtml = `<div class="src-refs-panel" id="ar-refs-panel">
        <div class="src-refs-title" style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <div style="display:flex;gap:0;flex:1">
            <button id="ar-tab-ev" class="ar-tab-btn ar-tab-active" style="flex:1;padding:4px 6px;font-size:10px;font-weight:700;border:none;border-bottom:2px solid #3b82f6;background:none;color:#1d4ed8;cursor:pointer">🔗 Evidence</button>
            <button id="ar-tab-cg" class="ar-tab-btn" style="flex:1;padding:4px 6px;font-size:10px;font-weight:700;border:none;border-bottom:2px solid transparent;background:none;color:#6b7280;cursor:pointer">📞 Call Graph</button>
          </div>
          <button id="ar-refs-reset" style="display:none;font-size:9px;border:none;background:#e2e8f0;color:#374151;border-radius:3px;padding:1px 6px;cursor:pointer;flex-shrink:0">show all</button>
        </div>
        <div id="ar-refs-body">${renderRefsContent(null)}</div>
        <div id="ar-cg-body" style="display:none">${renderCallGraphContent(srcPath)}</div>
      </div>`;

      viewer.innerHTML = `<div class="dm-src-view">${srcHeader}<div class="src-split"><pre class="dm-src-body lang-${escHtml(lang)}" id="ar-src-pre"><code id="ar-src-code">${linesHtml}</code></pre>${refsHtml}</div></div>`;

      // Inject inline annotation highlights.
      // Comment lines render as <span class="src-comment">…</span> — a child element,
      // not a text node. Code lines render as a plain text node after the line-number span.
      // Strategy: search for each symbol name in the rendered content using word-boundary
      // regex and wrap all occurrences in <mark class="src-ann-highlight">.
      const codeEl = viewer.querySelector("#ar-src-code");
      if (codeEl && lineToSymbols.size > 0) {
        for (const [lineNo, syms] of lineToSymbols.entries()) {
          const lineSpan = viewer.querySelector(`#ar-ln-${lineNo}`) as any;
          if (!lineSpan) continue;
          const next = lineSpan.nextSibling as any;
          if (!next) continue;

          const isCommentSpan =
            next.nodeType === 1 &&
            (next as any).classList.contains("src-comment");

          if (isCommentSpan) {
            // Comment line — do innerHTML replacement inside the comment span.
            // Safe: src-comment spans only contain plain-text HTML-escaped content.
            const commentEl = next as any;
            let html = commentEl.innerHTML;
            const sorted = [...syms].sort((a, b) => b.length - a.length);
            for (const sym of sorted) {
              if (sym.length < 2) continue;
              const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              // word boundary: not preceded/followed by word char or $
              const re = new RegExp("(?<![\\w$])(" + esc + ")(?![\\w$])", "gi");
              if (re.test(html)) {
                html = html.replace(
                  re,
                  '<mark class="src-ann-highlight" data-line="' +
                    lineNo +
                    '" data-sym="' +
                    sym +
                    '" title="Click to show references for: ' +
                    sym +
                    '" style="cursor:pointer">$1</mark>',
                );
              }
            }
            commentEl.innerHTML = html;
          } else if (next.nodeType === 3) {
            // Code line — wrap first matching symbol as a clickable filter link.
            let textNode = next as any;
            const raw = textNode.textContent ?? "";
            const sorted = [...syms].sort((a, b) => b.length - a.length);
            for (const sym of sorted) {
              if (sym.length < 2) continue;
              const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const idx = raw.search(
                new RegExp("(?<![\\w$])" + esc + "(?![\\w$])"),
              );
              if (idx < 0) continue;
              const symSpan = document.createElement("span");
              symSpan.className = "src-sym-link";
              symSpan.dataset.line = String(lineNo);
              symSpan.dataset.sym = sym;
              symSpan.title = `Click to filter — "${sym}"`;
              symSpan.textContent = sym;
              const parent = lineSpan.parentNode;
              if (!parent) break;
              parent.insertBefore(
                document.createTextNode(raw.slice(0, idx)),
                textNode,
              );
              parent.insertBefore(symSpan, textNode);
              parent.insertBefore(
                document.createTextNode(raw.slice(idx + sym.length)),
                textNode,
              );
              parent.removeChild(textNode);
              break;
            }
          }
        }
      }

      // Filter state
      let activeFilterLine: number | null = null;
      const refsBody = viewer.querySelector("#ar-refs-body");
      const refsReset = viewer.querySelector("#ar-refs-reset");

      function applyLineFilter(lineNo: number | null): void {
        activeFilterLine = lineNo;
        if (refsBody) refsBody.innerHTML = renderRefsContent(lineNo);
        if (refsReset)
          (refsReset as any).style.display =
            lineNo !== null ? "inline" : "none";
        viewer.querySelectorAll(".src-gutter-dot").forEach((d: any) => {
          d.classList.toggle(
            "src-gutter-dot-active",
            lineNo !== null && parseInt(d.dataset.line, 10) === lineNo,
          );
        });
        viewer.querySelectorAll(".src-sym-link").forEach((s: any) => {
          s.classList.toggle(
            "src-sym-link-active",
            lineNo !== null && parseInt(s.dataset.line, 10) === lineNo,
          );
        });
        viewer.querySelectorAll(".src-ann-highlight").forEach((m: any) => {
          m.classList.toggle(
            "src-ann-highlight-active",
            lineNo !== null && parseInt(m.dataset.line, 10) === lineNo,
          );
        });
        wireRefsPanel();
      }

      function wireRefsPanel(): void {
        (refsBody ?? viewer)
          .querySelectorAll(".src-ref-doc-item")
          .forEach((item: any) => {
            item.addEventListener("click", (e: any) => {
              if (e.target.classList.contains("src-ln-ref")) return;
              // Navigate to the doc in the Docs sidebar section (same chapter)
              const idx = dm.docs.findIndex(
                (d: any) => d.path === item.dataset.doc,
              );
              if (idx < 0) return;
              const navItem = document.querySelector(
                `#docmap-docs-section .dm-nav-item[data-idx="${idx}"]`,
              );
              if (navItem) {
                (navItem as any).click();
                // Scroll to the first ann-mark matching the primary symbol
                const sym = item.dataset.sym ?? "";
                if (sym) {
                  const key = sym.toLowerCase().replace(/[^a-z0-9]/g, "");
                  const mark = viewer.querySelector(
                    `.ann-mark[data-ak="${key}"]`,
                  );
                  if (mark)
                    (mark as any).scrollIntoView({
                      block: "center",
                      behavior: "smooth",
                    });
                }
              }
            });
          });
        (refsBody ?? viewer)
          .querySelectorAll(".src-ln-ref")
          .forEach((a: any) => {
            a.addEventListener("click", (e: any) => {
              e.stopPropagation();
              const ln = parseInt(a.dataset.line, 10);
              const el = viewer.querySelector(`#ar-ln-${ln}`);
              if (el) (el as any).scrollIntoView({ block: "center" });
            });
          });
      }

      if (refsReset)
        refsReset.addEventListener("click", () => applyLineFilter(null));

      // Tab toggle (Evidence Links ↔ Call Graph) — 19.5
      const tabEv = viewer.querySelector("#ar-tab-ev");
      const tabCg = viewer.querySelector("#ar-tab-cg");
      const refsBodyEl = viewer.querySelector("#ar-refs-body");
      const cgBodyEl = viewer.querySelector("#ar-cg-body");
      if (tabEv && tabCg) {
        tabEv.addEventListener("click", () => {
          (tabEv as any).style.borderBottomColor = "#3b82f6";
          (tabEv as any).style.color = "#1d4ed8";
          (tabCg as any).style.borderBottomColor = "transparent";
          (tabCg as any).style.color = "#6b7280";
          if (refsBodyEl) (refsBodyEl as any).style.display = "block";
          if (cgBodyEl) (cgBodyEl as any).style.display = "none";
          if (refsReset)
            (refsReset as any).style.display =
              activeFilterLine !== null ? "inline" : "none";
        });
        tabCg.addEventListener("click", () => {
          (tabCg as any).style.borderBottomColor = "#3b82f6";
          (tabCg as any).style.color = "#1d4ed8";
          (tabEv as any).style.borderBottomColor = "transparent";
          (tabEv as any).style.color = "#6b7280";
          if (refsBodyEl) (refsBodyEl as any).style.display = "none";
          if (cgBodyEl) (cgBodyEl as any).style.display = "block";
          if (refsReset) (refsReset as any).style.display = "none";
        });
      }

      viewer.querySelectorAll(".src-gutter-dot").forEach((dot: any) => {
        dot.addEventListener("click", () => {
          const lineNo = parseInt(dot.dataset.line, 10);
          if (activeFilterLine === lineNo) applyLineFilter(null);
          else applyLineFilter(lineNo);
        });
      });
      viewer.querySelectorAll(".src-sym-link").forEach((span: any) => {
        span.addEventListener("click", () => {
          const lineNo = parseInt(span.dataset.line, 10);
          if (activeFilterLine === lineNo) applyLineFilter(null);
          else applyLineFilter(lineNo);
        });
      });

      viewer.querySelectorAll(".src-ann-highlight").forEach((m: any) => {
        m.addEventListener("click", () => {
          const lineNo = parseInt(m.dataset.line, 10);
          if (activeFilterLine === lineNo) applyLineFilter(null);
          else applyLineFilter(lineNo);
        });
      });

      wireRefsPanel();
    }

    // Expose globally so other chapters can jump directly into the source viewer
    (globalThis as any).__openARSourceFile = openARSourceFile;
  }

  // ── Layer Import Flow Sankey (item 5) ────────────────────────────────────
  function buildLayerSankeyHtml(): string {
    type FlowDef = {
      fromLayer: string;
      toLayer: string;
      fromLayerIndex: number;
      toLayerIndex: number;
      importCount: number;
      violationCount: number;
      isViolation: boolean;
    };
    const sankeyFlows = (data as any).layerFlows as FlowDef[] | undefined;
    if (!sankeyFlows || sankeyFlows.length === 0) return "";

    // Derive unique layers ordered top-to-bottom by index (highest = top)
    const layerMap = new Map<number, string>();
    for (const f of sankeyFlows) {
      layerMap.set(f.fromLayerIndex, f.fromLayer);
      layerMap.set(f.toLayerIndex, f.toLayer);
    }
    const orderedLayers = [...layerMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([idx, name]) => ({ idx, name }));
    const N = orderedLayers.length;
    if (N < 2) return "";

    // Layout
    const W = 820,
      NODE_W = 110,
      NODE_H = 38,
      ROW_GAP = 18;
    const MARGIN_TOP = 14,
      MARGIN_BOT = 32;
    const rowH = NODE_H + ROW_GAP;
    const SVG_H = MARGIN_TOP + N * rowH - ROW_GAP + MARGIN_BOT;
    const xLeft = 10,
      xRight = W - 10 - NODE_W;
    const xBandLeft = xLeft + NODE_W,
      xBandRight = xRight;
    const bw = xBandRight - xBandLeft;

    const rowOf = new Map(orderedLayers.map(({ idx }, i) => [idx, i]));
    const nodeY = (idx: number) => MARGIN_TOP + (rowOf.get(idx) ?? 0) * rowH;

    // Scale: fit sum of outflow bands within NODE_H * 0.82
    const MAX_BAND_H = NODE_H * 0.82;
    const totalOut = new Map<number, number>();
    const totalIn = new Map<number, number>();
    for (const f of sankeyFlows) {
      totalOut.set(
        f.fromLayerIndex,
        (totalOut.get(f.fromLayerIndex) ?? 0) + f.importCount,
      );
      totalIn.set(
        f.toLayerIndex,
        (totalIn.get(f.toLayerIndex) ?? 0) + f.importCount,
      );
    }
    const maxTotal = Math.max(
      ...[...totalOut.values()],
      ...[...totalIn.values()],
      1,
    );
    const scale = MAX_BAND_H / maxTotal;

    // Sort flows for stable ordering within each node
    const sortedFlows = [...sankeyFlows].sort(
      (a, b) =>
        (rowOf.get(a.fromLayerIndex) ?? 0) -
          (rowOf.get(b.fromLayerIndex) ?? 0) ||
        (rowOf.get(a.toLayerIndex) ?? 0) - (rowOf.get(b.toLayerIndex) ?? 0),
    );

    // Compute starting Y offsets (centered within node)
    const leftRunning = new Map<number, number>();
    const rightRunning = new Map<number, number>();
    for (const { idx } of orderedLayers) {
      const outH = Math.min((totalOut.get(idx) ?? 0) * scale, MAX_BAND_H);
      const inH = Math.min((totalIn.get(idx) ?? 0) * scale, MAX_BAND_H);
      leftRunning.set(idx, (NODE_H - outH) / 2);
      rightRunning.set(idx, (NODE_H - inH) / 2);
    }

    type BandDef = {
      yFrom: number;
      yTo: number;
      bandH: number;
      flow: FlowDef;
    };
    const bands: BandDef[] = [];
    for (const f of sortedFlows) {
      const bandH = Math.max(2, Math.min(f.importCount * scale, MAX_BAND_H));
      const lOff = leftRunning.get(f.fromLayerIndex) ?? 0;
      const rOff = rightRunning.get(f.toLayerIndex) ?? 0;
      bands.push({
        yFrom: nodeY(f.fromLayerIndex) + lOff + bandH / 2,
        yTo: nodeY(f.toLayerIndex) + rOff + bandH / 2,
        bandH,
        flow: f,
      });
      leftRunning.set(f.fromLayerIndex, lOff + bandH);
      rightRunning.set(f.toLayerIndex, rOff + bandH);
    }

    let svg = `<svg viewBox="0 0 ${W} ${SVG_H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">`;

    // Bands (behind nodes)
    for (const { yFrom, yTo, bandH, flow } of bands) {
      const cx1 = xBandLeft + bw * 0.4,
        cx2 = xBandRight - bw * 0.4;
      const color = flow.isViolation ? "#ef4444" : "#3b82f6";
      const fillOp = flow.isViolation ? 0.6 : 0.3;
      const tip = `${esc(flow.fromLayer)} \u2192 ${esc(flow.toLayer)}: ${flow.importCount} import${flow.importCount !== 1 ? "s" : ""}${flow.violationCount > 0 ? ` \u00b7 ${flow.violationCount} violation${flow.violationCount !== 1 ? "s" : ""}` : ""}`;
      const y0t = (yFrom - bandH / 2).toFixed(1);
      const y0b = (yFrom + bandH / 2).toFixed(1);
      const y1t = (yTo - bandH / 2).toFixed(1);
      const y1b = (yTo + bandH / 2).toFixed(1);
      svg += `<path d="M ${xBandLeft},${y0t} C ${cx1},${y0t} ${cx2},${y1t} ${xBandRight},${y1t} L ${xBandRight},${y1b} C ${cx2},${y1b} ${cx1},${y0b} ${xBandLeft},${y0b} Z" fill="${color}" fill-opacity="${fillOp}"><title>${tip}</title></path>`;
    }

    // Nodes
    for (const { idx, name } of orderedLayers) {
      const y = nodeY(idx);
      const short = esc(name.replace(/^(packages|apps)\//, ""));
      const outCnt = totalOut.get(idx) ?? 0;
      const inCnt = totalIn.get(idx) ?? 0;
      // Left (source) node
      svg += `<rect x="${xLeft}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>`;
      svg += `<text x="${xLeft + NODE_W / 2}" y="${y + NODE_H / 2 - 5}" text-anchor="middle" font-size="11" font-family="ui-monospace,monospace" font-weight="600" fill="#1e293b">${short}</text>`;
      svg += `<text x="${xLeft + NODE_W / 2}" y="${y + NODE_H / 2 + 9}" text-anchor="middle" font-size="9" font-family="ui-sans-serif,sans-serif" fill="#64748b">out: ${outCnt}</text>`;
      // Right (target) node
      svg += `<rect x="${xRight}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>`;
      svg += `<text x="${xRight + NODE_W / 2}" y="${y + NODE_H / 2 - 5}" text-anchor="middle" font-size="11" font-family="ui-monospace,monospace" font-weight="600" fill="#1e293b">${short}</text>`;
      svg += `<text x="${xRight + NODE_W / 2}" y="${y + NODE_H / 2 + 9}" text-anchor="middle" font-size="9" font-family="ui-sans-serif,sans-serif" fill="#64748b">in: ${inCnt}</text>`;
    }

    // Legend
    const ly = SVG_H - 16;
    svg += `<circle cx="${W / 2 - 74}" cy="${ly}" r="5" fill="#3b82f6" fill-opacity="0.7"/>`;
    svg += `<text x="${W / 2 - 66}" y="${ly + 4}" font-size="10" font-family="ui-sans-serif,sans-serif" fill="#64748b">Allowed imports</text>`;
    svg += `<circle cx="${W / 2 + 36}" cy="${ly}" r="5" fill="#ef4444" fill-opacity="0.8"/>`;
    svg += `<text x="${W / 2 + 44}" y="${ly + 4}" font-size="10" font-family="ui-sans-serif,sans-serif" fill="#64748b">Violations \u00b7 band width \u221d import count</text>`;

    svg += `</svg>`;

    const totalViol = sankeyFlows.reduce((s, f) => s + f.violationCount, 0);
    const subtitle =
      totalViol > 0
        ? `${sankeyFlows.length} cross-layer flows · <span style="color:#ef4444;font-weight:600">${totalViol} violation${totalViol !== 1 ? "s" : ""}</span>`
        : `${sankeyFlows.length} cross-layer flows · all allowed`;
    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 10px 10px;margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding:0 4px">
        <span style="font-size:12px;font-weight:600;color:#475569">Layer Import Flows</span>
        <span style="font-size:11px;color:#6b7280">${subtitle}</span>
      </div>
      ${svg}
    </div>`;
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
      // ── Package-priority treemap ──────────────────────────────────────────
      const tmHotData = (data as any).hotspots as
        | {
            priorities?: Array<{
              filePath: string;
              churn: number;
              coveragePercent: number;
              priorityScore: number;
              totalExportedSymbols: number;
            }>;
          }
        | undefined;
      const tmFiles = tmHotData?.priorities ?? [];
      if (tmFiles.length > 0) {
        type TmNode = {
          name: string;
          value: number;
          avgCoverage: number;
          count: number;
        };
        type TmRect = TmNode & { x: number; y: number; w: number; h: number };
        const tmPartition = (
          items: TmNode[],
          x: number,
          y: number,
          w: number,
          ht: number,
        ): TmRect[] => {
          if (items.length === 0) return [];
          if (items.length === 1) return [{ ...items[0], x, y, w, h: ht }];
          const total = items.reduce((s, i) => s + i.value, 0);
          let acc = 0,
            split = 0;
          for (let i = 0; i < items.length - 1; i++) {
            acc += items[i].value;
            if (acc * 2 >= total) {
              split = i + 1;
              break;
            }
          }
          if (!split) split = Math.floor(items.length / 2) || 1;
          const frac =
            items.slice(0, split).reduce((s, i) => s + i.value, 0) / total;
          if (w >= ht) {
            const lw = Math.max(1, w * frac);
            return [
              ...tmPartition(items.slice(0, split), x, y, lw, ht),
              ...tmPartition(items.slice(split), x + lw, y, w - lw, ht),
            ];
          } else {
            const th = Math.max(1, ht * frac);
            return [
              ...tmPartition(items.slice(0, split), x, y, w, th),
              ...tmPartition(items.slice(split), x, y + th, w, ht - th),
            ];
          }
        };
        const tmCovColor = (pct: number) => {
          pct = Math.max(0, Math.min(100, pct));
          if (pct >= 70) {
            const t = (pct - 70) / 30;
            return `rgb(${Math.round(245 - 211 * t)},${Math.round(158 + 39 * t)},${Math.round(11 + 83 * t)})`;
          }
          const t = pct / 70;
          return `rgb(${Math.round(220 + 25 * t)},${Math.round(38 + 120 * t)},${Math.round(38 - 27 * t)})`;
        };
        const tmGroupMap = new Map<
          string,
          { covSum: number; cnt: number; totalPri: number }
        >();
        for (const f of tmFiles) {
          if (f.priorityScore <= 0) continue;
          const parts = f.filePath.replace(/\\/g, "/").split("/");
          const grp = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
          const g = tmGroupMap.get(grp) ?? { covSum: 0, cnt: 0, totalPri: 0 };
          g.covSum += f.coveragePercent;
          g.cnt++;
          g.totalPri += f.priorityScore;
          tmGroupMap.set(grp, g);
        }
        const tmGroupArr: TmNode[] = [...tmGroupMap.entries()]
          .filter(([, g]) => g.totalPri > 0)
          .map(([name, g]) => ({
            name,
            value: g.totalPri,
            avgCoverage: g.cnt > 0 ? g.covSum / g.cnt : 0,
            count: g.cnt,
          }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 40);
        if (tmGroupArr.length > 0) {
          const TW = 900,
            TH = 260;
          const tmCells = tmPartition(tmGroupArr, 0, 0, TW, TH);
          let tmSvg = `<svg viewBox="0 0 ${TW} ${TH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;border-radius:6px;overflow:hidden">`;
          for (const c of tmCells) {
            const color = tmCovColor(c.avgCoverage);
            const isDark = c.avgCoverage < 45;
            const tf = isDark ? "#fff" : "#1a1a1a";
            const short = c.name.replace(/^(packages|apps)\//, "");
            const titleTxt = `${esc(c.name)}: ${c.avgCoverage.toFixed(0)}% avg coverage · ${c.count} file${c.count !== 1 ? "s" : ""} · priority ${c.value.toFixed(0)}`;
            tmSvg += `<g><rect x="${(c.x + 1).toFixed(1)}" y="${(c.y + 1).toFixed(1)}" width="${Math.max(0, c.w - 2).toFixed(1)}" height="${Math.max(0, c.h - 2).toFixed(1)}" rx="3" fill="${color}" fill-opacity="0.9"><title>${titleTxt}</title></rect>`;
            if (c.w > 55 && c.h > 26) {
              const fs = Math.min(
                13,
                Math.max(8, Math.floor(c.w / (short.length * 0.72))),
              );
              const lbl =
                short.length > 22 ? short.slice(0, 20) + "\u2026" : short;
              tmSvg += `<text x="${(c.x + c.w / 2).toFixed(1)}" y="${(c.y + c.h / 2 - (c.h > 42 ? 7 : 0)).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="${fs}" font-family="ui-sans-serif,sans-serif" font-weight="600" fill="${tf}" pointer-events="none">${esc(lbl)}</text>`;
              if (c.h > 42) {
                tmSvg += `<text x="${(c.x + c.w / 2).toFixed(1)}" y="${(c.y + c.h / 2 + 8).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10" font-family="ui-sans-serif,sans-serif" fill="${tf}" fill-opacity="0.8" pointer-events="none">${c.avgCoverage.toFixed(0)}%</text>`;
              }
            }
            tmSvg += `</g>`;
          }
          tmSvg += `</svg>`;
          h += `<div style="margin-bottom:18px">
            <div style="font-size:11px;color:#6b7280;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
              <span>Cell area = churn priority · hover for details · ${tmGroupArr.length} packages</span>
              <span style="display:flex;gap:8px;align-items:center">
                <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:10px;height:10px;background:#22c55e;border-radius:2px;display:inline-block"></span>≥70% covered</span>
                <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:10px;height:10px;background:#f59e0b;border-radius:2px;display:inline-block"></span>40–70%</span>
                <span style="display:inline-flex;align-items:center;gap:3px"><span style="width:10px;height:10px;background:#dc2626;border-radius:2px;display:inline-block"></span>&lt;40%</span>
              </span>
            </div>
            ${tmSvg}
          </div>`;
        }
      }
      h += buildLayerSankeyHtml();

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

  // ── Living Score chapter ──────────────────────────────────────────────────
  function buildLivingScoreHtml(): string {
    const ls = (data as any).livingScore as {
      score: number;
      grade: string;
      specCoverage: { score: number; available: boolean; detail: string };
      constraintConsistency: {
        score: number;
        available: boolean;
        detail: string;
      };
      docFreshness: { score: number; available: boolean; detail: string };
      archConformance: { score: number; available: boolean; detail: string };
    };
    const gradeColor =
      ls.grade === "A"
        ? "#166534"
        : ls.grade === "B"
          ? "#065f46"
          : ls.grade === "C"
            ? "#92400e"
            : ls.grade === "D"
              ? "#9a3412"
              : "#991b1b";
    const gradeBg =
      ls.grade === "A"
        ? "#dcfce7"
        : ls.grade === "B"
          ? "#d1fae5"
          : ls.grade === "C"
            ? "#fef3c7"
            : ls.grade === "D"
              ? "#ffedd5"
              : "#fee2e2";
    const dims = [
      {
        key: "specCoverage",
        label: "Spec Coverage",
        icon: "📋",
        chapter: "chapter-coverage",
        dim: ls.specCoverage,
      },
      {
        key: "constraintConsistency",
        label: "Constraint Consistency",
        icon: "🔒",
        chapter: "chapter-violations",
        dim: ls.constraintConsistency,
      },
      {
        key: "docFreshness",
        label: "Documentation Freshness",
        icon: "📅",
        chapter: "chapter-documentation",
        dim: ls.docFreshness,
      },
      {
        key: "archConformance",
        label: "Architecture Conformance",
        icon: "🏛",
        chapter: "chapter-layers",
        dim: ls.archConformance,
      },
    ];

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">📈 Living Documentation Score</h1>
      <p class="chapter-subtitle">Composite quality score across 4 dimensions · spec, consistency, freshness, conformance</p>
    </div>
    <div class="chapter-body">
      <div style="display:flex;align-items:center;gap:24px;margin-bottom:24px;padding:20px 24px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
        <div style="flex-shrink:0;width:88px;height:88px;border-radius:50%;background:${gradeBg};border:4px solid ${gradeColor};display:flex;align-items:center;justify-content:center">
          <span style="font-size:40px;font-weight:900;color:${gradeColor};line-height:1">${esc(ls.grade)}</span>
        </div>
        <div>
          <div style="font-size:32px;font-weight:800;color:#1f2937;line-height:1">${Math.round(ls.score)}<span style="font-size:16px;font-weight:400;color:#6b7280"> / 100</span></div>
          <div style="font-size:13px;color:#6b7280;margin-top:4px">Overall living documentation health</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:6px">A ≥ 90 · B ≥ 75 · C ≥ 60 · D ≥ 45 · F &lt; 45</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">`;

    dims.forEach(({ label, icon, chapter, dim }) => {
      const sc = dim.available ? Math.round(dim.score) : null;
      const barColor =
        sc === null
          ? "#d1d5db"
          : sc >= 75
            ? "#22c55e"
            : sc >= 50
              ? "#f59e0b"
              : "#ef4444";
      const dimBg = dim.available ? "#fff" : "#f9fafb";
      h += `<div style="background:${dimBg};border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="font-size:16px">${icon}</span>
          <span style="font-size:13px;font-weight:700;color:#1f2937">${esc(label)}</span>
          ${dim.available ? "" : `<span class="badge low" style="margin-left:auto;font-size:9px">N/A</span>`}
        </div>
        ${
          dim.available && sc !== null
            ? `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="flex:1;height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden">
            <div style="width:${sc}%;height:100%;background:${barColor};border-radius:5px"></div>
          </div>
          <span style="font-size:18px;font-weight:800;color:${barColor};min-width:40px;text-align:right">${sc}%</span>
        </div>`
            : `<div style="font-size:12px;color:#9ca3af;margin-bottom:8px">Not enough data to compute this dimension.</div>`
        }
        <div style="font-size:11px;color:#6b7280;line-height:1.5">${esc(dim.detail)}</div>
        <div style="margin-top:8px;text-align:right">
          <button class="btn-goto" onclick="activateChapter('${chapter}')" style="font-size:10px">↗ Details</button>
        </div>
      </div>`;
    });

    h += `</div>
      <div style="margin-top:16px;padding:12px 14px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;font-size:12px;color:#0c4a6e">
        <b>Tip:</b> Run <code>iw intent score</code> in the CLI for detailed per-dimension breakdowns and improvement suggestions.
      </div>
    </div>`;
    return h;
  }

  // ── Tech Debt (TODOs) chapter (19.8b) ────────────────────────────────────
  function buildTechDebtHtml(): string {
    const hotspots = (data as any).hotspots as
      | {
          todos?: {
            items: Array<{
              filePath: string;
              line: number;
              kind: string;
              text: string;
            }>;
            totalCount: number;
            byKind: Record<string, number>;
          };
        }
      | undefined;
    const todosData = hotspots?.todos;
    if (!todosData || todosData.totalCount === 0) {
      return `<div class="empty-state"><span style="font-size:32px">✅</span><p>No TODO/FIXME/HACK/XXX markers found.</p></div>`;
    }
    const kindColor: Record<string, string> = {
      TODO: "#3b82f6",
      FIXME: "#ef4444",
      HACK: "#f97316",
      XXX: "#8b5cf6",
    };
    const kindBg: Record<string, string> = {
      TODO: "#eff6ff",
      FIXME: "#fef2f2",
      HACK: "#fff7ed",
      XXX: "#f5f3ff",
    };
    let h = `<div class="chapter-header"><h2>Tech Debt</h2><div class="chapter-sub">Inline markers requiring attention · ${todosData.totalCount} total</div></div>`;
    // Summary pills
    h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">`;
    for (const [kind, count] of Object.entries(todosData.byKind).sort(
      ([, a], [, b]) => (b as number) - (a as number),
    )) {
      const col = kindColor[kind] ?? "#6b7280";
      const bg = kindBg[kind] ?? "#f9fafb";
      h += `<div style="background:${bg};border:1px solid ${col};border-radius:20px;padding:4px 14px;font-size:12px;font-weight:700;color:${col}">${esc(kind)} <span style="font-weight:400">${count}</span></div>`;
    }
    h += `</div>`;
    // Group by kind
    const byKindItems: Record<string, typeof todosData.items> = {};
    for (const item of todosData.items) {
      (byKindItems[item.kind] = byKindItems[item.kind] ?? []).push(item);
    }
    for (const kind of ["FIXME", "HACK", "XXX", "TODO"]) {
      const items = byKindItems[kind];
      if (!items?.length) continue;
      const col = kindColor[kind] ?? "#6b7280";
      h += `<div class="viol-section">
        <h3 style="color:${col}">${esc(kind)} <span style="font-weight:400;color:#6b7280;font-size:12px">${items.length}</span></h3>
        <table class="violations-table" style="width:100%">
          <thead><tr><th style="width:38%">File</th><th style="width:50px">Line</th><th>Text</th></tr></thead>
          <tbody>`;
      for (const item of items.slice(0, 200)) {
        h += `<tr>
          <td class="td-file" title="${esc(item.filePath)}">${esc(shortPath(item.filePath))}</td>
          <td style="font-size:11px;color:#6b7280;text-align:right;padding-right:8px">${item.line}</td>
          <td style="font-size:11px;color:#374151;word-break:break-word">${esc(item.text.slice(0, 200))}</td>
        </tr>`;
      }
      if (items.length > 200) {
        h += `<tr><td colspan="3" style="font-size:11px;color:#9ca3af;padding:6px 8px">…and ${items.length - 200} more</td></tr>`;
      }
      h += `</tbody></table></div>`;
    }
    return h;
  }

  // ── Surprising Links chapter (19.7) ──────────────────────────────────────
  function buildSurprisesHtml(): string {
    const hotspots = (data as any).hotspots as
      | {
          surprises?: Array<{
            entityA: string;
            entityB: string;
            score: number;
            crossLayerWeight: number;
            communityDistance: number;
            inverseFrequency: number;
            reason: string;
          }>;
        }
      | undefined;
    const surprisesData = hotspots?.surprises;
    if (!surprisesData?.length) {
      return `<div class="empty-state"><span style="font-size:32px">🔗</span><p>No surprising connections found.</p></div>`;
    }
    const top20 = surprisesData.slice(0, Math.min(20, surprisesData.length));

    // ── Arc diagram ───────────────────────────────────────────────────────────
    // Nodes ordered by first appearance in the top surprises (highest-scored pairs first)
    const nodeOrder = new Map<string, number>();
    for (const s of top20) {
      if (!nodeOrder.has(s.entityA)) nodeOrder.set(s.entityA, nodeOrder.size);
      if (!nodeOrder.has(s.entityB)) nodeOrder.set(s.entityB, nodeOrder.size);
    }
    const nodeArr = [...nodeOrder.keys()].sort(
      (a, b) => nodeOrder.get(a)! - nodeOrder.get(b)!,
    );

    const W = 900,
      BASE_Y = 150,
      MARGIN_L = 24,
      MARGIN_R = 60,
      H = 240;
    const usableW = W - MARGIN_L - MARGIN_R;
    const nodeX = new Map<string, number>();
    nodeArr.forEach((n, i) => {
      nodeX.set(
        n,
        MARGIN_L +
          (nodeArr.length === 1
            ? usableW / 2
            : (i / (nodeArr.length - 1)) * usableW),
      );
    });

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">`;
    for (const s of top20) {
      const x1 = nodeX.get(s.entityA) ?? 0;
      const x2 = nodeX.get(s.entityB) ?? 0;
      const midX = (x1 + x2) / 2;
      const arcH = Math.max(
        22,
        Math.min(BASE_Y - 8, s.communityDistance * (BASE_Y * 0.9) + 18),
      );
      const color =
        s.score >= 0.7 ? "#ef4444" : s.score >= 0.4 ? "#f59e0b" : "#94a3b8";
      const opacity = (0.25 + s.score * 0.65).toFixed(2);
      const sw = (1.2 + s.score * 3.2).toFixed(1);
      svg += `<path d="M${x1.toFixed(1)},${BASE_Y} Q${midX.toFixed(1)},${(BASE_Y - arcH).toFixed(1)} ${x2.toFixed(1)},${BASE_Y}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-opacity="${opacity}" stroke-linecap="round"><title>${esc(s.entityA)} ↔ ${esc(s.entityB)} · score ${s.score.toFixed(2)} · ${esc(s.reason)}</title></path>`;
    }
    svg += `<line x1="${MARGIN_L}" y1="${BASE_Y}" x2="${W - MARGIN_R}" y2="${BASE_Y}" stroke="#e5e7eb" stroke-width="1"/>`;
    for (const n of nodeArr) {
      const x = nodeX.get(n) ?? 0;
      svg += `<circle cx="${x.toFixed(1)}" cy="${BASE_Y}" r="4.5" fill="#3b82f6" stroke="#1d4ed8" stroke-width="1.5"/>`;
      const lbl = n.length > 18 ? n.slice(0, 16) + "\u2026" : n;
      svg += `<g transform="translate(${x.toFixed(1)},${BASE_Y + 8})"><text transform="rotate(35)" x="0" y="0" dominant-baseline="hanging" text-anchor="start" font-size="8.5" font-family="ui-monospace,monospace" fill="#374151">${esc(lbl)}</text></g>`;
    }
    svg += `</svg>`;

    let h = `<div class="chapter-header"><h2>Surprising Links</h2><div class="chapter-sub">Unexpected entity couplings · arc height = community distance · stroke weight = surprise score · top ${top20.length} of ${surprisesData.length}</div></div>`;
    h += `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px 4px;margin-bottom:16px;overflow-x:hidden">
      ${svg}
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:4px;padding:0 2px 6px">
        <span style="font-size:10px;color:#6b7280;display:inline-flex;align-items:center;gap:5px"><svg width="28" height="10" viewBox="0 0 28 10"><path d="M2,8 Q14,1 26,8" fill="none" stroke="#ef4444" stroke-width="3" stroke-opacity="0.7" stroke-linecap="round"/></svg>score ≥ 0.7 (high)</span>
        <span style="font-size:10px;color:#6b7280;display:inline-flex;align-items:center;gap:5px"><svg width="28" height="10" viewBox="0 0 28 10"><path d="M2,8 Q14,2 26,8" fill="none" stroke="#f59e0b" stroke-width="2" stroke-opacity="0.65" stroke-linecap="round"/></svg>0.4 – 0.7 (medium)</span>
        <span style="font-size:10px;color:#6b7280;display:inline-flex;align-items:center;gap:5px"><svg width="28" height="10" viewBox="0 0 28 10"><path d="M2,8 Q14,3 26,8" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-opacity="0.55" stroke-linecap="round"/></svg>&lt; 0.4 (low)</span>
      </div>
    </div>`;
    h += `<details>
      <summary style="font-size:12px;font-weight:600;color:#374151;cursor:pointer;user-select:none;padding:4px 0 8px">&#9656; Full table (${surprisesData.length} items)</summary>
      <table class="violations-table" style="width:100%;margin-top:4px">
        <thead><tr>
          <th>Entity A</th><th>Entity B</th>
          <th style="width:70px;text-align:right">Score</th>
          <th>Why</th>
        </tr></thead>
        <tbody>`;
    for (const s of surprisesData) {
      const scoreColor =
        s.score >= 0.7 ? "#dc2626" : s.score >= 0.4 ? "#d97706" : "#6b7280";
      h += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:10px;color:#1e40af">${esc(s.entityA)}</td>
          <td style="font-family:ui-monospace,monospace;font-size:10px;color:#1e40af">${esc(s.entityB)}</td>
          <td style="text-align:right;font-weight:700;color:${scoreColor};font-size:12px">${s.score.toFixed(2)}</td>
          <td style="font-size:11px;color:#6b7280">${esc(s.reason)}</td>
        </tr>`;
    }
    h += `</tbody></table></details>
    <div style="margin-top:8px;font-size:11px;color:#9ca3af">Score components: cross-layer coupling · community distance · inverse co-occurrence frequency.</div>`;
    return h;
  }

  // ── Rule Coverage chapter (19.6) ─────────────────────────────────────────
  function buildRuleCoverageHtml(): string {
    const rc = (data as any).ruleCoverage as
      | {
          totalBehavioralRules: number;
          covered: Array<{
            dir: string;
            fileCount: number;
            behavioralRuleCount: number;
            coveredByRules: string[];
          }>;
          uncovered: Array<{
            dir: string;
            fileCount: number;
            behavioralRuleCount: number;
            coveredByRules: string[];
          }>;
          topUncovered: Array<{
            dir: string;
            fileCount: number;
            behavioralRuleCount: number;
            coveredByRules: string[];
          }>;
        }
      | undefined;
    if (!rc) {
      return `<div class="empty-state"><span style="font-size:32px">🎯</span><p>No rule coverage data. Add behavioral rules in rules.yaml to see coverage.</p></div>`;
    }
    const totalPkgs = rc.covered.length + rc.uncovered.length;
    const covPct =
      totalPkgs > 0 ? Math.round((rc.covered.length / totalPkgs) * 100) : 0;
    const badgeColor =
      covPct >= 80 ? "#16a34a" : covPct >= 50 ? "#d97706" : "#dc2626";
    let h = `<div class="chapter-header"><h2>Rule Coverage</h2><div class="chapter-sub">Packages covered by behavioral rules · ${rc.totalBehavioralRules} rules total</div></div>`;
    h += `<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px">
      <div class="stat-card" style="min-width:120px">
        <div class="stat-value" style="color:${badgeColor}">${covPct}%</div>
        <div class="stat-label">Package Coverage</div>
      </div>
      <div class="stat-card" style="min-width:120px">
        <div class="stat-value">${rc.covered.length}</div>
        <div class="stat-label">Covered Packages</div>
      </div>
      <div class="stat-card" style="min-width:120px">
        <div class="stat-value" style="color:${rc.uncovered.length > 0 ? "#dc2626" : "#16a34a"}">${rc.uncovered.length}</div>
        <div class="stat-label">Uncovered Packages</div>
      </div>
    </div>`;
    if (rc.uncovered.length > 0) {
      h += `<div class="viol-section">
        <h3 style="color:#dc2626">⚠ Uncovered Packages (${rc.uncovered.length})</h3>
        <p style="font-size:12px;color:#6b7280;margin:0 0 10px">These directories have no behavioral rules. Consider adding sequence diagrams or flow rules in rules.yaml.</p>
        <table class="violations-table" style="width:100%">
          <thead><tr><th>Package / Directory</th><th style="width:80px;text-align:right">Files</th></tr></thead>
          <tbody>`;
      for (const pkg of rc.topUncovered.slice(0, 30)) {
        h += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:11px;color:#374151">${esc(pkg.dir)}</td>
          <td style="text-align:right;font-size:11px;color:#6b7280">${pkg.fileCount}</td>
        </tr>`;
      }
      if (rc.uncovered.length > 30) {
        h += `<tr><td colspan="2" style="font-size:11px;color:#9ca3af;padding:6px 8px">…and ${rc.uncovered.length - 30} more</td></tr>`;
      }
      h += `</tbody></table></div>`;
    }
    if (rc.covered.length > 0) {
      h += `<div class="viol-section">
        <h3 style="color:#16a34a">✓ Covered Packages (${rc.covered.length})</h3>
        <table class="violations-table" style="width:100%">
          <thead><tr><th>Package / Directory</th><th style="width:80px;text-align:right">Files</th><th>Rules</th></tr></thead>
          <tbody>`;
      for (const pkg of rc.covered.slice(0, 30)) {
        h += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:11px;color:#374151">${esc(pkg.dir)}</td>
          <td style="text-align:right;font-size:11px;color:#6b7280">${pkg.fileCount}</td>
          <td style="font-size:10px;color:#6b7280">${pkg.coveredByRules.map((r) => esc(r)).join(", ")}</td>
        </tr>`;
      }
      if (rc.covered.length > 30) {
        h += `<tr><td colspan="3" style="font-size:11px;color:#9ca3af;padding:6px 8px">…and ${rc.covered.length - 30} more</td></tr>`;
      }
      h += `</tbody></table></div>`;
    }
    return h;
  }

  // ── Design Rationale chapter (19.8a) ─────────────────────────────────────
  function buildDesignRationaleHtml(): string {
    const doc = (data as any).documentation as
      | {
          rationale?: Array<{
            filePath: string;
            line: number;
            kind: string;
            text: string;
            symbol?: string;
          }>;
        }
      | undefined;
    const entries = doc?.rationale ?? [];
    if (entries.length === 0) {
      return `<div class="chapter-header"><h2>Design Rationale</h2><div class="chapter-sub">WHY · NOTE · IMPORTANT · DESIGN comments</div></div>
        <div class="empty-state"><span style="font-size:32px">💡</span><p>No rationale comments indexed.<br>Add <code>// WHY:</code>, <code>// NOTE:</code>, <code>// DESIGN:</code> or <code>// IMPORTANT:</code> comments to your code.</p></div>`;
    }
    const kindMeta: Record<
      string,
      { icon: string; color: string; bg: string }
    > = {
      WHY: { icon: "❓", color: "#1d4ed8", bg: "#eff6ff" },
      DESIGN: { icon: "🎯", color: "#7c3aed", bg: "#f5f3ff" },
      IMPORTANT: { icon: "⚠️", color: "#d97706", bg: "#fffbeb" },
      NOTE: { icon: "📎", color: "#374151", bg: "#f9fafb" },
    };
    const byKind = new Map<string, typeof entries>();
    entries.forEach((r) => {
      const arr = byKind.get(r.kind) ?? [];
      arr.push(r);
      byKind.set(r.kind, arr);
    });
    let h = `<div class="chapter-header"><h2>Design Rationale</h2><div class="chapter-sub">Ambient architectural decisions embedded in code · ${entries.length} entries</div></div>
      <div class="chapter-scroll-body" style="padding:16px 20px">`;
    // Summary pills
    h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">`;
    for (const [kind, items] of [...byKind.entries()].sort(
      ([, a], [, b]) => b.length - a.length,
    )) {
      const m = kindMeta[kind] ?? {
        icon: "💬",
        color: "#6b7280",
        bg: "#f9fafb",
      };
      h += `<div style="background:${m.bg};border:1px solid ${m.color};border-radius:20px;padding:4px 14px;font-size:12px;font-weight:700;color:${m.color}">${m.icon} ${esc(kind)} <span style="font-weight:400">${items.length}</span></div>`;
    }
    h += `</div>`;
    for (const kind of ["WHY", "DESIGN", "IMPORTANT", "NOTE"]) {
      const items = byKind.get(kind);
      if (!items?.length) continue;
      const m = kindMeta[kind] ?? {
        icon: "💬",
        color: "#6b7280",
        bg: "#f9fafb",
      };
      h += `<div class="viol-section">
        <h3 style="color:${m.color}">${m.icon} ${esc(kind)} <span style="font-weight:400;color:#6b7280;font-size:12px">${items.length}</span></h3>
        <div style="display:flex;flex-direction:column;gap:8px">`;
      for (const r of items) {
        h += `<div style="background:${m.bg};border:1px solid ${m.color}22;border-left:3px solid ${m.color};border-radius:6px;padding:10px 12px">
          <div style="font-size:12px;color:#1f2937;line-height:1.6">${esc(r.text)}</div>
          <div style="font-size:10px;color:#9ca3af;margin-top:6px">
            <span style="font-family:ui-monospace,monospace">${esc(shortPath(r.filePath, 50))}</span>
            ${r.line ? ` · line ${r.line}` : ""}
            ${r.symbol ? ` · <code style="background:#f1f5f9;padding:0 3px;border-radius:2px">${esc(r.symbol)}</code>` : ""}
          </div>
        </div>`;
      }
      h += `</div></div>`;
    }
    h += `</div>`;
    return h;
  }

  // ── Test Coverage chapter (19.8c) ─────────────────────────────────────────
  function buildTestCoverageHtml(): string {
    const tc = (data as any).testCoverage as
      | {
          totalExported: number;
          covered: number;
          coveragePercent: number;
          untested: Array<{
            name: string;
            filePath: string;
            kind: string;
            line: number;
          }>;
          mappings: Array<{
            testFile: string;
            sourceFile: string;
            strategy: string;
            importedNames: string[];
          }>;
          byDirectory: Array<{
            directory: string;
            totalExported: number;
            covered: number;
            coveragePercent: number;
          }>;
        }
      | undefined;
    if (!tc)
      return `<div class="empty-state"><span style="font-size:32px">🧪</span><p>No test coverage data available.</p></div>`;
    const pctColor =
      tc.coveragePercent >= 80
        ? "#16a34a"
        : tc.coveragePercent >= 50
          ? "#d97706"
          : "#dc2626";
    let h = `<div class="chapter-header"><h2>Test Coverage</h2><div class="chapter-sub">Test→source mapping via naming convention + imports · ${tc.totalExported} exported symbols</div></div>
      <div class="chapter-scroll-body" style="padding:16px 20px">`;
    // Top stats
    h += `<div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px">
      <div class="stat-card" style="min-width:120px">
        <div class="stat-value" style="color:${pctColor}">${Math.round(tc.coveragePercent)}%</div>
        <div class="stat-label">Symbol Coverage</div>
      </div>
      <div class="stat-card" style="min-width:120px">
        <div class="stat-value">${tc.covered}</div>
        <div class="stat-label">Covered Symbols</div>
      </div>
      <div class="stat-card" style="min-width:120px">
        <div class="stat-value" style="color:${tc.untested.length > 0 ? "#dc2626" : "#16a34a"}">${tc.untested.length}</div>
        <div class="stat-label">Untested Exports</div>
      </div>
      <div class="stat-card" style="min-width:120px">
        <div class="stat-value">${tc.mappings.length}</div>
        <div class="stat-label">Test Mappings</div>
      </div>
    </div>`;
    // Per-directory table
    if (tc.byDirectory.length > 0) {
      h += `<div class="viol-section">
        <h3>Coverage by Directory</h3>
        <table class="violations-table" style="width:100%">
          <thead><tr><th>Directory</th><th style="width:80px;text-align:right">Exported</th><th style="width:80px;text-align:right">Covered</th><th style="width:80px;text-align:right">%</th></tr></thead>
          <tbody>`;
      const sorted = [...tc.byDirectory].sort(
        (a, b) => a.coveragePercent - b.coveragePercent,
      );
      for (const dir of sorted) {
        const col =
          dir.coveragePercent >= 80
            ? "#16a34a"
            : dir.coveragePercent >= 50
              ? "#d97706"
              : "#dc2626";
        h += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:11px">${esc(dir.directory || "(root)")}</td>
          <td style="text-align:right;font-size:11px;color:#6b7280">${dir.totalExported}</td>
          <td style="text-align:right;font-size:11px;color:#6b7280">${dir.covered}</td>
          <td style="text-align:right;font-weight:700;font-size:11px;color:${col}">${Math.round(dir.coveragePercent)}%</td>
        </tr>`;
      }
      h += `</tbody></table></div>`;
    }
    // Untested exports
    if (tc.untested.length > 0) {
      h += `<div class="viol-section">
        <h3 style="color:#dc2626">⚠ Untested Exported Symbols (${tc.untested.length})</h3>
        <table class="violations-table" style="width:100%">
          <thead><tr><th>Symbol</th><th>Kind</th><th style="width:38%">File</th><th style="width:50px">Line</th></tr></thead>
          <tbody>`;
      for (const u of tc.untested.slice(0, 150)) {
        h += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:11px;font-weight:600">${esc(u.name)}</td>
          <td style="font-size:11px;color:#6b7280">${esc(u.kind)}</td>
          <td class="td-file" title="${esc(u.filePath)}">${esc(shortPath(u.filePath))}</td>
          <td style="font-size:11px;color:#6b7280;text-align:right;padding-right:8px">${u.line}</td>
        </tr>`;
      }
      if (tc.untested.length > 150) {
        h += `<tr><td colspan="4" style="font-size:11px;color:#9ca3af;padding:6px 8px">…and ${tc.untested.length - 150} more</td></tr>`;
      }
      h += `</tbody></table></div>`;
    }
    h += `</div>`;
    return h;
  }

  // ── Call Graph chapter builder (19.1) ────────────────────────────────────
  function buildCallGraphHtml(): string {
    const cg = (data as any).callGraph as
      | {
          total: number;
          topCallees: Array<{ calleeName: string; count: number }>;
          traces: Array<{ entryFile: string }>;
          callsTableActive: boolean;
        }
      | undefined;
    if (!cg?.callsTableActive || !cg.traces.length) {
      return `<div class="chapter-header"><h2>Call Graph</h2><div class="chapter-sub">Symbol-level call relationships (Phase 4)</div></div>
        <div class="chapter-scroll-body" style="padding:16px 20px">
          <div class="empty-state"><span style="font-size:32px">📞</span>
            <p>No call graph data. Run <code>iw index build</code> on a TypeScript/JavaScript codebase.</p>
          </div>
        </div>`;
    }
    const entryOptions = cg.traces
      .map(
        (t) =>
          `<option value="${esc(t.entryFile)}">${esc(shortPath(t.entryFile, 55))}</option>`,
      )
      .join("");
    let h = `<div class="chapter-header"><h2>Call Graph</h2>
      <div class="chapter-sub">Butterfly trace visualizer · ${cg.total.toLocaleString()} call edges · ${cg.traces.length} entry files pre-computed</div>
    </div>
    <div class="chapter-scroll-body" style="padding:16px 20px">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:11px;color:#6b7280;font-weight:600">Entry</label>
          <select id="cg-entry" style="font-size:11px;padding:3px 6px;border:1px solid #e5e7eb;border-radius:4px;background:#fff;max-width:260px">${entryOptions}</select>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:11px;color:#6b7280;font-weight:600">Mode</label>
          <select id="cg-mode" style="font-size:11px;padding:3px 6px;border:1px solid #e5e7eb;border-radius:4px;background:#fff">
            <option value="both">Both (Butterfly)</option>
            <option value="forward">Forward only (callees)</option>
            <option value="backward">Backward only (callers)</option>
          </select>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:11px;color:#6b7280;font-weight:600">Depth</label>
          <input type="range" id="cg-depth" min="1" max="4" value="3" style="width:80px">
          <span id="cg-depth-val" style="font-size:11px;font-weight:700;color:#374151;min-width:12px">3</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:11px;color:#6b7280;font-weight:600">Level</label>
          <select id="cg-level" style="font-size:11px;padding:3px 6px;border:1px solid #e5e7eb;border-radius:4px;background:#fff">
            <option value="file">Files</option>
            <option value="fn">Functions</option>
          </select>
        </div>
        <div style="display:flex;align-items:center;gap:5px;margin-left:4px">
          <label style="font-size:11px;color:#6b7280;font-weight:600">Viz</label>
          <button data-cg-viz="butterfly" style="font-size:10px;padding:2px 8px;border:1px solid #93c5fd;border-radius:4px;background:#1d4ed8;color:#fff;cursor:pointer;font-family:inherit">&#127987;&#65039; Butterfly</button>
          <button data-cg-viz="flame" style="font-size:10px;padding:2px 8px;border:1px solid #e5e7eb;border-radius:4px;background:#f3f4f6;color:#374151;cursor:pointer;font-family:inherit">&#128293; Flame</button>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;padding:0 4px;margin-bottom:4px">
        <span style="font-size:10px;color:#ec4899;font-weight:600">◀ Callers (who calls in)</span>
        <span style="font-size:10px;color:#0ea5e9;font-weight:600">Callees (what it calls) ▶</span>
      </div>
      <div id="cg-wrap" style="border:1px solid #e5e7eb;border-radius:8px;background:#fafafa;overflow:hidden;position:relative">
        <svg id="cg-svg" style="width:100%;display:block" height="500"></svg>
        <div id="cg-tooltip" style="display:none;position:absolute;background:rgba(15,23,42,0.92);color:#f1f5f9;font-size:11px;padding:6px 9px;border-radius:6px;pointer-events:none;max-width:300px;line-height:1.5;z-index:10;word-break:break-all"></div>
        <div id="cg-truncated" style="display:none;position:absolute;bottom:6px;right:8px;font-size:10px;color:#9ca3af;background:rgba(255,255,255,0.9);padding:2px 6px;border-radius:4px">⚠ result truncated — increase index depth for full graph</div>
      </div>`;
    if (cg.topCallees.length > 0) {
      h += `<div class="viol-section" style="margin-top:16px">
        <h3>Top Called Functions</h3>
        <table class="violations-table" style="width:100%">
          <thead><tr><th>Function</th><th style="width:90px;text-align:right">Call Count</th></tr></thead>
          <tbody>`;
      for (const tc of cg.topCallees.slice(0, 20)) {
        h += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:11px;font-weight:600">${esc(tc.calleeName)}</td>
          <td style="text-align:right;font-size:11px;color:#6b7280">${tc.count}</td>
        </tr>`;
      }
      h += `</tbody></table></div>`;
    }
    h += `</div>`;
    return h;
  }

  // ── Code Health chapter ───────────────────────────────────────────────────
  function buildCodeHealthHtml(): string {
    const ch = (data as any).codeHealth as {
      cloneGroups: Array<{
        symbols: Array<{
          name: string;
          filePath: string;
          line: number;
          kind: string;
        }>;
        bodyLines: number;
      }>;
      structuralCloneGroups: Array<{
        symbols: Array<{
          name: string;
          filePath: string;
          line: number;
          kind: string;
        }>;
        bodyLines: number;
      }>;
      circularCycles: Array<{ files: string[]; length: number }>;
      unusedExports: Array<{
        name: string;
        filePath: string;
        kind: string;
        line: number;
      }>;
      boundaryViolations: Array<{
        sourceFile: string;
        targetFile: string;
        sourcePackage: string;
        targetPackage: string;
        reason: string;
      }>;
      byPackagePair: Array<{
        sourcePackage: string;
        targetPackage: string;
        count: number;
      }>;
    };

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">🩺 Code Health</h1>
      <p class="chapter-subtitle">Clones · circular imports · unused exports · boundary violations</p>
    </div>
    <div class="chapter-body">`;

    // ── Section helper ──
    function section(title: string, icon: string, count: number, body: string) {
      const sColor = count === 0 ? "#166534" : "#92400e";
      const sBg = count === 0 ? "#dcfce7" : "#fff7ed";
      h += `<div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span>${icon}</span>
          <span style="font-size:14px;font-weight:700;color:#1f2937">${esc(title)}</span>
          <span style="margin-left:auto;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${sBg};color:${sColor}">${count}</span>
        </div>
        ${count === 0 ? `<div style="padding:10px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">✅ None found.</div>` : body}
      </div>`;
    }

    // ── Exact clones ──────────────────────────────────────────────────────
    let clonesBody = `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
      <th>Symbol</th><th>File</th><th>Kind</th><th>Lines</th>
    </tr></thead><tbody>`;
    let cloneRowCount = 0;
    ch.cloneGroups.slice(0, 30).forEach((g) => {
      g.symbols.forEach((s) => {
        clonesBody += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:10px">${esc(s.name)}</td>
          <td class="td-file" title="${esc(s.filePath)}">${esc(shortPath(s.filePath))}</td>
          <td><span class="badge low">${esc(s.kind)}</span></td>
          <td style="text-align:right;font-size:10px">${g.bodyLines}</td>
        </tr>`;
        cloneRowCount++;
      });
      clonesBody += `<tr><td colspan="4" style="background:#f8fafc;font-size:10px;color:#9ca3af;padding:3px 10px">↑ clone group (${g.symbols.length} copies, ${g.bodyLines} lines)</td></tr>`;
    });
    clonesBody += `</tbody></table></div>`;
    if (ch.cloneGroups.length > 30)
      clonesBody += `<p style="font-size:11px;color:#9ca3af;margin:4px 0 0">Showing 30 of ${ch.cloneGroups.length} clone groups.</p>`;
    section("Exact Clones", "🔁", ch.cloneGroups.length, clonesBody);

    // ── Structural clones ─────────────────────────────────────────────────
    let structBody = `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
      <th>Symbol</th><th>File</th><th>Kind</th><th>Lines</th>
    </tr></thead><tbody>`;
    ch.structuralCloneGroups.slice(0, 20).forEach((g) => {
      g.symbols.forEach((s) => {
        structBody += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:10px">${esc(s.name)}</td>
          <td class="td-file" title="${esc(s.filePath)}">${esc(shortPath(s.filePath))}</td>
          <td><span class="badge low">${esc(s.kind)}</span></td>
          <td style="text-align:right;font-size:10px">${g.bodyLines}</td>
        </tr>`;
      });
      structBody += `<tr><td colspan="4" style="background:#f8fafc;font-size:10px;color:#9ca3af;padding:3px 10px">↑ structural clone group (${g.symbols.length} copies)</td></tr>`;
    });
    structBody += `</tbody></table></div>`;
    section(
      "Structural Clones (Type 2)",
      "🔂",
      ch.structuralCloneGroups.length,
      structBody,
    );

    // ── Circular imports ──────────────────────────────────────────────────
    let circBody = `<div style="display:flex;flex-direction:column;gap:8px">`;
    ch.circularCycles.slice(0, 20).forEach((cycle, i) => {
      circBody += `<div style="background:#fff;border:1px solid #fecaca;border-radius:8px;padding:10px 12px">
        <div style="font-size:10px;font-weight:700;color:#991b1b;margin-bottom:6px">Cycle #${i + 1} · ${cycle.length} files</div>
        <div style="font-family:ui-monospace,monospace;font-size:10px;color:#374151;line-height:1.7">
          ${cycle.files.map((f, fi) => `<span style="color:#6b7280">${fi > 0 ? " → " : ""}</span><span title="${esc(f)}">${esc(shortPath(f, 36))}</span>`).join("")}
        </div>
      </div>`;
    });
    circBody += `</div>`;
    if (ch.circularCycles.length > 20)
      circBody += `<p style="font-size:11px;color:#9ca3af;margin:6px 0 0">Showing 20 of ${ch.circularCycles.length} cycles.</p>`;
    section("Circular Imports", "🔄", ch.circularCycles.length, circBody);

    // ── Unused exports ────────────────────────────────────────────────────
    let unusedBody = `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
      <th>Symbol</th><th>File</th><th>Kind</th><th>Line</th>
    </tr></thead><tbody>`;
    ch.unusedExports.slice(0, 40).forEach((s) => {
      unusedBody += `<tr>
        <td style="font-family:ui-monospace,monospace;font-size:10px">${esc(s.name)}</td>
        <td class="td-file" title="${esc(s.filePath)}">${esc(shortPath(s.filePath))}</td>
        <td><span class="badge low">${esc(s.kind)}</span></td>
        <td style="font-size:10px">${s.line ?? "—"}</td>
      </tr>`;
    });
    unusedBody += `</tbody></table></div>`;
    if (ch.unusedExports.length > 40)
      unusedBody += `<p style="font-size:11px;color:#9ca3af;margin:4px 0 0">Showing 40 of ${ch.unusedExports.length} unused exports.</p>`;
    section("Unused Exports", "🗑", ch.unusedExports.length, unusedBody);

    // ── Boundary violations ───────────────────────────────────────────────
    let bvBody = "";
    if (ch.byPackagePair.length > 0) {
      bvBody += `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">`;
      ch.byPackagePair.forEach((pp) => {
        bvBody += `<div style="background:#fff;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:11px">
          <span style="font-weight:700;color:#991b1b">${esc(pp.sourcePackage)}</span>
          <span style="color:#9ca3af"> → </span>
          <span style="font-weight:700;color:#1e40af">${esc(pp.targetPackage)}</span>
          <span style="margin-left:8px;font-size:10px;color:#6b7280">${pp.count} violation${pp.count !== 1 ? "s" : ""}</span>
        </div>`;
      });
      bvBody += `</div>`;
    }
    bvBody += `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
      <th>Source</th><th>Target</th><th>Reason</th>
    </tr></thead><tbody>`;
    ch.boundaryViolations.slice(0, 30).forEach((v) => {
      bvBody += `<tr>
        <td class="td-file" title="${esc(v.sourceFile)}">${esc(shortPath(v.sourceFile))}</td>
        <td class="td-file" title="${esc(v.targetFile)}">${esc(shortPath(v.targetFile))}</td>
        <td class="td-detail">${esc(v.reason.slice(0, 100))}</td>
      </tr>`;
    });
    bvBody += `</tbody></table></div>`;
    section("Boundary Violations", "🚫", ch.boundaryViolations.length, bvBody);

    h += `</div>`;
    return h;
  }

  // ── Hotspots chapter ──────────────────────────────────────────────────────
  // ── Priority Files chapter ────────────────────────────────────────────────
  function buildPriorityFilesHtml(): string {
    const hs = (data as any).hotspots as {
      priorities: Array<{
        filePath: string;
        churn: number;
        coveragePercent: number;
        priorityScore: number;
        totalExportedSymbols: number;
      }>;
    };

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">🔥 Priority Files</h1>
      <p class="chapter-subtitle">High-churn files with low documentation coverage (churn × (1 − coverage))</p>
    </div>
    <div class="chapter-body">`;

    h += `<div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:8px;display:flex;align-items:center;gap:8px">🔥 High-Priority Files <span style="font-size:11px;font-weight:400;color:#6b7280">(churn × (1 − coverage))</span></div>`;
    if (hs.priorities.length === 0) {
      h += `<div style="padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">✅ No high-priority files detected.</div>`;
    } else {
      h += `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
        <th>File</th><th>Churn</th><th>Exports</th><th>Doc Coverage</th><th>Priority</th>
      </tr></thead><tbody>`;
      hs.priorities.slice(0, 30).forEach((p) => {
        const barW = Math.min(100, Math.round(p.priorityScore * 100));
        const barColor =
          barW > 60 ? "#ef4444" : barW > 30 ? "#f59e0b" : "#22c55e";
        const covColor =
          p.coveragePercent >= 70
            ? "#22c55e"
            : p.coveragePercent >= 40
              ? "#f59e0b"
              : "#ef4444";
        h += `<tr>
          <td class="td-file" title="${esc(p.filePath)}">${esc(shortPath(p.filePath))}</td>
          <td style="text-align:right;font-size:11px">${p.churn}</td>
          <td style="text-align:right;font-size:11px">${p.totalExportedSymbols}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              <div class="cov-bar-wrap"><div class="cov-bar" style="width:${p.coveragePercent}%;background:${covColor}"></div></div>
              <span style="font-size:11px;color:${covColor};font-weight:600">${p.coveragePercent}%</span>
            </div>
          </td>
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              <div style="width:60px;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">
                <div style="width:${barW}%;height:100%;background:${barColor}"></div>
              </div>
              <span style="font-size:10px;color:${barColor};font-weight:700">${p.priorityScore.toFixed(2)}</span>
            </div>
          </td>
        </tr>`;
      });
      h += `</tbody></table></div>`;
      if (hs.priorities.length > 30)
        h += `<p style="font-size:11px;color:#9ca3af;margin:4px 0 0">Showing 30 of ${hs.priorities.length} files.</p>`;
    }
    h += `</div></div>`;
    return h;
  }

  // ── Code Structure chapter ────────────────────────────────────────────────
  function buildCodeStructureHtml(): string {
    const hs = (data as any).hotspots as {
      depthFiles: Array<{
        filePath: string;
        maxDepth: number;
        directDependencies: number;
        directDependents: number;
        risk: string;
        reason: string;
      }>;
      hubs: Array<{
        name: string;
        kind: string;
        filePath: string;
        totalDegree: number;
        annotationDegree: number;
        importDegree: number;
      }>;
      communities: Array<{
        id: number;
        label: string;
        size: number;
        members: Array<{ name: string; kind: string }>;
      }>;
    };

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">📐 Code Structure</h1>
      <p class="chapter-subtitle">Deep dependency chains · hub entities · community clusters</p>
    </div>
    <div class="chapter-body">`;

    // ── Dependency depth ──────────────────────────────────────────────────
    h += `<div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:8px">📦 Deep Dependency Chains</div>`;
    const highRisk = hs.depthFiles.filter(
      (f) => f.risk === "high" || f.risk === "critical",
    );
    if (highRisk.length === 0) {
      h += `<div style="padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">✅ No high-risk dependency chains.</div>`;
    } else {
      h += `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
        <th>File</th><th>Max Depth</th><th>Fan-out</th><th>Fan-in</th><th>Risk</th><th>Reason</th>
      </tr></thead><tbody>`;
      highRisk.slice(0, 25).forEach((f) => {
        const riskBadge =
          f.risk === "critical"
            ? `<span class="badge high">CRITICAL</span>`
            : `<span class="badge medium">HIGH</span>`;
        h += `<tr>
          <td class="td-file" title="${esc(f.filePath)}">${esc(shortPath(f.filePath))}</td>
          <td style="text-align:right;font-size:11px">${f.maxDepth}</td>
          <td style="text-align:right;font-size:11px">${f.directDependencies}</td>
          <td style="text-align:right;font-size:11px">${f.directDependents}</td>
          <td>${riskBadge}</td>
          <td class="td-detail">${esc((f.reason ?? "").slice(0, 80))}</td>
        </tr>`;
      });
      h += `</tbody></table></div>`;
    }
    h += `</div>`;

    // ── Hub entities ──────────────────────────────────────────────────────
    h += `<div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:8px">◎ Hub Entities <span style="font-size:11px;font-weight:400;color:#6b7280">(high degree centrality)</span></div>`;
    if (hs.hubs.length === 0) {
      h += `<div style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#6b7280">No hub entities detected yet.</div>`;
    } else {
      h += `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
        <th>Entity</th><th>File</th><th>Kind</th><th>Annotations</th><th>Imports</th><th>Total</th>
      </tr></thead><tbody>`;
      hs.hubs.slice(0, 20).forEach((hub) => {
        h += `<tr>
          <td style="font-family:ui-monospace,monospace;font-size:10px;font-weight:600">${esc(hub.name)}</td>
          <td class="td-file" title="${esc(hub.filePath)}">${esc(shortPath(hub.filePath))}</td>
          <td><span class="badge info">${esc(hub.kind)}</span></td>
          <td style="text-align:right;font-size:11px">${hub.annotationDegree}</td>
          <td style="text-align:right;font-size:11px">${hub.importDegree}</td>
          <td style="text-align:right;font-size:12px;font-weight:700;color:#1d4ed8">${hub.totalDegree}</td>
        </tr>`;
      });
      h += `</tbody></table></div>`;
    }
    h += `</div>`;

    // ── Communities ───────────────────────────────────────────────────────
    h += `<div>
      <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:8px">🎨 Code Communities <span style="font-size:11px;font-weight:400;color:#6b7280">(label propagation clusters)</span></div>`;
    if (hs.communities.length === 0) {
      h += `<div style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#6b7280">No community clusters detected.</div>`;
    } else {
      h += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">`;
      hs.communities.slice(0, 20).forEach((c, i) => {
        const bg = COMM_PALETTE[i % COMM_PALETTE.length];
        h += `<div style="background:${bg};border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px">
          <div style="font-size:12px;font-weight:700;color:#1f2937;margin-bottom:6px">${esc(c.label)} <span style="font-size:10px;font-weight:400;color:#6b7280">(${c.size})</span></div>
          ${c.members
            .slice(0, 6)
            .map(
              (m) =>
                `<div style="font-size:10px;color:#374151;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.name)}</div>`,
            )
            .join("")}
          ${c.members.length > 6 ? `<div style="font-size:10px;color:#9ca3af">… ${c.members.length - 6} more</div>` : ""}
        </div>`;
      });
      h += `</div>`;
      if (hs.communities.length > 20)
        h += `<p style="font-size:11px;color:#9ca3af;margin:8px 0 0">Showing 20 of ${hs.communities.length} communities.</p>`;
    }
    h += `</div></div>`;
    return h;
  }

  // ── Documentation Insights chapter ───────────────────────────────────────
  function buildDocInsightsHtml(): string {
    const doc = (data as any).documentation as {
      orphanedSections: Array<{
        docPath: string;
        heading: string;
        line: number;
        ungroundedMentions: number;
      }>;
      docCoverageAggregate?: { coveredSymbols: number; totalSymbols: number };
      docCompleteness: Array<{
        docPath: string;
        completenessPercent: number;
        totalRelevantExports: number;
        coveredExports: number;
        missing: Array<{ name: string; kind: string }>;
      }>;
      rationale: Array<{
        filePath: string;
        line: number;
        kind: string;
        text: string;
        symbol?: string;
      }>;
      terminology: Array<{
        symbolName: string;
        kind: string;
        filePath: string;
        severity: string;
        variants: Array<{ text: string; count: number }>;
      }>;
    };

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">📝 Documentation Quality</h1>
      <p class="chapter-subtitle">Orphaned sections · completeness · rationale · terminology inconsistencies</p>
    </div>
    <div class="chapter-body">`;

    // ── Doc completeness ──────────────────────────────────────────────────
    h += `<div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:8px">📄 Document Completeness</div>`;
    // Aggregate coverage banner
    const agg = doc.docCoverageAggregate as
      | { coveredSymbols: number; totalSymbols: number }
      | undefined;
    if (agg && agg.totalSymbols > 0) {
      const aggPct = Math.round((agg.coveredSymbols / agg.totalSymbols) * 100);
      const aggColor =
        aggPct >= 50 ? "#22c55e" : aggPct >= 25 ? "#f59e0b" : "#ef4444";
      h += `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px">
        <div style="flex:1">
          <div style="font-size:12px;font-weight:600;color:#374151">Overall codebase coverage</div>
          <div style="font-size:11px;color:#6b7280;margin-top:1px">${agg.coveredSymbols.toLocaleString()} of ${agg.totalSymbols.toLocaleString()} exported symbols mentioned in at least one doc</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:120px;height:8px;border-radius:999px;background:#e2e8f0;overflow:hidden">
            <div style="height:100%;width:${aggPct}%;background:${aggColor};border-radius:999px"></div>
          </div>
          <span style="font-size:16px;font-weight:700;color:${aggColor}">${aggPct}%</span>
        </div>
      </div>`;
    }
    if (doc.docCompleteness.length === 0) {
      h += `<div style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#6b7280">No completeness data — run <code>iw index build --depth full</code>.</div>`;
    } else {
      const sorted = [...doc.docCompleteness].sort(
        (a, b) => a.completenessPercent - b.completenessPercent,
      );
      h += `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
        <th>Document</th><th>Coverage</th><th>Covered</th><th>Total</th><th>Missing (sample)</th>
      </tr></thead><tbody>`;
      sorted.slice(0, 25).forEach((d) => {
        const barColor =
          d.completenessPercent >= 70
            ? "#22c55e"
            : d.completenessPercent >= 40
              ? "#f59e0b"
              : "#ef4444";
        const missingSample = d.missing
          .slice(0, 3)
          .map(
            (m) =>
              `<code style="font-size:9px;background:#f3f4f6;border:1px solid #e5e7eb;padding:1px 4px;border-radius:3px">${esc(m.name)}</code>`,
          )
          .join(" ");
        h += `<tr>
          <td class="td-file" title="${esc(d.docPath)}">${esc(shortPath(d.docPath, 40))}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              <div class="cov-bar-wrap"><div class="cov-bar" style="width:${d.completenessPercent}%;background:${barColor}"></div></div>
              <span style="font-size:11px;font-weight:600;color:${barColor}">${d.completenessPercent}%</span>
            </div>
          </td>
          <td style="text-align:right;font-size:11px">${d.coveredExports}</td>
          <td style="text-align:right;font-size:11px">${d.totalRelevantExports}</td>
          <td>${missingSample}${d.missing.length > 3 ? ` <span style="font-size:10px;color:#9ca3af">+${d.missing.length - 3} more</span>` : ""}</td>
        </tr>`;
      });
      h += `</tbody></table></div>`;
    }
    h += `</div>`;

    // ── Orphaned sections ─────────────────────────────────────────────────
    h += `<div style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:14px;font-weight:700;color:#1f2937">🔍 Orphaned Sections</span>
        <span style="font-size:11px;font-weight:400;color:#6b7280">(headings with no grounded code mentions)</span>
        <span style="margin-left:auto;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${doc.orphanedSections.length === 0 ? "#dcfce7" : "#fff7ed"};color:${doc.orphanedSections.length === 0 ? "#166534" : "#92400e"}">${doc.orphanedSections.length}</span>
      </div>`;
    if (doc.orphanedSections.length === 0) {
      h += `<div style="padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">✅ No orphaned sections.</div>`;
    } else {
      h += `<div class="violations-table-wrap"><table class="violations-table"><thead><tr>
        <th>Document</th><th>Heading</th><th>Line</th><th>Ungrounded</th>
      </tr></thead><tbody>`;
      doc.orphanedSections.slice(0, 30).forEach((s) => {
        h += `<tr>
          <td class="td-file" title="${esc(s.docPath)}">${esc(shortPath(s.docPath, 36))}</td>
          <td style="font-size:11px">${esc(s.heading.slice(0, 60))}</td>
          <td style="font-size:10px">${s.line}</td>
          <td style="text-align:right;font-size:11px;color:#9a3412">${s.ungroundedMentions}</td>
        </tr>`;
      });
      h += `</tbody></table></div>`;
    }
    h += `</div>`;

    // ── Terminology ───────────────────────────────────────────────────────
    h += `<div style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:14px;font-weight:700;color:#1f2937">🔤 Terminology Inconsistencies</span>
        <span style="margin-left:auto;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:${doc.terminology.length === 0 ? "#dcfce7" : "#fef3c7"};color:${doc.terminology.length === 0 ? "#166534" : "#92400e"}">${doc.terminology.length}</span>
      </div>`;
    if (doc.terminology.length === 0) {
      h += `<div style="padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">✅ No terminology inconsistencies.</div>`;
    } else {
      h += `<div style="display:flex;flex-direction:column;gap:8px">`;
      doc.terminology.slice(0, 20).forEach((ti) => {
        const sevBadge =
          ti.severity === "critical"
            ? `<span class="badge high">CRITICAL</span>`
            : ti.severity === "warning"
              ? `<span class="badge medium">WARNING</span>`
              : `<span class="badge info">INFO</span>`;
        const variantChips = ti.variants
          .map(
            (v) =>
              `<span style="display:inline-block;font-size:10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;padding:1px 6px;margin:1px 3px 0 0;color:#374151">"${esc(v.text)}" ×${v.count}</span>`,
          )
          .join("");
        h += `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            ${sevBadge}
            <code style="font-size:11px;font-weight:700;color:#1e40af">${esc(ti.symbolName)}</code>
            <span class="badge low">${esc(ti.kind)}</span>
            <span style="font-size:10px;color:#9ca3af;margin-left:auto">${esc(shortPath(ti.filePath, 36))}</span>
          </div>
          <div style="font-size:11px;color:#6b7280">Variants: ${variantChips}</div>
        </div>`;
      });
      h += `</div>`;
      if (doc.terminology.length > 20)
        h += `<p style="font-size:11px;color:#9ca3af;margin:6px 0 0">Showing 20 of ${doc.terminology.length} inconsistencies.</p>`;
    }
    h += `</div>`;

    // ── Rationale ─────────────────────────────────────────────────────────
    h += `<div>
      <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:8px">💡 Rationale Inventory <span style="font-size:11px;font-weight:400;color:#6b7280">(WHY / NOTE / IMPORTANT / DESIGN)</span></div>`;
    if (doc.rationale.length === 0) {
      h += `<div style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#6b7280">No rationale comments indexed. Add WHY:, NOTE:, DESIGN: or IMPORTANT: comments to your code.</div>`;
    } else {
      const byKind = new Map<string, typeof doc.rationale>();
      doc.rationale.forEach((r) => {
        const arr = byKind.get(r.kind) ?? [];
        arr.push(r);
        byKind.set(r.kind, arr);
      });
      h += `<div style="display:flex;flex-direction:column;gap:12px">`;
      [...byKind.entries()].forEach(([kind, entries]) => {
        const kindIcon =
          kind === "WHY"
            ? "❓"
            : kind === "DESIGN"
              ? "🎯"
              : kind === "IMPORTANT"
                ? "⚠️"
                : "📎";
        h += `<div>
          <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px">${kindIcon} ${esc(kind)} <span style="font-weight:400;color:#9ca3af">(${entries.length})</span></div>
          ${entries
            .slice(0, 5)
            .map(
              (
                r,
              ) => `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;margin-bottom:5px;font-size:11px">
            <div style="color:#1f2937;line-height:1.5">${esc(r.text.slice(0, 150))}${r.text.length > 150 ? "…" : ""}</div>
            <div style="font-size:10px;color:#9ca3af;margin-top:4px">${esc(shortPath(r.filePath, 40))}${r.line ? ` · line ${r.line}` : ""}${r.symbol ? ` · <code>${esc(r.symbol)}</code>` : ""}</div>
          </div>`,
            )
            .join("")}
          ${entries.length > 5 ? `<p style="font-size:10px;color:#9ca3af;margin:2px 0">…and ${entries.length - 5} more</p>` : ""}
        </div>`;
      });
      h += `</div>`;
    }
    h += `</div></div>`;
    return h;
  }

  // ── Executive Summary chapter (Phase 2) ──────────────────────────────────
  function buildExecutiveSummaryHtml(): string {
    const ls = (data as any).livingScore as
      | {
          score: number;
          grade: string;
          specCoverage: { score: number; available: boolean; detail: string };
          constraintConsistency: {
            score: number;
            available: boolean;
            detail: string;
          };
          docFreshness: { score: number; available: boolean; detail: string };
          archConformance: {
            score: number;
            available: boolean;
            detail: string;
          };
        }
      | undefined;

    const structTotal =
      data.meta.totalRuleViolations + data.meta.totalLayerViolations;
    const docTotal = docViols.length;
    const behavTotal = behavViols.length;

    // Grade colours
    const gradeColor = ls
      ? ls.grade === "A"
        ? "#166534"
        : ls.grade === "B"
          ? "#065f46"
          : ls.grade === "C"
            ? "#92400e"
            : ls.grade === "D"
              ? "#9a3412"
              : "#991b1b"
      : "#374151";
    const gradeBg = ls
      ? ls.grade === "A"
        ? "#dcfce7"
        : ls.grade === "B"
          ? "#d1fae5"
          : ls.grade === "C"
            ? "#fef3c7"
            : ls.grade === "D"
              ? "#ffedd5"
              : "#fee2e2"
      : "#f3f4f6";

    // Top-3 actionable items: pick the highest-severity one from each domain
    const topItems: Array<{
      icon: string;
      domain: string;
      title: string;
      detail: string;
      chapterId: string;
      sev: string;
    }> = [];

    // Structural: first high-severity violation, else medium, else any
    const topStruct = [...structViols].sort((a, b) => {
      const ord: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return (ord[a.severity] ?? 3) - (ord[b.severity] ?? 3);
    })[0];
    if (topStruct) {
      topItems.push({
        icon: "🔧",
        domain: "Structural",
        title: `Rule violation: ${topStruct.ruleId}`,
        detail: `${shortPath(topStruct.filePath)}${topStruct.line ? ` · L${topStruct.line}` : ""}`,
        chapterId: "chapter-violations",
        sev: topStruct.severity,
      });
    }

    // Behavioral: first high→medium→low behavioral violation (Phase 3)
    const topBehav = [...behavViols].sort((a, b) => {
      const ord: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return (ord[a.severity] ?? 3) - (ord[b.severity] ?? 3);
    })[0];
    if (topBehav) {
      topItems.push({
        icon: "🔀",
        domain: "Behavioral",
        title: `Sequence violation: ${topBehav.ruleId}`,
        detail: `${shortPath(topBehav.filePath)} — ${topBehav.detail.slice(0, 60)}`,
        chapterId: "chapter-violations",
        sev: topBehav.severity,
      });
    }

    // Documentary: first high→medium→low doc violation
    const topDoc = [...docViols].sort((a, b) => {
      const ord: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return (ord[a.severity] ?? 3) - (ord[b.severity] ?? 3);
    })[0];
    if (topDoc) {
      topItems.push({
        icon: "📝",
        domain: "Documentary",
        title: topDoc.ruleId,
        detail: `${shortPath(topDoc.filePath)} — ${topDoc.detail.slice(0, 60)}`,
        chapterId: "chapter-documentation",
        sev: topDoc.severity,
      });
    }

    // Code health: if codeHealth data exists, pick most impactful
    const ch = (data as any).codeHealth;
    if (
      ch &&
      (ch.circularCycles.length > 0 || ch.boundaryViolations.length > 0)
    ) {
      const isCirc = ch.circularCycles.length > 0;
      topItems.push({
        icon: "🩺",
        domain: "Code Health",
        title: isCirc
          ? `${ch.circularCycles.length} circular import cycle(s)`
          : `${ch.boundaryViolations.length} package boundary violation(s)`,
        detail: isCirc
          ? `Shortest cycle: ${ch.circularCycles[0].files.map((f: string) => shortPath(f, 18)).join(" → ")}`
          : `${ch.byPackagePair
              .slice(0, 2)
              .map((p: any) => `${p.sourcePackage}→${p.targetPackage}`)
              .join(", ")}`,
        chapterId: "chapter-code-health",
        sev: "medium",
      });
    }

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">📋 Executive Summary</h1>
      <p class="chapter-subtitle">Cross-domain health snapshot · ${data.meta.generated.replace("T", " ").replace(/\..+/, "")}</p>
    </div>
    <div class="chapter-body">`;

    // ── Living Score card ─────────────────────────────────────────────────
    if (ls) {
      const dims = [
        { label: "Spec Coverage", icon: "📋", dim: ls.specCoverage },
        {
          label: "Constraint Consistency",
          icon: "🔒",
          dim: ls.constraintConsistency,
        },
        { label: "Documentation Freshness", icon: "📅", dim: ls.docFreshness },
        {
          label: "Architecture Conformance",
          icon: "🏛",
          dim: ls.archConformance,
        },
      ];
      h += `<div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:24px;margin-bottom:16px;padding:20px 24px;background:#fff;border:1px solid #e2e8f0;border-radius:12px">
          <div onclick="activateChapter('chapter-living-score')" style="flex-shrink:0;width:88px;height:88px;border-radius:50%;background:${gradeBg};border:4px solid ${gradeColor};display:flex;align-items:center;justify-content:center;cursor:pointer" title="View Living Score breakdown">
            <span style="font-size:40px;font-weight:900;color:${gradeColor};line-height:1">${esc(ls.grade)}</span>
          </div>
          <div>
            <div style="font-size:32px;font-weight:800;color:#1f2937;line-height:1">${Math.round(ls.score)}<span style="font-size:16px;font-weight:400;color:#6b7280"> / 100</span></div>
            <div style="font-size:12px;color:#6b7280;margin-top:4px">Living Documentation Score</div>
            <div style="font-size:11px;color:#9ca3af;margin-top:4px">A ≥ 90 · B ≥ 75 · C ≥ 60 · D ≥ 45 · F &lt; 45</div>
            <button class="btn-goto" onclick="activateChapter('chapter-living-score')" style="margin-top:8px;font-size:10px">↗ Full Breakdown</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">`;
      dims.forEach(({ label, icon, dim }) => {
        const sc = dim.available ? Math.round(dim.score) : null;
        const barColor =
          sc === null
            ? "#d1d5db"
            : sc >= 75
              ? "#22c55e"
              : sc >= 50
                ? "#f59e0b"
                : "#ef4444";
        const dimBg = dim.available ? "#fff" : "#f9fafb";
        h += `<div style="background:${dimBg};border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="font-size:16px">${icon}</span>
            <span style="font-size:13px;font-weight:700;color:#1f2937">${esc(label)}</span>
            ${dim.available ? "" : `<span class="badge low" style="margin-left:auto;font-size:9px">N/A</span>`}
          </div>
          ${
            dim.available && sc !== null
              ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                  <div style="flex:1;height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden">
                    <div style="width:${sc}%;height:100%;background:${barColor};border-radius:5px"></div>
                  </div>
                  <span style="font-size:18px;font-weight:800;color:${barColor};min-width:40px;text-align:right">${sc}%</span>
                </div>`
              : `<div style="font-size:12px;color:#9ca3af;margin-bottom:8px">Not enough data to compute this dimension.</div>`
          }
          <div style="font-size:11px;color:#6b7280;line-height:1.5">${esc(dim.detail)}</div>
        </div>`;
      });
      h += `</div></div>`;
    } else {
      h += `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;margin-bottom:20px;font-size:12px;color:#6b7280">
        Living Score not available. Run <code>iw index build --depth full</code> then <code>iw intent score</code>.
      </div>`;
    }

    // ── Domain violation summary ────────────────────────────────────────
    h += `<div style="margin-bottom:20px">
      <div style="font-size:13px;font-weight:700;color:#1f2937;margin-bottom:10px">Violations by Domain</div>
      <div class="exec-domain-row">`;

    const domPills = [
      {
        label: "Structural",
        count: structTotal,
        icon: "🔧",
        chapter: "chapter-violations",
        color: structTotal === 0 ? "#166534" : "#991b1b",
        bg: structTotal === 0 ? "#dcfce7" : "#fee2e2",
      },
      {
        label: "Behavioral",
        count: behavTotal,
        icon: "🔀",
        chapter: "chapter-violations",
        color: behavTotal === 0 ? "#166534" : "#991b1b",
        bg: behavTotal === 0 ? "#dcfce7" : "#fee2e2",
      },
      {
        label: "Documentary",
        count: docTotal,
        icon: "📝",
        chapter: "chapter-documentation",
        color: docTotal === 0 ? "#166534" : "#92400e",
        bg: docTotal === 0 ? "#dcfce7" : "#fff7ed",
      },
    ];
    domPills.forEach((p) => {
      h += `<div class="exec-domain-pill" style="cursor:pointer;background:${p.bg};border-color:${p.bg === "#dcfce7" ? "#bbf7d0" : p.bg === "#fee2e2" ? "#fca5a5" : "#fed7aa"}" onclick="activateChapter('${p.chapter}')">
        <span style="font-size:20px">${p.icon}</span>
        <div class="edp-count" style="color:${p.color}">${p.count}</div>
        <div class="edp-label">${esc(p.label)}</div>
      </div>`;
    });
    h += `</div></div>`;

    // ── Top-3 actions ──────────────────────────────────────────────────
    if (topItems.length > 0) {
      h += `<div style="margin-bottom:20px">
        <div style="font-size:13px;font-weight:700;color:#1f2937;margin-bottom:10px">Top Issues</div>
        <div style="display:flex;flex-direction:column;gap:8px">`;
      topItems.slice(0, 3).forEach((item) => {
        const sevBadge = sev(item.sev);
        h += `<div class="action-card">
          <span class="ac-icon">${item.icon}</span>
          <div class="ac-body">
            <div class="ac-title">${sevBadge} <span style="margin-left:4px">${esc(item.title)}</span></div>
            <div class="ac-detail">${esc(item.detail)}</div>
            <div class="ac-link"><button class="btn-goto" style="margin-left:0" onclick="activateChapter('${item.chapterId}')">Go to ${esc(item.domain)} chapter →</button></div>
          </div>
        </div>`;
      });
      h += `</div></div>`;
    } else {
      h += `<div style="padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;margin-bottom:20px;font-size:13px;color:#166534;text-align:center">
        <div style="font-size:24px;margin-bottom:6px">🎉</div>
        No violations found across all domains. Great shape!
      </div>`;
    }

    // ── Quick links ──────────────────────────────────────────────────────
    h += `<div style="margin-bottom:4px">
      <div style="font-size:13px;font-weight:700;color:#1f2937;margin-bottom:10px">Jump to Chapter</div>
      <div class="quick-links-grid">`;

    const qlLinks: Array<{
      icon: string;
      label: string;
      id: string;
      badge?: number;
    }> = [
      {
        icon: "🎯",
        label: "Recommendations",
        id: "chapter-recommendations",
        badge: structTotal + behavViols.length + docTotal,
      },
      {
        icon: "⚠️",
        label: "All Violations",
        id: "chapter-violations",
        badge: structTotal + behavViols.length,
      },
      {
        icon: "📝",
        label: "Documentation",
        id: "chapter-documentation",
        badge: docTotal,
      },
      { icon: "🏛", label: "Layer Architecture", id: "chapter-layers" },
      { icon: "🔬", label: "Arch Graph", id: "chapter-arch-graph" },
      { icon: "🩺", label: "Code Health", id: "chapter-code-health" },
      { icon: "🔥", label: "Priority Files", id: "chapter-priority-files" },
      { icon: "📐", label: "Code Structure", id: "chapter-code-structure" },
      { icon: "📊", label: "Coverage", id: "chapter-coverage" },
    ];
    qlLinks.forEach((l) => {
      const targetEl = document.getElementById(l.id);
      if (!targetEl && l.id !== "chapter-layers") return; // skip unavailable chapters
      const badgeHtml =
        l.badge !== undefined
          ? `<span class="qlc-badge${l.badge === 0 ? " ok" : ""}">${l.badge === 0 ? "✓" : l.badge}</span>`
          : "";
      h += `<div class="quick-link-card" onclick="activateChapter('${l.id}')">
        <span class="qlc-icon">${l.icon}</span>
        <span>${esc(l.label)}</span>
        ${badgeHtml}
      </div>`;
    });
    h += `</div></div>`;

    h += `</div>`; // chapter-body
    return h;
  }

  // ── Recommendations chapter (Phase 2) ────────────────────────────────────
  function buildRecommendationsHtml(): string {
    // Aggregate cross-domain recommendations, rank by severity
    type RecoItem = {
      rank: number;
      severity: string;
      domain: string;
      domainIcon: string;
      ruleId: string;
      filePath: string;
      detail: string;
      hint: string;
      chapterId: string;
    };

    const sevOrd: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const items: RecoItem[] = [];

    // Structural rule violations
    structViols.forEach((v) => {
      items.push({
        rank: 0,
        severity: v.severity,
        domain: "Structural",
        domainIcon: "🔧",
        ruleId: v.ruleId,
        filePath: v.filePath,
        detail: v.detail.slice(0, 100),
        hint: `Fix the import/call pattern in this file to satisfy rule ${v.ruleId}.`,
        chapterId: "chapter-" + v.ruleId.replace(/[^a-z0-9]/gi, "-"),
      });
    });

    // Behavioral violations (Phase 3 — Mermaid rules)
    behavViols.forEach((v) => {
      const isMustNotCall = v.detail.includes("must_not_call");
      items.push({
        rank: 0,
        severity: v.severity,
        domain: "Behavioral",
        domainIcon: "🔀",
        ruleId: v.ruleId,
        filePath: v.filePath,
        detail: v.detail.slice(0, 100),
        hint: isMustNotCall
          ? "Remove the direct import — route through the declared intermediary instead."
          : "Add the required import/call to satisfy the declared sequence diagram.",
        chapterId: "chapter-violations",
      });
    });

    // Layer violations are already counted in totalLayerViolations — add a summary item
    if (data.meta.totalLayerViolations > 0) {
      items.push({
        rank: 0,
        severity: "high",
        domain: "Structural",
        domainIcon: "🔧",
        ruleId: "layer-violation",
        filePath: "(multiple files)",
        detail: `${data.meta.totalLayerViolations} files import across declared layer boundaries`,
        hint: `Run iw index layers-check for the full list, then move imports to respect layer order.`,
        chapterId: "chapter-layers",
      });
    }

    // Documentary violations
    docViols.forEach((v) => {
      items.push({
        rank: 0,
        severity: v.severity,
        domain: "Documentary",
        domainIcon: "📝",
        ruleId: v.ruleId,
        filePath: v.filePath,
        detail: v.detail,
        hint:
          v.ruleId === "doc.orphaned-section"
            ? "Update this doc section to reference real code symbols, or remove it."
            : v.ruleId === "doc.terminology"
              ? "Standardise the naming — pick one variant and update all docs."
              : "Expand this doc to cover more of its exported symbols.",
        chapterId: "chapter-documentation",
      });
    });

    // Code health issues
    const chData = (data as any).codeHealth;
    if (chData) {
      chData.circularCycles.slice(0, 5).forEach((cycle: any, i: number) => {
        items.push({
          rank: 0,
          severity: "high",
          domain: "Code Health",
          domainIcon: "🩺",
          ruleId: "circular-import",
          filePath: cycle.files[0] ?? "(unknown)",
          detail: `Cycle of ${cycle.length} files: ${cycle.files
            .slice(0, 3)
            .map((f: string) => shortPath(f, 20))
            .join(" → ")}${cycle.length > 3 ? " …" : ""}`,
          hint: "Break the cycle by extracting shared code to a lower-level module.",
          chapterId: "chapter-code-health",
        });
      });
      chData.boundaryViolations.slice(0, 5).forEach((v: any) => {
        items.push({
          rank: 0,
          severity: "medium",
          domain: "Code Health",
          domainIcon: "🩺",
          ruleId: "boundary-violation",
          filePath: v.sourceFile,
          detail: `${shortPath(v.sourceFile, 24)} → ${shortPath(v.targetFile, 24)} (${v.reason})`,
          hint: "Import through the public API (index.ts) instead of reaching into internal modules.",
          chapterId: "chapter-code-health",
        });
      });
    }

    // Sort by domain priority then severity
    const domOrd: Record<string, number> = {
      Structural: 0,
      Behavioral: 1,
      "Code Health": 2,
      Documentary: 3,
    };
    items.sort((a, b) => {
      const sevA = sevOrd[a.severity] ?? 3;
      const sevB = sevOrd[b.severity] ?? 3;
      if (sevA !== sevB) return sevA - sevB;
      const domA = domOrd[a.domain] ?? 9;
      const domB = domOrd[b.domain] ?? 9;
      return domA - domB;
    });
    items.forEach((item, i) => (item.rank = i + 1));

    const top = items.slice(0, 20);

    let h = `<div class="chapter-header">
      <h1 class="chapter-title">🎯 Recommendations</h1>
      <p class="chapter-subtitle">Cross-domain ranked actions · ${top.length} of ${items.length} total issues shown · sorted by severity</p>
    </div>
    <div class="chapter-body">`;

    if (top.length === 0) {
      h += `<div style="padding:48px;text-align:center;color:#6b7280;font-size:14px">
        <div style="font-size:40px;margin-bottom:12px">🏆</div>
        No cross-domain issues found. All checks pass!
      </div>`;
    } else {
      h += `<div class="reco-list">`;
      top.forEach((item) => {
        const domColor =
          item.domain === "Structural"
            ? { bg: "#eff6ff", color: "#1e40af", border: "#bfdbfe" }
            : item.domain === "Behavioral"
              ? { bg: "#fdf4ff", color: "#7c3aed", border: "#e9d5ff" }
              : item.domain === "Code Health"
                ? { bg: "#fff7ed", color: "#9a3412", border: "#fed7aa" }
                : { bg: "#f0fdf4", color: "#166534", border: "#bbf7d0" };
        h += `<div class="reco-card">
          <div class="reco-num" style="background:${item.rank <= 3 ? "#fef3c7" : "#f3f4f6"};color:${item.rank <= 3 ? "#92400e" : "#6b7280"}">${item.rank}</div>
          <div class="reco-body">
            <div class="reco-title">${sev(item.severity)} <span style="margin-left:4px">${esc(item.ruleId)}</span></div>
            <div class="reco-file" title="${esc(item.filePath)}">${esc(shortPath(item.filePath))}</div>
            <div class="reco-detail">${esc(item.detail)}</div>
            <div class="reco-footer">
              <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:6px;border:1px solid ${domColor.border};background:${domColor.bg};color:${domColor.color}">
                ${item.domainIcon} ${esc(item.domain)}
              </span>
              <span style="font-size:10px;color:#6b7280;font-style:italic">${esc(item.hint)}</span>
              <button class="btn-goto" style="margin-left:0" onclick="activateChapter('${item.chapterId}')">View →</button>
            </div>
          </div>
        </div>`;
      });
      h += `</div>`;
      if (items.length > 20) {
        h += `<p style="margin-top:16px;font-size:12px;color:#9ca3af">Showing top 20 of ${items.length} issues. Open individual chapters for the complete lists.</p>`;
      }
    }

    h += `</div>`;
    return h;
  }

  // ── Call Graph butterfly visualizer (19.1) ───────────────────────────────
  function initCallGraph(chapterId: string) {
    type TraceN = { file: string; symbols: string[]; depth: number };
    type TraceE = {
      fromFile: string;
      fromSymbol: string | null;
      toFile: string;
      toCalleeName: string;
      callerLine: number | null;
    };
    type CGTrace = { nodes: TraceN[]; edges: TraceE[]; truncated: boolean };
    type CGEntry = { entryFile: string; forward: CGTrace; backward: CGTrace };
    type CGData = {
      total: number;
      topCallees: Array<{ calleeName: string; count: number }>;
      traces: CGEntry[];
      callsTableActive: boolean;
    };
    const cgData = (DATA as any).callGraph as CGData | undefined;
    if (!cgData?.callsTableActive || !cgData.traces.length) return;
    const ch = document.getElementById(chapterId) as any;
    if (!ch) return;

    const entrySelect = ch.querySelector("#cg-entry") as any;
    const modeSelect = ch.querySelector("#cg-mode") as any;
    const depthSlider = ch.querySelector("#cg-depth") as any;
    const depthValEl = ch.querySelector("#cg-depth-val") as any;
    const levelSelect = ch.querySelector("#cg-level") as any;
    const svgEl = ch.querySelector("#cg-svg") as any;
    const tooltipEl = ch.querySelector("#cg-tooltip") as any;
    const truncBadge = ch.querySelector("#cg-truncated") as any;
    if (!svgEl) return;

    const NS = "http://www.w3.org/2000/svg";
    const ROOT_ID = "__root__";
    let currentEntry: CGEntry = cgData.traces[0];
    let maxDepth = 3;
    let mode: "both" | "forward" | "backward" = "both";
    let level: "file" | "fn" = "file";
    let vizMode: "butterfly" | "flame" = "butterfly";

    // A unified display node used for both file and function level
    type DNode = {
      id: string;
      label: string;
      sub: string | null;
      file: string;
      depth: number;
      symbols: string[];
      hasTrace: boolean;
    };
    type DEdge = { fromId: string; toId: string };

    function dedupEdges(edges: DEdge[]): DEdge[] {
      const seen = new Set<string>();
      return edges.filter((e) => {
        const k = `${e.fromId}→${e.toId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // ── FILE-LEVEL ────────────────────────────────────────────────────────────
    function buildFileLevel(
      trace: CGTrace,
      side: "fwd" | "bwd",
      md: number,
    ): { nodes: DNode[]; edges: DEdge[] } {
      const visible = new Set(
        trace.nodes
          .filter((n) => n.depth > 0 && n.depth <= md)
          .map((n) => n.file),
      );
      const nodes: DNode[] = trace.nodes
        .filter((n) => n.depth > 0 && n.depth <= md)
        .map((n) => ({
          id: n.file,
          label: (() => {
            const b = n.file.split("/").pop() ?? n.file;
            return b.length > 20 ? b.slice(0, 18) + "…" : b;
          })(),
          sub: null,
          file: n.file,
          depth: n.depth,
          symbols: n.symbols,
          hasTrace: cgData!.traces.some((t) => t.entryFile === n.file),
        }));
      let raw: DEdge[];
      if (side === "fwd") {
        // fromFile → toFile; entry is the source root
        raw = trace.edges
          .filter(
            (e) =>
              visible.has(e.toFile) &&
              (e.fromFile === currentEntry.entryFile ||
                visible.has(e.fromFile)),
          )
          .map((e) => ({
            fromId:
              e.fromFile === currentEntry.entryFile ? ROOT_ID : e.fromFile,
            toId: e.toFile,
          }));
      } else {
        // backward: fromFile = caller (further left), toFile = callee (toward center)
        // Arrow direction: caller → callee (pointing right/toward root)
        raw = trace.edges
          .filter(
            (e) =>
              visible.has(e.fromFile) &&
              (e.toFile === currentEntry.entryFile || visible.has(e.toFile)),
          )
          .map((e) => ({
            fromId: e.fromFile,
            toId: e.toFile === currentEntry.entryFile ? ROOT_ID : e.toFile,
          }));
      }
      return { nodes, edges: dedupEdges(raw) };
    }

    // ── FUNCTION-LEVEL ────────────────────────────────────────────────────────
    function buildFnLevel(
      trace: CGTrace,
      side: "fwd" | "bwd",
      md: number,
    ): { nodes: DNode[]; edges: DEdge[] } {
      const fileDepth = new Map<string, number>(
        trace.nodes.map((n) => [n.file, n.depth]),
      );
      const nodeMap = new Map<string, DNode>();
      const rawEdges: DEdge[] = [];

      if (side === "fwd") {
        // Each edge: fromFile/fromSymbol calls toCalleeName in toFile
        for (const e of trace.edges) {
          const d = fileDepth.get(e.toFile) ?? 1;
          if (d > md) continue;
          const nodeId = `fn:${e.toCalleeName}::${e.toFile}`;
          if (!nodeMap.has(nodeId)) {
            const lbl =
              e.toCalleeName.length > 22
                ? e.toCalleeName.slice(0, 20) + "…"
                : e.toCalleeName;
            const sub = (() => {
              const b = e.toFile.split("/").pop() ?? "";
              return b.length > 18 ? b.slice(0, 16) + "…" : b;
            })();
            nodeMap.set(nodeId, {
              id: nodeId,
              label: lbl,
              sub,
              file: e.toFile,
              depth: d,
              symbols: [],
              hasTrace: false,
            });
          }
          // Connect: previous fn node (or root) → this fn node
          const fromId =
            e.fromFile === currentEntry.entryFile
              ? ROOT_ID
              : e.fromSymbol
                ? `fn:${e.fromSymbol}::${e.fromFile}`
                : ROOT_ID;
          rawEdges.push({ fromId, toId: nodeId });
        }
      } else {
        // backward: fromFile=caller, fromSymbol=calling fn, toFile=callee (toward center)
        for (const e of trace.edges) {
          const d = fileDepth.get(e.fromFile) ?? 1;
          if (d > md) continue;
          const fnLabel =
            e.fromSymbol ?? e.fromFile.split("/").pop() ?? e.fromFile;
          const nodeId = `fn:${fnLabel}::${e.fromFile}`;
          if (!nodeMap.has(nodeId)) {
            const lbl =
              fnLabel.length > 22 ? fnLabel.slice(0, 20) + "…" : fnLabel;
            const sub = (() => {
              const b = e.fromFile.split("/").pop() ?? "";
              return b.length > 18 ? b.slice(0, 16) + "…" : b;
            })();
            nodeMap.set(nodeId, {
              id: nodeId,
              label: lbl,
              sub,
              file: e.fromFile,
              depth: d,
              symbols: [],
              hasTrace: false,
            });
          }
          // Arrow: caller fn node → callee (ROOT or closer node)
          const toId =
            e.toFile === currentEntry.entryFile
              ? ROOT_ID
              : `fn:${e.toCalleeName}::${e.toFile}`;
          rawEdges.push({ fromId: nodeId, toId });
        }
      }
      return { nodes: [...nodeMap.values()], edges: dedupEdges(rawEdges) };
    }

    // ── Shared Y layout ───────────────────────────────────────────────────────
    function buildYMap(nodes: DNode[], H: number): Map<string, number> {
      const byDepth = new Map<number, DNode[]>();
      for (const n of nodes) {
        const arr = byDepth.get(n.depth) ?? [];
        arr.push(n);
        byDepth.set(n.depth, arr);
      }
      const yMap = new Map<string, number>();
      for (const [, group] of byDepth) {
        const step = H / (group.length + 1);
        group.forEach((n, i) => yMap.set(n.id, (i + 1) * step));
      }
      return yMap;
    }

    // ── Main render ───────────────────────────────────────────────────────────
    function renderButterfly() {
      svgEl.innerHTML = "";
      const W = Math.max((svgEl.parentElement?.clientWidth ?? 800) - 4, 400);
      const H = 500;
      svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svgEl.setAttribute("height", String(H));
      const cx = W / 2;
      const rootY = H / 2;
      const md = Math.min(maxDepth, 4);
      const depthStep = Math.min(170, (W / 2 - 90) / Math.max(md, 1));

      const build = level === "file" ? buildFileLevel : buildFnLevel;
      const fwdData =
        mode !== "backward"
          ? build(currentEntry.forward, "fwd", md)
          : { nodes: [] as DNode[], edges: [] as DEdge[] };
      const bwdData =
        mode !== "forward"
          ? build(currentEntry.backward, "bwd", md)
          : { nodes: [] as DNode[], edges: [] as DEdge[] };

      const fwdY = buildYMap(fwdData.nodes, H);
      const bwdY = buildYMap(bwdData.nodes, H);

      function sideX(side: "fwd" | "bwd", depth: number) {
        return side === "fwd" ? cx + depth * depthStep : cx - depth * depthStep;
      }
      function resolveX(id: string, side: "fwd" | "bwd", nodes: DNode[]) {
        if (id === ROOT_ID) return cx;
        return sideX(side, nodes.find((n) => n.id === id)?.depth ?? 1);
      }
      function resolveY(id: string, yMap: Map<string, number>) {
        return id === ROOT_ID ? rootY : (yMap.get(id) ?? rootY);
      }

      // Defs
      const defs = document.createElementNS(NS, "defs");
      defs.innerHTML = `
        <marker id="cg-af" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M1,1 L1,6 L7,3.5 z" fill="#93c5fd"/>
        </marker>
        <marker id="cg-ab" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M1,1 L1,6 L7,3.5 z" fill="#f9a8d4"/>
        </marker>`;
      svgEl.appendChild(defs);

      const edgeG = document.createElementNS(NS, "g");
      svgEl.appendChild(edgeG);

      function drawEdge(
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        color: string,
        marker: string,
      ) {
        const p = document.createElementNS(NS, "path");
        const mx = (x1 + x2) / 2;
        p.setAttribute(
          "d",
          `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        );
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", color);
        p.setAttribute("stroke-width", "1.5");
        p.setAttribute("stroke-opacity", "0.6");
        p.setAttribute("marker-end", `url(#${marker})`);
        edgeG.appendChild(p);
      }

      // Forward (right) edges: arrow points right (caller → callee)
      for (const e of fwdData.edges) {
        drawEdge(
          resolveX(e.fromId, "fwd", fwdData.nodes),
          resolveY(e.fromId, fwdY),
          resolveX(e.toId, "fwd", fwdData.nodes),
          resolveY(e.toId, fwdY),
          "#93c5fd",
          "cg-af",
        );
      }
      // Backward (left) edges: fromId = caller (further left), toId = callee (toward center)
      // Arrow points right → toward center, showing "X calls Y" direction
      for (const e of bwdData.edges) {
        drawEdge(
          resolveX(e.fromId, "bwd", bwdData.nodes),
          resolveY(e.fromId, bwdY),
          resolveX(e.toId, "bwd", bwdData.nodes),
          resolveY(e.toId, bwdY),
          "#f9a8d4",
          "cg-ab",
        );
      }

      const nodeG = document.createElementNS(NS, "g");
      svgEl.appendChild(nodeG);

      function drawNode(
        x: number,
        y: number,
        node: DNode | null,
        isRoot: boolean,
      ) {
        const lbl = isRoot
          ? (() => {
              const b =
                currentEntry.entryFile.split("/").pop() ??
                currentEntry.entryFile;
              return b.length > 20 ? b.slice(0, 18) + "…" : b;
            })()
          : (node?.label ?? "");
        const showSub =
          !isRoot && level === "fn" && node?.sub && node.sub !== lbl;
        const nw = isRoot ? 140 : 116;
        const nh = showSub ? 36 : 28;
        const g = document.createElementNS(NS, "g") as any;
        g.setAttribute("transform", `translate(${x},${y})`);
        if (!isRoot && node?.hasTrace) g.style.cursor = "pointer";

        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", String(-nw / 2));
        rect.setAttribute("y", String(-nh / 2));
        rect.setAttribute("width", String(nw));
        rect.setAttribute("height", String(nh));
        rect.setAttribute("rx", "5");
        rect.setAttribute("fill", isRoot ? "#1d4ed8" : "#f0f9ff");
        rect.setAttribute("stroke", isRoot ? "#1e40af" : "#7dd3fc");
        rect.setAttribute("stroke-width", isRoot ? "2" : "1.5");
        g.appendChild(rect);

        const txt = document.createElementNS(NS, "text");
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("dominant-baseline", showSub ? "auto" : "middle");
        txt.setAttribute("y", showSub ? "-5" : "0");
        txt.setAttribute("font-size", "10");
        txt.setAttribute("font-weight", isRoot ? "700" : "500");
        txt.setAttribute("fill", isRoot ? "#fff" : "#1e40af");
        txt.setAttribute("font-family", "ui-monospace,monospace");
        txt.textContent = lbl;
        g.appendChild(txt);

        if (showSub) {
          const sub = document.createElementNS(NS, "text");
          sub.setAttribute("text-anchor", "middle");
          sub.setAttribute("dominant-baseline", "hanging");
          sub.setAttribute("y", "6");
          sub.setAttribute("font-size", "9");
          sub.setAttribute("fill", "#64748b");
          sub.setAttribute("font-family", "ui-sans-serif,sans-serif");
          sub.textContent = node!.sub!;
          g.appendChild(sub);
        }

        const fullLabel = isRoot ? currentEntry.entryFile : (node?.file ?? "");
        const syms = node?.symbols ?? [];
        g.addEventListener("mouseenter", (evt: any) => {
          const r = svgEl.getBoundingClientRect();
          const symLine = syms.length
            ? `<br><span style="color:#94a3b8">${syms.slice(0, 6).join(", ")}${syms.length > 6 ? " …" : ""}</span>`
            : "";
          tooltipEl.innerHTML = `<strong>${fullLabel}</strong>${symLine}`;
          tooltipEl.style.display = "block";
          tooltipEl.style.left = `${Math.min(evt.clientX - r.left + 12, W - 220)}px`;
          tooltipEl.style.top = `${Math.max(evt.clientY - r.top - 44, 4)}px`;
        });
        g.addEventListener("mousemove", (evt: any) => {
          const r = svgEl.getBoundingClientRect();
          tooltipEl.style.left = `${Math.min(evt.clientX - r.left + 12, W - 220)}px`;
          tooltipEl.style.top = `${Math.max(evt.clientY - r.top - 44, 4)}px`;
        });
        g.addEventListener("mouseleave", () => {
          tooltipEl.style.display = "none";
        });

        if (!isRoot && node?.hasTrace) {
          g.addEventListener("click", () => {
            const t = cgData!.traces.find((tr) => tr.entryFile === node!.file);
            if (t) {
              currentEntry = t;
              if (entrySelect) entrySelect.value = node!.file;
              renderButterfly();
            }
          });
        }
        nodeG.appendChild(g);
      }

      for (const n of fwdData.nodes)
        drawNode(sideX("fwd", n.depth), fwdY.get(n.id) ?? rootY, n, false);
      for (const n of bwdData.nodes)
        drawNode(sideX("bwd", n.depth), bwdY.get(n.id) ?? rootY, n, false);
      drawNode(cx, rootY, null, true); // root on top

      const trunc =
        (mode !== "backward" && currentEntry.forward.truncated) ||
        (mode !== "forward" && currentEntry.backward.truncated);
      if (truncBadge) truncBadge.style.display = trunc ? "block" : "none";
    }

    function renderFlame() {
      svgEl.innerHTML = "";
      const W = Math.max((svgEl.parentElement?.clientWidth ?? 800) - 4, 400);
      const trace = currentEntry.forward;
      const md = Math.min(maxDepth, 4);
      const byDepth = new Map<number, TraceN[]>();
      byDepth.set(0, [{ file: currentEntry.entryFile, symbols: [], depth: 0 }]);
      for (const n of trace.nodes) {
        if (n.depth > 0 && n.depth <= md) {
          const arr = byDepth.get(n.depth) ?? [];
          arr.push(n);
          byDepth.set(n.depth, arr);
        }
      }
      const ROW_H = 34,
        ROW_GAP = 3,
        LABEL_W = 48,
        PAD = 2;
      const maxD = byDepth.size > 0 ? Math.max(...byDepth.keys()) : 0;
      const fH = (maxD + 1) * (ROW_H + ROW_GAP) + 12;
      svgEl.setAttribute("viewBox", `0 0 ${W} ${fH}`);
      svgEl.setAttribute("height", String(fH));
      const palette = ["#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"];
      const topCalleeSet = new Set<string>(
        cgData!.topCallees.slice(0, 5).map((tc) => tc.calleeName),
      );
      for (const [depth, nodes] of byDepth) {
        const y = depth * (ROW_H + ROW_GAP) + 4;
        const availW = W - LABEL_W - 4;
        const nodeW = Math.max(4, availW / nodes.length - PAD);
        const fill0 = palette[Math.min(depth, palette.length - 1)];
        nodes.forEach((n, i) => {
          const x = 2 + i * (nodeW + PAD);
          const isHot = n.symbols.some((s) => topCalleeSet.has(s));
          const fill = isHot ? "#f97316" : fill0;
          const g = document.createElementNS(NS, "g") as any;
          const rect = document.createElementNS(NS, "rect");
          rect.setAttribute("x", String(x));
          rect.setAttribute("y", String(y));
          rect.setAttribute("width", String(nodeW));
          rect.setAttribute("height", String(ROW_H));
          rect.setAttribute("rx", "3");
          rect.setAttribute("fill", fill);
          rect.setAttribute("stroke", "#fff");
          rect.setAttribute("stroke-width", "1");
          g.appendChild(rect);
          if (nodeW > 35) {
            const maxChars = Math.max(4, Math.floor(nodeW / 6.5));
            const base = n.file.split("/").pop() ?? n.file;
            const lbl =
              base.length > maxChars
                ? base.slice(0, maxChars - 1) + "\u2026"
                : base;
            const txt = document.createElementNS(NS, "text");
            txt.setAttribute("x", String(x + nodeW / 2));
            txt.setAttribute("y", String(y + ROW_H / 2));
            txt.setAttribute("text-anchor", "middle");
            txt.setAttribute("dominant-baseline", "middle");
            txt.setAttribute("font-size", "9");
            txt.setAttribute("fill", "#fff");
            txt.setAttribute("font-family", "ui-monospace,monospace");
            txt.setAttribute("pointer-events", "none");
            txt.textContent = lbl;
            g.appendChild(txt);
          }
          g.addEventListener("mouseenter", (evt: any) => {
            const r = svgEl.getBoundingClientRect();
            const syms = n.symbols.length
              ? `<br><span style="color:#94a3b8">${n.symbols.slice(0, 6).join(", ")}${n.symbols.length > 6 ? " \u2026" : ""}</span>`
              : "";
            tooltipEl.innerHTML = `<strong>${n.file}</strong>${syms}`;
            tooltipEl.style.display = "block";
            tooltipEl.style.left = `${Math.min(evt.clientX - r.left + 12, W - 220)}px`;
            tooltipEl.style.top = `${Math.max(evt.clientY - r.top - 44, 4)}px`;
          });
          g.addEventListener("mousemove", (evt: any) => {
            const r = svgEl.getBoundingClientRect();
            tooltipEl.style.left = `${Math.min(evt.clientX - r.left + 12, W - 220)}px`;
            tooltipEl.style.top = `${Math.max(evt.clientY - r.top - 44, 4)}px`;
          });
          g.addEventListener("mouseleave", () => {
            tooltipEl.style.display = "none";
          });
          if (depth > 0 && cgData!.traces.some((t) => t.entryFile === n.file)) {
            g.style.cursor = "pointer";
            g.addEventListener("click", () => {
              const t = cgData!.traces.find((tr) => tr.entryFile === n.file);
              if (t) {
                currentEntry = t;
                if (entrySelect) entrySelect.value = n.file;
                renderFlame();
              }
            });
          }
          svgEl.appendChild(g);
        });
        const dlbl = document.createElementNS(NS, "text");
        dlbl.setAttribute("x", String(W - 2));
        dlbl.setAttribute("y", String(y + ROW_H / 2));
        dlbl.setAttribute("text-anchor", "end");
        dlbl.setAttribute("dominant-baseline", "middle");
        dlbl.setAttribute("font-size", "9");
        dlbl.setAttribute("fill", "#9ca3af");
        dlbl.setAttribute("font-family", "ui-sans-serif,sans-serif");
        dlbl.textContent = depth === 0 ? "entry" : `d=${depth}`;
        svgEl.appendChild(dlbl);
      }
      if (truncBadge)
        truncBadge.style.display = currentEntry.forward.truncated
          ? "block"
          : "none";
    }

    function render() {
      if (vizMode === "butterfly") renderButterfly();
      else renderFlame();
    }
    const vizBtns = Array.from(ch.querySelectorAll("[data-cg-viz]")) as any[];
    vizBtns.forEach((btn: any) => {
      btn.addEventListener("click", () => {
        vizMode = btn.dataset.cgViz as "butterfly" | "flame";
        vizBtns.forEach((b: any) => {
          const active = b.dataset.cgViz === vizMode;
          b.style.background = active ? "#1d4ed8" : "#f3f4f6";
          b.style.color = active ? "#fff" : "#374151";
          b.style.borderColor = active ? "#93c5fd" : "#e5e7eb";
        });
        render();
      });
    });

    entrySelect?.addEventListener("change", () => {
      const t = cgData!.traces.find((tr) => tr.entryFile === entrySelect.value);
      if (t) {
        currentEntry = t;
        render();
      }
    });
    modeSelect?.addEventListener("change", () => {
      mode = modeSelect.value;
      render();
    });
    levelSelect?.addEventListener("change", () => {
      level = levelSelect.value as "file" | "fn";
      render();
    });
    depthSlider?.addEventListener("input", () => {
      maxDepth = parseInt(depthSlider.value, 10);
      if (depthValEl) depthValEl.textContent = String(maxDepth);
      render();
    });

    render();

    if ((globalThis as any).ResizeObserver) {
      const ro = new (globalThis as any).ResizeObserver(() => render());
      ro.observe(svgEl.parentElement);
    }
  }

  // ── Pure-SVG LR flow diagram (Sugiyama-style, zero external deps) ────────
  // Track which overlay checkbox states are active per diagram id
  const overlayState = new Map<string, Set<string>>();
  // Per-diagram: Map from node-name → <g> element (rect + text), for overlay updates
  const flowNodeEls = new Map<string, Map<string, any>>();
  // Per-diagram: import edge group element (for toggle)
  const flowImportGroups = new Map<string, any>();

  // SVG namespace helper
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag: string, attrs: Record<string, string | number>) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  function initFlowDiagram(chapterId: string) {
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

    // ── Build node + edge data ─────────────────────────────────────────────
    interface FDNode {
      id: string;
      label: string;
      isStep: boolean;
      rank: number;
      posInRank: number;
      x: number;
      y: number;
    }
    interface FDEdge {
      source: string;
      target: string;
      edgeType: string;
      flowKind: string;
      isImport: boolean;
    }

    const nodeMap = new Map<string, FDNode>();
    els.forEach((el: any) => {
      nodeMap.set(el.name, {
        id: el.name,
        label: el.name,
        isStep: el.flowSeq != null && el.flowSeq < 999,
        rank: 0,
        posInRank: 0,
        x: 0,
        y: 0,
      });
    });

    const ruleEdges = data.edges.filter(
      (e: PrescriptiveEdge) =>
        e.ruleId === ruleId &&
        e.fromElementName &&
        e.toElementName &&
        !isGlob(String(e.fromElementName)) &&
        !isGlob(String(e.toElementName)),
    );
    const seenEdge = new Set<string>();
    const fdEdges: FDEdge[] = ruleEdges
      .filter((e: PrescriptiveEdge) => {
        const k = `${e.fromElementName}->${e.toElementName}`;
        if (seenEdge.has(k)) return false;
        seenEdge.add(k);
        return (
          nodeMap.has(String(e.fromElementName)) &&
          nodeMap.has(String(e.toElementName))
        );
      })
      .map((e: PrescriptiveEdge) => ({
        source: String(e.fromElementName),
        target: String(e.toElementName),
        edgeType: e.type ?? "allowed",
        flowKind: (e as any).flowKind ?? "",
        isImport: false,
      }));

    if (fdEdges.length === 0 && els.length > 1) {
      for (let i = 0; i < els.length - 1; i++) {
        fdEdges.push({
          source: els[i].name,
          target: els[i + 1].name,
          edgeType: "allowed",
          flowKind: "flow",
          isImport: false,
        });
      }
    }

    // ── Rank assignment (BFS from sources) ─────────────────────────────────
    const inEdges = new Map<string, string[]>();
    nodeMap.forEach((_, id) => inEdges.set(id, []));
    fdEdges
      .filter((e) => !e.isImport)
      .forEach((e) => inEdges.get(e.target)?.push(e.source));

    const rank = new Map<string, number>();
    nodeMap.forEach((_, id) => rank.set(id, 0));
    const sources = [...nodeMap.keys()].filter(
      (id) => (inEdges.get(id) ?? []).length === 0,
    );
    const queue = sources.length > 0 ? [...sources] : [[...nodeMap.keys()][0]];
    queue.forEach((id) => rank.set(id, 0));
    const outAdj = new Map<string, string[]>();
    nodeMap.forEach((_, id) => outAdj.set(id, []));
    fdEdges
      .filter((e) => !e.isImport)
      .forEach((e) => outAdj.get(e.source)?.push(e.target));
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const r = rank.get(cur) ?? 0;
      (outAdj.get(cur) ?? []).forEach((next) => {
        const nr = r + 1;
        if ((rank.get(next) ?? 0) < nr) {
          rank.set(next, nr);
          queue.push(next);
        }
      });
    }
    const maxRank = Math.max(0, ...[...rank.values()]);

    // ── Rank → nodes; compute Y positions ──────────────────────────────────
    const rankNodes = new Map<number, string[]>();
    for (let r = 0; r <= maxRank; r++) rankNodes.set(r, []);
    nodeMap.forEach((_, id) => rankNodes.get(rank.get(id) ?? 0)?.push(id));

    const NW = 120,
      NH = 36,
      RANK_SEP = 160,
      NODE_SEP = 60,
      PAD = 32;
    rankNodes.forEach((ids, r) => {
      const totalH = ids.length * NH + (ids.length - 1) * NODE_SEP;
      ids.forEach((id, i) => {
        const node = nodeMap.get(id)!;
        node.rank = r;
        node.posInRank = i;
        node.x = PAD + r * RANK_SEP;
        node.y =
          PAD + i * (NH + NODE_SEP) + (rankNodes.get(r)!.length > 1 ? 0 : 0);
        // Vertically center the entire column
        const maxColH = Math.max(
          ...[...rankNodes.values()].map(
            (ns) => ns.length * NH + (ns.length - 1) * NODE_SEP,
          ),
        );
        node.y = PAD + (maxColH - totalH) / 2 + i * (NH + NODE_SEP);
      });
    });

    const svgW = PAD * 2 + (maxRank + 1) * RANK_SEP;
    const svgH =
      PAD * 2 +
      Math.max(
        ...[...rankNodes.values()].map(
          (ns) => ns.length * NH + Math.max(0, ns.length - 1) * NODE_SEP,
        ),
      );

    // ── Build SVG ──────────────────────────────────────────────────────────
    const svg = svgEl("svg", {
      width: "100%",
      height: svgH,
      viewBox: `0 0 ${svgW} ${svgH}`,
      style: "display:block;overflow:visible",
    });

    // Arrow marker defs
    const defs = svgEl("defs", {});
    const mkMarker = (id: string, color: string, dashed: boolean) => {
      const marker = svgEl("marker", {
        id,
        markerWidth: "8",
        markerHeight: "8",
        refX: "7",
        refY: "3.5",
        orient: "auto",
      });
      const poly = svgEl("polygon", {
        points: "0 0, 8 3.5, 0 7",
        fill: color,
        opacity: dashed ? "0.8" : "1",
      });
      marker.appendChild(poly);
      defs.appendChild(marker);
    };
    mkMarker("fd-arr-allowed", "#0284c7", false);
    mkMarker("fd-arr-forbidden", "#dc2626", true);
    mkMarker("fd-arr-import", "#9ca3af", true);
    svg.appendChild(defs);

    // Edge layer (below nodes)
    const edgeGroup = svgEl("g", { class: "fd-edges" });
    const importGroup = svgEl("g", {
      class: "fd-imports",
      style: "display:none",
    });
    flowImportGroups.set(cyId, importGroup);

    fdEdges.forEach((e) => {
      const src = nodeMap.get(e.source);
      const tgt = nodeMap.get(e.target);
      if (!src || !tgt) return;
      const x1 = src.x + NW,
        y1 = src.y + NH / 2;
      const x2 = tgt.x,
        y2 = tgt.y + NH / 2;
      const dx = (x2 - x1) * 0.45;
      const path = svgEl("path", {
        d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
        fill: "none",
        stroke: e.edgeType === "forbidden" ? "#dc2626" : "#0284c7",
        "stroke-width": "2",
        "stroke-dasharray": e.edgeType === "forbidden" ? "6 3" : "none",
        "marker-end": `url(#fd-arr-${e.edgeType === "forbidden" ? "forbidden" : "allowed"})`,
      });
      edgeGroup.appendChild(path);

      if (e.flowKind && e.flowKind !== "flow") {
        const mx = (x1 + x2) / 2,
          my = (y1 + y2) / 2 - 8;
        const lbl = svgEl("text", {
          x: mx,
          y: my,
          "text-anchor": "middle",
          "font-size": "9",
          fill: "#64748b",
        });
        lbl.textContent = e.flowKind;
        edgeGroup.appendChild(lbl);
      }
    });

    // Import edges (overlay)
    if (overlay && overlay.actualImports.length > 0) {
      overlay.actualImports
        .filter((imp: any) => nodeMap.has(imp.from) && nodeMap.has(imp.to))
        .forEach((imp: any, i: number) => {
          const src = nodeMap.get(imp.from)!;
          const tgt = nodeMap.get(imp.to)!;
          const x1 = src.x + NW,
            y1 = src.y + NH / 2;
          const x2 = tgt.x,
            y2 = tgt.y + NH / 2;
          const dx = (x2 - x1) * 0.45;
          const path = svgEl("path", {
            d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
            fill: "none",
            stroke: "#9ca3af",
            "stroke-width": "1.5",
            "stroke-dasharray": "4 4",
            "marker-end": "url(#fd-arr-import)",
          });
          importGroup.appendChild(path);
        });
    }

    svg.appendChild(edgeGroup);
    svg.appendChild(importGroup);

    // Node layer
    const nodeGroup = svgEl("g", { class: "fd-nodes" });
    const nodeElMap = new Map<string, any>();

    nodeMap.forEach((node) => {
      const g = svgEl("g", {
        "data-fd-node": node.id,
        transform: `translate(${node.x},${node.y})`,
        style: "cursor:default",
      });
      const rect = svgEl("rect", {
        width: NW,
        height: NH,
        rx: "6",
        ry: "6",
        fill: node.isStep ? "#0284c7" : "#f0f9ff",
        stroke: node.isStep ? "#0369a1" : "#7dd3fc",
        "stroke-width": "2",
        class: "fd-node-rect",
      });
      // Truncate label to fit
      const maxChars = 16;
      const label =
        node.label.length > maxChars
          ? node.label.slice(0, maxChars - 1) + "…"
          : node.label;
      const txt = svgEl("text", {
        x: NW / 2,
        y: NH / 2 + 4,
        "text-anchor": "middle",
        "font-size": "10",
        "font-weight": "600",
        fill: node.isStep ? "#fff" : "#0c4a6e",
        "pointer-events": "none",
      });
      txt.textContent = label;

      const title = svgEl("title", {});
      title.textContent = node.id;

      g.appendChild(rect);
      g.appendChild(txt);
      g.appendChild(title);
      nodeGroup.appendChild(g);
      nodeElMap.set(node.id, { g, rect });
    });

    svg.appendChild(nodeGroup);
    container.appendChild(svg);
    flowNodeEls.set(cyId, nodeElMap);
    overlayState.set(cyId, new Set());

    // Wire overlay checkboxes
    document.querySelectorAll(`input[data-cy="${cyId}"]`).forEach((cb: any) => {
      cb.addEventListener("change", () => {
        const state = overlayState.get(cyId) ?? new Set();
        if (cb.checked) state.add(cb.dataset.overlay);
        else state.delete(cb.dataset.overlay);
        overlayState.set(cyId, state);
        applyFlowOverlays(cyId, ruleId, state);
      });
    });
  }

  // Apply/remove CARI overlays on a live SVG flow diagram.
  function applyFlowOverlays(
    cyId: string,
    ruleId: string,
    active: Set<string>,
  ) {
    const nodeElMap = flowNodeEls.get(cyId);
    if (!nodeElMap) return;

    nodeElMap.forEach(({ rect }, name) => {
      // Determine fill/stroke from overlays (priority: violations > hotspot > community > default)
      let fill = "#f0f9ff",
        stroke = "#7dd3fc",
        sw = "2";

      const hot = active.has("hotspot") ? overlay?.hotspot[name] : undefined;
      const hub = active.has("hubs") ? overlay?.hubs[name] : undefined;
      const comm = active.has("communities")
        ? overlay?.communities[name]
        : undefined;

      if (hot) {
        const g = Math.round(255 * (1 - hot.score) * 0.6);
        const b = Math.round(255 * (1 - hot.score) * 0.4);
        fill = `rgb(255,${g},${b})`;
        stroke = hot.score > 0.7 ? "#dc2626" : "#f97316";
      } else if (comm && !active.has("violations")) {
        fill = COMM_PALETTE[comm.id % COMM_PALETTE.length];
        stroke = "#a78bfa";
      }

      if (hub) sw = String(2 + hub.degree * 4);

      if (active.has("violations")) {
        const ruleViols = (data.violations ?? []).filter(
          (v: any) => v.ruleId === ruleId,
        );
        const isViol = ruleViols.some(
          (v: any) =>
            v.filePath.includes(name) || (v.symbol && v.symbol.includes(name)),
        );
        if (isViol) {
          fill = "#fee2e2";
          stroke = "#dc2626";
          sw = "3";
        }
      }

      rect.setAttribute("fill", fill);
      rect.setAttribute("stroke", stroke);
      rect.setAttribute("stroke-width", sw);
    });

    // Toggle import overlay group visibility
    const importGroup = flowImportGroups.get(cyId);
    if (importGroup)
      importGroup.setAttribute(
        "style",
        active.has("imports") ? "display:block" : "display:none",
      );
  }
}
