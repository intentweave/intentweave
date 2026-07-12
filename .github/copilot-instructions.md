# IntentWeave — Copilot Instructions

## Project Overview

IntentWeave is a **semantic knowledge extraction platform** that provides two complementary systems:

1. **CARI (Code-Aware Retrieval Index)** — Lightweight SQLite index built from AST, keywords, and
   git history. No LLM, no Neo4j, $0 cost. Powers ranked retrieval, connection discovery, and
   CI drift detection.

2. **Knowledge Graph (KG)** — LLM-powered entity/relationship extraction from documents. Persists
   to Neo4j for semantic queries, impact analysis, and documentation health checks.

### Monorepo Structure

```
intentweave/
├── packages/
│   ├── analyzer/         # Pipeline stages (AX, KWX, COX, TCG)
│   ├── ast-extractor/    # AST-based code entity extraction (tree-sitter)
│   ├── cli/              # `iw` CLI commands + MCP server
│   ├── core/             # Shared types, plugin registry, capability interfaces
│   ├── index/            # CARI — SQLite index (annotator, IDF, queries, incremental)
│   ├── cypher-lite/      # Zero-dep Cypher→SQL transpiler for SQLite KG
│   ├── plugin-llm/       # LLM provider plugin (OpenAI)
│   ├── plugin-python/    # Python language plugin (tree-sitter)
│   ├── plugin-swift/     # Swift language plugin (tree-sitter)
│   ├── python-parser/    # tree-sitter Python extraction
│   ├── swift-parser/     # tree-sitter Swift extraction
│   ├── sqlite-compat/    # SQLite driver compatibility shim
│   └── cari-native*/     # Native CARI bindings (per-platform)
├── docs/                 # Specifications & documentation
├── .iw/                  # Workspace data (runs, cache, index.db)
└── iw.sh                 # CLI wrapper (runs via tsx)
```

> Note: the standalone REST API server (`apps/server`, `@intentweave/server-core`,
> `@intentweave/server-open`) and the `ui/` frontend have been removed from the
> monorepo. Supported integration surfaces are the CLI, MCP tools, and the
> `@intentweave/index` programmatic API. The `@intentweave/plugin-kg` /
> `plugin-kg-lite` packages (Neo4j / SQLite persistence, installed via
> `iw plugin add kg`) live outside this monorepo.

## Build & Test

```bash
pnpm install              # Install all packages
pnpm build                # Build all (Turbo)
pnpm test                 # Run all tests
pnpm dev                  # Dev mode with hot reload

# Individual packages
pnpm --filter @intentweave/core build
pnpm --filter @intentweave/index build
pnpm --filter @intentweave/analyzer build

# CLI (has pre-existing TS errors in buildFull.ts, use --noEmitOnError false)
cd packages/cli && npx tsc --noEmitOnError false

# Run CARI tests specifically
npx vitest run packages/index/src/__tests__/

# Dev CLI wrapper (no build needed)
./iw.sh <command>
```

## CARI (Code-Aware Retrieval Index)

_Also referred to as CARI Evidence Engine. `iw index _` is the canonical power API.\*

### CLI Commands

```bash
# Build the index
iw index build                        # structured depth (default)
iw index build --depth full           # + body text with IDF filtering

# Query the index
iw index retrieve "authentication"    # ranked file retrieval
iw index connections "AuthService"    # cross-layer connections + gaps
iw index check --changed src/auth.ts  # CI drift detection
iw index report                       # corpus-wide health dashboard

# Incremental update
iw index update                       # only changed files

# Export
iw index export --html                # standalone architecture.html report
iw index export --html -o report.html # custom output path
iw index export --book                # Insights Book (Phase 2 deliverable — all chapters)
iw index export --book -o insights.html  # custom path for the book
iw index export --focus "AuthService" # focused Graphviz SVG report (focus.html)
iw index export --focus "auth.ts" --hops 3 --max-nodes 30 -o auth-focus.html

# Call graph (Phase 4)
iw index calls                                    # all call edges
iw index calls --caller-file src/auth.ts          # calls from a file
iw index calls --callee-name validateToken        # all callers of a function
iw index trace --entry src/auth.ts                # forward call trace (what auth.ts calls)
iw index trace --entry src/auth.ts --direction backward  # who calls into auth.ts
iw index trace --entry src/server.ts --hops 4 --max-nodes 30
iw index rule-coverage                            # packages with zero behavioral rules
```

### Intent Engine CLI (Phase 0+1)

```bash
# iw intent * — canonical Intent Engine namespace (Phase 0 aliases, Phase 1 domain flag)
iw intent check                           # check rules.yaml against codebase (structural domain)
iw intent check --domain documentary      # run built-in documentary checks (Phase 1)
iw intent check --domain all              # run all domains (structural + behavioral + documentary)
iw intent check --rule-id bdd-auth        # check a specific rule
iw intent extract docs/ADR-001.md         # extract rules from ADR via LLM
iw intent scan                            # scan diagrams for components
iw intent living                          # living documentation health (= iw doc-health)
iw intent score                           # living documentation score (= iw verify --score)

# Domain-specific shortcuts (Phase 1)
iw living verify                          # → iw intent check --domain documentary

# Backward-compatible aliases
iw living                                 # → iw doc-health (documentary domain overview)
iw guardrails check                       # → iw index rules-check (structural domain)
```

### Phase 1: Documentary Domain Built-in Checks

When `--domain documentary` (or `all`) is passed to `iw intent check`, the engine runs four
built-in CARI-backed checks in addition to any `rules.yaml` documentary rules:

| Rule ID                | Source                       | Default Mode | Confidence |
| ---------------------- | ---------------------------- | ------------ | ---------- |
| `doc.coverage.low`     | `moduleCoverageFromDb()`     | warn         | 0.97       |
| `doc.terminology`      | `terminologyInconsistency()` | warn         | 0.80       |
| `doc.orphaned-section` | `orphanedSectionsFromDb()`   | warn         | 0.90       |
| `doc.completeness.low` | `docCompletenessFromDb()`    | warn         | 0.97       |

All documentary violations carry `ruleMode: "warn"` — they show in the output but
**do not set exit code 1** (warn-only exit). Thresholds: coverage < 50%, completeness < 40%.

Key implementation files:

- `packages/index/src/queries/documentaryCheck.ts` — documentary domain runner
- `packages/index/src/queries/rulesCheck.ts` — `domain` filter + `iwConfig` in `RulesCheckOptions`
- `packages/index/src/types.ts` — `confidence?: number` on `RulesViolation`; `IwConfig` type

### Phase 3: Behavioral Domain — Mermaid Rules

When a rule in `rules.yaml` has `domain: behavioral` and a `mermaid:` inline key (or
`source.type: mermaid_file` pointing to an ADR), the Intent Engine parses the diagram
at check time and derives violations from the CARI import graph. No LLM, no call graph.

**Supported diagram types:**

| Diagram type      | Check type                         | Confidence | Default mode |
| ----------------- | ---------------------------------- | ---------- | ------------ |
| `sequenceDiagram` | `must_call` (import presence)      | 0.70       | warn         |
| `sequenceDiagram` | `must_not_call` (import absence)   | 0.85       | error        |
| `stateDiagram-v2` | `valid_transition` (symbol naming) | 0.50       | warn         |
| `flowchart`       | `must_precede` (shared importer)   | 0.30       | warn         |

**Example `rules.yaml` entry:**

```yaml
- id: bdd-auth-sequence
  domain: behavioral
  description: "Login must route through AuthService; UI must not call TokenStore directly"
  severity: high
  mode: warn
  source:
    type: mermaid_inline
  mermaid: |
    sequenceDiagram
      UI->>AuthService: login(credentials)
      AuthService->>TokenStore: issue(token)
      AuthService-->>UI: token
  forbidden: []
```

**Or load from an ADR file:**

```yaml
- id: bdd-auth-sequence
  domain: behavioral
  severity: high
  source:
    type: mermaid_file
    file: docs/ADR-001-auth.md
    block_id: auth-login-flow # optional: named block, else first mermaid block
  forbidden: []
```

**Parser:** zero-dep regex-based edge extractor — no npm dependencies, no DOM.
`@mermaid-js/parser` and `beautiful-mermaid` were evaluated; `beautiful-mermaid` does not
support `sequenceDiagram` (the most critical type), so the custom parser was chosen.

Key implementation files:

- `packages/index/src/queries/mermaidCheck.ts` — Mermaid parser + behavioral check engine
- `packages/index/src/queries/rulesCheck.ts` — routes `domain: behavioral` + Mermaid source rules to `checkMermaidRule()`
- `packages/index/src/types.ts` — `source?`, `mermaid?` fields on `RuleDefinition`; `ruleDomain` + `confidence` on `PrescriptiveViolation`

Behavioral violations surface in:

- `iw intent check --domain behavioral` (or `--domain all`)
- Insights Book → All Violations → Behavioral section (real violations, with confidence badge + WARN mode indicator)
- Insights Book → Executive Summary → domain pills + Top Issues
- Insights Book → Recommendations chapter (ranked with behavioral items, purple domain badge)

### Phase 2: Insights Book Upgrade

`iw index export --book` generates a multi-chapter HTML deliverable. The book now opens on
the **Executive Summary** chapter by default (Phase 2).

**Insights Book chapter order (Phase 2+3):**

| Nav Section  | Chapter             | Content                                                                                                          |
| ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Summary      | Executive Summary   | Living Score badge · violations by domain (structural/behavioral/documentary) · top-3 action items · quick links |
| Summary      | Recommendations     | Cross-domain ranked violations list (top 20, sorted by severity then domain, with Behavioral in purple)          |
| Architecture | Layer Architecture  | §17 prescriptive SVG (iframe)                                                                                    |
| Architecture | Control & Data Flow | Rule table with per-ADR flow links                                                                               |
| Architecture | Arch Graph          | §10.1 D3 interactive arch report (iframe)                                                                        |
| Architecture | Per-ADR chapters    | Cytoscape.js flow diagrams + CARI overlays                                                                       |
| Reports      | All Violations      | Domain-grouped: Structural / Behavioral (real Mermaid violations) / Documentary + Dormant Rules                  |
| Reports      | Coverage            | Per-layer doc coverage + hotspot files                                                                           |
| Analytics    | Living Score        | 4-dimension score breakdown                                                                                      |
| Analytics    | Code Health         | Clones · circular imports · unused exports · boundary violations                                                 |
| Analytics    | Hotspots            | High-churn files · dependency depth · hubs · communities                                                         |
| Analytics    | Documentation       | Orphaned sections · doc completeness · rationale · terminology                                                   |

Key implementation files:

- `packages/index/src/export/insightsBook.ts` — `renderInsightsBookHtml()` + all chapter builders
- `packages/index/src/export/prescriptiveReport.ts` — `InsightsBookData` type; `PrescriptiveViolation` now has `ruleDomain`, `ruleMode`, `confidence`
- `packages/cli/src/commands/indexBuild.ts` — `buildPrescriptiveReportData()` collects all analytics; passes `domain: "all"` to `rulesCheck()`

### `.iw/config.yaml` — Per-domain CI thresholds (Phase 1)

Optional workspace config file loaded automatically by `iw intent check`.

```yaml
version: 1
thresholds:
  structural:
    max_violations: 0 # not yet enforced in exit-code (structural rules already block CI)
  documentary:
    coverage_min: 60 # flag modules with < 60% coverage (default: 50)
    completeness_min: 50 # flag docs with < 50% completeness (default: 40)
    mode: error # promote documentary violations to CI-blocking (default: warn)
  behavioral:
    mode: warn # keep behavioral violations as warnings (default)
aliases:
  "@site": "microsite" # Override auto-detected alias (manual config wins)
  "@app": "packages/app" # Webpack/TS path alias example
```

**Path alias resolution** runs automatically after every `iw index build`:

1. Reads `compilerOptions.paths` from `tsconfig.json` / `tsconfig.base.json` (follows `extends`)
2. Merges with any `aliases` in `.iw/config.yaml` (manual config wins on conflict)
3. Rewrites matching `target_file` rows in the `imports` table so cross-package rules don't produce false positives

When `documentary.mode: error` is set, `iw intent check --domain documentary` will exit 1 on violations.
When `behavioral.mode: error` is set, Mermaid `must_not_call` violations will also exit 1.

### Library API (Facade)

```typescript
import { CariIndex } from "@intentweave/index";

// Build: runs AX → KWX → COX → TCG → annotate → write
const index = await CariIndex.build({
  paths: ["docs/"],
  workspaceRoot: process.cwd(),
  depth: "full",
});

// Or load existing
const index = CariIndex.load(".iw/index.db");

// Typed queries
const results = index.retrieve({ query: "auth" });
const drift = index.check({ changed: ["src/auth.ts"] });
const conns = index.connections({ entity: "AuthService" });

index.close();
```

See `docs/LIBRARY-API.md` for full documentation.

### Key Files

| File                                                     | Purpose                                                  |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `packages/index/src/facade.ts`                           | CariIndex facade class + buildFromPaths orchestration    |
| `packages/index/src/writer.ts`                           | SQLite index builder                                     |
| `packages/index/src/annotator.ts`                        | Document→code annotation engine (IDF penalty)            |
| `packages/index/src/idf.ts`                              | IDF scorer + stopword baseline (50 terms, ceiling 0.15)  |
| `packages/index/src/schema.ts`                           | SQLite table definitions                                 |
| `packages/index/src/queries/retrieve.ts`                 | Ranked file retrieval                                    |
| `packages/index/src/queries/connections.ts`              | Cross-layer connection discovery                         |
| `packages/index/src/queries/check.ts`                    | CI drift detection                                       |
| `packages/index/src/queries/report.ts`                   | Corpus-wide health report                                |
| `packages/index/src/queries/clones.ts`                   | Exact + structural clone detection                       |
| `packages/index/src/queries/imports.ts`                  | Circular imports + unused exports                        |
| `packages/index/src/queries/hotspotPriority.ts`          | High-churn low-doc file ranking                          |
| `packages/index/src/queries/todos.ts`                    | TODO/FIXME/HACK/XXX inventory                            |
| `packages/index/src/queries/moduleCoverage.ts`           | Documentation coverage per directory                     |
| `packages/index/src/queries/orphanedSections.ts`         | Doc sections with all-ungrounded mentions                |
| `packages/index/src/queries/docCompleteness.ts`          | Per-doc completeness vs. referenced exports              |
| `packages/index/src/queries/crossGroupDrift.ts`          | Cross-group entity coverage conflicts                    |
| `packages/index/src/queries/hubs.ts`                     | God-node / hub analysis (degree centrality)              |
| `packages/index/src/queries/communities.ts`              | Label-propagation community detection                    |
| `packages/index/src/queries/surprises.ts`                | Surprising connection ranking (composite score)          |
| `packages/index/src/queries/rationale.ts`                | WHY/NOTE/IMPORTANT/DESIGN rationale inventory            |
| `packages/index/src/queries/terminologyInconsistency.ts` | Terminology inconsistency detection (1.5)                |
| `packages/index/src/queries/dependencyDepth.ts`          | Transitive import depth + fan-in/fan-out risk (3.3)      |
| `packages/index/src/queries/boundaryViolations.ts`       | Cross-package internal import detection (3.4)            |
| `packages/index/src/queries/layersInfer.ts`              | Auto-infer architectural layers from import graph (5.1a) |
| `packages/index/src/queries/layersCheck.ts`              | Validate imports against layer configuration (5.1b)      |
| `packages/index/src/queries/focus.ts`                    | Focused architecture view around a target entity         |
| `packages/index/src/queries/archReport.ts`               | Architecture report data collector (10.1)                |
| `packages/index/src/export/htmlReport.ts`                | Standalone HTML architecture report renderer (10.1)      |
| `packages/index/src/export/focusReport.ts`               | Focused architecture SVG report (Graphviz WASM)          |
| `packages/index/src/incremental.ts`                      | Content-hash incremental updates                         |
| `packages/analyzer/src/kwg/heuristicExtractor.ts`        | Keyword extraction (dictionary, depth)                   |
| `packages/analyzer/src/kwg/kwxStage.ts`                  | KWX stage options (depth, dictionary)                    |
| `packages/analyzer/src/stages/languageRegistry.ts`       | LanguageAdapter interface + LanguageRegistry class       |
| `packages/python-parser/src/extractor.ts`                | Python AST extractor (tree-sitter-python)                |
| `packages/cli/src/commands/indexBuild.ts`                | `iw index build` CLI orchestrator                        |
| `packages/cli/src/mcp/server.ts`                         | MCP server (6 KG + 52 CARI tools)                        |

### SQLite Schema (`.iw/index.db`)

- `symbols` — Code symbols from AST (name, kind, file, line, export, body_hash, structure_hash)
- `annotations` — Doc spans → code symbols (confidence, source, qualifier, IDF score)
- `co_occurrences` — Entity pairs co-mentioned in docs or co-imported in code
- `co_changes` — File pairs that change together in git (Jaccard + recency)
- `files` — Per-file metadata (last modified, churn, hotspot, owner, doc_group)
- `imports` — Import relationships between files
- `todos` — Inline TODO/FIXME/HACK/XXX markers
- `rationale` — WHY/NOTE/IMPORTANT/DESIGN rationale comments

### Depth Modes

- `structured` (default): headings, bold, code-spans, identifiers only
- `full`: + body text dictionary matching + IDF filtering. +72% annotations, +189% grounded.

### Pipeline Order (in `indexBuild.ts`)

1. **AX** — AST extraction → symbol registry + symbol dictionary
2. **KWX** — Keyword extraction (receives dictionary in full mode)
3. **COX** — Co-occurrence scoring
4. **TCG** — Git analysis (co-changes, hotspots, ownership, staleness)
5. **Annotate** — Match mentions → symbols, apply IDF penalties
6. **Write** — Persist to SQLite

## Knowledge Graph (KG)

### CLI Commands

```bash
iw doc-health                                               # Living Documentation (documentary domain, CARI default)
iw intent living                                            # Living Documentation (alias)
iw doc-health --neo4j -s my-project                         # Living Documentation (full KG mode, requires Neo4j)
iw verify --score                                           # Living Documentation Score (12.3): composite 0-100/A-F
iw intent score                                             # Living Documentation Score (alias)
iw verify --score -f json                                   # JSON output for CI integration
```

### Key Files

| File                                           | Purpose                                    |
| ---------------------------------------------- | ------------------------------------------ |
| `packages/cli/src/doc-health/cariDocHealth.ts` | Documentation health analyzer (CARI)       |
| `packages/index/src/queries/livingScore.ts`    | Living Documentation Score (12.3)          |
| `packages/index/src/queries/calls.ts`          | Call graph query (Phase 4)                 |
| `packages/index/src/queries/trace.ts`          | BFS call-path tracer (Phase 4)             |
| `packages/index/src/queries/ruleCoverage.ts`   | Behavioral rule coverage monitor (Phase 4) |

## MCP Tools

The MCP server exposes 58 tools for GitHub Copilot (6 KG + 52 CARI).

All CARI query functions are also available as CLI subcommands
(e.g., `iw index clones`, `iw index todos`) and via the `@intentweave/index`
programmatic API.

### KG Tools (require Neo4j)

| Tool            | Purpose                         | Key Parameters                  |
| --------------- | ------------------------------- | ------------------------------- |
| `kg_query`      | NL or Cypher query              | `question`, `cypher?`, `limit?` |
| `kg_context`    | Build RAG context               | `topic?`, `entity?`, `hops?`    |
| `kg_entities`   | List/search entities            | `type?`, `search?`, `limit?`    |
| `kg_impact`     | Semantic impact analysis        | `files`, `hops?`                |
| `kg_doc_health` | Documentation freshness (Neo4j) | `files?`                        |
| `kg_schema`     | Graph schema                    | _(none)_                        |

### CARI Tools (local SQLite, no Neo4j; most need no LLM)

| Tool                          | Purpose                                                    | Key Parameters                                                       |
| ----------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `intent_check`                | Check all intent domains (Phase 1 preferred tool)          | `domain?`, `severity?`, `changed?`, `limit?`                         |
| `cari_retrieve`               | Ranked file retrieval                                      | `query`, `scope?`, `limit?`                                          |
| `cari_connections`            | Connection discovery + gaps                                | `entity`, `include?`, `limit?`                                       |
| `cari_check`                  | CI drift detection                                         | `changed`, `severity?`                                               |
| `cari_clones`                 | Exact clone detection                                      | _(none)_                                                             |
| `cari_structural_clones`      | Type 2 clone detection                                     | _(none)_                                                             |
| `cari_circular_imports`       | Import cycle detection                                     | _(none)_                                                             |
| `cari_unused_exports`         | Unused exported symbols                                    | `limit?`                                                             |
| `cari_hotspot_priority`       | High-churn low-doc files                                   | `limit?`                                                             |
| `cari_todos`                  | TODO/FIXME/HACK/XXX list                                   | `kind?`, `limit?`                                                    |
| `cari_module_coverage`        | Coverage % per directory                                   | _(none)_                                                             |
| `cari_orphaned_sections`      | Ungrounded doc sections                                    | _(none)_                                                             |
| `cari_doc_completeness`       | Per-doc completeness                                       | _(none)_                                                             |
| `cari_cross_group_drift`      | Cross-group conflicts                                      | _(none)_                                                             |
| `cari_mentions_of`            | Entity → doc mentions                                      | `entityId`, `minConfidence?`, `limit?`                               |
| `cari_annotations_for`        | File → all annotations                                     | `filePath`, `minConfidence?`, `limit?`                               |
| `cari_test_coverage`          | Test→source mapping + gaps                                 | `limit?`                                                             |
| `cari_hubs`                   | God-node / hub analysis                                    | `limit?`                                                             |
| `cari_communities`            | Community detection                                        | _(none)_                                                             |
| `cari_surprises`              | Surprising connections                                     | `limit?`                                                             |
| `cari_rationale`              | WHY/NOTE/IMPORTANT/DESIGN                                  | `kind?`, `limit?`                                                    |
| `cari_terminology`            | Terminology inconsistency                                  | `limit?`                                                             |
| `cari_dep_depth`              | Transitive import depth                                    | `limit?`                                                             |
| `cari_boundary_violations`    | Package boundary violations                                | _(none)_                                                             |
| `cari_layers_infer`           | Auto-infer architectural layers                            | _(none)_                                                             |
| `cari_layers_check`           | Validate imports vs. layer config                          | `allowSkipLayer?`                                                    |
| `cari_focus`                  | Focused architecture view                                  | `target`, `hops?`, `maxNodes?`                                       |
| `cari_slices`                 | Vertical slice detection (feature cohorts spanning layers) | `minLayers?`, `limit?`                                               |
| `cari_enrich`                 | Score + optionally trigger selective LLM enrichment        | `budget?`, `dryRun?`, `provider?`                                    |
| `cari_resolve`                | Resolve diagram component to code symbols + docs           | `name`, `limitSymbols?`, `limitDocs?`                                |
| `cari_arch_diff`              | Validate diagram entities/flows against CARI evidence      | `paths?`, `provider?`, `refresh?`                                    |
| `cari_component_evidence`     | All CARI evidence for one architecture component           | `name`, `limit?`                                                     |
| `cari_living_score`           | Composite living documentation score (12.3)                | `minConfidence?`, `allowSkipLayer?`                                  |
| `cari_calls`                  | Query the symbol_calls call graph (Phase 4)                | `callerFile?`, `calleeName?`, `callerName?`, `methodOnly?`, `limit?` |
| `cari_trace`                  | Trace call paths from entry-point file (Phase 4)           | `entry` (required), `hops?`, `maxNodes?`, `direction?`               |
| `cari_naming_violations`      | Naming-convention enforcement                              | `limit?`                                                             |
| `cari_comment_code_ratio`     | Comment-to-code ratio per file                             | `limit?`                                                             |
| `cari_skipped_files`          | Files excluded from CARI analysis                          | _(none)_                                                             |
| `cari_rules_check`            | Rules check (structural domain, direct)                    | `severity?`, `changed?`                                              |
| `cari_deprecated_callers`     | Calls to `@deprecated` symbols                             | `limit?`                                                             |
| `cari_internal_violations`    | `@internal` / `_` boundary violations                      | _(none)_                                                             |
| `cari_type_assertions`        | `as any` and forced type-assertion inventory               | `limit?`                                                             |
| `cari_test_intent`            | Test descriptions vs. symbol alignment                     | `limit?`                                                             |
| `cari_rules_trend`            | ADR conformance trend over git history                     | `limit?`                                                             |
| `cari_layers_from_decorators` | Layer assignment from class decorators                     | _(none)_                                                             |
| `cari_layers_name`            | LLM-generated layer & directory names                      | `provider`, `model?`, `api_key?`                                     |
| `cari_verify`                 | Spec-to-code grounding verification                        | _(none)_                                                             |
| `cari_consistency`            | Constraint consistency check                               | _(none)_                                                             |
| `cari_arch_check`             | Validate diagrams against import evidence                  | `paths?`, `provider?`                                                |
| `cari_cypher`                 | Custom graph queries via CypherLite                        | `query`, `limit?`                                                    |
| `cari_graph_schema`           | CARI graph schema — node/rel types, query templates        | _(none)_                                                             |
| `cari_capsule`                | Architecture snapshot / capsule export                     | `format?`                                                            |

### CARI Programmatic Queries (via `@intentweave/index`)

All CARI query functions are available as direct API calls, MCP tools, and CLI subcommands:

| Function                     | CLI Command                    | Purpose                                                                                  |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `clones()`                   | `iw index clones`              | Exact clone detection (identical body hash)                                              |
| `structuralClones()`         | `iw index structural-clones`   | Type 2 clones (same control flow, different identifiers)                                 |
| `circularImports()`          | `iw index circular-imports`    | Import cycle detection                                                                   |
| `unusedExports()`            | `iw index unused-exports`      | Exported symbols never imported                                                          |
| `hotspotPriority()`          | `iw index hotspot-priority`    | High-churn low-doc files ranked by urgency                                               |
| `todos()`                    | `iw index todos`               | TODO/FIXME/HACK/XXX inventory                                                            |
| `moduleCoverage()`           | `iw index module-coverage`     | Documentation coverage % per directory                                                   |
| `orphanedSections()`         | `iw index orphaned-sections`   | Doc sections with all-ungrounded mentions                                                |
| `docCompleteness()`          | `iw index doc-completeness`    | Per-doc completeness vs. referenced exports                                              |
| `crossGroupDrift()`          | `iw index cross-group-drift`   | Entity coverage conflicts across doc groups                                              |
| `mentionsOf()`               | `iw index mentions-of`         | Find doc mentions of a code or external entity                                           |
| `annotationsForFile()`       | `iw index annotations-for`     | List all annotations for a documentation file                                            |
| `testCoverage()`             | `iw index test-coverage`       | Map test files to source files, find untested exports                                    |
| `hubs()`                     | `iw index hubs`                | Degree centrality across all edge types (god-node)                                       |
| `communities()`              | `iw index communities`         | Label-propagation community detection                                                    |
| `surprises()`                | `iw index surprises`           | Surprising connection ranking (composite score)                                          |
| `rationale()`                | `iw index rationale`           | WHY/NOTE/IMPORTANT/DESIGN rationale inventory                                            |
| `terminologyInconsistency()` | `iw index terminology`         | Detect different doc names for the same code symbol                                      |
| `dependencyDepth()`          | `iw index dep-depth`           | Transitive import depth + fan-in/fan-out risk                                            |
| `boundaryViolations()`       | `iw index boundary-violations` | Cross-package internal import detection                                                  |
| `layersInfer()`              | `iw index layers-infer`        | Auto-infer architectural layers from import graph                                        |
| `layersCheck()`              | `iw index layers-check`        | Validate imports against layer configuration                                             |
| `focus()`                    | `iw index focus`               | Focused architecture view around a target entity                                         |
| `livingScore()`              | `iw verify --score`            | Composite living documentation score (spec + consistency + freshness + arch conformance) |
| `calls()`                    | `iw index calls`               | Query symbol_calls call graph (Phase 4)                                                  |
| `trace()`                    | `iw index trace`               | BFS call-path tracing from entry-point file (Phase 4)                                    |
| `ruleCoverage()`             | `iw index rule-coverage`       | Flag packages with zero behavioral rules (Phase 4)                                       |

### Entity Bridge

The Entity Bridge lets consumers inject external entities (domain concepts, pipeline
entities, third-party models) so that annotation matching works beyond AST-extracted
code symbols.

```typescript
import { CariIndex, type ExternalEntity } from "@intentweave/index";
const index = CariIndex.load(".iw/index.db");
index.registerEntities([
  {
    id: "entity:auth",
    name: "AuthService",
    type: "component",
    aliases: ["auth service"],
  },
]);
const mentions = index.mentionsOf({ entityId: "entity:auth" });
```

CLI: `iw index register-entities entities.json` (reads JSON array of ExternalEntity objects)

### Usage Patterns

- "Find files about auth" → `cari_retrieve` with query="authentication"
- "What's connected to AuthService?" → `cari_connections` with entity="AuthService"
- "I changed auth.ts — what docs need updating?" → `cari_check` with changed files
- "Find duplicate code" → `cari_clones`
- "Show circular dependencies" → `cari_circular_imports`
- "What TODOs exist?" → `cari_todos`
- "Which modules lack documentation?" → `cari_module_coverage`
- "What decisions were made?" → `kg_query` with NL question
- "Where is AuthService mentioned?" → `cari_mentions_of` with entityId
- "What entities appear in AUTH.md?" → `cari_annotations_for` with filePath
- "Build context about authentication" → `kg_context` with topic
- "What are the central entities?" → `cari_hubs` for god-node analysis
- "Show me code clusters" → `cari_communities` for community detection
- "Find unexpected connections" → `cari_surprises` for surprising couplings
- "Why was this code written?" → `cari_rationale` for design rationale
- "Do docs use consistent names?" → `cari_terminology` for naming inconsistencies
- "Which files have deep dependency chains?" → `cari_dep_depth` for import depth analysis
- "Are there cross-package boundary violations?" → `cari_boundary_violations` for monorepo hygiene
- "What are the architectural layers?" → `cari_layers_infer` for auto-inferred layer analysis
- "Do imports respect layer boundaries?" → `cari_layers_check` for layer violation detection
- "Show me the architecture around auth.ts" → `cari_focus` for focused architecture view
