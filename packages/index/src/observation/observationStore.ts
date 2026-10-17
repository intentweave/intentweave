// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Observation store (Phase G5.3, O2). Persists complete inventory runs, identities,
 * versions, membership, ChangeSets, the Subject bridge, evidence projection, and
 * change impacts. It follows docs/OBSERVATION-MIGRATION-21-DRAFT.md and the
 * decisions D1–D4, Amendment A, and Decision C.
 *
 * Invariants enforced here:
 * - a run is idempotent for the same adapter, contract, scope, and revision;
 * - removal is decided only from complete coverage in both runs;
 * - a ChangeSet is a pure function of its runs and contract, and is stored once;
 * - the Subject bridge is written only with a rule or Review basis (decision B);
 * - change items never carry materiality (D4).
 */

import type Database from "@intentweave/sqlite-compat";
import { fingerprint } from "../claims/canonical.js";
import { ClaimsStore } from "../claims/store.js";
import type { PersistGenericEvidenceInput } from "../claims/types.js";

export type CoverageStatus =
  | "complete"
  | "partial"
  | "not_observed"
  | "unsupported";

export interface RunCoverageInput {
  kind: string;
  status: CoverageStatus;
  reason?: string;
  objectCount: number;
}

export interface RunRecordInput {
  kind: string;
  identityKey: string;
  locator: {
    filePath: string;
    container?: string;
    line?: number;
    endLine?: number;
  };
  payload: Record<string, unknown>;
  cariId?: string;
}

export interface RecordRunInput {
  adapterId: string;
  adapterContractVersion: string;
  scope: { files: readonly string[]; description: string };
  repositoryRevision: string;
  coverage: readonly RunCoverageInput[];
  records: readonly RunRecordInput[];
}

export type ChangeKind =
  | "added"
  | "removed"
  | "moved"
  | "renamed"
  | "property-changed"
  | "relation-changed"
  | "continuity-unclear"
  | "not_comparable";

export interface ChangeItem {
  id: string;
  changeKind: ChangeKind;
  observedIdentityId: string;
  successorIdentityId: string | null;
  basis: string;
  changedProperties: string[];
}

const CONTINUITY_RULE_BASIS = "rule:observation-changeset-move@1";

function stableId(...parts: string[]): string {
  return fingerprint(parts).slice(0, 32);
}

function isRuleOrReviewBasis(basis: string): boolean {
  return basis.startsWith("rule:") || basis.startsWith("review:");
}

export class ObservationStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Persist one complete or partial inventory run. Re-recording the same adapter,
   * contract, scope, and revision returns the existing run unchanged.
   */
  recordRun(input: RecordRunInput): string {
    const scopeFingerprint = fingerprint({
      files: [...input.scope.files].sort(),
      description: input.scope.description,
    });
    const runId = stableId(
      input.adapterId,
      input.adapterContractVersion,
      scopeFingerprint,
      input.repositoryRevision,
    );
    const existing = this.db
      .prepare("SELECT id FROM observation_runs WHERE id = ?")
      .get(runId);
    if (existing) return runId;

    const now = Date.now();
    const record = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO observation_runs
             (id, adapter_id, adapter_contract_version, scope_fingerprint,
              scope_descriptor_json, repository_revision, status, started_at,
              finished_at, fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, 'finished', ?, ?, ?)`,
        )
        .run(
          runId,
          input.adapterId,
          input.adapterContractVersion,
          scopeFingerprint,
          JSON.stringify({
            description: input.scope.description,
            files: [...input.scope.files].sort(),
          }),
          input.repositoryRevision,
          now,
          now,
          fingerprint({ runId, coverage: input.coverage }),
        );

      for (const coverage of input.coverage) {
        if (coverage.status !== "complete" && !coverage.reason) {
          throw new Error(
            `Coverage for ${coverage.kind} is ${coverage.status} and needs a reason`,
          );
        }
        this.db
          .prepare(
            `INSERT INTO observation_run_coverage
               (run_id, kind, coverage_status, reason, object_count)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            coverage.kind,
            coverage.status,
            coverage.reason ?? null,
            coverage.objectCount,
          );
      }

      const seen = new Set<string>();
      for (const item of input.records) {
        if (seen.has(item.identityKey)) {
          throw new Error(
            `Duplicate identity key in one run: ${item.identityKey}`,
          );
        }
        seen.add(item.identityKey);
        const identityId = stableId("observed-identity", item.identityKey);
        const existingIdentity = this.db
          .prepare(
            "SELECT kind FROM observed_identities WHERE identity_key = ?",
          )
          .get(item.identityKey) as { kind: string } | undefined;
        if (existingIdentity && existingIdentity.kind !== item.kind) {
          throw new Error(`Identity ${item.identityKey} changed kind`);
        }
        this.db
          .prepare(
            `INSERT OR IGNORE INTO observed_identities
               (id, kind, identity_key, creation_run_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(identityId, item.kind, item.identityKey, runId, now);

        const locatorJson = JSON.stringify(item.locator);
        const payloadJson = JSON.stringify(item.payload);
        const versionFingerprint = fingerprint({
          locator: item.locator,
          payload: item.payload,
        });
        const latest = this.db
          .prepare(
            `SELECT id, payload_fingerprint, version_ordinal FROM observed_versions
             WHERE observed_identity_id = ?
             ORDER BY version_ordinal DESC LIMIT 1`,
          )
          .get(identityId) as
          | { id: string; payload_fingerprint: string; version_ordinal: number }
          | undefined;
        let versionId: string;
        if (latest && latest.payload_fingerprint === versionFingerprint) {
          versionId = latest.id;
        } else {
          const ordinal = (latest?.version_ordinal ?? 0) + 1;
          versionId = stableId(
            "observed-version",
            identityId,
            String(ordinal),
            versionFingerprint,
          );
          this.db
            .prepare(
              `INSERT INTO observed_versions
                 (id, observed_identity_id, version_ordinal, locator_json, payload_json,
                  payload_fingerprint, cari_id, first_run_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              versionId,
              identityId,
              ordinal,
              locatorJson,
              payloadJson,
              versionFingerprint,
              item.cariId ?? null,
              runId,
            );
        }
        this.db
          .prepare(
            `INSERT INTO observation_run_items
               (run_id, observed_identity_id, effective_version_id)
             VALUES (?, ?, ?)`,
          )
          .run(runId, identityId, versionId);
      }
    });
    record();
    return runId;
  }

  /** Current payload and locator of an identity within a run, or undefined when absent. */
  private itemIn(runId: string, identityId: string) {
    return this.db
      .prepare(
        `SELECT version.payload_json, version.locator_json, identity.kind, identity.identity_key
         FROM observation_run_items item
         JOIN observed_versions version ON version.id = item.effective_version_id
         JOIN observed_identities identity ON identity.id = item.observed_identity_id
         WHERE item.run_id = ? AND item.observed_identity_id = ?`,
      )
      .get(runId, identityId) as
      | {
          payload_json: string;
          locator_json: string;
          kind: string;
          identity_key: string;
        }
      | undefined;
  }

  private membersOf(runId: string) {
    return this.db
      .prepare(
        `SELECT item.observed_identity_id AS identity_id, identity.kind,
                identity.identity_key, version.payload_json, version.locator_json
         FROM observation_run_items item
         JOIN observed_identities identity ON identity.id = item.observed_identity_id
         JOIN observed_versions version ON version.id = item.effective_version_id
         WHERE item.run_id = ?`,
      )
      .all(runId) as Array<{
      identity_id: string;
      kind: string;
      identity_key: string;
      payload_json: string;
      locator_json: string;
    }>;
  }

  private coverageOf(runId: string): Map<string, CoverageStatus> {
    const rows = this.db
      .prepare(
        "SELECT kind, coverage_status FROM observation_run_coverage WHERE run_id = ?",
      )
      .all(runId) as Array<{ kind: string; coverage_status: CoverageStatus }>;
    return new Map(rows.map((row) => [row.kind, row.coverage_status]));
  }

  /**
   * Derive and store the ChangeSet between two runs. `renames` maps a base path to
   * its head path, from Git rename detection at the reference revisions. A base
   * object moves only when exactly one head object of the same kind, name, and
   * container lives at the renamed path, and no other base object claims it.
   */
  computeChangeSet(input: {
    baseRunId: string;
    headRunId: string;
    contractFingerprint: string;
    renames: ReadonlyMap<string, string>;
  }): string {
    const changeSetId = stableId(
      "changeset",
      input.baseRunId,
      input.headRunId,
      input.contractFingerprint,
    );
    const existing = this.db
      .prepare("SELECT id FROM observed_changesets WHERE id = ?")
      .get(changeSetId);
    if (existing) return changeSetId;

    const baseCoverage = this.coverageOf(input.baseRunId);
    const headCoverage = this.coverageOf(input.headRunId);
    const completeFor = (kind: string) =>
      baseCoverage.get(kind) === "complete" &&
      headCoverage.get(kind) === "complete";

    const base = this.membersOf(input.baseRunId);
    const head = this.membersOf(input.headRunId);
    const headByIdentity = new Map(
      head.map((member) => [member.identity_id, member]),
    );
    const baseByIdentity = new Map(
      base.map((member) => [member.identity_id, member]),
    );

    const name = (member: { payload_json: string }) =>
      String(
        (JSON.parse(member.payload_json) as Record<string, unknown>).name ?? "",
      );
    const container = (member: { payload_json: string }) =>
      (JSON.parse(member.payload_json) as Record<string, unknown>).container ??
      null;
    const filePath = (member: { locator_json: string }) =>
      String(
        (JSON.parse(member.locator_json) as { filePath: string }).filePath,
      );

    type Item = {
      kind: ChangeKind;
      identityId: string;
      successorId: string | null;
      basis: string;
      changed: string[];
      baseVersion: string | null;
      headVersion: string | null;
    };
    const items: Item[] = [];

    // Successor candidates for base objects whose file was renamed.
    const candidatesOf = new Map<string, string[]>();
    for (const member of base) {
      if (headByIdentity.has(member.identity_id)) continue;
      const renamedTo = input.renames.get(filePath(member));
      if (!renamedTo) continue;
      const matches = head
        .filter(
          (candidate) =>
            filePath(candidate) === renamedTo &&
            candidate.kind === member.kind &&
            name(candidate) === name(member) &&
            container(candidate) === container(member) &&
            !baseByIdentity.has(candidate.identity_id),
        )
        .map((candidate) => candidate.identity_id)
        .sort();
      candidatesOf.set(member.identity_id, matches);
    }
    const claimants = new Map<string, string[]>();
    for (const [baseId, matches] of candidatesOf) {
      for (const match of matches)
        claimants.set(match, [...(claimants.get(match) ?? []), baseId]);
    }
    const successorOf = new Map<string, string>();
    const unclearBase = new Set<string>();
    const unclearHead = new Set<string>();
    for (const [baseId, matches] of candidatesOf) {
      if (matches.length === 1 && claimants.get(matches[0]!)?.length === 1) {
        successorOf.set(baseId, matches[0]!);
      } else if (matches.length > 0) {
        unclearBase.add(baseId);
        for (const match of matches) unclearHead.add(match);
      }
    }

    const changedProperties = (before: string, after: string): string[] => {
      const left = JSON.parse(before) as Record<string, unknown>;
      const right = JSON.parse(after) as Record<string, unknown>;
      return [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .filter(
          (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]),
        )
        .sort();
    };

    for (const member of base) {
      const headMember = headByIdentity.get(member.identity_id);
      if (headMember) {
        if (member.payload_json !== headMember.payload_json) {
          items.push({
            kind: "property-changed",
            identityId: member.identity_id,
            successorId: null,
            basis: "identity-equal",
            changed: changedProperties(
              member.payload_json,
              headMember.payload_json,
            ),
            baseVersion: null,
            headVersion: null,
          });
        }
        continue;
      }
      if (unclearBase.has(member.identity_id)) {
        items.push({
          kind: "continuity-unclear",
          identityId: member.identity_id,
          successorId: null,
          basis: "ambiguous-rename-match",
          changed: [],
          baseVersion: null,
          headVersion: null,
        });
        continue;
      }
      const successor = successorOf.get(member.identity_id);
      if (successor) {
        const after = headByIdentity.get(successor)!;
        items.push({
          kind: "moved",
          identityId: member.identity_id,
          successorId: successor,
          basis: "git-rename",
          changed: changedProperties(member.payload_json, after.payload_json),
          baseVersion: null,
          headVersion: null,
        });
        continue;
      }
      items.push({
        kind: completeFor(member.kind) ? "removed" : "not_comparable",
        identityId: member.identity_id,
        successorId: null,
        basis: completeFor(member.kind)
          ? "complete-coverage"
          : "partial-coverage",
        changed: [],
        baseVersion: null,
        headVersion: null,
      });
    }

    const claimedHeads = new Set(successorOf.values());
    for (const member of head) {
      if (
        baseByIdentity.has(member.identity_id) ||
        claimedHeads.has(member.identity_id)
      )
        continue;
      if (unclearHead.has(member.identity_id)) {
        items.push({
          kind: "continuity-unclear",
          identityId: member.identity_id,
          successorId: null,
          basis: "ambiguous-rename-match",
          changed: [],
          baseVersion: null,
          headVersion: null,
        });
        continue;
      }
      items.push({
        kind: completeFor(member.kind) ? "added" : "not_comparable",
        identityId: member.identity_id,
        successorId: null,
        basis: completeFor(member.kind)
          ? "complete-coverage"
          : "partial-coverage",
        changed: [],
        baseVersion: null,
        headVersion: null,
      });
    }

    items.sort((left, right) =>
      `${left.kind}:${left.identityId}`.localeCompare(
        `${right.kind}:${right.identityId}`,
      ),
    );

    const store = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO observed_changesets
             (id, base_run_id, head_run_id, adapter_contract_fingerprint, changeset_fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          changeSetId,
          input.baseRunId,
          input.headRunId,
          input.contractFingerprint,
          changeSetId,
          Date.now(),
        );
      for (const item of items) {
        const id = stableId(
          "change-item",
          changeSetId,
          item.kind,
          item.identityId,
        );
        this.db
          .prepare(
            `INSERT INTO observed_change_items
               (id, changeset_id, change_kind, observed_identity_id, base_version_id,
                head_version_id, successor_identity_id, basis, changed_properties_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            changeSetId,
            item.kind,
            item.identityId,
            item.baseVersion,
            item.headVersion,
            item.successorId,
            item.basis,
            item.changed.length ? JSON.stringify(item.changed) : null,
          );
      }
    });
    store();
    return changeSetId;
  }

  changeItems(changeSetId: string): ChangeItem[] {
    return (
      this.db
        .prepare(
          `SELECT id, change_kind, observed_identity_id, successor_identity_id, basis,
                  changed_properties_json
           FROM observed_change_items WHERE changeset_id = ? ORDER BY id`,
        )
        .all(changeSetId) as Array<{
        id: string;
        change_kind: ChangeKind;
        observed_identity_id: string;
        successor_identity_id: string | null;
        basis: string;
        changed_properties_json: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      changeKind: row.change_kind,
      observedIdentityId: row.observed_identity_id,
      successorIdentityId: row.successor_identity_id,
      basis: row.basis,
      changedProperties: row.changed_properties_json
        ? (JSON.parse(row.changed_properties_json) as string[])
        : [],
    }));
  }

  /**
   * Bind a Claim Subject to an observed identity (decision B). The basis must name
   * a versioned rule or a Review.
   */
  bridgeSubject(input: {
    subjectIdentityId: string;
    observedIdentityId: string;
    role: string;
    basis: string;
    contractVersion: string;
  }): void {
    if (!isRuleOrReviewBasis(input.basis)) {
      throw new Error(
        `Subject bridge basis must be a rule or review, got ${input.basis}`,
      );
    }
    const current = this.db
      .prepare(
        `SELECT subject_identity_id FROM subject_observations
         WHERE observed_identity_id = ? AND role = ? AND retired_run_id IS NULL`,
      )
      .all(input.observedIdentityId, input.role) as Array<{
      subject_identity_id: string;
    }>;
    if (
      current.some((row) => row.subject_identity_id !== input.subjectIdentityId)
    ) {
      throw new Error(
        `Observed identity ${input.observedIdentityId} is already bridged for role ${input.role}`,
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO subject_observations
           (subject_identity_id, observed_identity_id, role, basis, contract_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.subjectIdentityId,
        input.observedIdentityId,
        input.role,
        input.basis,
        input.contractVersion,
        Date.now(),
      );
  }

  /**
   * Follow current bridges through a ChangeSet. A move retires the bridge to the
   * predecessor and binds the successor, under the ChangeSet move rule. Removed,
   * unclear, and not comparable identities leave the Subject unbound.
   */
  followBridgesThroughChangeSet(changeSetId: string, runId: string): number {
    const moves = this.changeItems(changeSetId).filter(
      (item) => item.changeKind === "moved" && item.successorIdentityId,
    );
    let followed = 0;
    const apply = this.db.transaction(() => {
      for (const move of moves) {
        const bridges = this.db
          .prepare(
            `SELECT subject_identity_id, role FROM subject_observations
             WHERE observed_identity_id = ? AND retired_run_id IS NULL`,
          )
          .all(move.observedIdentityId) as Array<{
          subject_identity_id: string;
          role: string;
        }>;
        for (const bridge of bridges) {
          this.db
            .prepare(
              `UPDATE subject_observations SET retired_run_id = ?
               WHERE subject_identity_id = ? AND observed_identity_id = ? AND role = ?`,
            )
            .run(
              runId,
              bridge.subject_identity_id,
              move.observedIdentityId,
              bridge.role,
            );
          this.bridgeSubject({
            subjectIdentityId: bridge.subject_identity_id,
            observedIdentityId: move.successorIdentityId!,
            role: bridge.role,
            basis: CONTINUITY_RULE_BASIS,
            contractVersion: "1",
          });
          followed += 1;
        }
      }
    });
    apply();
    return followed;
  }

  /**
   * Project an observed version into ordinary evidence, so that existing Rule Results
   * and Assessments reach it through the evidence dependency path.
   */
  projectVersion(input: {
    observedVersionId: string;
    evidence: PersistGenericEvidenceInput;
    projectionContractVersion: string;
  }): string {
    const claims = new ClaimsStore(this.db);
    const version = claims.persistGenericEvidence(input.evidence);
    const identity = this.db
      .prepare(
        "SELECT evidence_identity_id FROM evidence_versions WHERE id = ?",
      )
      .get(version.id) as { evidence_identity_id: string };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO observed_evidence_projection
           (observed_version_id, evidence_identity_id, evidence_version_id, projection_contract_version)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.observedVersionId,
        identity.evidence_identity_id,
        version.id,
        input.projectionContractVersion,
      );
    return version.id;
  }

  /**
   * Reverse Impact from persisted dependencies only: the Claims whose current
   * Assessments depend on any evidence projected from the observed identity.
   */
  dependentClaims(observedIdentityId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT claim_version.claim_identity_id AS claim_identity_id
           FROM observed_versions observed
           JOIN observed_evidence_projection projection
             ON projection.observed_version_id = observed.id
           JOIN claim_assessment_dependencies dependency
             ON dependency.dependency_kind = 'evidence_version'
            AND dependency.dependency_version_id = projection.evidence_version_id
           JOIN claim_assessments assessment
             ON assessment.id = dependency.claim_assessment_id
            AND assessment.is_current = 1
           JOIN claim_versions claim_version
             ON claim_version.id = assessment.claim_version_id
           WHERE observed.observed_identity_id = ?
           ORDER BY claim_version.claim_identity_id`,
        )
        .all(observedIdentityId) as Array<{ claim_identity_id: string }>
    ).map((row) => row.claim_identity_id);
  }

  /**
   * The payloads a run recorded, each at the version the run saw, in record order.
   * Producers read back what they recorded; claims checks never call this.
   */
  runItemPayloads(runId: string): unknown[] {
    const rows = this.db
      .prepare(
        `SELECT v.payload_json AS payload
         FROM observation_run_items item
         JOIN observed_versions v ON v.id = item.effective_version_id
         WHERE item.run_id = ?
         ORDER BY item.rowid`,
      )
      .all(runId) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as unknown);
  }

  /**
   * Whether an observed identity was ever bridged to a Claim Subject. A retired bridge
   * still records that the identity was a Subject in its run, so it counts for the gate.
   */
  hasSubjectBridge(observedIdentityId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 AS present FROM subject_observations
           WHERE observed_identity_id = ? LIMIT 1`,
        )
        .get(observedIdentityId),
    );
  }

  /**
   * Bridge Claim Subjects to the observed identities of a run. A Subject is matched
   * through its CARI id, which the run stores as a reference attribute. The bridge
   * records the claim-subject rule as its basis (decision B).
   */
  bridgeClaimSubjectsInRun(
    runId: string,
    subjects: ReadonlyArray<{ subjectIdentityId: string; cariId: string }>,
  ): number {
    let bridged = 0;
    for (const subject of subjects) {
      const row = this.db
        .prepare(
          `SELECT identity.id AS identity_id
           FROM observation_run_items item
           JOIN observed_versions version ON version.id = item.effective_version_id
           JOIN observed_identities identity ON identity.id = item.observed_identity_id
           WHERE item.run_id = ? AND version.cari_id = ?`,
        )
        .get(runId, subject.cariId) as { identity_id: string } | undefined;
      if (!row) continue;
      this.bridgeSubject({
        subjectIdentityId: subject.subjectIdentityId,
        observedIdentityId: row.identity_id,
        role: "subject",
        basis: "rule:claim-subject-bridge@1",
        contractVersion: "1",
      });
      bridged += 1;
    }
    return bridged;
  }

  /**
   * Store one materiality result for a change item and Claim. The result comes from
   * the Claim family's contract and is never asserted by the change itself (D4).
   */
  recordChangeImpact(input: {
    changeItemId: string;
    claimIdentityId: string;
    materialityContractVersion: string;
    result: "material" | "immaterial" | "not_applicable";
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO change_impacts
           (id, change_item_id, claim_identity_id, materiality_contract_version, result, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stableId(
          "impact",
          input.changeItemId,
          input.claimIdentityId,
          input.materialityContractVersion,
        ),
        input.changeItemId,
        input.claimIdentityId,
        input.materialityContractVersion,
        input.result,
        Date.now(),
      );
  }
}
