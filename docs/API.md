<!-- SPDX-License-Identifier: Apache-2.0 -->

# Integration surfaces

IntentWeave has no REST API. The standalone Fastify server (`apps/server`,
`@intentweave/server-core`, `@intentweave/server-open`) was removed, and the
endpoints it served (`/api/query`, `/api/context`, `/api/entities`, `/api/impact`,
`/api/doc-health`, `/api/xlink`, `/api/run`, `/api/persist`, `/api/schema`) are gone.

These are the supported integration surfaces:

- **CLI**: the `iw` command, documented in [`CLI-USAGE.md`](CLI-USAGE.md). Commands
  support `--format json` where machine-readable output applies.
- **MCP server**: `iw mcp` starts a stdio MCP server with the `cari_*` tools for
  GitHub Copilot and other MCP clients. The tool list is defined in
  `packages/cli/src/mcp/server.ts`.
- **Programmatic API**: the `CariIndex` facade and query functions exported by
  `@intentweave/index`, documented in [`LIBRARY-API.md`](LIBRARY-API.md).

## Graph tools that need a plugin

The `kg_*` MCP tools (`kg_query`, `kg_context`, `kg_entities`, `kg_doc_health`, `kg_schema`)
read a graph through the `persistence` plugin capability. `@intentweave/plugin-kg-lite`
provides it with SQLite and needs no configuration. Without a persistence plugin the tools
return "No persistence plugin available".
