// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { NODE_COLORS, NODE_KIND_LABELS, EDGE_SEVERITY_COLORS, type NodeKind } from "../types.js";

const KINDS: NodeKind[] = [
  "topic",
  "decision",
  "chosen",
  "rejected",
  "option",
  "concept",
  "rationale",
  "risk",
  "center",
  "affected",
  // KWG+ / TCG overlay kinds
  "file",
  "commit",
  "author",
  "drift",
  // SCG layer kinds
  "directory",
  "symbol",
];

/** Severity items shown only for impact-graph views. */
const SEVERITY_ITEMS: { label: string; color: string }[] = [
  { label: "Critical", color: EDGE_SEVERITY_COLORS.critical },
  { label: "Warning", color: EDGE_SEVERITY_COLORS.warning },
  { label: "Info", color: EDGE_SEVERITY_COLORS.info },
];

interface LegendProps {
  /** Only show kinds that are actually present in the data. */
  activeKinds?: Set<NodeKind>;
  /** When true, also shows edge severity legend. */
  showSeverity?: boolean;
}

export function Legend({ activeKinds, showSeverity }: LegendProps) {
  const items = activeKinds ? KINDS.filter((k) => activeKinds.has(k)) : KINDS;

  return (
    <div className="flex flex-wrap gap-4 px-6 py-3 border-t border-slate-800 bg-slate-950/80">
      {items.map((kind) => (
        <div
          key={kind}
          className="flex items-center gap-2 text-xs text-slate-400"
        >
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ backgroundColor: NODE_COLORS[kind] }}
          />
          {NODE_KIND_LABELS[kind]}
        </div>
      ))}
      {showSeverity && (
        <>
          <div className="w-px bg-slate-700 mx-1 self-stretch" />
          {SEVERITY_ITEMS.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-2 text-xs text-slate-400"
            >
              <span
                className="inline-block w-6 h-0.5 rounded"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
