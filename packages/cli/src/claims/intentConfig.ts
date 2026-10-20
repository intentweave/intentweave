// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as path from "node:path";
import { load as yamlLoad } from "js-yaml";

/**
 * Intent Anchor evaluation mode (Phase G5.4). `off` skips anchors. `report` (default)
 * shows anchor outcomes and leaves exit codes unchanged. `gate` lets anchored conflicts
 * fail the check, and unresolved anchors make it inconclusive.
 */
export const INTENT_CONFIG_RELATIVE_PATH = ".iw/claims/intent.yaml";
export type IntentMode = "off" | "report" | "gate";

export interface IntentConfig {
  mode: IntentMode;
  /** Declared follow-ups (G5.4): intended statement changes, reviewed in the repository. */
  followUps: Array<{ claimIdentityId: string; statementFingerprint: string }>;
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export class IntentConfigError extends Error {}

export function parseIntentConfig(text: string): IntentConfig {
  const raw = yamlLoad(text);
  if (raw === undefined || raw === null)
    return { mode: "report", followUps: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new IntentConfigError("intent.yaml must be a mapping");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "schemaVersion" && key !== "mode" && key !== "followUps") {
      throw new IntentConfigError(`intent.yaml has unknown key ${key}`);
    }
  }
  if (record.schemaVersion !== undefined && record.schemaVersion !== "1") {
    throw new IntentConfigError('intent.yaml schemaVersion must be "1"');
  }
  const mode = record.mode ?? "report";
  if (mode !== "off" && mode !== "report" && mode !== "gate") {
    throw new IntentConfigError(
      "intent.yaml mode must be off, report, or gate",
    );
  }
  const followUps = parseFollowUps(record.followUps ?? []);
  return { mode, followUps };
}

function parseFollowUps(value: unknown): IntentConfig["followUps"] {
  if (!Array.isArray(value)) {
    throw new IntentConfigError("intent.yaml followUps must be a list");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new IntentConfigError(`followUps[${index}] must be a mapping`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "claimIdentityId" && key !== "statementFingerprint") {
        throw new IntentConfigError(
          `followUps[${index}] has unknown key ${key}`,
        );
      }
    }
    if (typeof record.claimIdentityId !== "string" || !record.claimIdentityId) {
      throw new IntentConfigError(
        `followUps[${index}].claimIdentityId is required`,
      );
    }
    if (
      typeof record.statementFingerprint !== "string" ||
      !FINGERPRINT_PATTERN.test(record.statementFingerprint)
    ) {
      throw new IntentConfigError(
        `followUps[${index}].statementFingerprint must be a 64-character lowercase hex digest`,
      );
    }
    return {
      claimIdentityId: record.claimIdentityId,
      statementFingerprint: record.statementFingerprint,
    };
  });
}

/**
 * The declared follow-ups that the change set introduces: those in the head configuration
 * and absent from the base configuration. A declaration that was already in place before the
 * change does not authorize it (G5.4 step 4).
 */
export function followUpsInChangeSet(
  head: IntentConfig["followUps"],
  base: IntentConfig["followUps"],
): IntentConfig["followUps"] {
  const inBase = new Set(
    base.map(
      (item) => `${item.claimIdentityId}\u0000${item.statementFingerprint}`,
    ),
  );
  return head.filter(
    (item) =>
      !inBase.has(`${item.claimIdentityId}\u0000${item.statementFingerprint}`),
  );
}

/** Parse `.iw/claims/intent.yaml` text; undefined text means no file, so no declarations. */
export function parseIntentConfigAt(text: string | undefined): IntentConfig {
  return text === undefined
    ? { mode: "report", followUps: [] }
    : parseIntentConfig(text);
}

/** Read `.iw/claims/intent.yaml`. A missing file means the default mode, `report`. */
export function readIntentConfig(workspaceRoot: string): IntentConfig {
  const file = path.join(workspaceRoot, INTENT_CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(file)) return { mode: "report", followUps: [] };
  return parseIntentConfig(fs.readFileSync(file, "utf-8"));
}
