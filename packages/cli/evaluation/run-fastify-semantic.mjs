#!/usr/bin/env node
// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the labeled Fastify semantic-endpoint cases through the built CLI and
 * compares each model's raw answer with its hand label.
 *
 * Usage: node packages/cli/evaluation/run-fastify-semantic.mjs \
 *          --models gpt-5-mini,gpt-5.1 [--report report.json]
 *
 * Requires OPENAI_API_KEY and a built packages/cli/dist/cli.js. Each case runs
 * in a fresh directory under the OS temp directory. Nothing is deleted.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const cli = path.join(repo, "packages/cli/dist/cli.js");
const labelsPath = path.join(here, "fastify-semantic-endpoint.labels.json");
const inferenceConfig = path.join(repo, ".iw/claims/inference.yaml");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const models = argValue("--models", "gpt-5-mini").split(",");
const reportPath = argValue("--report", undefined);
const dataset = JSON.parse(readFileSync(labelsPath, "utf-8"));

/**
 * Run the CLI and return its output. A non-zero exit from the semantic step is
 * a result, not a harness failure: grounding rejects some model answers.
 */
function run(args, cwd) {
  const result = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, IW_SESSION: "fastify-semantic-labels" },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function prepareWorkspace(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "iw-fastify-labels-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(path.join(dir, ".iw/claims"), { recursive: true });
  writeFileSync(
    path.join(dir, ".iw/claims/inference.yaml"),
    readFileSync(inferenceConfig, "utf-8"),
  );
  return dir;
}

/** The raw model answer and the stored candidate outcome for the route. */
function observe(dir) {
  const database = new DatabaseSync(path.join(dir, ".iw/index.db"));
  try {
    const candidate = database
      .prepare(
        `SELECT confidence FROM claim_candidates
         WHERE identity_key LIKE 'endpoint-auth:fastify:GET:/api/orders/orders%'
         ORDER BY version_ordinal DESC LIMIT 1`,
      )
      .get();
    const inference = database
      .prepare(
        `SELECT provenance_json FROM candidate_inferences
         WHERE adapter_id = 'semantic-endpoint-authentication-correlation'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get();
    const raw = inference
      ? (JSON.parse(inference.provenance_json).structuredInference?.value
          ?.confidence ?? "no-answer")
      : "not-asked";
    return {
      raw,
      stored: candidate?.confidence ?? "missing",
    };
  } finally {
    database.close();
  }
}

const results = [];
for (const item of dataset.cases) {
  for (const model of models) {
    const dir = prepareWorkspace(item.files);
    run(["index", "build"], dir);
    run(["claims", "discover"], dir);
    const semantic = run(
      [
        "claims",
        "discover",
        "--semantic",
        "--provider",
        "openai",
        "--model",
        model,
        "--semantic-limit",
        "10",
      ],
      dir,
    );
    const observed = observe(dir);
    const ungrounded = /ungrounded_output/.test(semantic.stdout);
    // Only `probable` counts as a proposed binding. not-asked and ungrounded
    // answers propose none.
    const proposedBinding = observed.raw === "probable";
    results.push({
      id: item.id,
      model,
      label: item.label,
      raw: observed.raw,
      stored: observed.stored,
      ungrounded,
      match: proposedBinding === (item.label === "probable"),
      dir,
    });
  }
}

const table = results
  .map(
    (row) =>
      `${row.id}\t${row.model}\tlabel=${row.label}\traw=${row.raw}\tstored=${row.stored}\tungrounded=${row.ungrounded}\t${row.match ? "match" : "MISMATCH"}`,
  )
  .join("\n");
console.log(table);

for (const model of models) {
  const rows = results.filter((row) => row.model === model);
  const predictedProbable = rows.filter((row) => row.raw === "probable");
  const truePositive = predictedProbable.filter(
    (row) => row.label === "probable",
  ).length;
  const labeledProbable = rows.filter((row) => row.label === "probable").length;
  const precision = predictedProbable.length
    ? truePositive / predictedProbable.length
    : null;
  const recall = labeledProbable ? truePositive / labeledProbable : null;
  console.log(
    `${model}: cases=${rows.length} matches=${rows.filter((row) => row.match).length} ungrounded=${rows.filter((row) => row.ungrounded).length} probable precision=${precision ?? "n/a"} recall=${recall ?? "n/a"}`,
  );
}

if (reportPath) {
  writeFileSync(
    reportPath,
    JSON.stringify({ models, results }, null, 2) + "\n",
  );
}
