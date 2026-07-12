<!-- SPDX-License-Identifier: Apache-2.0 -->

# IntentWeave REST API — Removed

> **Removed.** The standalone Fastify REST API server (`apps/server`,
> `@intentweave/server-core`, `@intentweave/server-open`) has been removed from
> the codebase to simplify and scope the product. Those packages no longer
> exist, and none of the endpoints formerly documented here (`/api/query`,
> `/api/context`, `/api/entities`, `/api/impact`, `/api/doc-health`,
> `/api/xlink`, `/api/run`, `/api/persist`, `/api/schema`) are exposed by
> anything IntentWeave currently ships.
>
> IntentWeave's supported integration surfaces today are:
>
> - **CLI** — see [`docs/CLI-USAGE.md`](CLI-USAGE.md)
> - **MCP tools** — 58+ tools for GitHub Copilot / any MCP client, see
>   `packages/cli/src/mcp/server.ts`
> - **Programmatic API** — `@intentweave/index`'s `CariIndex` facade, see
>   [`docs/LIBRARY-API.md`](LIBRARY-API.md)
>
> For Neo4j-backed knowledge graph querying, install the KG plugin
> (`iw plugin add kg`) and use the `kg_query` / `kg_context` / `kg_impact` /
> `kg_entities` / `kg_doc_health` / `kg_schema` MCP tools against an existing,
> already-populated Neo4j instance. IntentWeave does not currently provide a
> CLI command to ingest data into Neo4j from scratch.
