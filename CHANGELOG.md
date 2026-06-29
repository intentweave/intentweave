# Changelog

All notable changes to IntentWeave are documented in this file.

## [0.15.6] — 2026-06-20

### Fixed

- **`iw index retrieve` / `context-pack` latency on large corpora** — 3m24s → sub-second on a
  2.2M-annotation index. Root causes:
  - `ORDER BY rank` on FTS5 JOIN forced full BM25 scan before `LIMIT 500` — removed (JS file-level
    scoring handles ranking)
  - N+1 symbol lookups (up to 500 individual queries) replaced with one bulk `IN (?)` query
  - Strategy 3 exact-match (`LOWER(text)` full scan on 2.2M rows) now skipped for multi-word queries
  - Co-occurrence `LOWER()` scans on 440K rows added lazy expression indexes (`idx_co_occ_a_lower`,
    `idx_co_occ_b_lower`, `idx_annotations_text`) — one-time creation on first `openIndex` call,
    persisted in the DB file

- **`iw index update` NOT NULL failures** — incremental writer now skips call edges with no caller
  name (`symbol_calls.caller_name NOT NULL`) and defaults `idf_score` to `1.0` instead of NULL

- **FTS5 index not synced after native build** — `rebuildFtsIndexes()` is now called after
  `cari-build` exits, enabling multi-word `retrieve` queries on natively-built indexes

- **FTS5 `rowid` JOIN was wrong** — `fts.rowid = a.id` (TEXT UUID) fixed to `fts.rowid = a.rowid`
  (integer rowid); multi-word queries always returned 0 results previously

- **FTS5 AND vs OR semantics** — `sanitizeFtsQuery` now joins tokens with `OR` so any matching
  keyword scores a file, rather than requiring all tokens in a single annotation row

### Added

- **`--no-native` flag for `iw index build`** — forces the TypeScript pipeline even when the Rust
  binary is available. Verbose mode shows which engine was chosen and why.
- **WAL mode set after native build** — `PRAGMA journal_mode=WAL; synchronous=NORMAL` applied
  post-build for faster subsequent reads

---

## [0.15.5] — 2026-06-21

### Added

- **`cari_context_pack` MCP tool + `iw index context-pack` CLI command** — composite context
  bundle for LLM injection: ranked files, symbols, architectural rules (from conformance
  snapshots), cross-layer connections, design rationale, and documentation drift in one call.
  Token-budgeted (default 4 000 tokens), deterministic markdown output, empty sections omitted.
  Accepts `--query`, `--files`, `--entity`, `--budget`, `--sections`, and `--format json`.

---

## [0.15.4] — 2026-06-20

### Added

- **Auto-detect TypeScript path aliases from `tsconfig.json`** — `iw index build` now reads
  `compilerOptions.paths` from `tsconfig.json` and `tsconfig.base.json` (following `extends`
  chains) and automatically rewrites aliased import specifiers in the index. This eliminates
  false positives from cross-package rules in any project that uses TypeScript path aliases,
  Webpack aliases, or Vite aliases — without requiring any manual configuration. Manual
  `aliases` in `.iw/config.yaml` are merged on top and take precedence on conflict.

---

## [0.15.3] — 2026-06-14

### Added

- **Path alias resolution in `.iw/config.yaml`** — new `aliases` key rewrites import specifiers
  after index build so that path-aliased imports (Docusaurus `@site`, Webpack `@app`, TypeScript
  `paths`, etc.) resolve to their real workspace-relative paths before cross-package checks run.
  Without this, tools like `no-cross-package-internal-imports` raised false positives for any
  project that uses module aliases. Configuration:

  ```yaml
  aliases:
    "@site": "microsite"
    "@app": "packages/app/src"
  ```

  Applied as a post-build SQLite `UPDATE` on the `imports` table; works with both the native
  Rust `cari-build` binary and the TypeScript pipeline.

- **`iw intent extract` workspace-structure context** — before calling the LLM, the command now
  loads up to 30 real file paths from the CARI index and injects them into the system prompt.
  This prevents the LLM from generating glob patterns like `src/**` that match nothing in a
  monorepo where all files live under `packages/*/src/**` or `plugins/*/src/**`.

- **Scope warnings in `iw intent check`** — if a rule's `in:` glob matches zero indexed files,
  the check now prints a warning rather than silently reporting the rule as clean:

  ```
  ⚠  scope warning: avoid-default-exports — in: src/** matched 0 indexed files (rule never evaluated)
  ```

- **`variable_assignment` rule accepts `pattern` field** — the LLM extraction prompt documents
  `pattern` as the field for `variable_assignment` rules; the checker now treats `pattern` as an
  alias for `value_pattern` so LLM-generated rules are not silently skipped.

- **`maxTokens` raised to 8192 in `iw intent extract`** — prevents LLM response truncation when
  many ADRs are analyzed in a single run.

### Changed

- **`node:sqlite` migration** — replaced `better-sqlite3` (native C++ addon requiring build tools)
  with `node:sqlite` (Node.js 22.15+ built-in) via a new `@intentweave/sqlite-compat` shim package.
  Zero native compilation; `npm install` no longer requires a C++ toolchain. Requires Node ≥ 22.15.

- **`SmartMockLLMProvider` moved to `@intentweave/plugin-llm`** — the mock provider used in tests
  and as an LLM fallback is now the canonical export of `plugin-llm` instead of a broken
  `@intentweave/analyzer/llm` sub-path export.

---

## [0.13.0] — 2026-05-17

### Added

- **Rust Indexer Port design analysis** — added to BACKLOG.md: full architecture plan for replacing
  the CARI build pipeline (AX + KWG stages) with a native Rust binary (`packages/cari-native/`).
  Measured baselines: 47 s on 595 files (KWG = 69% of build time). Phase R1 targets 10–20× speedup
  (47 s → 3–5 s) using `oxc_parser`, `pulldown-cmark`, `rayon`, `rusqlite`, and `gix`.
  The 57 TypeScript query files remain unchanged — only the build path moves to Rust.

### Changed

- **TypeScript 5.9** — all packages upgraded from `typescript ^5.6.0` to `^5.9.3`.
- **Prettier 3.8** — formatter upgraded from `^3.3.0` to `^3.8.3`.
- **Turbo 2.9** — build orchestrator upgraded from `^2.8.14` to `^2.9.14`.
- **Vitest 2.1.9** — test runner upgraded from `^2.1.0` to `^2.1.9`.
- **@types/node** — updated from `^20.19.37` to `^20.19.41`.

### Infrastructure

- All 16 packages bumped to `0.13.0`.

---

## [0.12.0] — 2026-05-17

### Added

- **Insights Book** (`iw index export --book`) — a single self-contained HTML deliverable that
  answers _"is this project OK?"_ at a glance. 15+ navigable chapters with full cross-chapter
  navigation, interactive D3 visualizations, domain-filtered violation tables, and a composite
  living score badge. Chapters cover:
  - **Executive Summary** — living score badge, violation domain pills (structural / behavioral /
    documentary), top-3 action items, quick links to other chapters
  - **Recommendations** — top-20 cross-domain issues ranked by severity, with domain badges
  - **Rules Catalog** — full `rules.yaml` inventory, filterable by domain / severity, with
    Mermaid and Cypher indicators per rule
  - **Layer Architecture** — §17 prescriptive SVG iframe with layer geometry, rule overlays, and
    allowed/forbidden flow arrows
  - **Documentation & Source** — three-panel explorer: docs list, source files, per-file
    annotation evidence
  - **Architecture** — §10.1 D3 interactive chart (Layers / Violations / Communities /
    Dependencies tabs)
  - **Code Structure** — transitive dependency depth table with CRITICAL / HIGH risk indicators
  - **Code Health** — exact clone groups, structural clones, circular imports
  - **Violations** — domain-grouped tables (Structural / Behavioral / Documentary) with per-rule
    expansion and dormant rules section
  - **Coverage** — per-layer documentation coverage table with low-coverage warning; Layer Sankey
    SVG (two-column bezier bands, blue = allowed, red = violation, width ∝ import count — rendered
    when cross-layer flows exist)
  - **Living Score** — 4-dimension breakdown (spec grounding · consistency · freshness ·
    architectural conformance)
  - **Priority Files** — high-churn / low-doc hotspot table with urgency scores
  - **Tech Debt** — TODO / FIXME / HACK / XXX inventory
  - **Test Coverage** — symbol-level coverage % and per-directory breakdown
  - **Call Graph** — butterfly trace around any entry-point file; depth / mode controls;
    23 000+ edge corpus for large repos
  - **Per-ADR chapters** — Cytoscape.js + dagre flow diagrams for each ADR rule, with CARI
    import-graph overlay and per-rule violation panel
  - Opens on **Executive Summary** by default

- **Intent Engine — domain support** (`--domain structural|behavioral|documentary|all`) on
  `iw intent check`. All three domains enforced in a single pass; warn-only domains do not
  set exit code 1 unless promoted via `.iw/config.yaml`.

- **Behavioral Domain — Mermaid Rules** (Phase 3) — express architectural intent as inline
  or ADR-sourced Mermaid diagrams in `rules.yaml`; CARI validates against the live import graph
  at $0 / < 100 ms:

  | Diagram type      | Check type         | Confidence | Default mode |
  | ----------------- | ------------------ | ---------- | ------------ |
  | `sequenceDiagram` | `must_call`        | 0.70       | warn         |
  | `sequenceDiagram` | `must_not_call`    | 0.85       | error        |
  | `stateDiagram-v2` | `valid_transition` | 0.50       | warn         |
  | `flowchart`       | `must_precede`     | 0.30       | warn         |

  Custom zero-dependency regex parser (no DOM, no `@mermaid-js/parser`). Violations surface in
  the Insights Book (Behavioral section, confidence badge, WARN mode indicator) and in
  `iw intent check --domain behavioral`.

- **Documentary Domain — built-in CARI checks** (Phase 1) — four automatic checks run whenever
  `--domain documentary` (or `all`) is passed; no rules.yaml entry required:

  | Rule ID                | Threshold      | Default mode |
  | ---------------------- | -------------- | ------------ |
  | `doc.coverage.low`     | coverage < 50% | warn         |
  | `doc.terminology`      | any mismatch   | warn         |
  | `doc.orphaned-section` | any orphan     | warn         |
  | `doc.completeness.low` | complete < 40% | warn         |

- **`.iw/config.yaml`** — per-domain CI thresholds. Override coverage/completeness floor and
  promote warn-only domains to CI-blocking (`mode: error`).

- **Call Graph** (Phase 4) — full call-graph pipeline extracted from AST:
  - `iw index calls` — query `symbol_calls` edges by caller file / callee name
  - `iw index trace` — BFS call-path tracing from an entry-point file (forward or backward)
  - `iw index rule-coverage` — flag packages with zero behavioral rules
  - MCP: `cari_calls`, `cari_trace`

- **Prescriptive Architecture Diagram** (§17 complete) — standalone HTML export of the
  architectural intent graph:
  - `allowed:` entries in `rules.yaml` (17.2) with edge-level rationale support
  - Layer geometry rendering for SVG layout (17.1a)
  - Rule-expressed element overlay with violation heat-map (17.1b)
  - ASCII conformance diagram inline in `iw intent check` output (17.4)
  - LLM-assisted prescriptive spec synthesis from ADR prose — generates `allowed:` entries,
    `forbidden:` rules, and layer assignment hints in a single LLM call (17.3)

- **Semantic rules — extended rule types and modifiers** (13.5–13.11, 15.1–15.5):
  - `type: variable_assignment` — flag assignments to forbidden variables (13.10)
  - `type: cypher` — custom graph queries via CypherLite for domain-specific rules (13.11)
  - `type: property_chain_length` — limit chained property access depth (15.3)
  - `--baseline` regression gating — compare violation count against a stored baseline, fail CI
    only on regressions (13.5)
  - `import_pattern: "**"` glob matching across path separators (13.6)
  - Import violation line numbers in output (13.7)
  - `symbol_name` scope modifier — restrict rule to exports, internals, or tests (13.9)
  - `context_import` modifier — apply a rule only when a specific import is present (15.1)
  - `except_symbol` exclusion list (15.2)
  - `count_mode: per_file` — count violations per file rather than globally (15.4)
  - Autofix hints in rules output (15.5)
  - JSON redirect fix for `rules-check` output (13.8)

- **Signal-layer checks** (14.1–14.6):
  - `iw index deprecated-callers` — detect calls to `@deprecated`-annotated symbols (14.1)
  - `iw index internal-violations` — enforce `@internal` / `_`-prefixed symbol boundaries (14.2)
  - `iw index type-assertions` — inventory `as any` and forced type assertions (14.3)
  - `iw index naming-violations` — configurable naming-convention enforcement (6.1)
  - `iw index comment-code-ratio` — comment-to-code ratio per file (6.4)
  - `iw index layers-from-decorators` — derive layer assignment from class decorators
    (`@Controller`, `@Injectable`, `@Module`, etc.) without manual `layers.yaml` (14.4)
  - `iw index rules-trend` — ADR conformance trend over git history (14.5)
  - `iw index test-intent` — detect test descriptions that reference no matching symbol (14.6)

- **Intra-function def-use chains** (16.1) — track variable assignments and reads within a
  function body to detect shadowed variables, unused assignments, and tainted flows.

- **Cross-layer clone analysis** (5.9) — surface clones that span layer boundaries, indicating
  accidental duplication across architectural tiers.

- **Selective semantic enrichment** (11.8) — `iw index enrich` targets the highest-value files
  (hotspots, orphans, hubs) for LLM triple extraction and writes results back into the same
  `index.db`. Budget-controlled (`--budget N`), incremental.

- **Spec-to-code verification** (12.1) and **constraint consistency check** (12.2) — validate
  that rules in `rules.yaml` have measurable code grounding; detect conflicting rule pairs.

- **Architecture Book** (§18) — interactive multi-chapter HTML book with per-ADR Cytoscape.js
  flow diagrams, CARI overlay toggles, rule panel, and violation list per ADR chapter.
  All vendor bundles (Cytoscape.js + dagre) inlined for offline use.

- **Watch mode** (10.2) — `iw index watch` continuously re-indexes on file change; incremental
  updates only re-process modified files.

- **CI integration** (8.4) — `intentweave/doc-health-action@v1` GitHub Action runs
  `iw intent check` in CI with configurable domain, severity, and format flags.

- **Git hooks** (10.3) — `iw hook install / uninstall / status` adds a pre-commit hook
  that runs `iw intent check --changed` on staged files.

- **REST API v1.0.0** (8.5) — all CARI query functions available over HTTP. New endpoints:
  `/api/rules-check`, `/api/living-score`, `/api/enrich`, `/api/calls`, `/api/trace`.

- **Diagram validation** (5.8) — `iw index arch-check` / `cari_arch_diff` validates component
  names and flow edges in ASCII/Mermaid diagrams against CARI import evidence.

- **58 MCP tools total** (up from 35): added `intent_check`, `cari_calls`, `cari_trace`,
  `cari_rules_check`, `cari_rules_trend`, `cari_deprecated_callers`, `cari_internal_violations`,
  `cari_type_assertions`, `cari_naming_violations`, `cari_comment_code_ratio`,
  `cari_layers_from_decorators`, `cari_test_intent`, `cari_skipped_files`, `cari_verify`,
  `cari_enrich`, `cari_consistency`, `cari_capsule`, `cari_cypher`, `cari_graph_schema`,
  `cari_slices`, `cari_arch_check`, and others.

### Changed

- `iw intent check` is now the canonical entry-point for all enforcement domains (replaces
  separate `iw guardrails check` and `iw living verify` aliases; backward-compatible aliases
  preserved).
- `iw index export --book` replaces `iw index export --html` as the primary deliverable command;
  `--html` still generates the standalone §10.1 architecture report.
- Insights Book opens on the **Executive Summary** chapter by default.
- `iw index export --focus` focused SVG report now also embeds CARI evidence (hub degree,
  community label, layer name) in node tooltips.
- `iw intent score` / `iw verify --score` now outputs 4-dimension breakdown
  (spec · consistency · freshness · arch).

### Fixed

- Spurious change reports in watch / incremental update cycles when file content was
  unchanged but mtime differed.
- Hub analysis crash on projects with null import data.
- `rules-check` JSON output incorrectly redirected when `--format json` was combined with
  `--output`; stdout and file output are now independent.

### Infrastructure

- **1532 tests** across 80 test files (up from 1375 / 70)
- **16 published packages** (`@intentweave/*@0.12.0`)
- Added `docs/ADR-001-INTENT-ENGINE.md`, `docs/PRODUCT-CONCEPT.md`,
  `docs/ROADMAP.md`, `docs/SEMANTIC-RULES-SPEC.md`
- Cytoscape.js + dagre vendor bundles inlined in the `@intentweave/index` package for
  fully offline per-ADR flow diagrams
- All packages remain at `0.12.0`; lockstep versioning via `scripts/bump-version.sh`

---

## [0.9.0] — 2026-04-19

### Added

- **Plugin architecture** (11.1–11.6) — `PluginRegistry` with auto-discovery, 3 capability types
  (LLM, persistence, language), and 6 plugins:
  - `@intentweave/plugin-llm` — OpenAI-compatible LLM capability
  - `@intentweave/plugin-kg` — Neo4j persistence backend
  - `@intentweave/plugin-kg-lite` — zero-config SQLite persistence via CypherLite
  - `@intentweave/plugin-python` — Python AST extraction (tree-sitter)
  - `@intentweave/plugin-swift` — Swift AST extraction (tree-sitter)
- **CypherLite** (`@intentweave/cypher-lite`) — zero-dependency Cypher→SQL transpiler with
  MATCH, WHERE, RETURN, ORDER BY, LIMIT, SKIP, OPTIONAL MATCH, and label/property filtering.
  63 tests, powers the KG-Lite plugin.
- **Plugin CLI commands** — `iw plugin list`, `iw plugin add <name>`, `iw plugin remove <name>`
- **18 packages total** (up from 12), all published to npm

### Changed

- Language parsers (Python, Swift) now register via `LanguageCapability` plugin interface
  instead of hardcoded dispatch
- KG persistence abstracted behind `PersistenceCapability` — consumers no longer import
  Neo4j directly
- LLM calls abstracted behind `LlmCapability` — layer naming, enrichment, and extraction
  use the plugin interface

### Infrastructure

- All 16 public packages published to npm as `@intentweave/*@0.9.0` (6 new, 10 updated)
- tsconfig project references added for all new packages
- 1375+ tests across 70 test files
- Updated README with three-layer umbrella vision (CARI → Enrichment → Verification)
- Updated intentweave.org: new homepage, plugins page with combinations matrix, restructured
  sidebar, rewritten roadmap

## [0.8.0] — 2026-04-13

### Added

- **Focused architecture view** — explore the architecture around any target file or symbol with
  configurable hop depth and max-node limits. Renders as a standalone Graphviz WASM-powered SVG
  report (`iw index export --focus <target>`). MCP: `cari_focus`.
- **Interface conformance drift** (5.2) — detect when a class claims to implement an interface but
  method signatures have diverged. Extracts `implements` clauses from AST (`class_heritage` in
  tree-sitter), compares method signatures, and reports missing methods, missing properties, and
  signature mismatches. CLI: `iw index conformance`.
- **Dead feature detection** (5.3) — combine three signals (unused exports, undocumented symbols,
  stale files) to surface likely dead features. Configurable minimum signal count and staleness
  threshold. CLI: `iw index dead-features`.
- **API surface changelog** (5.4) — track exported symbols over time via git history. Detects
  additions, removals, and signature changes per release. Auto-generates summaries like
  _"+40 added, −14 removed, ~1 signature changed across 28 files"_.
  CLI: `iw index api-surface [--baseline <ref>]`.
- **As-is vs. as-should layer comparison** (5.6) — `iw index layers-check --compare` runs both
  inference and config validation, outputting a three-column delta view showing where files
  actually are vs. where they should be.
- **4 new CLI subcommands**: `conformance`, `dead-features`, `api-surface`, `focus`
- **1 new MCP tool**: `cari_focus` (focused architecture view)
- **34 MCP tools total**, **1248 tests**

### Fixed

- **Hub analysis crash** on projects with null import data (added null guards)
- **Check severity filtering** now promotes severity based on annotation confidence
- **Impact analysis** works without Neo4j (CARI-only mode)
- **Layer inference granularity** — improved fan-out splitting for more balanced layers

## [0.7.0] — 2026-04-11

### Added

- **Multi-view community detection** — three modes for different architectural perspectives:
  - `structural` (default): imports + co-changes + file-level co-occurrences
  - `semantic`: full co-occurrence graph including doc mentions and generic terms
  - `temporal`: co-change edges only, revealing historically coupled file clusters
  - Mode switchable via CLI (`--mode`), MCP (`cari_communities` `mode` param), and the HTML
    architecture report dropdown
- **Vertical slice detection** — identify cross-layer feature slices (communities spanning ≥ 2
  layers), distinguished from horizontal layers via layer-span heuristic
- **Hierarchical sub-layering** — recursive sub-community splitting within architectural layers,
  with four-strategy fallback: LPA subgraph → hub removal → weak-edge removal → file-path grouping
- **Community resolution parameter** — `--resolution` scales max community size for finer or
  coarser clustering (default 1.0; higher = more communities)
- **Deterministic community detection** — seeded PRNG (mulberry32, seed=42) ensures identical
  results across runs
- **LLM-powered layer & directory naming** — optional `--provider openai` on `export --html`
  generates descriptive names for layers and aggregated directories via a single LLM call
  (`cari_layers_name` MCP tool)
- **Interactive HTML architecture report enhancements:**
  - Community mode dropdown (structural / semantic / temporal) with live re-rendering
  - Slice highlighting: click a community in the legend to highlight its vertical slice across layers
  - Sub-layer bands within layers for hierarchical grouping
  - Documentation nodes (purple dashed circles) linked to their communities
  - Directory aggregation with LLM-generated directory labels
  - Improved tooltip with per-file metrics (depth, dependents, risk, hub degree, community)
- **1 new MCP tool**: `cari_layers_name` (LLM-generated layer and directory naming)
- **33 MCP tools total**, **1220 tests** (1217 functional, 3 flaky perf baselines)

### Changed

- Community detection now defaults to `structural` mode (file-graph only), avoiding noise from
  generic term co-occurrences that previously created mega-communities
- Architecture report (`archReportFromDb`) now computes all three community views and embeds them
  in the report data for client-side mode switching
- `communitiesFromDb` accepts `mode` option to select the graph builder

### Fixed

- Mega-community problem: generic terms ("code", "build", "file") no longer inflate community
  sizes in structural mode by switching to a file-only graph
- Non-deterministic community assignments across runs (seeded PRNG)
- Summary panel in HTML report now updates dynamically on community mode switch

## [0.5.0] — 2026-04-08

### Added

- **Python AST extraction** via `@intentweave/python-parser` (tree-sitter)
- **Language-agnostic AX dispatch** (`LanguageRegistry` + `LanguageAdapter` interface)
- **Architecture analysis & visualization (5.1a/b/c, 10.1):**
  - Auto-infer architectural layers from import graph (`layersInfer`)
  - Validate imports against layer boundaries (`layersCheck`)
  - Interactive HTML architecture report (`export --html`) with three views:
    Layers, Communities, Dependencies
  - Directory aggregation in all views
- **Graph topology functions:**
  - Hub / god-node analysis (`hubs`)
  - Label-propagation community detection (`communities`)
  - Surprising connection ranking (`surprises`)
  - Rationale extraction (`rationale`)
- **Terminology inconsistency detection** (`terminology`)
- **Dependency depth + boundary violation detection** (`depDepth`, `boundaryViolations`)
- `CariIndex` facade — single-class API for build + query
- Entity Bridge — inject external entities for annotation matching
- `mentionsOf()` / `annotationsForFile()` query methods
- Test coverage mapping (`testCoverage()`)
- 2 new MCP tools (`cari_mentions_of`, `cari_annotations_for`)
- 3 new CLI subcommands (`mentions-of`, `annotations-for`, `register-entities`)
- Library API documentation

## [0.4.0] — 2026-04-08

### Added

- Swift AST extraction via `@intentweave/swift-parser` (tree-sitter)
- npm publish setup + CLI usage guide
- Lockstep version management (`scripts/bump-version.sh`)

## [0.3.0] — 2026-04-07

### Added

- CARI implementation (full pipeline: AX → KWX → COX → TCG → annotate → write)
- CARI-backed doc-health as default mode
- Replaced legacy codegraph references with intentweave branding

## [0.2.0] — 2026-04-07

### Added

- Initial release with KG pipeline (IN → FX → KX → GX)
- CLI commands: `run`, `query`, `context`, `persist`, `impact`, `doc-health`
- MCP server with 6 KG tools
- Fastify server with REST API
- React UI with D3 graph visualization
