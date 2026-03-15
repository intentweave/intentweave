// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import type { VizType } from "../types.js";

/** Preset queries for decision-tree exploration. */
const DECISION_PRESETS = [
  { label: "All decisions", question: "Show all decisions" },
  { label: "Architecture", question: "What architecture decisions were made?" },
  { label: "Technology", question: "What technology choices were made?" },
  {
    label: "Trade-offs",
    question: "What trade-offs and risks were identified?",
  },
];

/** Preset queries for impact-graph exploration. */
const IMPACT_PRESETS = [
  { label: "Authentication", question: "authentication" },
  { label: "Database", question: "database" },
  { label: "API", question: "API" },
  { label: "Security", question: "security" },
];

/** Preset queries for full knowledge graph exploration. */
const KG_PRESETS = [
  { label: "Full Graph", question: "*" },
  { label: "Decisions", question: "decision" },
  { label: "Components", question: "component" },
  { label: "Risks", question: "risk" },
];

interface QueryBarProps {
  onSubmit: (question: string, vizType?: VizType) => void;
  loading: boolean;
  vizType: VizType;
}

export function QueryBar({ onSubmit, loading, vizType }: QueryBarProps) {
  const [value, setValue] = useState("");

  const presets =
    vizType === "knowledge-graph"
      ? KG_PRESETS
      : vizType === "impact-graph"
        ? IMPACT_PRESETS
        : DECISION_PRESETS;
  const placeholder =
    vizType === "knowledge-graph"
      ? "Filter entities (or * for full graph)…"
      : vizType === "impact-graph"
        ? "Enter an entity name to analyze impact…"
        : "Ask a question about your knowledge graph…";

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (q) onSubmit(q);
  };

  const handlePreset = (question: string) => {
    setValue(question);
    onSubmit(question);
  };

  return (
    <div className="px-6 py-4 border-b border-slate-800">
      <form onSubmit={handleSubmit} className="flex gap-3">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="flex-1 rounded-lg bg-slate-800 px-4 py-2.5 text-sm text-slate-100
                     placeholder-slate-500 border border-slate-700
                     focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500
                     transition-colors"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !value.trim()}
          className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white
                     hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed
                     transition-colors"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <Spinner />
              Generating…
            </span>
          ) : (
            "Visualize"
          )}
        </button>
      </form>

      {/* Preset buttons */}
      <div className="mt-3 flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => handlePreset(p.question)}
            disabled={loading}
            className="rounded-md bg-slate-800 px-3 py-1.5 text-xs text-slate-400
                       hover:bg-slate-700 hover:text-slate-200 border border-slate-700
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
