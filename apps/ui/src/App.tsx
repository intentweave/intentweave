// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import { QueryBar } from "./components/QueryBar.js";
import { DecisionTree } from "./components/DecisionTree.js";
import { Legend } from "./components/Legend.js";
import { MetaBar } from "./components/MetaBar.js";
import { NodeDetail } from "./components/NodeDetail.js";
import { fetchInsight, checkHealth } from "./api/insight.js";
import type { InsightResponse, InsightNode, NodeKind } from "./types.js";

export function App() {
  const [insight, setInsight] = useState<InsightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [selectedNode, setSelectedNode] = useState<InsightNode | null>(null);

  // Check backend health on mount
  useEffect(() => {
    checkHealth().then(setBackendUp);
  }, []);

  const handleQuery = useCallback(async (question: string) => {
    setLoading(true);
    setError(null);
    setSelectedNode(null);

    try {
      const result = await fetchInsight({
        question,
        vizType: "decision-tree",
      });
      setInsight(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setInsight(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Active node kinds for legend filtering
  const activeKinds = insight
    ? (new Set(insight.data.nodes.map((n) => n.kind)) as Set<NodeKind>)
    : undefined;

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
      <QueryBar onSubmit={handleQuery} loading={loading} />

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
                <div className="bg-slate-900 rounded-lg p-3 border border-slate-800">
                  <span className="text-violet-400 font-medium">
                    Decision Trees
                  </span>
                  <p className="mt-1">
                    Explore decisions, options, and rationale
                  </p>
                </div>
                <div className="bg-slate-900 rounded-lg p-3 border border-slate-800 opacity-50">
                  <span className="text-cyan-400 font-medium">
                    Impact Graphs
                  </span>
                  <p className="mt-1">Coming soon</p>
                </div>
                <div className="bg-slate-900 rounded-lg p-3 border border-slate-800 opacity-50">
                  <span className="text-emerald-400 font-medium">
                    Architecture
                  </span>
                  <p className="mt-1">Coming soon</p>
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
        {insight && insight.data.nodes.length > 1 && (
          <DecisionTree
            data={insight.data}
            selectedNodeId={selectedNode?.id}
            onNodeClick={setSelectedNode}
          />
        )}

        {/* Node detail side panel */}
        {selectedNode && (
          <NodeDetail
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
            onNavigate={handleNavigate}
          />
        )}

        {/* Empty result state */}
        {insight && insight.data.nodes.length <= 1 && !loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-3">🤷</div>
              <p className="text-slate-400 text-sm">
                No decisions found in the knowledge graph.
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
        <Legend activeKinds={activeKinds} />
      )}
    </div>
  );
}
