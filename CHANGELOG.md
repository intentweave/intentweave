# Changelog

All notable changes to IntentWeave are documented in this file.

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
