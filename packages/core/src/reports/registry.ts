// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue Registry
 *
 * Manages persistent issue IDs across runs.
 * Stores fingerprint -> ID mappings per session.
 */

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import type {
  IssueRegistry,
  IssueRegistryEntry,
  IssueKind,
  IssueFingerprint,
} from "./types.js";
import { EMPTY_ISSUE_REGISTRY } from "./types.js";
import { computeFingerprintHash, getIssuePrefix } from "./fingerprint.js";

/**
 * Get the path to the issue registry for a session.
 */
export function getIssueRegistryPath(
  iwDir: string,
  sessionKey: string,
): string {
  // Sanitize session key for filesystem
  const sanitized = sessionKey.replace(/[/:]/g, "_");
  return join(iwDir, "issues", `${sanitized}.json`);
}

/**
 * Load issue registry for a session.
 */
export async function loadIssueRegistry(
  iwDir: string,
  sessionKey: string,
): Promise<IssueRegistry> {
  const path = getIssueRegistryPath(iwDir, sessionKey);

  if (!existsSync(path)) {
    return { ...EMPTY_ISSUE_REGISTRY };
  }

  try {
    const content = await readFile(path, "utf-8");
    const data = JSON.parse(content) as IssueRegistry;

    // Ensure all required fields exist
    return {
      fingerprints: data.fingerprints ?? {},
      nextId: {
        C: data.nextId?.C ?? 1,
        O: data.nextId?.O ?? 1,
        N: data.nextId?.N ?? 1,
        E: data.nextId?.E ?? 1,
      },
    };
  } catch {
    return { ...EMPTY_ISSUE_REGISTRY };
  }
}

/**
 * Save issue registry for a session.
 */
export async function saveIssueRegistry(
  iwDir: string,
  sessionKey: string,
  registry: IssueRegistry,
): Promise<void> {
  const path = getIssueRegistryPath(iwDir, sessionKey);
  const dir = dirname(path);

  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * Result of looking up or allocating an issue ID.
 */
export interface IssueIdResult {
  id: string;
  issueKey: string;
  fingerprint: string;
  isNew: boolean;
  previousStatus?: "active" | "resolved";
}

/**
 * Look up or allocate an issue ID from the registry.
 *
 * @param registry - The issue registry (will be mutated)
 * @param sessionKey - Session key for issueKey construction
 * @param runId - Current run ID
 * @param fingerprintInputs - Fingerprint inputs for the issue
 * @returns Issue ID result
 */
export function getOrAllocateIssueId(
  registry: IssueRegistry,
  sessionKey: string,
  runId: string,
  fingerprintInputs: IssueFingerprint,
): IssueIdResult {
  const fingerprintHash = computeFingerprintHash(fingerprintInputs);
  const prefix = getIssuePrefix(fingerprintInputs.kind);
  const now = new Date().toISOString();

  const existing = registry.fingerprints[fingerprintHash];

  if (existing) {
    // Existing issue - update lastSeen
    const previousStatus = existing.resolved ? "resolved" : "active";

    // If was resolved, it's now regressed
    if (existing.resolved) {
      delete existing.resolved;
    }
    existing.lastSeen = now;

    return {
      id: existing.id,
      issueKey: `${sessionKey}#${existing.id}`,
      fingerprint: fingerprintHash,
      isNew: false,
      previousStatus,
    };
  }

  // New issue - allocate ID
  const num = registry.nextId[prefix];
  registry.nextId[prefix] = num + 1;

  const id = `${prefix}-${num}`;

  const entry: IssueRegistryEntry = {
    id,
    firstSeen: now,
    lastSeen: now,
  };
  registry.fingerprints[fingerprintHash] = entry;

  return {
    id,
    issueKey: `${sessionKey}#${id}`,
    fingerprint: fingerprintHash,
    isNew: true,
  };
}

/**
 * Mark issues as resolved if they weren't seen in the current run.
 *
 * @param registry - The issue registry (will be mutated)
 * @param seenFingerprints - Set of fingerprints seen in current run
 * @returns Number of issues marked as resolved
 */
export function markUnseenAsResolved(
  registry: IssueRegistry,
  seenFingerprints: Set<string>,
): number {
  const now = new Date().toISOString();
  let resolved = 0;

  for (const [fingerprint, entry] of Object.entries(registry.fingerprints)) {
    if (!seenFingerprints.has(fingerprint) && !entry.resolved) {
      entry.resolved = now;
      resolved++;
    }
  }

  return resolved;
}

/**
 * Get issue trend compared to previous state.
 */
export interface IssueTrendResult {
  newIssues: number;
  resolvedIssues: number;
  recurringIssues: number;
  regressedIssues: number;
}

export function computeIssueTrend(
  results: IssueIdResult[],
  newlyResolved: number,
): IssueTrendResult {
  let newIssues = 0;
  let recurringIssues = 0;
  let regressedIssues = 0;

  for (const result of results) {
    if (result.isNew) {
      newIssues++;
    } else if (result.previousStatus === "resolved") {
      regressedIssues++;
    } else {
      recurringIssues++;
    }
  }

  return {
    newIssues,
    resolvedIssues: newlyResolved,
    recurringIssues,
    regressedIssues,
  };
}
