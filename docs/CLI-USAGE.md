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
| **Neo4j**          | 5.x     | _Optional_ — only for MCP `kg_*` tools / `iw doc-health --neo4j`  |
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

### `iw index watch`

Continuously watches the workspace for file changes and incrementally re-indexes on
every save, keeping `.iw/index.db` up to date without manual `iw index update` calls.

```bash
iw index watch                       # watch the whole workspace
iw index watch src/ docs/            # scope to specific directories
iw index watch --debounce 1000 -v    # slower debounce, verbose output
```

| Option                  | Default        | Description                        |
| ----------------------- | -------------- | ---------------------------------- |
| `--db <path>`           | `.iw/index.db` | Path to the SQLite index           |
| `--exclude <patterns…>` | —              | Exclude files matching these globs |
| `--debounce <ms>`       | `500`          | Debounce delay in ms               |
| `-v, --verbose`         | off            | Verbose output                     |

Press `Ctrl+C` to stop. Ignores `node_modules`, `.git`, `dist`, `build`, `coverage`,
`.iw`, and minified/map files automatically.

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
This queries the local CARI SQLite projection only — no Neo4j, no LLM. For the
separate LLM-powered Knowledge Graph (Neo4j), use the `kg_query` MCP tool instead.

| Option                | Default        | Description                                                |
| --------------------- | -------------- | ---------------------------------------------------------- |
| `--db <path>`         | `.iw/index.db` | Path to CARI index                                         |
| `-p, --param <kv...>` | —              | Query parameters as `key=value` pairs                      |
| `--template <id>`     | —              | Run a named built-in template (alternative to `@:` prefix) |
| `--list-templates`    | off            | List all available query templates and exit                |
| `-f, --format <fmt>`  | `table`        | `table`, `json`, or `csv`                                  |
| `--limit <n>`         | `50`           | Max rows to display                                        |
| `--show-sql`          | off            | Print the generated SQL before results                     |

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

# CI: changed files only, high severity (comma-separated, no spaces)
iw intent check --changed src/auth.ts,src/auth/jwt.ts --severity high --format json

# Regression gating
iw intent check --baseline .iw/baseline.json
```

| Option               | Default          | Description                                       |
| -------------------- | ---------------- | ------------------------------------------------- |
| `--domain <d>`       | `all`            | `structural`, `behavioral`, `documentary`, `all`  |
| `--severity <level>` | `info`           | Minimum: `info`, `medium`, `high`                 |
| `--changed <files>`  | —                | Comma-separated list of changed files (no spaces) |
| `--config <path>`    | `.iw/rules.yaml` | Path to rules config                              |
| `--baseline <path>`  | —                | Regression gating: fail only on new violations    |
| `--format <f>`       | `text`           | `text`, `json`, `github`                          |

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
sessionLog: true # opt-in local session log (default: false, see below)
```

#### `sessionLog` — local, transparent query log (opt-in)

When `sessionLog: true`, confidence/score-bearing CARI queries append one JSON
line per invocation to `.iw/sessions/<YYYY-MM-DD>.jsonl` — one file per UTC
calendar day. Nothing is ever transmitted anywhere; this is purely a local,
human-readable record meant to be reviewed by a maintainer later, not an
automatic runtime adaptation.

Covered on both the CLI and MCP surfaces: `iw index retrieve` / `cari_retrieve`,
`iw index connections` / `cari_connections`, `iw index check` / `cari_check`,
`iw index arch-check` / `cari_arch_diff`, `iw verify` / `cari_verify`,
`iw verify --consistency` / `cari_consistency`, `iw verify --score` /
`cari_living_score`.

Each line looks like:

```json
{
  "ts": "2026-07-14T10:15:30.000Z",
  "surface": "cli",
  "tool": "index retrieve",
  "sessionId": "default",
  "confidence": 0.87,
  "resultCount": 5
}
```

Default is `false` (disabled) — no `.iw/sessions/` directory is created unless
you opt in. `.iw/` is already git-ignored, so log files never get committed.

#### `indexAllFiles` — index non-binary files beyond md/mdx/txt/rst (opt-in)

By default, `iw index build` only discovers markdown (`.md`/`.mdx`) and plain
text (`.txt`/`.rst`) files for keyword/annotation indexing (AX code-symbol
extraction is separate and unaffected by this setting). Set `indexAllFiles: true`
to widen discovery to any non-binary file — config (`.json`/`.yaml`/`.toml`),
data, and source files in languages without an AX plugin — so their content
becomes searchable/annotatable as plain text.

```yaml
# .iw/config.yaml
indexAllFiles: true
```

Binary files are still excluded:

- A built-in denylist of known-binary extensions (images, fonts, archives,
  executables/libraries, media, compiled artifacts, binary document formats,
  databases) is always skipped, even with `indexAllFiles: true`.
- Files with an unrecognized extension are sniffed for a NUL byte in the
  first 8 KB (the same heuristic git/ripgrep use) and skipped if found.
- Newly-included files larger than `--max-file-size` (default 256 KiB) are
  skipped, to avoid indexing huge lockfiles or data dumps.

Note: the Rust native build acceleration (`cari-build`) does not yet support
`indexAllFiles` — when enabled, `iw index build` automatically falls back to
the TypeScript pipeline (same fallback behavior as `--include`/`--exclude`).

### Claims discovery and optional bindings

`iw claims check` extracts provisional claims directly from syntactically strong
scalar literal bindings in TypeScript and JavaScript: exported literals,
top-level constants, parameter/destructuring defaults, and directly annotated
defaults. Ordinary local variables, loop counters, accumulators, assignments,
tests, fixtures, generated output, dependencies, and build directories are not
materialized as claims by the default scan.

Explicit defaults become `CLM-DEFAULT`; other exported or top-level constants
become `CLM-LITERAL`. A directly attached JSDoc default is captured as separate
corroborating or contradicting evidence.

No binding manifest or scope registry is required for this unscoped discovery:

```bash
iw index build
iw claims check
iw claims explain
```

Automatically discovered code claims use provisional code-based parameter
identities and `r1-discovery` provenance. IntentWeave does not guess that
similarly named code, configuration, and prose values represent the same domain
parameter.

Add `intentweave.bindings.yaml` only when you want to promote or correlate a
candidate with a canonical parameter key, documentation assertion, or scoped
configuration. Scoped checks additionally require `config/environments.yaml`
and the corresponding `config/<scope>.yaml` files.

```yaml
# intentweave.bindings.yaml
parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/session.ts
        export: SESSION_TIMEOUT
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: production-override
            target: effective
            scope: production
            pattern: '^The production override is (?<value>\d+) seconds\.$'
```

```yaml
# config/environments.yaml
environments:
  - name: production
    capabilities: [session-runtime]
```

```yaml
# config/production.yaml
session:
  timeout: 3600
```

With optional bindings in place, evaluate the correlated scope and inspect the
evidence chain:

```bash
iw claims check --scope production
iw claims explain
iw claims explain --claim session.timeout --type CLM-DEFAULT
iw claims check --scope production --since origin/main
iw claims check --refresh
```

`--claim` accepts either the stable `claim:<sha256>` identity or a canonical
parameter key. A parameter can have several claims, so use `--type` and, for
scoped claims, `--scope` when selecting exactly one claim for review.

`--refresh` reconciles the current automatic discovery result with previously
current provisional `code:*` claims. Claims that no longer pass discovery are
retired from the current assessment lifecycle without deleting their history.
An existing review is reopened with `continuity-broken`; explicitly bound
parameter claims are not retired by this cleanup.

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

### CI caching — delta indexing instead of a full rebuild {#ci-caching}

`iw index build` re-parses the whole workspace every run. For faster CI, cache
`.iw/index.db` across runs and use `iw index update` — a content-hash-based
incremental update — to re-index only what changed instead.

```yaml
# .github/workflows/ci.yml
- uses: actions/checkout@v4
  with:
    fetch-depth: 100 # iw index update's TCG (churn/hotspot) stage reads recent git log;
    # a shallow depth (or the default depth-1 checkout) still works but with weaker history

- uses: actions/cache@v4
  with:
    path: .iw/index.db
    # Include the CLI version in the key: there is no automatic schema
    # migration on `iw index update`, so a stale-schema cache from an
    # older/newer CLI version should trigger a fresh full build, not reuse.
    key: iw-index-${{ runner.os }}-${{ steps.iw-version.outputs.version }}-${{ github.event.pull_request.base.sha || github.sha }}
    restore-keys: |
      iw-index-${{ runner.os }}-${{ steps.iw-version.outputs.version }}-

- run: npm install -g @intentweave/cli
- id: iw-version
  run: echo "version=$(iw --version)" >> "$GITHUB_OUTPUT"

- name: Build or update CARI index
  run: |
    if [ -f .iw/index.db ]; then
      iw index update -v
    else
      iw index build -v
    fi

- run: iw intent check --format github
```

The bundled composite action (`intentweave/doc-health-action`) supports this pattern
directly — restore `.iw/index.db` via `actions/cache` before the action, then pass
`build-index: false`; it runs `iw index update` against the restored index automatically.

**Caveats:**

- `iw index update` still re-parses the current file tree with AX to detect what
  changed (content-hash comparison, not a git diff) — it's a real speedup because only
  changed files go through KWX/annotate/write, but it's not free.
- No schema-version guard exists yet — always key the cache on the installed CLI
  version so a version bump forces a fresh full build rather than reusing an
  incompatible cached index.
- Jenkins / Zuul / other CI: the pattern is identical — persist the single
  `.iw/index.db` file between builds (Jenkins `stash`/`unstash` or an artifact/cache
  plugin; Zuul's artifact/cache storage or a reusable workspace), then run
  `iw index update` instead of `iw index build` when a prior index is present.

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

## Supported Languages

IntentWeave works on two layers:

### Semantic layer (documentation / KG)

Works on **any text file** — markdown, Swift, TypeScript, Python, etc. The LLM reads
the content and extracts entities and relationships regardless of language (see
Optional: Knowledge Graph above).

### Structural layer (AX stage — powers CARI)

Uses tree-sitter AST parsing for precise code symbol extraction:

| Language              | Parser                   | Symbols extracted                                                              |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| TypeScript/JavaScript | `tree-sitter-typescript` | classes, functions, interfaces, types, enums                                   |
| Swift                 | `tree-sitter-swift`      | structs, classes, protocols, enums, extensions, functions, methods, properties |
| Python                | `tree-sitter-python`     | classes, functions, decorators, methods                                        |

---

## Optional: Knowledge Graph (Neo4j, via MCP tools)

Deep semantic extraction, NL queries over the knowledge graph, and impact analysis require
Neo4j and an LLM API key. These are optional and complementary to the CARI Evidence Engine.
There is no longer a dedicated `iw run` / `iw query` / `iw persist` CLI — this functionality
is exposed exclusively through MCP tools (for GitHub Copilot / other MCP clients) plus one
CLI flag on `doc-health`:

```bash
export NEO4J_URI=neo4j://localhost:7687
export NEO4J_PASSWORD=intentweave
export OPENAI_API_KEY=sk-...

# Start the MCP server (stdio transport) — exposes kg_query, kg_context, kg_entities,
# kg_impact, kg_doc_health, kg_schema (6 KG tools) alongside the 52 CARI tools
iw mcp --neo4j-uri neo4j://localhost:7687

# The only KG-aware CLI entry point: full Neo4j-backed doc health (vs. the CARI-only default)
iw doc-health --neo4j -s my-project
```

Once the MCP server is running, ask your AI agent things like "What are the main components?"
(`kg_query`), "Build context about authentication" (`kg_context`), or "What's the impact of
changing src/auth.ts?" (`kg_impact`) — see the MCP Tools reference in the project README.

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

This only affects the optional KG features (`iw doc-health --neo4j`, `iw mcp` KG tools).
For CARI-only usage no Neo4j is needed.

```bash
export NEO4J_PASSWORD=intentweave
```

### MCP tools not visible in Copilot

1. Ensure `.vscode/mcp.json` exists with the correct server config
2. Test the server starts without errors: `iw mcp`
3. Restart VS Code after adding or modifying `mcp.json`
