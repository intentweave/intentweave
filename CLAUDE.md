# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

IntentWeave is a pnpm/Turbo TypeScript monorepo for a semantic knowledge
extraction platform. Two engines share one local workspace:

- **CARI (Code-Aware Retrieval Index)** — zero-cost SQLite index (`.iw/index.db`)
  built from AST, document keywords, and git history. No LLM, no servers.
- **Intent Engine** — enforces ADR-derived rules (`.iw/rules.yaml`) against the
  CARI index in CI. Structural, behavioral (Mermaid), and documentary domains.
- **Claims** — the active product line: governed, evidence-backed statements about
  a repository (parameter claims V1, plus generalized repository Claims). See
  `docs/PLAN-GENERALIZED-REPOSITORY-CLAIMS.md`.

The primary interface is the `iw` CLI and its MCP server. The REST API and UI
are removed; the supported integration surfaces are the CLI, MCP tools, and the
`@intentweave/index` programmatic API.

## Layout

```
packages/
  analyzer/          Pipeline stages (AX, KWX, COX, TCG)
  ast-extractor/     Tree-sitter AST extraction (TS/JS)
  cli/               `iw` commands, MCP server (src/mcp/server.ts), claims, intent
  core/              Shared types, plugin registry, capability interfaces
  index/             CARI: SQLite index, queries, exports, claims (src/claims)
  cypher-lite/       Cypher subset → SQLite transpiler
  plugin-llm/        LLM provider plugin (OpenAI, Azure, compatible)
  plugin-python/     Python language plugin
  plugin-swift/      Swift language plugin
  python-parser/     Tree-sitter Python extraction
  swift-parser/      Tree-sitter Swift extraction
  sqlite-compat/     node:sqlite wrapper with better-sqlite3-compatible API
  cari-native*/      Rust native CARI binaries (per-platform; target/ is gitignored)
docs/                Specs, plans, ADRs, roadmap, CLI and library docs
.github/             CI, doc-health workflow, skills, Copilot instructions
.iw/                 Workspace data — gitignored except .iw/claims/*
scripts/             Release and demo scripts
iw.sh                Dev CLI wrapper (runs packages/cli/src/cli.ts via tsx)
```

Source of truth for the Copilot-facing CARI and Intent Engine reference is
`.github/copilot-instructions.md`; read it before changing those surfaces.

## Commands

Requirements: Node >= 22.15, pnpm >= 9 (repo pins pnpm 10.32.1).

```bash
pnpm install --frozen-lockfile   # install (CI uses frozen lockfile)
pnpm build                       # turbo run build (dependsOn ^build)
pnpm typecheck                   # tsc --noEmit per package
pnpm test                        # vitest run from repo root
pnpm format:check                # prettier --check on ts/tsx/json/md
pnpm format                      # prettier --write
pnpm lint                        # currently a stub (echoes TODO: eslint)

# One package
pnpm --filter @intentweave/index build
pnpm --filter @intentweave/index test

# One test file
npx vitest run packages/index/src/__tests__/<file>.test.ts

# Run the CLI without building
./iw.sh <command>
```

CI (`.github/workflows/ci.yml`) runs build → typecheck → test → lint →
format:check on Node 22. Run the same sequence before opening a PR.

Known quirk: the CLI package has pre-existing TypeScript errors in
`buildFull.ts`. Use `cd packages/cli && npx tsc --noEmitOnError false` when
building it directly.

## Conventions

- **TypeScript, strict.** Base config is `tsconfig.base.json` (ES2022, NodeNext,
  `strict`). Prefer explicit types; avoid `any` unless justified (PR template
  checks this).
- **ESM only.** Packages use `"type": "module"` and NodeNext resolution, so
  relative imports need explicit `.js` extensions.
- **Formatting:** Prettier, 2-space indent, LF, UTF-8, trailing newline
  (`.editorconfig`). Markdown is not trimmed of trailing whitespace.
- **Tests:** Vitest, colocated in `src/__tests__/` or as `*.test.ts` under
  `packages/*/src`. Root `vitest.config.ts` uses the node environment with globals.
  Bug fixes should include a regression test; new features should include tests.
- **Node SQLite:** go through `@intentweave/sqlite-compat`, not `better-sqlite3`
  directly in new code. The root vitest config externalises it for this reason.
- **Naming:** clear over clever. Stage and pipeline names are established
  (AX, KWX, COX, TCG, IN, FX, KX, GX); reuse them rather than inventing new ones.
- **Changelog:** user-visible changes go under `## [Unreleased]` in `CHANGELOG.md`.
- **Docs are part of the change.** Update the relevant `docs/` spec or
  `copilot-instructions.md` when behavior or CLI surface changes. A doc-health
  check runs on PRs and scores documentation coverage.

## Design principles

These come from `CONTRIBUTING.md` and the Claims plan. Hold to them when adding code.

1. **Deterministic verification.** Once a Claim or Rule is promoted, its check
   must run without an LLM call. CI must never need a model.
2. **LLMs propose, they do not decide.** Semantic models may generate candidates
   and correlations. Promotion and assessment go through deterministic analysis
   and governed review/Policy decisions.
3. **Evidence over assertion.** Results should be traceable to code, config,
   docs, tests, or git history, with provenance.
4. **Explicit identities and versioned contracts.** Preserve existing identities
   and history when changing schemas. Parameter Claims V1 identities must keep
   working; schema changes are versioned (currently up to schema 19 on the
   generalized Claims work).
5. **Separation of stages.** Ingestion → extraction → materialization →
   projection stay distinct phases.
6. **Profiles over forks.** Domain-specific behavior belongs in profiles or
   plugins, not hard-coded branches in core.
7. **CLI is first-class.** Every capability should be scriptable and CI-friendly,
   with `--format json` where it applies.
8. **Do not hard-code domain assumptions** in generic mechanisms.

## Working in this repo

- The current feature branch is `feat/generalized-repository-claims`. Main is `main`.
- `.iw/` holds local index databases, caches, and scratch data. Do not commit
  it, except the tracked `.iw/claims/` files. Do not delete `.iw/index*.db`
  backups without checking with the user.
- `.iw/claims/state.yaml` and `inference.yaml` are tracked and represent
  reviewed Claim state. Treat edits to them as meaningful changes.
- `packages/cari-native/target/` is a large Rust build directory. Leave it alone.
- Avoid `apps/` references. That directory was removed; `pnpm-workspace.yaml`
  still lists it for compatibility.
- When running the index against this repo, the output lands in `.iw/`. That is
  expected and gitignored.

## Git and PRs

- Branch from `main` for new work. Keep commits focused and readable.
- PR description should follow `.github/pull_request_template.md`.
- Do not push or open PRs unless asked.
- Do not add attribution lines beyond what the user's own instructions specify.
