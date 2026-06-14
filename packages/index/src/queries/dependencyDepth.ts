// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: dependencyDepth (3.3)
 *
 * Compute transitive import depth per file. Flag files with excessive
 * fan-in (many dependents — high-risk to change) or fan-out (many
 * dependencies — fragile).
 */

import type Database from "@intentweave/sqlite-compat";
import type { DependencyDepthResult, DependencyDepthEntry } from "../types.js";
import { openIndex, buildImportGraph } from "./shared.js";

/** Fan-in threshold for "high" risk. */
const HIGH_FAN_IN = 10;
/** Fan-out threshold for "high" risk. */
const HIGH_FAN_OUT = 10;
/** Fan-in threshold for "critical" risk. */
const CRITICAL_FAN_IN = 20;
/** Fan-out threshold for "critical" risk. */
const CRITICAL_FAN_OUT = 20;

/**
 * Compute dependency depth metrics for all files in the import graph.
 */
export function dependencyDepth(dbPath: string): DependencyDepthResult {
  const db = openIndex(dbPath);
  try {
    return dependencyDepthFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core dependency depth logic against an open database.
 */
export function dependencyDepthFromDb(
  db: Database.Database,
): DependencyDepthResult {
  const { forward, reverse, allFiles } = buildImportGraph(db);
  const files: DependencyDepthEntry[] = [];

  for (const file of allFiles) {
    const directDeps = forward.get(file)?.size ?? 0;
    const directDependents = reverse.get(file)?.size ?? 0;

    // Transitive forward (fan-out): all files reachable from this file
    const { reachable: transitiveDeps, maxDepth } = bfsReachable(file, forward);

    // Transitive reverse (fan-in): all files that can reach this file
    const { reachable: transitiveDependents } = bfsReachable(file, reverse);

    // Assess risk
    const { risk, reason } = assessRisk(
      directDependents,
      transitiveDependents,
      directDeps,
      transitiveDeps,
    );

    files.push({
      filePath: file,
      directDependencies: directDeps,
      transitiveDependencies: transitiveDeps,
      directDependents,
      transitiveDependents,
      maxDepth,
      risk,
      reason,
    });
  }

  // Sort: critical first, then high, medium, low; within same risk by transitiveDependents desc
  const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  files.sort(
    (a, b) =>
      riskOrder[a.risk] - riskOrder[b.risk] ||
      b.transitiveDependents - a.transitiveDependents,
  );

  const highRiskCount = files.filter(
    (f) => f.risk === "high" || f.risk === "critical",
  ).length;

  return { files, totalFiles: files.length, highRiskCount };
}

/**
 * BFS from a starting node. Returns count of reachable nodes (excluding start)
 * and the maximum depth.
 */
function bfsReachable(
  start: string,
  graph: Map<string, Set<string>>,
): { reachable: number; maxDepth: number } {
  const visited = new Set<string>();
  visited.add(start);
  let queue = [start];
  let maxDepth = 0;

  while (queue.length > 0) {
    const next: string[] = [];
    for (const node of queue) {
      const neighbours = graph.get(node);
      if (!neighbours) continue;
      for (const n of neighbours) {
        if (!visited.has(n)) {
          visited.add(n);
          next.push(n);
        }
      }
    }
    if (next.length > 0) {
      maxDepth++;
    }
    queue = next;
  }

  return { reachable: visited.size - 1, maxDepth };
}

/**
 * Assess risk based on fan-in and fan-out metrics.
 */
function assessRisk(
  directDependents: number,
  transitiveDependents: number,
  directDeps: number,
  transitiveDeps: number,
): { risk: "low" | "medium" | "high" | "critical"; reason: string } {
  const reasons: string[] = [];

  // Fan-in risk (many dependents → changes here affect many files)
  if (transitiveDependents >= CRITICAL_FAN_IN) {
    reasons.push(
      `critical fan-in: ${transitiveDependents} transitive dependents`,
    );
  } else if (transitiveDependents >= HIGH_FAN_IN) {
    reasons.push(`high fan-in: ${transitiveDependents} transitive dependents`);
  } else if (directDependents >= 5) {
    reasons.push(`moderate fan-in: ${directDependents} direct dependents`);
  }

  // Fan-out risk (many dependencies → fragile, changes elsewhere break this)
  if (transitiveDeps >= CRITICAL_FAN_OUT) {
    reasons.push(`critical fan-out: ${transitiveDeps} transitive dependencies`);
  } else if (transitiveDeps >= HIGH_FAN_OUT) {
    reasons.push(`high fan-out: ${transitiveDeps} transitive dependencies`);
  } else if (directDeps >= 5) {
    reasons.push(`moderate fan-out: ${directDeps} direct dependencies`);
  }

  if (reasons.length === 0) {
    return { risk: "low", reason: "within normal thresholds" };
  }

  // Determine overall risk level
  const hasCritical = reasons.some((r) => r.startsWith("critical"));
  const hasHigh = reasons.some((r) => r.startsWith("high"));

  let risk: "low" | "medium" | "high" | "critical";
  if (hasCritical) {
    risk = "critical";
  } else if (hasHigh) {
    risk = "high";
  } else {
    risk = "medium";
  }

  return { risk, reason: reasons.join("; ") };
}
