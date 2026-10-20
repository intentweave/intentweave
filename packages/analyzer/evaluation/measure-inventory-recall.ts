// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Measures inventory recall for hand-checked route registrations (Phase O1).
 *
 * Usage: npx tsx packages/analyzer/evaluation/measure-inventory-recall.ts <repo> <reference.json>
 *
 * Runs the TypeScript observation inventory over the repository's tracked files and
 * reports how many reference registrations appear as call-site observations at the
 * same file and line, with the same callee and first literal argument.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTypeScriptAdapter } from "../src/stages/ax.js";
import { LanguageRegistry } from "../src/stages/languageRegistry.js";
import { runObservationInventory } from "../src/stages/observation/inventoryRun.js";

interface Reference {
  file: string;
  line: number;
  method: string;
  path: string;
}

const [repo, referencePath] = process.argv.slice(2);
if (!repo || !referencePath) {
  console.error("usage: measure-inventory-recall.ts <repo> <reference.json>");
  process.exit(64);
}

const reference = JSON.parse(readFileSync(referencePath, "utf-8")) as {
  registrations: Reference[];
};
const files = execFileSync("git", ["ls-files"], {
  cwd: repo,
  encoding: "utf-8",
})
  .split("\n")
  .filter(
    (file) =>
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !file.includes("node_modules"),
  );

const registry = new LanguageRegistry().register(
  createTypeScriptAdapter({
    workspaceRoot: repo,
    includePrivate: true,
    includeMembers: true,
    maxDepth: 2,
  }),
);
const run = runObservationInventory(registry, repo, files);

const callSites = run.records.filter((record) => record.kind === "call-site");
let hits = 0;
const misses: Reference[] = [];
for (const expected of reference.registrations) {
  const found = callSites.some(
    (record) =>
      record.locator.filePath === expected.file &&
      record.locator.line === expected.line &&
      String(record.payload.callee) ===
        `fastify.${expected.method.toLowerCase()}` &&
      (record.payload.literalArguments as string[])[0] === expected.path,
  );
  if (found) hits += 1;
  else misses.push(expected);
}

console.log(
  JSON.stringify(
    {
      repository: path.basename(repo),
      scopeFiles: files.length,
      coverage: run.coverage,
      callSitesObserved: callSites.length,
      referenceRegistrations: reference.registrations.length,
      recall: hits / reference.registrations.length,
      misses,
    },
    null,
    2,
  ),
);
