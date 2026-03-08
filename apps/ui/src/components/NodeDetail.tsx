// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * NodeDetail — slide-in side panel showing full details for a selected node.
 *
 * Displays: kind badge, confidence bar, aliases, source document,
 * run ID, and connections list grouped by predicate.
 */

import type { InsightNode, InsightConnection } from "../types.js";
import {
  NODE_COLORS,
  NODE_KIND_LABELS,
  PREDICATE_LABELS,
} from "../types.js";

interface NodeDetailProps {
  node: InsightNode;
  onClose: () => void;
  onNavigate?: (nodeId: string) => void;
}

/** Group connections by predicate for clean display. */
function groupConnections(
  connections: InsightConnection[],
): Map<string, InsightConnection[]> {
  const grouped = new Map<string, InsightConnection[]>();
  for (const conn of connections) {
    const key = `${conn.direction}:${conn.predicate}`;
    let list = grouped.get(key);
    if (!list) {
      list = [];
      grouped.set(key, list);
    }
    list.push(conn);
  }
  return grouped;
}

export function NodeDetail({ node, onClose, onNavigate }: NodeDetailProps) {
  const kindColor = NODE_COLORS[node.kind];
  const kindLabel = NODE_KIND_LABELS[node.kind];
  const connections = node.connections ?? [];
  const grouped = groupConnections(connections);

  return (
    <div className="absolute right-0 top-0 bottom-0 w-80 bg-slate-900 border-l border-slate-800 shadow-2xl z-20 flex flex-col overflow-hidden animate-slide-in">
      {/* Header */}
      <div className="flex items-start justify-between p-4 border-b border-slate-800">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-slate-100 break-words leading-tight">
            {node.label}
          </h3>
          <div className="flex items-center gap-2 mt-1.5">
            <span
              className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: kindColor + "1A",
                color: kindColor,
              }}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: kindColor }}
              />
              {kindLabel}
            </span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-300 ml-2 mt-0.5 text-lg leading-none"
          aria-label="Close details"
        >
          ✕
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {/* Confidence */}
        {node.confidence != null && (
          <Section label="Confidence">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${node.confidence * 100}%`,
                    backgroundColor: kindColor,
                  }}
                />
              </div>
              <span className="text-slate-400 tabular-nums">
                {(node.confidence * 100).toFixed(0)}%
              </span>
            </div>
          </Section>
        )}

        {/* Source Document */}
        {node.sourceDoc && (
          <Section label="Source Document">
            <span className="text-slate-300 font-mono text-[11px] break-all">
              {node.sourceDoc}
            </span>
          </Section>
        )}

        {/* Run ID — temporal indicator */}
        {node.runId && (
          <Section label="Run ID">
            <div className="flex items-center gap-2">
              <span className="text-slate-300 font-mono text-[11px]">
                {node.runId}
              </span>
              {node.temporalOrder != null && (
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-indigo-100 text-[10px] font-bold">
                  #{node.temporalOrder}
                </span>
              )}
            </div>
          </Section>
        )}

        {/* Temporal order (if no runId but temporalOrder exists) */}
        {!node.runId && node.temporalOrder != null && (
          <Section label="Temporal Order">
            <span className="inline-flex items-center gap-1 text-slate-300">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-indigo-100 text-[10px] font-bold">
                #{node.temporalOrder}
              </span>
              <span className="text-slate-500 text-[11px]">in decision sequence</span>
            </span>
          </Section>
        )}

        {/* Aliases */}
        {node.aliases && node.aliases.length > 0 && (
          <Section label="Aliases">
            <div className="flex flex-wrap gap-1">
              {node.aliases.map((alias) => (
                <span
                  key={alias}
                  className="bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded text-[11px]"
                >
                  {alias}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Connections */}
        {connections.length > 0 && (
          <Section label={`Connections (${connections.length})`}>
            <div className="space-y-2">
              {Array.from(grouped.entries()).map(([key, conns]) => {
                const [direction, predicate] = key.split(":") as [
                  "incoming" | "outgoing",
                  string,
                ];
                const predicateLabel =
                  PREDICATE_LABELS[predicate] ??
                  predicate.toLowerCase().replace(/_/g, " ");
                const arrow = direction === "outgoing" ? "→" : "←";

                return (
                  <div key={key}>
                    <div className="text-slate-500 mb-0.5">
                      {arrow} {predicateLabel}
                    </div>
                    {conns.map((conn) => (
                      <button
                        key={conn.targetId}
                        onClick={() => onNavigate?.(conn.targetId)}
                        className="block w-full text-left text-slate-300 hover:text-indigo-400 hover:bg-slate-800/60 rounded px-1.5 py-0.5 transition-colors truncate"
                        title={conn.targetLabel}
                      >
                        {conn.targetLabel}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* Empty state */}
        {connections.length === 0 &&
          !node.aliases?.length &&
          !node.sourceDoc &&
          !node.runId &&
          node.confidence == null && (
            <p className="text-slate-600 italic">
              No additional details available.
            </p>
          )}
      </div>

      {/* Node ID footer */}
      <div className="px-4 py-2 border-t border-slate-800 text-[10px] text-slate-600 font-mono truncate">
        {node.id}
      </div>
    </div>
  );
}

// ── Small helpers ────────────────────────────────────────────────────────────

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}
