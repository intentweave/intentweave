---
name: intentweave
description: "Use this skill when working in a repository that has an IntentWeave index (`.iw/index.db` or `.iw/rules.yaml` present) — before implementing a feature that touches code you haven't read yourself, before finishing a change or opening a PR, when asked why code works a certain way or what depends on something, or after editing documentation or renaming/moving a symbol. Grounds your understanding of the codebase in its own docs, imports, and git history instead of guessing, and checks changes against the repo's own documented architecture rules before a human reviewer has to. Local SQLite index, $0 cost, no LLM or servers required for the core commands."
---

# IntentWeave — Architecture Grounding & Enforcement

IntentWeave builds a local, zero-LLM evidence index of a repository — its code AST, documentation,
and git history — exposed through the `iw` CLI. Use it to ground your understanding of a codebase
and to catch changes that violate the team's own documented architecture before they're proposed.

## When to use this skill

- **Before implementing a feature that touches code you haven't read yourself.** Don't infer
  architecture from filenames or a partial read — retrieve it.
- **Before finishing any change, or right before opening a PR.** Check the diff against the
  repo's own rules.
- **When asked "why does X work this way" or "what depends on X."** Answer from grounded
  evidence, not inference.
- **After editing documentation, or after renaming/moving a symbol.** Confirm no new drift was
  introduced.

Skip this skill if there's no `.iw/` directory and no `rules.yaml` — IntentWeave isn't set up for
this repository. You may suggest `iw init` to the user, but don't run it yourself without asking
first — it writes files.

## Setup check

Before first use in a session, confirm the CLI and index are available:

```bash
iw --version || npx @intentweave/cli --version
```

If neither works, `iw` isn't installed. Ask before running `npm install -g @intentweave/cli` —
or just prefix every command below with `npx @intentweave/cli` instead of installing anything.

```bash
test -f .iw/index.db || iw index build
```

`iw index build` (and `iw index update` for incremental refreshes afterward) is zero-LLM,
local-only, and always safe to run without asking — it only reads project files and writes
`.iw/index.db`.

## Core workflows

### 1. Ground yourself before writing code in unfamiliar territory

```bash
iw index context-pack --query "<topic or feature area>"
iw index context-pack --files src/auth/service.ts src/auth/jwt.ts   # anchor on files you're about to edit
```

Returns a token-budgeted, ranked bundle of the files, symbols, rules, and doc excerpts most
relevant to the query — ranked by the real import graph and git history, not guesswork. Read this
before writing code that touches the area, instead of inferring architecture from a partial read
of a few files.

For a narrower question:

```bash
iw index retrieve "<topic>"
iw index connections "<EntityName>"   # cross-layer connections and gaps
```

### 2. Check a change against the repo's own architecture rules

Run before proposing a diff, and again before considering the task done:

```bash
iw intent check --changed src/auth/service.ts,src/auth/jwt.ts --severity high --format text
```

`--changed` takes a comma-separated file list. If this reports violations, surface them to the
user rather than silently ignoring them — prefer fixing the violation over overriding or
deleting the rule.

### 3. Check for documentation drift after touching docs or heavily-referenced code

```bash
iw index check src/auth/service.ts src/auth/jwt.ts
```

Reports docs that reference the files you just changed. If you renamed, moved, or changed the
signature of a symbol, run this and update any doc it flags.

### 4. Extract rules from an ADR (only if asked, and only with an LLM provider configured)

```bash
iw intent extract docs/<adr-file>.md --provider openai --output .iw/rules.yaml
```

This is the one command in this skill that makes an LLM call and costs money — only run it if
the user has a provider configured and explicitly wants rules generated from a written ADR.

### 5. Answer a question the built-in queries don't cover: run an ad-hoc graph query

If retrieval/connections don't surface what's needed, query the CARI graph projection
directly with CypherLite (no Neo4j, no LLM):

```bash
iw index schema                                  # node labels, relationships, built-in templates
iw index cypher "MATCH (a:SYMBOL)-[:CALLS]->(b:SYMBOL) RETURN a.name, b.name LIMIT 10"
iw index cypher @:callers-of --param calleeName=validateToken
```

Always run `iw index schema` first if you haven't already in this session — it lists the
exact node labels (`FILE`, `SYMBOL`, `DOCSPAN`, `TODO`, `RATIONALE`, `SEMANTIC`), relationship
types (`IMPORTS`, `DEFINES`, `CALLS`, `ANNOTATED_BY`, `HAS_TODO`, `HAS_RATIONALE`,
`SUMMARIZED_BY`, `CO_OCCURS`, `CO_CHANGES`), and named templates so you don't guess at
property names. Read-only — safe to run without asking.

## Interpreting output

- Rule violations are labeled `high` / `medium` / `low` severity — treat `high` as blocking.
- Retrieval and connection results carry a relevance/rank score (e.g. `0.95`) — treat low scores
  as worth verifying, not facts to state outright.
- If a query returns nothing, say so plainly rather than filling the gap with a guess.

## What this skill does not do

It doesn't replace reading the code you're actually modifying. Its rule checks are structural
(imports, symbols, call patterns, Mermaid-derived flows) — the one rule type that follows data
through variables (`taint_propagation`) is intra-function only and won't trace a value across a
function call boundary. Treat its output as grounding and a pre-flight check, not a substitute
for judgment.

## Learn more

For code-quality/dead-code checks (duplicate code, circular imports, unused exports, TODOs, etc.),
run `iw index report` for a corpus-wide dashboard, or `iw index <subcommand> --help` for any
specific one. Full command reference: [https://intentweave.org/docs/getting-started/](https://intentweave.org/docs/getting-started/)
and `iw --help` / `iw <command> --help` for any subcommand.
