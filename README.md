# IntentWeave

**Semantic knowledge extraction platform** — build queryable knowledge graphs from documents and code.

IntentWeave extracts entities and relationships from your docs, specs, and code using LLMs,
canonicalizes them into a coherent graph, persists to Neo4j, and exposes them through CLI, MCP tools,
REST API, and a React UI.

---

## Quick Start

```bash
# Install
pnpm install

# Build all packages
pnpm build

# Start Neo4j (requires Docker)
docker compose up neo4j -d

# Run the server
cd apps/server
cp .env.example .env    # edit NEO4J_PASSWORD
pnpm dev
```

The server starts at `http://localhost:3000` with:

- 📖 API docs: `http://localhost:3000/docs`
- ❤️ Health: `http://localhost:3000/health`
- 📡 SSE: `http://localhost:3000/stream`

### CLI

```bash
# Run extraction pipeline
iw run docs/*.md --track open --provider openai -i -v

# Query the knowledge graph
iw query "What are the main components?"

# Build RAG context
iw context "authentication architecture"

# Impact analysis
iw impact src/auth.ts

# Documentation health check
iw doc-health docs/

# Cross-layer code linking
iw xlink . --session my-project --persist
```

### MCP (GitHub Copilot integration)

IntentWeave exposes MCP tools for use in VS Code Copilot:

| Tool            | Purpose                          |
| --------------- | -------------------------------- |
| `kg_query`      | Natural language or Cypher query |
| `kg_context`    | Build RAG context from graph     |
| `kg_entities`   | List/search entities             |
| `kg_impact`     | Semantic impact analysis         |
| `kg_doc_health` | Documentation freshness          |
| `kg_schema`     | Graph schema description         |

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
  ast-extractor/        → @intentweave/ast-extractor — tree-sitter code extraction
```

### Server Plugin Architecture

The server is built on a layered plugin model:

```
┌──────────────────────────────────────────┐
│          @intentweave/server-core         │
│  Fastify + Neo4j pool + context MW        │
│  Health + SSE + OpenAPI                   │
└──────────┬───────────────────────────────┘
           │
┌──────────▼───────────────────────────────┐
│         @intentweave/server-open          │
│  POST /api/run     — pipeline execution   │
│  POST /api/query   — KG query             │
│  POST /api/context — RAG context          │
│  POST /api/impact  — impact analysis      │
│  POST /api/xlink   — code linking         │
│  ...9 endpoint groups                     │
└──────────────────────────────────────────┘
```

Pro features (curation, promotion, proposals, ledger) are added via additional plugins from a separate package.

---

## Pipeline

### Open Track (IN → FX → KX → GX)

Schema-free knowledge extraction:

1. **IN** — Chunk documents (semantic markdown splitting, ~16k chars/chunk)
2. **FX** — Free extraction (LLM extracts raw triples per chunk)
3. **KX** — Canonicalization (normalize entities + predicates)
4. **GX** — Global merge (cross-document entity deduplication)

### Features

- **Incremental caching** — SHA-256 content-addressed, skip unchanged files
- **Batch failure detection** — 3 consecutive failures = abort
- **Network resilience** — two-phase retry, batch cooldown
- **Token/cost estimation** — before committing to LLM calls
- **Delta persistence** — only write changes to Neo4j

---

## Development

```bash
pnpm install          # Install all packages
pnpm build            # Build all (uses Turbo)
pnpm test             # Run all tests
pnpm dev              # Dev mode with hot reload
pnpm typecheck        # Type check all packages
pnpm format           # Format with Prettier
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions are subject to the [CLA](CLA.md).
