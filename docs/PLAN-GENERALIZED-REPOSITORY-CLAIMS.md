# Generalized Repository Claims

> **Version:** 0.8
> **Status:** Follow-on concept / implementation plan
> **Date:** 2026-08-20
> **Starting point:** IntentWeave Vertical Slice V5.1.x and the implemented parameter-centered Claims slice

## 1. Purpose

The existing Claims vertical slice demonstrates a robust end-to-end path for
configurable values:

```text
discover
-> correlate
-> derive
-> assess
-> review
-> change impact
-> reopen or carry forward
-> explain why
```

This plan extends that slice to general, verifiable statements about a
repository. It does not replace the existing parameter slice. The parameter
slice continues as the first specialized claim family under a more general
Subject model.

The goal is not to ask an LLM whether arbitrary statements are true or false.
The goal remains an evidence-grounded lifecycle with explicit identities,
versioned contracts, governed decisions, and reproducible results. Semantic
models may propose candidates and correlations where deterministic analysis does
not provide enough recall, but they are not the authority that promotes or
assesses a Claim. Once a Claim is promoted, its verification path must remain
deterministic and must not require a model call in CI.

## 2. Current Starting Point

The implemented slice currently supports:

- provisional code discovery for scalar TypeScript and JavaScript literals,
- canonical parameter bindings through `intentweave.bindings.yaml`,
- code, JSDoc, YAML, scope, and documentation evidence,
- `CLM-LITERAL`, `CLM-DEFAULT`, `CLM-EFFECTIVE`, and
  `CLM-DOC-CONFORMANCE`,
- R1, R3, and R7 RuleResults,
- append-only Evidence, RuleResult, Claim, Assessment, and Review versions,
- Git continuity, materiality checks, and `check --since`,
- carry-forward, reopen, explain, and CI exit codes,
- persistent Claims history across a complete CARI rebuild.

The central limitation is structural: every `ClaimIdentity` currently points to
exactly one `ParameterIdentity`. Manifest-free code findings work, but they also
receive a provisional code-based parameter identity.

The slice can therefore express statements about values and defaults, but not
general Claims such as:

- "The endpoint `POST /admin/users` is authenticated."
- "The `ui` module does not depend directly on `persistence`."
- "The exported handler conforms to its documented contract."
- "The current dependency graph complies with ADR-17."
- "The public function `parseConfig` documents its error cases."

### 2.1 Implemented and Planned

This plan explicitly distinguishes the currently executable slice from the
target state. Examples of general Claims do not imply that those capabilities
have already shipped.

| Area           | Implemented today                                                             | Target of this extension                                         |
| -------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Subject        | exactly one `ParameterIdentity` per Claim                                     | multiple typed `SubjectIdentity` roles                           |
| Discovery      | scalar TypeScript and JavaScript parameter findings are materialized directly | persistent Candidates before any Claim promotion                 |
| Claim families | Literal, Default, Effective, and Doc Conformance                              | additional Symbol, Endpoint, and Architecture Claims             |
| Curation       | Assessment Review for materialized Claims                                     | Candidate Review before Assessment Review                        |
| AI             | not required for check or CI                                                  | optional semantic discovery, extraction, correlation, and triage |
| CI             | `iw claims check` for the parameter slice                                     | promoted Claims under the unified Intent Runtime entry point     |
| Persistence    | Claims and Review history in `.iw/index.db`                                   | portable effective decisions plus a SQLite projection            |

## 3. Target State

IntentWeave treats general repository Claims as verifiable, versioned
statements:

```text
CARI evidence adapters
-> Deterministic and semantic induction
-> Candidate discovery
-> Subject correlation
-> Candidate triage
-> Candidate promotion
-> Claim derivation
-> Rule evaluation
-> Claim assessment
-> Assessment review
-> Reverse impact
-> Explanation and history
```

The layers have separate responsibilities:

1. **Evidence** records deterministic observations from code, documents,
   configuration, and Git.
2. **Discovery and semantic induction** find possible Claim Candidates through
   deterministic adapters, semantic adapters, or both.
3. **Correlation** determines which durable repository Subjects the Evidence and
   Candidates refer to.
4. **Candidate triage** decides whether a possible statement is relevant enough
   to govern over time.
5. **Promotion** turns only accepted Candidates into active Claims.
6. **Derivation** creates normalized Claims from promoted, correlated
   observations.
7. **Rules** evaluate applicable predicates with sufficient Evidence.
8. **Policies** aggregate assertions and warrants into Assessments.
9. **Assessment Review** records human decisions about current Assessments and
   their lifecycle.
10. **Impact** identifies affected Claims through persisted Dependencies.

### 3.1 Product and Component Boundary

Generalization does not create a third IntentWeave product. It adds a Claims
lifecycle to the Intent Engine that turns CARI Evidence into curated, verifiable
statements:

```text
CARI Evidence Engine
observe code, documents, configuration, and Git
        |
        v
Semantic Induction and Claims Lifecycle (part of the Intent Engine)
discover, extract, correlate, triage, promote, assess, review, and explain
        |
        v
Intent Runtime
deterministically enforce promoted Claims in CI
```

The logical responsibilities are explicitly separated:

| Component                          | Owns                                                                                                             | Explicitly does not own                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| CARI Evidence Engine               | AST, documentation, import, call-graph, and Git observations plus queryable Evidence                             | human Reviews, Candidate promotion, or semantic truth judgments      |
| Semantic Discovery and Correlation | grounded Candidate and Subject proposals from deterministic rules or models                                      | authoritative promotion, Assessment, or silent `certain` correlation |
| Claims Lifecycle                   | Subject and Candidate identity, promotion, Claim versions, Assessments, Reviews, continuity, reopen, and explain | raw code indexing or unconstrained truth judgments                   |
| Intent Runtime                     | versioned Rule and Policy contracts, deterministic evaluation, unified Findings, and CI exit semantics           | repeated AI evaluation on every check                                |

CARI guarantees a deterministic Evidence substrate, not complete Claim
discovery. Generalized Claims may need semantic extraction to achieve useful
recall and correlation across code, prose, and configuration. This does not
change the CARI product contract: no model is required to build or query the
CARI index, and CARI commands do not create, interpret, or modify human
decisions. A shared SQLite database may carry those decisions in logically
separate Claims tables.

The Claims lifecycle supports deterministic and semantic Discovery and
Correlation adapters. Semantic adapters may propose grounded Candidates and
Subject mappings. Humans or explicitly approved project Policies decide whether
those proposals become effective. Promoted Claims are then checked
reproducibly, without a required model call.

The CLI reflects this separation:

- `iw index ...` observes and queries CARI Evidence.
- `iw claims ...` is the domain workbench for Discovery, semantic induction,
  triage, Review, history, and explain.
- `iw intent check` is the long-term primary product and CI entry point for all
  promoted Claims and existing Intent rules.

`iw claims check` remains available as a direct expert and compatibility entry
point. It must not become a second check engine with different semantics.
`iw claims check` and the Claims portion of `iw intent check` use the same
Runtime contract and persisted results.

## 4. Guiding Principles

The extension preserves the contracts established by the vertical slice:

- **Silence is not success:** missing positive Evidence is not automatically
  `passed`.
- **Identity before version:** Subject, Evidence, RuleResult, and Claim have
  durable identities and append-only versions.
- **Applicability is explicit:** `not_applicable` is neither success nor failure.
- **Claim-family-specific authority:** authority is defined per Claim family,
  not through a global source ranking.
- **Materiality is semantic:** path, span, and commit changes alone do not cause
  a reopen.
- **Deterministic substrate, hybrid induction:** CARI records reproducible facts;
  deterministic or semantic adapters may infer possible Claims from those
  facts.
- **Grounded model output:** every semantic proposal cites Evidence versions and
  records its model, prompt, contract, input, and output fingerprints.
- **AI proposes; Policies or humans decide:** a model cannot promote a Candidate
  or create a `certain` correlation without an explicitly approved Policy and a
  verifiable anchor.
- **Extract when inputs change; verify repeatedly:** semantic induction is
  incremental and cached. Checks of already promoted Claims do not call a model.
- **Reproducibility:** the same repository, contract, effective inference, and
  Policy state produce the same domain result.
- **Review is a separate layer:** a technical Assessment is not a human
  approval.
- **Candidate Review is not Assessment Review:** the first asks whether a
  statement should be governed; the second asks whether the current evaluation
  of that statement is accepted.
- **No new runtime services or database backends:** SQLite and existing CARI
  data remain the operational substrate. Versioned repository artifacts are
  compatibility surfaces that are imported into SQLite, not a second Runtime
  or persistence service.

## 5. General Subject Model

### 5.1 `SubjectIdentity`

`SubjectIdentity` denotes a durable domain object about which Claims can be
made.

Full target Subject vocabulary:

```text
parameter
symbol
endpoint
module
component
document
architecture-rule
```

G1 initially reserves only `parameter`, `symbol`, `module`, and `endpoint`.
Additional kinds enter the persisted vocabulary with their corresponding Claim
family rather than being treated as implemented in G1.

Proposed core:

```ts
interface SubjectIdentity {
  id: string;
  kind: SubjectKind;
  identityKey: string;
  displayName: string;
  lifecycleState: "active" | "retired";
  createdAt: number;
}
```

`identityKey` is adapter-specific and must not contain a transient position.
Examples:

- Parameter: `parameter:session.timeout`
- Symbol: `symbol:typescript:<stable-structure-id>`
- Endpoint: `endpoint:http:POST:/admin/users`
- Module: `module:workspace:@intentweave/index`
- Architecture rule: `architecture-rule:no-ui-to-persistence`

### 5.2 Claims Can Have Multiple Subjects

A single `subject_identity_id` on `claim_identities` would be too restrictive.
The Claim "Module A must not import Module B" refers to at least two Subjects
with different roles.

A role-based relationship is therefore introduced:

```text
claim_subjects(
  claim_identity_id,
  subject_identity_id,
  subject_role
)
```

Examples of `subject_role`:

- `subject` for a Parameter or Symbol Claim,
- `source` and `target` for a dependency statement,
- `endpoint` and `guard` for an authentication Claim,
- `document` and `implementation` for conformance Claims.

The same principle applies to Evidence:

```text
evidence_subjects(
  evidence_identity_id,
  subject_identity_id,
  subject_role,
  basis,
  confidence
)
```

### 5.3 `ParameterIdentity` Remains Compatible

`ParameterIdentity` is not deleted or renamed initially. It becomes a domain
subtype of `SubjectIdentity`:

```text
subject_identities
  ^
  |
parameter_identities.subject_identity_id UNIQUE
```

In SQLite, G1a implements this as an initially nullable column followed by
backfill, duplicate and null validation, and a separate unique index. It does
not attempt `ALTER TABLE ... ADD COLUMN ... UNIQUE`. If the final schema requires
an inline `NOT NULL` constraint, that constraint is introduced through a
transactional table rebuild.

A Subject is backfilled deterministically for every existing Parameter
identity. Existing IDs, Claim identities, Assessments, and Reviews remain
unchanged.

Migration is additive and takes place in two consecutive G1 schema releases:

1. **G1a / Subject foundation:** add Subject identities, aliases, and role-link
   tables; add and backfill `parameter_identities.subject_identity_id`; and
   dual-write the existing Parameter Claim and Evidence relationships. The
   mandatory `claim_identities.parameter_identity_id` remains authoritative for
   legacy Parameter Claims in this step.
2. **G1b / generic Claim activation:** transactionally rebuild the Claim
   identity storage so `parameter_identity_id` becomes a nullable legacy
   compatibility link. `claim_subjects` becomes authoritative for generic
   Claims, including Claims with multiple Subject roles. Existing Parameter
   rows retain their original foreign key and IDs; generic Claims do not receive
   synthetic Parameter identities.

The already nullable Evidence-to-Parameter link remains available for legacy
readers while `evidence_subjects` becomes authoritative for generic Evidence.
Old Parameter foreign keys are removed only after a complete migration and
recovery cycle. G1 does not introduce down migrations. Before each schema step,
the migrator creates a durable pre-migration database snapshot and restores it
atomically if the step fails. Supported release rollback means restoring that
snapshot before G1b-only writes are accepted; downgrade after new-version-only
writes is explicitly unsupported. G1 is complete only after both schema
releases, including stepwise forward-migration, snapshot-restore, and
history-preservation tests.

## 6. Candidate Discovery as a Separate Layer

Today, a code finding is materialized immediately as a Claim. That is too
aggressive for general Claims. Discovery first creates durable Candidates:

```text
claim_candidates
candidate_evidence
candidate_subjects
candidate_inferences
candidate_reviews
candidate_policy_decisions
```

A Candidate contains at least:

```ts
interface ClaimCandidate {
  id: string;
  candidateKind: string;
  proposedClaimType: string;
  discoveryMode: "deterministic" | "semantic" | "manual";
  discoveryAdapterId: string;
  discoveryContractVersion: string;
  inferenceId?: string;
  confidence: "certain" | "probable" | "ambiguous";
  state:
    | "discovered"
    | "correlated"
    | "triaged"
    | "promoted"
    | "rejected"
    | "suppressed"
    | "superseded";
  fingerprint: string;
}
```

Important rules:

- A Candidate is not yet an assessed Claim.
- Annotation-only Candidates are persisted even when they are not surfaced
  immediately.
- Ambiguous findings are persisted as `ambiguous`, not discarded.
- `@example`, fixtures, and generated artifacts are excluded with a reason.
- An unchanged scan does not create a new Candidate version.
- Rejected and suppressed Candidates retain their fingerprint and rationale so
  that every scan does not recreate the same work.
- Only a promoted Candidate materializes or activates a Claim for Assessment,
  Review, reopen, and CI.

### 6.1 Deterministic and Semantic Discovery

Deterministic Discovery remains the preferred path for high-precision signals:

- explicit bindings and repository configuration,
- AST structure, exports, signatures, literals, and annotations,
- import, call-graph, route, and framework structures,
- exact documentation patterns and stable identifiers.

Semantic Discovery is an additional adapter class for signals that cannot be
recovered reliably from syntax alone:

- intent statements in ADRs and prose,
- semantically equivalent names across code, configuration, and documentation,
- implicit relationships and domain terminology,
- Candidate grouping, deduplication, and relevance ranking.

Every model-backed result is persisted as a versioned inference:

```ts
interface CandidateInference {
  id: string;
  adapterId: string;
  contractVersion: string;
  mode: "model";
  providerId: string;
  modelId: string;
  promptVersion: string;
  inputFingerprint: string;
  outputFingerprint: string;
  evidenceVersionIds: string[];
  proposedSubjectBindings: unknown[];
  confidence: "probable" | "ambiguous";
  rationale: string;
  createdAt: string;
}
```

The inference contract is strict:

- model output without source spans or Evidence IDs is `ambiguous`,
- a model proposal alone cannot establish `certain` Subject continuity,
- the same input and contract reuse the persisted inference instead of calling
  the model again,
- a changed model, prompt, adapter contract, or source input creates a new
  inference version and never rewrites the old result,
- re-running semantic induction may reclassify Candidates but does not silently
  rewrite promoted Claims or effective Reviews,
- disabling semantic adapters reduces recall explicitly; it must not turn
  missing semantic Evidence into success.

Semantic induction is an authoring and refresh capability, not a hidden CI
dependency. A separate Discovery job or local workflow may call a model when
inputs change. Checks of already promoted Claims consume persisted effective
artifacts and deterministic Evidence.

### 6.2 Surfacing

The default for new Claim families is:

- surface immediately when there is a conflict,
- surface immediately for a `certain` deterministic correlation,
- otherwise surface after at least two independent Source Kinds or a grounded
  semantic recommendation,
- keep annotation-only and low-confidence Candidates visible under
  `claims discover --all`.

R1 Parameter Claims that are current before migration retain their lifecycle so
existing users do not lose Claims. They are materialized as effective promotions
by the versioned `r1-compatibility` Policy, which is a one-time migration
backfill rather than a continuing auto-promotion rule. An explicit Parameter
binding remains a deliberate governance action and promotes through a separate
versioned `explicit-binding` Policy. New unbound findings after migration start
as Candidates.

Projects that intentionally want the pre-generalization behavior for future R1
findings enable a separate versioned `r1-continuous-auto-promote` Candidate
Policy. Upgrade and initialization flows state and persist that choice
explicitly; they do not infer it from existing database contents. Explain names
which Policy promoted each Claim, so changed coverage cannot remain silent.

### 6.3 Candidate Triage and Promotion

Candidate Triage answers a different question from Assessment Review:

```text
Candidate Review:  Is this statement relevant and should it be governed?
Assessment Review: Do I accept its current evaluation and Evidence?
```

A persisted Candidate Review contains at least:

```ts
interface CandidateReview {
  id: string;
  candidateId: string;
  actorKind: "human" | "ai" | "policy";
  actorId: string;
  decision: "promote" | "reject" | "suppress" | "defer";
  effect: "recommendation" | "effective";
  rationale: string;
  provenance: unknown;
  createdAt: string;
}
```

Decision semantics are fixed:

- `promote`: the statement becomes an active Claim and is checked over time.
- `reject`: this specific Candidate is not a meaningful repository statement.
- `suppress`: the Candidate is understandable but an explicit project Policy
  chooses not to govern it.
- `defer`: Evidence or correlation is not sufficient for a decision; the
  Candidate remains `triaged` and eligible for a later Review.

The state transitions are explicit:

```text
discovered -> correlated -> triaged
triaged + promote  -> promoted
triaged + reject   -> rejected
triaged + suppress -> suppressed
triaged + defer    -> triaged
```

`superseded` is a system transition when a newer Candidate version or Discovery
contract replaces the effective Candidate. It is not a `CandidateReview`
decision. Every transition retains the Review or system provenance that caused
it.

Manual triage is the trust anchor. AI may group Candidates, identify possible
duplicates, propose Subjects and Claim types, prioritize the inbox, and provide
a rationale. Every recommendation stores model, model version, prompt or Policy
version, confidence, and Evidence IDs. Without an explicit, versioned project
Policy, it remains a proposal and does not create an active Claim. An AI entry
therefore has `effect: "recommendation"` by default. Only a human decision or an
approved Policy has `effect: "effective"` and changes Candidate state.

Repeated decisions can be turned into a versioned Candidate Policy, such as
"promote public mutating endpoints" or "suppress test fixtures." Policy
decisions are materialized per Candidate in `candidate_policy_decisions` so
Explain and reproduction do not depend on a later Policy version.

Changes to Discovery, inference, or Candidate Policies may reclassify
Candidates. They do not by themselves reopen existing Assessment Reviews. Only
a material change to an effective Evidence, Subject, Rule, inference dependency,
or Assessment of a promoted Claim may enter the Assessment Review lifecycle.

### 6.4 First User Flow

The primary adoption path visibly separates observation, semantic induction,
selection, and enforcement:

```text
iw index build
-> iw claims discover [--ai]
-> iw claims candidates triage [--ai]
-> iw claims candidates review --decision promote|reject|suppress|defer
-> iw claims check
-> iw claims explain
-> iw intent check
```

A first scan may show unpromoted Candidates, but Candidate existence alone must
neither imply repository conformance nor activate a new CI gate. Only an
effective human or Policy-based promotion enters a Claim into the Assessment,
Review, reopen, and CI lifecycle.

This is an intentional change from the current parameter-only behavior, where
empty Discovery yields exit `2` and a materialized, unreviewed Claim can yield
exit `4`. The target commands separate those cases:

- successful `claims discover` returns exit `0` even when it finds Candidates;
  operational and contract failures remain non-zero,
- direct `claims check` with no active promoted or compatibility Claim returns
  exit `2` with reason `no_active_claims`, so absence is not reported as
  success,
- the Claims portion of `iw intent check` remains `not_evaluated` when only
  unpromoted Candidates exist and therefore does not change the exit result of
  other Intent checks,
- once a Claim is promoted, an existing compatibility Claim is active, or the
  Claims gate is explicitly enabled, missing Evidence and missing Review retain
  their defined `inconclusive` and `review_required` exits.

The versioned `r1-compatibility` Policy preserves the current lifecycle for
Claims backfilled during migration. Explicit bindings remain effective through
the `explicit-binding` Policy. Neither Policy promotes newly discovered unbound
R1 findings. Continued automatic promotion requires the explicit
`r1-continuous-auto-promote` Policy; otherwise those findings remain visible
Candidates until reviewed.

`not_evaluated` is a gate-level orchestration state, not a RuleResult,
Assessment, or Claim status. It means that the Claims gate had no active Claim
inventory to evaluate, creates no Assessment, and contributes no exit code to
`iw intent check`. The equivalent direct `iw claims check` invocation remains
`inconclusive` with exit `2` and reason `no_active_claims`.

The default view is a prioritized, bounded inbox, not a dump of every
syntactically or semantically possible statement. `--all` is the explicit path
to the complete Discovery and diagnostic view.

## 7. Correlation

Correlation connects Candidates and Evidence to durable Subjects. Priority is:

1. explicit binding or stable repository ID,
2. deterministic structural assignment,
3. versioned continuity from Git provenance,
4. grounded semantic proposal with `probable` confidence,
5. conservative heuristic with `probable` confidence,
6. otherwise `ambiguous` rather than a silent assignment.

IntentWeave does not correlate solely because names are similar or literal
values are equal. A semantic adapter may propose a mapping, but it cannot create
a `certain` assignment without a verifiable anchor. The proposal records its
Evidence, inference contract, confidence, and rationale.

Subject-specific Correlators:

| Subject           | Stable basis                                       | Continuity                        |
| ----------------- | -------------------------------------------------- | --------------------------------- |
| Parameter         | canonical Config key or explicit binding           | existing Parameter contract       |
| Symbol            | CgId or structure fingerprint plus container role  | Git rename and unique predecessor |
| Endpoint          | normalized method and route plus framework adapter | route or handler rename           |
| Module            | Workspace or Package identity                      | Package and path rename           |
| Architecture rule | explicit Rule ID                                   | versioned Rule contract           |

## 8. Extensible Claim and Rule Contracts

### 8.1 Claim Family

Each Claim family is described by a versioned contract:

```ts
interface ClaimFamilyDefinition {
  claimType: string;
  contractVersion: string;
  supportedSubjectRoles: Record<string, SubjectKind[]>;
  statementSchemaVersion: string;
  discoveryAdapterIds: string[];
  correlationAdapterIds: string[];
  ruleIds: string[];
  assessmentPolicyId: string;
  assessmentPolicyVersion: string;
  surfacingPolicyId: string;
}
```

The contract is TypeScript code with JSON-compatible inputs and outputs at
first. Arbitrary executable project code or a free-form YAML Rule language is
not part of the first extension.

### 8.2 Discovery and Correlation Adapters

Every adapter declares whether it is deterministic or model-backed:

```ts
interface InductionAdapterDefinition {
  id: string;
  contractVersion: string;
  mode: "deterministic" | "model";
  inputSchemaVersion: string;
  outputSchemaVersion: string;
}
```

Deterministic adapters emit reproducible Candidates directly. Model-backed
adapters emit versioned `CandidateInference` artifacts. Both use the same
normalized Candidate and Subject proposal schemas, allowing Policies and UI to
operate without provider-specific branches.

### 8.3 Structured Inference Transport

IntentWeave already has a low-level `LLMProvider` contract in
`@intentweave/core` and an `llm` plugin capability. Generalized Claims reuse and
versionably extend that contract; they do not introduce a second
Claims-specific LLM transport abstraction. The current contract is not reused
as-is because it loses refusal, content-filter, effective-model, request, and
detailed usage information before a higher layer can inspect it.

The implementation first extends the public `LLMProvider` transport contract to
v2, then adds a narrow `StructuredInferenceService` above it and below semantic
induction adapters:

```text
LLMProvider
provider transport
        |
        v
StructuredInferenceService
schema enforcement, local validation, errors, provenance, and fingerprints
        |
        v
SemanticInductionAdapter
Claims prompts, Evidence grounding, and CandidateInference
```

The v2 transport extension is part of G2 and includes:

- `LLMRequest.signal` in addition to the existing `timeoutMs`, with cancellation
  remaining distinguishable from timeout,
- distinct finish reasons for `refusal`, `content_filter`, `length`, `error`,
  and unknown provider outcomes instead of mapping unknown values to `stop`,
- optional provider request ID and model revision plus reasoning-token and
  cached-input-token usage,
- the effective model ID returned by the provider,
- capability resolution for the effective per-request model rather than only a
  configured default model,
- adapter contract tests that verify provider-specific refusal and filtering
  payloads before the normalized response reaches Structured Inference.

Provider contract negotiation is explicit: absence of a transport contract
version means v1; a v2 provider declares `contractVersion: 2` and resolves
capabilities for a requested model through a model-aware method rather than only
the existing static `capabilities` property. `StructuredInferenceService`
requires v2. This is a versioned evolution of the same SPI, not a parallel
Claims provider interface.

Existing text-generation callers continue through a compatibility adapter
during migration. A legacy provider that cannot preserve terminal outcome
semantics may still serve legacy text calls, but it cannot advertise support for
Claims Structured Inference. The OpenAI adapter must read refusal fields and
request metadata explicitly; an unknown finish reason remains `other` and is
never treated as a clean stop.

Proposed normalized boundary:

```ts
interface StructuredInferenceRequest {
  schemaName: string;
  responseSchema: Record<string, unknown>;
  system?: string;
  messages: LLMMessage[];
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface StructuredInferenceMeta {
  providerId: string;
  requestedModelId?: string;
  effectiveModelId: string;
  modelRevision?: string;
  requestId?: string;
  structuredOutput: "strict" | "json" | "text";
  finishReason:
    | "stop"
    | "length"
    | "refusal"
    | "content_filter"
    | "error"
    | "other";
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  latencyMs: number;
  rawOutputFingerprint?: string;
}

type StructuredInferenceResult =
  | {
      ok: true;
      value: unknown;
      meta: StructuredInferenceMeta;
    }
  | {
      ok: false;
      failure: {
        kind:
          | "rate_limit"
          | "timeout"
          | "cancelled"
          | "refusal"
          | "content_filter"
          | "truncated"
          | "invalid_json"
          | "schema_mismatch"
          | "transport"
          | "provider";
        retryable: boolean;
        statusCode?: number;
        message: string;
      };
      meta: StructuredInferenceMeta;
    };
```

The service contract is deliberately stricter than any provider wire format:

- every parsed result is validated locally against the requested schema, even
  when a provider claims native Structured Output support,
- invalid JSON, schema mismatch, refusal, content filtering, truncation, and
  transport failure remain distinct typed outcomes,
- retryability, rate limiting, timeout, and cancellation are represented
  explicitly rather than flattened into an error string,
- provider capabilities are resolved for the effective model used by the
  request, not only for a configured default model,
- provider ID, effective model, model revision when available, request ID,
  finish reason, usage, and output mode are retained for `CandidateInference`
  provenance,
- streaming and tool calling are not required for the first Claims induction
  path and must not be advertised unless the provider contract exposes them,
- prompt, Evidence input, normalized output, and contract fingerprints remain
  the responsibility of the semantic induction adapter, not the transport.

OpenAI-compatible Chat Completions is treated as a useful de facto transport
adapter, not as the IntentWeave domain contract and not as proof of feature
parity. Provider-specific adapters may use native APIs when strict Structured
Outputs or provenance cannot be represented by the compatibility surface.

A third-party provider framework such as the AI SDK may be used internally by
`plugin-llm` to implement provider coverage. Its public types must not cross the
`@intentweave/core` boundary, so adopting, replacing, or upgrading that framework
does not change Claim, inference, or plugin contracts.

### 8.4 Rule Adapters

Rule Adapters remain pure functions:

```ts
interface RuleEvaluation {
  applicability: "applicable" | "not_applicable";
  status: "passed" | "failed" | "inconclusive" | "not_applicable";
  output: unknown;
  reasons: string[];
  evidenceVersionIds: string[];
}
```

Every persisted RuleResult version continues to contain:

- `rule_contract_version`,
- `implementation_fingerprint`,
- normalized output and reasons,
- direct Evidence Dependencies.

R1, R3, and R7 are registered as the first Parameter Claim family under this
contract model. Their domain semantics and existing identity and fingerprint
outputs do not change. Their internal implementation does change where it moves
to generalized Subject and materiality contracts, so compatibility is enforced
through pinned v1 golden vectors rather than assumed to be additive.

## 9. Planned Claim Families

### 9.1 Existing: Parameter Values

```text
CLM-LITERAL
CLM-DEFAULT
CLM-EFFECTIVE
CLM-DOC-CONFORMANCE
```

This family remains the reference path for versioning, materiality, scopes, and
the Review lifecycle.

### 9.2 Next Slice: Documented Public Symbol Contract

This slice demonstrates the first non-Parameter Claim with low framework risk.

Example:

```text
Subject: exported symbol parseConfig
Claim:  CLM-PUBLIC-SYMBOL-DOCUMENTED
```

Evidence:

- exported Symbol and signature from AST and CARI,
- directly attached JSDoc description,
- documented Parameters and error cases,
- optional reference in Markdown or API documentation.

RuleResults:

- `passed` when the required positive documentation is present unambiguously,
- `failed` when an existing contract contradicts the signature,
- `inconclusive` when extraction or assignment is ambiguous,
- `not_applicable` when the Symbol is not public.

### 9.3 Second Slice: Endpoint Protection

Example:

```text
Subject: POST /admin/users
Claim:  CLM-ENDPOINT-AUTHENTICATED
```

Evidence:

- Route and handler,
- authentication middleware or guard,
- framework configuration,
- documented security requirement.

This slice specifically exercises "silence is not success." An Endpoint is not
considered protected merely because no violation was found. Positive Guard
Evidence appropriate for the framework must exist.

### 9.4 Third Slice: Architecture Dependency

Example:

```text
Subjects: ui (source), persistence (target)
Claim:   CLM-DEPENDENCY-CONFORMANCE
```

This slice uses existing CARI imports and `.iw` architecture Rules, but emits
normalized positive, negative, and incomplete results rather than only a list of
violations.

## 10. Persistence

The existing Claims companion layer remains. Schema changes follow the current
one-step, version-guarded migration discipline and are split at the G1/G2
boundary rather than bundled into one large version. Assuming implementation
starts from the current schema version `16`, the sequence is:

| Schema | Phase | Change                                                                                                                                            |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `17`   | G1a   | add `subject_identities`, `subject_aliases`, `claim_subjects`, and `evidence_subjects`; backfill Parameter Subjects and dual-write                |
| `18`   | G1b   | rebuild Claim identity storage with nullable legacy Parameter linkage and authoritative role-based Subjects                                       |
| `19`   | G2    | add `claim_candidates`, `candidate_evidence`, `candidate_subjects`, `candidate_inferences`, `candidate_reviews`, and `candidate_policy_decisions` |

If the baseline schema advances before implementation, the numbers shift but
the order, transaction boundaries, and one-version-at-a-time migrations do not.
Splitting is based on dependency and recovery boundaries, not on an arbitrary
table-count limit.

### 10.1 Identity and Versioning

- Subject identities are durable and are not derived from file paths when a more
  stable domain basis exists.
- Candidates, inferences, Evidence, RuleResults, Claims, and Assessments remain
  append-only.
- Candidate Reviews and materialized Policy decisions remain append-only and
  reference the effective Candidate, inference, and Policy versions.
- A -> B -> A creates a new observation version and never reactivates an old row.
- Current continues to mean the highest valid version or an explicit lifecycle
  state, not "whatever was read most recently."

### 10.2 Materiality

A global material fingerprint is not sufficient for general Claims. Each Claim
family defines a versioned identity and materiality contract.

The existing Parameter family is frozen as a compatibility contract:

```text
ParameterClaimIdentityV1
  = parameter identity + claim type + scope

ParameterMaterialityV1
  = parameter identity + semantic location + normalized value
```

G0 records golden vectors for existing Parameter, Evidence, Claim, and
material-fingerprint IDs. Migration must retain those exact outputs and must not
recompute historical IDs from generalized Subject rows. Existing rows without
an explicit contract-version column are interpreted as v1. New generalized
records persist their identity and materiality contract versions so a later
contract change appends or migrates deliberately instead of silently changing
identity.

The frozen formulas, concrete vectors, public exit codes, and executable
compatibility-suite mapping are recorded in
`docs/CLAIMS-PARAMETER-COMPATIBILITY-V1.md`.

Examples:

- Parameter: value, semantic location, and Parameter Subject,
- Symbol contract: public signature and documentation-relevant metadata,
- Endpoint: method, normalized route, Guard set, and Policy,
- Dependency: Source, Target, edge kind, and Architecture Rule.

Path, span, commit, formatting-only changes, and model wording remain excluded by
default. A changed effective semantic binding is material only when its
normalized Subject or Claim meaning changes, not merely because a model produced
different prose.

### 10.3 Reverse Impact

Reverse Impact remains a SQLite join over versioned Dependencies:

```text
changed EvidenceVersion or contract
-> RuleResultVersion
-> ClaimAssessment
-> ReviewDecision/Reopen
```

Subject and effective inference changes add:

```text
changed SubjectIdentity/alias/continuity or effective inference
-> evidence_subjects, candidate_subjects, and claim_subjects
-> affected current assessments
```

### 10.4 Portability and Source of Truth

SQLite remains the operational, queryable projection for Discovery, Evidence,
versions, Dependencies, and Reverse Impact. Effective human decisions and
project Policies must not exist only in a local, gitignored `.iw/index.db` in the
target state.

At least the following are repository-portable and versioned with a
`schemaVersion`:

- Candidate Policies and explicit bindings,
- effective promotion, rejection, and suppression decisions,
- effective normalized semantic bindings required by promoted Claims,
- Assessment Reviews trusted by both the team and CI,
- required Actor, basis, inference, and provenance information.

Purely local Discovery results, unaccepted AI recommendations, provider payloads,
and reproducible RuleResult or Assessment projections do not need to be stored
in Git. The portable artifact stores the normalized effective result and enough
provenance to audit it, not necessarily the full provider request or response.

When SQLite is built, portable decisions and effective semantic bindings are
imported and validated against their referenced identities. Missing or ambiguous
references are `inconclusive` or require migration; they are never silently
reassigned.

The portable v1 artifact is `.iw/claims/state.yaml`. It is human-reviewable YAML
validated against a strict, versioned domain schema with these top-level maps:

```text
schemaVersion
policies
candidateDecisions
subjectBindings
assessmentReviews
baselineAcceptances
```

The contract is fixed as follows:

- the artifact stores only the currently effective governance state; Git is its
  portable history, while SQLite retains the complete operational append-only
  history,
- entries reference durable domain identity keys and content fingerprints, not
  local SQLite row IDs,
- every Policy actor carries its own Policy ID and version; Assessment Reviews
  name the Assessment Policy separately so decision provenance and evaluation
  provenance cannot be conflated,
- `intentweave.bindings.yaml` remains the explicit Parameter binding source and
  is not duplicated; its effective promotions are projected with
  `explicit-binding` provenance,
- an Assessment Review is imported only when its assessment and Policy
  fingerprints match; a stale basis reopens or becomes `inconclusive` rather
  than being silently accepted,
- the portable Assessment fingerprint is content-addressed over the durable
  Claim identity, normalized statement, epistemic status, Assessment Policy,
  and each dependency's semantic projection and role; Evidence contributes its
  Source Kind and material fingerprint, while Rule Results contribute identity,
  applicability, normalized status/output/reasons, and Rule Contract version but
  not their implementation fingerprint; paths, SQLite row IDs, and local version
  ordinals are excluded,
- during G0, portable Assessment Reviews bootstrap only a fresh SQLite
  projection with no Review history for that Claim; once local Review history
  exists, carry-forward and reopen semantics remain authoritative and import
  does not overwrite or reinterpret them,
- export order is canonical, writes are atomic, and export -> import -> export is
  byte-identical,
- duplicate YAML keys, conflicting effective entries, unknown fields, and
  unsupported schema versions fail closed with an actionable validation error,
- provider payloads, complete prompts, secrets, and source excerpts are excluded;
  only normalized decisions and required provenance are portable,
- CLI commands own atomic updates, but manual edits are supported when they pass
  the same validation contract.

Once published, the file path and schema are compatibility surfaces. Schema
changes require an explicit version, migration, and round-trip tests.
Repositories that ignore `.iw/` must add a narrow exception for
`.iw/claims/state.yaml`; runtime artifacts such as `.iw/index.db` remain ignored.

## 11. CLI Target

Discovery is visibly separated from evaluation without removing the convenient
standard path:

```text
iw claims discover [--ai] [--subject-kind K] [--claim-type T] [--all]
iw claims candidates list [--state S] [--subject-kind K] [--all]
iw claims candidates triage [--ai] [--subject-kind K] [--claim-type T]
iw claims candidates review --candidate ID --actor NAME \
  --decision promote|reject|suppress|defer
iw claims check [--scope S] [--since REV] [--claim-type T] [--refresh]
iw claims list [--status S] [--subject-kind K] [--history]
iw claims explain [--claim ID] [--scope S] [--history]
iw claims review (--claim ID | --all) --actor NAME --decision VALUE
iw claims baseline accept --actor NAME [--claim-type T]
```

Behavior:

- `claims discover` runs deterministic adapters by default; `--ai` also runs
  enabled semantic Discovery and Correlation adapters.
- model-backed adapters run only for changed input and contract fingerprints and
  reuse persisted inferences otherwise.
- without `--ai`, the CLI states that semantic Discovery was not run. Reduced
  recall is never presented as repository conformance.
- `claims check` continues to run deterministic Discovery before evaluation with
  `--refresh` or by default, but outside the R1 compatibility path it evaluates
  only promoted Claims.
- `claims candidates triage --ai` creates recommendations, not promotions, by
  default. Automatic promotion requires an explicit project Policy.
- `claims candidates review` decides whether to add a Candidate to the governed
  Claim inventory; `claims review` evaluates a ClaimAssessment instead.
- `claims list` is an inventory and lifecycle view, not a replacement for
  Explain.
- `claims baseline accept` makes first adoption deliberate and auditable.
- `review --all` requires an explicit filter or confirmation and must not silently
  accept unknown or inconclusive Claims.
- `intent check` orchestrates the same Claims Runtime together with existing
  structural, behavioral, and documentary Intent Rules. It does not calculate a
  parallel set of Claim results.
- CI evaluation of promoted Claims never requires `--ai`. If a promoted Claim
  requires a missing or stale effective semantic artifact, the result is
  `inconclusive`, never implicitly `passed`.

## 12. Continuity and `--since`

The existing merge-base approach remains:

```text
merge-base(reference, HEAD)
-> observations at reference
-> observations at HEAD
-> subject-specific continuity
-> materiality comparison
-> reverse impact
```

Each Subject kind defines its own continuity Rules. A generic rename score is
not sufficient.

Contract and Policy drift continues to be checked against Assessments anchored
at the reference point. The result must not depend on the order of previous
check invocations.

Inference contract changes create new Candidate inference versions. They do not
silently replace the effective inference anchored at the reference point. A new
semantic proposal enters Candidate Triage first; only an effective normalized
binding that materially changes a promoted Claim can trigger its Assessment
Review lifecycle.

## 13. Assessment Review Lifecycle

The existing carry-forward, reopen, and resolution states remain. The extension
adds:

- explicit Subject retirement provenance,
- Explain for current and historical or retired Claims,
- baseline acceptance for controlled first adoption,
- filtering by Claim family and Subject kind,
- fixed Decision values with documented semantics.

A Review may be carried forward automatically only when:

- the normalized Claim is semantically equivalent,
- the Assessment Policy is unchanged,
- every changed Dependency is non-material,
- Subject continuity is `certain`,
- no effective semantic binding changed materially.

## 14. Architecture and Modules

Proposed additions:

```text
packages/core/src/interfaces.ts
  # versioned LLMProvider v2 transport extension

packages/core/src/inference/
  structuredInference.ts # normalized wrapper over LLMProvider v2
  schemaValidation.ts    # mandatory provider-independent output validation

packages/index/src/claims/
  subjects.ts             # Subject identities, aliases, roles
  candidates.ts           # Candidate lifecycle and surfacing
  inferences.ts           # versioned semantic inference artifacts
  candidateReviews.ts     # triage, promotion, and policy decisions
  registry.ts             # Claim family and adapter registration
  impact.ts               # reverse dependency queries
  explain.ts              # current and historical explanation model
  portableState.ts        # provider-neutral portable-state contract and validation

packages/index/src/schema.ts
  # stepwise forward migrations plus durable pre-migration snapshot restore

packages/cli/src/claims/
  portableState.ts        # YAML loading and atomic canonical writes
  discovery/
    codeValues.ts         # existing deterministic R1 discovery
    publicSymbols.ts      # deterministic symbol discovery
    endpoints.ts          # framework adapters
    architecture.ts       # CARI imports/rules adapter
    semantic.ts           # provider-neutral semantic induction
  correlation/
    explicit.ts
    structural.ts
    continuity.ts
    semantic.ts           # grounded semantic Subject proposals

packages/plugin-llm/src/
  openai.ts               # preserve refusal, finish, model, request, and usage metadata
  native/                 # optional native provider adapters when required
```

The existing `ClaimsEngine` does not become a large switch over all Claim types.
It orchestrates registered Claim families and induction adapters through uniform
input and output contracts.

## 15. Delivery Plan

### Phase G0: Freeze the Existing Slice

Goal: establish a robust baseline before generalization.

- merge the current Claims slice and record the schema version,
- document public types and exit codes,
- mark the existing C0-C10 and P-001 regressions as the compatibility suite,
- record golden vectors for existing Parameter, Evidence, Claim, and material
  fingerprints plus their current exit behavior,
- record performance and database-size baselines,
- implement `.iw/claims/state.yaml` v1 with strict import, deterministic atomic
  export, and byte-identical round-trip tests,
- measure the current first run on at least three external repositories,
- publish a public design article that clearly distinguishes current and target
  behavior and collect feedback from five to ten design partners.

Acceptance:

- existing Parameter Claims remain usable without changes,
- existing Parameter and Claim IDs and material fingerprints match the pinned
  v1 golden vectors byte for byte,
- repeated checks and index rebuilds are idempotent,
- a reviewed Claim can be reconstructed from `.iw/claims/state.yaml` in a fresh
  index without changing the file, while a changed Assessment basis is reported
  as `stale_assessment` and produces `inconclusive` rather than acceptance,
- old databases migrate without losing history,
- the first run records the number, type, and surfacing reasons of automatically
  materialized Claims; findings are manually classified as `would-promote`,
  `would-reject`, `would-suppress`, or `would-defer`,
- the standard output remains manageable as a bounded Candidate inbox,
- Discovery contract changes do not create unjustified reopens,
- the published article labels Parameter Claims as implemented and generalized
  Subjects, semantic induction, and Candidates as the target state.

The design article uses this testable thesis:

> **Discover broadly. Govern narrowly. Verify deterministically.**

It is not a release announcement. Endpoint, Symbol, and Architecture examples
are labeled as target behavior and paired with an invitation to validate the
model on real repositories.

### Phase G1: Subject Foundation

- G1a adds Subject identities, aliases, and role-based relationships, backfills
  existing Parameter identities, introduces dual read and write, and creates the
  unique Subject link through backfill validation plus a separate index,
- G1b makes role-based Subjects authoritative for generic Claims and relaxes the
  legacy mandatory Parameter foreign key without creating synthetic Parameters,
- create and atomically restore durable pre-migration snapshots for failed G1a
  and G1b upgrades; do not add general down-migration tooling,
- define Subject continuity and materiality contracts,
- extend Reverse Impact queries to Subjects.

Acceptance:

- every existing Parameter Claim has exactly one compatible Subject,
- IDs, fingerprints, Reviews, and Assessments remain stable across both schema
  migrations,
- schema `16 -> 17 -> 18` forward migration preserves history and can be replayed
  one step at a time,
- failed G1a and G1b migrations atomically restore the corresponding
  pre-migration snapshot; downgrade after G1b-only writes is rejected,
- after G1b, Claims with two Subject roles can be persisted and explained
  without a `ParameterIdentity`.

### Phase G2: Candidate and Semantic Discovery

- implement Candidate persistence and states,
- separate Discovery, Correlation, Triage, and Promotion,
- persist annotation-only findings and ambiguity,
- add the Surfacing Policy and `claims discover` CLI,
- implement versioned `CandidateInference` artifacts and input/output
  fingerprint caching,
- versionably extend the existing `@intentweave/core` `LLMProvider` as the sole
  low-level model transport contract and provide a migration adapter for legacy
  text-generation callers,
- update the OpenAI adapter to preserve refusal, content filtering, unknown
  finish reasons, effective-model, request, and detailed usage metadata,
- add `StructuredInferenceService` with mandatory local schema validation,
  typed failure modes, provenance, cancellation, and effective-model
  capabilities,
- define provider-neutral deterministic and model-backed induction adapters,
- add one grounded semantic Discovery and Correlation adapter behind explicit
  opt-in,
- add Candidate Reviews, manual promotion, and persisted rejection,
- add versioned Candidate Policies and materialized Policy decisions,
- migrate existing R1 Discovery as the first deterministic adapter and backfill
  existing Parameter Claims as promoted through the versioned
  one-time `r1-compatibility` Policy,
- represent explicit Parameter bindings as effective promotions through the
  versioned `explicit-binding` Policy,
- add the optional versioned `r1-continuous-auto-promote` Policy for projects
  that explicitly retain automatic promotion of future R1 findings,
- introduce the explicit Candidate-only exit behavior without changing the
  established exits of active compatibility Claims.

Acceptance:

- schema `18 -> 19` migration preserves existing Subject and Parameter history
  and installs Candidate storage transactionally,
- ambiguous findings do not disappear silently,
- unchanged deterministic scans and semantic inputs are idempotent,
- the same semantic input and contract do not repeat a model call,
- a provider that ignores or only partially implements Structured Outputs cannot
  bypass local schema validation,
- legacy providers that cannot preserve typed terminal outcomes cannot
  advertise Claims Structured Inference support,
- refusal, content filtering, truncation, timeout, and invalid output remain
  distinguishable and never map to a successful inference,
- model, prompt, or contract changes append a new inference version instead of
  rewriting history,
- a Candidate can be explicitly correlated, promoted, rejected, suppressed, or
  deferred,
- only promoted Candidates reach Assessment, Assessment Review, reopen, and CI,
- the one-time compatibility backfill never promotes a new post-migration R1
  finding, while an enabled `r1-continuous-auto-promote` Policy does so with
  persisted Policy provenance,
- Candidate-only Discovery returns success for `claims discover`, direct
  `claims check` reports `no_active_claims`, and `iw intent check` does not gain
  a Claims failure solely because unpromoted Candidates exist,
- a rejected unchanged Candidate does not reappear as new work on every scan,
- semantic recommendations are reproducibly explained and are not authoritative
  without opt-in,
- promoted Claims can be checked from frozen effective artifacts without model
  access.

### Phase G3: Symbol Contract Slice

- public Symbol Subjects and continuity,
- positive documentation Evidence,
- `CLM-PUBLIC-SYMBOL-DOCUMENTED`,
- materiality and reopen Rules,
- fixture with rename, signature change, missing documentation, and ambiguous
  documentation.

Acceptance:

- the first non-Parameter Claim passes through Discovery, optional semantic
  induction, Assessment, Review, `--since`, reopen, and Explain end to end.

### Phase G4: Endpoint Slice

- select exactly one framework adapter first,
- correlate Route, handler, and Guard Subjects,
- model positive authentication Evidence and applicability,
- test delete, rename, and Guard-change scenarios.

Acceptance:

- missing Guard Evidence is `inconclusive` or `failed` according to the contract,
  never implicitly `passed`,
- relevant Guard changes reproducibly reopen affected Reviews.

### Phase G5: Architecture Claim Slice

- connect CARI imports and Architecture Rules as Evidence Adapters,
- use relational Source and Target Subjects,
- normalize positive conformance and violations,
- bridge existing `intent` and `rulesCheck` results.

Acceptance:

- no parallel Architecture Rule inventory is created,
- existing Rules produce Claims-compatible results through adapters,
- "no violation found" becomes `passed` only with complete applicability and
  sufficient Evidence.

## 16. Test Strategy

Each Claim family receives a temporary Git fixture with fixed commits.

### Symbol Contract

```text
S0  exported Symbol plus valid documentation
S1  rename or move only, carry-forward
S2  signature change without documentation update, reopen
S3  documentation and signature changed together, new supported Assessment
S4  documentation deleted, not silently successful
S5  two ambiguous Candidates, no automatic correlation
```

### Endpoint Protection

```text
E0  Route plus Guard, supported
E1  handler rename, carry-forward
E2  Guard removed, failed/refuted and reopen
E3  unknown framework path, inconclusive
E4  public Route explicitly exempted, not_applicable
E5  documentation and implementation contracts contradict each other
```

Every semantic adapter additionally verifies:

- the v2 transport contract preserves refusal, content-filter, unknown finish,
  effective-model, request, and detailed usage metadata from provider fixtures,
- legacy v1 text callers continue through the compatibility adapter while a v1
  provider cannot falsely advertise Claims Structured Inference support,
- the same input and contract reuse the persisted inference without a provider
  call,
- provider output is validated locally even when native strict mode was
  requested,
- a compatibility endpoint that ignores the requested schema produces a typed
  invalid-output result rather than a Candidate,
- refusal, content filtering, truncation, timeout, and transport errors are not
  normalized to `stop`,
- changed source input appends a new inference version,
- changed model, prompt, or adapter contract never overwrites history,
- ungrounded model output remains `ambiguous`,
- replay from frozen effective artifacts produces the same normalized Candidate
  and Subject bindings without provider access,
- a model recommendation never promotes a Candidate by itself.

Every slice additionally verifies:

- schema migrations advance one version at a time and preserve history at each
  G1/G2 boundary,
- a failed G1a or G1b migration atomically restores its durable pre-migration
  snapshot, and unsupported post-write downgrade is rejected,
- existing Parameter identities, Claim identities, and material fingerprints
  match the G0 golden vectors after migration,
- a new post-migration R1 finding remains a Candidate under
  `r1-compatibility` alone and is promoted only when
  `r1-continuous-auto-promote` is explicitly effective,
- an explicit post-migration Parameter binding promotes through
  `explicit-binding` without enabling continuous auto-promotion for unrelated
  R1 findings,
- Candidate-only `iw intent check` reports the Claims gate as `not_evaluated`
  without creating an Assessment or changing the aggregate exit code,
- `defer` leaves a Candidate `triaged`, while `superseded` is produced only by a
  provenance-bearing system transition,
- two checks on the same commit create no new domain version,
- A -> B -> A remains append-only,
- `check` and `check --since` are independent of invocation order,
- index rebuild preserves history,
- missing Evidence is never interpreted as success,
- Explain names Subjects, Evidence, RuleResult, Policy, effective inference,
  Review, and reopen reason.

## 17. Definition of Done

Generalization is robust when:

1. existing Parameter Claims migrate without ID or history breaks,
2. Claims can reference one or more typed Subjects with roles,
3. Discovery Candidates persist independently of materialized Claims,
4. deterministic and model-backed induction use versioned, provider-neutral
   contracts,
5. every semantic proposal is grounded in Evidence and persisted with model,
   prompt, input, output, and contract fingerprints,
6. Candidate Review and Assessment Review are persisted and explained
   separately,
7. only Candidates promoted by a human or approved Policy enter the active check
   lifecycle,
8. at least one non-Parameter Claim family completes the end-to-end path,
9. ambiguity and missing Evidence produce explicit results,
10. materiality and continuity are versioned per Subject and Claim family,
11. Reverse Impact is derivable exclusively from persisted Dependencies,
12. Review, carry-forward, reopen, retirement, and baseline acceptance are
    auditable,
13. CLI text and JSON preserve the same domain reasons without loss,
14. TypeScript and native schema creation implement the same schema contract,
15. the existing C0-C10 and P-001 slice remains fully green,
16. at least Symbol or Endpoint Claims run against a real repository,
17. effective Candidate and Assessment Reviews reproduce between two fresh
    checkouts without identity or history loss,
18. `iw claims check` and the Claims portion of `iw intent check` produce the
    same Assessments, Findings, and exit semantics,
19. a first run on at least three external repositories does not activate an
    uncurated Claim flood directly in CI,
20. promoted Claims can be evaluated in CI without model credentials or network
    access,
21. disabling semantic induction reports reduced Discovery coverage and never
    converts missing semantic Evidence into `passed`,
22. the existing `@intentweave/core` `LLMProvider` remains the only public
    low-level model transport contract and its v2 adapters preserve typed
    terminal outcomes before Structured Inference,
23. all model-backed Candidate outputs pass provider-independent local schema
    validation before persistence or promotion,
24. existing Parameter and Claim identities and material fingerprints remain
    byte-for-byte compatible with the pinned v1 golden vectors,
25. Candidate decisions and system supersession follow the specified state
    transitions with persisted provenance,
26. Candidate-only Discovery does not activate a CI gate, while direct
    `claims check` without active Claims reports `no_active_claims` rather than
    success,
27. each G1 migration failure restores its pre-migration database snapshot
    atomically, while unsupported downgrade after new-version-only writes is
    rejected,
28. `r1-compatibility` is a one-time backfill and continued automatic R1
    promotion occurs only through an explicit, versioned
    `r1-continuous-auto-promote` Policy; explicit bindings use their separate
    `explicit-binding` Policy,
29. `.iw/claims/state.yaml` reproduces effective Policies, Candidate decisions,
    Subject bindings, Assessment Reviews, and baseline acceptances between fresh
    checkouts without SQLite-local IDs or non-deterministic serialization.

## 18. Explicit Non-Goals

The first extension does not include:

- automatic truth assessment of arbitrary natural language,
- complete general Claim recall in deterministic-only mode,
- mandatory model calls during check or CI,
- a second Claims-specific LLM transport API alongside `LLMProvider`,
- a new graph backend or a second Claims database,
- executable project-side Rule code without a sandbox and trust model,
- fully automatic LLM correlation without verifiable provenance,
- autonomous AI promotion by default without an explicit project Policy,
- organization-wide permissions and SaaS Review workflows,
- every framework and programming language in the first release.

## 19. Open Decisions Before G1

Only a small number of architecture decisions must be fixed before
implementation:

1. Which Symbol contract defines G3: documentation presence only, or signature
   and error-case conformance?
2. Which concrete web framework adapter is the first Endpoint slice?
3. Which Assessment Review Decision values are fixed and how do they affect CI?
4. Which Candidate Policies may promote automatically and which may only
   recommend?

Recommendation:

- G1 starts with only `parameter`, `symbol`, `module`, and `endpoint` as reserved
  kinds.
- G1a dual-writes for one release; G1b makes role-based Subjects authoritative
  for generic Claims while retaining the nullable legacy Parameter link.
- G1 uses durable pre-migration snapshots for failure recovery instead of down
  migrations; downgrade after G1b-only writes is unsupported.
- G3 starts with a small, positive Symbol documentation contract.
- G4 supports exactly one framework present in the target repository.
- Reviews initially use `accepted` and `rejected`; additional values require
  defined semantics.
- Candidate Triage starts manually. AI provides opt-in Discovery, Correlation,
  and Triage recommendations. Automatic promotion is enabled only per versioned
  project Policy.
- `r1-compatibility` backfills only Claims active at migration time. Explicit
  Parameter bindings promote through `explicit-binding`. Continued automatic R1
  promotion is a separate, explicit `r1-continuous-auto-promote` Policy.
- Model-backed adapters are provider-neutral and can assign at most `probable`
  confidence without a stable deterministic anchor.
- The existing `LLMProvider` remains the sole transport SPI and receives a
  versioned v2 extension for typed terminal outcomes and provenance.
  `StructuredInferenceService` adds Claims-grade validation above v2 without
  becoming another plugin capability.
- OpenAI compatibility is a baseline adapter, not the public IntentWeave
  contract. Native provider APIs may be used where the compatibility surface
  cannot guarantee strict Structured Outputs.
- Third-party provider frameworks may be implementation details of `plugin-llm`;
  their types do not cross into `@intentweave/core` or Claims contracts.
- SQLite remains the Runtime projection. Effective team decisions and normalized
  semantic bindings use the strict `.iw/claims/state.yaml` v1 contract; Git is
  the portable history and provider payloads remain local.
- Promoted Claim evaluation never depends on model availability.

## 20. Core Statement

The current vertical slice proves that IntentWeave can support versioned,
evidence-grounded Claims technically. The next step is not to add more and more
Parameter Rules, but to separate:

```text
Deterministic evidence
Semantic induction
Subject identity
Candidate discovery
Evidence correlation
Candidate triage and promotion
Claim family
Rule contract
Assessment policy
```

With this separation, `session.timeout` becomes the first compatible Claim
family, not the permanent boundary of the model. CARI remains the deterministic
source of observed facts; semantic induction expands what IntentWeave can
recognize; governance determines what matters; and the Intent Runtime verifies
accepted Claims reproducibly.
