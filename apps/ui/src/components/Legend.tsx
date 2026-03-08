// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { NODE_COLORS, NODE_KIND_LABELS, type NodeKind } from "../types.js";

const KINDS: NodeKind[] = [
  "topic",
  "decision",
  "chosen",
  "rejected",
  "option",
  "concept",
  "rationale",
  "risk",
];

interface LegendProps {
  /** Only show kinds that are actually present in the data. */
  activeKinds?: Set<NodeKind>;
}

export function Legend({ activeKinds }: LegendProps) {
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
    </div>
  );
}
