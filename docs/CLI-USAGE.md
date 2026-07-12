# Using IntentWeave (`iw`) in Your Project

IntentWeave is a **semantic knowledge extraction platform** with two complementary products:

- **CARI Evidence Engine** — lightweight SQLite index built from AST, keywords, and git history.
  $0 cost, no LLM, no Neo4j. Powers ranked retrieval, architecture enforcement, and CI drift detection.
- **Intent Engine** — rule checking across three domains (structural / behavioral / documentary)
  backed by CARI. Express architectural intent in `rules.yaml`; enforce it in CI.

The **Insights Book** (`iw index export --book`) combines both into a single self-contained HTML deliverable.

---

## Installation

```bash
# Global install — adds `iw` to your PATH
npm install -g @intentweave/cli

# Verify
iw --version
iw --help
```

Or use `npx` without installing:

```bash
npx @intentweave/cli index build
npx @intentweave/cli intent check
```

### Development (clone and link)

```bash
git clone https://github.com/intentweave/intentweave.git
cd intentweave
pnpm install && pnpm build

# Dev wrapper (no build needed for changes)
./iw.sh index build

# Or link globally from the built CLI package
cd packages/cli && npm link
iw --help
```

### Requirements

| Requirement        | Version | Notes                                                             |
| ------------------ | ------- | ----------------------------------------------------------------- |
| **Node.js**        | ≥ 22.15 | `node -v` — requires Node.js built-in SQLite                      |
| **Git**            | any     | For co-change analysis (TCG stage)                                |
| **Neo4j**          | 5.x     | _Optional_ — only for `iw run`/`iw query`/`iw persist`            |
| **OpenAI API key** | —       | _Optional_ — only for `--provider openai` and `iw intent extract` |

CARINative uses no native C++ compilation. `npm install` works everywhere Node.js does.

> **CI note:** Use `node:22` as your CI base image. No other dependencies needed for CARI.

---

## Quick Start

```bash
cd /path/to/your/project
iw init

# 1. Build the CARI index (no API key needed)
iw index build

# 2. Check architectural rules
iw intent check

# 3. Open the Insights Book
iw index export --book -o insights.html
open insights.html
```

`iw init` also offers to scaffold an agent skill file (`SKILL.md`) so AI coding agents
(Claude Code, Copilot, Cursor) discover and use `iw` automatically:

```bash
iw init             # prompts interactively [Y/n] (auto-skipped in CI / non-TTY)
iw init --skill      # force-install, no prompt
iw init --skip-skill # force-skip, no prompt
```

Writes identical content to `.claude/skills/intentweave/SKILL.md` and
`.github/skills/intentweave/SKILL.md`. Canonical template:
`packages/cli/assets/skill/SKILL.md`.

---

## CARI Evidence Engine — `iw index`

### `iw index build`

Runs the full CARI pipeline: AST extraction → keyword extraction → co-occurrence →
git analysis → annotation → SQLite write.

```bash
iw index build                    # structured depth (default)
iw index build --depth full       # + body text with IDF filtering (+72% annotations)
iw index build --verbose          # show per-stage timing
iw index build --include "src/**" # only index specific directories
```

| Option             | Default        | Description                                               |
| ------------------ | -------------- | --------------------------------------------------------- |
| `--depth <mode>`   | `structured`   | `structured` (headings/bold/code) or `full` (+ body text) |
| `--output <path>`  | `.iw/index.db` | SQLite output path                                        |
| `--include <glob>` | —              | Only index files matching glob (repeatable)               |
| `--exclude <glob>` | —              | Skip files matching glob (repeatable)                     |
| `-v, --verbose`    | off            | Show per-stage progress and timing                        |

**Path alias resolution:** After building, `iw index build` automatically detects TypeScript path
aliases from `tsconfig.json` / `tsconfig.base.json` (`compilerOptions.paths`) and rewrites
aliased specifiers in the imports table. Manual overrides go in `.iw/config.yaml`:

```yaml
# .iw/config.yaml
aliases:
  "@site": "microsite" # Docusaurus — only needed if tsconfig doesn't define it
```

### `iw index retrieve`

Ranked file retrieval by topic or symbol name.

```bash
iw index retrieve "authentication"
iw index retrieve "AuthService" --scope code --limit 5
```

### `iw index connections`

Cross-layer connection discovery + gap detection.

```bash
iw index connections "AuthService"
```

### `iw index check`

CI drift detection — which docs reference code you just changed? Changed files are
positional arguments (there is no `--changed` flag on this subcommand).

```bash
iw index check src/auth/service.ts src/auth/jwt.ts

# CI integration
iw index check $(git diff --name-only origin/main...HEAD) --format github
```

### `iw index report`

Corpus-wide health dashboard: coverage, stale docs, hidden couplings, undocumented deps.

```bash
iw index report
```

### `iw index update`

Incremental re-index — only files whose content hash changed.

```bash
iw index update
```

### `iw index export`

```bash
iw index export --book                          # Insights Book (multi-chapter HTML)
iw index export --book -o insights.html         # custom output path
iw index export --html                          # D3 architecture report only
iw index export --focus "AuthService"           # focused Graphviz SVG
iw index export --focus "src/auth.ts" --hops 3 --max-nodes 30
```

### `iw index calls` / `iw index trace` (Phase 4 — Call Graph)

```bash
iw index calls                                   # all call edges
iw index calls --caller-file src/auth.ts         # calls from a file
iw index calls --callee-name validateToken       # all callers of a function
iw index trace --entry src/auth.ts              # forward call trace
iw index trace --entry src/auth.ts --direction backward  # who calls into auth.ts
iw index rule-coverage                          # packages with zero behavioral rules
```

### `iw index cypher` / `iw index schema` — Ad-Hoc Graph Queries

A second layer on top of the 30+ built-in queries: run your own read-only graph
queries directly against the CARI SQLite projection using CypherLite (a
zero-dependency Cypher-subset → SQL transpiler). No Neo4j, no LLM.

```bash
# See the full node/relationship schema + built-in query templates
iw index schema
iw index schema --format json

# Run a raw query
iw index cypher "MATCH (a:SYMBOL)-[:CALLS]->(b:SYMBOL) RETURN a.name, b.name LIMIT 10"

# Run a named built-in template with parameters
iw index cypher --list-templates
iw index cypher @:callers-of --param calleeName=validateToken
iw index cypher --template co-changed-with --param file=src/auth.ts --format json

# Debug the generated SQL
iw index cypher "MATCH (f:FILE)-[:HAS_TODO]->(t:TODO) RETURN f.name, t.name" --show-sql
```

Node labels: `FILE`, `SYMBOL`, `DOCSPAN`, `TODO`, `RATIONALE`, `SEMANTIC`. Relationship
types: `IMPORTS`, `DEFINES`, `CALLS`, `ANNOTATED_BY`, `HAS_TODO`, `HAS_RATIONALE`,
`SUMMARIZED_BY`, `CO_OCCURS`, `CO_CHANGES`. Run `iw index schema` for the full property
reference and the current list of built-in templates (`callers-of`, `callees-of`,
`docs-for-callees`, `co-changed-with`, `undocumented-hubs`, `symbol-docs`, `import-chain`).
This is distinct from `iw query --cypher` (KG/Neo4j, see below) — `iw index cypher` needs
only `.iw/index.db`.

| Option                 | Default        | Description                                              |
| ---------------------- | -------------- | --------------------------------------------------------- |
| `--db <path>`          | `.iw/index.db` | Path to CARI index                                         |
| `-p, --param <kv...>`  | —              | Query parameters as `key=value` pairs                      |
| `--template <id>`      | —              | Run a named built-in template (alternative to `@:` prefix) |
| `--list-templates`     | off            | List all available query templates and exit                |
| `-f, --format <fmt>`   | `table`        | `table`, `json`, or `csv`                                   |
| `--limit <n>`          | `50`           | Max rows to display                                         |
| `--show-sql`           | off            | Print the generated SQL before results                      |

### Analysis Subcommands

All available via `iw index <command>`, MCP tool `cari_*`, and the `@intentweave/index` API:

| Command               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `clones`              | Exact clone detection (identical body hash)        |
| `structural-clones`   | Type 2 clones (same control flow, different names) |
| `circular-imports`    | Import cycle detection                             |
| `unused-exports`      | Exported symbols never imported                    |
| `hotspot-priority`    | High-churn low-doc files ranked by urgency         |
| `todos`               | TODO/FIXME/HACK/XXX inventory                      |
| `module-coverage`     | Documentation coverage % per directory             |
| `orphaned-sections`   | Doc sections with all-ungrounded mentions          |
| `doc-completeness`    | Per-doc completeness vs. referenced exports        |
| `cross-group-drift`   | Cross-group entity coverage conflicts              |
| `mentions-of`         | Entity → doc mentions                              |
| `annotations-for`     | File → all annotations                             |
| `test-coverage`       | Test→source mapping + gaps                         |
| `hubs`                | God-node / hub analysis (degree centrality)        |
| `communities`         | Community detection                                |
| `surprises`           | Surprising connection ranking                      |
| `rationale`           | WHY/NOTE/IMPORTANT/DESIGN rationale inventory      |
| `terminology`         | Terminology inconsistency detection                |
| `dep-depth`           | Transitive import depth + fan-in/fan-out risk      |
| `boundary-violations` | Cross-package internal import detection            |
| `layers-infer`        | Auto-infer architectural layers from import graph  |
| `layers-check`        | Validate imports against layer configuration       |
| `focus`               | Focused architecture view around a target entity   |
| `naming-violations`   | Naming convention enforcement                      |
| `comment-code-ratio`  | Comment-to-code ratio per file                     |
| `deprecated-callers`  | Calls to `@deprecated` symbols                     |
| `internal-violations` | `@internal` / `_` boundary violations              |
| `type-assertions`     | `as any` and forced type-assertion inventory       |
| `rules-trend`         | ADR conformance trend over git history             |
| `skipped-files`       | Files excluded from CARI analysis                  |
| `cypher`              | Ad-hoc CypherLite graph query (see above)          |
| `schema`              | Graph projection schema + built-in query templates |

---

## Intent Engine — `iw intent`

### `iw intent check`

Check architectural rules across three domains.

```bash
iw intent check                              # all domains
iw intent check --domain structural          # import + AST rules only
iw intent check --domain behavioral          # Mermaid sequence/flow rules
iw intent check --domain documentary         # coverage + stale docs + terminology
iw intent check --domain all                 # explicit all-domains pass

# CI: changed files only, high severity
iw intent check --changed src/auth.ts --severity high --format json

# Regression gating
iw intent check --baseline .iw/baseline.json
```

| Option                 | Default          | Description                                      |
| ---------------------- | ---------------- | ------------------------------------------------ |
| `--domain <d>`         | `all`            | `structural`, `behavioral`, `documentary`, `all` |
| `--severity <level>`   | `info`           | Minimum: `info`, `medium`, `high`                |
| `--changed <files...>` | —                | Scope to files changed in PR/commit              |
| `--config <path>`      | `.iw/rules.yaml` | Path to rules config                             |
| `--baseline <path>`    | —                | Regression gating: fail only on new violations   |
| `--format <f>`         | `text`           | `text`, `json`, `github`                         |

### `iw intent extract`

LLM-powered extraction of architectural rules from ADR files.

```bash
iw intent extract docs/ADR-001.md --provider openai --output .iw/rules.yaml
iw intent extract docs/ --provider openai       # batch: all markdown in directory
```

| Option              | Default          | Description                                    |
| ------------------- | ---------------- | ---------------------------------------------- |
| `--provider <name>` | `smart-mock`     | `smart-mock`, `openai`                         |
| `--model <name>`    | `gpt-4o`         | LLM model                                      |
| `--output <path>`   | `.iw/rules.yaml` | Output path                                    |
| `--db <path>`       | `.iw/index.db`   | Index DB (injects real file paths into prompt) |

> The command injects up to 30 real file paths from the CARI index into the LLM prompt so
> generated `in:` glob patterns match your actual project layout (not `src/**`).

### `iw intent score` / `iw verify --score`

Composite living documentation score (A–F) across four dimensions.

```bash
iw intent score
iw verify --score -f json      # JSON output for CI integration
```

---

## MCP Server — `iw mcp`

Starts an MCP (Model Context Protocol) server over stdio for GitHub Copilot in VS Code.

```bash
iw mcp
```

**VS Code auto-discovery** — add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "intentweave": {
      "command": "npx",
      "args": ["@intentweave/cli", "mcp"]
    }
  }
}
```

The MCP server exposes **58 tools** — 6 KG tools and 52 CARI tools. See the
[MCP Integration guide](https://intentweave.org/docs/integrations/mcp/) for the full tool list.

---

## Configuration

### `.iw/config.yaml`

Optional per-workspace config. Created by `iw init`.

```yaml
version: 1
thresholds:
  documentary:
    coverage_min: 60 # flag modules with < 60% doc coverage (default: 50)
    completeness_min: 50 # flag docs with < 50% completeness (default: 40)
    mode: error # promote to CI-blocking (default: warn)
aliases:
  "@site": "microsite" # manual alias override (tsconfig.json paths are auto-detected)
```

### `.iw/rules.yaml`

Architectural rules for `iw intent check`. Created by `iw intent extract` or manually.

```yaml
version: 1
rules:
  - id: no-cross-package-imports
    domain: structural
    severity: high
    forbidden:
      - type: import_pattern
        pattern: "packages/*/src/!(index)*"
        in: "**/*.ts"
```

See the [Semantic Rules guide](https://intentweave.org/docs/cari/semantic-rules/) for all rule types.

---

## Environment Variables

| Variable         | Default                 | Description                                |
| ---------------- | ----------------------- | ------------------------------------------ |
| `NEO4J_URI`      | `bolt://localhost:7687` | Neo4j bolt URI (optional, for KG commands) |
| `NEO4J_USERNAME` | `neo4j`                 | Neo4j username                             |
| `NEO4J_PASSWORD` | _(required for KG)_     | Neo4j password                             |
| `NEO4J_DATABASE` | `neo4j`                 | Neo4j database name                        |
| `OPENAI_API_KEY` | _(optional)_            | Required for `--provider openai`           |
| `IW_SESSION`     | `default`               | Default session ID                         |

---

## Common Workflows

### CARI + Intent Engine (zero external dependencies)

```bash
cd my-project
iw init
iw index build
iw intent check
iw index export --book -o insights.html
open insights.html
```

### CI drift check

```bash
# .github/workflows/ci.yml
- name: IntentWeave drift check
  run: |
    npx @intentweave/cli index build
    npx @intentweave/cli intent check --format github
```

### Using with GitHub Copilot (MCP)

1. Add `.vscode/mcp.json` (see above)
2. Restart VS Code
3. Ask Copilot: `Find files related to authentication` or `Check if docs are stale for auth.ts`

### Architecture enforcement

```bash
# Extract rules from ADRs
iw intent extract docs/ADR-*.md --provider openai --output .iw/rules.yaml

# Check conformance
iw intent check --domain structural

# View in Insights Book
iw index export --book -o insights.html
```

---

## Optional: Knowledge Graph (`iw run` / `iw query`)

The following commands require Neo4j and an LLM API key. They power deep semantic extraction,
NL queries over the knowledge graph, and impact analysis. These are optional and complementary
to the CARI Evidence Engine.

### `iw run` — Extract and build the knowledge graph

```bash
export OPENAI_API_KEY=sk-...
iw run docs/**/*.md --track open --provider openai -i -v
```

| Option                | Default      | Description                            |
| --------------------- | ------------ | -------------------------------------- |
| `-t, --track <track>` | `main`       | Pipeline track: `main`, `open`, `both` |
| `--provider <name>`   | `smart-mock` | LLM provider: `smart-mock`, `openai`   |
| `-i, --incremental`   | off          | SHA-256 content-addressed cache        |
| `--persist`           | off          | Auto-persist to Neo4j after run        |
| `-v, --verbose`       | off          | Show per-stage progress                |

### `iw persist` — Write to Neo4j

```bash
export NEO4J_PASSWORD=intentweave
iw persist --latest -v
```

### `iw query` — Query the knowledge graph

```bash
iw query "What are the main components?" -s my-project
iw query --cypher "MATCH (n:Canon:Entity) RETURN n.name LIMIT 20"
```

### `iw context` — Build RAG context

```bash
iw context "authentication" -s my-project
iw context --entity AuthService --hops 2 -s my-project
```

### `iw impact` — Semantic impact analysis

```bash
iw impact src/auth.ts -s my-project
```

---

## Troubleshooting

### Scope warnings in `iw intent check`

If you see `⚠ scope warning: rule-id — in: src/** matched 0 indexed files`, the rule's `in:`
glob doesn't match any indexed files. Re-run `iw intent extract` with `--db` pointing at your
index so the LLM sees real file paths.

### tsconfig alias false positives

If cross-package rules show false positives for path aliases (e.g. `@app/`, `@site/`), check
that your `tsconfig.json` has `compilerOptions.paths` defined — CARI auto-detects these.
For non-tsconfig aliases (Docusaurus, Webpack), add them to `.iw/config.yaml` under `aliases:`.

### "Neo4j password required"

This only affects the optional KG commands (`iw run`, `iw query`, `iw persist`).
For CARI-only usage no Neo4j is needed.

```bash
export NEO4J_PASSWORD=intentweave
```

### MCP tools not visible in Copilot

1. Ensure `.vscode/mcp.json` exists with the correct server config
2. Test the server starts without errors: `iw mcp`
3. Restart VS Code after adding or modifying `mcp.json`

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

| Requirement        | Version | Notes                                                |
| ------------------ | ------- | ---------------------------------------------------- |
| **Node.js**        | ≥ 22.15 | `node -v` — requires Node 22.15+ for built-in SQLite |
| **Neo4j**          | 5.x     | Only for `query`, `context`, `impact`, `persist`     |
| **OpenAI API key** | —       | Only for `--provider openai` and NL queries          |
| **Docker**         | —       | Easiest way to run Neo4j locally                     |

> **CI / Docker note:** IntentWeave uses Node.js's built-in `node:sqlite` module
> (available since Node 22.15), which requires **no native compilation** and no extra
> build tools. Use `node:22` or `node:lts` as your CI base image:
>
> ```yaml
> # .github/workflows/ci.yml
> - uses: actions/setup-node@v4
>   with:
>     node-version: "22"
> ```

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

### `iw intent living` — Documentation freshness

```bash
iw intent living [files...] [options]
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
iw intent living
iw intent living -v -f json -o report.json

# Lightweight preflight (no index needed)
iw intent living --lite docs/

# Full KG mode (requires Neo4j)
iw intent living --neo4j -s my-project
iw intent living --neo4j -s my-project --only doc-code,deps
```

### `iw hook` — Git hooks integration

Keep the CARI index current automatically without manual `iw index build` calls.

```bash
# Install post-commit and post-checkout hooks
iw hook install

# Install with verbose output
iw hook install --verbose

# Remove iw-managed hook sections (leaves any existing hook content intact)
iw hook uninstall

# Check installation status
iw hook status
```

The installed hooks run `iw index update` after every commit and branch switch.
If an existing hook is already present the iw block is appended rather than
overwriting it. `iw hook uninstall` only removes the iw section, leaving any
other hook logic untouched.

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

| Option              | Default        | Description                              |
| ------------------- | -------------- | ---------------------------------------- |
| `--db <path>`       | `.iw/index.db` | Path to the SQLite index                 |
| `--exclude <globs>` | —              | Comma-separated glob patterns to exclude |
| `--debounce <ms>`   | `500`          | Debounce window in milliseconds          |
| `-v`                | off            | Show cycle details                       |

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
iw intent living -s my-project
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
