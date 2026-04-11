# Changelog

All notable changes to IntentWeave are documented in this file.

## [0.6.0] — 2026-04-11

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
