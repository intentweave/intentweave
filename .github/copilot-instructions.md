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
├── apps/
│   └── server/           # Fastify backend (REST API)
├── packages/
│   ├── analyzer/         # Pipeline stages (IN, FX, KX, RX, CX, MX, PX, KWX, COX, AX)
│   ├── ast-extractor/    # AST-based code entity extraction (tree-sitter)
│   ├── cli/              # `iw` CLI commands + MCP server
│   ├── core/             # Shared types, LLM interfaces, utilities
│   ├── index/            # CARI — SQLite index (annotator, IDF, queries, incremental)
│   ├── profiles/         # Profile packs for domain-specific extraction
│   ├── server-core/      # Fastify + Neo4j + middleware
│   ├── server-open/      # Open track API routes
│   └── swift-parser/     # tree-sitter Swift extraction
├── ui/                   # React + Vite frontend
├── docs/                 # Specifications & documentation
├── .iw/                  # Workspace data (runs, cache, index.db)
└── iw.sh                 # CLI wrapper (runs via tsx)
```

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
```

### Key Files

| File                                              | Purpose                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| `packages/index/src/writer.ts`                    | SQLite index builder                                    |
| `packages/index/src/annotator.ts`                 | Document→code annotation engine (IDF penalty)           |
| `packages/index/src/idf.ts`                       | IDF scorer + stopword baseline (50 terms, ceiling 0.15) |
| `packages/index/src/schema.ts`                    | SQLite table definitions                                |
| `packages/index/src/queries/retrieve.ts`          | Ranked file retrieval                                   |
| `packages/index/src/queries/connections.ts`       | Cross-layer connection discovery                        |
| `packages/index/src/queries/check.ts`             | CI drift detection                                      |
| `packages/index/src/queries/report.ts`            | Corpus-wide health report                               |
| `packages/index/src/queries/clones.ts`            | Exact + structural clone detection                      |
| `packages/index/src/queries/imports.ts`           | Circular imports + unused exports                       |
| `packages/index/src/queries/hotspotPriority.ts`   | High-churn low-doc file ranking                         |
| `packages/index/src/queries/todos.ts`             | TODO/FIXME/HACK/XXX inventory                           |
| `packages/index/src/queries/moduleCoverage.ts`    | Documentation coverage per directory                    |
| `packages/index/src/queries/orphanedSections.ts`  | Doc sections with all-ungrounded mentions               |
| `packages/index/src/queries/docCompleteness.ts`   | Per-doc completeness vs. referenced exports             |
| `packages/index/src/queries/crossGroupDrift.ts`   | Cross-group entity coverage conflicts                   |
| `packages/index/src/incremental.ts`               | Content-hash incremental updates                        |
| `packages/analyzer/src/kwg/heuristicExtractor.ts` | Keyword extraction (dictionary, depth)                  |
| `packages/analyzer/src/kwg/kwxStage.ts`           | KWX stage options (depth, dictionary)                   |
| `packages/cli/src/commands/indexBuild.ts`         | `iw index build` CLI orchestrator                       |
| `packages/cli/src/mcp/server.ts`                  | MCP server (6 KG + 13 CARI tools)                       |

### SQLite Schema (`.iw/index.db`)

- `symbols` — Code symbols from AST (name, kind, file, line, export, body_hash, structure_hash)
- `annotations` — Doc spans → code symbols (confidence, source, qualifier, IDF score)
- `co_occurrences` — Entity pairs co-mentioned in docs or co-imported in code
- `co_changes` — File pairs that change together in git (Jaccard + recency)
- `files` — Per-file metadata (last modified, churn, hotspot, owner, doc_group)
- `imports` — Import relationships between files
- `todos` — Inline TODO/FIXME/HACK/XXX markers

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
iw run docs/*.md --track open --provider openai -i -v   # Extract
iw persist --latest -v                                    # Persist to Neo4j
iw query "What are the main components?" -s my-project   # Query
iw context "authentication" -s my-project                 # RAG context
iw impact src/auth.ts -s my-project                       # Impact analysis
iw doc-health                                               # Doc health (CARI default)
iw doc-health --neo4j -s my-project                         # Doc health (full KG mode)
```

### Key Files

| File                                               | Purpose                               |
| -------------------------------------------------- | ------------------------------------- |
| `packages/analyzer/src/stages/fx.ts`               | FX extraction (parallel chunks)       |
| `packages/analyzer/src/stages/kx.ts`               | KX canonicalization (30 predicates)   |
| `packages/analyzer/src/stages/gx.ts`               | GX cross-document entity merge        |
| `packages/analyzer/src/pipeline/openTrack.ts`      | Open track orchestrator               |
| `packages/cli/src/commands/run.ts`                 | `iw run` CLI command                  |
| `packages/cli/src/commands/query.ts`               | `iw query` CLI command                |
| `packages/cli/src/commands/context.ts`             | `iw context` CLI command              |
| `packages/cli/src/impact/impactAnalyzer.ts`        | Impact analysis engine                |
| `packages/cli/src/doc-health/docHealthAnalyzer.ts` | Documentation health analyzer (Neo4j) |
| `packages/cli/src/doc-health/cariDocHealth.ts`     | Documentation health analyzer (CARI)  |

## MCP Tools

The MCP server exposes 19 tools for GitHub Copilot (6 KG + 13 CARI).

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

### CARI Tools (local SQLite, no Neo4j or LLM)

| Tool                     | Purpose                     | Key Parameters                 |
| ------------------------ | --------------------------- | ------------------------------ |
| `cari_retrieve`          | Ranked file retrieval       | `query`, `scope?`, `limit?`    |
| `cari_connections`       | Connection discovery + gaps | `entity`, `include?`, `limit?` |
| `cari_check`             | CI drift detection          | `changed`, `severity?`         |
| `cari_clones`            | Exact clone detection       | _(none)_                       |
| `cari_structural_clones` | Type 2 clone detection      | _(none)_                       |
| `cari_circular_imports`  | Import cycle detection      | _(none)_                       |
| `cari_unused_exports`    | Unused exported symbols     | `limit?`                       |
| `cari_hotspot_priority`  | High-churn low-doc files    | `limit?`                       |
| `cari_todos`             | TODO/FIXME/HACK/XXX list    | `kind?`, `limit?`              |
| `cari_module_coverage`   | Coverage % per directory    | _(none)_                       |
| `cari_orphaned_sections` | Ungrounded doc sections     | _(none)_                       |
| `cari_doc_completeness`  | Per-doc completeness        | _(none)_                       |
| `cari_cross_group_drift` | Cross-group conflicts       | _(none)_                       |

### CARI Programmatic Queries (via `@intentweave/index`)

All CARI query functions are available as direct API calls, MCP tools, and CLI subcommands:

| Function             | CLI Command                  | Purpose                                                  |
| -------------------- | ---------------------------- | -------------------------------------------------------- |
| `clones()`           | `iw index clones`            | Exact clone detection (identical body hash)              |
| `structuralClones()` | `iw index structural-clones` | Type 2 clones (same control flow, different identifiers) |
| `circularImports()`  | `iw index circular-imports`  | Import cycle detection                                   |
| `unusedExports()`    | `iw index unused-exports`    | Exported symbols never imported                          |
| `hotspotPriority()`  | `iw index hotspot-priority`  | High-churn low-doc files ranked by urgency               |
| `todos()`            | `iw index todos`             | TODO/FIXME/HACK/XXX inventory                            |
| `moduleCoverage()`   | `iw index module-coverage`   | Documentation coverage % per directory                   |
| `orphanedSections()` | `iw index orphaned-sections` | Doc sections with all-ungrounded mentions                |
| `docCompleteness()`  | `iw index doc-completeness`  | Per-doc completeness vs. referenced exports              |
| `crossGroupDrift()`  | `iw index cross-group-drift` | Entity coverage conflicts across doc groups              |

### Usage Patterns

- "Find files about auth" → `cari_retrieve` with query="authentication"
- "What's connected to AuthService?" → `cari_connections` with entity="AuthService"
- "I changed auth.ts — what docs need updating?" → `cari_check` with changed files
- "Find duplicate code" → `cari_clones`
- "Show circular dependencies" → `cari_circular_imports`
- "What TODOs exist?" → `cari_todos`
- "Which modules lack documentation?" → `cari_module_coverage`
- "What decisions were made?" → `kg_query` with NL question
- "Build context about authentication" → `kg_context` with topic
