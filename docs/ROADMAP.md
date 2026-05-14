# IntentWeave — Product Roadmap

> **Principle:** Restructure first, then add features by value. Restructuring costs
> nothing and enables adoption. New features built on a confused foundation compound
> the noise problem. Every phase must ship something a user can immediately see and use.

---

## Platform Vision

Two engines. One platform. One deliverable.

```
CARI Evidence Engine  ──evidence──►  Intent Engine  ──violations──►  Insights Book
(observe)                            (enforce)                       (the deliverable)
```

- **CARI Evidence Engine** — AST, imports, call graph, annotations, git. $0, always-on.
- **Intent Engine** — one rule checker, three domains (structural / behavioral / documentary).
- **Insights Book** — the unified HTML deliverable. One file, every dimension.

---

## Phase 0 — Restructure ✅

*Goal: make the product legible. Users should understand what they have and how to
use it from the README alone.*

| Task | Effort | Value | Status |
|------|--------|-------|--------|
| `iw intent` CLI namespace (alias layer over `iw index rules-*` and `iw guardrails *`) | S | High | ✅ |
| `domain` field in `rules.yaml` schema + violations output, grouped by domain | S | High | ✅ |
| README rewrite: two products, three commands, one deliverable | S | High | ✅ |
| Homepage rewrite: two product cards, Insights Book as primary output | S | High | ✅ |
| Getting Started: three commands → open the book | S | High | ✅ |
| Rename "CARI Index" → "CARI Evidence Engine" in all user-facing docs | XS | Medium | ✅ |
| Sidebar restructure: CARI / Intent Engine sections | XS | Medium | ✅ |

**Exit criteria:** a new user reads the README in 2 minutes, runs three commands,
opens the Insights Book, and understands what all three sections mean. ✅

**Estimated wall time:** 1–2 weeks (mostly documentation + CLI alias wiring)

---

## Phase 1 — Intent Engine Foundation ✅

*Goal: unify the enforcement model. Documentary intent becomes enforceable in CI,
not just queryable. All three domains report into one violations table.*

| Task | Effort | Value | Status |
|------|--------|-------|--------|
| Documentary domain check types wired to existing CARI queries | M | High | ✅ |
| `iw intent check --domain documentary` (= `iw living verify`) | S | High | ✅ |
| Violation `confidence` + `mode: warn\|error` fields on every violation | M | High | ✅ |
| Per-domain CI threshold config in `.iw/config.yaml` | S | High | ✅ |
| `iw living verify` as convenience alias for documentary domain | XS | Medium | ✅ |
| Update MCP tools: `cari_rules_check` → `intent_check` with domain param | S | Medium | ✅ |

**Exit criteria:** a team can add documentary rules to `rules.yaml` and get CI failures
when coverage drops or docs go stale — using the same `iw intent check` command as
structural rules. ✅

**Estimated wall time:** 2–3 weeks

---

## Phase 2 — Insights Book Upgrade ✅

*Goal: make the Insights Book the product's primary deliverable — not just an export
option. The book must answer "is my project OK?" on its first page.*

| Task | Effort | Value | Status |
|------|--------|-------|--------|
| **Executive Summary chapter** — living score + violations by domain + top-3 actions | M | Very High | ✅ |
| **Recommendations chapter** — ranked actionable list, cross-domain, links to chapters | M | Very High | ✅ |
| **Documentary domain chapters** — Coverage, Stale Docs, Terminology as violation tables | M | High | ✅ |
| Violations table grouped by domain (structural / behavioral / documentary) | S | High | ✅ |
| Opinionated defaults: `iw index export --book` includes all chapters by default | S | Medium | ✅ |
| Rule dormancy alerts in Insights Book (zero violations for N runs → flag for review) | M | Medium | ✅ |

**Exit criteria:** open the book and the Executive Summary tells you your score, your
three biggest problems, and which chapter to go to for each. No reading required to
get the top-level answer. ✅

**Estimated wall time:** 2–3 weeks

---

## Phase 3 — Behavioral Domain / Mermaid Rules

*Goal: make Mermaid diagrams in ADR files enforceable with zero authoring overhead.*

| Task | Effort | Value | Status |
|------|--------|-------|--------|
| Mermaid diagram parser — zero-dep regex-based edge extraction (sequence/state/flowchart) | S | High | ✅ |
| Sequence diagram → `must_call` / `must_not_call` rule extraction | M | Very High | ✅ |
| `mermaid:` inline key in `rules.yaml` (§4.5 of SEMANTIC-RULES-SPEC) | M | High | ✅ |
| `source.type: mermaid_file` — load diagram from ADR file at check time | M | High | ✅ |
| State diagram → `valid_transition` rule extraction (mode: warn) | M | Medium | ✅ |
| Flowchart → `must_precede` / `must_not_bypass` rule extraction (mode: warn) | L | Medium | ✅ |
| Behavioral violations surfaced in Insights Book Violations chapter + Executive Summary | M | High | ✅ |
| `iw intent extract --domain behavioral` for BDD scenario → rules.yaml | M | Medium | |

**Key insight:** for sequence diagrams, `must_not_call` (forbidden edges) can already run
at ~0.85 confidence via import absence — no call graph needed. These can be `mode: error`
from day one. `must_call` (required edges) needs the calls table (Phase 4) for ~0.90.

**Parser decision:** `@mermaid-js/parser` (langium-based, DOM issues) and `beautiful-mermaid`
(zero-DOM, clean API) were both evaluated. `beautiful-mermaid` does not support `sequenceDiagram`
— the most critical diagram type for behavioral enforcement. The implemented solution is a
zero-dep regex-based edge extractor in `packages/index/src/queries/mermaidCheck.ts` that covers
all three diagram types (sequence / state / flowchart) with no npm dependencies.

**Exit criteria:** a team pastes a Mermaid sequence diagram from their ADR into `rules.yaml`,
runs `iw intent check`, and gets CI violations when code bypasses the declared call path. ✅

**Estimated wall time:** 3–4 weeks

---

## Phase 4 — CARI Evidence Engine: Calls Table

*Goal: lift behavioral confidence from ~0.70 (co-occurrence) to ~0.90+ (directed call
graph) — the threshold needed for `mode: error` in CI.*

| Task | Effort | Value | Status |
|------|--------|-------|--------|
| `calls` table in CARI SQLite schema | S | Very High | ✅ (`symbol_calls` table) |
| AX extractor (tree-sitter) extension: emit call edges as `calls` rows | L | Very High | ✅ |
| Incremental: only recompute calls for files with changed `body_hash` | M | High | ✅ |
| Behavioral `must_call` checks use `calls` table → promote to `mode: error` | M | High | ✅ (0.95 conf / error) |
| `iw index trace --entry <file>` — entry-point call path tracing | L | High | ✅ |
| Entry-point tracing in Insights Book (behavioral coverage per use-case) | M | Medium | — deferred |
| Rule coverage monitoring: flag packages with zero behavioral rules | M | Medium | ✅ |

**Calls table schema:**
```sql
CREATE TABLE calls (
  id            INTEGER PRIMARY KEY,
  caller_file   TEXT NOT NULL,
  caller_symbol TEXT NOT NULL,
  caller_line   INTEGER NOT NULL,
  callee_file   TEXT,
  callee_symbol TEXT NOT NULL,
  callee_line   INTEGER,
  call_kind     TEXT NOT NULL   -- 'direct' | 'method' | 'constructor' | 'dynamic'
);
```

**Estimated wall time:** 2–3 weeks (AX extractor work is the majority)

---

## Phase 5 — Intent Chat (future)

*Goal: make rule authoring conversational. "Our auth flow should always route through
AuthService" → preview check → confirm → committed to rules.yaml.*

This phase has its own ADR (to be written when Phase 4 is stable).

| Component | Notes |
|-----------|-------|
| Chat client (CLI or web) | Input: natural language intent |
| Rule draft generation | LLM → structured `rules.yaml` entry |
| Preview check | Run `iw intent check --dry-run` on the draft rule before committing |
| Human confirmation | User sees the violations the rule would catch, confirms or refines |
| Commit to `rules.yaml` | Append, version, human-review gate |
| Model independence | Rule is extracted once; enforcement never calls the LLM again |

**This is the same extraction pipeline with a conversational UI.** The Intent Runtime
(enforcement) is completely unchanged. The chat client is an authoring accelerator.

**Estimated wall time:** design ADR first; estimate after Phase 4 ships.

---

## Value / Effort Summary

| Phase | Key deliverable | Effort | Value | Unlocks |
|---|---|---|---|---|
| 0 — Restructure | Legible product | Low | High | Adoption |
| 1 — Intent Foundation | Documentary domain in CI | Medium | High | Living Docs enforcement |
| 2 — Insights Book | Executive Summary + Recommendations | Medium | Very High | Shareable deliverable |
| 3 — Mermaid Rules | Behavioral rules from diagrams | Medium | Very High | Zero-cost rule authoring |
| 4 — Calls Table | ~0.90 behavioral confidence | High | High | Behavioral `mode: error` |
| 5 — Intent Chat | Conversational rule authoring | High | Medium | Onboarding acceleration |

---

## What Stays Stable

The following are not on the roadmap — they are foundations that don't change:

- `iw index *` command surface — the CARI power API stays exactly as-is
- `rules.yaml` YAML check types (structural domain) — backward-compatible only
- SQLite schema for existing tables — additive only, no migrations
- All existing MCP tools — aliases kept, none removed

---

## Not On This Roadmap

Explicitly out of scope to avoid scope creep:

- Code generation from intent (spec-driven development direction)
- Full TypeScript type inference in the call graph (too costly, diminishing returns)
- Replacing ESLint/Biome for style/syntax checks
- Building a documentation generator (TypeDoc direction)
- Real-time (watch mode) enforcement — CI-per-PR is the target model
