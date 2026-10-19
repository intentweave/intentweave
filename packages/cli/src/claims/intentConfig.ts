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
}

export class IntentConfigError extends Error {}

export function parseIntentConfig(text: string): IntentConfig {
  const raw = yamlLoad(text);
  if (raw === undefined || raw === null) return { mode: "report" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new IntentConfigError("intent.yaml must be a mapping");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "schemaVersion" && key !== "mode") {
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
  return { mode };
}

/** Read `.iw/claims/intent.yaml`. A missing file means the default mode, `report`. */
export function readIntentConfig(workspaceRoot: string): IntentConfig {
  const file = path.join(workspaceRoot, INTENT_CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(file)) return { mode: "report" };
  return parseIntentConfig(fs.readFileSync(file, "utf-8"));
}
