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

| Requirement       | Version  | Notes                                          |
| ----------------- | -------- | ---------------------------------------------- |
| **Node.js**       | ≥ 20     | `node -v`                                      |
| **Neo4j**         | 5.x      | Only for `query`, `context`, `impact`, `persist` |
| **OpenAI API key** | —       | Only for `--provider openai` and NL queries     |
| **Docker**        | —        | Easiest way to run Neo4j locally                |

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
  -e NEO4J_AUTH=neo4j/codegraph \
  neo4j:5

# Persist the latest run
export NEO4J_PASSWORD=codegraph
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

| Option                | Default      | Description                          |
| --------------------- | ------------ | ------------------------------------ |
| `-t, --track <track>` | `main`       | Pipeline track: `main`, `open`, `both` |
| `--provider <name>`   | `smart-mock` | LLM provider: `smart-mock`, `openai` |
| `--model <name>`      | `gpt-4o-mini`| Model for OpenAI provider            |
| `-i, --incremental`   | off          | SHA-256 content-addressed cache      |
| `--persist`           | off          | Auto-persist to Neo4j after run      |
| `--force`             | off          | Ignore cache, recompute everything   |
| `-p, --profile <name>`| `standard`   | Extraction profile                   |
| `--concurrency <n>`   | `5`          | Parallel LLM calls                   |
| `--from-fx <source>`  | —            | Skip FX, reuse cached FX output      |
| `-v, --verbose`       | off          | Show per-stage progress              |

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

| Option             | Default | Description                    |
| ------------------ | ------- | ------------------------------ |
| `-s, --session`    | —       | Neo4j session scope            |
| `-f, --format`     | `table` | Output format: `table`, `json` |
| `-o, --output`     | —       | Write output to file           |
| `-v, --verbose`    | off     | Show generated Cypher          |

### `iw context` — Build RAG context

```bash
iw context <topic> [options]
iw context -e <entity> [options]
iw context --all [options]
```

| Option          | Default | Description                      |
| --------------- | ------- | -------------------------------- |
| `-s, --session` | —       | Neo4j session scope              |
| `-e, --entity`  | —       | Seed from specific entity        |
| `--hops <n>`    | `2`     | Expansion depth from seed entity |
| `--all`         | off     | Dump all entities and relationships |
| `--code-refs`   | off     | Include source code references   |
| `-f, --format`  | `text`  | Output: `text`, `json`           |
| `-o, --output`  | —       | Write output to file             |

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

| Option          | Default | Description         |
| --------------- | ------- | ------------------- |
| `-s, --session` | —       | Neo4j session scope |
| `-f, --format`  | `text`  | Output format       |
| `-o, --output`  | —       | Write to file       |

### `iw persist` — Write to Neo4j

```bash
iw persist [run-id] [options]
```

| Option           | Default | Description                     |
| ---------------- | ------- | ------------------------------- |
| `--latest`       | off     | Persist the most recent run     |
| `--file <path>`  | —       | Persist from a specific JSON file |
| `-v, --verbose`  | off     | Show persistence details        |

### `iw xlink` — Cross-layer code linking

```bash
iw xlink [directory] [options]
```

Links semantic entities (from the knowledge graph) to actual source code symbols
found via AST extraction.

| Option           | Default | Description                     |
| ---------------- | ------- | ------------------------------- |
| `-s, --session`  | —       | Neo4j session scope             |
| `--persist`      | off     | Write code links to Neo4j       |
| `-v, --verbose`  | off     | Detailed output                 |

### `iw mcp` — MCP server for Copilot

```bash
iw mcp [options]
```

Starts an MCP (Model Context Protocol) server over stdio for use with
GitHub Copilot in VS Code.

| Option           | Default | Description             |
| ---------------- | ------- | ----------------------- |
| `-s, --session`  | —       | Default session scope   |
| `-v, --verbose`  | off     | Log tool invocations    |

**Exposed tools:**

| Tool            | Purpose                          |
| --------------- | -------------------------------- |
| `kg_query`      | Natural language or Cypher query |
| `kg_context`    | Build RAG context from graph     |
| `kg_entities`   | List/search entities             |
| `kg_impact`     | Semantic impact analysis         |
| `kg_doc_health` | Documentation freshness          |
| `kg_schema`     | Graph schema description         |

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

---

## Environment Variables

| Variable           | Default                 | Description                           |
| ------------------ | ----------------------- | ------------------------------------- |
| `NEO4J_URI`        | `bolt://localhost:7687` | Neo4j bolt URI                        |
| `NEO4J_USERNAME`   | `neo4j`                 | Neo4j username                        |
| `NEO4J_PASSWORD`   | _(required for Neo4j)_  | Neo4j password                        |
| `NEO4J_DATABASE`   | `neo4j`                 | Neo4j database name                   |
| `IW_SESSION`       | `default`               | Default session ID                    |
| `OPENAI_API_KEY`   | _(optional)_            | Required for `--provider openai` and NL queries |
| `IW_LLM_MODEL`    | `gpt-4o-mini`           | LLM model for NL queries              |

---

## Supported Languages

IntentWeave works on two layers:

### Semantic layer (open track)

Works on **any text file** — markdown, Swift, TypeScript, Python, etc.
The LLM reads the content and extracts entities and relationships regardless
of language. This is the primary extraction mode.

### Structural layer (AX stage)

Uses tree-sitter AST parsing for precise code symbol extraction:

| Language              | Parser                  | Symbols extracted                          |
| --------------------- | ----------------------- | ------------------------------------------ |
| TypeScript/JavaScript | `tree-sitter-typescript`| classes, functions, interfaces, types, enums |
| Swift                 | `tree-sitter-swift`     | structs, classes, protocols, enums, extensions, functions, methods, properties |

The cross-layer linker (`iw xlink`) connects semantic entities from the knowledge
graph to structural code symbols, enabling code-reference-enriched context.

---

## Common Workflows

### First-time project setup

```bash
cd my-project
iw init

# Analyze your docs
export OPENAI_API_KEY=sk-...
iw run docs/**/*.md --track open --provider openai -i -v

# Persist to Neo4j
export NEO4J_PASSWORD=codegraph
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
export NEO4J_PASSWORD=codegraph
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
