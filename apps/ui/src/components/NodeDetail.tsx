// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * NodeDetail — slide-in side panel showing full details for a selected node.
 *
 * Displays: kind badge, description, confidence bar, lineage (auto-fetched),
 * aliases, source document, run ID, raw triples, and connections list.
 */

import { useState, useEffect } from "react";
import type {
  InsightNode,
  InsightConnection,
  InsightRawTriple,
  LineageResponse,
} from "../types.js";
import { NODE_COLORS, NODE_KIND_LABELS, PREDICATE_LABELS } from "../types.js";
import { fetchLineage } from "../api/insight.js";

/** Format an ISO/Neo4j datetime string to a human-readable form. */
function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

/** Human-readable predicate phrase. */
function humanPredicate(pred: string): string {
  return PREDICATE_LABELS[pred] ?? pred.toLowerCase().replace(/_/g, " ");
}

/** Format a raw triple as a human-readable sentence. */
function tripleToSentence(t: InsightRawTriple): string {
  const pred = humanPredicate(t.predicate);
  return `${t.subject} ${pred} ${t.object}`;
}

interface NodeDetailProps {
  node: InsightNode;
  onClose: () => void;
  onNavigate?: (nodeId: string) => void;
  /** Session ID for fetching lineage data. */
  session?: string;
  /** Called when lineage data loads — provides node IDs to highlight on the graph. */
  onHighlightChange?: (nodeIds: Set<string> | null) => void;
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

export function NodeDetail({
  node,
  onClose,
  onNavigate,
  session,
  onHighlightChange,
}: NodeDetailProps) {
  const kindColor = NODE_COLORS[node.kind];
  const kindLabel = NODE_KIND_LABELS[node.kind];
  const connections = node.connections ?? [];
  const grouped = groupConnections(connections);

  // Auto-fetch lineage data
  const [lineage, setLineage] = useState<LineageResponse | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageError, setLineageError] = useState<string | null>(null);

  const isRealEntity = node.id !== "__root__" && node.id !== "__empty__";

  useEffect(() => {
    if (!isRealEntity) return;

    let cancelled = false;
    setLineageLoading(true);
    setLineageError(null);
    setLineage(null);

    fetchLineage(node.id, session)
      .then((res) => {
        if (!cancelled) {
          setLineage(res);
          // Build highlight set for graph
          const ids = new Set<string>();
          ids.add(node.id);
          for (const rel of res.canonRelations) {
            ids.add(rel.otherCanonId);
          }
          onHighlightChange?.(ids);
        }
      })
      .catch((err) => {
        if (!cancelled)
          setLineageError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLineageLoading(false);
      });

    return () => {
      cancelled = true;
      onHighlightChange?.(null);
    };
  }, [node.id, session]);

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
            {node.entityType && node.entityType !== node.kind && (
              <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                {node.entityType}
              </span>
            )}
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
        {/* Description — synthesized from raw triples */}
        {node.description && (
          <Section label="Description">
            <p className="text-slate-300 text-[12px] leading-relaxed">
              {node.description}
            </p>
          </Section>
        )}

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

        {/* ── Lineage (auto-fetched) ──────────────────────────────────── */}
        {isRealEntity && (
          <div className="space-y-3">
            {/* Hop 1: KG Layer */}
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400">
                KG Layer
              </span>
              <div className="flex-1 h-px bg-slate-800" />
            </div>

            {lineageLoading && (
              <div className="text-slate-600 text-[11px] animate-pulse pl-3">
                Loading lineage…
              </div>
            )}

            {lineageError && (
              <div className="text-red-500 text-[10px] pl-3">
                {lineageError}
              </div>
            )}

            {/* Canonical Relationships */}
            {lineage && lineage.canonRelations.length > 0 && (
              <Section
                label={`Relationships (${lineage.canonRelations.length})`}
              >
                <div className="space-y-1">
                  {lineage.canonRelations.map((rel, i) => {
                    const arrow = rel.direction === "outgoing" ? "→" : "←";
                    const predLabel = humanPredicate(rel.predicate);
                    return (
                      <div
                        key={i}
                        className="bg-slate-800/30 rounded px-2 py-1.5 space-y-0.5"
                      >
                        <div className="flex items-center gap-1.5 text-[11px]">
                          <span className="text-slate-500">{arrow}</span>
                          <span className="text-amber-400">{predLabel}</span>
                          <button
                            onClick={() => onNavigate?.(rel.otherCanonId)}
                            className="text-indigo-400 hover:text-indigo-300 hover:underline font-medium truncate"
                            title={`Navigate to ${rel.otherName}`}
                          >
                            {rel.otherName}
                          </button>
                          {rel.otherType && (
                            <span className="text-[9px] text-slate-600 bg-slate-800 px-1 py-0.5 rounded">
                              {rel.otherType}
                            </span>
                          )}
                        </div>
                        {(rel.rawPredicate || rel.confidence != null) && (
                          <div className="flex gap-3 text-[9px] text-slate-600">
                            {rel.rawPredicate &&
                              rel.rawPredicate !== rel.predicate && (
                                <span>
                                  raw:{" "}
                                  <span className="italic text-slate-500">
                                    {rel.rawPredicate}
                                  </span>
                                </span>
                              )}
                            {rel.confidence != null && (
                              <span>
                                conf: {(rel.confidence * 100).toFixed(0)}%
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* Raw Triples with rationale */}
            {lineage && lineage.triples.length > 0 && (
              <Section label={`Evidence (${lineage.triples.length} triples)`}>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {lineage.triples.map((t, i) => (
                    <div
                      key={i}
                      className="bg-slate-800/30 rounded px-2 py-1.5 space-y-0.5"
                    >
                      <div className="text-[11px] leading-relaxed">
                        <span className="text-cyan-400">{t.subject}</span>
                        <span className="text-slate-500 mx-1">
                          {humanPredicate(t.predicate)}
                        </span>
                        <span className="text-emerald-400">{t.object}</span>
                      </div>
                      <div className="flex flex-wrap gap-2 text-[9px] text-slate-600">
                        {t.confidence != null && (
                          <span>conf: {(t.confidence * 100).toFixed(0)}%</span>
                        )}
                        {t.sourceFile && (
                          <span
                            className="font-mono truncate max-w-[180px]"
                            title={t.sourceFile}
                          >
                            📄 {t.sourceFile}
                          </span>
                        )}
                      </div>
                      {t.rationale && (
                        <div className="text-[9px] text-amber-600 italic">
                          💡 {t.rationale}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Hop 2: Source Layer */}
            {lineage && lineage.sources.length > 0 && (
              <>
                <div className="flex items-center gap-2 mt-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">
                    Source Layer
                  </span>
                  <div className="flex-1 h-px bg-slate-800" />
                </div>
                <Section label={`Source Documents (${lineage.sources.length})`}>
                  <div className="space-y-1">
                    {lineage.sources.map((s, i) => (
                      <div
                        key={i}
                        className="bg-slate-800/30 rounded px-2 py-1.5 space-y-0.5"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="text-emerald-400 text-[11px]">
                            📄
                          </span>
                          <span className="text-slate-200 text-[11px] font-mono break-all">
                            {s.sourceFile}
                          </span>
                        </div>
                        <div className="text-[9px] text-slate-500">
                          {s.tripleCount} triple{s.tripleCount !== 1 ? "s" : ""}{" "}
                          · {s.predicates.map(humanPredicate).join(", ")}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              </>
            )}

            {/* Lineage empty state */}
            {lineage &&
              lineage.canonRelations.length === 0 &&
              lineage.triples.length === 0 &&
              lineage.sources.length === 0 && (
                <p className="text-slate-600 italic text-[10px] pl-3">
                  No lineage data found for this entity.
                </p>
              )}
          </div>
        )}

        {/* Source Document */}
        {node.sourceDoc && (
          <Section label="Source Document">
            <span className="text-slate-300 font-mono text-[11px] break-all">
              {node.sourceDoc}
            </span>
          </Section>
        )}

        {/* Impact depth (for impact-graph nodes) */}
        {node.depth != null && (
          <Section label="Impact Distance">
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold"
                style={{
                  backgroundColor:
                    node.depth === 0
                      ? "#ec4899"
                      : node.depth === 1
                        ? "#6366f1"
                        : "#475569",
                  color: "#fff",
                }}
              >
                {node.depth}
              </span>
              <span className="text-slate-400 text-[11px]">
                {node.depth === 0
                  ? "Center — directly queried"
                  : node.depth === 1
                    ? "Direct impact (1 hop)"
                    : `Ripple effect (${node.depth} hops)`}
              </span>
            </div>
          </Section>
        )}

        {/* Timestamps */}
        {(node.createdAt || node.updatedAt) && (
          <Section label="Timeline">
            <div className="space-y-0.5">
              {node.createdAt && (
                <div className="flex items-center gap-1.5">
                  <span className="text-emerald-500 text-[10px]">●</span>
                  <span className="text-slate-500 text-[10px]">Created</span>
                  <span className="text-slate-300 text-[11px]">
                    {formatTimestamp(node.createdAt)}
                  </span>
                </div>
              )}
              {node.updatedAt && (
                <div className="flex items-center gap-1.5">
                  <span className="text-amber-500 text-[10px]">●</span>
                  <span className="text-slate-500 text-[10px]">Updated</span>
                  <span className="text-slate-300 text-[11px]">
                    {formatTimestamp(node.updatedAt)}
                  </span>
                </div>
              )}
            </div>
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
              <span className="text-slate-500 text-[11px]">
                in decision sequence
              </span>
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

        {/* Raw Triples (provenance) */}
        {node.rawTriples && node.rawTriples.length > 0 && (
          <Section label={`Knowledge (${node.rawTriples.length} facts)`}>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {node.rawTriples.map((t, i) => (
                <div
                  key={i}
                  className="bg-slate-800/50 rounded px-2 py-1.5 text-[11px] leading-relaxed"
                >
                  <div className="text-slate-300">{tripleToSentence(t)}</div>
                  <div className="text-[9px] text-slate-600 mt-0.5 font-mono">
                    {t.subject} → {t.predicate} → {t.object}
                  </div>
                </div>
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
          !node.description &&
          !node.rawTriples?.length &&
          node.confidence == null && (
            <p className="text-slate-600 italic text-[11px]">
              No additional context. Run the pipeline with more documents to
              enrich this entity.
            </p>
          )}
      </div>

      {/* Footer: Node ID */}
      <div className="px-4 py-2 border-t border-slate-800">
        <div className="text-[10px] text-slate-600 font-mono truncate">
          {node.id}
        </div>
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
