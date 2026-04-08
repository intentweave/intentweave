// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: dependencyDepth (3.3)
 *
 * Compute transitive import depth per file. Flag files with excessive
 * fan-in (many dependents — high-risk to change) or fan-out (many
 * dependencies — fragile).
 */

import type Database from "better-sqlite3";
import type {
  DependencyDepthResult,
  DependencyDepthEntry,
} from "../types.js";
import { openIndex } from "./shared.js";

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
  // 1. Build directed graph from imports (resolve module_specifier if target_file is NULL)
  const edges = db
    .prepare(
      `
      SELECT DISTINCT source_file, target_file, module_specifier
      FROM imports
      WHERE is_relative = 1
    `,
    )
    .all() as Array<{
    source_file: string;
    target_file: string | null;
    module_specifier: string;
  }>;

  // Build a set of known file paths for resolution
  const knownFiles = new Set(
    (
      db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>
    ).map((r) => r.path),
  );

  // Forward graph: file → files it imports (outgoing / dependencies)
  const forward = new Map<string, Set<string>>();
  // Reverse graph: file → files that import it (incoming / dependents)
  const reverse = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of edges) {
    const target =
      edge.target_file ||
      resolveModuleSpecifier(
        edge.source_file,
        edge.module_specifier,
        knownFiles,
      );
    if (!target) continue;

    allFiles.add(edge.source_file);
    allFiles.add(target);

    if (!forward.has(edge.source_file)) {
      forward.set(edge.source_file, new Set());
    }
    forward.get(edge.source_file)!.add(target);

    if (!reverse.has(target)) {
      reverse.set(target, new Set());
    }
    reverse.get(target)!.add(edge.source_file);
  }

  // 2. Compute transitive closure + max depth via BFS for each file
  const files: DependencyDepthEntry[] = [];

  for (const file of allFiles) {
    const directDeps = forward.get(file)?.size ?? 0;
    const directDependents = reverse.get(file)?.size ?? 0;

    // Transitive forward (fan-out): all files reachable from this file
    const { reachable: transitiveDeps, maxDepth } = bfsReachable(
      file,
      forward,
    );

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
    reasons.push(`critical fan-in: ${transitiveDependents} transitive dependents`);
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

/**
 * Resolve a relative module_specifier to a known file path.
 * Tries the specifier as-is and with common extensions.
 */
function resolveModuleSpecifier(
  sourceFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  // Compute the directory of the source file
  const lastSlash = sourceFile.lastIndexOf("/");
  const dir = lastSlash >= 0 ? sourceFile.slice(0, lastSlash) : ".";

  // Normalise the specifier: join dir + specifier and collapse ../
  let resolved = specifier.startsWith("./") || specifier.startsWith("../")
    ? `${dir}/${specifier}`
    : specifier;

  // Collapse . and .. segments
  const parts = resolved.split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") {
      stack.pop();
    } else {
      stack.push(p);
    }
  }
  resolved = stack.join("/");

  // Try exact match first
  if (knownFiles.has(resolved)) return resolved;

  // Strip existing extension (e.g. .js) before trying alternatives
  const stripped = resolved.replace(/\.[jt]sx?$|\.[mc][jt]s$/, "");

  // Try common extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
  for (const ext of extensions) {
    if (knownFiles.has(stripped + ext)) return stripped + ext;
  }

  // Try index files (directory import)
  for (const ext of extensions) {
    if (knownFiles.has(`${stripped}/index${ext}`)) return `${stripped}/index${ext}`;
  }

  // Also try the unstripped path with extensions (in case no extension to strip)
  if (stripped !== resolved) {
    for (const ext of extensions) {
      if (knownFiles.has(resolved + ext)) return resolved + ext;
    }
  }

  return null;
}
