// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { InsightMeta } from "../types.js";

interface MetaBarProps {
  meta: InsightMeta;
  title: string;
}

export function MetaBar({ meta, title }: MetaBarProps) {
  return (
    <div className="flex items-center justify-between px-6 py-2 border-b border-slate-800 bg-slate-900/50">
      <span className="text-sm font-medium text-slate-300">{title}</span>
      <div className="flex gap-4 text-xs text-slate-500">
        <span>{meta.entityCount} nodes</span>
        <span>{meta.edgeCount} edges</span>
        <span>{meta.queryTimeMs}ms</span>
        <span className="text-slate-600">session: {meta.session}</span>
      </div>
    </div>
  );
}
