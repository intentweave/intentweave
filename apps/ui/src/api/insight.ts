// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { InsightResponse, LineageResponse } from "../types.js";

const BASE = "/api";

export interface InsightRequest {
  question?: string;
  vizType?: string;
  session?: string;
  maxNodes?: number;
}

/**
 * Call POST /api/insight and return the structured visualization data.
 */
export async function fetchInsight(
  req: InsightRequest,
): Promise<InsightResponse> {
  const res = await fetch(`${BASE}/insight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ??
        `Insight request failed (${res.status})`,
    );
  }

  return res.json() as Promise<InsightResponse>;
}

/**
 * Check if the backend is reachable.
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch("/health", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch available sessions from the server.
 */
export interface SessionInfo {
  id: string;
  canonCount: number;
  kwgCount: number;
  tcgCount: number;
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  try {
    const res = await fetch(`${BASE}/sessions`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { sessions: SessionInfo[] };
    return body.sessions ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch lineage for a single Canon entity — traces back through
 * raw triples to original source documents.
 */
export async function fetchLineage(
  canonId: string,
  session?: string,
): Promise<LineageResponse> {
  const params = new URLSearchParams();
  if (session) params.set("session", session);
  const qs = params.toString();
  const url = `${BASE}/insight/lineage/${encodeURIComponent(canonId)}${qs ? `?${qs}` : ""}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ??
        `Lineage request failed (${res.status})`,
    );
  }

  return res.json() as Promise<LineageResponse>;
}
