// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in local session log.
 *
 * Disabled by default. When a workspace turns it on via `.iw/config.yaml`
 * (`sessionLog: true`), confidence/score-bearing CARI queries append one
 * JSON line per invocation to `.iw/sessions/<YYYY-MM-DD>.jsonl` — nothing is
 * ever transmitted anywhere. This is a deliberately simple, human-readable
 * signal (which query type ran, with what confidence, when) meant to be
 * reviewed by a maintainer later — not an automatic runtime adaptation.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

/** One line written to `.iw/sessions/<date>.jsonl`. */
export interface SessionLogEntry {
  /** ISO-8601 timestamp of the invocation. */
  ts: string;
  /** Which surface the query came through. */
  surface: "cli" | "mcp";
  /** Tool / command name, e.g. `"index retrieve"` or `"cari_retrieve"`. */
  tool: string;
  /** Session identifier — `IW_SESSION` env var / `--session` flag, or `"default"`. */
  sessionId: string;
  /**
   * A representative confidence/score for this invocation, if the query
   * naturally produces one. Scale varies by tool (0–1 for retrieve/connections,
   * 0–100 for verify/consistency/livingScore/arch-check percentages) — this
   * log is for qualitative human review, not cross-tool numeric comparison.
   */
  confidence?: number;
  /** Number of results/findings/entities returned, if applicable. */
  resultCount?: number;
  /** Wall-clock duration of the query, in milliseconds. */
  durationMs?: number;
}

export interface LogSessionEventInput {
  /**
   * Whether session logging is enabled for this workspace (caller resolves
   * this from `.iw/config.yaml`'s `sessionLog` field).
   */
  enabled: boolean;
  /** Workspace root containing the `.iw/` directory. */
  workspaceRoot: string;
  surface: SessionLogEntry["surface"];
  tool: string;
  sessionId?: string;
  confidence?: number;
  resultCount?: number;
  durationMs?: number;
}

/**
 * Append one entry to the session log. No-op when `enabled` is false.
 * Never throws — session logging must never break a query call.
 */
export async function logSessionEvent(
  input: LogSessionEventInput,
): Promise<void> {
  if (!input.enabled) return;
  try {
    const ts = new Date().toISOString();
    const entry: SessionLogEntry = {
      ts,
      surface: input.surface,
      tool: input.tool,
      sessionId: input.sessionId ?? process.env.IW_SESSION ?? "default",
      confidence: input.confidence,
      resultCount: input.resultCount,
      durationMs: input.durationMs,
    };
    const dir = path.join(input.workspaceRoot, ".iw", "sessions");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${ts.slice(0, 10)}.jsonl`);
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Session logging must never break a query call.
  }
}
