// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  parsePortableClaimsState,
  type PortableClaimsState,
} from "@intentweave/index";
import { JSON_SCHEMA, dump as yamlDump, load as yamlLoad } from "js-yaml";

export const CLAIMS_PORTABLE_STATE_RELATIVE_PATH = ".iw/claims/state.yaml";

const FILE_HEADER = [
  "# IntentWeave portable Claims governance state.",
  "# This file is the Git-tracked source of effective decisions; .iw/index.db is the runtime projection.",
  "",
].join("\n");

export class ClaimsPortableStateFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaimsPortableStateFileError";
  }
}

export function claimsPortableStatePath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, CLAIMS_PORTABLE_STATE_RELATIVE_PATH);
}

/** Parse YAML and enforce the provider-neutral portable-state contract. */
export function parsePortableClaimsStateYaml(
  source: string,
  sourceName = CLAIMS_PORTABLE_STATE_RELATIVE_PATH,
): PortableClaimsState {
  try {
    return parsePortableClaimsState(
      yamlLoad(source, { schema: JSON_SCHEMA, filename: sourceName }),
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new ClaimsPortableStateFileError(
        `Invalid Claims portable state at ${sourceName}: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Serialize canonical state. Re-parse first so callers cannot bypass validation. */
export function serializePortableClaimsState(value: unknown): string {
  const state = parsePortableClaimsState(value);
  return (
    FILE_HEADER +
    yamlDump(state, {
      lineWidth: 120,
      noCompatMode: true,
      noRefs: true,
      quotingType: '"',
      sortKeys: false,
    })
  );
}

export function loadPortableClaimsState(
  workspaceRoot: string,
): PortableClaimsState | undefined {
  const filePath = claimsPortableStatePath(workspaceRoot);
  if (!existsSync(filePath)) return undefined;
  return parsePortableClaimsStateYaml(
    readFileSync(filePath, "utf-8"),
    filePath,
  );
}

/** Atomically replace the portable source of truth after full validation. */
export function writePortableClaimsState(
  workspaceRoot: string,
  value: unknown,
): string {
  const filePath = claimsPortableStatePath(workspaceRoot);
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const serialized = serializePortableClaimsState(value);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporaryPath, serialized, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return filePath;
}
