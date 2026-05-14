// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 17.1 Prescriptive Architecture Report — SVG Renderer
 *
 * Renders a deterministic, top-down "should-be" architecture view:
 * - Layers are drawn top-down (consumers/entrypoints at top)
 * - Allowed edges (derived defaults) in green
 * - Forbidden/violating edges in red
 * - Optional rule-expressed elements inside layer containers
 */

export interface PrescriptiveElementNode {
  name: string;
  kind: "component" | "class" | "method" | "symbol";
  layerName: string;
  ruleId?: string;
  /** Position in the expresses.elements[] array — used for flow-order sorting */
  flowSeq?: number;
}

export interface PrescriptiveLayerNode {
  index: number;
  name: string;
  fileCount: number;
  ruleViolationCount: number;
  elements?: PrescriptiveElementNode[];
  policies?: Array<{
    ruleId: string;
    kind: string;
    count: number;
    description?: string;
    adr?: string;
    severity?: "high" | "medium" | "low";
  }>;
  row?: number;
  column?: number;
  colSpan?: number;
  rowSpan?: number;
  side?: "left" | "right";
}

export interface PrescriptiveEdge {
  fromLayerIndex: number;
  toLayerIndex: number;
  type: "allowed" | "forbidden";
  label: string;
  count?: number;
  flowKind?: "control" | "data" | "hop";
  ruleId?: string;
  description?: string;
  adr?: string;
  severity?: "high" | "medium" | "low";
  fromElementName?: string;
  toElementName?: string;
}

export interface PrescriptiveRuleSummary {
  id: string;
  severity: "high" | "medium" | "low";
  description?: string;
  adr?: string;
  count: number;
}

/** One rule violation (top N per rule, for the architecture book violations chapter). */
export interface PrescriptiveViolation {
  ruleId: string;
  severity: "high" | "medium" | "low";
  /** Intent domain — "structural", "behavioral", or "documentary" (Phase 3) */
  ruleDomain?: "structural" | "behavioral" | "documentary";
  /** Enforcement mode — "error" or "warn" (Phase 3) */
  ruleMode?: "error" | "warn";
  /** Confidence score 0–1 (Phase 3, behavioral rules) */
  confidence?: number;
  filePath: string;
  line: number | null;
  symbol?: string | null;
  detail: string;
}

/** Per-element CARI overlay data (18.1b). */
export interface PrescriptiveCariOverlay {
  /** element name → churn priority score (0..1 normalised) + raw values */
  hotspot: Record<string, { score: number; churn: number; coverage: number }>;
  /** element name → total hub degree */
  hubs: Record<string, { degree: number }>;
  /** element name → community id + label */
  communities: Record<string, { id: number; label: string }>;
  /** Actual import edges between flow-element files (for the import overlay) */
  actualImports: Array<{ from: string; to: string }>;
}

/** Per-layer coverage data for the Coverage chapter (18.3). */
export interface PrescriptiveLayerCoverage {
  layerIndex: number;
  layerName: string;
  fileCount: number;
  /** Weighted average doc coverage % across all modules in this layer */
  coveragePercent: number;
  rulesGoverning: string[];
  /** Top 5 hotspot files in this layer */
  hotspotFiles: Array<{ filePath: string; churn: number; score: number }>;
}

export interface PrescriptiveReportData {
  meta: {
    generated: string;
    totalFiles: number;
    totalRuleViolations: number;
    totalLayerViolations: number;
  };
  layers: PrescriptiveLayerNode[];
  edges: PrescriptiveEdge[];
  rules: PrescriptiveRuleSummary[];
  /** Top violations (up to 50 per rule) — used by the architecture book. */
  violations?: PrescriptiveViolation[];
  /** CARI overlay data for per-ADR Cytoscape chapters (18.1b). */
  cariOverlay?: PrescriptiveCariOverlay;
  /** Per-layer coverage data for the Coverage chapter (18.3). */
  layerCoverage?: PrescriptiveLayerCoverage[];
  options?: {
    showRuleElements?: boolean;
  };
}

// ── Analytics chapters data (§18 Insights Book) ──────────────────────────────

export interface InsightsCodeHealth {
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
}

export interface InsightsHotspots {
  priorities: Array<{
    filePath: string;
    churn: number;
    coveragePercent: number;
    priorityScore: number;
    totalExportedSymbols: number;
  }>;
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
}

export interface InsightsDocumentation {
  orphanedSections: Array<{
    docPath: string;
    heading: string;
    line: number;
    ungroundedMentions: number;
  }>;
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
  /** Overall codebase symbol coverage across all docs combined */
  docCoverageAggregate?: { coveredSymbols: number; totalSymbols: number };
}

export interface InsightsLivingScore {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  specCoverage: { score: number; available: boolean; detail: string };
  constraintConsistency: { score: number; available: boolean; detail: string };
  docFreshness: { score: number; available: boolean; detail: string };
  archConformance: { score: number; available: boolean; detail: string };
}

export interface InsightsRuleCatalogEntry {
  id: string;
  description?: string;
  adr?: string;
  severity: "high" | "medium" | "low";
  domain?: "structural" | "behavioral" | "documentary";
  mode?: "error" | "warn";
  sourceType?: "mermaid_inline" | "mermaid_file";
  sourceFile?: string;
  sourceBlockId?: string;
  mermaid?: string;
  forbidden?: unknown[];
}

export interface InsightsRulesCatalog {
  configPath?: string;
  rawYaml?: string;
  rules: InsightsRuleCatalogEntry[];
}

/** One resolved annotation entry: a mention in a doc that maps to a code symbol. */
export interface InsightsDocAnnotation {
  symbolName: string;
  symbolKind: string;
  symbolFile: string;
  symbolLine: number;
  confidence: number;
  /** Line number in the documentation file (1-based) */
  docLine: number;
  /** The matched span text as it appears in the source (or normalized form) */
  text: string;
  /** Annotation source: 'code-span' | 'bold' | 'identifier' | 'heading' | 'dictionary' */
  source: string;
}

/** Aggregated data for one indexed documentation file. */
export interface InsightsDocEntry {
  /** Workspace-relative path, e.g. "docs/API.md" */
  path: string;
  /** Raw markdown content (capped at 600 lines for large files) */
  content: string;
  /** Number of unique code symbols referenced in this document */
  uniqueSymbols: number;
  /** Number of distinct source files referenced */
  uniqueSourceFiles: number;
  /** Package/app prefixes referenced (e.g. "packages/index", "apps/server") */
  referencedPackages: string[];
  /** Quality-filtered annotations for inline highlighting (code-span, bold, identifier; conf ≥ 0.5) */
  topAnnotations: InsightsDocAnnotation[];
}

/** A code symbol that appears in multiple documentation files — a "hot" cross-cutting concept. */
export interface InsightsDocHotSymbol {
  name: string;
  kind: string;
  /** Source file path */
  file: string;
  /** Number of documentation files that mention this symbol */
  docCount: number;
  /** Paths of those documentation files */
  docs: string[];
}

/** Documentation Map chapter data — connects indexed docs to code via CARI annotations. */
export interface InsightsDocMap {
  /** All indexed doc entries with annotation data, sorted by uniqueSymbols desc */
  docs: InsightsDocEntry[];
  /** Total number of annotation rows in the index */
  totalAnnotations: number;
  /** Symbols mentioned in 3+ doc files (cross-cutting concepts) */
  hotSymbols: InsightsDocHotSymbol[];
  /** Source files referenced by links in the docs (workspace-relative path → raw content) */
  sourceFiles: Record<string, string>;
}

/** Extended data type for the Insights Book — superset of PrescriptiveReportData. */
export interface InsightsBookData extends PrescriptiveReportData {
  codeHealth?: InsightsCodeHealth;
  hotspots?: InsightsHotspots;
  documentation?: InsightsDocumentation;
  livingScore?: InsightsLivingScore;
  rulesCatalog?: InsightsRulesCatalog;
  /** CARI-powered doc→code interconnection map (Documentation Map chapter) */
  docMap?: InsightsDocMap;
}

declare const DATA: PrescriptiveReportData;
declare const document: any;

export function renderPrescriptiveReportHtml(
  data: PrescriptiveReportData,
): string {
  // Prevent embedded '</script>' in data strings from terminating this script tag.
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prescriptive Architecture Report</title>
<style>
${CSS}
</style>
</head>
<body>
<header>
  <div class="title-wrap">
    <h1>Prescriptive Architecture Report</h1>
    <p class="subtitle">Should-be view (SVG, top-down layers)</p>
  </div>
  <div class="stats" id="stats"></div>
</header>
<main>
  <svg id="viz" role="img" aria-label="Prescriptive architecture visualization"></svg>
  <aside id="rules">
    <h2>Rules</h2>
    <div id="rules-list"></div>
  </aside>
</main>
<script>
const DATA = ${json};
${clientScript.toString()}
clientScript();
</script>
</body>
</html>`;
}

const CSS = `
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  background: #f7f9fc;
  color: #1f2937;
}
header {
  border-bottom: 1px solid #d8dee9;
  background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
  padding: 14px 18px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}
.title-wrap h1 {
  margin: 0;
  font-size: 18px;
}
.subtitle {
  margin: 4px 0 0;
  color: #5b6576;
  font-size: 12px;
}
.stats {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #4b5563;
  flex-wrap: wrap;
}
main {
  display: grid;
  grid-template-columns: 1fr 320px;
  height: calc(100vh - 74px);
}
#viz {
  width: 100%;
  height: 100%;
  background: radial-gradient(circle at 8% 8%, #ffffff 0%, #f4f8ff 55%, #eef3fb 100%);
}
#rules {
  border-left: 1px solid #d8dee9;
  padding: 14px;
  background: #f9fbff;
  overflow-y: auto;
}
#rules h2 {
  margin: 0 0 10px;
  font-size: 14px;
}
.rule-item {
  border: 1px solid #dbe3ef;
  border-radius: 8px;
  background: #fff;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.rule-id {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 2px;
}
.rule-meta {
  font-size: 11px;
  color: #5b6576;
}
.rule-desc {
  font-size: 10px;
  color: #6b7280;
  margin-top: 3px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.badge.high { background: #fee2e2; color: #991b1b; }
.badge.medium { background: #fef3c7; color: #92400e; }
.badge.low { background: #e5e7eb; color: #374151; }
.layer-title {
  font-size: 13px;
  font-weight: 700;
  fill: #111827;
}
.layer-meta {
  font-size: 11px;
  fill: #4b5563;
}
.edge-label {
  font-size: 10px;
  fill: #334155;
}
.edge-label.rule-flow {
  fill: #1f2937;
  font-weight: 600;
}
.element-chip {
  font-size: 10px;
  fill: #334155;
}
`;

function clientScript() {
  const data = DATA;
  const svg = document.getElementById("viz");
  const rulesList = document.getElementById("rules-list");
  const stats = document.getElementById("stats");

  // ── Tooltip (chip hover) ──────────────────────────────────────────────────
  const tooltip = document.createElement("div");
  tooltip.id = "iw-tooltip";
  tooltip.style.cssText =
    "position:fixed;pointer-events:none;z-index:9999;display:none;" +
    "background:#1e2533;color:#e2e8f0;border-radius:8px;padding:8px 12px;" +
    "font-size:11px;max-width:340px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,0.35);" +
    "border:1px solid #334155;white-space:pre-wrap;";
  document.body.appendChild(tooltip);
  function showTooltip(ev: any, html: string) {
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
    positionTooltip(ev);
  }
  function positionTooltip(ev: any) {
    const x = ev.clientX + 14,
      y = ev.clientY + 14;
    const vw = (globalThis as any).window?.innerWidth ?? 1920;
    const vh = (globalThis as any).window?.innerHeight ?? 1080;
    tooltip.style.left =
      (x + tooltip.offsetWidth > vw ? vw - tooltip.offsetWidth - 8 : x) + "px";
    tooltip.style.top =
      (y + tooltip.offsetHeight > vh ? y - tooltip.offsetHeight - 20 : y) +
      "px";
  }
  function hideTooltip() {
    tooltip.style.display = "none";
  }

  // ── Edge info panel (E) — fixed card, populated on edge hover ────────────
  const edgePanel = document.createElement("div");
  edgePanel.id = "iw-edge-panel";
  edgePanel.style.cssText =
    "position:fixed;bottom:16px;left:16px;z-index:9998;width:290px;" +
    "background:#fff;border:1px solid #d1d5db;border-radius:10px;" +
    "padding:10px 14px;font-size:11px;line-height:1.5;" +
    "box-shadow:0 4px 20px rgba(0,0,0,0.10);pointer-events:none;opacity:0.7;" +
    "transition:opacity 0.12s;";
  edgePanel.innerHTML =
    "<span style='color:#9ca3af;font-style:italic'>Hover an edge\u2026</span>";
  document.body.appendChild(edgePanel);
  function showEdgePanel(edge: any) {
    const isAllow = edge.type === "allowed";
    const bg = isAllow ? "#dcfce7" : "#fee2e2",
      fg = isAllow ? "#166534" : "#991b1b";
    let h =
      "<div style='font-weight:700;font-size:12px;margin-bottom:3px'>" +
      (edge.ruleId ?? "Edge") +
      " &nbsp;<span style='display:inline-block;padding:1px 7px;border-radius:9px;font-size:9px;" +
      "font-weight:700;background:" +
      bg +
      ";color:" +
      fg +
      "'>" +
      edge.type.toUpperCase() +
      "</span></div>";
    if (edge.severity)
      h +=
        "<div style='color:#6b7280;font-size:10px'>Severity: <b>" +
        edge.severity.toUpperCase() +
        "</b></div>";
    if (edge.adr)
      h +=
        "<div style='color:#6b7280;font-size:10px'>ADR: " + edge.adr + "</div>";
    h += "<div style='margin-top:4px;color:#374151'>" + edge.label + "</div>";
    if (edge.count != null)
      h +=
        "<div style='color:#6b7280;font-size:10px'>Violations: <b>" +
        edge.count +
        "</b></div>";
    if (edge.fromElementName)
      h +=
        "<div style='color:#92400e;font-size:10px'>\u21b3 Scope: " +
        edge.fromElementName +
        "</div>";
    if (edge.toElementName)
      h +=
        "<div style='color:#991b1b;font-size:10px'>\u21b3 Target: " +
        edge.toElementName +
        "</div>";
    if (edge.description)
      h +=
        "<div style='margin-top:6px;color:#4b5563;border-top:1px solid #e5e7eb;" +
        "padding-top:5px;font-size:10px'>" +
        edge.description.trim() +
        "</div>";
    edgePanel.innerHTML = h;
    edgePanel.style.opacity = "1";
  }
  function clearEdgePanel() {
    edgePanel.innerHTML =
      "<span style='color:#9ca3af;font-style:italic'>Hover an edge\u2026</span>";
    edgePanel.style.opacity = "0.7";
    edgePanel.style.width = "290px";
    edgePanel.style.maxWidth = "";
  }

  // ── Rule-element edge toggle ─────────────────────────────────────────────
  let showAllRuleElementEdges = false;
  let refreshRuleElementOverlay: (() => void) | null = null;
  const edgeToggle = document.createElement("label");
  edgeToggle.style.cssText =
    "position:fixed;bottom:122px;left:16px;z-index:9998;display:flex;align-items:center;gap:8px;" +
    "background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:8px 10px;" +
    "font-size:11px;color:#374151;box-shadow:0 4px 20px rgba(0,0,0,0.10);";
  edgeToggle.innerHTML =
    "<input id='iw-rule-edge-toggle' type='checkbox' style='margin:0'/>" +
    "<span>Show all rule-element edges</span>";
  document.body.appendChild(edgeToggle);
  const edgeToggleInput = edgeToggle.querySelector(
    "#iw-rule-edge-toggle",
  ) as any;
  if (edgeToggleInput) {
    edgeToggleInput.addEventListener("change", () => {
      showAllRuleElementEdges = Boolean(edgeToggleInput.checked);
      refreshRuleElementOverlay?.();
    });
  }

  // ── Pan/zoom ──────────────────────────────────────────────────────────────
  let vpX = 0,
    vpY = 0,
    vpScale = 1;
  let panActive = false,
    panStartX = 0,
    panStartY = 0;
  let panGroup: any = null;
  function applyTransform() {
    if (panGroup)
      panGroup.setAttribute(
        "transform",
        "translate(" + vpX + "," + vpY + ") scale(" + vpScale + ")",
      );
  }
  svg.addEventListener(
    "wheel",
    (ev: any) => {
      ev.preventDefault();
      const delta = ev.deltaY < 0 ? 1.1 : 0.909;
      const rect = svg.getBoundingClientRect();
      const mx = ev.clientX - rect.left,
        my = ev.clientY - rect.top;
      vpX = mx - (mx - vpX) * delta;
      vpY = my - (my - vpY) * delta;
      vpScale = Math.min(4, Math.max(0.15, vpScale * delta));
      applyTransform();
    },
    { passive: false },
  );
  svg.addEventListener("mousedown", (ev: any) => {
    if (ev.button !== 0) return;
    panActive = true;
    panStartX = ev.clientX - vpX;
    panStartY = ev.clientY - vpY;
    svg.style.cursor = "grabbing";
    hideTooltip();
  });
  document.addEventListener("mousemove", (ev: any) => {
    if (!panActive) return;
    vpX = ev.clientX - panStartX;
    vpY = ev.clientY - panStartY;
    applyTransform();
  });
  document.addEventListener("mouseup", () => {
    panActive = false;
    svg.style.cursor = "";
  });

  // ── Collapse state (D) — survives build() calls ───────────────────────────
  const collapsedSections = new Map<string, boolean>();

  // ── Glob-pattern guard ─────────────────────────────────────────────────────
  // File-scope selectors (e.g. "packages/@arccraft/adapters/src/**") are rule
  // implementation details, not named architectural concepts. Filter them out
  // of all chip-render paths so only human-readable names remain visible.
  function isGlobPattern(name: string): boolean {
    return name.includes("*") || name.includes("/");
  }

  // ── Pre-compute forbidden anchor maps ────────────────────────────────────
  type AnchorItem = { name: string; kind: string };
  const forbiddenFromByLayer = new Map<number, AnchorItem[]>();
  const forbiddenToByLayer = new Map<number, AnchorItem[]>();
  data.edges.forEach((edge) => {
    if (edge.type !== "forbidden" || edge.fromLayerIndex === edge.toLayerIndex)
      return;
    const edgeKind = (edge.label ?? "").split(" ")[0] || "import_pattern";
    if (edge.fromElementName && !isGlobPattern(edge.fromElementName)) {
      const arr = forbiddenFromByLayer.get(edge.fromLayerIndex) ?? [];
      if (!arr.some((a: AnchorItem) => a.name === edge.fromElementName))
        arr.push({ name: edge.fromElementName, kind: edgeKind });
      forbiddenFromByLayer.set(edge.fromLayerIndex, arr);
    }
    if (edge.toElementName && !isGlobPattern(edge.toElementName)) {
      const arr = forbiddenToByLayer.get(edge.toLayerIndex) ?? [];
      if (!arr.some((a: AnchorItem) => a.name === edge.toElementName))
        arr.push({ name: edge.toElementName, kind: edgeKind });
      forbiddenToByLayer.set(edge.toLayerIndex, arr);
    }
  });

  // ── SVG element factory ───────────────────────────────────────────────────
  function mk(tag: string, attrs: Record<string, unknown> = {}) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  // ── Fixed visual constants ────────────────────────────────────────────────
  const BAND_PALETTE = [
    { bg: "#eff6ff", slab: "#dbeafe", border: "#93c5fd", text: "#1e40af" },
    { bg: "#f0fdf4", slab: "#dcfce7", border: "#86efac", text: "#166534" },
    { bg: "#fff7ed", slab: "#fed7aa", border: "#fdba74", text: "#9a3412" },
    { bg: "#fdf4ff", slab: "#f3e8ff", border: "#d8b4fe", text: "#6b21a8" },
    { bg: "#fef2f2", slab: "#fecaca", border: "#fca5a5", text: "#991b1b" },
    { bg: "#ecfdf5", slab: "#a7f3d0", border: "#6ee7b7", text: "#065f46" },
    { bg: "#fffbeb", slab: "#fde68a", border: "#fcd34d", text: "#92400e" },
  ];
  const LABEL_W = 124;
  const CHIP_H = 26;
  const CHIP_GAP = 6;
  const CHIP_PADX = 10;
  const SEC_H = 18;
  const rowGap = 28;
  const colGap = 24;
  const GCW = 300;
  const LANE_W = 16;

  const fallbackTopDown = [...data.layers].sort((a, b) => b.index - a.index);
  const fallbackRowByLI = new Map<number, number>();
  fallbackTopDown.forEach((l, i) => fallbackRowByLI.set(l.index, i));

  const hasGeometry = data.layers.some(
    (l) =>
      typeof l.row === "number" ||
      typeof l.column === "number" ||
      typeof l.colSpan === "number" ||
      typeof l.rowSpan === "number" ||
      l.side === "left" ||
      l.side === "right",
  );

  // ── Content height (respects D collapse state) ────────────────────────────
  function contentHeightFor(layer: PrescriptiveLayerNode, bw: number): number {
    const pItems = Array.isArray(layer.policies) ? layer.policies : [];
    const toA = (forbiddenToByLayer.get(layer.index) ?? []) as AnchorItem[];
    const fromA = (forbiddenFromByLayer.get(layer.index) ?? []) as AnchorItem[];
    const cw = bw - LABEL_W - CHIP_PADX * 2;
    const pr = Math.max(1, Math.floor((cw + CHIP_GAP) / (160 + CHIP_GAP)));
    const polC =
      collapsedSections.get(String(layer.index) + ":policies") ?? false;
    const ancC =
      collapsedSections.get(String(layer.index) + ":anchors") ?? false;
    let h = 14;
    if (pItems.length > 0) {
      h += SEC_H + 4;
      if (!polC)
        h += Math.ceil(Math.min(pItems.length, 9) / pr) * (CHIP_H + 4) + 4;
    }
    if (toA.length > 0 || fromA.length > 0) {
      h += SEC_H + 4;
      if (!ancC) {
        if (toA.length > 0)
          h += Math.ceil(Math.min(toA.length, 4) / pr) * (CHIP_H + 4);
        if (fromA.length > 0)
          h += Math.ceil(Math.min(fromA.length, 2) / pr) * (CHIP_H + 4) + 4;
      }
    }
    if (
      data.options?.showRuleElements &&
      Array.isArray(layer.elements) &&
      layer.elements.length > 0
    ) {
      const namedEls = (layer.elements as any[]).filter(
        (e) => !isGlobPattern(String(e.name)),
      );
      if (namedEls.length > 0) {
        // One row per unique ruleId group + section header
        const uniqueRules = new Set(
          namedEls.map((e: any) => String(e.ruleId ?? "")),
        );
        h += SEC_H + 4 + uniqueRules.size * (CHIP_H + 10) + 4;
      }
    }
    return Math.max(56, h);
  }

  // Classify edge as same-row (horizontal gap) vs cross-row (gutter) using
  // layer.row metadata so we can pre-count gutter edges before layout.
  function isSameRow(edge: any): boolean {
    const fl = data.layers.find((l) => l.index === edge.fromLayerIndex);
    const tl = data.layers.find((l) => l.index === edge.toLayerIndex);
    if (!fl || !tl) return false;
    const fr =
      typeof fl.row === "number"
        ? fl.row
        : (fallbackRowByLI.get(fl.index) ?? 0);
    const tr =
      typeof tl.row === "number"
        ? tl.row
        : (fallbackRowByLI.get(tl.index) ?? 0);
    return fr === tr;
  }

  // ── Main build function (re-runs on section toggle) ───────────────────────
  function build() {
    const preferredWidth = Math.max(1200, svg.clientWidth || 1200);
    type LayerPlacement = {
      layer: PrescriptiveLayerNode;
      row: number;
      column: number;
      colSpan: number;
      rowSpan: number;
    };
    let placements: LayerPlacement[] = [];

    if (hasGeometry) {
      const raw = data.layers.map((layer) => ({
        layer,
        row:
          typeof layer.row === "number"
            ? layer.row
            : (fallbackRowByLI.get(layer.index) ?? 0),
        column: typeof layer.column === "number" ? layer.column : 0,
        colSpan: Math.max(1, layer.colSpan ?? 1),
        rowSpan: Math.max(1, layer.rowSpan ?? 1),
        side: layer.side,
      }));
      const regular = raw.filter(
        (p) => p.side !== "left" && p.side !== "right",
      );
      const minRC =
        regular.length > 0
          ? Math.min(...regular.map((p) => p.column))
          : Math.min(...raw.map((p) => p.column));
      const maxRC =
        regular.length > 0
          ? Math.max(...regular.map((p) => p.column + p.colSpan - 1))
          : Math.max(...raw.map((p) => p.column + p.colSpan - 1));
      const totalCols = maxRC - minRC + 1;
      placements = raw.map((p) => {
        if (p.side === "left") return { ...p, column: minRC - 1 };
        if (p.side === "right") return { ...p, column: maxRC + 1 };
        if (
          typeof p.layer.column !== "number" &&
          p.colSpan === 1 &&
          totalCols > 1
        ) {
          const rm = raw.filter(
            (q) =>
              q !== p &&
              q.side !== "left" &&
              q.side !== "right" &&
              q.row === p.row,
          );
          if (rm.length === 0) return { ...p, colSpan: totalCols };
        }
        return p;
      });
      const minCol = Math.min(...placements.map((p) => p.column));
      const minRow = Math.min(...placements.map((p) => p.row));
      placements = placements.map((p) => ({
        ...p,
        row: p.row - minRow,
        column: p.column - minCol,
      }));
    } else {
      placements = fallbackTopDown.map((layer, idx) => ({
        layer,
        row: idx,
        column: 0,
        colSpan: 1,
        rowSpan: 1,
      }));
    }

    // Pre-count cross-row edges to size gutters
    const nAllowedCross = data.edges.filter(
      (e) => e.type === "allowed" && !isSameRow(e),
    ).length;
    const nForbiddenCross = data.edges.filter(
      (e) => e.type === "forbidden" && !isSameRow(e),
    ).length;
    // Left gutter holds allowed edges; right gutter holds forbidden edges
    const lGutter = Math.max(nAllowedCross, 1) * LANE_W + 24;
    const bandBaseLeft = Math.max(100, lGutter);

    // Band widths
    const placementBandW = new Map<number, number>();
    placements.forEach((p) => {
      placementBandW.set(
        p.layer.index,
        hasGeometry
          ? p.colSpan * GCW + Math.max(0, p.colSpan - 1) * colGap
          : Math.min(940, preferredWidth - bandBaseLeft - 60),
      );
    });

    // Band heights (dynamic, respects collapse)
    const layerBandH = new Map<number, number>();
    placements.forEach((p) => {
      layerBandH.set(
        p.layer.index,
        contentHeightFor(p.layer, placementBandW.get(p.layer.index) ?? GCW),
      );
    });

    // Per-row max heights
    const rowHMap = new Map<number, number>();
    placements.forEach((p) => {
      const lh = layerBandH.get(p.layer.index) ?? 56;
      for (let r = p.row; r < p.row + p.rowSpan; r++)
        rowHMap.set(
          r,
          Math.max(rowHMap.get(r) ?? 0, p.rowSpan === 1 ? lh : 56),
        );
    });

    // Row Y positions
    const rowYs = new Map<number, number>();
    let yc = 30;
    const nRows = rowHMap.size > 0 ? Math.max(...rowHMap.keys()) + 1 : 1;
    for (let r = 0; r < nRows; r++) {
      rowYs.set(r, yc);
      yc += (rowHMap.get(r) ?? 56) + rowGap;
    }
    const totalHeight = yc - rowGap + 40;

    // Eager layer positions (needed for port stagger before band rendering)
    const layerPositions = new Map<
      number,
      { x: number; y: number; w: number; h: number }
    >();
    placements.forEach((p) => {
      const bw = placementBandW.get(p.layer.index) ?? GCW;
      const lx = hasGeometry
        ? bandBaseLeft + p.column * (GCW + colGap)
        : Math.floor((preferredWidth - bw) / 2);
      const ly = rowYs.get(p.row) ?? yc;
      let bh = 0;
      for (let r = p.row; r < p.row + p.rowSpan; r++)
        bh += rowHMap.get(r) ?? 56;
      bh += Math.max(0, p.rowSpan - 1) * rowGap;
      layerPositions.set(p.layer.index, { x: lx, y: ly, w: bw, h: bh });
    });

    // ── Port stagger (C) ─────────────────────────────────────────────────────
    // Sort cross-row edges for deterministic lane/slot order (by source row then target row)
    function sortCross(arr: any[]) {
      return arr.slice().sort((a, b) => {
        const sa = layerPositions.get(a.fromLayerIndex),
          sb = layerPositions.get(b.fromLayerIndex);
        if (!sa || !sb || sa.y !== sb.y) return (sa?.y ?? 0) - (sb?.y ?? 0);
        return (
          (layerPositions.get(a.toLayerIndex)?.y ?? 0) -
          (layerPositions.get(b.toLayerIndex)?.y ?? 0)
        );
      });
    }
    const sortedAllowed = sortCross(
      data.edges.filter((e) => e.type === "allowed" && !isSameRow(e)),
    );
    const sortedForbidden = sortCross(
      data.edges.filter((e) => e.type === "forbidden" && !isSameRow(e)),
    );

    // Per-layer outgoing/incoming slot lists for port Y stagger
    const outA = new Map<number, number[]>(),
      incA = new Map<number, number[]>();
    const outF = new Map<number, number[]>(),
      incF = new Map<number, number[]>();
    sortedAllowed.forEach((e, i) => {
      const o = outA.get(e.fromLayerIndex) ?? [];
      o.push(i);
      outA.set(e.fromLayerIndex, o);
      const t = incA.get(e.toLayerIndex) ?? [];
      t.push(i);
      incA.set(e.toLayerIndex, t);
    });
    sortedForbidden.forEach((e, i) => {
      const o = outF.get(e.fromLayerIndex) ?? [];
      o.push(i);
      outF.set(e.fromLayerIndex, o);
      const t = incF.get(e.toLayerIndex) ?? [];
      t.push(i);
      incF.set(e.toLayerIndex, t);
    });
    const PORT_ZONE = 0.18;
    function portY(
      layerIdx: number,
      laneIdx: number,
      isOut: boolean,
      isForbidden: boolean,
    ): number {
      const pos = layerPositions.get(layerIdx);
      if (!pos) return 0;
      const map = isForbidden ? (isOut ? outF : incF) : isOut ? outA : incA;
      const arr = map.get(layerIdx) ?? [];
      const i = arr.indexOf(laneIdx),
        n = arr.length;
      const zoneTop = pos.y + pos.h * PORT_ZONE,
        zoneH = pos.h * (1 - 2 * PORT_ZONE);
      return n <= 1 ? pos.y + pos.h / 2 : zoneTop + (i / (n - 1)) * zoneH;
    }

    // Gutter X positions
    const maxBandRight = Math.max(
      ...[...layerPositions.values()].map((v) => v.x + v.w),
      0,
    );
    const LGUTTER_X0 = 4;
    const RGUTTER_X0 = maxBandRight + 12;
    const svgWidth = Math.max(
      preferredWidth,
      RGUTTER_X0 + Math.max(nForbiddenCross, 1) * LANE_W + 40,
    );

    // ── SVG setup ──────────────────────────────────────────────────────────
    svg.setAttribute("viewBox", "0 0 " + svgWidth + " " + totalHeight);
    svg.setAttribute("style", "cursor:grab;");
    svg.innerHTML = "";
    panGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    panGroup.setAttribute("id", "pan-group");
    svg.appendChild(panGroup);

    const defs = mk("defs");
    const mA = mk("marker", {
      id: "arrow-allowed",
      viewBox: "0 0 10 10",
      refX: "8",
      refY: "5",
      markerWidth: "7",
      markerHeight: "7",
      orient: "auto-start-reverse",
    });
    mA.appendChild(mk("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#1f8f4e" }));
    const mF = mk("marker", {
      id: "arrow-forbidden",
      viewBox: "0 0 10 10",
      refX: "8",
      refY: "5",
      markerWidth: "7",
      markerHeight: "7",
      orient: "auto-start-reverse",
    });
    mF.appendChild(mk("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#c53030" }));
    defs.appendChild(mA);
    defs.appendChild(mF);
    panGroup.appendChild(defs);

    // Faint gutter rail lines
    sortedAllowed.forEach((_, i) => {
      const lx =
        LGUTTER_X0 + (sortedAllowed.length - 1 - i) * LANE_W + LANE_W / 2;
      panGroup.appendChild(
        mk("line", {
          x1: lx,
          y1: 20,
          x2: lx,
          y2: totalHeight - 20,
          stroke: "#1f8f4e",
          "stroke-width": "0.5",
          opacity: "0.12",
          "stroke-dasharray": "3 5",
        }),
      );
    });
    sortedForbidden.forEach((_, i) => {
      const lx = RGUTTER_X0 + i * LANE_W + LANE_W / 2;
      panGroup.appendChild(
        mk("line", {
          x1: lx,
          y1: 20,
          x2: lx,
          y2: totalHeight - 20,
          stroke: "#c53030",
          "stroke-width": "0.5",
          opacity: "0.12",
          "stroke-dasharray": "3 5",
        }),
      );
    });

    // Build element-edge index for hover-revealed explicit element connections.
    // Keys are "<layerIndex>::<elementName>".
    const elementEdgePairs = data.edges
      .filter((e) => !!e.fromElementName && !!e.toElementName)
      .map((e) => ({
        edge: e,
        fromKey: String(e.fromLayerIndex) + "::" + String(e.fromElementName),
        toKey: String(e.toLayerIndex) + "::" + String(e.toElementName),
      }));

    // Additional rule-based connectivity: elements that share a ruleId are related.
    const keyRuleIds = new Map<string, Set<string>>();
    const ruleMemberKeys = new Map<string, Set<string>>();
    const ruleTypeById = new Map<string, "allowed" | "forbidden">();
    data.layers.forEach((layer) => {
      (layer.elements ?? []).forEach((el) => {
        if (!el?.name || !el.ruleId) return;
        const key = String(layer.index) + "::" + String(el.name);
        const rs = keyRuleIds.get(key) ?? new Set<string>();
        rs.add(String(el.ruleId));
        keyRuleIds.set(key, rs);
        const ms = ruleMemberKeys.get(String(el.ruleId)) ?? new Set<string>();
        ms.add(key);
        ruleMemberKeys.set(String(el.ruleId), ms);
      });
    });
    data.edges.forEach((e) => {
      if (!e.ruleId) return;
      const rid = String(e.ruleId);
      const prev = ruleTypeById.get(rid);
      if (!prev) {
        ruleTypeById.set(rid, e.type);
      } else if (prev !== e.type) {
        // Prefer forbidden style if mixed.
        ruleTypeById.set(rid, "forbidden");
      }
    });

    // Build a map of ruleId → all elements (cross-layer) for the flow panel.
    const rulesWithFlows = new Set<string>();
    const flowElementsByRule = new Map<
      string,
      Array<{
        name: string;
        kind: string;
        layerName: string;
        flowSeq: number;
        layerIndex: number;
      }>
    >();
    data.layers.forEach((layer) => {
      (layer.elements ?? []).forEach((el: any) => {
        if (!el?.ruleId || isGlobPattern(String(el.name))) return;
        const rid = String(el.ruleId);
        rulesWithFlows.add(rid);
        const arr = flowElementsByRule.get(rid) ?? [];
        arr.push({
          name: String(el.name),
          kind: String(el.kind),
          layerName: layer.name,
          flowSeq: el.flowSeq ?? 999,
          layerIndex: layer.index,
        });
        flowElementsByRule.set(rid, arr);
      });
    });

    // ── Flow Panel renderer ───────────────────────────────────────────────────
    function showFlowPanel(ruleId: string) {
      const allEls = (flowElementsByRule.get(ruleId) ?? [])
        .slice()
        .sort((a, b) => a.flowSeq - b.flowSeq);
      if (allEls.length === 0) return;
      const flowEdges = data.edges.filter(
        (e) =>
          e.ruleId === ruleId &&
          e.fromElementName &&
          e.toElementName &&
          !isGlobPattern(String(e.fromElementName)) &&
          !isGlobPattern(String(e.toElementName)),
      );
      const n = allEls.length;
      // Layout: horizontal if ≤6, else vertical
      const horizontal = n <= 6;
      const NODE_W = 110,
        NODE_H = 32,
        ARROW = 30,
        PAD = 12;
      const svgW = horizontal
        ? n * NODE_W + (n - 1) * ARROW + PAD * 2
        : NODE_W + PAD * 2;
      const svgH = horizontal
        ? NODE_H + 30
        : n * NODE_H + (n - 1) * ARROW + PAD * 2;
      let s = `<defs><marker id='fp-a' viewBox='0 0 10 10' refX='8' refY='5' markerWidth='5' markerHeight='5' orient='auto-start-reverse'>`;
      s += `<path d='M 0 0 L 10 5 L 0 10 z' fill='#0284c7'/></marker>`;
      s += `<marker id='fp-af' viewBox='0 0 10 10' refX='8' refY='5' markerWidth='5' markerHeight='5' orient='auto-start-reverse'>`;
      s += `<path d='M 0 0 L 10 5 L 0 10 z' fill='#dc2626'/></marker></defs>`;
      allEls.forEach((el, i) => {
        const nx = horizontal ? PAD + i * (NODE_W + ARROW) : PAD;
        const ny = horizontal ? 0 : PAD + i * (NODE_H + ARROW);
        const shortLayer = el.layerName.replace(/^(packages|apps)\//, "");
        s += `<rect x='${nx}' y='${ny}' width='${NODE_W}' height='${NODE_H}' rx='6' fill='#f0f9ff' stroke='#7dd3fc' stroke-width='1.5'/>`;
        if (el.flowSeq < 999) {
          s += `<circle cx='${nx + 13}' cy='${ny + NODE_H / 2}' r='8' fill='#0284c7'/>`;
          s += `<text x='${nx + 13}' y='${ny + NODE_H / 2 + 4}' text-anchor='middle' font-size='8' font-weight='700' fill='#fff'>${el.flowSeq + 1}</text>`;
        }
        const lx = nx + (el.flowSeq < 999 ? 27 : 8);
        const maxCh = Math.floor((NODE_W - (el.flowSeq < 999 ? 34 : 12)) / 6);
        const dn =
          el.name.length > maxCh
            ? el.name.slice(0, maxCh - 1) + "\u2026"
            : el.name;
        s += `<text x='${lx}' y='${ny + NODE_H / 2 + 4}' font-size='8.5' font-weight='600' fill='#0c4a6e'>${dn}</text>`;
        const layMaxCh = Math.floor(NODE_W / 6);
        const dl =
          shortLayer.length > layMaxCh
            ? shortLayer.slice(0, layMaxCh - 1) + "\u2026"
            : shortLayer;
        if (horizontal) {
          s += `<text x='${nx + NODE_W / 2}' y='${ny + NODE_H + 12}' text-anchor='middle' font-size='7' fill='#64748b'>${dl}</text>`;
        } else {
          s += `<text x='${nx + NODE_W + 4}' y='${ny + NODE_H / 2 + 3}' font-size='7' fill='#64748b'>${dl}</text>`;
        }
        if (i < allEls.length - 1) {
          const edge = flowEdges.find(
            (e) =>
              e.fromElementName === el.name &&
              e.toElementName === allEls[i + 1].name,
          );
          const ec = edge?.type === "forbidden" ? "#dc2626" : "#0284c7";
          const da =
            edge?.flowKind === "data"
              ? "2 3"
              : edge?.type === "forbidden"
                ? "4 3"
                : "0";
          const mk2 = edge?.type === "forbidden" ? "url(#fp-af)" : "url(#fp-a)";
          const fk = edge?.flowKind ?? "";
          if (horizontal) {
            const ax = nx + NODE_W + 2,
              ay = NODE_H / 2;
            s += `<line x1='${ax}' y1='${ay}' x2='${ax + ARROW - 4}' y2='${ay}' stroke='${ec}' stroke-width='1.6' stroke-dasharray='${da}' marker-end='${mk2}'/>`;
            if (fk)
              s += `<text x='${ax + ARROW / 2}' y='${ay - 4}' text-anchor='middle' font-size='6.5' fill='${ec}'>${fk}</text>`;
          } else {
            const ax = NODE_W / 2 + PAD,
              ay = ny + NODE_H + 2;
            s += `<line x1='${ax}' y1='${ay}' x2='${ax}' y2='${ay + ARROW - 4}' stroke='${ec}' stroke-width='1.6' stroke-dasharray='${da}' marker-end='${mk2}'/>`;
            if (fk)
              s += `<text x='${ax + 5}' y='${ay + ARROW / 2}' font-size='6.5' fill='${ec}'>${fk}</text>`;
          }
        }
      });
      const panelW = Math.min(Math.max(svgW + 28, 290), 680);
      const svgEl = `<svg xmlns='http://www.w3.org/2000/svg' width='${svgW}' height='${svgH}' viewBox='0 0 ${svgW} ${svgH}' style='display:block;overflow:visible'>${s}</svg>`;
      edgePanel.innerHTML =
        `<div style='font-weight:700;font-size:11px;margin-bottom:6px;color:#0c4a6e;display:flex;justify-content:space-between;align-items:center'>` +
        `<span>&#9654; Flow: <span style='font-family:monospace'>${ruleId}</span></span>` +
        `<span style='cursor:pointer;color:#94a3b8;font-size:14px' onclick="this.closest('#iw-edge-panel').dispatchEvent(new Event('iw-close'))">\u00d7</span></div>` +
        `<div style='overflow-x:auto'>${svgEl}</div>`;
      edgePanel.style.opacity = "1";
      edgePanel.style.width = panelW + "px";
      edgePanel.style.pointerEvents = "auto";
      edgePanel.addEventListener(
        "iw-close",
        () => {
          clearEdgePanel();
          edgePanel.style.pointerEvents = "none";
        },
        { once: true },
      );
    }

    const elementHoverOverlay = mk("g", { "pointer-events": "none" });

    function clearElementHoverOverlay() {
      while (elementHoverOverlay.firstChild)
        elementHoverOverlay.removeChild(elementHoverOverlay.firstChild);
    }

    // ── Smart port routing for element edges ────────────────────────────────
    // Given two chip rects, pick the border port closest to the direction of
    // travel and build a cubic bezier with tangents aligned to the port edge.
    type ChipRect = {
      cx: number;
      cy: number;
      x: number;
      y: number;
      w: number;
      h: number;
    };
    function smartEdgePath(a: ChipRect, b: ChipRect, tension = 80): string {
      const dx = b.cx - a.cx;
      const dy = b.cy - a.cy;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      // Prefer horizontal routing unless clearly more vertical
      const horizontal = absDx >= absDy * 0.5;
      let p1x: number, p1y: number, p2x: number, p2y: number;
      let c1x: number, c1y: number, c2x: number, c2y: number;
      if (horizontal) {
        if (dx >= 0) {
          // A exits right, B enters left
          p1x = a.x + a.w;
          p1y = a.cy;
          p2x = b.x;
          p2y = b.cy;
          const t = Math.max(tension, absDx * 0.35);
          c1x = p1x + t;
          c1y = p1y;
          c2x = p2x - t;
          c2y = p2y;
        } else {
          // A exits left, B enters right
          p1x = a.x;
          p1y = a.cy;
          p2x = b.x + b.w;
          p2y = b.cy;
          const t = Math.max(tension, absDx * 0.35);
          c1x = p1x - t;
          c1y = p1y;
          c2x = p2x + t;
          c2y = p2y;
        }
      } else {
        if (dy >= 0) {
          // A exits bottom, B enters top
          p1x = a.cx;
          p1y = a.y + a.h;
          p2x = b.cx;
          p2y = b.y;
          const t = Math.max(tension, absDy * 0.35);
          c1x = p1x;
          c1y = p1y + t;
          c2x = p2x;
          c2y = p2y - t;
        } else {
          // A exits top, B enters bottom
          p1x = a.cx;
          p1y = a.y;
          p2x = b.cx;
          p2y = b.y + b.h;
          const t = Math.max(tension, absDy * 0.35);
          c1x = p1x;
          c1y = p1y - t;
          c2x = p2x;
          c2y = p2y + t;
        }
      }
      return `M ${p1x} ${p1y} C ${c1x} ${c1y} ${c2x} ${c2y} ${p2x} ${p2y}`;
    }

    function drawExplicitElementEdge(
      p: { edge: any; fromKey: string; toKey: string },
      drawn: Set<string>,
    ) {
      const a = elementPositions.get(p.fromKey);
      const b = elementPositions.get(p.toKey);
      if (!a || !b) return;
      const dk =
        p.fromKey + "->" + p.toKey + "::" + (p.edge.ruleId ?? p.edge.type);
      if (drawn.has(dk)) return;
      drawn.add(dk);
      const isAllowed = p.edge.type === "allowed";
      const ec = isAllowed ? "#15803d" : "#b91c1c";
      const da = isAllowed ? "0" : "6 4";
      const d = smartEdgePath(a, b);
      // Invisible wide hit area for the label
      const kind = p.edge.flowKind ?? (isAllowed ? "data" : "forbidden");
      const midT = 0.5;
      // Approximate midpoint of bezier for label placement (De Casteljau t=0.5 approx)
      const parts = d
        .replace("M ", "")
        .replace(" C ", ",")
        .split(",")
        .map(Number);
      const lx =
        parts.length >= 8
          ? parts[0] * 0.125 +
            parts[2] * 0.375 +
            parts[4] * 0.375 +
            parts[6] * 0.125
          : (a.cx + b.cx) / 2;
      const ly =
        parts.length >= 9
          ? parts[1] * 0.125 +
            parts[3] * 0.375 +
            parts[5] * 0.375 +
            parts[7] * 0.125
          : (a.cy + b.cy) / 2;
      elementHoverOverlay.appendChild(
        mk("path", {
          d,
          fill: "none",
          stroke: ec,
          "stroke-width": "2.2",
          "stroke-dasharray": da,
          "marker-end": isAllowed
            ? "url(#arrow-allowed)"
            : "url(#arrow-forbidden)",
          opacity: "0.95",
        }),
      );
      // Pill label at bezier midpoint
      const labelW = 66,
        labelH = 14;
      const labelBg = mk("rect", {
        x: lx - labelW / 2,
        y: ly - labelH / 2,
        width: labelW,
        height: labelH,
        rx: 7,
        fill: isAllowed ? "#dcfce7" : "#fee2e2",
        stroke: ec,
        "stroke-width": "0.8",
        opacity: "0.92",
      });
      const labelTxt = mk("text", {
        x: lx,
        y: ly + 4,
        "text-anchor": "middle",
        "font-size": "8",
        fill: ec,
        "font-weight": "600",
      });
      labelTxt.textContent = kind + " flow";
      elementHoverOverlay.appendChild(labelBg);
      elementHoverOverlay.appendChild(labelTxt);
    }

    function drawRuleMemberEdge(
      keyA: string,
      keyB: string,
      ruleId: string,
      drawn: Set<string>,
    ) {
      const a = elementPositions.get(keyA);
      const b = elementPositions.get(keyB);
      if (!a || !b) return;
      const pairKey =
        keyA < keyB
          ? keyA + "::" + keyB + "::" + ruleId
          : keyB + "::" + keyA + "::" + ruleId;
      if (drawn.has(pairKey)) return;
      drawn.add(pairKey);
      const t = ruleTypeById.get(ruleId) ?? "forbidden";
      const isAllowed = t === "allowed";
      const ec = isAllowed ? "#15803d" : "#b91c1c";
      const da = isAllowed ? "4 3" : "6 4";
      const d = smartEdgePath(a, b, 60);
      elementHoverOverlay.appendChild(
        mk("path", {
          d,
          fill: "none",
          stroke: ec,
          "stroke-width": "1.6",
          "stroke-dasharray": da,
          opacity: "0.65",
        }),
      );
    }

    function showElementHoverOverlay(key: string) {
      clearElementHoverOverlay();
      const drawn = new Set<string>();
      elementEdgePairs
        .filter((p) => p.fromKey === key || p.toKey === key)
        .forEach((p) => drawExplicitElementEdge(p, drawn));

      // Connect to other elements that participate in the same rule.
      const hoveredRules = keyRuleIds.get(key);
      if (!hoveredRules || hoveredRules.size === 0) return;
      hoveredRules.forEach((ruleId) => {
        const members = ruleMemberKeys.get(ruleId);
        if (!members) return;
        members.forEach((otherKey) => {
          if (otherKey === key) return;
          drawRuleMemberEdge(key, otherKey, ruleId, drawn);
        });
      });
    }

    function showAllElementEdgesOverlay() {
      clearElementHoverOverlay();
      const drawn = new Set<string>();
      elementEdgePairs.forEach((p) => drawExplicitElementEdge(p, drawn));
      ruleMemberKeys.forEach((members, ruleId) => {
        const arr = [...members];
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            drawRuleMemberEdge(arr[i], arr[j], ruleId, drawn);
          }
        }
      });
    }

    let lastHoveredElementKey: string | null = null;
    refreshRuleElementOverlay = () => {
      if (showAllRuleElementEdges) {
        showAllElementEdgesOverlay();
      } else if (lastHoveredElementKey) {
        showElementHoverOverlay(lastHoveredElementKey);
      } else {
        clearElementHoverOverlay();
      }
    };
    refreshRuleElementOverlay();

    // ── Render bands ────────────────────────────────────────────────────────
    const elementPositions = new Map<
      string,
      { cx: number; cy: number; x: number; y: number; w: number; h: number }
    >();
    placements.forEach((p) => {
      const layer = p.layer;
      const pos = layerPositions.get(layer.index)!;
      const { x, y, w: boxWidth, h } = pos;
      const col = BAND_PALETTE[layer.index % BAND_PALETTE.length];
      const bw = placementBandW.get(layer.index) ?? GCW;
      const cw = bw - LABEL_W - CHIP_PADX * 2;
      const perRow = Math.max(
        1,
        Math.floor((cw + CHIP_GAP) / (160 + CHIP_GAP)),
      );
      const cw1 = Math.floor((cw - CHIP_GAP * (perRow - 1)) / perRow);
      const cx0 = x + LABEL_W + CHIP_PADX;
      const g = mk("g");
      const policyItems = Array.isArray(layer.policies) ? layer.policies : [];
      const fromAnchors = (forbiddenFromByLayer.get(layer.index) ??
        []) as AnchorItem[];
      const toAnchors = (forbiddenToByLayer.get(layer.index) ??
        []) as AnchorItem[];
      const polKey = String(layer.index) + ":policies";
      const ancKey = String(layer.index) + ":anchors";
      const polC = collapsedSections.get(polKey) ?? false;
      const ancC = collapsedSections.get(ancKey) ?? false;

      // Band background
      const bandRect = mk("rect", {
        x,
        y,
        width: boxWidth,
        height: h,
        rx: 10,
        ry: 10,
        fill: col.bg,
        stroke: col.border,
        "stroke-width": "1.5",
        style: "cursor:default;",
      });
      const policyTip = policyItems
        .map(
          (pi) =>
            "\u2022 " +
            (pi.severity ? pi.severity.toUpperCase() + " \u00b7 " : "") +
            pi.ruleId +
            (pi.adr ? " [" + pi.adr + "]" : "") +
            (pi.description ? "\n  " + pi.description.trim() : ""),
        )
        .join("\n");
      const layerTip =
        "<b>Layer: " +
        layer.name +
        "</b>\n" +
        layer.fileCount +
        " files \u00b7 " +
        layer.ruleViolationCount +
        " violation(s)" +
        (policyTip ? "\n\n<b>Forbidden policies:</b>\n" + policyTip : "");
      bandRect.addEventListener("mousemove", (ev: any) =>
        showTooltip(ev, layerTip),
      );
      bandRect.addEventListener("mouseleave", hideTooltip);
      g.appendChild(bandRect);

      // Left colour slab
      g.appendChild(
        mk("rect", {
          x,
          y,
          width: LABEL_W,
          height: h,
          rx: 10,
          ry: 10,
          fill: col.slab,
          stroke: "none",
        }),
      );
      g.appendChild(
        mk("rect", {
          x: x + LABEL_W - 12,
          y,
          width: 12,
          height: h,
          fill: col.slab,
          stroke: "none",
        }),
      );
      g.appendChild(
        mk("line", {
          x1: x + LABEL_W,
          y1: y + 8,
          x2: x + LABEL_W,
          y2: y + h - 8,
          stroke: col.border,
          "stroke-width": "1",
        }),
      );
      const shortName = layer.name.replace(/^(packages|apps)\//, "");
      const slabMidX = x + LABEL_W / 2;
      const hasMeta = layer.fileCount > 0 || layer.ruleViolationCount > 0;
      const titleEl = mk("text", {
        x: slabMidX,
        y: y + h / 2 + (hasMeta ? -6 : 4),
        "text-anchor": "middle",
        "font-size": "11",
        "font-weight": "700",
        fill: col.text,
      });
      titleEl.textContent =
        shortName.length > 17 ? shortName.slice(0, 15) + "\u2026" : shortName;
      g.appendChild(titleEl);
      if (hasMeta) {
        const metaEl = mk("text", {
          x: slabMidX,
          y: y + h / 2 + 10,
          "text-anchor": "middle",
          "font-size": "9",
          fill: col.text,
          opacity: "0.75",
        });
        metaEl.textContent =
          layer.fileCount + "f  " + layer.ruleViolationCount + "v";
        g.appendChild(metaEl);
      }
      if (layer.ruleViolationCount > 0) {
        g.appendChild(
          mk("rect", {
            x: x + boxWidth - 80,
            y: y + 8,
            width: 68,
            height: 18,
            rx: 9,
            fill: "#fee2e2",
            stroke: col.border,
          }),
        );
        const bt = mk("text", {
          x: x + boxWidth - 46,
          y: y + 21,
          "text-anchor": "middle",
          "font-size": "9",
          "font-weight": "700",
          fill: "#991b1b",
        });
        bt.textContent = layer.ruleViolationCount + " issue(s)";
        g.appendChild(bt);
      }

      let cy0 = y + 10;

      // ── Forbidden Policies section (D — collapsible) ──────────────────
      if (policyItems.length > 0) {
        const hdrG = mk("g", { style: "cursor:pointer;" });
        hdrG.appendChild(
          mk("rect", {
            x: cx0 - 4,
            y: cy0,
            width: cw + 8,
            height: SEC_H,
            rx: 4,
            fill: col.slab,
            opacity: "0.7",
          }),
        );
        const ht = mk("text", {
          x: cx0 + 2,
          y: cy0 + 12,
          "font-size": "8",
          "font-weight": "700",
          fill: col.text,
          "letter-spacing": "0.4",
        });
        ht.textContent =
          (polC ? "\u25b6" : "\u25bc") +
          " FORBIDDEN POLICIES (" +
          policyItems.length +
          ")";
        hdrG.appendChild(ht);
        const hdrHit = mk("rect", {
          x: cx0 - 4,
          y: cy0,
          width: cw + 8,
          height: SEC_H,
          fill: "transparent",
        });
        hdrHit.addEventListener("click", (ev: any) => {
          ev.stopPropagation();
          collapsedSections.set(polKey, !polC);
          build();
        });
        hdrG.appendChild(hdrHit);
        g.appendChild(hdrG);
        cy0 += SEC_H + 2;
        if (!polC) {
          policyItems.slice(0, 9).forEach((pItem, idx) => {
            const c2 = idx % perRow,
              r2 = Math.floor(idx / perRow);
            const bx = cx0 + c2 * (cw1 + CHIP_GAP),
              by = cy0 + r2 * (CHIP_H + 4);
            g.appendChild(
              mk("rect", {
                x: bx,
                y: by,
                width: cw1,
                height: CHIP_H,
                rx: 5,
                fill: "#fff",
                stroke: "#fca5a5",
                "stroke-width": "1",
              }),
            );
            g.appendChild(
              mk("rect", {
                x: bx,
                y: by,
                width: 5,
                height: CHIP_H,
                rx: 3,
                fill: "#dc2626",
              }),
            );
            g.appendChild(
              mk("rect", {
                x: bx + 2,
                y: by,
                width: 3,
                height: CHIP_H,
                fill: "#dc2626",
              }),
            );
            const mc = Math.max(10, Math.floor((cw1 - 14) / 6));
            const rt = mk("text", {
              x: bx + 10,
              y: by + CHIP_H / 2 + 4,
              "font-size": "9",
              fill: "#7f1d1d",
              "font-weight": "600",
            });
            rt.textContent =
              pItem.ruleId.length > mc
                ? pItem.ruleId.slice(0, mc - 1) + "\u2026"
                : pItem.ruleId;
            const itip =
              "<b>" +
              pItem.ruleId +
              "</b>" +
              (pItem.severity
                ? " \u00b7 " + pItem.severity.toUpperCase()
                : "") +
              (pItem.adr ? " \u00b7 " + pItem.adr : "") +
              "\nType: " +
              pItem.kind +
              " \u00b7 Violations: " +
              pItem.count +
              (pItem.description ? "\n\n" + pItem.description.trim() : "");
            const ch = mk("rect", {
              x: bx,
              y: by,
              width: cw1,
              height: CHIP_H,
              fill: "transparent",
              style: "cursor:pointer;",
            });
            ch.addEventListener("mousemove", (ev: any) => {
              ev.stopPropagation();
              showTooltip(ev, itip);
            });
            ch.addEventListener("mouseleave", hideTooltip);
            if (rulesWithFlows.has(pItem.ruleId)) {
              ch.addEventListener("click", (ev: any) => {
                ev.stopPropagation();
                hideTooltip();
                showFlowPanel(pItem.ruleId);
              });
            }
            g.appendChild(rt);
            g.appendChild(ch);
          });
          cy0 +=
            Math.ceil(Math.min(policyItems.length, 9) / perRow) * (CHIP_H + 4) +
            4;
        }
      }

      // ── Rule Elements section (D — collapsible) ───────────────────────
      if (toAnchors.length > 0 || fromAnchors.length > 0) {
        const hdrG = mk("g", { style: "cursor:pointer;" });
        hdrG.appendChild(
          mk("rect", {
            x: cx0 - 4,
            y: cy0,
            width: cw + 8,
            height: SEC_H,
            rx: 4,
            fill: col.slab,
            opacity: "0.7",
          }),
        );
        const ht = mk("text", {
          x: cx0 + 2,
          y: cy0 + 12,
          "font-size": "8",
          "font-weight": "700",
          fill: col.text,
          "letter-spacing": "0.4",
        });
        ht.textContent =
          (ancC ? "\u25b6" : "\u25bc") +
          " RULE ELEMENTS (" +
          (toAnchors.length + fromAnchors.length) +
          ")";
        hdrG.appendChild(ht);
        const hdrHit = mk("rect", {
          x: cx0 - 4,
          y: cy0,
          width: cw + 8,
          height: SEC_H,
          fill: "transparent",
        });
        hdrHit.addEventListener("click", (ev: any) => {
          ev.stopPropagation();
          collapsedSections.set(ancKey, !ancC);
          build();
        });
        hdrG.appendChild(hdrHit);
        g.appendChild(hdrG);
        cy0 += SEC_H + 2;
        if (!ancC) {
          toAnchors.slice(0, 4).forEach((anchor: AnchorItem, idx: number) => {
            const c2 = idx % perRow,
              r2 = Math.floor(idx / perRow);
            const bx = cx0 + c2 * (cw1 + CHIP_GAP),
              by = cy0 + r2 * (CHIP_H + 4);
            const key = String(layer.index) + "::" + anchor.name;
            const isImp = anchor.kind === "import_pattern";
            g.appendChild(
              mk("rect", {
                x: bx,
                y: by,
                width: cw1,
                height: CHIP_H,
                rx: 5,
                fill: "#fff7f7",
                stroke: "#fca5a5",
                "stroke-width": "1",
              }),
            );
            const sx2 = bx + 7,
              cy2 = by + CHIP_H / 2;
            if (isImp) {
              g.appendChild(
                mk("line", {
                  x1: sx2,
                  y1: cy2,
                  x2: sx2 + 7,
                  y2: cy2,
                  stroke: "#dc2626",
                  "stroke-width": "1.5",
                }),
              );
              g.appendChild(
                mk("path", {
                  d:
                    "M " +
                    (sx2 + 7) +
                    " " +
                    (cy2 - 4) +
                    " A 4 4 0 0 1 " +
                    (sx2 + 7) +
                    " " +
                    (cy2 + 4),
                  fill: "none",
                  stroke: "#dc2626",
                  "stroke-width": "1.5",
                }),
              );
            } else {
              g.appendChild(
                mk("line", {
                  x1: sx2,
                  y1: cy2,
                  x2: sx2 + 5,
                  y2: cy2,
                  stroke: "#dc2626",
                  "stroke-width": "1.5",
                }),
              );
              g.appendChild(
                mk("circle", {
                  cx: sx2 + 9,
                  cy: cy2,
                  r: "4",
                  fill: "#fee2e2",
                  stroke: "#dc2626",
                  "stroke-width": "1.5",
                }),
              );
              g.appendChild(
                mk("line", {
                  x1: sx2 + 6,
                  y1: cy2 - 3,
                  x2: sx2 + 12,
                  y2: cy2 + 3,
                  stroke: "#dc2626",
                  "stroke-width": "1",
                }),
              );
              g.appendChild(
                mk("line", {
                  x1: sx2 + 12,
                  y1: cy2 - 3,
                  x2: sx2 + 6,
                  y2: cy2 + 3,
                  stroke: "#dc2626",
                  "stroke-width": "1",
                }),
              );
            }
            if (!elementPositions.has(key))
              elementPositions.set(key, {
                cx: bx + cw1 / 2,
                cy: by + CHIP_H / 2,
                x: bx,
                y: by,
                w: cw1,
                h: CHIP_H,
              });
            const mc = Math.max(8, Math.floor((cw1 - 24) / 6));
            const lbl = mk("text", {
              x: sx2 + 19,
              y: by + CHIP_H / 2 + 4,
              "font-size": "9",
              fill: "#991b1b",
              "font-weight": "500",
            });
            lbl.textContent =
              anchor.name.length > mc
                ? anchor.name.slice(0, mc - 1) + "\u2026"
                : anchor.name;
            const ch = mk("rect", {
              x: bx,
              y: by,
              width: cw1,
              height: CHIP_H,
              fill: "transparent",
              style: "cursor:help;",
            });
            ch.addEventListener("mousemove", (ev: any) => {
              ev.stopPropagation();
              showTooltip(
                ev,
                "<b>" +
                  anchor.name +
                  "</b>\nKind: " +
                  anchor.kind +
                  "\nForbidden target",
              );
            });
            ch.addEventListener("mouseleave", hideTooltip);
            ch.addEventListener("mouseenter", () => {
              lastHoveredElementKey = key;
              if (!showAllRuleElementEdges) showElementHoverOverlay(key);
            });
            ch.addEventListener("mouseleave", () => {
              lastHoveredElementKey = null;
              if (!showAllRuleElementEdges) clearElementHoverOverlay();
            });
            g.appendChild(lbl);
            g.appendChild(ch);
          });
          cy0 +=
            Math.ceil(Math.min(toAnchors.length, 4) / perRow) * (CHIP_H + 4);
          fromAnchors.slice(0, 2).forEach((anchor: AnchorItem, idx: number) => {
            const c2 = idx % perRow,
              r2 = Math.floor(idx / perRow);
            const bx = cx0 + c2 * (cw1 + CHIP_GAP),
              by = cy0 + r2 * (CHIP_H + 4);
            const key = String(layer.index) + "::" + anchor.name;
            g.appendChild(
              mk("rect", {
                x: bx,
                y: by,
                width: cw1,
                height: CHIP_H,
                rx: 5,
                fill: "#fff8f0",
                stroke: "#fdba74",
                "stroke-width": "1",
              }),
            );
            const sx2 = bx + 7,
              cy2 = by + CHIP_H / 2;
            g.appendChild(
              mk("rect", {
                x: sx2 + 3,
                y: cy2 - 5,
                width: 10,
                height: 9,
                rx: "1",
                fill: "#fff8f0",
                stroke: "#f97316",
                "stroke-width": "1",
              }),
            );
            g.appendChild(
              mk("rect", {
                x: sx2,
                y: cy2 - 4,
                width: 5,
                height: 3,
                rx: "0.5",
                fill: "#fff8f0",
                stroke: "#f97316",
                "stroke-width": "0.8",
              }),
            );
            g.appendChild(
              mk("rect", {
                x: sx2,
                y: cy2 + 1,
                width: 5,
                height: 3,
                rx: "0.5",
                fill: "#fff8f0",
                stroke: "#f97316",
                "stroke-width": "0.8",
              }),
            );
            if (!elementPositions.has(key))
              elementPositions.set(key, {
                cx: bx + cw1 / 2,
                cy: by + CHIP_H / 2,
                x: bx,
                y: by,
                w: cw1,
                h: CHIP_H,
              });
            const mc = Math.max(8, Math.floor((cw1 - 24) / 6));
            const lbl = mk("text", {
              x: sx2 + 19,
              y: by + CHIP_H / 2 + 4,
              "font-size": "9",
              fill: "#92400e",
              "font-weight": "500",
            });
            lbl.textContent =
              anchor.name.length > mc
                ? anchor.name.slice(0, mc - 1) + "\u2026"
                : anchor.name;
            const ch = mk("rect", {
              x: bx,
              y: by,
              width: cw1,
              height: CHIP_H,
              fill: "transparent",
              style: "cursor:help;",
            });
            ch.addEventListener("mousemove", (ev: any) => {
              ev.stopPropagation();
              showTooltip(
                ev,
                "<b>" +
                  anchor.name +
                  "</b>\nKind: " +
                  anchor.kind +
                  "\nForbidden scope",
              );
            });
            ch.addEventListener("mouseleave", hideTooltip);
            ch.addEventListener("mouseenter", () => {
              lastHoveredElementKey = key;
              if (!showAllRuleElementEdges) showElementHoverOverlay(key);
            });
            ch.addEventListener("mouseleave", () => {
              lastHoveredElementKey = null;
              if (!showAllRuleElementEdges) clearElementHoverOverlay();
            });
            g.appendChild(lbl);
            g.appendChild(ch);
          });
          cy0 +=
            Math.ceil(Math.min(fromAnchors.length, 2) / perRow) * (CHIP_H + 4) +
            4;
        }
      }

      // ── Flow Elements section (expresses.elements, grouped by rule → horizontal strips) ───
      if (data.options?.showRuleElements && Array.isArray(layer.elements)) {
        const namedEls = (layer.elements as any[]).filter(
          (el) => !isGlobPattern(String(el.name)),
        );
        if (namedEls.length > 0) {
          // Section header
          const flHdr = mk("g");
          flHdr.appendChild(
            mk("rect", {
              x: cx0 - 4,
              y: cy0,
              width: cw + 8,
              height: SEC_H,
              rx: 4,
              fill: "#eff6ff",
              opacity: "0.9",
            }),
          );
          const flHt = mk("text", {
            x: cx0 + 2,
            y: cy0 + 12,
            "font-size": "8",
            "font-weight": "700",
            fill: "#1e40af",
            "letter-spacing": "0.4",
          });
          flHt.textContent = "\u25bc FLOW ELEMENTS (" + namedEls.length + ")";
          flHdr.appendChild(flHt);
          g.appendChild(flHdr);
          cy0 += SEC_H + 2;

          // Group by ruleId — one horizontal flow strip per rule
          const ruleGroups = new Map<string, any[]>();
          namedEls.forEach((el: any) => {
            const rid = String(el.ruleId ?? "");
            const arr = ruleGroups.get(rid) ?? [];
            arr.push(el);
            ruleGroups.set(rid, arr);
          });

          const ARROW_GAP = 22;
          ruleGroups.forEach((groupEls) => {
            const sorted = groupEls
              .slice()
              .sort(
                (a: any, b: any) => (a.flowSeq ?? 999) - (b.flowSeq ?? 999),
              );
            const gn = sorted.length;
            const totalArrowSpace = Math.max(0, gn - 1) * ARROW_GAP;
            const chipW = Math.max(80, Math.floor((cw - totalArrowSpace) / gn));

            sorted.forEach((el: any, i: number) => {
              const bx = cx0 + i * (chipW + ARROW_GAP);
              const by = cy0;
              g.appendChild(
                mk("rect", {
                  x: bx,
                  y: by,
                  width: chipW,
                  height: CHIP_H,
                  rx: 5,
                  fill: "#f0f9ff",
                  stroke: "#7dd3fc",
                  "stroke-width": "1.2",
                }),
              );
              const hasStep = el.flowSeq != null && el.flowSeq < 999;
              if (hasStep) {
                g.appendChild(
                  mk("rect", {
                    x: bx + 5,
                    y: by + 5,
                    width: 16,
                    height: 16,
                    rx: 8,
                    fill: "#0284c7",
                  }),
                );
                const stepTxt = mk("text", {
                  x: bx + 13,
                  y: by + 16,
                  "text-anchor": "middle",
                  "font-size": "7.5",
                  "font-weight": "700",
                  fill: "#fff",
                });
                stepTxt.textContent = String(el.flowSeq + 1);
                g.appendChild(stepTxt);
              }
              const labelX = bx + (hasStep ? 26 : 8);
              const maxCh = Math.max(
                6,
                Math.floor((chipW - (hasStep ? 34 : 12)) / 6),
              );
              const lbl = mk("text", {
                x: labelX,
                y: by + CHIP_H / 2 + 4,
                "font-size": "9",
                fill: "#0c4a6e",
                "font-weight": "600",
              });
              lbl.textContent =
                String(el.name).length > maxCh
                  ? String(el.name).slice(0, maxCh - 1) + "\u2026"
                  : String(el.name);
              g.appendChild(lbl);

              // Arrow to next chip in this layer's flow strip
              if (i < sorted.length - 1) {
                const ax = bx + chipW + 1,
                  ay = by + CHIP_H / 2;
                g.appendChild(
                  mk("line", {
                    x1: ax,
                    y1: ay,
                    x2: ax + ARROW_GAP - 6,
                    y2: ay,
                    stroke: "#0284c7",
                    "stroke-width": "1.5",
                    "marker-end": "url(#arrow-allowed)",
                  }),
                );
              }

              const key = String(layer.index) + "::" + String(el.name);
              elementPositions.set(key, {
                cx: bx + chipW / 2,
                cy: by + CHIP_H / 2,
                x: bx,
                y: by,
                w: chipW,
                h: CHIP_H,
              });
              const eh = mk("rect", {
                x: bx,
                y: by,
                width: chipW,
                height: CHIP_H,
                fill: "transparent",
                style: "cursor:pointer;",
              });
              const tip =
                "<b>" +
                el.name +
                "</b>\nKind: " +
                el.kind +
                (hasStep ? "\nFlow step: " + (el.flowSeq + 1) : "") +
                (el.ruleId ? "\nRule: " + el.ruleId : "") +
                "\n\n<i>Click to open full flow diagram</i>";
              eh.addEventListener("mousemove", (ev: any) => {
                ev.stopPropagation();
                showTooltip(ev, tip);
              });
              eh.addEventListener("mouseleave", hideTooltip);
              eh.addEventListener("click", (ev: any) => {
                ev.stopPropagation();
                hideTooltip();
                if (el.ruleId) showFlowPanel(String(el.ruleId));
              });
              eh.addEventListener("mouseenter", () => {
                lastHoveredElementKey = key;
                if (!showAllRuleElementEdges) showElementHoverOverlay(key);
              });
              eh.addEventListener("mouseleave", () => {
                lastHoveredElementKey = null;
                if (!showAllRuleElementEdges) clearElementHoverOverlay();
              });
              g.appendChild(eh);
            });
            cy0 += CHIP_H + 10;
          });
        }
      }

      panGroup.appendChild(g);
    }); // end bands

    // ── Render edges ─────────────────────────────────────────────────────────
    // Same-row  → S-curve in the band gap with a short label
    // Allowed cross-row   → orthogonal elbow through LEFT  gutter (green) — staggered Y ports
    // Forbidden cross-row → orthogonal elbow through RIGHT gutter (red)   — staggered Y ports
    // No text in the gutter — all details in the edge panel (E)
    const sameRowAllowed = data.edges.filter(
      (e) => e.type === "allowed" && isSameRow(e),
    );
    const outASame = new Map<number, number[]>();
    const incASame = new Map<number, number[]>();
    sameRowAllowed.forEach((e, i) => {
      const o = outASame.get(e.fromLayerIndex) ?? [];
      o.push(i);
      outASame.set(e.fromLayerIndex, o);
      const t = incASame.get(e.toLayerIndex) ?? [];
      t.push(i);
      incASame.set(e.toLayerIndex, t);
    });
    function sameAllowedPortY(
      layerIdx: number,
      laneIdx: number,
      isOut: boolean,
    ): number {
      const pos = layerPositions.get(layerIdx);
      if (!pos) return 0;
      const arr = (isOut ? outASame : incASame).get(layerIdx) ?? [];
      const i = arr.indexOf(laneIdx),
        n = arr.length;
      const zoneTop = pos.y + pos.h * 0.22;
      const zoneH = pos.h * 0.56;
      return n <= 1 ? pos.y + pos.h / 2 : zoneTop + (i / (n - 1)) * zoneH;
    }

    data.edges.forEach((edge) => {
      const s = layerPositions.get(edge.fromLayerIndex);
      const t = layerPositions.get(edge.toLayerIndex);
      if (!s || !t) return;
      const isAllowed = edge.type === "allowed";
      const ec = isAllowed ? "#1f8f4e" : "#c53030";
      const da =
        edge.type === "forbidden"
          ? "7 4"
          : edge.flowKind === "data"
            ? "2 4"
            : "0";
      const me = isAllowed ? "url(#arrow-allowed)" : "url(#arrow-forbidden)";
      const sw = isAllowed ? "2" : "2.5";
      let pathD: string;

      if (isSameRow(edge)) {
        const lr = t.x > s.x;
        const sx = lr ? s.x + s.w : s.x,
          tx = lr ? t.x : t.x + t.w;
        const sameLane = sameRowAllowed.indexOf(edge);
        const sy = isAllowed
          ? sameAllowedPortY(edge.fromLayerIndex, sameLane, true)
          : s.y + s.h / 2;
        const ty = isAllowed
          ? sameAllowedPortY(edge.toLayerIndex, sameLane, false)
          : t.y + t.h / 2;
        const mx = (sx + tx) / 2;
        pathD =
          "M " +
          sx +
          " " +
          sy +
          " C " +
          mx +
          " " +
          sy +
          " " +
          mx +
          " " +
          ty +
          " " +
          tx +
          " " +
          ty;
        const pe = mk("path", {
          d: pathD,
          fill: "none",
          stroke: ec,
          "stroke-width": sw,
          "stroke-dasharray": da,
          "marker-end": me,
          opacity: "0.85",
          style: "cursor:pointer;",
        });
        const he = mk("path", {
          d: pathD,
          fill: "none",
          stroke: "transparent",
          "stroke-width": "14",
          style: "cursor:pointer;",
        });
        he.addEventListener("mouseenter", () => showEdgePanel(edge));
        he.addEventListener("mouseleave", clearEdgePanel);
        panGroup.appendChild(pe);
        panGroup.appendChild(he);
        const lbl = mk("text", {
          x: mx,
          y: Math.min(sy, ty) - 5,
          "text-anchor": "middle",
          "font-size": "8",
          fill: ec,
          style: "pointer-events:none;",
        });
        lbl.textContent =
          edge.label.length > 26
            ? edge.label.slice(0, 24) + "\u2026"
            : edge.label;
        panGroup.appendChild(lbl);
        return;
      }

      const li = isAllowed
        ? sortedAllowed.indexOf(edge)
        : sortedForbidden.indexOf(edge);
      const sy = portY(edge.fromLayerIndex, li, true, !isAllowed);
      const ty = portY(edge.toLayerIndex, li, false, !isAllowed);

      if (isAllowed) {
        // LEFT gutter: rightmost lane closest to bands (lane 0 = closest)
        const lx =
          LGUTTER_X0 + (sortedAllowed.length - 1 - li) * LANE_W + LANE_W / 2;
        pathD =
          "M " +
          s.x +
          " " +
          sy +
          " L " +
          lx +
          " " +
          sy +
          " L " +
          lx +
          " " +
          ty +
          " L " +
          t.x +
          " " +
          ty;
      } else {
        // RIGHT gutter: lane 0 closest to bands
        const lx = RGUTTER_X0 + li * LANE_W + LANE_W / 2;
        pathD =
          "M " +
          (s.x + s.w) +
          " " +
          sy +
          " L " +
          lx +
          " " +
          sy +
          " L " +
          lx +
          " " +
          ty +
          " L " +
          (t.x + t.w) +
          " " +
          ty;
      }

      const pe = mk("path", {
        d: pathD,
        fill: "none",
        stroke: ec,
        "stroke-width": sw,
        "stroke-dasharray": da,
        "marker-end": me,
        opacity: "0.85",
        style: "cursor:pointer;",
        "stroke-linejoin": "round",
      });
      const he = mk("path", {
        d: pathD,
        fill: "none",
        stroke: "transparent",
        "stroke-width": "14",
        style: "cursor:pointer;",
      });
      he.addEventListener("mouseenter", () => showEdgePanel(edge));
      he.addEventListener("mouseleave", clearEdgePanel);
      panGroup.appendChild(pe);
      panGroup.appendChild(he);
    }); // end edges

    // Keep hover element-edge overlays above all chips and base edges.
    panGroup.appendChild(elementHoverOverlay);

    applyTransform();
  } // end build()

  build();

  stats.innerHTML = [
    "<span>Total files: <strong>" + data.meta.totalFiles + "</strong></span>",
    "<span>Rule violations: <strong>" +
      data.meta.totalRuleViolations +
      "</strong></span>",
    "<span>Layer violations: <strong>" +
      data.meta.totalLayerViolations +
      "</strong></span>",
    "<span>Layers: <strong>" + data.layers.length + "</strong></span>",
    "<span style='font-size:10px;color:#6b7280'>Scroll to zoom \u00b7 drag to pan \u00b7 click \u25bc headers to collapse</span>",
  ].join(" \u00b7 ");

  const rules = [...data.rules].sort(
    (a, b) => b.count - a.count || a.id.localeCompare(b.id),
  );
  if (rules.length === 0) {
    rulesList.innerHTML =
      '<div class="rule-item"><div class="rule-id">No active rule violations</div></div>';
    return;
  }
  rulesList.innerHTML = rules
    .map(
      (r) =>
        '<div class="rule-item">' +
        '<div class="rule-id">' +
        r.id +
        "</div>" +
        '<div class="rule-meta"><span class="badge ' +
        r.severity +
        '">' +
        String(r.severity).toUpperCase() +
        "</span> " +
        r.count +
        " violation(s)" +
        (r.adr
          ? ' \u00b7 <span style="font-size:10px">' + r.adr + "</span>"
          : "") +
        "</div>" +
        (r.description
          ? '<div class="rule-desc">' + r.description.trim() + "</div>"
          : "") +
        "</div>",
    )
    .join("");
}
