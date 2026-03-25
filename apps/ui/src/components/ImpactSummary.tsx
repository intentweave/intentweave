// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * ImpactSummary — collapsible panel showing structured impact analysis results.
 *
 * Displays: headline stats banner, risk/decision/dependency chains grouped
 * by severity, and copyable RAG context lines for agent consumption.
 */

import { useState } from "react";
import type {
  ImpactSummary as ImpactSummaryType,
  ImpactChain,
} from "../types.js";
import { EDGE_SEVERITY_COLORS } from "../types.js";

interface ImpactSummaryProps {
  summary: ImpactSummaryType;
}

/** Severity badge component. */
function SeverityBadge({ severity }: { severity: ImpactChain["severity"] }) {
  const color = EDGE_SEVERITY_COLORS[severity];
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded"
      style={{ backgroundColor: color + "1A", color }}
    >
      {severity}
    </span>
  );
}

/** Collapsible chain section with severity-colored items. */
function ChainSection({
  title,
  chains,
  icon,
  defaultOpen = false,
}: {
  title: string;
  chains: ImpactChain[];
  icon: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (chains.length === 0) return null;

  return (
    <div className="border-t border-slate-800">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-left text-xs font-medium text-slate-300 hover:bg-slate-800/40 transition-colors"
      >
        <span className="text-sm">{icon}</span>
        <span className="flex-1">{title}</span>
        <span className="text-slate-500 tabular-nums">{chains.length}</span>
        <span
          className="text-slate-500 transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-1.5">
          {chains.map((chain, i) => (
            <div
              key={i}
              className="flex items-start gap-2 text-xs text-slate-400 pl-2 border-l-2"
              style={{
                borderColor: EDGE_SEVERITY_COLORS[chain.severity] + "60",
              }}
            >
              <SeverityBadge severity={chain.severity} />
              <span className="break-words leading-relaxed">{chain.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ImpactSummary({ summary }: ImpactSummaryProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [contextCopied, setContextCopied] = useState(false);

  const { stats } = summary;
  const hasChains =
    summary.riskChains.length > 0 ||
    summary.decisionChains.length > 0 ||
    summary.dependencyChains.length > 0;

  const handleCopyContext = async () => {
    const text = summary.contextLines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setContextCopied(true);
      setTimeout(() => setContextCopied(false), 2000);
    } catch {
      // Fallback: select-all in a hidden textarea
    }
  };

  return (
    <div className="absolute left-4 top-4 bottom-4 w-80 bg-slate-900/95 backdrop-blur-sm border border-slate-800 rounded-lg shadow-2xl z-10 flex flex-col overflow-hidden animate-slide-in">
      {/* Header with collapse toggle */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <h3 className="text-xs font-semibold text-slate-200 tracking-wide uppercase">
          Impact Summary
        </h3>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-slate-500 hover:text-slate-300 text-xs"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto">
          {/* Headline */}
          <div className="px-4 py-3 text-xs text-slate-300 leading-relaxed border-b border-slate-800">
            <span
              dangerouslySetInnerHTML={{
                __html: summary.headline.replace(
                  /\*\*(.+?)\*\*/g,
                  '<strong class="text-slate-100">$1</strong>',
                ),
              }}
            />
          </div>

          {/* Stats banner */}
          <div className="grid grid-cols-2 gap-px bg-slate-800 border-b border-slate-800">
            <StatCell
              label="Direct"
              value={stats.directCount}
              color="#3b82f6"
            />
            <StatCell
              label="Ripple"
              value={stats.rippleCount}
              color="#8b5cf6"
            />
            <StatCell label="Risks" value={stats.riskCount} color="#ef4444" />
            <StatCell
              label="Decisions"
              value={stats.decisionCount}
              color="#f59e0b"
            />
          </div>
          <div className="px-4 py-1.5 border-b border-slate-800">
            <span className="text-[10px] text-slate-500">
              {stats.totalRelationships} relationship
              {stats.totalRelationships !== 1 ? "s" : ""} total
            </span>
          </div>

          {/* Chain sections */}
          {hasChains && (
            <div>
              <ChainSection
                title="Risks & Blockers"
                chains={summary.riskChains}
                icon="🔴"
                defaultOpen={true}
              />
              <ChainSection
                title="Related Decisions"
                chains={summary.decisionChains}
                icon="🟡"
              />
              <ChainSection
                title="Dependencies"
                chains={summary.dependencyChains}
                icon="🔗"
              />
            </div>
          )}

          {/* No chains fallback */}
          {!hasChains && stats.totalRelationships > 0 && (
            <div className="px-4 py-3 text-xs text-slate-500 italic">
              All relationships are informational — no critical chains detected.
            </div>
          )}

          {/* RAG Context Lines */}
          {summary.contextLines.length > 0 && (
            <div className="border-t border-slate-800">
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs font-medium text-slate-400">
                  📋 RAG Context
                </span>
                <button
                  onClick={handleCopyContext}
                  className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-300 transition-colors"
                >
                  {contextCopied ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <pre className="px-4 pb-3 text-[10px] text-slate-500 leading-relaxed whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                {summary.contextLines.join("\n")}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Individual stat cell for the 2x2 grid. */
function StatCell({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-slate-900 px-4 py-2.5 flex items-baseline gap-2">
      <span
        className="text-base font-bold tabular-nums"
        style={{ color: value > 0 ? color : "#475569" }}
      >
        {value}
      </span>
      <span className="text-[10px] text-slate-500 uppercase tracking-wide">
        {label}
      </span>
    </div>
  );
}
