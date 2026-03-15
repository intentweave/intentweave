# IntentWeave

**Semantic knowledge extraction platform** — build queryable knowledge graphs from documents and code.

IntentWeave extracts entities and relationships from your docs, specs, and code using LLMs,
canonicalizes them into a coherent graph, persists to Neo4j, and exposes them through CLI, MCP tools,
REST API, and a React UI.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

---

## Quick Start

### Install from npm

```bash
npm install -g @intentweave/cli
iw --help
```

Or use `npx` without installing:

```bash
npx @intentweave/cli run docs/*.md --track open -i -v
```

### First project setup

```bash
cd /path/to/your/project

# Initialize workspace
iw init

# Start Neo4j (requires Docker)
docker run -d --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/codegraph \
  neo4j:5

# Run the extraction pipeline on your docs
export NEO4J_PASSWORD=codegraph
export OPENAI_API_KEY=sk-...
iw run docs/*.md --track open --provider openai -i --persist -v

# Query the knowledge graph
iw query "What are the main components?"
```

> **Full CLI documentation:** [docs/CLI-USAGE.md](docs/CLI-USAGE.md)

### From source (development)

```bash
git clone https://github.com/intentweave/intentweave.git
cd intentweave
pnpm install && pnpm build

# Use the dev wrapper (no build needed for changes)
./iw.sh run docs/*.md --track open -i -v
```

### Start the Server

```bash
cd apps/server
cp .env.example .env    # edit NEO4J_PASSWORD and OPENAI_API_KEY

pnpm dev
# → 🧠 IntentWeave server listening on http://0.0.0.0:3000
# → 📖 API docs:   http://localhost:3000/docs
# → ❤️  Health:     http://localhost:3000/health
```

---

## REST API

All endpoints live under `/api/`. The server runs on port 3000 by default.

### Query the Knowledge Graph

**Natural language** (requires `OPENAI_API_KEY`):

```bash
curl -X POST http://localhost:3000/api/query \
  -H 'Content-Type: application/json' \
  -H 'x-session-id: my-project' \
  -d '{"question": "What decisions were made about the database?"}'
```

```json
{
  "results": [
    {
      "decision": "Neo4j",
      "type": "decision",
      "predicate": "DECIDED_FOR",
      "target": "graph database"
    }
  ],
  "cypher": "MATCH (a:Canon)-[r:CANON_REL {predicate: \"DECIDED_FOR\"}]->(b:Canon) WHERE ...",
  "summary": "- **Neo4j** was decided for as the graph database\n- ...",
  "count": 3
}
```

**Raw Cypher** (no LLM needed):

```bash
curl -X POST http://localhost:3000/api/query \
  -H 'Content-Type: application/json' \
  -d '{"cypher": "MATCH (n:Canon:Entity) RETURN n.name, n.type LIMIT 10"}'
```

### Build RAG Context

**Topic-based** (requires `OPENAI_API_KEY`):

```bash
curl -X POST http://localhost:3000/api/context \
  -H 'Content-Type: application/json' \
  -H 'x-session-id: my-project' \
  -d '{"topic": "authentication architecture"}'
```

**Entity-seeded** (no LLM needed):

```bash
curl -X POST http://localhost:3000/api/context \
  -H 'Content-Type: application/json' \
  -H 'x-session-id: my-project' \
  -d '{"entity": "React", "hops": 3}'
```

**Dump all** entities:

```bash
curl -X POST http://localhost:3000/api/context \
  -H 'x-session-id: my-project' \
  -H 'Content-Type: application/json' \
  -d '{"all": true}'
```

### List Entities

```bash
# All entities in a session
curl 'http://localhost:3000/api/entities?session=my-project'

# Filter by type
curl 'http://localhost:3000/api/entities?session=my-project&type=decision&limit=20'

# Search by name
curl 'http://localhost:3000/api/entities?session=my-project&search=auth'
```

### Run Extraction Pipeline

```bash
curl -X POST http://localhost:3000/api/run \
  -H 'Content-Type: application/json' \
  -d '{
    "files": ["docs/*.md"],
    "track": "open",
    "provider": "openai",
    "incremental": true,
    "persist": true,
    "verbose": true
  }'
```

Returns 202 with a run summary including `runId`, artifact count, entity/relationship totals, and duration.

### Persist to Neo4j

```bash
# Persist latest run
curl -X POST http://localhost:3000/api/persist \
  -H 'Content-Type: application/json' \
  -d '{"latest": true}'

# Persist specific run
curl -X POST http://localhost:3000/api/persist \
  -H 'Content-Type: application/json' \
  -d '{"runId": "run-2026-03-08-abc12345"}'
```

### Impact Analysis

```bash
curl -X POST http://localhost:3000/api/impact \
  -H 'Content-Type: application/json' \
  -H 'x-session-id: my-project' \
  -d '{"files": ["src/auth.ts"], "hops": 2}'
```

### Documentation Health

```bash
curl -X POST http://localhost:3000/api/doc-health \
  -H 'Content-Type: application/json' \
  -H 'x-session-id: my-project' \
  -d '{"files": ["docs/ARCHITECTURE.md"]}'
```

### Graph Schema

```bash
curl http://localhost:3000/api/schema
```

Returns canonical predicates, entity types, and relationship documentation.

---

## CLI

```bash
# Run extraction pipeline
iw run docs/*.md --track open --provider openai -i -v

# Query the knowledge graph (natural language)
iw query "What are the main components?"

# Query with raw Cypher
iw query --cypher "MATCH (n:Canon:Entity) RETURN n.name, n.type LIMIT 20"

# Build RAG context
iw context "authentication architecture" -s my-project

# Entity-seeded context
iw context -e "React" --hops 3 -s my-project

# Impact analysis
iw impact src/auth.ts -s my-project

# Documentation health check
iw doc-health docs/ -s my-project

# Cross-layer code linking
iw xlink . --session my-project --persist

# Persist to Neo4j
iw persist --latest -v
```

> See [docs/CLI-USAGE.md](docs/CLI-USAGE.md) for the full command reference, workflows, and troubleshooting.

### MCP (GitHub Copilot Integration)

IntentWeave exposes MCP tools for use in VS Code Copilot:

| Tool            | Purpose                          | Key Parameters                  |
| --------------- | -------------------------------- | ------------------------------- |
| `kg_query`      | Natural language or Cypher query | `question`, `cypher?`, `limit?` |
| `kg_context`    | Build RAG context from graph     | `topic?`, `entity?`, `hops?`    |
| `kg_entities`   | List/search entities             | `type?`, `search?`, `limit?`    |
| `kg_impact`     | Semantic impact analysis         | `files`, `hops?`                |
| `kg_doc_health` | Documentation freshness          | `files?`                        |
| `kg_schema`     | Graph schema description         | _(none)_                        |

Start the MCP server:

```bash
iw mcp --session my-project -v
```

VS Code auto-discovers via `.vscode/mcp.json`:

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

## Architecture

```
apps/
  server/               → Runnable server (composes core + open)

packages/
  core/                 → @intentweave/core — types, predicates, interfaces
  analyzer/             → @intentweave/analyzer — pipeline engine (IN→FX→KX→GX)
  cli/                  → @intentweave/cli — `iw` commands + MCP server
  server-core/          → @intentweave/server-core — Fastify + Neo4j + middleware
  server-open/          → @intentweave/server-open — open track API routes
  profiles/             → @intentweave/profiles — extraction profile packs
  ast-extractor/        → @intentweave/ast-extractor — tree-sitter TS/JS extraction
  swift-parser/         → @intentweave/swift-parser — tree-sitter Swift extraction
```

### Server Plugin Architecture

The server is built on a layered plugin model:

```
┌──────────────────────────────────────────┐
│          @intentweave/server-core         │
│  Fastify 5 + Neo4j pool + context MW     │
│  Health + SSE + OpenAPI (Swagger)        │
└──────────┬───────────────────────────────┘
           │
┌──────────▼───────────────────────────────┐
│         @intentweave/server-open          │
│  POST /api/query   — KG query (NL+Cypher)│
│  POST /api/context — RAG context          │
│  POST /api/run     — pipeline execution   │
│  POST /api/persist — Neo4j persistence    │
│  POST /api/impact  — impact analysis      │
│  POST /api/doc-health — doc freshness     │
│  GET  /api/entities — entity listing      │
│  GET  /api/schema  — graph schema         │
│  POST /api/xlink   — code linking         │
└──────────────────────────────────────────┘
```

Pro features (curation, promotion, proposals, ledger) are added via additional
plugins from a separate `@intentweave/server-pro` package.

---

## Pipeline

### Open Track (IN → FX → KX → GX)

Schema-free knowledge extraction:

1. **IN** — Chunk documents (semantic markdown splitting, ~16k chars/chunk)
2. **FX** — Free extraction (LLM extracts raw triples per chunk, parallel)
3. **KX** — Canonicalization (normalize entities + predicates, batch of 40)
4. **GX** — Global merge (cross-document entity deduplication)

### Features

- **Incremental caching** — SHA-256 content-addressed, skip unchanged files
- **Fast keyword scanning** — parallel file I/O (64 concurrent reads), combined regex pre-filter, single-pass `indexOf` matching, early termination. Scans 3500+ files in seconds, not minutes
- **Batch failure detection** — 3 consecutive failures = abort
- **Network resilience** — two-phase retry, batch cooldown
- **Token/cost estimation** — before committing to LLM calls
- **Delta persistence** — only write changes to Neo4j
- **Profile packs** — domain-specific extraction rules

---

## Configuration

### Environment Variables

| Variable            | Default                 | Description                           |
| ------------------- | ----------------------- | ------------------------------------- |
| `NEO4J_URI`         | `bolt://localhost:7687` | Neo4j bolt URI                        |
| `NEO4J_USERNAME`    | `neo4j`                 | Neo4j username                        |
| `NEO4J_PASSWORD`    | _(required)_            | Neo4j password                        |
| `NEO4J_DATABASE`    | `neo4j`                 | Neo4j database name                   |
| `IW_SESSION`        | `default`               | Default session ID                    |
| `IW_WORKSPACE_ROOT` | _(optional)_            | Workspace root (enables run/persist)  |
| `OPENAI_API_KEY`    | _(optional)_            | OpenAI key (enables NL query + topic) |
| `IW_LLM_MODEL`      | `gpt-4o-mini`           | LLM model for NL queries              |
| `PORT`              | `3000`                  | Server port                           |
| `HOST`              | `0.0.0.0`               | Server host                           |
| `LOG_LEVEL`         | `info`                  | Log level                             |
| `CORS_ORIGIN`       | `*`                     | CORS origin(s), comma-separated       |

---

## Development

```bash
pnpm install          # Install all packages
pnpm build            # Build all (uses Turbo)
pnpm test             # Run all tests (710+ tests)
pnpm dev              # Dev mode with hot reload
pnpm typecheck        # Type check all packages
pnpm format           # Format with Prettier
pnpm format:check     # Verify formatting
```

### Publishing

All `@intentweave/*` packages are publishable to npm:

```bash
# Build everything first
pnpm build

# Publish all packages (pnpm resolves workspace:* → real versions)
pnpm -r publish --access public

# Or publish individual packages
pnpm --filter @intentweave/cli publish --access public
```

### Project Stats

- **9 packages** + 1 app
- **710+ tests**, all passing
- **TypeScript 5.6**, ESM, strict mode
- **Fastify 5**, Neo4j 5, Turbo, pnpm workspaces

---

## License

Apache-2.0 — see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions require signing the [CLA](CLA.md).
