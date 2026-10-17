# Observation layer: migration 21 draft (Phase O0)

Status: draft for review. Not applied to any database. No code depends on it yet.
Scope: Phase G5.3 (`docs/PLAN-GENERALIZED-REPOSITORY-CLAIMS.md`), decisions D1–D4,
Amendment A, and Decision C.

The current schema is 20. This draft describes the additive migration to 21. It
does not change `CURRENT_SCHEMA_VERSION` and does not touch `schema.ts`.

## 1. Invariants the draft encodes

- **D1, two identity levels.** Portable identity is `subject_identities`, with
  continuity through `subject_continuity` and `subject_aliases`. Inventory
  identities are local to a store and are never exported (`observed_identities`).
- **Amendment A.** A CARI symbol id is a reference attribute only
  (`observed_versions.cari_id`), never an identity. Identity keys for symbols are
  created from kind, file, and name.
- **D2, runs and coverage.** A run is one `(adapter, contract, scope)` at one
  repository revision. Completeness is recorded per kind in
  `observation_run_coverage`. Membership is recorded per run in
  `observation_run_items`, so an unchanged object adds membership, not a version.
- **D3, bridge and projection.** `subject_observations` is the only bridge from an
  observed identity to a Subject, and it is written only through a versioned rule
  or a Review. `observed_evidence_projection` connects an observed version to an
  ordinary `evidence_versions` row, so Rule Results and Assessments reach
  observations through `rule_result_evidence` and `claim_assessment_dependencies`
  as they do today.
- **D4, materiality separate.** `observed_change_items` carry no materiality.
  `change_impacts` holds the result per Claim and materiality contract version.
- **Decision C.** Continuity used by `claims check` comes from `subject_continuity`
  or from Git history at the reference revision. The observation tables are not a
  source for it. Inventory continuity in `observed_continuity_links` is not read by
  `check`.

## 2. Column-level definitions

```sql
-- Runs: one per (adapter, contract, scope, repository revision).
CREATE TABLE IF NOT EXISTS observation_runs (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  adapter_contract_version TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL,
  scope_descriptor_json TEXT NOT NULL,
  repository_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  fingerprint TEXT NOT NULL,
  UNIQUE (adapter_id, adapter_contract_version, scope_fingerprint, repository_revision)
);

-- Coverage: completeness per kind within a run.
CREATE TABLE IF NOT EXISTS observation_run_coverage (
  run_id TEXT NOT NULL REFERENCES observation_runs(id),
  kind TEXT NOT NULL,
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('complete', 'partial')),
  reason TEXT,
  object_count INTEGER NOT NULL,
  PRIMARY KEY (run_id, kind),
  CHECK (coverage_status = 'complete' OR reason IS NOT NULL)
);

-- Inventory identities: store-local, never exported.
CREATE TABLE IF NOT EXISTS observed_identities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  creation_run_id TEXT NOT NULL REFERENCES observation_runs(id),
  created_at INTEGER NOT NULL
);

-- Versions: one per payload change, not one per run.
CREATE TABLE IF NOT EXISTS observed_versions (
  id TEXT PRIMARY KEY,
  observed_identity_id TEXT NOT NULL REFERENCES observed_identities(id),
  version_ordinal INTEGER NOT NULL,
  locator_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  cari_id TEXT,
  first_run_id TEXT NOT NULL REFERENCES observation_runs(id),
  UNIQUE (observed_identity_id, version_ordinal),
  UNIQUE (observed_identity_id, payload_fingerprint),
  UNIQUE (id, observed_identity_id)
);

-- Membership: which identities a run saw, and with which version.
CREATE TABLE IF NOT EXISTS observation_run_items (
  run_id TEXT NOT NULL REFERENCES observation_runs(id),
  observed_identity_id TEXT NOT NULL REFERENCES observed_identities(id),
  effective_version_id TEXT NOT NULL,
  PRIMARY KEY (run_id, observed_identity_id),
  FOREIGN KEY (effective_version_id, observed_identity_id)
    REFERENCES observed_versions(id, observed_identity_id)
);

-- Relations between observed versions.
CREATE TABLE IF NOT EXISTS observed_relations (
  id TEXT PRIMARY KEY,
  observed_version_id TEXT NOT NULL REFERENCES observed_versions(id),
  relation_kind TEXT NOT NULL,
  target_identity_id TEXT NOT NULL REFERENCES observed_identities(id),
  target_version_id TEXT REFERENCES observed_versions(id),
  basis TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  UNIQUE (observed_version_id, relation_kind, target_identity_id)
);

-- Inventory continuity only. Subject continuity stays in subject_continuity.
CREATE TABLE IF NOT EXISTS observed_continuity_links (
  id TEXT PRIMARY KEY,
  from_identity_id TEXT NOT NULL REFERENCES observed_identities(id),
  to_identity_id TEXT NOT NULL REFERENCES observed_identities(id),
  basis TEXT NOT NULL CHECK (basis IN ('git_rename', 'unique_merge_base', 'structural_match', 'reviewed')),
  decided_by TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (from_identity_id != to_identity_id),
  UNIQUE (from_identity_id, to_identity_id)
);

-- Subject bridge: written only through a versioned rule or a Review.
CREATE TABLE IF NOT EXISTS subject_observations (
  subject_identity_id TEXT NOT NULL REFERENCES subject_identities(id),
  observed_identity_id TEXT NOT NULL REFERENCES observed_identities(id),
  role TEXT NOT NULL,
  basis TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_run_id TEXT REFERENCES observation_runs(id),
  PRIMARY KEY (subject_identity_id, observed_identity_id, role),
  UNIQUE (observed_identity_id, role, retired_run_id)
);

-- Projection to ordinary evidence, so existing dependencies reach observations.
CREATE TABLE IF NOT EXISTS observed_evidence_projection (
  observed_version_id TEXT NOT NULL REFERENCES observed_versions(id),
  evidence_identity_id TEXT NOT NULL REFERENCES evidence_identities(id),
  evidence_version_id TEXT NOT NULL REFERENCES evidence_versions(id),
  projection_contract_version TEXT NOT NULL,
  PRIMARY KEY (observed_version_id, evidence_identity_id, projection_contract_version)
);

-- ChangeSets: a pure function of the base run, head run, and contract.
CREATE TABLE IF NOT EXISTS observed_changesets (
  id TEXT PRIMARY KEY,
  base_run_id TEXT NOT NULL REFERENCES observation_runs(id),
  head_run_id TEXT NOT NULL REFERENCES observation_runs(id),
  adapter_contract_fingerprint TEXT NOT NULL,
  changeset_fingerprint TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (base_run_id != head_run_id),
  UNIQUE (base_run_id, head_run_id, adapter_contract_fingerprint)
);

-- Change items: generic facts, no materiality.
CREATE TABLE IF NOT EXISTS observed_change_items (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL REFERENCES observed_changesets(id),
  change_kind TEXT NOT NULL CHECK (change_kind IN (
    'added', 'removed', 'moved', 'renamed', 'property-changed',
    'relation-changed', 'continuity-unclear', 'not_comparable')),
  observed_identity_id TEXT NOT NULL REFERENCES observed_identities(id),
  base_version_id TEXT REFERENCES observed_versions(id),
  head_version_id TEXT REFERENCES observed_versions(id),
  successor_identity_id TEXT REFERENCES observed_identities(id),
  basis TEXT NOT NULL,
  changed_properties_json TEXT,
  CHECK (change_kind NOT IN ('moved', 'renamed') OR successor_identity_id IS NOT NULL),
  UNIQUE (changeset_id, observed_identity_id, change_kind)
);

-- Materiality: derived by the Claim family's contract, recomputable.
CREATE TABLE IF NOT EXISTS change_impacts (
  id TEXT PRIMARY KEY,
  change_item_id TEXT NOT NULL REFERENCES observed_change_items(id),
  claim_identity_id TEXT NOT NULL REFERENCES claim_identities(id),
  materiality_contract_version TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('material', 'immaterial', 'not_applicable')),
  decided_at INTEGER NOT NULL,
  UNIQUE (change_item_id, claim_identity_id, materiality_contract_version)
);
```

## 3. Review against the tables it bridges

| Bridged table                                                                                    | Used by the draft                                   | Verdict                                                                                                     |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `subject_identities` (`identity_key UNIQUE`, `contract_version`)                                 | `subject_observations.subject_identity_id`          | Matches. The bridge references the existing identity and adds no second Subject key.                        |
| `subject_continuity` (`from` and `to` distinct, CHECK)                                           | Not written by the observation tables               | Matches. Subject-level continuity stays there. The inventory link is separate.                              |
| `subject_aliases` (`alias_kind`, `alias_key`)                                                    | Not written by the draft                            | Matches. The CARI id alias keeps working for Claims. The draft stores the CARI id as a reference attribute. |
| `evidence_identities` (`identity_key UNIQUE`)                                                    | `observed_evidence_projection.evidence_identity_id` | Matches.                                                                                                    |
| `evidence_versions` (`file_path`, `symbol_id`, span, `repository_revision`)                      | `observed_evidence_projection.evidence_version_id`  | Matches. A projection can fill these from the observed locator.                                             |
| `rule_result_evidence`, `claim_assessment_dependencies` (`dependency_kind = 'evidence_version'`) | Reached through the projection                      | Matches. Reverse Impact uses the existing path, so no new Assessment dependency kind is needed.             |
| `claim_identities`                                                                               | `change_impacts.claim_identity_id`                  | Matches.                                                                                                    |

## 4. Findings from the review

1. **Native parity is already missing before migration 21.** The native Rust
   schema (`packages/cari-native/src/schema.rs`) is at version 16. It defines the
   early claims tables (`claim_identities`, `claim_versions`, `claim_assessments`,
   and their dependency tables). It has none of the tables that schemas 17–20
   introduced in TypeScript: `subject_identities`, `subject_continuity`,
   `subject_aliases`, `claim_subjects`, or any `candidate_*` table. Definition of
   Done item 14 requires TypeScript and native schema creation to match. That was
   not met for 17–20. Migration 21 cannot satisfy it either. See decision A.
2. **Effective version must belong to the identity.** The composite foreign key
   in `observation_run_items` enforces that the run's effective version belongs to
   the same identity. This is enforced by SQL, not by code.
3. **Partial coverage needs a reason.** The CHECK on `observation_run_coverage`
   ensures that a partial kind names why it is partial. A partial kind can never
   produce a `removed` change item. That rule is enforced in code, because it
   crosses tables.
4. **Continuity is never duplicated.** `observed_continuity_links` has no
   Subject-level semantics, and Subject links are never copied into it. Both
   constraints are code-level invariants. The schema cannot express them across
   tables.
5. **The bridge is written only by rule or Review.** `subject_observations`
   carries a `basis` and a `contract_version`, and no column records automatic
   creation. Writing it only through rules or Reviews is a code-level invariant.
   See decision B.
6. **Membership growth is bounded by objects times runs.** `observation_run_items`
   adds one row per present identity per run. Versions are stored only on payload
   change. Retention is open (decision C).
7. **The end-to-end path is not yet validated through projection.** The tracer
   spike validated the ChangeSet and bridge, but it did not write projection rows,
   so the path through `observed_evidence_projection` into Reverse Impact is
   untested. O2 must test it.
8. **`ALTER`-only migration.** The draft adds tables only. It changes no existing
   table, so it is additive and transactional. Following G1, it creates a
   pre-migration snapshot and supports restore on failure. Downgrade is not
   supported.

## 5. Open decisions to accept before O1

- **A. Native parity for claims tables.** Options:
  1. Port claims tables 17–21 into the native schema. This is large and touches
     the Rust crate for every claims schema change.
  2. Amend Definition of Done item 14: native parity covers the CARI tables and
     the claims tables that the native schema already defines (through schema 16).
     The tables introduced in schemas 17 and later are owned by the TypeScript
     schema. A test asserts the native tables match, and asserts that the
     TypeScript-only tables are created only by the TypeScript path.
     Recommendation: option 2, recorded explicitly, with item 14 amended to match.
- **B. Creation policy for `subject_observations`.** Options: automatic for
  implementation-view objects, or only through a versioned rule or Review.
  Recommendation: only through a rule or Review. Implementation-view objects stay
  inventory-only until a Claim references them.
- **C. Retention.** Options: keep all runs, or prune runs that no ChangeSet or
  Assessment references. Recommendation: keep all runs until O4 measures volume,
  then decide.

## 6. O0 exit criteria

- Decisions A, B, and C are accepted, and the plan records them.
- This draft is reviewed, and its findings are resolved or recorded as open.
- The plan's Definition of Done item 14 is amended if decision A is option 2.
- No code or schema change is made in O0. The first code change is O1.
