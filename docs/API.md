<!-- SPDX-License-Identifier: Apache-2.0 -->

# IntentWeave REST API — v1.0.0

This document describes the versioned HTTP API exposed by the IntentWeave server
(`@intentweave/server-core` + `@intentweave/server-open`).  It is the stable
integration surface for external doc platforms (Confluence, Notion, custom wikis)
and any tooling that cannot use the CLI or MCP server directly.

> **Interactive docs:** When the server is running, the full OpenAPI spec is
> available at `GET /docs` (Swagger UI) and `GET /docs/json` (raw JSON).

## Contents

- [Base URL & Versioning](#base-url--versioning)
- [Authentication](#authentication)
- [Common Headers](#common-headers)
- [Endpoints](#endpoints)
  - [Health](#health)
  - [Sessions](#sessions)
  - [Schema](#schema)
  - [Query](#query)
  - [Context](#context)
  - [Entities](#entities)
  - [Impact](#impact)
  - [Doc Health](#doc-health)
  - [Cross-layer Link (xlink)](#cross-layer-link-xlink)
  - [Pipeline — Run](#pipeline--run)
  - [Pipeline — Persist](#pipeline--persist)
- [Error Responses](#error-responses)
- [Quick-Start Integration Example](#quick-start-integration-example)

---

## Base URL & Versioning

```
http://<host>:<port>/
```

Default: `http://localhost:3000/`

The API is **version-stamped** via the `x-api-version` response header on every
response.  The current version is **1.0.0**.

```
x-api-version: 1.0.0
```

Breaking changes will increment the major version.  Non-breaking additions
(new optional fields, new endpoints) increment the minor version.

---

## Authentication

When the server is started with `apiKeys` in the `ServerConfig`, all `/api/*`
routes require a bearer token:

```http
Authorization: Bearer <api-key>
```

When `apiKeys` is not set (default), the API is open.  Never expose an
unauthenticated server on a public network.

---

## Common Headers

| Header             | Direction | Description                              |
| ------------------ | --------- | ---------------------------------------- |
| `Content-Type`     | Request   | `application/json` for all POST bodies   |
| `Authorization`    | Request   | `Bearer <api-key>` when auth is enabled  |
| `x-session-id`     | Request   | Override the session for this request    |
| `x-api-version`    | Response  | Server API version (`1.0.0`)             |
| `x-trace-id`       | Both      | Optional trace ID for distributed tracing|

---

## Endpoints

### Health

#### `GET /health`

Liveness probe — always returns 200 while the process is running.

**Response 200**

```json
{
  "status": "ok",
  "uptime": 42.3,
  "timestamp": "2026-04-26T10:00:00.000Z"
}
```

#### `GET /ready`

Readiness probe — checks Neo4j connectivity.

**Response 200**

```json
{ "status": "ready", "neo4j": "connected" }
```

**Response 503** — Neo4j unreachable

```json
{ "status": "not ready", "neo4j": "disconnected" }
```

---

### Sessions

#### `GET /api/sessions`

List all available sessions across graph layers (Canon / KWG / TCG).

**Response 200**

```json
{
  "sessions": [
    {
      "id": "my-project",
      "canonCount": 312,
      "kwgCount": 84,
      "tcgCount": 0
    }
  ]
}
```

---

### Schema

#### `GET /api/schema`

Describe the knowledge graph schema — node labels, relationship types,
canonical predicates, and entity types.  Useful for building query UIs.

**Response 200**

```json
{
  "nodeLabels": ["Canon", "Entity", "RawTriple", "Session"],
  "relationshipTypes": ["CANON_REL", "CANONICALIZED_FROM", "CONTAINS"],
  "canonicalPredicates": ["CONTAINS", "DEPENDS_ON", "IMPLEMENTS", "CALLS", "..."],
  "entityTypes": ["concept", "decision", "component", "technology", "..."]
}
```

---

### Query

#### `POST /api/query`

Execute a natural-language or raw Cypher query against the knowledge graph.

**Body**

| Field       | Type    | Required | Default | Description                                  |
| ----------- | ------- | -------- | ------- | -------------------------------------------- |
| `question`  | string  | either   | —       | NL question; LLM translates to Cypher        |
| `cypher`    | string  | either   | —       | Raw Cypher; bypasses LLM                     |
| `session`   | string  | no       | default | Session to scope the query                   |
| `limit`     | integer | no       | 25      | Max results                                  |
| `summarize` | boolean | no       | true    | LLM-summarize results (NL mode only)         |
| `format`    | string  | no       | `json`  | `json` or `table`                            |

**Example — NL query**

```json
{
  "question": "What decisions were made about the database?",
  "session": "my-project"
}
```

**Example — Raw Cypher**

```json
{
  "cypher": "MATCH (n:Canon:Entity) WHERE n.type = 'decision' RETURN n.name, n.type LIMIT 20",
  "session": "my-project"
}
```

**Response 200**

```json
{
  "rows": [
    { "n.name": "Use Neo4j for graph storage", "n.type": "decision" }
  ],
  "summary": "Two decisions concern the database: ...",
  "cypher": "MATCH (n:Canon:Entity) ...",
  "durationMs": 45
}
```

---

### Context

#### `POST /api/context`

Build RAG context from the knowledge graph.  Returns entities and relationships
suitable for injecting into an LLM prompt.

**Body**

| Field    | Type    | Required  | Default  | Description                                    |
| -------- | ------- | --------- | -------- | ---------------------------------------------- |
| `topic`  | string  | see note¹ | —        | NL topic; LLM picks relevant entities          |
| `entity` | string  | see note¹ | —        | Seed entity name for neighborhood expansion    |
| `all`    | boolean | see note¹ | false    | Dump entire session                            |
| `session`| string  | no        | default  | Session to scope                               |
| `hops`   | integer | no        | 2        | Expansion depth (entity mode)                  |
| `format` | string  | no        | `json`   | `json` or `markdown`                           |

> ¹ Exactly one of `topic`, `entity`, or `all: true` is required.

**Example — topic retrieval**

```json
{
  "topic": "authentication architecture",
  "session": "my-project",
  "hops": 2
}
```

**Response 200**

```json
{
  "entities": [
    {
      "name": "AuthService",
      "type": "component",
      "aliases": ["auth service"],
      "relationships": [
        { "predicate": "DEPENDS_ON", "target": "JWT", "direction": "out" }
      ]
    }
  ],
  "stats": { "entities": 8, "relationships": 14, "hops": 2 }
}
```

---

### Entities

#### `GET /api/entities`

List or search canonical entities.

**Query parameters**

| Param    | Type    | Default | Description                                          |
| -------- | ------- | ------- | ---------------------------------------------------- |
| `type`   | string  | —       | Filter by entity type (e.g. `component`, `decision`) |
| `search` | string  | —       | Case-insensitive name contains filter                |
| `session`| string  | default | Session to scope                                     |
| `limit`  | integer | 50      | Max results                                          |

**Example**

```
GET /api/entities?type=component&session=my-project&limit=20
```

**Response 200**

```json
{
  "entities": [
    {
      "name": "AuthService",
      "type": "component",
      "aliases": ["auth service"],
      "confidence": 0.95,
      "relationshipCount": 7
    }
  ],
  "total": 1
}
```

---

### Impact

#### `POST /api/impact`

Semantic impact analysis — given file paths, traverse the knowledge graph to
find which concepts and documents are affected.

**Body**

| Field    | Type     | Required | Default | Description                         |
| -------- | -------- | -------- | ------- | ----------------------------------- |
| `files`  | string[] | yes      | —       | File paths to analyze               |
| `session`| string   | no       | default | Session                             |
| `hops`   | integer  | no       | 2       | Ripple analysis depth               |
| `format` | string   | no       | `json`  | `json` or `markdown`                |

**Example**

```json
{
  "files": ["packages/cli/src/commands/run.ts"],
  "session": "my-project",
  "hops": 3
}
```

**Response 200**

```json
{
  "direct": [
    { "entity": "RunCommand", "type": "component", "confidence": 0.9 }
  ],
  "ripple": [
    { "entity": "PipelineOrchestrator", "type": "component", "via": "DEPENDS_ON" }
  ],
  "risks": [],
  "summary": "Changing run.ts directly affects RunCommand and ripples to ...",
  "durationMs": 120
}
```

---

### Doc Health

#### `POST /api/doc-health`

Documentation freshness analysis — detect stale, drifted, and contradicted docs.

**Body**

| Field    | Type     | Required | Default | Description                                     |
| -------- | -------- | -------- | ------- | ----------------------------------------------- |
| `files`  | string[] | no       | all     | Specific files to check (omit = check all)      |
| `session`| string   | no       | default | Session                                         |
| `format` | string   | no       | `json`  | `json` or `markdown`                            |

**Example**

```json
{
  "files": ["docs/ARCHITECTURE.md"],
  "session": "my-project"
}
```

**Response 200**

```json
{
  "reports": [
    {
      "file": "docs/ARCHITECTURE.md",
      "status": "warning",
      "score": 0.72,
      "issues": [
        {
          "type": "drift",
          "entity": "AuthService",
          "detail": "Entity gained 3 new relationships since extraction"
        }
      ]
    }
  ],
  "summary": "1 file has warnings, 0 files are rotten"
}
```

---

### Cross-Layer Link (xlink)

#### `POST /api/xlink`

Cross-layer linking — connects semantic knowledge graph entities to source code
symbols using four strategies: `dep`, `import`, `name`, `path`.  Creates
`CodeRef` nodes and `REALIZED_BY` relationships.

**Body**

| Field      | Type     | Required | Default         | Description                            |
| ---------- | -------- | -------- | --------------- | -------------------------------------- |
| `session`  | string   | no       | default         | Session                                |
| `strategies`| string[]| no       | all four        | Subset of `dep`, `import`, `name`, `path` |
| `persist`  | boolean  | no       | false           | Write CodeRef nodes to Neo4j           |
| `format`   | string   | no       | `json`          | `json` or `markdown`                   |

**Response 200**

```json
{
  "links": [
    {
      "entity": "AuthService",
      "file": "packages/cli/src/commands/run.ts",
      "strategy": "name",
      "confidence": 0.9
    }
  ],
  "stats": { "linked": 24, "unlinked": 3 },
  "durationMs": 380
}
```

---

### Pipeline — Run

#### `POST /api/run`

Execute the open-track extraction pipeline on the server.  Requires
`workspaceRoot` in the server config.  Progress events are published on the
SSE stream.

**Body**

| Field      | Type     | Required | Default        | Description                                    |
| ---------- | -------- | -------- | -------------- | ---------------------------------------------- |
| `files`    | string[] | no       | all workspace  | Paths or globs to process                      |
| `session`  | string   | no       | default        | Session ID for the run                         |
| `provider` | string   | no       | `smart-mock`   | LLM provider: `smart-mock` or `openai`         |
| `model`    | string   | no       | `gpt-4o-mini`  | LLM model name                                 |
| `track`    | string   | no       | `open`         | Pipeline track: `open`, `main`, or `both`      |
| `profile`  | string   | no       | `standard`     | Extraction profile name                        |
| `persist`  | boolean  | no       | false          | Auto-persist to Neo4j after completion         |

**Response 200** — run started

```json
{
  "runId": "run_2026-04-26T10-00-00_abc123",
  "status": "started",
  "files": 12
}
```

#### `GET /api/runs/:runId`

Poll run status.

**Response 200**

```json
{
  "runId": "run_2026-04-26T10-00-00_abc123",
  "status": "completed",
  "artifacts": 12,
  "durationMs": 8400
}
```

---

### Pipeline — Persist

#### `POST /api/persist`

Persist extraction results to Neo4j.  Requires `workspaceRoot` in server config.

**Body**

| Field    | Type    | Required | Default | Description                          |
| -------- | ------- | -------- | ------- | ------------------------------------ |
| `runId`  | string  | either   | —       | Specific run to persist              |
| `latest` | boolean | either   | false   | Persist the most recent run          |
| `session`| string  | no       | default | Session                              |
| `mode`   | string  | no       | `delta` | `delta` (diff-only) or `full`        |

**Response 200**

```json
{
  "persisted": 312,
  "updated": 14,
  "durationMs": 650
}
```

---

## Error Responses

All errors follow a consistent shape:

```json
{
  "error": "Bad Request",
  "message": "Either 'question' or 'cypher' is required",
  "statusCode": 400
}
```

| Status | Meaning                                                               |
| ------ | --------------------------------------------------------------------- |
| 400    | Invalid request body or missing required field                        |
| 401    | Missing or invalid `Authorization` header (when auth is enabled)      |
| 404    | Resource not found (e.g. unknown `runId`)                             |
| 429    | Rate limit exceeded                                                   |
| 500    | Internal server error                                                 |
| 501    | Feature not available (e.g. NL query without LLM configured)          |
| 503    | Dependency unavailable (e.g. Neo4j unreachable)                       |

---

## Quick-Start Integration Example

This example integrates IntentWeave into a Confluence-like doc system to annotate
pages with freshness status.

### 1. Start the server

```bash
npm install -g @intentweave/cli
iw run docs/ --track open --provider openai -i --persist -v
node -e "
  const { createServer } = require('@intentweave/server-core');
  const { openPlugin } = require('@intentweave/server-open');
  createServer({
    neo4j: { uri: 'bolt://localhost:7687', username: 'neo4j', password: process.env.NEO4J_PASSWORD },
    defaultSession: 'my-project',
    apiKeys: [process.env.IW_API_KEY],
  }).then(s => s.register(openPlugin).then(() => s.listen({ port: 3000 })));
"
```

### 2. Check a page for freshness

```bash
curl -s -X POST http://localhost:3000/api/doc-health \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $IW_API_KEY' \
  -d '{"files": ["docs/ARCHITECTURE.md"], "session": "my-project"}'
```

### 3. Show the score badge

```bash
curl -s http://localhost:3000/api/entities \
  -d 'type=component&session=my-project&limit=5'
```

### 4. Embed context into an LLM prompt

```bash
curl -s -X POST http://localhost:3000/api/context \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $IW_API_KEY' \
  -d '{"topic": "authentication architecture", "session": "my-project"}'
```

### TypeScript client snippet

```typescript
const BASE = "http://localhost:3000";
const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${process.env.IW_API_KEY}`,
};

// Check doc health
const health = await fetch(`${BASE}/api/doc-health`, {
  method: "POST",
  headers: HEADERS,
  body: JSON.stringify({ files: ["docs/ARCHITECTURE.md"], session: "my-project" }),
}).then((r) => r.json());

// List components
const { entities } = await fetch(
  `${BASE}/api/entities?type=component&session=my-project`,
  { headers: HEADERS },
).then((r) => r.json());
```
