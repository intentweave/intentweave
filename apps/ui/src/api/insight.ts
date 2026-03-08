// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { InsightResponse } from "../types.js";

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
