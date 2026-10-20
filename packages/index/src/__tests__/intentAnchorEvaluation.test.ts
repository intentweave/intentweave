// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeded evaluation of Intent Anchor outcomes (Phase G5.4, plan Evaluation).
 *
 * Each scenario is a short history of one Claim's statement, an optional protection,
 * an assessment, and optional declared follow-ups. Expected outcomes are written from
 * the rules in the plan, not from the implementation. The matrix measures consistency:
 * it cannot show how often real repositories are right, and it is not a replay.
 *
 * Two measures are reported and asserted:
 * - undeclared changes wrongly accepted as follow-ups, which must be zero;
 * - conflict precision and recall over the matrix.
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { fingerprint } from "../claims/canonical.js";
import { IntentAnchorStore } from "../claims/intentAnchors.js";
import type { IntentAnchorEvaluation } from "../claims/intentAnchors.js";
import { initSchema } from "../schema.js";

type Assessment = "supported" | "refuted" | "contested" | "inconclusive";

interface Scenario {
  name: string;
  /** Statement values in order. The first one is protected. */
  versions: unknown[];
  assessment?: Assessment;
  /** Declared follow-up for this value, if any. */
  followUpFor?: unknown;
  /** The Claim was retired by this change. */
  retired?: boolean;
  /** The Claim was not evaluated in this run. */
  notEvaluated?: boolean;
  /** True when the statement changed without an authorized follow-up. */
  undeclaredChange: boolean;
  expected: IntentAnchorEvaluation["outcome"];
}

const SCENARIOS: Scenario[] = [
  {
    name: "unchanged statement",
    versions: [{ value: 1800 }],
    undeclaredChange: false,
    expected: "satisfied",
  },
  {
    name: "undeclared change, supported assessment",
    versions: [{ value: 1800 }, { value: 3600 }],
    assessment: "supported",
    undeclaredChange: true,
    expected: "intent_conflict",
  },
  {
    name: "undeclared change, refuted assessment",
    versions: [{ value: 1800 }, { value: 3600 }],
    assessment: "refuted",
    undeclaredChange: true,
    expected: "intent_conflict",
  },
  {
    name: "undeclared change, contested assessment",
    versions: [{ value: 1800 }, { value: 3600 }],
    assessment: "contested",
    undeclaredChange: true,
    expected: "intent_conflict",
  },
  {
    name: "undeclared change, inconclusive assessment",
    versions: [{ value: 1800 }, { value: 3600 }],
    assessment: "inconclusive",
    undeclaredChange: true,
    expected: "intent_conflict",
  },
  {
    name: "declared follow-up, supported assessment",
    versions: [{ value: 1800 }, { value: 3600 }],
    assessment: "supported",
    followUpFor: { value: 3600 },
    undeclaredChange: false,
    expected: "satisfied",
  },
  {
    name: "declared follow-up, refuted assessment cannot lift the change",
    versions: [{ value: 1800 }, { value: 3600 }],
    assessment: "refuted",
    followUpFor: { value: 3600 },
    undeclaredChange: true,
    expected: "intent_conflict",
  },
  {
    name: "declared follow-up for a different value",
    versions: [{ value: 1800 }, { value: 3600 }],
    assessment: "supported",
    followUpFor: { value: 7200 },
    undeclaredChange: true,
    expected: "intent_conflict",
  },
  {
    name: "two changes, follow-up declared only for the intermediate value",
    versions: [{ value: 1800 }, { value: 3600 }, { value: 7200 }],
    assessment: "supported",
    followUpFor: { value: 3600 },
    undeclaredChange: true,
    expected: "intent_conflict",
  },
  {
    name: "value returns to the protected statement",
    versions: [{ value: 1800 }, { value: 3600 }, { value: 1800 }],
    assessment: "supported",
    undeclaredChange: false,
    expected: "satisfied",
  },
  {
    name: "retired Claim",
    versions: [{ value: 1800 }],
    retired: true,
    undeclaredChange: true,
    expected: "intent_conflict",
  },
  {
    name: "Claim not evaluated in this run",
    versions: [{ value: 1800 }],
    notEvaluated: true,
    undeclaredChange: false,
    expected: "intent_unresolved",
  },
];

describe("Intent Anchor seeded evaluation (G5.4)", () => {
  let db: Database.Database;
  let store: IntentAnchorStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    db.exec(
      `INSERT INTO parameter_identities (id, canonical_key, created_at)
       VALUES ('param', 'param', 0)`,
    );
    store = new IntentAnchorStore(db);
  });

  afterEach(() => db.close());

  function insertVersion(claimId: string, value: unknown, ordinal: number) {
    db.prepare(
      `INSERT OR IGNORE INTO claim_identities
         (id, parameter_identity_id, claim_type, scope, identity_key, created_at)
       VALUES (?, 'param', 'parameter', 'repo', ?, 0)`,
    ).run(claimId, claimId);
    db.prepare(
      `INSERT INTO claim_versions
         (id, claim_identity_id, version_ordinal, normalized_statement_json,
          assessment_policy_id, assessment_policy_version, repository_revision, created_at)
       VALUES (?, ?, ?, ?, 'policy', '1', 'rev', ?)`,
    ).run(
      `${claimId}:v${ordinal}`,
      claimId,
      ordinal,
      JSON.stringify(value),
      ordinal,
    );
  }

  function setAssessment(claimId: string, status: Assessment): void {
    const version = store.latestVersion(claimId)!;
    db.prepare(
      `INSERT INTO claim_assessments
         (id, claim_version_id, assessment_key, epistemic_status, repository_revision,
          reference_key, is_current, created_at)
       VALUES (?, ?, ?, ?, 'rev', NULL, 1, 0)`,
    ).run(
      `assessment:${claimId}:${status}`,
      version.id,
      `key:${claimId}:${status}`,
      status,
    );
  }

  /** Run one scenario and return the single anchor outcome it produced. */
  function run(scenario: Scenario, claimId: string): IntentAnchorEvaluation {
    insertVersion(claimId, scenario.versions[0], 1);
    store.protect({
      claimIdentityId: claimId,
      actor: "reviewer",
      createdAt: 10,
    });
    scenario.versions.slice(1).forEach((value, index) => {
      insertVersion(claimId, value, index + 2);
    });
    if (scenario.assessment) setAssessment(claimId, scenario.assessment);
    const results = store.evaluate({
      followUps: scenario.followUpFor
        ? [
            {
              claimIdentityId: claimId,
              statementFingerprint: fingerprint(scenario.followUpFor),
            },
          ]
        : [],
      evaluatedClaimIds: scenario.notEvaluated ? new Set() : new Set([claimId]),
      retiredClaimIds: scenario.retired ? new Set([claimId]) : new Set(),
    });
    expect(results).toHaveLength(1);
    return results[0]!;
  }

  it("matches the expected outcome in every scenario", () => {
    for (const [index, scenario] of SCENARIOS.entries()) {
      const outcome = run(scenario, `claim:scenario-${index}`);
      expect(outcome.outcome, scenario.name).toBe(scenario.expected);
      db.exec(
        "DELETE FROM intent_anchors; DELETE FROM claim_assessments; DELETE FROM claim_versions; DELETE FROM claim_identities;",
      );
    }
  });

  it("accepts no undeclared change as a follow-up", () => {
    const wronglyAccepted: string[] = [];
    let undeclared = 0;
    for (const [index, scenario] of SCENARIOS.entries()) {
      const outcome = run(scenario, `claim:scenario-${index}`);
      if (scenario.undeclaredChange) {
        undeclared += 1;
        if (outcome.followUp === true) wronglyAccepted.push(scenario.name);
      }
      db.exec(
        "DELETE FROM intent_anchors; DELETE FROM claim_assessments; DELETE FROM claim_versions; DELETE FROM claim_identities;",
      );
    }
    expect(undeclared).toBeGreaterThan(0);
    expect(wronglyAccepted).toEqual([]);
  });

  it("scores conflict precision and recall over the matrix", () => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const [index, scenario] of SCENARIOS.entries()) {
      const predicted =
        run(scenario, `claim:scenario-${index}`).outcome === "intent_conflict";
      const labelled = scenario.expected === "intent_conflict";
      if (predicted && labelled) truePositive += 1;
      else if (predicted) falsePositive += 1;
      else if (labelled) falseNegative += 1;
      db.exec(
        "DELETE FROM intent_anchors; DELETE FROM claim_assessments; DELETE FROM claim_versions; DELETE FROM claim_identities;",
      );
    }
    expect(falsePositive).toBe(0);
    expect(falseNegative).toBe(0);
    expect(truePositive).toBeGreaterThan(0);
  });
});
