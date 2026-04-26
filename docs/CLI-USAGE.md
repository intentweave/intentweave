# Using IntentWeave (`iw`) in Your Project

IntentWeave builds queryable knowledge graphs from your documents and code.
This guide shows how to install, configure, and use the `iw` CLI in any
development project.

---

## Installation

### Option A: Install from npm (recommended)

```bash
# Global install — adds `iw` to your PATH
npm install -g @intentweave/cli

# Verify
iw --version
iw --help
```

Or use `npx` without installing globally:

```bash
npx @intentweave/cli run docs/*.md --track open -i -v
npx @intentweave/cli query "What are the main components?"
```

### Option B: Clone and link (development)

```bash
git clone https://github.com/intentweave/intentweave.git
cd intentweave
pnpm install && pnpm build

# Option 1: Use the dev wrapper (no build needed for changes)
./iw.sh run docs/*.md --track open -i -v

# Option 2: Link globally from the built CLI package
cd packages/cli && npm link
iw --help
```

### Requirements

| Requirement        | Version | Notes                                            |
| ------------------ | ------- | ------------------------------------------------ |
| **Node.js**        | ≥ 20    | `node -v`                                        |
| **Neo4j**          | 5.x     | Only for `query`, `context`, `impact`, `persist` |
| **OpenAI API key** | —       | Only for `--provider openai` and NL queries      |
| **Docker**         | —       | Easiest way to run Neo4j locally                 |

---

## Quick Start

### 1. Initialize a workspace

```bash
cd /path/to/your/project
iw init
```

Creates a `.iw/` directory with config, cache, and run storage.

### 2. Run the extraction pipeline

```bash
# With smart-mock provider (no API key needed — fast, deterministic, for testing)
iw run docs/*.md --track open -i -v

# With OpenAI (real extraction)
export OPENAI_API_KEY=sk-...
iw run docs/*.md --track open --provider openai -i -v
```

**What happens:**

1. **IN** — Chunks your documents (semantic markdown splitting, ~16k chars/chunk)
2. **FX** — LLM extracts raw entity-relationship triples per chunk
3. **KX** — Canonicalizes entities and predicates into a consistent schema
4. **GX** — Merges entities across documents (deduplication)

The `-i` flag enables incremental caching — unchanged files are skipped on re-runs.

**Output is stored in:**

```
.iw/runs/<run-id>/
├── open-track/
│   ├── fx-<artifact>.json   # Raw triples per file
│   ├── kx-<artifact>.json   # Canonical triples per file
│   └── kx-results.json      # Merged output
└── run.meta.json
```

### 3. Persist to Neo4j

```bash
# Start Neo4j (Docker)
docker run -d --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/intentweave \
  neo4j:5

# Persist the latest run
export NEO4J_PASSWORD=intentweave
iw persist --latest -v
```

Delta persist: on subsequent runs, only changes are written (adds, updates, removals).

### 4. Query your knowledge graph

```bash
# Natural language (LLM translates to Cypher)
iw query "What are the main components?" -s my-project

# Raw Cypher — no LLM needed
iw query --cypher "MATCH (n:Canon:Entity) RETURN n.name, n.type LIMIT 20"

# Output as JSON
iw query "What decisions were made?" -f json -o decisions.json
```

---

## Command Reference

### `iw run` — Extract knowledge

```bash
iw run [files...] [options]
```

| Option                 | Default       | Description                            |
| ---------------------- | ------------- | -------------------------------------- |
| `-t, --track <track>`  | `main`        | Pipeline track: `main`, `open`, `both` |
| `--provider <name>`    | `smart-mock`  | LLM provider: `smart-mock`, `openai`   |
| `--model <name>`       | `gpt-4o-mini` | Model for OpenAI provider              |
| `-i, --incremental`    | off           | SHA-256 content-addressed cache        |
| `--persist`            | off           | Auto-persist to Neo4j after run        |
| `--force`              | off           | Ignore cache, recompute everything     |
| `-p, --profile <name>` | `standard`    | Extraction profile                     |
| `--concurrency <n>`    | `5`           | Parallel LLM calls                     |
| `--from-fx <source>`   | —             | Skip FX, reuse cached FX output        |
| `-v, --verbose`        | off           | Show per-stage progress                |

**Examples:**

```bash
# Analyze all markdown docs
iw run docs/**/*.md --track open --provider openai -i -v

# Analyze Swift source code
iw run Sources/**/*.swift --track open --provider openai -i -v

# Analyze everything and persist
iw run . --track open --provider openai -i --persist -v

# Re-run only KX on existing FX results
iw run docs/*.md --track open --from-fx run-2026-03-09-abc12345
```

### `iw query` — Query the knowledge graph

```bash
iw query <question> [options]
iw query --cypher <cypher> [options]
```

| Option          | Default | Description                    |
| --------------- | ------- | ------------------------------ |
| `-s, --session` | —       | Neo4j session scope            |
| `-f, --format`  | `table` | Output format: `table`, `json` |
| `-o, --output`  | —       | Write output to file           |
| `-v, --verbose` | off     | Show generated Cypher          |

### `iw context` — Build RAG context

```bash
iw context <topic> [options]
iw context -e <entity> [options]
iw context --all [options]
```

| Option          | Default | Description                         |
| --------------- | ------- | ----------------------------------- |
| `-s, --session` | —       | Neo4j session scope                 |
| `-e, --entity`  | —       | Seed from specific entity           |
| `--hops <n>`    | `2`     | Expansion depth from seed entity    |
| `--all`         | off     | Dump all entities and relationships |
| `--code-refs`   | off     | Include source code references      |
| `-f, --format`  | `text`  | Output: `text`, `json`              |
| `-o, --output`  | —       | Write output to file                |

### `iw impact` — Semantic impact analysis

```bash
iw impact <files...> [options]
```

Traces what entities, decisions, and risks are affected when you change a file.

| Option          | Default | Description         |
| --------------- | ------- | ------------------- |
| `-s, --session` | —       | Neo4j session scope |
| `--hops <n>`    | `2`     | Ripple depth        |
| `-f, --format`  | `text`  | Output format       |
| `-o, --output`  | —       | Write to file       |

### `iw doc-health` — Documentation freshness

```bash
iw doc-health [files...] [options]
```

Detects stale references, structural drift, contradictions, and undocumented entities.
Three modes (least → most infrastructure):

1. `--lite` — Zero-infra keyword scan (regex grounding, no index)
2. _(default)_ — CARI-backed analysis from `.iw/index.db` (no Neo4j)
3. `--neo4j` — Full KG-based analysis (requires Neo4j + persisted KWG)

| Option          | Default        | Description                                        |
| --------------- | -------------- | -------------------------------------------------- |
| `--db <path>`   | `.iw/index.db` | Path to CARI index (default mode)                  |
| `--neo4j`       | off            | Full KG mode — requires Neo4j + persisted KWG      |
| `--neo4j-uri`   | —              | Neo4j connection URI (implies `--neo4j`)           |
| `-s, --session` | —              | Session ID (required for `--neo4j` mode only)      |
| `--only`        | all            | Specific detectors: doc-code,temporal,deps,doc-doc |
| `--lite`        | off            | Lightweight keyword-only mode — no index needed    |
| `-f, --format`  | `markdown`     | Output format: markdown \| json                    |
| `-o, --output`  | —              | Write to file                                      |
| `-v, --verbose` | off            | Show progress on stderr                            |

```bash
# Default: CARI mode (reads .iw/index.db, no Neo4j)
iw doc-health
iw doc-health -v -f json -o report.json

# Lightweight preflight (no index needed)
iw doc-health --lite docs/

# Full KG mode (requires Neo4j)
iw doc-health --neo4j -s my-project
iw doc-health --neo4j -s my-project --only doc-code,deps
```

### `iw persist` — Write to Neo4j

```bash
iw persist [run-id] [options]
```

| Option          | Default | Description                       |
| --------------- | ------- | --------------------------------- |
| `--latest`      | off     | Persist the most recent run       |
| `--file <path>` | —       | Persist from a specific JSON file |
| `-v, --verbose` | off     | Show persistence details          |

### `iw xlink` — Cross-layer code linking

```bash
iw xlink [directory] [options]
```

Links semantic entities (from the knowledge graph) to actual source code symbols
found via AST extraction.

| Option          | Default | Description               |
| --------------- | ------- | ------------------------- |
| `-s, --session` | —       | Neo4j session scope       |
| `--persist`     | off     | Write code links to Neo4j |
| `-v, --verbose` | off     | Detailed output           |

### `iw mcp` — MCP server for Copilot

```bash
iw mcp [options]
```

Starts an MCP (Model Context Protocol) server over stdio for use with
GitHub Copilot in VS Code.

| Option          | Default | Description           |
| --------------- | ------- | --------------------- |
| `-s, --session` | —       | Default session scope |
| `-v, --verbose` | off     | Log tool invocations  |

**Exposed tools:**

| Tool            | Purpose                          |
| --------------- | -------------------------------- |
| `kg_query`      | Natural language or Cypher query |
| `kg_context`    | Build RAG context from graph     |
| `kg_entities`   | List/search entities             |
| `kg_impact`     | Semantic impact analysis         |
| `kg_doc_health` | Documentation freshness          |
| `kg_schema`     | Graph schema description         |

**CARI tools** (local SQLite, no Neo4j or LLM needed):

| Tool                     | Purpose                                 |
| ------------------------ | --------------------------------------- |
| `cari_retrieve`          | Ranked file retrieval by topic          |
| `cari_connections`       | Cross-layer connections + gap detection |
| `cari_check`             | CI drift detection for changed files    |
| `cari_clones`            | Exact code clone detection              |
| `cari_structural_clones` | Type 2 clone detection                  |
| `cari_circular_imports`  | Import cycle detection                  |
| `cari_unused_exports`    | Unused exported symbols                 |
| `cari_hotspot_priority`  | High-churn low-doc file ranking         |
| `cari_todos`             | TODO/FIXME/HACK/XXX inventory           |
| `cari_module_coverage`   | Documentation coverage per directory    |
| `cari_orphaned_sections` | Doc sections with ungrounded mentions   |
| `cari_doc_completeness`  | Per-doc completeness scoring            |
| `cari_cross_group_drift` | Cross-group entity coverage conflicts   |

**VS Code auto-discovery:** Add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "intentweave-kg": {
      "command": "npx",
      "args": ["@intentweave/cli", "mcp", "--session", "my-project", "-v"]
    }
  }
}
```

### `iw index` — Code-Aware Retrieval Index (CARI)

Build and query a lightweight SQLite index from your code, docs, and git history.
No LLM calls, no Neo4j, no external services.

#### `iw index build`

```bash
iw index build [options]
```

Runs the full CARI pipeline: AST extraction → keyword extraction → co-occurrence →
git analysis → annotation → SQLite persistence.

| Option             | Default      | Description                                                        |
| ------------------ | ------------ | ------------------------------------------------------------------ |
| `--depth <mode>`   | `structured` | `structured` (headings/bold/code) or `full` (+ body text with IDF) |
| `--include <glob>` | —            | Only index files matching glob                                     |
| `--exclude <glob>` | —            | Skip files matching glob                                           |
| `-v, --verbose`    | off          | Show per-stage progress                                            |

**Examples:**

```bash
# Default structured build (fast, precise)
iw index build

# Full-depth build (more annotations, IDF noise filtering)
iw index build --depth full

# Only index specific directories
iw index build --include "src/**" --include "docs/**"
```

**Output:** `.iw/index.db` (SQLite database)

#### `iw index retrieve`

```bash
iw index retrieve <query> [options]
```

Ranked file retrieval by topic or symbol name. Combines annotation relevance,
symbol matching, co-occurrence boost, and co-change signals.

| Option           | Default | Description              |
| ---------------- | ------- | ------------------------ |
| `--limit <n>`    | `10`    | Maximum results          |
| `--scope <type>` | `all`   | `code`, `docs`, or `all` |

**Example:**

```bash
iw index retrieve "authentication"

# 1. src/auth/service.ts     (0.95) — 12 annotations, AuthService class
# 2. docs/auth.md            (0.92) — 18 mentions, primary auth doc
# 3. src/auth/jwt.ts         (0.78) — co-occurs with AuthService
```

#### `iw index connections`

```bash
iw index connections <entity> [options]
```

Cross-layer connection discovery. Shows co-mentions in docs, co-changes in git,
structural links in code — and **gaps** where signals disagree.

| Option             | Default | Description                                    |
| ------------------ | ------- | ---------------------------------------------- |
| `--limit <n>`      | `15`    | Maximum connections                            |
| `--include <type>` | all     | Filter: `doc_cooc`, `co_change`, `code_import` |

**Example:**

```bash
iw index connections "AuthService"

# Co-mentioned in docs:
#   JwtValidator     (0.72, in 4 docs)
#   RateLimiter      (0.45, in 2 docs)
#
# Co-changes in git:
#   src/auth/jwt.ts  (jaccard: 0.68, 15 commits)
#
# ⚠ Gaps:
#   RateLimiter co-mentioned but NO code dependency → hidden coupling?
```

#### `iw index check`

```bash
iw index check [options]
```

CI drift detection. Identifies docs that reference changed code and may need updating.

| Option                 | Default | Description                            |
| ---------------------- | ------- | -------------------------------------- |
| `--changed <files...>` | —       | Files changed in PR/commit             |
| `--severity <level>`   | `info`  | Minimum: `info`, `warning`, `critical` |
| `-f, --format`         | `text`  | Output: `text`, `json`, `github`       |

**Example:**

```bash
# Check drift for changed files
iw index check --changed src/auth/service.ts src/auth/jwt.ts

# CI integration (GitHub Actions)
iw index check --changed $(git diff --name-only origin/main...HEAD) --format github
```

#### `iw index report`

```bash
iw index report
```

Corpus-wide health dashboard. No arguments needed.

**Output includes:**

- Documentation coverage (% of exported symbols mentioned in docs)
- Stale documents (docs referencing recently-changed code)
- Hidden couplings (co-mentioned in docs but no code dependency)
- Undocumented dependencies (code imports with no doc mention)

#### `iw index update`

```bash
iw index update [options]
```

Incremental index update. Re-indexes only files whose content hash has changed.

| Option | Default | Description       |
| ------ | ------- | ----------------- |
| `-v`   | off     | Show what changed |

Typical update time: < 1 second for small changes.

#### `iw index watch`

```bash
iw index watch [options]
```

Continuously watches the workspace for file changes and incrementally re-indexes on
every save. Keeps `.iw/index.db` up to date without manual intervention.

| Option              | Default      | Description                        |
| ------------------- | ------------ | ---------------------------------- |
| `--db <path>`       | `.iw/index.db` | Path to the SQLite index           |
| `--exclude <globs>` | —            | Comma-separated glob patterns to exclude |
| `--debounce <ms>`   | `500`        | Debounce window in milliseconds    |
| `-v`                | off          | Show cycle details                 |

Run in a background terminal while developing:

```bash
iw index watch -v
```

Press `Ctrl+C` to stop. The watcher ignores `node_modules`, `.git`, `dist`, `build`,
`coverage`, `.iw`, and minified/map files automatically.

#### CARI CLI Subcommands & Programmatic API

All CARI analysis queries are available as CLI subcommands (`iw index <command>`) and
via the `@intentweave/index` programmatic API:

```bash
# CLI usage
iw index clones                    # exact clone detection
iw index structural-clones         # type 2 clone detection
iw index circular-imports          # import cycle detection
iw index unused-exports            # unused exported symbols
iw index hotspot-priority          # high-churn low-doc files
iw index todos                     # TODO/FIXME/HACK/XXX inventory
iw index module-coverage           # documentation coverage per dir
iw index orphaned-sections         # ungrounded doc sections
iw index doc-completeness          # per-doc completeness scoring
iw index cross-group-drift         # cross-group entity conflicts
```

Programmatic usage:

```typescript
import { openIndex } from "@intentweave/index";
const db = openIndex(".iw/index.db");
```

| CLI Command                  | API Function            | Purpose                                                  |
| ---------------------------- | ----------------------- | -------------------------------------------------------- |
| `iw index clones`            | `db.clones()`           | Exact clone detection (identical body hash)              |
| `iw index structural-clones` | `db.structuralClones()` | Type 2 clones (same control flow, different identifiers) |
| `iw index circular-imports`  | `db.circularImports()`  | Import cycle detection                                   |
| `iw index unused-exports`    | `db.unusedExports()`    | Exported symbols never imported                          |
| `iw index hotspot-priority`  | `db.hotspotPriority()`  | High-churn low-doc files ranked by urgency               |
| `iw index todos`             | `db.todos()`            | TODO/FIXME/HACK/XXX inventory                            |
| `iw index module-coverage`   | `db.moduleCoverage()`   | Documentation coverage % per directory                   |
| `iw index orphaned-sections` | `db.orphanedSections()` | Doc sections with all-ungrounded mentions                |
| `iw index doc-completeness`  | `db.docCompleteness()`  | Per-doc completeness vs. referenced exports              |
| `iw index cross-group-drift` | `db.crossGroupDrift()`  | Cross-group entity coverage conflicts                    |

---

## Environment Variables

| Variable         | Default                 | Description                                     |
| ---------------- | ----------------------- | ----------------------------------------------- |
| `NEO4J_URI`      | `bolt://localhost:7687` | Neo4j bolt URI                                  |
| `NEO4J_USERNAME` | `neo4j`                 | Neo4j username                                  |
| `NEO4J_PASSWORD` | _(required for Neo4j)_  | Neo4j password                                  |
| `NEO4J_DATABASE` | `neo4j`                 | Neo4j database name                             |
| `IW_SESSION`     | `default`               | Default session ID                              |
| `OPENAI_API_KEY` | _(optional)_            | Required for `--provider openai` and NL queries |
| `IW_LLM_MODEL`   | `gpt-4o-mini`           | LLM model for NL queries                        |

---

## Supported Languages

IntentWeave works on two layers:

### Semantic layer (open track)

Works on **any text file** — markdown, Swift, TypeScript, Python, etc.
The LLM reads the content and extracts entities and relationships regardless
of language. This is the primary extraction mode.

### Structural layer (AX stage)

Uses tree-sitter AST parsing for precise code symbol extraction:

| Language              | Parser                   | Symbols extracted                                                              |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| TypeScript/JavaScript | `tree-sitter-typescript` | classes, functions, interfaces, types, enums                                   |
| Swift                 | `tree-sitter-swift`      | structs, classes, protocols, enums, extensions, functions, methods, properties |

The cross-layer linker (`iw xlink`) connects semantic entities from the knowledge
graph to structural code symbols, enabling code-reference-enriched context.

---

## Common Workflows

### CARI — Zero-cost index (recommended starting point)

```bash
cd my-project
iw init

# Build the index (no API keys needed)
iw index build

# Find relevant files
iw index retrieve "authentication"

# Explore connections
iw index connections "UserService"

# Check doc freshness
iw index report

# Add to CI (exit code 0 = clean, 1 = drift found)
iw index check --changed $(git diff --name-only origin/main...HEAD)
```

### First-time KG project setup

```bash
cd my-project
iw init

# Analyze your docs (requires LLM + Neo4j)
export OPENAI_API_KEY=sk-...
iw run docs/**/*.md --track open --provider openai -i -v

# Persist to Neo4j
export NEO4J_PASSWORD=intentweave
iw persist --latest -v

# Query
iw query "What are the main components?" -s my-project
```

### Daily iteration

```bash
# Edit docs/code, then re-run (cache skips unchanged files — seconds, not minutes)
iw run docs/**/*.md --track open --provider openai -i --persist -v

# Before changing a file — check what's affected
iw impact src/auth.ts -s my-project

# Check if docs are stale
iw doc-health -s my-project
```

### Swift project analysis

```bash
cd my-swift-project
iw init

# Semantic extraction on Swift source
iw run Sources/**/*.swift --track open --provider openai -i -v

# Structural extraction + cross-layer linking
iw xlink . -s my-swift-project --persist -v

# Persist and query
iw persist --latest -v
iw query "What are the main view models?" -s my-swift-project
```

### Using with GitHub Copilot (MCP)

```bash
# 1. Start the MCP server
iw mcp --session my-project -v

# 2. Or configure VS Code auto-discovery in .vscode/mcp.json:
# {
#   "servers": {
#     "intentweave-kg": {
#       "command": "npx",
#       "args": ["@intentweave/cli", "mcp", "--session", "my-project", "-v"]
#     }
#   }
# }

# Now Copilot can use your knowledge graph as context!
# Try: "@workspace What decisions were made about the database?"
```

### CI integration

```bash
# In your CI pipeline — check doc freshness
npx @intentweave/cli doc-health -s my-project -f json -o health.json

# Impact analysis on changed files
npx @intentweave/cli impact $(git diff --name-only HEAD~1) -s my-project -f json
```

---

## Troubleshooting

### "Neo4j password required"

```bash
export NEO4J_PASSWORD=intentweave
```

### Cache not working

Ensure the `-i` flag is set. Check `.iw/cache/open-track/` for cached artifacts.
Use `--force` to bypass the cache for a full recompute.

### "No entities found" after persist

Verify the session ID matches:

```bash
iw query --cypher "MATCH (n:Canon) RETURN count(n)" -s my-project
```

### MCP tools not visible in Copilot

1. Ensure `.vscode/mcp.json` exists with the correct server config
2. Test the server starts without errors: `iw mcp -s my-project -v`
3. Restart VS Code after adding/modifying `mcp.json`

### tree-sitter compilation errors

The packages `@intentweave/ast-extractor` and `@intentweave/swift-parser` use
native tree-sitter bindings that require a C++ compiler. On most systems this
works automatically, but you may need:

- **macOS:** `xcode-select --install`
- **Ubuntu/Debian:** `sudo apt install build-essential`
- **Windows:** Visual Studio Build Tools or `npm install -g windows-build-tools`
