// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * O4 evaluation. The seeded part runs on git fixtures and asserts exact agreement with
 * the labels, reporting precision and recall per change kind. The volume part runs
 * only when O4_VOLUME_REPO is set, and writes change volume and stored rows per commit.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  writeFileSync as writeJson,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initSchema, ObservationStore } from "@intentweave/index";
import Database from "@intentweave/sqlite-compat";
import { describe, expect, it } from "vitest";
import {
  changesBetween,
  ObservedChange,
  recordRevision,
  revisionRenames,
  scoreChanges,
  type Score,
} from "./observationEvaluation.js";
import { SCENARIOS, type Scenario } from "./observationScenarios.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Build the base and head revisions of a scenario and return the detector's changes. */
function detect(scenario: Scenario): ObservedChange[] {
  const workspace = mkdtempSync(path.join(tmpdir(), "iw-o4-scenario-"));
  try {
    git(workspace, ["init", "-q"]);
    git(workspace, ["config", "user.email", "o4@example.test"]);
    git(workspace, ["config", "user.name", "O4 evaluation"]);
    const commit = (files: Record<string, string>): string => {
      const tracked = git(workspace, ["ls-files"]);
      if (tracked)
        git(workspace, ["rm", "-q", "-f", "--", ...tracked.split("\n")]);
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(workspace, file)), {
          recursive: true,
        });
        writeFileSync(path.join(workspace, file), content);
      }
      git(workspace, ["add", "-A"]);
      git(workspace, ["commit", "-q", "--allow-empty", "-m", "scenario"]);
      return git(workspace, ["rev-parse", "HEAD"]);
    };
    const base = commit(scenario.base);
    const head = commit(scenario.head);

    const database = new Database(path.join(workspace, "observations.db"));
    initSchema(database);
    const store = new ObservationStore(database);
    const baseRun = recordRevision(store, workspace, base);
    const headRun = recordRevision(store, workspace, head);
    const changes = changesBetween(
      database,
      store,
      baseRun,
      headRun,
      revisionRenames(workspace, base, head),
    );
    database.close();
    return changes;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("O4 change detection on seeded changes", () => {
  const results = SCENARIOS.map((scenario) => ({
    scenario,
    predicted: detect(scenario),
  }));

  it.each(SCENARIOS.map((scenario) => [scenario.name]))(
    "reports exactly the labelled changes: %s",
    (name) => {
      const result = results.find((entry) => entry.scenario.name === name)!;
      const score = scoreChanges(
        result.scenario.labels,
        result.predicted,
      ).total;
      expect({
        falsePositives: score.falsePositives,
        falseNegatives: score.falseNegatives,
      }).toEqual({ falsePositives: 0, falseNegatives: 0 });
    },
    120000,
  );

  it("reports precision and recall per kind over the seeded set", () => {
    const labels = results.flatMap((entry) => entry.scenario.labels);
    const predicted = results.flatMap((entry) => entry.predicted);
    const { total, byKind } = scoreChanges(labels, predicted);
    const summary: Record<string, Score> = { total, ...byKind };
    process.stderr.write(`O4 seeded ${JSON.stringify(summary)}\n`);
    expect(total.precision).toBe(1);
    expect(total.recall).toBe(1);
  }, 600000);
});

const VOLUME_REPO = process.env.O4_VOLUME_REPO;
const VOLUME_COMMITS = Number(process.env.O4_VOLUME_COMMITS ?? "10");

describe.skipIf(!VOLUME_REPO)("O4 change volume per commit (opt-in)", () => {
  it("measures change volume and stored rows for consecutive commits", () => {
    const revisions = git(VOLUME_REPO!, [
      "rev-list",
      "--reverse",
      `--max-count=${VOLUME_COMMITS + 1}`,
      "HEAD",
    ])
      .split("\n")
      .filter(Boolean);
    const database = new Database(
      path.join(tmpdir(), `iw-o4-volume-${Date.now()}.db`),
    );
    initSchema(database);
    const store = new ObservationStore(database);
    const runs = new Map<string, string>();
    const rows: Array<Record<string, unknown>> = [];
    for (const revision of revisions) {
      const before = database
        .prepare(`SELECT COUNT(*) AS n FROM observed_versions`)
        .get() as { n: number };
      runs.set(revision, recordRevision(store, VOLUME_REPO!, revision));
      const after = database
        .prepare(`SELECT COUNT(*) AS n FROM observed_versions`)
        .get() as { n: number };
      rows.push({
        revision: revision.slice(0, 10),
        newVersions: after.n - before.n,
      });
    }
    for (let index = 1; index < revisions.length; index += 1) {
      const base = revisions[index - 1]!;
      const head = revisions[index]!;
      const changes = changesBetween(
        database,
        store,
        runs.get(base)!,
        runs.get(head)!,
        revisionRenames(VOLUME_REPO!, base, head),
      );
      const kinds: Record<string, number> = {};
      for (const change of changes)
        kinds[change.kind] = (kinds[change.kind] ?? 0) + 1;
      rows[index]!.changes = changes.length;
      rows[index]!.kinds = kinds;
    }
    const totals = {
      runs: (
        database
          .prepare(`SELECT COUNT(*) AS n FROM observation_runs`)
          .get() as { n: number }
      ).n,
      identities: (
        database
          .prepare(`SELECT COUNT(*) AS n FROM observed_identities`)
          .get() as { n: number }
      ).n,
      versions: (
        database
          .prepare(`SELECT COUNT(*) AS n FROM observed_versions`)
          .get() as { n: number }
      ).n,
      runItems: (
        database
          .prepare(`SELECT COUNT(*) AS n FROM observation_run_items`)
          .get() as { n: number }
      ).n,
    };
    database.close();
    const report = { repository: VOLUME_REPO, commits: rows, totals };
    if (process.env.O4_VOLUME_OUT)
      writeJson(process.env.O4_VOLUME_OUT, JSON.stringify(report, null, 2));
    process.stderr.write(`O4 volume ${JSON.stringify(report)}\n`);
    expect(totals.runs).toBe(revisions.length);
  }, 1800000);
});
