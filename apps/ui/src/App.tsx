// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { QueryBar } from "./components/QueryBar.js";
import { DecisionTree } from "./components/DecisionTree.js";
import { DecisionTimeline } from "./components/DecisionTimeline.js";
import { ImpactGraph } from "./components/ImpactGraph.js";
import { ImpactSummary } from "./components/ImpactSummary.js";
import { KnowledgeGraph } from "./components/KnowledgeGraph.js";
import { Legend } from "./components/Legend.js";
import { MetaBar } from "./components/MetaBar.js";
import { NodeDetail } from "./components/NodeDetail.js";
import { fetchInsight, checkHealth, fetchSessions } from "./api/insight.js";
import type { SessionInfo } from "./api/insight.js";
import type {
  InsightResponse,
  InsightNode,
  NodeKind,
  VizType,
  DecisionTreeData,
  ImpactGraphData,
  KnowledgeGraphData,
} from "./types.js";

type ViewMode = "graph" | "timeline";

export function App() {
  const [insight, setInsight] = useState<InsightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [selectedNode, setSelectedNode] = useState<InsightNode | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [vizType, setVizType] = useState<VizType>("decision-tree");
  /** Node IDs to highlight on the graph when lineage is shown in the detail panel. */
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string> | null>(null);
  /** Available sessions from the server. */
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  /** Currently selected session (null = server default). */
  const [activeSession, setActiveSession] = useState<string | null>(null);

  // Check backend health on mount
  useEffect(() => {
    checkHealth().then(setBackendUp);
  }, []);

  // Fetch available sessions on mount
  useEffect(() => {
    fetchSessions().then((list) => {
      setSessions(list);
      // Auto-select first session if available
      if (list.length > 0 && !activeSession) {
        setActiveSession(list[0].id);
      }
    });
  }, []);

  const handleQuery = useCallback(
    async (question: string, overrideVizType?: VizType) => {
      const activeViz = overrideVizType ?? vizType;
      setLoading(true);
      setError(null);
      setSelectedNode(null);
      if (overrideVizType) setVizType(overrideVizType);
      // Reset to graph view when switching
      setViewMode("graph");

      try {
        // For KG mode, "*" means "show everything" → send no question filter
        const effectiveQuestion =
          (activeViz === "knowledge-graph" || activeViz === "kwg") && question.trim() === "*"
            ? undefined
            : question;
        const result = await fetchInsight({
          question: effectiveQuestion,
          vizType: activeViz,
          maxNodes: (activeViz === "knowledge-graph" || activeViz === "kwg") ? 200 : undefined,
          session: activeSession ?? undefined,
        });
        setInsight(result);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setInsight(null);
      } finally {
        setLoading(false);
      }
    },
    [vizType, activeSession],
  );

  // Active node kinds for legend filtering
  const activeKinds = insight
    ? (new Set(insight.data.nodes.map((n) => n.kind)) as Set<NodeKind>)
    : undefined;

  /** Is the current response a decision tree? */
  const isDecisionTree = insight?.vizType === "decision-tree";
  /** Is the current response an impact graph? */
  const isImpactGraph = insight?.vizType === "impact-graph";
  /** Is the current response a full knowledge graph? */
  const isKnowledgeGraph = insight?.vizType === "knowledge-graph";

  /** Navigate to a node by ID (from connection links in the detail panel). */
  const handleNavigate = useCallback(
    (nodeId: string) => {
      if (!insight) return;
      const target = insight.data.nodes.find((n) => n.id === nodeId);
      if (target) setSelectedNode(target);
    },
    [insight],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-950">
        <div className="flex items-center gap-3">
          <span className="text-xl">🔮</span>
          <h1 className="text-base font-semibold text-slate-100">
            IntentWeave
          </h1>
          <span className="text-xs font-medium text-indigo-400 bg-indigo-950 px-2 py-0.5 rounded-full">
            Insight Canvas
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* VizType selector */}
          <div className="flex items-center bg-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setVizType("decision-tree")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                vizType === "decision-tree"
                  ? "bg-violet-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Decisions
            </button>
            <button
              onClick={() => setVizType("impact-graph")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                vizType === "impact-graph"
                  ? "bg-pink-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Impact
            </button>
            <button
              onClick={() => setVizType("knowledge-graph")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                vizType === "knowledge-graph"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Full KG
            </button>
            <button
              onClick={() => setVizType("kwg")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                vizType === "kwg"
                  ? "bg-cyan-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              KWG
            </button>
          </div>

          {/* Session selector */}
          {sessions.length > 0 && (
            <select
              value={activeSession ?? ""}
              onChange={(e) => setActiveSession(e.target.value || null)}
              className="bg-slate-800 text-slate-300 text-xs rounded-lg px-2 py-1.5 border border-slate-700 focus:border-indigo-500 focus:outline-none"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} ({s.canonCount > 0 ? `${s.canonCount} canon` : ""}{s.canonCount > 0 && s.kwgCount > 0 ? ", " : ""}{s.kwgCount > 0 ? `${s.kwgCount} kwg` : ""})
                </option>
              ))}
            </select>
          )}

          {/* View mode toggle (only for decision-tree) */}
          {isDecisionTree && insight && insight.data.nodes.length > 1 && (
            <div className="flex items-center bg-slate-800 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode("graph")}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  viewMode === "graph"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Graph
              </button>
              <button
                onClick={() => setViewMode("timeline")}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  viewMode === "timeline"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Timeline
              </button>
            </div>
          )}
          {backendUp === false && (
            <span className="text-xs text-red-400">
              ⚠ Backend not reachable
            </span>
          )}
          {backendUp === true && (
            <span className="text-xs text-emerald-500">● Connected</span>
          )}
        </div>
      </header>

      {/* Query bar */}
      <QueryBar onSubmit={handleQuery} loading={loading} vizType={vizType} />

      {/* Meta bar (shown when we have results) */}
      {insight && <MetaBar meta={insight.meta} title={insight.title} />}

      {/* Canvas area */}
      <div className="flex-1 relative">
        {/* Error state */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-red-950/60 border border-red-800 rounded-lg px-6 py-4 max-w-md text-center">
              <p className="text-red-300 text-sm">{error}</p>
              <p className="text-red-500 text-xs mt-2">
                Make sure the IntentWeave server is running on port 3000
              </p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!insight && !error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center max-w-lg">
              <div className="text-6xl mb-4">🔮</div>
              <h2 className="text-xl font-semibold text-slate-300 mb-2">
                Insight Canvas
              </h2>
              <p className="text-slate-500 text-sm leading-relaxed mb-6">
                Ask a question about your knowledge graph to generate an
                interactive visualization. Try a preset query above or type your
                own.
              </p>
              <div className="grid grid-cols-2 gap-3 text-left text-xs text-slate-600">
                <div
                  className="bg-slate-900 rounded-lg p-3 border border-slate-800 cursor-pointer hover:border-violet-800 transition-colors"
                  onClick={() => setVizType("decision-tree")}
                >
                  <span className="text-violet-400 font-medium">
                    Decision Trees
                  </span>
                  <p className="mt-1">
                    Explore decisions, options, and rationale
                  </p>
                </div>
                <div
                  className="bg-slate-900 rounded-lg p-3 border border-slate-800 cursor-pointer hover:border-pink-800 transition-colors"
                  onClick={() => setVizType("impact-graph")}
                >
                  <span className="text-pink-400 font-medium">
                    Impact Graphs
                  </span>
                  <p className="mt-1">
                    Visualize blast radius and ripple effects
                  </p>
                </div>
                <div
                  className="bg-slate-900 rounded-lg p-3 border border-slate-800 cursor-pointer hover:border-emerald-800 transition-colors"
                  onClick={() => setVizType("knowledge-graph")}
                >
                  <span className="text-emerald-400 font-medium">
                    Full Knowledge Graph
                  </span>
                  <p className="mt-1">
                    Browse all entities and relationships
                  </p>
                </div>
                <div className="bg-slate-900 rounded-lg p-3 border border-slate-800 opacity-50">
                  <span className="text-amber-400 font-medium">Doc Health</span>
                  <p className="mt-1">Coming soon</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/60 z-10">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-slate-400">
                Querying knowledge graph…
              </span>
            </div>
          </div>
        )}

        {/* Visualization */}
        {isDecisionTree &&
          insight &&
          insight.data.nodes.length > 1 &&
          viewMode === "graph" && (
            <DecisionTree
              data={insight.data as DecisionTreeData}
              selectedNodeId={selectedNode?.id}
              onNodeClick={setSelectedNode}
              highlightedNodeIds={highlightedNodeIds ?? undefined}
            />
          )}
        {isDecisionTree &&
          insight &&
          insight.data.nodes.length > 1 &&
          viewMode === "timeline" && (
            <DecisionTimeline
              data={insight.data as DecisionTreeData}
              selectedNodeId={selectedNode?.id}
              onNodeClick={setSelectedNode}
            />
          )}
        {isImpactGraph && insight && insight.data.nodes.length > 1 && (
          <>
            <ImpactGraph
              data={insight.data as ImpactGraphData}
              selectedNodeId={selectedNode?.id}
              onNodeClick={setSelectedNode}
              highlightedNodeIds={highlightedNodeIds ?? undefined}
            />
            {(insight.data as ImpactGraphData).summary && (
              <ImpactSummary
                summary={(insight.data as ImpactGraphData).summary}
              />
            )}
          </>
        )}
        {isKnowledgeGraph && insight && insight.data.nodes.length > 0 && (
          <KnowledgeGraph
            data={insight.data as KnowledgeGraphData}
            selectedNodeId={selectedNode?.id}
            onNodeClick={setSelectedNode}
            highlightedNodeIds={highlightedNodeIds ?? undefined}
          />
        )}

        {/* Node detail side panel (with inline lineage) */}
        {selectedNode && (
          <NodeDetail
            node={selectedNode}
            onClose={() => {
              setSelectedNode(null);
              setHighlightedNodeIds(null);
            }}
            onNavigate={handleNavigate}
            session={insight?.meta.session}
            onHighlightChange={(ids) => setHighlightedNodeIds(ids)}
          />
        )}

        {/* Empty result state */}
        {insight && insight.data.nodes.length <= 1 && !loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-3">🤷</div>
              <p className="text-slate-400 text-sm">
                {isImpactGraph
                  ? "No matching entities found in the knowledge graph."
                  : isKnowledgeGraph
                    ? "No entities found in the knowledge graph for this session."
                    : "No decisions found in the knowledge graph."}
              </p>
              <p className="text-slate-600 text-xs mt-1">
                Run{" "}
                <code className="bg-slate-800 px-1.5 py-0.5 rounded">
                  iw run
                </code>{" "}
                with{" "}
                <code className="bg-slate-800 px-1.5 py-0.5 rounded">
                  --persist
                </code>{" "}
                to populate the graph first.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      {insight && insight.data.nodes.length > 1 && (
        <Legend activeKinds={activeKinds} showSeverity={isImpactGraph || isKnowledgeGraph} />
      )}
    </div>
  );
}
