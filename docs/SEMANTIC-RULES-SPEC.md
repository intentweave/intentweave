# Semantic Rule Checking — Specification

> **Version:** 0.2  
> **Status:** Partially Implemented (Stage 1 complete; Stages 2–3 in backlog)  
> **Scope:** Extending CARI from import-graph checks to symbol-usage-pattern checks,
> enabling CI enforcement of ADR-level architectural constraints.
>
> **Changelog v0.2:** Added `expresses` block format (§4.4) for visualization-intent
> rules; added `target_layer` scope modifier (§4.3); documented `forbidden: []` pattern
> for pure-visualization rules; updated implementation stage status.

---

## 1. Motivation — The Gap Between Import Checks and Semantic Checks

IntentWeave currently enforces two classes of structural rule:

| Check                 | What it catches                                               | Mechanism                              |
| --------------------- | ------------------------------------------------------------- | -------------------------------------- |
| `layers-check`        | File A (lower layer) imports File B (higher layer)            | Import graph edges                     |
| `boundary-violations` | File A imports File B's _internals_ across package boundaries | Import graph + package.json paths      |
| `arch-check`          | Component A has an undocumented import flow to Component B    | Import graph vs. declared architecture |

All three work on the **import graph** — they answer the question _"which module imports which?"_.

### 1.1 What they cannot detect

Consider this example violation:

```typescript
// apps/ui/src/components/views/ItemView.tsx, L42
function parseCategory(resourcePath: string): string {
  const match = resourcePath.match(/Catalog_([^_/]+)/);
  return match ? match[1] : "Unknown";
}

// Usage:
const category = parseCategory(item.resource.path); // ← THE VIOLATION
```

The import graph is **clean**: `ItemView.tsx` imports `item` from the correct API layer. Nothing
is imported that shouldn't be. The violation is _behavioral_: the view component accesses a
raw internal field (`resource.path`) and applies domain parsing logic that belongs in the
resolver/transformer layer. An ADR constraint explicitly forbids this class of coupling.

A second example:

```typescript
// DetailView.tsx, L51
const normalizeRef = (ref: string) =>
  ref.replace(/^#\//, "").replace(/\//g, ".");
const entityById = useMemo(
  () => new Map(allEntities.map((e) => [e.id, e])),
  [allEntities],
);
```

`normalizeRef` is a re-implementation of logic that already exists in the server-side resolver.
The import is legal. The problem is that this parsing and map-building logic exists in the UI
at all. No import-graph tool can see this.

### 1.2 The fundamental class difference

```
Import-graph violations (current):
  File A  ──imports──►  File B     ← edge in the import graph
                        (wrong direction / wrong boundary)

Semantic usage violations (new):
  File A  ──accesses──► item.resource.path    ← property access chain
  File A  ──calls─────► normalizeRef()        ← function invocation
  File A  ──defines───► itemsById Map         ← forbidden symbol pattern
  File A  ──contains──► /Catalog_/            ← regex literal on domain data
```

These are **AST-level facts about what code does inside a file**, not graph-level facts about
which files depend on which. Detecting them requires extending CARI's data model from
import edges to **symbol-call edges** and **property-access chains**.

---

## 2. Proposed Extension: Semantic Rule Checking

### 2.1 Overview

A two-part extension to CARI:

1. **AX Extractor additions** — capture call expressions and property access chains during
   AST traversal. Store in two new SQLite tables: `symbol_calls` and `property_accesses`.

2. **New query: `rulesCheck`** — validate the index against a team-committed
   `.iw/rules.yaml` config. Report violations per rule, per file, with line numbers.

Optional Layer 2 addition:

3. **`rules-extract` command** — LLM reads one or more ADR documents and produces a
   structured `.iw/rules.yaml` from the constraints described in prose. Once extracted,
   all ongoing CI checks run at $0 against the SQLite index.

### 2.2 Why this fits CARI's model

CARI's principle is: extract facts once (AX phase), store in SQLite, run any number of
queries at $0 with no re-extraction. Semantic rules follow the same pattern:

```
Code files ──► AST extraction (AX) ──► symbol_calls + property_accesses tables
                                                │
                               ┌────────────────┘
                               ▼
                    .iw/rules.yaml ──► rulesCheck query ──► CI violations
```

The extraction cost is paid once at index build time. The rule check is pure SQL.

---

## 3. Data Model — New SQLite Tables

### 3.1 `symbol_calls`

Tracks every function/method call made within a symbol's body.

```sql
CREATE TABLE symbol_calls (
  id            INTEGER PRIMARY KEY,
  caller_file   TEXT NOT NULL,    -- file containing the caller
  caller_name   TEXT,             -- name of the enclosing function/class, NULL for module-level
  caller_line   INTEGER,          -- line of the call expression
  callee_name   TEXT NOT NULL,    -- name of the called function (unqualified)
  callee_id     TEXT,             -- fully-qualified callee if resolvable (e.g. "resolver.normalizeRef")
  is_method     INTEGER DEFAULT 0 -- 1 if callee_name is a method call (obj.method())
);
```

**Example data:**

| caller_file    | caller_name   | caller_line | callee_name    | is_method |
| -------------- | ------------- | ----------- | -------------- | --------- |
| ItemView.tsx   | parseCategory | 43          | match          | 1         |
| DetailView.tsx | DetailView    | 51          | normalizeRef   | 0         |
| DetailView.tsx | DetailView    | 55          | buildEntityMap | 0         |

### 3.2 `property_accesses`

Tracks property access chains used within symbol bodies.

```sql
CREATE TABLE property_accesses (
  id          INTEGER PRIMARY KEY,
  file        TEXT NOT NULL,    -- file containing the access
  symbol_name TEXT,             -- enclosing function/class name
  line        INTEGER,
  chain       TEXT NOT NULL,    -- e.g. "user.profile.name", "order.status.code"
  root        TEXT NOT NULL,    -- first identifier: "user"
  depth       INTEGER           -- number of property segments: "user.profile.name" → 3
);
```

**Example data:**

| file           | symbol_name   | line | chain               | root  |
| -------------- | ------------- | ---- | ------------------- | ----- |
| ItemView.tsx   | parseCategory | 43   | item.resource.path  | item  |
| ItemView.tsx   | renderDetails | 92   | item.raw.metadata   | item  |
| DetailView.tsx | useParamRows  | 95   | param.internal.type | param |

### 3.3 Index build

Both tables are populated by the AX (AST extractor) stage during `iw index build`.
They are incremental: only recomputed for files whose `body_hash` has changed.

tree-sitter provides the AST node types needed:

- `call_expression` → callee name (`callee_name`)
- `member_expression` → property chain (`property_accesses.chain`)
- `assignment_expression` / `variable_declarator` → defined symbol names

---

## 4. Rule Definition Format — `.iw/rules.yaml`

### 4.1 File structure

```yaml
# .iw/rules.yaml
version: 1

rules:
  - id: no-internal-field-access-in-ui
    description: "UI view components must not access internal resource fields directly"
    adr: ADR-001
    severity: high # high | medium | low
    forbidden:
      - type: property_access
        chain: "**.resource.path" # glob-style property chain matcher
        in: "apps/ui/**" # file scope (glob)

  - id: no-domain-helpers-in-ui
    description: "UI components must not implement domain-parsing helpers — belongs in the service layer"
    adr: ADR-001
    severity: medium
    forbidden:
      - type: call
        callee: "normalizeRef|buildPath|parseId|lastSegment" # regex or | list
        in: "apps/ui/src/components/**"
      - type: property_access
        chain: "**.internal.type"
        in: "apps/ui/src/components/**"
        except: "apps/ui/src/components/resolver/**" # allowed in resolver only

  - id: no-lookup-maps-in-views
    description: "Lookup maps must not be built in view components"
    adr: ADR-001
    severity: medium
    forbidden:
      - type: symbol_name
        pattern: "entityById" # variable/constant name pattern
        in: "apps/ui/src/components/views/**"

  - id: no-regex-on-internal-fields
    description: "Regex parsing of internal field values belongs in adapters"
    adr: ADR-001
    severity: high
    forbidden:
      - type: call
        callee: "match|exec" # regex methods
        in: "apps/ui/**"
        context_access: "**.resource.path" # only flag when used on .resource.path access

  # Visualization-intent rule — no CI enforcement, pure SVG architecture diagram input
  - id: intended-data-flow
    description: "Intended pipeline flow (visualization-only)"
    adr: ADR-001
    severity: low
    expresses:
      elements:
        - name: SourceProvider
          kind: component
          layer: "packages/providers"
        - name: AdapterParser
          kind: component
          layer: "packages/adapters"
        - name: PipelineWorker
          kind: component
          layer: "packages/workers"
      flows:
        - from: SourceProvider
          to: AdapterParser
          policy: allowed
          kind: data
        - from: AdapterParser
          to: PipelineWorker
          policy: allowed
          kind: control
    forbidden: []
```

### 4.2 Rule types

| Type              | Detects                                                          | Table queried        |
| ----------------- | ---------------------------------------------------------------- | -------------------- |
| `property_access` | Access to a property chain matching a pattern                    | `property_accesses`  |
| `call`            | Invocation of a function matching a name pattern                 | `symbol_calls`       |
| `symbol_name`     | Declaration of a symbol with a name matching a pattern           | `symbols` (existing) |
| `import_pattern`  | Import of a path matching a pattern (existing, via import graph) | `imports` (existing) |

**Visualization-intent rules** (no enforcement, no table query — pure SVG rendering):

| Key         | Purpose                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expresses` | Declare named components, their layers, and intended data/control flows between them. Used by `iw index export --prescriptive` to render the architecture SVG. Requires `forbidden: []`. |

### 4.3 Scope modifiers

| Key              | Meaning                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `in`             | Restrict violation detection to files matching this glob                                                                                                                           |
| `except`         | Whitelist paths that are allowed despite the rule                                                                                                                                  |
| `except_pattern` | Whitelist files whose _enclosing symbol name_ matches this regex                                                                                                                   |
| `context_access` | Only flag when co-located with an access chain matching this pattern                                                                                                               |
| `target_layer`   | For `import_pattern`: only flag if the imported file resolves to this layer name (avoids false positives when two packages share a similar path pattern but only one is forbidden) |

---

### 4.4 The `expresses` block — Visualization-Intent Rules

A rule may carry an `expresses` block **instead of** (or alongside an empty `forbidden: []`) a
`forbidden` list. Rules with only `expresses` are _visualization-only_: they have `severity: low`
and never produce CI violations. Their sole purpose is to encode **intended architecture** so that
`iw index export --prescriptive --show-rule-elements` can render named components and their
data/control flows as a prescriptive SVG architecture diagram.

```yaml
- id: intended-data-flow
  description: >
    Intended pipeline: Providers → Adapters/Parsers → Worker pipeline.
    Visualization-only — encodes expected data/control flow for the
    current engine implementation.
  adr: ADR-001
  severity: low
  expresses:
    elements:
      - name: SourceProvider
        kind: component # component | interface | service | store
        layer: "packages/providers"
      - name: AdapterParser
        kind: component
        layer: "packages/adapters"
      - name: PipelineWorker
        kind: component
        layer: "packages/workers"
    flows:
      - from: SourceProvider
        to: AdapterParser
        policy: allowed # allowed | forbidden
        kind: data # data | control
      - from: AdapterParser
        to: PipelineWorker
        policy: allowed
        kind: control
  forbidden: [] # explicit empty list — no CI enforcement
```

#### `expresses.elements` fields

| Field   | Type   | Required | Description                                                      |
| ------- | ------ | -------- | ---------------------------------------------------------------- |
| `name`  | string | yes      | Display name for the component chip in the SVG                   |
| `kind`  | string | yes      | Visual style class: `component`, `interface`, `service`, `store` |
| `layer` | string | yes      | Layer name from `.iw/layers.yaml` that this component belongs to |

#### `expresses.flows` fields

| Field    | Type   | Required | Description                                                     |
| -------- | ------ | -------- | --------------------------------------------------------------- |
| `from`   | string | yes      | Source element `name`                                           |
| `to`     | string | yes      | Target element `name`                                           |
| `policy` | string | yes      | `allowed` (green solid arrow) or `forbidden` (red dashed arrow) |
| `kind`   | string | no       | `data` or `control` — shown in the edge hover panel             |

#### Relationship to `forbidden` enforcement

A rule may contain **both** `expresses` and `forbidden` entries:

```yaml
expresses:
  elements: [...]   # defines visual components
  flows: [...]      # defines intended flows for SVG
forbidden:
  - type: import_pattern
    ...             # the same rule also enforces a real constraint at CI
```

In this combined form the `expresses` block supplies the visualization intent while the
`forbidden` clauses provide the enforcement signal. This pattern is recommended for rules
that have _both_ a diagrammatic expression and a detectable code-level violation.

---

### 4.5 Mermaid Inline Behavioral Rules

*Design status: planned — not yet implemented. Supersedes hand-rolled `expresses.flows` for the behavioral domain.*

The behavioral domain supports Mermaid diagrams as a **first-class rule format**. Instead
of manually authoring `must_call` / `must_not_call` YAML checks, or hand-rolling the
`expresses.flows` block, teams embed Mermaid diagrams directly in `rules.yaml` under a
`mermaid:` key. The Intent Runtime parses the Mermaid AST at check time — no extraction
step, no intermediate representation.

**Three advantages:**

1. The diagram IS the rule — what renders in GitHub is exactly what runs in CI
2. The Insights Book renders the Mermaid diagram directly alongside its violations — the
   behavioral spec is self-documenting in the output
3. Mermaid diagrams already exist in ADR files — the authoring workflow is copy-paste

#### Sequence diagram — call edge enforcement

```yaml
- id: bdd-auth-sequence
  domain: behavioral
  description: "Login must route through AuthService; UI must not call TokenStore directly"
  severity: high
  mode: warn        # promote to error when calls table ships
  source:
    type: mermaid_inline
  mermaid: |
    sequenceDiagram
      UI->>AuthService: login(credentials)
      AuthService->>TokenStore: issue(token)
      AuthService-->>UI: token
```

Auto-derived checks from this diagram:
- `must_call { from: UI, to: AuthService }` — edge exists in diagram
- `must_call { from: AuthService, to: TokenStore }` — edge exists in diagram
- `must_not_call { from: UI, to: TokenStore }` — implied: UI→TokenStore bypasses AuthService

#### State diagram — valid transition enforcement

```yaml
- id: adr002-order-state-machine
  domain: behavioral
  description: "Order lifecycle must follow the defined state machine"
  severity: high
  mode: warn
  source:
    type: mermaid_inline
  mermaid: |
    stateDiagram-v2
      [*] --> Pending
      Pending --> Processing : submit
      Processing --> Fulfilled : complete
      Processing --> Cancelled : cancel
      Fulfilled --> [*]
      Cancelled --> [*]
```

Auto-derived checks: only the listed transitions are valid. Any code path that moves
`OrderState` from `Pending` directly to `Fulfilled` (skipping `Processing`) is a violation.

#### Flowchart — must-precede / must-not-bypass enforcement

```yaml
- id: adr001-auth-gate
  domain: behavioral
  description: "Every request path must traverse AuthCheck before reaching Process"
  severity: high
  mode: warn
  source:
    type: mermaid_inline
  mermaid: |
    flowchart TD
      Request --> AuthCheck
      AuthCheck -->|authenticated| Process
      AuthCheck -->|rejected| Error
```

Auto-derived check: any call path from `Request`-handling code to `Process`-handling code
that does not traverse `AuthCheck` is a violation.

#### Referencing an existing diagram in an ADR file

Instead of inlining, point to a named Mermaid block in a markdown file:

```yaml
- id: bdd-auth-sequence
  domain: behavioral
  severity: high
  source:
    type: mermaid_file
    file: docs/ADR-001-auth.md
    block_id: auth-login-flow   # optional: named block, else first mermaid block
  # no mermaid: key needed — loaded from file at check time
```

When the ADR is updated, `iw intent check` picks up the change automatically — the rule
and the diagram are the same artifact.

#### Confidence and mode

Mermaid behavioral rules inherit the confidence tier of the underlying check type:

| Diagram type | Check type | Confidence (now) | Confidence (+calls table) |
|---|---|---|---|
| `sequenceDiagram` | `must_call` / `must_not_call` | ~0.70–0.85 | ~0.90+ |
| `stateDiagram-v2` | `valid_transition` | ~0.50 | ~0.80 (+CFG, future) |
| `flowchart` | `must_precede` | ~0.30 | ~0.80 (+CFG, future) |

Sequence diagrams are the recommended starting point: they cover the most common ADR
violation patterns and reach CI-grade confidence (~0.90) as soon as the `calls` table
ships. State machine and flowchart checks should remain `mode: warn` until CFG analysis
is available.

#### Relationship to `expresses` block

The `expresses.flows` block (§4.4) is the *current* way to declare intended flows for
SVG visualization. Mermaid inline rules are the *planned replacement* for the behavioral
enforcement use case — not for visualization (the SVG renderer will continue to use
`expresses.elements` for component chips and styling metadata that Mermaid does not carry).

A rule can carry both during the transition:

```yaml
- id: adr001-pipeline-flow
  domain: behavioral
  expresses:                      # still used for SVG component chips
    elements:
      - { name: UI, kind: component, layer: apps/ui }
      - { name: AuthService, kind: service, layer: packages/auth }
  mermaid: |                      # used for behavioral enforcement
    sequenceDiagram
      UI->>AuthService: login(credentials)
  forbidden: []                   # no additional YAML checks needed
```

---

## 5. CLI Interface

### 5.1 `iw index rules-check`

```bash
iw index rules-check
iw index rules-check --config .iw/rules.yaml
iw index rules-check --adr docs/ADR-003.md   # auto-extract + check in one shot (requires LLM)
iw index rules-check -f json                  # JSON output for CI
iw index rules-check --severity high          # only report high-severity violations
```

**Output (text):**

```
⚠ 4 semantic rule violations

  Rule: no-internal-field-access-in-ui (ADR-001) [HIGH]
  ───────────────────────────────────────────────────────
  ItemView.tsx:42     item.resource.path accessed in parseCategory()
                     → Move to ResourceAdapter or CategoryTransformer

  Rule: no-domain-helpers-in-ui (ADR-001) [MEDIUM]
  ──────────────────────────────────────────────────
  DetailView.tsx:51  normalizeRef() called in DetailView component
  DetailView.tsx:55  buildEntityMap() called in DetailView component

  Rule: no-lookup-maps-in-views (ADR-001) [MEDIUM]
  ──────────────────────────────────────────────────
  ItemView.tsx:340    entityById defined in ItemView component
```

**Exit code:** 0 (no violations), 1 (violations found), 2 (config error).

### 5.2 `iw index rules-extract` (Layer 2, requires LLM)

Reads one or more ADR documents and produces a `.iw/rules.yaml` draft:

```bash
iw index rules-extract docs/ADR-003.md --provider openai --output .iw/rules.yaml
iw index rules-extract docs/ADR-*.md --provider openai   # merge multiple ADRs
```

The LLM receives the ADR text and a structured prompt asking it to identify:

- Which code layers should NOT perform which types of operations
- Which function names, property access patterns, or symbol names violate the rule

The output is a draft `.iw/rules.yaml` that the team reviews and commits. After that,
all CI enforcement is $0 — no LLM calls.

### 5.3 `iw index rules-check --changed` (incremental CI)

Same as `iw index check --changed` but for semantic rules:

```bash
iw index rules-check --changed src/components/ItemView.tsx
```

Reports only violations in files that were modified. Used in PR pipelines to give
fast targeted feedback without checking the entire codebase.

---

## 6. MCP Tool

```typescript
// cari_rules_check — new MCP tool
{
  name: "cari_rules_check",
  description: "Check codebase against semantic architectural rules from .iw/rules.yaml",
  parameters: {
    severity: { type: "string", enum: ["high", "medium", "low"], optional: true },
    changed: { type: "array", items: { type: "string" }, optional: true },
    ruleId: { type: "string", optional: true },  // check only one rule
    limit: { type: "number", optional: true }
  }
}
```

Copilot usage: _"Are there any ADR-003 violations in the explorer views?"_
→ `cari_rules_check` with `{ ruleId: "no-internal-field-access-in-ui" }`

---

## 7. Implementation Plan

The feature has three independently shippable stages:

### Stage 1 — Manual rules, import-graph detection only ($0, no AX changes) ✅

**Scope:** Implement `rulesCheck` for `import_pattern` type rules only. These use the existing
`imports` table. No AX changes. Catches a subset of violations where the wrong dependency
_is_ visible in the import graph (e.g., a UI file importing `data-service-worker.ts` directly
instead of via the API route).

Also delivered in Stage 1: the `expresses` block parser and prescriptive SVG export pipeline
(`iw index export --prescriptive --show-rule-elements`). Visualization-intent rules are loaded
at export time; no SQLite query is issued for `forbidden: []` rules.

**Effort:** S (1 day). New query + YAML config loader.  
**Status:** Complete. `import_pattern` rules and `expresses` visualization are live.

### Stage 2 — AST extensions: call tracking and property access _(backlog: 13.1)_ ✅

**Scope:** Extend the AX extractor (tree-sitter TS/JS/TSX) to capture:

- `call_expression` nodes → `symbol_calls` table
- `member_expression` chains deeper than 2 levels → `property_accesses` table

**Effort:** M (2–3 days). Extend `ast-extractor` + new writer code + new query + rule types
`call` and `property_access`.

**Unlocks detection of:**

- `parseCategory(item.resource.path)` → both `call` and `property_access` rules
- `normalizeRef()`, `buildEntityMap()`, `entityById` → `call` rules

**Status:** Complete. Full pipeline is live and validated:

- `symbol_calls` table: 21 k rows (on IntentWeave codebase itself)
- `property_accesses` table: 3.3 k rows
- `imports.line` column: 1.1 k rows with line numbers
- `rulesCheck` handles `call`, `property_access`, `symbol_name`, `import_pattern`,
  `variable_assignment`, and `cypher` rule types (31 unit tests pass)
- `iw index rules-check --format json` redirect is stable (uses `process.stdout.write`)
- `--baseline` / `--save-baseline` / `--fail-on-increase` CI gate is live
- `import_pattern` glob handling treats `**` as crossing `/` (13.6 fix is applied)
- `symbol_name` `scope` modifier (`exported` / `top-level` / `any`) is supported

### Stage 3 — LLM rule extraction from ADRs _(backlog: 13.4)_

**Scope:** `iw index rules-extract` command. Reads ADR markdown, produces `.iw/rules.yaml`
draft. Uses the same LLM provider pipeline as existing KG extraction.

**Effort:** M (2 days). New CLI command + LLM prompt engineering + output formatter.

**Unlocks:** Zero-config onboarding — teams with existing ADR libraries can auto-generate
their rule set without writing YAML by hand.

---

## 8. Rule Coverage by Violation Type

For each class of violation that semantic rules can detect, the following table maps the
violation pattern to the rule type that catches it and the implementation stage required:

| Violation pattern                             | Rule type         | Stage needed |
| --------------------------------------------- | ----------------- | ------------ |
| View accesses internal field (e.g. `x.raw.y`) | `property_access` | Stage 2      |
| View calls domain helper (e.g. `parseId()`)   | `call`            | Stage 2      |
| View accesses `**.$ref` or similar ref field  | `property_access` | Stage 2      |
| View declares lookup map (e.g. `entityById`)  | `symbol_name`     | Stage 2      |
| View applies regex to internal data           | `call` + context  | Stage 2      |
| File imports wrong package internal           | `import_pattern`  | Stage 1      |

---

## 9. CI Gate Example

Once implemented, a PR pipeline would add:

```yaml
# .github/workflows/ci.yml
- name: Architecture rule check
  run: iw index rules-check --severity high --changed ${{ steps.changed-files.outputs.all_changed_files }}
  # Exits non-zero if any high-severity ADR violation is introduced
```

A developer introducing a new access to an internal field in a view component would see:

```
✗ Architecture violation: no-internal-field-access-in-ui (ADR-001, HIGH)
  NewView.tsx:42  item.resource.path accessed in renderConfig()

  This pattern violates ADR-001.
  The category data must come from the service layer as a resolved property,
  not parsed from the raw resource path.

  See: docs/ADR-001.md
```

The violation is caught in the PR — before review, before merge, before regression.

---

## 10. Relationship to Existing Features

| Existing feature               | Relationship                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `layers-check`                 | Orthogonal. Catches wrong import direction. Semantic rules catch wrong usage inside files.                                                                         |
| `boundary-violations`          | Orthogonal. Catches cross-package internal imports. Semantic rules catch data misuse.                                                                              |
| `arch-check`                   | Complementary. `arch-check` validates declared component flows. Rules validate coding patterns within components.                                                  |
| `clones` / `structural-clones` | Partially overlapping. Clones finds duplicated helpers (e.g. the same `normalizeRef` in 4 files). Rules enforces that _none_ of them should exist in the UI layer. |
| `cari_check` (drift)           | Complementary. Drift check catches stale documentation. Rules check catches stale architecture patterns.                                                           |
| KG `rules-extract`             | New Layer 2 addition. LLM populates `.iw/rules.yaml` from ADR text. $0 after initial extraction.                                                                   |

---

## 11. What This Enables Beyond ADR

The same mechanism generalizes to many common ADR patterns:

| ADR type                                              | Rule example                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| "UI must not access database directly"                | `property_access: "\*\*.query                                             | **.execute"`in`apps/web/**`                        |
| "Services must not import from each other"            | `import_pattern: "services/*"` forbidden in `services/*/` except own      |
| "All API responses must go through validator"         | `call: "res.json                                                          | res.send"`without prior`validate()`in`routes/\*\*` |
| "No raw SQL strings in business logic"                | `symbol_name: /"SELECT.*FROM"/` (string literal pattern) in `services/**` |
| "Logging must use the structured logger, not console" | `call: "console.log                                                       | console.error"`in`src/\*\*`                        |
| "Config must be injected, not read directly"          | `call: "process.env.*"` in `src/services/**`                              |

The rule format is intentionally general — it captures the class of violation that architects
care about most but that static import-graph tools cannot see.
