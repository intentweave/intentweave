# Layered Graph Architecture

> **Version:** 0.2  
> **Status:** Draft / Proposal  
> **Date:** 2025-07-14  
> **Scope:** Multi-layer context graph design for IntentWeave — evidence-first architecture, temporal signals, drift detection, use cases, and competitive landscape

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Layer Stack Overview](#3-layer-stack-overview)
4. [Layer Definitions](#4-layer-definitions)
   - 4.1 [Layer 0: FILE — File Structure](#41-layer-0-file--file-structure)
   - 4.2 [Layer 1: KWG — Keyword Co-occurrence Graph](#42-layer-1-kwg--keyword-co-occurrence-graph)
   - 4.3 [Layer 2: SCG — Static Code Graph](#43-layer-2-scg--static-code-graph)
   - 4.4 [Layer 3: SKG — Semantic Knowledge Graph](#44-layer-3-skg--semantic-knowledge-graph)
   - 4.5 [Layer 4: DCG — Dynamic Code Graph](#45-layer-4-dcg--dynamic-code-graph)
   - 4.6 [Cross-cutting: TCG — Temporal Change Graph](#46-cross-cutting-tcg--temporal-change-graph)
   - 4.7 [Cross-cutting: Drift & Alignment Detectors](#47-cross-cutting-drift--alignment-detectors)
   - 4.8 [Cross-cutting: Vectors, Persistence, Validation](#48-cross-cutting-vectors-persistence-validation)
5. [Stage Architecture](#5-stage-architecture)
   - 5.1 [Naming Convention](#51-naming-convention)
   - 5.2 [Stage Reference](#52-stage-reference)
   - 5.3 [Mapping: Legacy → New Stage Names](#53-mapping-legacy--new-stage-names)
   - 5.4 [CLI Surface](#54-cli-surface)
6. [Cross-layer Linking](#6-cross-layer-linking)
7. [Neo4j Schema](#7-neo4j-schema)
8. [Co-occurrence & Envelope Entities](#8-co-occurrence--envelope-entities)
   - 8.1 [Sentence-level Co-occurrence](#81-sentence-level-co-occurrence)
   - 8.2 [Sliding Window](#82-sliding-window)
   - 8.3 [Envelope Entities (Concept Clusters)](#83-envelope-entities-concept-clusters)
   - 8.4 [Verb Extraction (OpenIE-lite) — Weak Hints, Not Semantics](#84-verb-extraction-openie-lite--weak-hints-not-semantics)
9. [Vector Embeddings](#9-vector-embeddings)
10. [Use Case Analysis](#10-use-case-analysis)
11. [Competitive Landscape](#11-competitive-landscape)
12. [Progressive Enrichment Workflow](#12-progressive-enrichment-workflow)
13. [Strategy: Open Source](#13-strategy-open-source)
14. [Product vs. Framework Surface](#14-product-vs-framework-surface)
15. [Roadmap & Open Questions](#15-roadmap--open-questions)

---

## 1. Executive Summary

**IntentWeave builds a context graph, not just a semantic graph.**

It preserves _where_ things were said, _how_ they connect structurally, _when_ they changed, and
_whether_ they still align — before any LLM ever touches the data.

Today, most knowledge-graph-from-documents tools require LLM extraction to produce anything useful.
The result is expensive, non-deterministic, and lossy: assertions are compressed to flat triples,
uncertainty and perspective are discarded, and different mentions of the same concept are unified
too early. The graph captures conclusions but loses the evidence.

IntentWeave takes a different approach. The **non-LLM path** is not a cheap approximation of the
semantic graph — it is a fundamentally different, complementary artifact: an **evidence-rich context
graph** that records _mentions_ (who said what, where, in what section, under which heading),
_structural relationships_ (what calls what, what imports what, how the API surface looks),
_temporal signals_ (what changed together, what's stale, who owns what), and _drift indicators_
(where documentation and code have diverged). This graph is deterministic, complete, and $0.

The **LLM path** (SKG) then becomes an optional overlay — a selective enrichment that adds semantic
predicates (decisions, alternatives, trade-offs) to the evidence already captured by the lower
layers. You don't need it to start. You invest in it where it matters.

This document proposes a **five-layer architecture** plus cross-cutting capabilities:

| Layer | Name     | What it captures                                                      | Cost        |
| ----- | -------- | --------------------------------------------------------------------- | ----------- |
| 0     | **FILE** | Directory structure, file metadata                                    | $0, <1s     |
| 1     | **KWG**  | Mentions, co-occurrence, signal qualifiers, concept clusters          | $0, 1–3s    |
| 2     | **SCG**  | AST structure, API surface, dependencies, test coverage, config       | $0, 1–5min  |
| 3     | **SKG**  | Semantic predicates (LLM) — decisions, trade-offs, alternatives       | $$, 2–60min |
| 4     | **DCG**  | Runtime behavior — call chains, data flow, hot paths                  | $0, future  |
| ⏱     | **TCG**  | Temporal/change signals from git — co-evolution, staleness, ownership | $0, 1–3min  |

The key innovations in this design:

1. **Mentions as first-class citizens** — every keyword occurrence is a `:Mention` node carrying
   source file, section, heading, sentence index, document type, and commit context. The graph
   preserves _evidence_, not just extracted assertions.

2. **Temporal Change Graph (TCG)** — git history produces co-change relationships, hotspot
   detection, ownership maps, staleness signals, and decision volatility without LLM involvement.

3. **Drift & Alignment Detectors** — instead of pseudo-semantic predicates, the non-LLM layers
   use structural comparisons to detect where docs and code have diverged (doc↔code drift,
   dependency drift, temporal drift).

4. **Progressive enrichment** — start with evidence (KWG + SCG + TCG), detect problems (drift
   detectors), then selectively invest LLM tokens (SKG) only where the evidence signals warrant it.

IntentWeave is built in public as **Apache-2.0 OSS**. The moat is consultancy, integration
services, and a future SaaS offering — not the code itself. Everything lives in the `@intentweave`
package ecosystem, offered both as a **product** (CLI, server, UI) and as a **framework**
(composable TypeScript libraries). All layers — including vector embeddings — can run with
zero paid API dependencies using free local models.

---

## 2. Problem Statement

### The LLM knowledge graph trap

Most "knowledge graph from documents" tools follow the same pattern: feed text to an LLM, extract
(subject, predicate, object) triples, deduplicate, persist. The result _looks_ like a knowledge
graph, but it loses critical context:

| What's lost              | Why it matters                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Source location**      | "Where was this said?" — the triple floats free of its document/section/sentence                             |
| **Assertion context**    | Was it a decision? A proposal? A deprecated idea? A plan? The triple doesn't say.                            |
| **Temporal context**     | When was it written? Has the source changed since extraction? Is it still true?                              |
| **Perspective**          | Who said it? In which document? Under what heading? Different authors may disagree.                          |
| **Mention multiplicity** | "AuthService" mentioned 47 times across 12 files is collapsed to one entity. The distribution IS the signal. |
| **Uncertainty**          | LLM confidence is binary (extract or don't). Real knowledge has gradients.                                   |

The LLM graph captures _conclusions_ but loses _evidence_. You can query "what depends on what" but
not "where does the documentation say this" or "how stale is this assertion."

### Current gaps in IntentWeave

| Gap                                                                      | Impact                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Keyword scan is flat (entity → file, no entity ↔ entity edges)           | Can't traverse relationships without LLM extraction                                       |
| No mention-level granularity                                             | Can't answer "where exactly was X discussed?" — only "which file mentions X"              |
| No temporal signals from git history                                     | Can't detect staleness, co-evolution, ownership, or decision volatility                   |
| No drift detection between doc and code                                  | `doc-health` requires KG; the non-LLM path can't detect structural divergence             |
| Stage names are opaque (IN, FX, KX, GX, RX, CX, MX, PX)                  | Users can't intuit what the pipeline does                                                 |
| No formal layer separation                                               | KWG, SCG, SKG data intermixed; unclear which layer asserted which edge                    |
| AST extraction exists (AX stage) but isn't integrated into a named layer | Code structure graph isn't a first-class citizen                                          |
| SCG captures only basic structure                                        | Missing: API surface, test coverage relations, config graph, build/runtime wiring, schema |
| No path to dynamic analysis                                              | Control flow, data flow, runtime traces have no place in the architecture                 |

### Design goals

1. **Evidence-first** — the non-LLM path captures _where, when, how often, and by whom_ things are said
2. **Progressive cost curve** — useful context graph at $0, richer at each investment level
3. **Independent layers** — rebuild KWG without touching SKG, re-run SCG after refactoring without LLM cost
4. **Temporal awareness** — git history as a first-class signal source (co-change, staleness, ownership)
5. **Drift detection** — structural comparison detects doc↔code divergence without LLM
6. **Provenance** — every edge carries its layer origin; queries can filter by confidence/layer
7. **Transparent stages** — human-readable names, clear input→output contracts, visible progress
8. **Composable queries** — "entities in KWG but not SKG" = candidates for next `iw run`
9. **SKG as overlay** — LLM extraction enriches the evidence graph, it doesn't replace it

---

## 3. Layer Stack Overview

```
Cost/Richness ▲
              │
   Layer 4    │  DCG: Dynamic Code Graph (control + data flow)   ── future
   Layer 3    │  SKG: Semantic Knowledge Graph (LLM overlay)     ── iw build skg
              │  ────── cross-links: SKG ↔ SCG (iw xlink) ─────
   Layer 2    │  SCG: Static Code Graph (AST, 6 sub-graphs)     ── iw build scg
              │  ────── cross-links: KWG ↔ SCG (name match) ───
   Layer 1    │  KWG: Keyword Mention Graph (evidence-first)    ── iw build kwg
   Layer 0    │  FILE: File Structure (dirs, files, imports)     ── implicit
              │
   Cross-cut  │  TCG: Temporal Change Graph (git history)        ── iw build tcg
              │  Drift Detectors: doc↔code, dep, temporal        ── iw doc-health
              └──────────────────────────────────────────────────▶  Cost ($, time)
                free/seconds                                       $$$/hours
```

### Key properties per layer

| Layer   | Cost     | Time     | Deterministic | Requires LLM | Provides                                                        | Refresh trigger            |
| ------- | -------- | -------- | ------------- | ------------ | --------------------------------------------------------------- | -------------------------- |
| 0: FILE | $0       | <1s      | Yes           | No           | Containment edges, metadata                                     | Any file change            |
| 1: KWG  | $0       | 1–3s     | Yes           | No           | Mentions, co-occurrence, clusters, signal qualifiers            | Doc/code change            |
| 2: SCG  | $0       | 1–5 min  | Yes           | No           | AST structure, API surface, deps, test coverage, config, schema | Code file change           |
| 3: SKG  | $0.30–5+ | 2–60 min | No (LLM)      | Yes          | 30 semantic predicates (decisions, trade-offs, alternatives)    | Explicit `iw build skg`    |
| 4: DCG  | $0       | Varies   | Yes (runtime) | No           | Runtime call chains, data flow, hot paths                       | Test execution / profiling |
| ⏱ TCG   | $0       | 1–3 min  | Yes           | No           | Co-change, hotspots, staleness, ownership, stability            | Git commit                 |

### The evidence → enrichment principle

```
┌─────────────────────────────────────────────────────────────────────┐
│  Evidence Layers (deterministic, $0)                                │
│  KWG: Where is it mentioned? How often? In what context?            │
│  SCG: What does the code actually look like? API surface?           │
│  TCG: When did it change? What changed together? Who owns it?       │
│                                                                     │
│  Drift Detectors (computed, $0)                                     │
│  Doc mentions API endpoint X, but code shows endpoint X was         │
│  renamed to Y three commits ago.                                    │
│                                                                     │
│  Enrichment Layer (LLM, $$)                                         │
│  SKG: What does this design *mean*? What decisions were made?       │
│  → Only run where drift detectors or high mention density suggests  │
│    the semantic investment is worthwhile.                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Layer Definitions

### 4.1 Layer 0: FILE — File Structure

**What it produces:** Directory tree, file metadata (size, mtime, content hash), basic containment.

**Nodes:** `:File {filePath, name, size, contentHash, mtime}`, `:Dir {filePath, name}`  
**Edges:** `(:Dir)-[:CONTAINS]->(:File|:Dir)`

**Current implementation:** Implicit in IN stage (chunking). File discovery happens in every pipeline
run. Content hashes used for incremental caching.

**Refresh cadence:** Every build. Near-instant.

---

### 4.2 Layer 1: KWG — Keyword Mention Graph (Evidence-first)

**What it produces:** An evidence-rich graph where every keyword occurrence is a **Mention** — a
first-class node that carries source file, section, heading, sentence index, document type, and
context qualifiers. Mentions are linked to keyword entities, file nodes, and to each other via
co-occurrence. Densely connected keywords form concept clusters.

**Core principle: Mentions are evidence, not noise.** The distribution of mentions _is_ the signal.
"AuthService mentioned 47 times across 12 files" is not a count to collapse — it's an evidence
pack that tells you about centrality, ownership, and concern boundaries.

**Four sub-stages:**

| Stage               | Input                                   | Output                                    | Cost      |
| ------------------- | --------------------------------------- | ----------------------------------------- | --------- |
| `scan-keywords`     | Files + keyword patterns                | Entity → file locations + mention nodes   | $0, ~1s   |
| `extract-mentions`  | Source text + entities                  | `:Mention` nodes with full source context | $0, ~0.5s |
| `link-cooccurrence` | Mention-enriched entities + source text | CO_OCCURS edges with weights              | $0, ~0.5s |
| `detect-clusters`   | Co-occurrence graph                     | Envelope entities (concept clusters)      | $0, ~0.1s |

**Nodes:**

```
:KW:Entity {
  name,                    // canonical keyword name
  frequency,               // total mention count across all files
  firstSeen,               // earliest file mtime containing this keyword
  session_id
}

:KW:Mention {
  text,                    // the actual text matched (preserves casing, context)
  filePath,                // source file
  section,                 // enclosing markdown section or code block
  heading,                 // nearest heading (## Decision: Use Neo4j)
  sentenceIdx,             // sentence position within section
  docType,                 // 'spec' | 'readme' | 'adr' | 'code' | 'config' | 'test' | 'comment'
  lineNumber,              // line in source file
  qualifiers,              // signal qualifiers: ['decision', 'must', 'deprecated', 'planned', ...]
  session_id
}

:KW:Doc {filePath, contentHash, mtime, session_id}
:KW:SourceFile {filePath, language, session_id}
:KW:Cluster {label, memberCount, cohesion, session_id}
```

**Edges:**

```
(:KW:Doc)-[:KW_MENTIONS {count, positions}]->(:KW:Entity)         // doc contains keyword
(:KW:SourceFile)-[:KW_CONTAINS {count}]->(:KW:Entity)             // source file contains keyword
(:KW:Entity)-[:HAS_MENTION]->(:KW:Mention)                        // entity → individual mentions
(:KW:Mention)-[:APPEARS_IN]->(:KW:Doc|:KW:SourceFile)             // mention → source file
(:KW:Mention)-[:DEFINED_BY {heading, section}]->(:KW:Doc)         // mention → defining section
(:KW:Entity)-[:CO_OCCURS {weight, window, sources}]->(:KW:Entity) // co-occurrence
(:KW:Cluster)-[:CLUSTER_MEMBER]->(:KW:Entity)                     // cluster membership
```

#### Signal Qualifiers

Instead of verb extraction (which produces pseudo-semantic predicates), the KWG detects **context
qualifiers** — lightweight flags that describe the _kind of context_ a mention appears in:

| Qualifier     | Detection pattern                                                       | What it signals                                   |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| `decision`    | "decided for/against/on", "chose X over Y", heading contains "Decision" | This mention is part of a design decision         |
| `deprecated`  | "deprecated", "legacy", "will be removed", "do not use"                 | This mention refers to something being phased out |
| `planned`     | "planned", "future", "will be", "TODO", "roadmap"                       | This mention refers to something not yet built    |
| `must`        | "must", "required", "mandatory", "shall"                                | This mention carries a requirement/constraint     |
| `should`      | "should", "recommended", "prefer"                                       | This mention carries a recommendation             |
| `alternative` | "alternatively", "instead of", "or we could", "option"                  | This mention discusses alternatives               |
| `risk`        | "risk", "concern", "caveat", "warning", "careful"                       | This mention flags a risk or concern              |
| `example`     | "example", "e.g.", "for instance", code block context                   | This mention is illustrative, not normative       |

The qualifiers enrich mentions without attempting to build semantic predicates. They are _tags on
evidence_, not _assertions about meaning_.

**Current implementation (Phase A — ✅ Complete):**

- `HeuristicKeywordExtractor` → `runKwxStage()` — mentions with qualifiers, heading/section context
- `SlidingWindowCoOccurrence` → `runCoxStage()` — per-doc co-occurrence, session-level aggregation
- `detectClusters()` → `runClxStage()` — connected-component clusters with envelope entities
- `persistKwg()` — Neo4j persist: `:KW:Entity`, `:KW:Mention`, `:KW:Doc`, `:KW:Cluster` nodes + edges
- `iw build kwg` CLI — `iw build kwg <paths...> --session X [--persist] [-v]`
- ONNX vector embeddings on entities + clusters (Phase D-6/D-7)

---

### 4.3 Layer 2: SCG — Static Code Graph (6 Sub-graphs)

**What it produces:** Full AST-derived code structure — not just classes and functions, but the
complete structural picture: API surfaces, dependency chains, test coverage maps, configuration
graphs, build/runtime wiring, and schema definitions.

**Six sub-graphs:**

| Sub-graph                   | What it captures                                                          | Nodes/Edges                                                     |
| --------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Core AST**                | Classes, functions, methods, variables, types, modules                    | `:Entity:Class`, `CALLS`, `EXTENDS`, `IMPLEMENTS`               |
| **API Surface**             | Exported symbols, route definitions, handler signatures, public contracts | `:API:Endpoint`, `:API:ExportedSymbol`, `EXPOSES`, `HANDLES`    |
| **Dependency Graph**        | Package dependencies, import chains, circular dependency detection        | `:Dep:Package`, `DEPENDS_ON`, `IMPORTS`, `CYCLES_WITH`          |
| **Test Coverage Relations** | Which tests cover which functions/classes, test↔code mapping              | `:Test:Suite`, `:Test:Case`, `TESTS`, `COVERS`                  |
| **Config Graph**            | Environment variables, config file references, feature flags              | `:Config:Var`, `:Config:File`, `CONFIGURED_BY`, `FEATURE_FLAGS` |
| **Build/Runtime Wiring**    | Entry points, build targets, Docker services, CI steps                    | `:Build:Target`, `:Runtime:Service`, `WIRED_TO`, `STARTS`       |

**Core stages (existing):**

| Stage           | Input                         | Output                                             | Cost         |
| --------------- | ----------------------------- | -------------------------------------------------- | ------------ |
| `parse-ast`     | Source files                  | AST nodes (classes, functions, methods, variables) | $0, ~minutes |
| `resolve-refs`  | AST nodes + import statements | Cross-file references, call edges                  | $0, ~seconds |
| `link-code-kwg` | SCG entities + KWG entities   | Joins on (filePath, name)                          | $0, ~seconds |

**Extended stages (new):**

| Stage                 | Input                                 | Output                             | Cost         |
| --------------------- | ------------------------------------- | ---------------------------------- | ------------ |
| `extract-api-surface` | Exported symbols + route patterns     | API endpoint map, public contracts | $0, ~seconds |
| `map-test-coverage`   | Test files + source files             | Test↔code coverage links           | $0, ~seconds |
| `scan-config`         | Config files + env references in code | Config→code dependency map         | $0, ~seconds |
| `map-build-wiring`    | package.json, Dockerfile, CI configs  | Build target graph                 | $0, ~seconds |

**Core AST Nodes:** `:Entity:Class`, `:Entity:Function`, `:Entity:Method`, `:Entity:Variable`,
`:Entity:Interface`, `:Entity:Type`, `:Entity:Module`, `:Entity:File`

**Core AST Edges:** `CONTAINS`, `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `USES`, `DEPENDS_ON`

**API Surface Example:**

```cypher
// Route definition → handler function → dependencies
(:API:Endpoint {method: 'POST', path: '/api/login'})
  -[:HANDLES]->(:Entity:Function {name: 'handleLogin'})
    -[:CALLS]->(:Entity:Method {name: 'validate', class: 'AuthService'})
    -[:CALLS]->(:Entity:Method {name: 'createToken', class: 'TokenManager'})
```

**Test Coverage Example:**

```cypher
// Test suite → covers code entities
(:Test:Suite {filePath: 'tests/auth.test.ts'})
  -[:COVERS]->(:Entity:Class {name: 'AuthService'})
(:Test:Case {name: 'should validate JWT'})
  -[:TESTS]->(:Entity:Method {name: 'validate', class: 'AuthService'})
```

**Current implementation (Phase E — ⏳ Next Priority):**

- ✅ AX stage (`ax.ts`) — tree-sitter extraction for TypeScript/JS and Swift. Produces
  `AxSymbol` objects with stable IDs (`impl:<path>#<kind>:<name>`).
- ✅ `iw code` CLI — runs AX extraction, outputs `.iw/ax.json`, optional spec linking
- ✅ AX runs inside `iw build cheap` and `iw build full` (in-memory, used by drift detectors)
- ❌ **No Neo4j persistence** — AX output is JSON-only, not queryable via Cypher
- ❌ **No SCG_IMPORTS edges** — ast-extractor extracts imports but AX doesn't persist cross-file links
- ❌ Extended sub-graphs (API Surface, Test Coverage, Config, Build/Runtime) not yet implemented
- Reference: `codegraphchat-v2/packages/cli/src/scg/scgPersist.ts` for SCG Neo4j model

**AX Output Contract (`packages/analyzer/src/stages/ax.ts`):**

The AX stage is language-agnostic. New languages are contributed via `LanguageAdapter` plugins
discovered at runtime by `LanguageRegistry`. The entry point is `runAxStage(options)`.

| Type / Function          | Role                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `runAxStage`             | Main entry point — dispatches to `LanguageRegistry`, writes `ax.json`                                          |
| `runAxStageIncremental`  | Incremental variant — skips unchanged files using `contentHash`                                                |
| `AxStageOptions`         | Input config: `workspaceRoot`, `include/exclude` globs, `extraAdapters` for language plugins                   |
| `AxOutput`               | Top-level output: `version`, `workspaceRoot`, `totalFiles`, `totalSymbols`, `files[]`, `stats`                 |
| `AxFileResult`           | Per-file result: `filePath`, `contentHash`, `language`, `symbols[]`, `imports[]`, `todos[]`, `rationale[]`     |
| `AxSymbol`               | One extracted symbol: `id` (`impl:<path>#<kind>:<name>`), `kind`, `name`, `isExported`, `body`/`structureHash` |
| `AxImport`               | One import statement: `moduleSpecifier`, `resolvedPath`, `isRelative`, `importedNames[]`                       |
| `AxTodo`                 | TODO/FIXME/HACK/XXX marker: `line`, `kind`, `text`                                                             |
| `AxRationale`            | WHY/NOTE/IMPORTANT/DESIGN comment: `line`, `kind`, `text`                                                      |
| `LanguageAdapter`        | Interface plugins must implement: `supports(file)`, `extract(file, options)` → `AxFileResult`                  |
| `LanguageRegistry`       | Runtime adapter registry — `register(adapter)`, `getAdapter(filePath)`, `extractFile(...)`                     |
| `createLanguageRegistry` | Factory; registers the built-in TypeScript/JS adapter and any `extraAdapters` from options                     |

**SCG ↔ KWG cross-link:** This is a **query-time join**, not a build step. When `AuthService`
appears as a KWG keyword in `src/auth.ts`, and the SCG has `Entity:Class{name:"AuthService"}` in
`src/auth.ts`, the link is: same file path + same name. No separate extraction needed.

```cypher
// Query-time join: KWG entity realized by SCG entity
MATCH (kw:KW:Entity), (scg:Entity)
WHERE kw.name = scg.name
AND kw.filePath = scg.filePath
RETURN kw.name, scg.type, scg.filePath
```

---

### 4.4 Layer 3: SKG — Semantic Knowledge Graph (Optional LLM Overlay)

**What it produces:** Canonicalized entities with typed, directed relationships extracted by LLMs.
Rich semantic meaning: decisions, dependencies, alternatives, trade-offs.

**Position in the architecture:** The SKG is an **optional enrichment layer**, not the foundation.
The evidence layers (KWG + SCG + TCG) provide the structural, temporal, and mention-level context.
The SKG adds _semantic interpretation_ — "what does this design mean?" — on top of that evidence.

**When to invest in SKG:**

- Drift detectors flag high-divergence areas → those need semantic understanding
- KWG mentions with `decision` qualifiers → worth extracting the full decision graph
- High-degree KWG entities → central concepts that benefit from structured predicates
- Agent queries that evidence layers can't answer ("why was X chosen over Y?")

**When SKG is NOT needed:**

- "Where is X mentioned?" → KWG handles this (mentions + file locations)
- "What calls X?" → SCG handles this (AST call graph)
- "Is this doc stale?" → TCG + drift detectors handle this (git timestamps + structural comparison)
- "What changed recently?" → TCG handles this (git history)

**Stages:**

| Stage               | Input                         | Output                                      | Cost                              |
| ------------------- | ----------------------------- | ------------------------------------------- | --------------------------------- |
| `chunk-docs`        | Documents                     | Semantic chunks (~16k chars)                | $0, ~seconds                      |
| `extract-triples`   | Chunks                        | Raw triples (subject, predicate, object)    | $$, parallel LLM calls            |
| `canonicalize`      | Raw triples                   | Normalized Canon entities + predicates      | $$, batch LLM calls               |
| `merge-global`      | Canon entities across docs    | Deduplicated entities (exact + fuzzy merge) | $0, algorithmic                   |
| `link-code-skg`     | Canon entities + SCG entities | `:REALIZED_BY` edges                        | $0, name/import/dep/path matching |
| `link-evidence-skg` | Canon entities + KWG mentions | `:EVIDENCED_BY` edges                       | $0, name/position matching        |

**Nodes:** `:Canon:Entity {name, type, canonId, aliases, confidence, session_id, embedding?}`  
**Edges:** `(:Canon:Entity)-[:CANON_REL {predicate, confidence, source}]->(:Canon:Entity)`

**Evidence linking (new):** Each Canon entity links back to the KWG mentions that support it:

```cypher
(:Canon:Entity)-[:EVIDENCED_BY {confidence, mentionCount}]->(:KW:Mention)
```

This preserves provenance: "Canon entity 'AuthService' was extracted from these 47 mentions across
these 12 files." The LLM's assertion is grounded in observable evidence.

**30 canonical predicates:** CONTAINS, DEPENDS_ON, ALTERNATIVE_TO, IMPLEMENTS, EXTENDS, IS_A,
DESCRIBES, HAS_PROPERTY, HAS_STATE, HAS_PHASE, TRANSITIONS_TO, TRIGGERS, PRECEDES, FOLLOWS,
DECIDED_FOR, DECIDED_AGAINST, SUPERSEDES, MOTIVATED_BY, ENABLES, BLOCKS, RISKS, DEFERRED_TO,
PROPOSED_FOR, REPLACES, REQUIRES, CALLS, USES, PRODUCES, CONSUMES, RELATED_TO.

**Note on the 30 predicates:** These are valuable for rich semantic queries ("what decisions were
made?", "what are the alternatives?") but they are NOT the product's front door. The front door is
the evidence graph + drift detection. The predicates enrich areas where deeper understanding is
needed.

**Current implementation (Phases A+D — ✅ Complete):**

- `in.ts` → `chunk-docs` (semantic markdown splitting)
- `fx.ts` → `extract-triples` (parallel LLM extraction, incremental cache)
- `kx.ts` → `canonicalize` (batch LLM normalization, incremental cache)
- `gx.ts` → `merge-global` (Levenshtein + alias overlap)
- `crossLayerLinker.ts` → `link-code-skg` (4 strategies: dep, import, name, path)
- `evidenceLinker.ts` → `link-evidence-skg` (Canon → KWG mentions via name match)
- `triageAnalyzer.ts` → evidence-guided triage scoring for selective SKG extraction
- `iw build full` → 5-stage orchestrator: CHEAP → TRIAGE → SKG → LINK → EMBED
- ONNX vector embeddings on Canon entities (Phase D-6/D-7)

---

### 4.5 Layer 4: DCG — Dynamic Code Graph

**What it produces:** Runtime behavior — actual call chains, data flow paths, execution frequencies,
hot paths, dead code (runtime-confirmed).

**Stages (future):**

| Stage              | Input                               | Output                                 | Cost                   |
| ------------------ | ----------------------------------- | -------------------------------------- | ---------------------- |
| `trace-calls`      | Instrumented code / profiling       | Runtime call graph                     | $0, requires execution |
| `trace-dataflow`   | Taint tracking / data flow analysis | Data flow edges                        | $0, requires execution |
| `link-dynamic-scg` | DCG traces + SCG entities           | Overlay edges confirming/extending SCG | $0, join               |

**Nodes:** `:Runtime:Call {caller, callee, count, avgDuration}`,
`:Runtime:DataFlow {source, sink, path}`  
**Edges:** `(:Entity:Function)-[:INVOKES {count, avgMs}]->(:Entity:Function)`,
`(:Entity:Variable)-[:FLOWS_TO]->(:Entity:Variable)`

**Current implementation:** None. Future layer.

**Value:** Confirms or refutes SCG edges (static call graph says A calls B — does it actually at
runtime?), discovers dynamic dispatch, callback chains, event-driven flows that static analysis
misses.

---

### 4.6 Cross-cutting: TCG — Temporal Change Graph (Git History)

The TCG is not a numbered layer — it is a **cross-cutting temporal dimension** that enriches all
other layers with time-awareness. It extracts signals from git history without any LLM involvement.

**What it produces:** Co-change relationships, hotspot detection, ownership maps, staleness signals,
decision volatility indicators, and stability metrics — all derived from commit history.

**Stages:**

| Stage              | Input                                 | Output                                | Cost         |
| ------------------ | ------------------------------------- | ------------------------------------- | ------------ |
| `extract-commits`  | Git log (configurable depth)          | `:Commit` nodes with metadata         | $0, ~seconds |
| `map-co-changes`   | Commit→file associations              | `CO_CHANGED_WITH` edges between files | $0, ~seconds |
| `detect-hotspots`  | Commit frequency per file/entity      | Hotspot scores, churn rates           | $0, ~seconds |
| `map-ownership`    | Author→file→frequency                 | Ownership scores per file/entity      | $0, ~seconds |
| `detect-staleness` | File mtime vs. related doc/code mtime | Staleness signals                     | $0, ~seconds |

**Nodes:**

```
:TCG:Commit {
  hash,                    // git commit hash
  author,                  // commit author
  date,                    // commit timestamp
  message,                 // commit message (first line)
  session_id
}

:TCG:FileVersion {
  filePath,                // file path at this commit
  commitHash,              // which commit
  changeType,              // 'added' | 'modified' | 'deleted' | 'renamed'
  linesAdded,              // +N lines
  linesRemoved,            // -N lines
  session_id
}

:TCG:Author {
  name,                    // author name
  email,                   // author email
  session_id
}
```

**Edges:**

```
(:TCG:Commit)-[:MODIFIED {changeType, linesAdded, linesRemoved}]->(:File)
(:TCG:Commit)-[:AUTHORED_BY]->(:TCG:Author)
(:TCG:Author)-[:OWNS {score, commitCount, lastTouch}]->(:File)
(:File)-[:CO_CHANGED_WITH {frequency, commits}]->(:File)              // co-evolution
(:KW:Entity)-[:INTRODUCED_IN]->(:TCG:Commit)                          // entity first appearance
(:KW:Entity)-[:LAST_TOUCHED_IN]->(:TCG:Commit)                        // entity last modification
```

**Temporal signals derived:**

| Signal                  | What it measures                                        | How it's computed                                            |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| **Hotspot**             | Files/entities that change disproportionately often     | Commit frequency normalized by age                           |
| **Co-evolution**        | Files that always change together (hidden coupling)     | Jaccard similarity on commit sets                            |
| **Staleness**           | Doc last modified 6 months ago, code modified yesterday | `max(code_mtime) - max(doc_mtime)` per entity                |
| **Decision volatility** | Areas where decisions keep changing                     | Count of mention-with-`decision`-qualifier changes over time |
| **Ownership clarity**   | Whether a file/area has a clear owner or is "nobody's"  | Gini coefficient of commit distribution per author           |
| **Stability**           | Mature, settled areas vs. areas in active flux          | Exponential decay of change frequency                        |

**Git depth configuration:**

```bash
# Default: last 6 months of history
iw build tcg --session X --persist

# Full history (slower, richer co-evolution signals)
iw build tcg --session X --depth full --persist

# Last 100 commits
iw build tcg --session X --depth 100 --persist
```

**Current implementation (Phase B — ✅ Complete):**

- `extractCommits()` → git log parser with configurable depth
- `mapCoChanges()` → `CO_CHANGED_WITH` edges with Jaccard confidence
- `detectHotspots()` → churn rate scoring, recency-weighted
- `mapOwnership()` → author → file ownership with commit count + recency
- `detectStaleness()` → doc vs. code mtime comparison per entity
- `persistTcg()` → Neo4j persist: `:TCG:Commit`, `:TCG:Author`, `:TCG:FileVersion` nodes + edges
- `iw build tcg` CLI — `iw build tcg --session X [--persist] [--depth N] [-v]`

---

### 4.7 Cross-cutting: Drift & Alignment Detectors

Drift detectors are **computed comparisons** between layers (and within layers over time). They
don't compute new graph structure — they flag discrepancies in the existing graph. They replace
the need for pseudo-semantic predicates in the non-LLM path.

**Core principle:** Instead of trying to extract "DEPENDS_ON" from text (which requires understanding
meaning), detect that "the documentation mentions entity X but the code no longer has it" (which
requires only structural comparison).

**Three detector categories:**

#### 4.7.1 Doc ↔ Code Drift

Compares KWG (document mentions) against SCG (code structure) to find divergences.

| Drift signal           | Detection method                                                                 | Example                                                                  |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Ungrounded mention** | KWG entity in docs, no matching SCG entity                                       | Doc says "PaymentGateway" but no such class/function exists              |
| **Undocumented code**  | SCG entity exists, no KWG mentions in docs                                       | `TokenRefresher` class has no documentation                              |
| **Signature mismatch** | KWG mention says `authenticate(token)`, SCG shows `authenticate(token, options)` | API signature changed, docs not updated                                  |
| **Renamed entity**     | KWG mentions name A, SCG entity renamed to B (detected via git)                  | Code changed from `UserAuth` to `AuthService`, docs still say `UserAuth` |
| **Deleted entity**     | KWG mentions entity, TCG shows it was deleted N commits ago                      | Doc references removed function                                          |

#### 4.7.2 Dependency & Architecture Drift

Compares SCG structure against documented architecture / package boundaries.

| Drift signal              | Detection method                                         | Example                               |
| ------------------------- | -------------------------------------------------------- | ------------------------------------- |
| **Undeclared dependency** | SCG shows import A→B, package.json doesn't declare B     | Transitive dependency used directly   |
| **Circular dependency**   | SCG import cycle detected                                | A imports B imports C imports A       |
| **Boundary violation**    | SCG shows cross-package import that violates layer rules | `ui/` imports from `server/internals` |
| **Dead export**           | SCG entity is exported but never imported by anyone      | Public API surface pollution          |
| **Missing test coverage** | SCG entity exists, no `:Test:Case` → COVERS edge         | Critical function with no tests       |

#### 4.7.3 Temporal Drift

Uses TCG signals to detect time-based divergence.

| Drift signal              | Detection method                                                      | Example                                                |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| **Stale documentation**   | Doc mtime >> code mtime for shared entities                           | Doc last updated 6 months ago, code updated 2 days ago |
| **Decision volatility**   | Entity with `decision` qualifier changes > N times in M days          | Team keeps flip-flopping on database choice            |
| **Ownership vacuum**      | No single author has >30% of commits to a file/area                   | "Nobody's code" — maintenance risk                     |
| **Correlated change lag** | File A and B co-evolve (TCG), but B wasn't updated in latest A change | Likely forgot to update the related file               |
| **Abandoned code**        | No commits to file in >N months, low test coverage                    | Code is probably dead but not deleted                  |

**CLI integration:**

```bash
# Default: CARI-backed analysis (no Neo4j)
iw doc-health

# Full KG mode (requires Neo4j)
iw doc-health --neo4j -s X
iw doc-health --neo4j -s X --only doc-code   # doc ↔ code drift only
iw doc-health --neo4j -s X --only deps       # dependency drift only
iw doc-health --neo4j -s X --only temporal   # temporal drift only

# Verbose output
$ iw doc-health --neo4j -s X -v

  Drift Analysis
  ──────────────────────────────────────
  Doc ↔ Code:
    ⚠  5 ungrounded mentions (entities in docs but not in code)
    ⚠  12 undocumented entities (code entities with no doc mentions)
    ✗  2 signature mismatches (doc says X, code says Y)

  Dependency/Architecture:
    ✗  1 circular dependency (auth ↔ session)
    ⚠  3 dead exports

  Temporal:
    ⚠  8 stale documents (doc >3 months older than related code)
    ⚠  2 ownership vacuums (no clear owner)
    ⚠  1 correlated change lag (auth.ts updated, auth.md not)

  15 drift signals found  │  3 critical  │  12 warnings  │  $0.00
```

**Current implementation (Phase C — ✅ Partial, Phase E will complete):**

- ✅ `drift-temporal` — staleness signals via TCG (doc mtime vs. code mtime), integrated into
  `iw build cheap` pipeline
- ✅ `drift-doc-code` — in-memory comparison of KWG mentions vs. AX output (ungrounded mentions,
  undocumented code). Works in `iw build cheap` but uses JSON, not Neo4j queries.
- ⏳ `drift-doc-code` via Cypher — requires SCG in Neo4j (Phase E) for full power: signature
  mismatch, renamed entity detection, boundary violations, dead exports
- ⏳ `drift-deps` — dependency/architecture drift (circular deps, boundary violations) requires
  SCG import edges in Neo4j

---

### 4.8 Cross-cutting: Vectors, Persistence, Validation

These are not layers — they are capabilities that enhance any layer.

| Capability | What it does                               | Cost      | Applies to           |
| ---------- | ------------------------------------------ | --------- | -------------------- |
| `embed`    | Vector-embed entities (local ONNX default) | **$0.00** | Any layer's entities |
| `persist`  | Write to Neo4j                             | $0        | Any layer            |
| `validate` | Check graph consistency, dangling refs     | $0        | All layers           |

**Vector index** on Canon entities enables hybrid retrieval (vector search → graph traversal) and
improved GX deduplication. See §9.

---

## 5. Stage Architecture

### 5.1 Naming Convention

**Old names** (opaque): `IN`, `FX`, `KX`, `GX`, `RX`, `CX`, `MX`, `PX`, `AX`

**New names** (self-documenting): `verb-noun` format — every stage name tells you what it does.

Design principles:

- **Layer prefix** in the CLI (`iw build kwg/scg/skg/dcg`) groups stages logically
- **Stage names** are human-readable: `scan-keywords`, `extract-triples`, `canonicalize`
- **Each stage** has a clear input → output contract
- **Verbose output** shows stage name, what it processed, timing, and cost

### 5.2 Stage Reference

```
┌─────────────────────────────────────────────────────────────────────┐
│                        iw build pipeline                            │
│                                                                     │
│  Layer 0: FILE    File structure (dirs, files, sizes)               │
│  ──────────────────────────────────────────────────────────────────  │
│    scan-files         Discover files, compute hashes                │
│                       → :File, :Dir nodes + CONTAINS edges          │
│                                                                     │
│  Layer 1: KWG     Keyword mention graph (evidence-first)            │
│  ──────────────────────────────────────────────────────────────────  │
│    scan-keywords      Regex keyword extraction per file             │
│    extract-mentions   Build :Mention nodes with source context      │
│    link-cooccurrence  Sentence/window co-occurrence edges           │
│    detect-clusters    Community detection → envelope entities        │
│                       → :KW nodes, :Mention nodes, CO_OCCURS edges  │
│                                                                     │
│  Layer 2: SCG     Static code graph (AST, 6 sub-graphs)            │
│  ──────────────────────────────────────────────────────────────────  │
│    parse-ast          AST extraction (tree-sitter / ts-morph)       │
│    resolve-refs       Cross-file import/type resolution             │
│    extract-api-surface  Route definitions, exported symbols         │
│    map-test-coverage  Test ↔ code coverage links                    │
│    scan-config        Config → code dependency map                  │
│    map-build-wiring   Build target graph                            │
│    link-code-kwg      Join SCG entities ↔ KWG mentions              │
│                       → :Entity:Class, :Function, :Method nodes     │
│                       → :API:Endpoint, :Test:Suite, :Config nodes   │
│                       → CALLS, IMPORTS, EXTENDS, TESTS, COVERS      │
│                                                                     │
│  Cross-cut: TCG   Temporal change graph (git history)               │
│  ──────────────────────────────────────────────────────────────────  │
│    extract-commits    Git log → :Commit nodes                       │
│    map-co-changes     Co-evolution edges between files              │
│    detect-hotspots    Churn rates, hotspot scores                   │
│    map-ownership      Author → file ownership scores                │
│    detect-staleness   Doc vs code mtime comparison                  │
│                       → :Commit, :Author, :FileVersion nodes        │
│                       → CO_CHANGED_WITH, OWNS, INTRODUCED_IN edges  │
│                                                                     │
│  Cross-cut: Drift  Drift & alignment detectors                      │
│  ──────────────────────────────────────────────────────────────────  │
│    drift-doc-code     Compare KWG mentions vs SCG structure         │
│    drift-deps         Dependency & architecture analysis            │
│    drift-temporal     Time-based divergence signals                 │
│                       → Drift reports (no new graph structure)       │
│                                                                     │
│  Layer 3: SKG     Semantic knowledge graph (LLM overlay)            │
│  ──────────────────────────────────────────────────────────────────  │
│    chunk-docs         Semantic chunking (~16k chars)                │
│    extract-triples    LLM free extraction (parallel, per chunk)     │
│    canonicalize       Normalize entities + predicates (batch)       │
│    merge-global       Cross-document entity dedup (GX)             │
│    link-code-skg      Join Canon entities ↔ SCG entities (xlink)   │
│    link-evidence-skg  Join Canon entities ↔ KWG mentions            │
│                       → :Canon:Entity nodes, CANON_REL edges        │
│                       → EVIDENCED_BY links to :KW:Mention           │
│                                                                     │
│  Layer 4: DCG     Dynamic code graph (future)                       │
│  ──────────────────────────────────────────────────────────────────  │
│    trace-calls        Runtime call graph (instrumentation)          │
│    trace-dataflow     Data flow analysis (taint tracking)           │
│    link-dynamic-scg   Join DCG traces ↔ SCG entities               │
│                       → :Runtime:Call, :DataFlow nodes + edges      │
│                                                                     │
│  Cross-cutting capabilities:                                        │
│  ──────────────────────────────────────────────────────────────────  │
│    embed              Vector-embed entities (local ONNX default)    │
│    persist            Write to Neo4j (any layer)                    │
│    validate           Check graph consistency                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 Mapping: Legacy → New Stage Names

| Legacy       | New name              | Layer         | What it does                             |
| ------------ | --------------------- | ------------- | ---------------------------------------- |
| — (implicit) | `scan-files`          | FILE          | Discover files, compute hashes           |
| — (new)      | `scan-keywords`       | KWG           | Regex keyword extraction per file        |
| — (new)      | `extract-mentions`    | KWG           | Build :Mention nodes with source context |
| — (new)      | `link-cooccurrence`   | KWG           | Sentence/window co-occurrence edges      |
| — (new)      | `detect-clusters`     | KWG           | Community detection → concept clusters   |
| `AX`         | `parse-ast`           | SCG           | AST extraction (tree-sitter)             |
| — (new)      | `resolve-refs`        | SCG           | Cross-file import/type resolution        |
| — (new)      | `extract-api-surface` | SCG           | Route definitions, exported symbols      |
| — (new)      | `map-test-coverage`   | SCG           | Test ↔ code coverage links               |
| — (new)      | `scan-config`         | SCG           | Config → code dependency map             |
| — (new)      | `map-build-wiring`    | SCG           | Build target graph                       |
| — (new)      | `link-code-kwg`       | SCG           | Join SCG↔KWG on (filePath, name)         |
| — (new)      | `extract-commits`     | TCG           | Git log → :Commit nodes                  |
| — (new)      | `map-co-changes`      | TCG           | Co-evolution edges between files         |
| — (new)      | `detect-hotspots`     | TCG           | Churn rates, hotspot scores              |
| — (new)      | `map-ownership`       | TCG           | Author → file ownership scores           |
| — (new)      | `detect-staleness`    | TCG           | Doc vs code mtime comparison             |
| — (new)      | `drift-doc-code`      | Drift         | Compare KWG mentions vs SCG structure    |
| — (new)      | `drift-deps`          | Drift         | Dependency & architecture analysis       |
| — (new)      | `drift-temporal`      | Drift         | Time-based divergence signals            |
| `IN`         | `chunk-docs`          | SKG           | Semantic chunking                        |
| `FX`         | `extract-triples`     | SKG           | LLM free extraction                      |
| `KX`         | `canonicalize`        | SKG           | Normalize entities + predicates          |
| `GX`         | `merge-global`        | SKG           | Cross-document entity dedup              |
| `xlink`      | `link-code-skg`       | SKG           | Join Canon↔SCG entities                  |
| — (new)      | `link-evidence-skg`   | SKG           | Join Canon↔KWG mentions                  |
| `RX`         | _(main track)_        | —             | Schema-constrained extraction            |
| `CX`         | _(main track)_        | —             | Consolidate schema results               |
| `MX`         | _(main track)_        | —             | Merge schema entities                    |
| `PX`         | `persist`             | Cross-cutting | Write to Neo4j                           |

### 5.4 CLI Surface

```bash
# === Layer-specific builds ===
iw build kwg --session X                  # scan-keywords + extract-mentions + link-cooccurrence + detect-clusters
iw build scg --session X                  # parse-ast + resolve-refs + extract-api-surface + map-test-coverage
iw build tcg --session X                  # extract-commits + map-co-changes + detect-hotspots + map-ownership
iw build skg --session X --provider openai -i   # chunk + extract + canonicalize + merge + link-evidence
iw build dcg --session X                  # trace-calls + trace-dataflow (future)

# === Drift detection ===
iw doc-health                             # CARI-backed analysis (default, no Neo4j)
iw doc-health --neo4j -s X               # full KG mode (all detectors)
iw doc-health --neo4j -s X --only doc-code   # doc ↔ code drift only

# === Convenience aliases ===
iw build --cheap --session X --persist    # = kwg + scg + tcg + drift + xlink (all free layers)
iw build --full  --session X --persist    # = kwg + scg + tcg + drift + skg + xlink + embed

# === Individual cross-cutting ===
iw embed --session X                      # vector-embed all entities
iw xlink --session X --persist            # all cross-layer links
iw validate --session X                   # consistency checks

# === All with persist ===
iw build kwg --session X --persist        # + write KWG to Neo4j
iw build scg --session X --persist        # + write SCG to Neo4j
iw build tcg --session X --persist        # + write TCG to Neo4j
iw build skg --session X --persist -i     # + write SKG to Neo4j + auto-xlink
```

### Verbose output examples

```
$ iw build kwg --session planpling --persist -v

  Layer 1: KWG  Keyword Mention Graph (evidence-first)
  ─────────────────────────────────────────────────────
  [1/4] scan-keywords        142 files → 847 keywords              0.8s
  [2/4] extract-mentions     847 keywords → 4,231 mentions         0.4s
        (signal qualifiers: 89 decision, 47 deprecated, 23 planned)
  [3/4] link-cooccurrence    2-sentence window → 2,341 CO_OCCURS   0.3s
  [4/4] detect-clusters      threshold → 23 clusters               0.1s

  persist                    847 :KW + 4231 :Mention + 2341 edges  0.6s

  ✓ KWG built  │  847 entities  │  4,231 mentions  │  23 clusters  │  2.2s  │  $0.00
```

```
$ iw build tcg --session planpling --persist -v

  Cross-cut: TCG  Temporal Change Graph (git history)
  ───────────────────────────────────────────────────
  [1/5] extract-commits      last 6 months → 342 commits           0.3s
  [2/5] map-co-changes       → 156 CO_CHANGED_WITH edges           0.2s
  [3/5] detect-hotspots      → 12 hotspot files (>2σ churn)        0.1s
  [4/5] map-ownership        → 8 authors, 142 ownership edges      0.1s
  [5/5] detect-staleness     → 23 stale doc signals                0.1s

  persist                    342 :Commit + 156 co-change edges     0.4s

  ✓ TCG built  │  342 commits  │  12 hotspots  │  23 stale  │  1.2s  │  $0.00
```

```
$ iw doc-health --neo4j -s planpling -v

  Drift Analysis
  ──────────────────────────────────────
  Doc ↔ Code:
    ⚠  5 ungrounded mentions (entities in docs but not in code)
    ⚠  12 undocumented entities (code entities with no doc mentions)
    ✗  2 signature mismatches (doc says X, code says Y)

  Dependency/Architecture:
    ✗  1 circular dependency (auth ↔ session)
    ⚠  3 dead exports

  Temporal:
    ⚠  8 stale documents (doc >3 months older than related code)
    ⚠  2 ownership vacuums (no clear owner)
    ⚠  1 correlated change lag (auth.ts updated, auth.md not)

  ✓ 15 drift signals  │  3 critical  │  12 warnings  │  0.8s  │  $0.00
```

persist 847 :KW nodes, 2341 edges → Neo4j 0.4s

```

```

$ iw build skg --session planpling --provider openai -i --persist -v

Layer 3: SKG Semantic Knowledge Graph (LLM overlay)
────────────────────────────────────────────────────
[1/6] chunk-docs 12 files → 34 chunks 0.2s
[2/6] extract-triples 34 chunks → 412 raw triples 47.3s $0.23
(cache hit: 28/34 chunks, 6 new)
[3/6] canonicalize 412 triples → 189 Canon entities 12.1s $0.08
[4/6] merge-global 189 → 156 entities (33 merged) 0.4s
[5/6] link-code-skg 23 SKG↔SCG links created 0.1s
[6/6] link-evidence-skg 156 entities → 2,847 evidence links 0.3s

persist 156 :Canon nodes, 287 edges → Neo4j 0.6s

✓ SKG built │ 156 entities │ 287 rels │ 2,847 evidence links │ 61.0s │ $0.31

````

---

## 6. Cross-layer Linking

### Link, not merge

Layers are linked, never merged. Five reasons:

1. **Different refresh cadences** — KWG: on file save (seconds), SCG: on code change (minutes),
   SKG: on explicit run (expensive). Merging would force full rebuild.
2. **Provenance** — "Where did this edge come from?" is critical. Merging loses layer attribution.
3. **Confidence layering** — KWG edges are low-confidence (regex), SCG edges are structural-certain,
   SKG edges are semantically rich but LLM-confidence. Queries filter by layer.
4. **Independent rebuild** — Re-run KWG without touching SKG. Rebuild SCG after refactoring without
   LLM cost.
5. **Composable queries** — "Entities in KWG but NOT in SKG" → candidates for next `iw run`.

### Cross-layer edge types

```cypher
// KWG → SCG (query-time join on filePath + name)
(:KW:Entity)-[:REALIZED_BY {method: 'name-match'}]->(:Entity:Class|Function|...)

// SKG → SCG (xlink, 4 strategies: dep, import, name, path)
(:Canon:Entity)-[:REALIZED_BY {strategy, confidence, detail}]->(:CodeRef)

// KWG → SKG (name or vector similarity)
(:KW:Entity)-[:CANONICALIZED_AS {confidence, method}]->(:Canon:Entity)

// DCG → SCG (future: runtime traces mapped to AST entities)
(:Runtime:Call)-[:CONFIRMS]->(:Entity:Function)
````

---

## 7. Neo4j Schema

### Complete label scheme

```cypher
// ── Layer 0: FILE ──
(:File {filePath, name, size, contentHash, mtime})
(:Dir {filePath, name})
(:Dir)-[:CONTAINS]->(:File|:Dir)

// ── Layer 1: KWG (evidence-first) ──
(:KW:Entity {name, frequency, firstSeen, session_id})
(:KW:Mention {text, filePath, section, heading, sentenceIdx, docType, lineNumber, qualifiers, session_id})
(:KW:Doc {filePath, contentHash, mtime, session_id})
(:KW:SourceFile {filePath, language, session_id})
(:KW:Cluster {label, memberCount, cohesion, session_id})
(:KW:Doc)-[:KW_MENTIONS {count, positions}]->(:KW:Entity)
(:KW:SourceFile)-[:KW_CONTAINS {count}]->(:KW:Entity)
(:KW:Entity)-[:HAS_MENTION]->(:KW:Mention)                              // entity → evidence
(:KW:Mention)-[:APPEARS_IN]->(:KW:Doc|:KW:SourceFile)                   // mention → source
(:KW:Mention)-[:DEFINED_BY {heading, section}]->(:KW:Doc)               // mention → defining section
(:KW:Entity)-[:CO_OCCURS {weight, window, sources}]->(:KW:Entity)
(:KW:Cluster)-[:CLUSTER_MEMBER]->(:KW:Entity)

// ── Layer 2: SCG (core AST + 6 sub-graphs) ──
// Core AST
(:Entity:Class {name, filePath, range, isExported, id})
(:Entity:Function {name, filePath, range, isExported, isAsync, id})
(:Entity:Method {name, filePath, range, isStatic, visibility, id})
(:Entity:Variable {name, filePath, range, isConst, isExported, id})
(:Entity:Interface {name, filePath, range, isExported, id})
(:Entity:Type {name, filePath, range, isExported, id})
(:Entity:Module {name, filePath, range, id})
(:Entity:Class)-[:CONTAINS]->(:Entity:Method)
(:Entity:File)-[:IMPORTS]->(:Entity:File)
(:Entity:Class)-[:EXTENDS]->(:Entity:Class)
(:Entity:Class)-[:IMPLEMENTS]->(:Entity:Interface)
(:Entity:Function)-[:CALLS]->(:Entity:Function|:Method)
(:Entity)-[:USES]->(:Entity)
(:Entity:File)-[:DEPENDS_ON]->(:Entity:File)
// API Surface sub-graph
(:API:Endpoint {method, path, filePath, handlerName})
(:API:ExportedSymbol {name, kind, filePath})
(:API:Endpoint)-[:HANDLES]->(:Entity:Function|:Method)
(:Entity)-[:EXPOSES]->(:API:ExportedSymbol)
// Test Coverage sub-graph
(:Test:Suite {name, filePath})
(:Test:Case {name, filePath})
(:Test:Suite)-[:CONTAINS]->(:Test:Case)
(:Test:Case)-[:TESTS]->(:Entity:Function|:Method)
(:Test:Suite)-[:COVERS]->(:Entity:Class|:Function)
// Config sub-graph
(:Config:Var {name, source, filePath})
(:Config:File {filePath, format})
(:Entity)-[:CONFIGURED_BY]->(:Config:Var)

// ── Cross-cut: TCG (temporal change graph) ──
(:TCG:Commit {hash, author, date, message, session_id})
(:TCG:FileVersion {filePath, commitHash, changeType, linesAdded, linesRemoved, session_id})
(:TCG:Author {name, email, session_id})
(:TCG:Commit)-[:MODIFIED {changeType, linesAdded, linesRemoved}]->(:File)
(:TCG:Commit)-[:AUTHORED_BY]->(:TCG:Author)
(:TCG:Author)-[:OWNS {score, commitCount, lastTouch}]->(:File)
(:File)-[:CO_CHANGED_WITH {frequency, commits}]->(:File)
(:KW:Entity)-[:INTRODUCED_IN]->(:TCG:Commit)
(:KW:Entity)-[:LAST_TOUCHED_IN]->(:TCG:Commit)

// ── Layer 3: SKG (LLM overlay) ──
(:Canon:Entity {name, type, canonId, aliases, confidence, session_id, embedding?})
(:RawTriple {subject, predicate, object, confidence, source})
(:Session {id, name, createdAt})
(:CodeRef {filePath, name, kind, language, session_id})
(:Canon:Entity)-[:CANON_REL {predicate, confidence, source}]->(:Canon:Entity)
(:Canon:Entity)-[:EVIDENCED_BY {confidence, mentionCount}]->(:KW:Mention)  // SKG→KWG evidence
(:RawTriple)-[:CANONICALIZED_FROM]->(:Canon:Entity)
(:Session)-[:CONTAINS]->(:Canon:Entity)
(:Canon:Entity)-[:REALIZED_BY {strategy, confidence, detail}]->(:CodeRef)

// ── Layer 4: DCG (future) ──
(:Runtime:Call {caller, callee, count, avgDuration})
(:Runtime:DataFlow {source, sink, path})
(:Entity:Function)-[:INVOKES {count, avgMs}]->(:Entity:Function)
(:Entity:Variable)-[:FLOWS_TO]->(:Entity:Variable)
(:Runtime:Call)-[:CONFIRMS]->(:Entity:Function)

// ── Cross-layer links ──
(:KW:Entity)-[:REALIZED_BY {method}]->(:Entity:Class|:Function|...)     // KWG→SCG
(:KW:Entity)-[:CANONICALIZED_AS {confidence, method}]->(:Canon:Entity)  // KWG→SKG
(:Canon:Entity)-[:REALIZED_BY {strategy, confidence}]->(:CodeRef)       // SKG→SCG
(:Canon:Entity)-[:EVIDENCED_BY]->(:KW:Mention)                          // SKG→KWG evidence
(:Runtime:Call)-[:CONFIRMS]->(:Entity:Function)                          // DCG→SCG

// ── Vector index ──
CREATE VECTOR INDEX canon_embedding IF NOT EXISTS
FOR (c:Canon:Entity) ON (c.embedding)
OPTIONS {indexConfig: {`vector.dimensions`: 384, `vector.similarity_function`: 'cosine'}}
// 384 dims = all-MiniLM-L6-v2 default; adjust if using different model
```

---

## 8. Co-occurrence & Envelope Entities

### 8.1 Sentence-level Co-occurrence

**Idea:** When two keywords appear in the same sentence, they are likely related. Record this as an
edge with a weight proportional to frequency.

**Example:**

> "The AuthService validates JWT tokens using the TokenManager."

Keywords found: `AuthService`, `JWT`, `TokenManager`

```
AuthService ──CO_OCCURS {weight: 1}──▶ JWT
AuthService ──CO_OCCURS {weight: 1}──▶ TokenManager
JWT         ──CO_OCCURS {weight: 1}──▶ TokenManager
```

**Implementation sketch:**

```typescript
function extractCoOccurrences(
  text: string,
  keywords: string[],
  windowSize: number = 2, // sentences
): Map<string, number> {
  const sentences = splitIntoSentences(text);
  const cooccurrences = new Map<string, number>();

  // Sliding window of N sentences
  for (let i = 0; i <= sentences.length - windowSize; i++) {
    const window = sentences.slice(i, i + windowSize).join(" ");
    const found = keywords.filter((kw) =>
      window.toLowerCase().includes(kw.toLowerCase()),
    );

    for (let a = 0; a < found.length; a++) {
      for (let b = a + 1; b < found.length; b++) {
        const key = [found[a], found[b]].sort().join("|");
        cooccurrences.set(key, (cooccurrences.get(key) ?? 0) + 1);
      }
    }
  }

  return cooccurrences;
}
```

### 8.2 Sliding Window

| Window size           | Pro                                  | Con                              | Recommendation                  |
| --------------------- | ------------------------------------ | -------------------------------- | ------------------------------- |
| 1 sentence            | Tight, precise                       | Misses cross-sentence refs       | Technical specs                 |
| 2 sentences           | Catches "A does X. X connects to B." | Slightly more noise              | **Default**                     |
| 3 sentences           | Broad context                        | Significant noise                | Narrative docs                  |
| 1 paragraph / section | Very broad                           | Too much noise for co-occurrence | Use for cluster membership only |

**Recommendation:** Default window = **2 sentences**. Configurable via `--window` flag.

### 8.3 Envelope Entities (Concept Clusters)

After building the co-occurrence graph, apply **community detection** to find densely connected
subgroups. Each community becomes an **envelope entity** (concept cluster).

**Algorithm options:**

| Algorithm            | Complexity | Quality | Built-in Neo4j? | Recommended            |
| -------------------- | ---------- | ------- | --------------- | ---------------------- |
| Louvain              | O(n log n) | Good    | Yes (GDS)       | For large graphs       |
| Leiden               | O(n log n) | Better  | Yes (GDS)       | For production         |
| Label Propagation    | O(n)       | Decent  | Yes (GDS)       | For speed              |
| Connected Components | O(n)       | Basic   | Yes (native)    | Baseline / fallback    |
| Simple threshold     | O(e)       | Decent  | N/A (custom)    | **v1 — no GDS needed** |

**V1 approach (no GDS dependency):** Simple threshold-based clustering in application code:

```typescript
function detectClusters(
  cooccurrences: Map<string, number>,
  threshold: number = 3,
): Cluster[] {
  // Build adjacency list from co-occurrences above threshold
  const adj = new Map<string, Set<string>>();
  for (const [key, weight] of cooccurrences) {
    if (weight < threshold) continue;
    const [a, b] = key.split("|");
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  // Connected components = clusters
  const visited = new Set<string>();
  const clusters: Cluster[] = [];

  for (const node of adj.keys()) {
    if (visited.has(node)) continue;
    const members: string[] = [];
    const queue = [node];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      members.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    clusters.push({
      members,
      label: members[0], // highest-degree member or LLM-generated label later
      cohesion: members.length,
    });
  }

  return clusters;
}
```

**Cluster labels:** For v1, use the highest-degree member as the label. For v2, optionally use a
single LLM call to name clusters: "Given these related terms: [AuthService, JWT, TokenManager,
OAuth, RefreshEndpoint], what is this concept cluster about?" → "Authentication & Token Management".

### 8.4 Verb Extraction (OpenIE-lite) — Weak Hints, Not Semantics

> **Important framing:** Verb extraction produces _weak predicate hints_ — lightweight signals that
> something structural might be happening. They are **not actual semantic predicates**. Do not treat
> them as trustworthy assertions. They are best used as _triage signals_ to identify areas worth
> running SKG extraction on.

Optionally, extract lightweight predicate hints from sentences containing keyword pairs:

```typescript
const VERB_PATTERNS = [
  { regex: /(\w+)\s+depends?\s+on\s+(\w+)/i, predicate: "DEPENDS_ON" },
  { regex: /(\w+)\s+uses?\s+(\w+)/i, predicate: "USES" },
  { regex: /(\w+)\s+implements?\s+(\w+)/i, predicate: "IMPLEMENTS" },
  { regex: /(\w+)\s+extends?\s+(\w+)/i, predicate: "EXTENDS" },
  { regex: /(\w+)\s+calls?\s+(\w+)/i, predicate: "CALLS" },
  { regex: /(\w+)\s+replaces?\s+(\w+)/i, predicate: "REPLACES" },
  { regex: /(\w+)\s+requires?\s+(\w+)/i, predicate: "REQUIRES" },
  { regex: /decided\s+(?:for|on)\s+(\w+)/i, predicate: "DECIDED_FOR" },
  { regex: /decided\s+against\s+(\w+)/i, predicate: "DECIDED_AGAINST" },
  {
    regex: /(\w+)\s+is\s+(?:an?\s+)?alternative\s+to\s+(\w+)/i,
    predicate: "ALTERNATIVE_TO",
  },
];
```

This converts a subset of CO*OCCURS edges into **hint-typed edges** (e.g., `DEPENDS_ON_HINT`) for free.
Won't catch everything, and false positives are expected. For technical prose it catches a surprising
amount, but the key distinction is: these are \_hints for triage*, not _semantic assertions_. The
actual semantic predicates come from the SKG layer.

---

## 9. Vector Embeddings

Vectors are a **cross-cutting enhancement**, not a separate layer. They improve three things:
hybrid retrieval, entity deduplication, and fuzzy cross-layer linking.

### 9.1 Embedding Provider Strategy: Local-first, Cloud-optional

IntentWeave defaults to **free, local embedding models** — no API key, no cost, no data leaving
the machine. Cloud providers are available as opt-in alternatives for higher quality or convenience.

#### Free / Local Models

| Model                        | Dimensions | Size   | Quality   | Speed     | License    | Notes                                                            |
| ---------------------------- | ---------- | ------ | --------- | --------- | ---------- | ---------------------------------------------------------------- |
| **all-MiniLM-L6-v2**         | 384        | 80 MB  | Good      | Very fast | Apache-2.0 | **Default choice.** Best speed/quality trade-off. Runs on CPU.   |
| **nomic-embed-text-v1.5**    | 768        | 270 MB | Very good | Fast      | Apache-2.0 | Matryoshka dims (truncate to 256/384/512). Good for longer text. |
| **BGE-small-en-v1.5** (BAAI) | 384        | 130 MB | Good      | Fast      | MIT        | Strong on retrieval benchmarks.                                  |
| **BGE-base-en-v1.5** (BAAI)  | 768        | 440 MB | Very good | Medium    | MIT        | Better quality, larger.                                          |
| **gte-small** (Alibaba)      | 384        | 60 MB  | Good      | Very fast | MIT        | Smallest, fastest option.                                        |
| **snowflake-arctic-embed-s** | 384        | 130 MB | Very good | Fast      | Apache-2.0 | State-of-the-art for size.                                       |

#### Cloud Models (opt-in)

| Provider | Model                  | Dimensions | Cost         | Quality   | Notes                          |
| -------- | ---------------------- | ---------- | ------------ | --------- | ------------------------------ |
| OpenAI   | text-embedding-3-small | 1536       | $0.02/1M tok | Excellent | Supports dimension reduction   |
| OpenAI   | text-embedding-3-large | 3072       | $0.13/1M tok | Best      | Overkill for entity embeddings |
| Cohere   | embed-english-v3.0     | 1024       | $0.10/1M tok | Excellent | Good multilingual support      |
| Voyage   | voyage-3               | 1024       | $0.06/1M tok | Excellent | Optimized for code+text        |

#### Runtime Options

| Runtime                    | How                               | Pros                               | Cons                               |
| -------------------------- | --------------------------------- | ---------------------------------- | ---------------------------------- |
| **ONNX Runtime** (default) | Bundle ONNX model, run in Node.js | Zero external deps, fast, portable | ~100-400 MB model download         |
| **Ollama**                 | `ollama pull nomic-embed-text`    | Easy install, GPU acceleration     | Requires Ollama running            |
| **Transformers.js**        | Run HuggingFace models in Node.js | Pure JS, no native deps            | Slower than ONNX on CPU            |
| **Fastembed** (Qdrant)     | Optimized ONNX wrapper            | Fastest local option               | Python-only (not ideal for TS)     |
| **OpenAI / Cohere API**    | HTTP call                         | No local compute, best quality     | Cost, latency, data leaves machine |

**Recommended default:** ONNX Runtime + `all-MiniLM-L6-v2`. Zero cost, ~5ms per embedding on
modern hardware, 384 dimensions (small Neo4j index footprint). Model auto-downloads on first use.

#### Configuration

```bash
# Default: free local embeddings (no config needed)
iw embed --session X

# Explicit local model
iw embed --session X --provider local --model nomic-embed-text-v1.5

# Via Ollama (if running)
iw embed --session X --provider ollama --model nomic-embed-text

# Cloud provider (requires API key)
iw embed --session X --provider openai --model text-embedding-3-small

# Environment variable override
IW_EMBED_PROVIDER=local        # default
IW_EMBED_MODEL=all-MiniLM-L6-v2  # default
```

#### Interface

```typescript
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// Implementations
export class OnnxEmbeddingProvider implements EmbeddingProvider { ... }
export class OllamaEmbeddingProvider implements EmbeddingProvider { ... }
export class OpenAIEmbeddingProvider implements EmbeddingProvider { ... }
```

The `EmbeddingProvider` interface is part of `@intentweave/core`, making it extensible for
framework users to plug in custom providers.

### 9.2 Where Vectors Add Value

#### Hybrid retrieval in `iw context` / `iw query`

```
query("what handles user sessions?")
  → embed(query) → vector ANN search on Canon entities → top-K seeds
  → graph traversal from seeds (N hops)
  → return subgraph as context
```

Better than pure NL→Cypher because vector search handles vocabulary mismatch.

#### GX deduplication

Cases Levenshtein misses:

```
"authentication module"  ←→  "auth service"       (Levenshtein: low)
embed("authentication module") ≈ embed("auth service")  (cosine: high)
```

#### KWG→SKG fuzzy cross-linking

For KWG entities that don't match any Canon entity by exact name, vector similarity provides a
fallback:

```cypher
MATCH (kw:KW:Entity)
WHERE NOT EXISTS { (kw)-[:CANONICALIZED_AS]->() }
CALL db.index.vector.queryNodes('canon_embedding', 3, kw.embedding)
YIELD node AS candidate, score
WHERE score > 0.85
MERGE (kw)-[:CANONICALIZED_AS {confidence: score, method: 'vector'}]->(candidate)
```

### 9.3 Cost Comparison

| Approach                        | Cost for 500 entities | Latency         | Quality   | Offline? |
| ------------------------------- | --------------------- | --------------- | --------- | -------- |
| **Local (all-MiniLM-L6-v2)**    | **$0.00**             | ~2.5s total     | Good      | **Yes**  |
| Local (nomic-embed-text)        | $0.00                 | ~5s total       | Very good | Yes      |
| Ollama (nomic-embed-text)       | $0.00                 | ~3s total (GPU) | Very good | Yes      |
| OpenAI (text-embedding-3-small) | ~$0.001               | ~2s total       | Excellent | No       |

For 500 Canon entities, any approach is near-instant and near-free. The local default means
**zero external dependencies** — `iw embed` works out of the box without API keys.

---

## 10. Use Case Analysis

### Overview matrix

| Use Case                            | FILE (L0) | KWG (L1) | SCG (L2) | TCG (⏱) | Drift | SKG (L3) | DCG (L4) |
| ----------------------------------- | :-------: | :------: | :------: | :-----: | :---: | :------: | :------: |
| UC1: Doc/spec ↔ code disconnection  |     ◌     |    ◕     |    ●     |    ◕    | **●** |    ●     |    ◌     |
| UC2: Duplicate implementations/docs |     ◌     |    ◕     |    ●     |    ◔    |   ◕   |    ●     |    ◌     |
| UC3: Understand design decisions    |     ◌     |    ◕     |    ◌     |    ◕    |   ◌   |    ●     |    ◌     |
| UC4: Clean/update documentation     |     ◔     |    ◕     |    ◕     |  **●**  | **●** |    ●     |    ◌     |
| UC5: Clean/refactor code            |     ◌     |    ◔     |    ●     |    ◕    |   ◕   |    ◕     |    ●     |
| UC6: Agent context access           |     ◔     |    ◕     |    ●     |    ◕    |   ◕   |    ●     |    ◕     |
| UC7: Architecture discovery         |     ◔     |    ◕     |    ●     |    ◕    |   ◔   |    ●     |    ◕     |
| UC8: Impact analysis                |     ◔     |    ◕     |    ●     |  **●**  |   ◕   |    ●     |    ●     |
| UC9: Contradiction detection        |     ◌     |    ◕     |    ◕     |    ◕    | **●** |    ●     |    ◌     |

_Legend: ◌ = not applicable, ◔ = minimal, ◕ = useful, ● = excellent_

**Key observation:** TCG and Drift detectors dramatically improve UC1 (disconnection), UC4 (doc
freshness), UC8 (impact), and UC9 (contradictions) — all without LLM involvement. These were
previously SKG-only use cases.

---

### UC1: Finding disconnections between doc/spec and code

**Problem:** Documentation mentions `AuthService` but no such class exists in code, or code has
`PaymentGateway` but no docs reference it.

| Layer     | Capability                                | How                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KWG**   | Entity grounding check + mention evidence | `scan-keywords` over docs → entity list with `:Mention` nodes. `scan-keywords` over code → presence check. Entities in docs but not code = **ungrounded**. Entities in code but not docs = **undocumented**. Mentions carry section, heading, qualifiers → "PaymentGateway mentioned 3 times in spec section 'Billing Architecture' with `planned` qualifier." |
| **KWG+**  | Co-occurrence context                     | Ungrounded `PaymentGateway` co-occurs with `Stripe`, `billing` → helps triage: is it planned? abandoned? renamed?                                                                                                                                                                                                                                              |
| **SCG**   | Structural confirmation                   | Exact match: `Entity:Class{name: "AuthService"}` exists? Which file, what methods? Stronger signal than keyword presence in a comment.                                                                                                                                                                                                                         |
| **TCG**   | Temporal context for disconnection        | When was `PaymentGateway` last mentioned in a commit? Was the doc updated after the code was deleted? Is the keyword mentioned in a recent or ancient commit?                                                                                                                                                                                                  |
| **Drift** | **Automated detection**                   | `drift-doc-code` directly outputs: "5 ungrounded mentions, 12 undocumented entities, 2 signature mismatches." No manual query needed.                                                                                                                                                                                                                          |
| **SKG**   | Semantic grounding                        | Canon entity `AuthService` has `:REALIZED_BY` edge to `:CodeRef`? If not → semantically documented but structurally absent. Full provenance.                                                                                                                                                                                                                   |

**Evidence-first workflow:**

```bash
# Phase A: Mention graph catches most disconnections ($0)
iw build kwg --session X --persist
iw doc-health --neo4j -s X --only doc-code
# → "5 ungrounded mentions, 12 undocumented entities"
# → Each with mention evidence: file, section, heading, qualifier

# Phase B: Temporal context adds "when did it drift?" ($0)
iw build tcg --session X --persist
iw doc-health --neo4j -s X --only temporal
# → "PaymentGateway: last code commit 3 months ago (deleted), doc updated 6 months ago"

# Phase C (optional): Semantic grounding for confirmed issues ($$)
iw build skg docs/billing.md --session X --provider openai -i --persist
# → Full decision graph around PaymentGateway
```

---

### UC2: Finding duplicated implementations / documents

**Problem:** Same concept implemented twice (two auth modules), or same information documented in
multiple places that can drift apart.

| Layer     | Capability                      | How                                                                                                                                          |
| --------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **KWG**   | Same keyword in multiple files  | `AuthService` appears in `src/auth.ts` AND `src/legacy/auth-handler.ts` → potential duplication                                              |
| **KWG+**  | Cluster similarity across files | Two files have overlapping co-occurrence clusters (same keyword neighborhood) → likely cover the same concern                                |
| **TCG**   | Copy-paste lineage              | Two files that were copied from a common ancestor (git blame overlap). Or: two files that diverged recently after being identical.           |
| **Drift** | Divergence detection            | drift-doc-doc: Two documents cover the same topic but their mention footprints have diverged → one was updated, the other wasn't.            |
| **SCG**   | Structural similarity           | Two classes with overlapping method signatures. Two functions with similar call patterns.                                                    |
| **SKG**   | Semantic duplication            | GX merge detects `AuthService` and `AuthenticationHandler` as the same entity → merged with alias. Documents referencing both = duplication. |

**Evidence-first workflow:**

1. **KWG:** Find files sharing >5 keywords → candidate duplicates
2. **TCG:** Check git history — were they forked from the same file? Did they diverge recently?
3. **Drift:** Flag pairs where the overlapping mention footprint has drifted
4. **SCG:** Confirm structural similarity (matching method signatures, overlapping imports)
5. **SKG (optional):** GX merges the entities → confirms semantic duplication

**KWG-specific query:**

```cypher
// Files that share many keywords → likely duplicated content
MATCH (d1:KW:Doc)-[:KW_MENTIONS]->(e:KW:Entity)<-[:KW_MENTIONS]-(d2:KW:Doc)
WHERE d1.filePath < d2.filePath
WITH d1, d2, COUNT(e) AS sharedKeywords, COLLECT(e.name) AS keywords
WHERE sharedKeywords > 5
RETURN d1.filePath, d2.filePath, sharedKeywords, keywords
ORDER BY sharedKeywords DESC
```

---

### UC3: Understanding design decisions

**Problem:** Team needs to know why a certain technology/approach was chosen, what alternatives
were considered, and what trade-offs apply.

| Layer    | Capability                     | How                                                                                                                                                                                                                                          |
| -------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KWG**  | Decision evidence via mentions | Mentions with `decision` qualifier: "decided for Neo4j" → `:Mention {text: "decided for Neo4j", heading: "Database Selection", qualifiers: ['decision'], filePath: "docs/arch.md"}`. The mention _is_ the evidence, not a compressed triple. |
| **KWG+** | Decision context clusters      | `Neo4j` co-occurs with `PostgreSQL`, `MongoDB`, `graph database` → this cluster is about a database decision                                                                                                                                 |
| **TCG**  | Decision volatility            | How often did mentions with `decision` qualifier change in this area? High volatility = team keeps revisiting the decision. Low volatility = settled.                                                                                        |
| **SCG**  | N/A                            | Decisions are not in code structure                                                                                                                                                                                                          |
| **SKG**  | Full decision graph            | `DECIDED_FOR`, `DECIDED_AGAINST`, `ALTERNATIVE_TO`, `MOTIVATED_BY`, `SUPERSEDES` — full decision provenance                                                                                                                                  |

**Example:** "Why did we choose Neo4j?"

- **KWG (evidence):** "Neo4j mentioned 23 times. 5 mentions have `decision` qualifier, all in
  `docs/arch.md` under heading 'Database Selection'. Co-occurs with PostgreSQL, MongoDB, graph
  database. Here are the 5 source sentences." → Agent or human can read the actual context.

- **TCG (stability):** "The 'Database Selection' section was last modified 8 months ago, 2 commits
  total. This decision appears stable."

- **SKG (structured):** "Neo4j was DECIDED_FOR as graph database. PostgreSQL DECIDED_AGAINST.
  MOTIVATED_BY: native graph traversal. ALTERNATIVE_TO: MongoDB."

**Key insight:** For design decisions, the KWG mention evidence + source sentences is often
_sufficient_ — you send the agent to the right section of the right document. The SKG adds
queryable structure for when you need to traverse the decision graph.

---

### UC4: Clean/update documentation

**Problem:** Documentation is stale, references outdated entities, or contradicts the current
codebase.

| Layer     | Capability                 | How                                                                                                                                                                                                                                                                         |
| --------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FILE**  | Timestamp comparison       | Doc `mtime` vs code `mtime` → temporal staleness                                                                                                                                                                                                                            |
| **KWG**   | Entity freshness           | Keyword in doc but deleted from codebase → stale reference. New keywords in code but not in docs → undocumented. Mention qualifiers: `deprecated` in code but still referenced in docs without caveat.                                                                      |
| **KWG+**  | Cluster drift              | Doc's keyword cluster has shifted (new members, lost members) → topic has evolved, doc may be outdated                                                                                                                                                                      |
| **TCG**   | Temporal staleness         | Git shows `src/auth.ts` changed 12 times in the last month, but `docs/auth.md` last touched 6 months ago → evidence of staleness. Also: doc was last updated by a different author than the code → potential knowledge gap.                                                 |
| **Drift** | **Primary detection tool** | drift-doc-code: Doc mentions `authenticate(token)` but code shows `authenticate(token, options)` → signature drift. drift-temporal: doc references entities whose git activity pattern has changed. drift-deps: `package.json` added a dependency that no doc mentions yet. |
| **SCG**   | API drift                  | Structural confirmation: doc mentions function with wrong signature, wrong parameter count, wrong return type                                                                                                                                                               |
| **SKG**   | Semantic staleness         | 6 detection categories: stale, drift, contradiction, temporal, orphaned, undocumented (existing `doc-health`)                                                                                                                                                               |

> **This is `iw doc-health`'s killer use case — and the strongest argument for the evidence model.**
> With KWG mentions + TCG temporal signals + drift detectors, most documentation problems are
> detectable _without any LLM_. The `--lite` mode becomes genuinely useful: "This doc's mention
> footprint no longer matches the codebase, the code changed 12 times since the doc was written,
> and the function signature drifted." That's actionable evidence without spending a token.

**Example:** `iw doc-health` (CARI default) or `iw doc-health --neo4j -s X` (full KG)

```
⚠️  docs/auth.md — STALE (high confidence)
    Evidence:
    - TCG: src/auth.ts modified 12× since doc last updated (6 months ago)
    - Drift: authenticate() signature changed (token → token, options)
    - KWG: doc mentions 'BasicAuth' (deprecated qualifier in code, 2 mentions)
    - KWG: code has 'OAuth2Provider' (3 mentions) not referenced in doc
    Recommendation: Update doc to reflect OAuth2 migration
```

---

### UC5: Clean/refactor code

**Problem:** Identify dead code, redundant modules, tangled dependencies, and refactoring
opportunities.

| Layer     | Capability                     | How                                                                                                                        |
| --------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **KWG**   | Code-only entities not in docs | Entities that exist only in code, never referenced in docs or specs → potentially orphaned/legacy                          |
| **TCG**   | Churn hotspots                 | Files changed in >80% of recent commits → code is volatile, maybe needs refactoring. Files never changed → stable or dead. |
| **TCG**   | Ownership concentration        | File touched by only 1 author → bus factor risk.                                                                           |
| **Drift** | drift-deps                     | `package.json` dependency not imported anywhere in code → unused dependency.                                               |
| **SCG**   | Dead code detection            | Functions/classes never called or imported. Circular dependencies. God classes (high fan-in/fan-out).                      |
| **SKG**   | Semantic redundancy            | Two Canon entities both `IMPLEMENTS` the same interface → potential consolidation                                          |
| **DCG**   | Runtime dead code              | Static call graph says function is reachable, but runtime traces show zero invocations → true dead code                    |

**Progressive approach:**

1. **SCG:** Find structurally dead code (never called/imported)
2. **TCG:** Identify churn hotspots (volatile code = refactoring candidates) and ownership risks
3. **Drift:** Flag unused dependencies, mismatched configs
4. **DCG:** Confirm with runtime data (called in tests but never in production?)
5. **SKG:** Identify semantically redundant implementations
6. **KWG:** Find code that's not referenced in any documentation → maybe intentional utility, maybe forgotten

---

### UC6: Broader agent context access — avoid context loss

**Problem:** AI coding agents (Copilot, Cursor) lose context in large codebases. They can't see
the full architecture, don't know about design decisions, and make changes that violate existing
patterns.

| Layer     | Capability                   | How                                                                                                                                                                                         |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KWG**   | Cheap broad context          | "What's related to `AuthService`?" → CO_OCCURS traversal → give agent the keyword neighborhood + source sentences. Fast, free, good enough for orientation.                                 |
| **KWG+**  | Cluster summaries            | "What are the main concerns?" → envelope entities → one-line cluster labels. Agent sees the forest, not just trees.                                                                         |
| **TCG**   | "What else should I update?" | Agent changes `auth.ts` → TCG co-change signal: `token-manager.ts` changes in 90% of commits that touch `auth.ts` → agent gets a nudge: "you probably need to update token-manager.ts too." |
| **TCG**   | Recency context              | "Who last touched this? How volatile is it?" → agent adjusts its confidence — volatile code needs more careful changes.                                                                     |
| **Drift** | Constraint context           | "Are there known drift issues here?" → agent sees: "docs/auth.md is stale, function signature changed" → agent knows to update the doc too.                                                 |
| **SCG**   | Code structure context       | "What methods does `UserService` have? What does it import?" → precise structural context for the agent.                                                                                    |
| **SKG**   | Semantic context             | "How does authentication relate to authorization?" → full semantic subgraph. Rich context for complex reasoning.                                                                            |
| **DCG**   | Behavioral context           | "What actually happens when a user logs in?" → runtime call chain → agent understands the real flow, not just static structure.                                                             |

**The key insight:** Agents need **layered context** at different granularities:

1. **Orientation** (KWG): "What concepts exist? What's near this entity?"
2. **Co-change awareness** (TCG): "What else typically changes with this file?"
3. **Constraint awareness** (Drift): "What's already broken or stale here?"
4. **Structure** (SCG): "What's the code shape? Imports, exports, class hierarchy?"
5. **Meaning** (SKG): "What does this design mean? What decisions constrain it?"
6. **Behavior** (DCG): "What actually happens at runtime?"

Providing all layers via MCP tools means the agent can request the right level of detail for
each sub-task. Quick orientation uses KWG ($0). Co-change awareness uses TCG ($0). Detailed
understanding uses SKG (cached).

**Anti-pattern avoided:** Without layered context, agents either get too little (miss dependencies)
or you feed the entire codebase (token explosion, cost, hallucination). The layer system lets the
agent do **progressive disclosure**: start broad (KWG), check co-change (TCG), drill into
relevant areas (SCG/SKG).

**Killer agent pattern — "what else?" via TCG:**

```
Agent modifies src/auth.ts
→ MCP tool: kg_impact("src/auth.ts")
→ TCG: co-changed with token-manager.ts (90%), auth.test.ts (85%)
→ Drift: docs/auth.md is stale (last updated 6 months ago)
→ KWG: AuthService co-occurs with SessionStore (not in SCG imports — maybe a doc reference?)
→ Agent: "I should also update token-manager.ts, run auth.test.ts, and update docs/auth.md"
```

---

### UC7: Architecture discovery

**Problem:** New team member or AI agent needs to understand the overall architecture — main
components, how they relate, what technologies are used.

| Layer    | Capability          | How                                                                                                                                                                      |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **FILE** | Module boundaries   | Directory structure → package boundaries, monorepo layout                                                                                                                |
| **KWG**  | Concept map         | Envelope entities = "these are the main topics". Cluster graph shows how topics relate.                                                                                  |
| **TCG**  | Evolution map       | Git history reveals: which modules are actively developed (hot), which are stable (cold), which are decaying (once active, now untouched). Ownership map: who owns what. |
| **TCG**  | Hidden coupling     | Co-change analysis: modules that always change together may have hidden dependencies that aren't visible in imports.                                                     |
| **SCG**  | Dependency graph    | Import/call graph → which modules depend on which. Circular deps = architecture smell.                                                                                   |
| **SKG**  | Architectural model | Canon entities of type `component`, `technology`, `pattern` + their `DEPENDS_ON`, `CONTAINS` relationships → architectural diagram data                                  |

**KWG + TCG value for architecture discovery:**
Even without LLM, the co-occurrence cluster graph reveals the main concerns:
"Authentication" cluster (AuthService, JWT, OAuth, ...), "Data Layer" cluster (Neo4j, Cypher,
Repository, ...), "Frontend" cluster (React, Vite, D3, ...). This is a cheap architectural map.

Add TCG and you get temporal architecture: which parts are actively evolving, which are stable,
and which have hidden coupling (always change together despite no import relationship).

---

### UC8: Impact analysis

**Problem:** "If I change `AuthService`, what else is affected?" Need to know before making changes
to avoid breaking unrelated parts of the system.

| Layer     | Capability                 | How                                                                                                                                                                                                                                       |
| --------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KWG**   | Co-occurrence neighborhood | `AuthService` → CO_OCCURS → `JWT`, `TokenManager`, `SecurityAuditLog` → files mentioning those → approximate impact radius                                                                                                                |
| **TCG**   | **Co-evolution impact**    | `auth.ts` historically co-changes with `token-manager.ts` (90%), `auth.test.ts` (85%), `session-store.ts` (60%) → these files are likely affected even if there's no import relationship. This is the strongest non-static impact signal. |
| **TCG**   | Blast radius estimation    | File has been touched in 47 commits, by 3 authors, and is imported by 12 other files → high blast radius.                                                                                                                                 |
| **Drift** | Pre-existing issues        | drift-doc-code already flagged `docs/auth.md` as stale → "if you're changing auth.ts, you _must_ update auth.md too."                                                                                                                     |
| **SCG**   | Call graph impact          | `AuthService.validate()` → CALLS → `TokenManager.verify()` → CALLS → `Redis.get()` → precise structural impact chain                                                                                                                      |
| **SKG**   | Semantic impact            | `AuthService` → DEPENDS_ON → `TokenManager` → USED_BY → `PaymentService` → doc says "critical for billing" → semantic impact context                                                                                                      |
| **DCG**   | Runtime impact             | Runtime call graph shows `AuthService` is invoked by 15 endpoints, with 10k calls/day on `/api/login` → prioritize testing                                                                                                                |

**Evidence-first impact analysis:**

```bash
# Phase A: evidence-based impact (∼2 seconds, $0)
iw impact auth.ts --session X
# → KWG: AuthService co-occurs with JWT, TokenManager, RefreshEndpoint in 4 files
# → TCG: auth.ts co-changes with token-manager.ts (90%), session-store.ts (60%)
# → Drift: docs/auth.md is stale (6 months, 12 code changes since)
# → Combined: 6 files likely affected, 1 doc needs updating

# Phase B: structural confirmation (∼seconds, $0)
iw impact auth.ts --session X --layer scg
# → SCG: AuthService.validate() called by LoginController, APIGateway. 12 transitive dependents.
# → Confirms 4 of the 6 files, adds 2 more from transitive call graph

# Phase C: semantic enrichment (if SKG exists, $0 from cache)
iw impact auth.ts --session X --full
# → SKG: AuthService is a critical component. DECIDED_FOR OAuth. 3 docs reference it.
# → Full picture: 8 files, 3 docs, 12 transitive code dependents
```

**Key insight:** TCG co-change data is the most surprising and valuable impact signal. Static
analysis misses files that have no import relationship but always change together (e.g.,
`auth.ts` and `auth.test.ts`, or `auth.ts` and `session-store.ts` connected via runtime behavior).

---

### UC9: Finding contradictions in spec/doc or code

**Problem:** Spec says "use PostgreSQL" but architecture doc says "decided for Neo4j". Or doc says
`AuthService` is stateless but code shows it has instance state.

| Layer     | Capability                         | How                                                                                                                                                                                                                                                                       |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KWG**   | Conflicting mention evidence       | `PostgreSQL` mention with `decision` qualifier in `docs/db-eval.md`. `Neo4j` mention with `decision` qualifier in `docs/arch.md`. Same heading pattern ("Database Selection") → two documents claim different decisions. The mentions _are_ the evidence.                 |
| **KWG+**  | Cross-document drift               | Same entity's co-occurrence neighborhood differs significantly between two documents → topic has diverged                                                                                                                                                                 |
| **TCG**   | Temporal contradiction signal      | `docs/db-eval.md` last modified 2 years ago. `docs/arch.md` modified 2 months ago. The newer doc is probably correct → temporal evidence about which version is authoritative.                                                                                            |
| **Drift** | **Primary contradiction detector** | drift-doc-doc: Two documents describe the same topic but disagree on key mentions. drift-doc-code: Doc says "AuthService is a function" but AST says it's a class. drift-deps: `package.json` has `pg` (PostgreSQL driver) but architecture doc says "decided for Neo4j". |
| **SCG**   | Code contradicts docs              | Structural confirmation: doc says "AuthService is a function" but SCG shows `Entity:Class{name: "AuthService"}`                                                                                                                                                           |
| **SKG**   | Full contradiction detection       | `DECIDED_FOR PostgreSQL` in one doc, `DECIDED_FOR Neo4j` for same purpose in another → explicit contradiction. `AuthService DECIDED_AGAINST stateful` but code has instance vars → spec/code mismatch                                                                     |

**Evidence-first contradiction detection:**

> The key insight is that most contradictions can be _flagged_ without LLM by combining:
>
> 1. KWG mention evidence (the actual sentences)
> 2. TCG temporal ordering (which version is newer?)
> 3. Drift detection (doc↔code, doc↔doc, deps↔architecture)
>
> The SKG can _confirm and structure_ contradictions, but the evidence layers provide the
> detection signal.

**Progressive workflow:**

```bash
# Phase A: evidence-based contradiction flags ($0)
iw doc-health --neo4j -s X
# → "⚠️  Potential contradiction: 'PostgreSQL' has decision qualifier in docs/db-eval.md,
#     'Neo4j' has decision qualifier in docs/arch.md. Both in database context.
#     TCG: docs/db-eval.md last modified 2 years ago (4 commits).
#          docs/arch.md last modified 2 months ago (12 commits).
#     Likely: db-eval.md is outdated."

# Phase C: drift detection ($0)
iw doc-health --neo4j -s X
# → "❌  Drift: docs/arch.md says AuthService is stateless.
#     SCG: AuthService has 3 instance properties.
#     Confidence: high (structural evidence)."

# Optional: semantic confirmation (requires SKG)
iw build skg docs/db-eval.md docs/arch.md --session X --persist
iw doc-health --neo4j -s X --only doc-code,temporal
# → "Confirmed contradiction: DECIDED_FOR PostgreSQL vs DECIDED_FOR Neo4j
#     for the same purpose (primary database). Recommend: archive db-eval.md."
```

---

## 11. Competitive Landscape

### 11.1 Solution Comparison

|                                | **IntentWeave (proposed)**                                                          | **Microsoft GraphRAG**            | **LlamaIndex KG**            | **LangChain + Neo4j**        | **Zep**                     | **FalkorDB GraphRAG**        |
| ------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------- | ---------------------------- | ---------------------------- | --------------------------- | ---------------------------- |
| **Primary focus**              | Multi-layer code + doc intelligence                                                 | Document QA via graph communities | KG-augmented RAG             | Chain-based RAG + graph QA   | LLM memory                  | Graph-native RAG             |
| **Graph construction**         | Multi-layer: KWG (regex) + SCG (AST) + SKG (LLM)                                    | LLM-only entity extraction        | LLM-only or manual triplets  | LLM-only NL→Cypher           | LLM conversation extraction | LLM entity extraction        |
| **Cheapest useful graph**      | **$0** (KWG co-occurrence)                                                          | $$ (requires LLM extraction)      | $$ (requires LLM extraction) | $$ (requires LLM extraction) | $ (per conversation)        | $$ (requires LLM extraction) |
| **Evidence model (mentions)**  | **Yes** — Mentions as first-class nodes with source sentences, headings, qualifiers | No — entities only                | No                           | No                           | No                          | No                           |
| **Signal qualifiers**          | **Yes** — decision, deprecated, planned, risk, etc. on mentions                     | No                                | No                           | No                           | No                          | No                           |
| **Temporal/git signals (TCG)** | **Yes** — co-change, hotspots, ownership, staleness from git                        | No                                | No                           | No                           | No                          | No                           |
| **Drift detection**            | **Yes** — doc↔code, doc↔doc, deps, temporal                                         | No                                | No                           | No                           | No                          | No                           |
| **Code-aware**                 | **Yes** (AST, xlink, CodeRef)                                                       | No                                | No                           | No                           | No                          | No                           |
| **Incremental updates**        | **Yes** (content-addressed cache)                                                   | Rebuild required                  | Partial                      | Manual                       | Conversation-level          | Rebuild required             |
| **Community detection**        | Proposed (KWG clusters)                                                             | **Yes** (Leiden, core feature)    | No                           | No                           | No                          | Basic                        |
| **Global QA**                  | Via cluster summaries                                                               | **Yes** (community summaries)     | No                           | No                           | No                          | Basic                        |
| **Cross-doc dedup**            | **Yes** (GX merge)                                                                  | Basic                             | No                           | No                           | No                          | No                           |
| **Predicate types**            | **30 canonical** + KWG verb hints (opt-in)                                          | Generic (LLM-chosen)              | Generic                      | Generic                      | Generic                     | Generic                      |
| **Storage backend**            | Neo4j                                                                               | Parquet + optional graph          | Multiple (Neo4j, Kuzu, etc.) | Neo4j, others                | Postgres + graph            | FalkorDB (Redis-compat)      |
| **MCP integration**            | **Yes** (6 tools)                                                                   | No                                | No                           | No                           | No                          | No                           |
| **Agent-oriented**             | **Yes** (progressive context)                                                       | Library use                       | Library use                  | Library use                  | Library use                 | Library use                  |
| **Doc health / drift**         | **Yes** (evidence-based, multi-signal)                                              | No                                | No                           | No                           | No                          | No                           |
| **Impact analysis**            | **Yes** (multi-layer + TCG co-change)                                               | No                                | No                           | No                           | No                          | No                           |
| **Open source**                | Apache-2.0                                                                          | MIT                               | MIT                          | MIT                          | Apache-2.0                  | MIT                          |

### 11.2 Detailed Comparisons

#### Microsoft GraphRAG

**What it does well:**

- Community-based summarization — Leiden clustering + LLM summaries of each community
- Two query modes: local (entity neighborhood) and global (community summaries)
- Well-researched (Microsoft Research paper, extensive benchmarks)

**Where IntentWeave differs:**

- GraphRAG requires LLM for **all** graph construction. IntentWeave's KWG gives you a traversable
  graph for $0 — then optionally enriches with LLM.
- GraphRAG has no concept of code structure. IntentWeave integrates AST analysis (SCG layer).
- GraphRAG rebuilds from scratch. IntentWeave has incremental content-addressed caching.
- GraphRAG is a library (Python). IntentWeave is a CLI + MCP server + REST API + UI.

**What IntentWeave should adopt from GraphRAG:**

- Community-based summarization of KWG clusters (use LLM to name/describe clusters)
- The two-mode query pattern (local entity traversal + global cluster overview)
- Leiden algorithm for community detection (when Neo4j GDS is available)

#### LlamaIndex Knowledge Graph

**What it does well:**

- Flexible KG backends (Neo4j, Kuzu, NebulaGraph, in-memory)
- Hybrid retrieval: vector + KG traversal combined
- Good documentation, active community

**Where IntentWeave differs:**

- LlamaIndex KG requires LLM to build the graph. No cheap alternative.
- No code awareness — treats source files as text documents.
- No built-in entity canonicalization (GX equivalent).
- No multi-layer architecture — single graph, single extraction method.
- No incremental updates (partial support via document insertion APIs).

**What IntentWeave should adopt from LlamaIndex:**

- Hybrid retrieval (vector seeds + graph traversal) — proposed in §9
- Multiple backend support (though Neo4j is the right choice for us)

#### LangChain Neo4j Integration

**What it does well:**

- `Neo4jVector` — vector store directly in Neo4j
- `GraphCypherQAChain` — NL→Cypher question answering
- Easy integration with existing LangChain pipelines

**Where IntentWeave differs:**

- LangChain is a framework; IntentWeave is a product. LangChain requires assembly; IntentWeave
  works out of the box.
- LangChain's NL→Cypher is fragile (hallucinated property names). IntentWeave's MCP tools
  provide structured access that's more reliable.
- No community detection, no code awareness, no incremental updates.

**What IntentWeave should adopt from LangChain:**

- Nothing specific — IntentWeave's `iw query` already does NL→Cypher better (with schema-aware
  system prompts and session scoping).

#### Zep

**What it does well:**

- Purpose-built for LLM memory — tracks conversation entities across sessions
- Automatic entity extraction from conversations
- Fast retrieval for chat applications

**Where IntentWeave differs:**

- Zep is conversation-focused; IntentWeave is document/code-focused.
- Different data model: Zep tracks conversation state, IntentWeave tracks project knowledge.
- Complementary rather than competitive — Zep for chat memory, IntentWeave for project knowledge.

#### FalkorDB GraphRAG

**What it does well:**

- Redis-compatible graph DB — very fast for small-medium graphs
- Built-in vector + graph hybrid queries
- Simple API, easy to get started

**Where IntentWeave differs:**

- FalkorDB is a database + basic RAG toolkit. IntentWeave is a full extraction platform.
- No multi-layer architecture, no code awareness, no incremental caching.
- Neo4j is more mature for complex graph queries (Cypher, GDS algorithms).

### 11.3 Unique IntentWeave Differentiators

| Differentiator                         | Why it matters                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Evidence graph, not semantic graph** | No other tool stores mentions as first-class nodes with source sentences. You always know _where_ knowledge came from.        |
| **Signal qualifiers on mentions**      | `decision`, `deprecated`, `planned`, `risk` — structured metadata on raw evidence without LLM. No other tool does this.       |
| **TCG: git as knowledge source**       | Co-change = hidden coupling. Hotspots = refactoring candidates. Ownership = bus factor. No GraphRAG tool queries git history. |
| **Drift detectors**                    | doc↔code, doc↔doc, deps↔architecture, temporal staleness. Actionable signals without LLM.                                     |
| **Multi-layer with $0 base**           | No other tool gives you a useful graph without LLM spend                                                                      |
| **Code + docs in one graph**           | No other tool cross-links semantic knowledge with AST structure                                                               |
| **30 canonical predicates**            | Typed, directed relationships vs. generic "related to"                                                                        |
| **Incremental caching**                | Build once, update incrementally — critical for large projects                                                                |
| **Progressive enrichment**             | Start cheap, invest where it matters — evidence triage → targeted SKG                                                         |
| **Agent-native (MCP)**                 | Built for AI agent consumption, not just human dashboards                                                                     |
| **Fully offline capable**              | Local embeddings + local LLM (Ollama) → zero cloud dependency                                                                 |
| **Product + Framework**                | Use as CLI tool or compose as TypeScript libraries in your own pipeline                                                       |
| **OSS (Apache-2.0)**                   | Full platform open source — no feature-gated tiers in the core                                                                |

### 11.4 Feature Matrix by Use Case

| Use Case                       | IntentWeave | MS GraphRAG | LlamaIndex | LangChain | Zep | FalkorDB |
| ------------------------------ | :---------: | :---------: | :--------: | :-------: | :-: | :------: |
| Doc↔code disconnection         |      ●      |      ◌      |     ◌      |     ◌     |  ◌  |    ◌     |
| Duplicate detection            |      ●      |      ◕      |     ◔      |     ◔     |  ◌  |    ◔     |
| Design decision tracking       |      ●      |      ◕      |     ◔      |     ◔     |  ◌  |    ◔     |
| Doc freshness/health           |      ●      |      ◌      |     ◌      |     ◌     |  ◌  |    ◌     |
| Code refactoring support       |      ●      |      ◌      |     ◌      |     ◌     |  ◌  |    ◌     |
| Agent context (MCP)            |      ●      |      ◌      |     ◕      |     ◕     |  ◕  |    ◔     |
| Architecture discovery         |      ●      |      ◕      |     ◔      |     ◔     |  ◌  |    ◔     |
| Impact analysis                |      ●      |      ◌      |     ◌      |     ◌     |  ◌  |    ◌     |
| Contradiction detection        |      ●      |      ◔      |     ◌      |     ◌     |  ◌  |    ◌     |
| Temporal/git intelligence      |      ●      |      ◌      |     ◌      |     ◌     |  ◌  |    ◌     |
| Drift detection (multi-signal) |      ●      |      ◌      |     ◌      |     ◌     |  ◌  |    ◌     |
| General document QA            |      ◕      |      ●      |     ●      |     ●     |  ◕  |    ●     |
| Conversation memory            |      ◌      |      ◌      |     ◌      |     ◕     |  ●  |    ◌     |

_Legend: ◌ = not supported, ◔ = minimal, ◕ = good, ● = excellent_

**IntentWeave's position:** Strongest in code+doc intelligence, impact analysis, and progressive
enrichment. Competitive in general document QA. Not designed for conversation memory (Zep's niche).

---

## 12. Progressive Enrichment Workflow

### The typical workflow

```bash
# ──────────────────────────────────────────────────────
# Step 1: Free, instant — "what's mentioned where?"
# ──────────────────────────────────────────────────────
iw build kwg --session my-project --persist
# → KWG in Neo4j: keyword entities, mentions with qualifiers, co-occurrence edges, concept clusters
# → Already useful for: entity discovery, agent orientation, basic impact, doc health triage

# ──────────────────────────────────────────────────────
# Step 2: Free, seconds — "what changed when, and with what?"
# ──────────────────────────────────────────────────────
iw build tcg --session my-project --persist
# → TCG in Neo4j: commits, co-change edges, hotspots, ownership, staleness scores
# → Unlocks: "what else should I update?", temporal staleness, bus factor, hidden coupling

# ──────────────────────────────────────────────────────
# Step 3: Free, instant — "what's broken or stale?"
# ──────────────────────────────────────────────────────
iw doc-health --neo4j -s my-project
# → Drift detectors run against KWG + TCG: doc↔code, doc↔doc, deps, temporal
# → Actionable: "docs/auth.md is stale — 12 code changes since last doc update, signature drifted"

# ──────────────────────────────────────────────────────
# Step 4: Free, minutes — "what's the code structure?"
# ──────────────────────────────────────────────────────
iw build scg --session my-project --persist
# → SCG in Neo4j: classes, functions, imports, call graph, inheritance
# → Cross-linked with KWG automatically

# ──────────────────────────────────────────────────────
# Step 5: Triage — "what's worth extracting?"
# ──────────────────────────────────────────────────────
iw query "high-degree KWG entities not yet in SKG" --session my-project
# → "AuthService (co-occurs with 12 entities, 5 decision mentions), DataPipeline (8), PaymentGateway (7)"
# → These are the concepts worth spending LLM tokens on

# ──────────────────────────────────────────────────────
# Step 6: Selective LLM extraction — "what does it mean?"
# ──────────────────────────────────────────────────────
iw build skg docs/arch.md docs/auth.md --session my-project --provider openai -i --persist
# → SKG for only the high-value documents. Incremental: skip unchanged.
# → EVIDENCED_BY links back to KWG mentions that motivated the extraction

# ──────────────────────────────────────────────────────
# Step 7: Cross-link — "connect the layers"
# ──────────────────────────────────────────────────────
iw xlink --session my-project --persist
# → SKG↔SCG links (Canon entities → CodeRef nodes)

# ──────────────────────────────────────────────────────
# Step 8: Embed — "enable vector search"
# ──────────────────────────────────────────────────────
iw embed --session my-project
# → Vector index on Canon entities (~$0.00 with local ONNX)
```

### Shorthand

```bash
# Everything free (evidence graph + code structure):
iw build --cheap --session my-project --persist
# → Runs: kwg + tcg + doc-health + scg + embed

# Everything including LLM:
iw build --full --session my-project --provider openai -i --persist
# → Runs: kwg + tcg + doc-health + scg + triage + skg + xlink + embed
```

### Cost summary

| Step         | What runs                                     | Time  | Cost      | Cumulative value                                        |
| ------------ | --------------------------------------------- | ----- | --------- | ------------------------------------------------------- |
| `build kwg`  | Regex + mentions + co-occurrence + clustering | ~2s   | $0.00     | Keyword graph, mentions with qualifiers, clusters       |
| `build tcg`  | Git log parsing + co-change analysis          | ~5s   | $0.00     | + temporal signals, co-change, hotspots, ownership      |
| `doc-health` | Drift detectors (KWG + TCG)                   | ~1s   | $0.00     | + staleness reports, drift signals, contradiction flags |
| `build scg`  | AST parsing + ref resolution                  | ~2min | $0.00     | + code structure, call graph                            |
| `build skg`  | LLM extraction + canonicalization             | ~5min | ~$0.30    | + semantic relationships, decisions                     |
| `xlink`      | Name/import/dep matching                      | ~1s   | $0.00     | + code↔knowledge links                                  |
| `embed`      | Local vector embeddings (ONNX)                | ~2s   | **$0.00** | + hybrid retrieval, fuzzy matching                      |

> **Note:** Steps 1-4 (`--cheap`) are all free and complete in under 3 minutes for a typical
> project. This is the evidence graph — already sufficient for impact analysis, doc health,
> agent context, and architecture discovery. Steps 5-8 add semantic structure where the evidence
> shows it's worth the LLM investment.

### How layers compose at query time

```
User: "What handles authentication?"

╔══════════════════════════════════════════════════════════════╗
║  Query Router                                                ║
║  Available layers: [KWG ✓] [TCG ✓] [SCG ✓] [SKG ✓] [DCG ✗] ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  1. KWG: mention + co-occurrence lookup                      ║
║     "authentication" → AuthService(5 mentions), JWT(4),      ║
║     OAuth(3). Cluster: "Auth Concern" (envelope).            ║
║     Qualifiers: 2× decision, 1× deprecated (BasicAuth)      ║
║     → candidate entities + source sentences + qualifiers     ║
║                                                              ║
║  2. TCG: temporal enrichment                                 ║
║     AuthService → last modified 3 days ago, 47 commits,      ║
║     co-changes with token-manager.ts (90%)                   ║
║     → recency, volatility, related files                     ║
║                                                              ║
║  3. SCG: code structure enrichment                           ║
║     AuthService → class in src/auth.ts                       ║
║     → methods: validate(), refresh(), revoke()               ║
║     → calls: TokenManager.verify(), Redis.get()              ║
║                                                              ║
║  4. SKG: semantic enrichment                                 ║
║     AuthService DEPENDS_ON TokenManager                      ║
║     AuthService DECIDED_FOR OAuth (over SAML)                ║
║     → typed, directed relationships                          ║
║                                                              ║
║  5. Combine → context document → LLM → answer               ║
╚══════════════════════════════════════════════════════════════╝
```

The query works with **any subset of layers**. KWG-only gives a decent answer. Each additional
layer makes it more precise. No layer is strictly required except KWG (the cheapest).

---

## 13. Strategy: Open Source

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   IntentWeave OSS                            │
│                   Apache-2.0                                 │
│                                                             │
│  @intentweave/core          Types, interfaces, predicates   │
│  @intentweave/analyzer      Pipeline engine (all layers)    │
│  @intentweave/index         CARI — SQLite index + queries   │
│  @intentweave/cli           `iw` commands + MCP server      │
│  @intentweave/server-core   Fastify + Neo4j + middleware    │
│  @intentweave/server-open   REST API routes                 │
│  @intentweave/profiles      Extraction profile packs        │
│  @intentweave/ast-extractor Tree-sitter AST (TS/JS/Swift)  │
│  @intentweave/swift-parser  Swift-specific parsing          │
│  apps/server                Runnable server                 │
│  apps/ui                    React visualization             │
└─────────────────────────────────────────────────────────────┘
```

Everything is free, open-source, and Apache-2.0 licensed.

### CodeGraph → IntentWeave consolidation

The SCG layer currently exists in two places:

- **CodeGraph** (`codegraph/`) — mature ts-morph-based parser with CgId system, Neo4j integration
- **IntentWeave AX stage** — tree-sitter-based extraction (TS/JS + Swift)

**Decision:** Consolidate into IntentWeave. The AX stage becomes the canonical SCG implementation.
CodeGraph's mature patterns (CgId, call resolution, import tracking) inform the design, but the
implementation lives in `@intentweave/ast-extractor` and future language-specific packages.

Rationale:

- One product, one brand, one ecosystem
- Users install `@intentweave/cli` and get everything: KWG + SCG + SKG
- No dependency on a separate project
- tree-sitter supports many languages (TS, JS, Swift, Python, Rust, Go, ...) — more extensible
  than ts-morph (TypeScript-only)

---

## 14. Product vs. Framework Surface

IntentWeave serves two audiences:

### 14.1 As a Product (CLI / Server / UI)

For users who want to **use it directly** — install, run, query.

```bash
# Install
npm install -g @intentweave/cli

# Build graph (free layers)
iw build --cheap --session my-project --persist

# Build graph (all layers)
iw build --full --session my-project --provider openai -i --persist

# Query
iw query "What are the main components?" --session my-project

# Start server
iw server --session my-project

# MCP for agents
iw mcp --session my-project
```

### 14.2 As a Framework (composable libraries)

For developers who want to **build on top of it** — import packages, compose pipelines, extend.

```typescript
import {
  scanKeywords,
  linkCooccurrence,
  detectClusters,
} from "@intentweave/analyzer";
import { parseAst, resolveRefs } from "@intentweave/ast-extractor";
import {
  extractTriples,
  canonicalize,
  mergeGlobal,
} from "@intentweave/analyzer";
import { OnnxEmbeddingProvider } from "@intentweave/core";
import { Neo4jPersister } from "@intentweave/analyzer";

// Build a custom pipeline
const files = await discoverFiles("./docs");

// Layer 1: KWG
const keywords = await scanKeywords(files);
const cooccurrences = await linkCooccurrence(files, keywords, { window: 2 });
const clusters = detectClusters(cooccurrences, { threshold: 3 });

// Layer 2: SCG
const ast = await parseAst("./src", { languages: ["typescript"] });
const refs = await resolveRefs(ast);

// Layer 3: SKG (optional — requires LLM provider)
const chunks = await chunkDocs(files);
const triples = await extractTriples(chunks, { provider: "openai" });
const canon = await canonicalize(triples);
const merged = mergeGlobal(canon);

// Embed (local, free)
const embedder = new OnnxEmbeddingProvider("all-MiniLM-L6-v2");
for (const entity of merged.entities) {
  entity.embedding = await embedder.embed(`${entity.type}: ${entity.name}`);
}

// Persist
const persister = new Neo4jPersister(neo4jDriver);
await persister.persistKwg(keywords, cooccurrences, clusters, "my-session");
await persister.persistScg(ast, refs, "my-session");
await persister.persistSkg(merged, "my-session");
```

### 14.3 Framework extension points

| Extension point        | Interface           | Example                                    |
| ---------------------- | ------------------- | ------------------------------------------ |
| **LLM Provider**       | `LLMProvider`       | Custom local model, Anthropic, Gemini      |
| **Embedding Provider** | `EmbeddingProvider` | Custom embedding model, Cohere, Voyage     |
| **Language Parser**    | `LanguageParser`    | Add Python, Rust, Go AST extraction        |
| **Profile Pack**       | `ExtractionProfile` | Domain-specific entity types + prompts     |
| **Persister**          | `GraphPersister`    | Alternative graph DBs (Memgraph, FalkorDB) |
| **Keyword Extractor**  | `KeywordExtractor`  | Custom entity detection rules              |
| **Query Handler**      | `QueryHandler`      | Custom query strategies                    |

### 14.4 Package architecture for dual use

```
@intentweave/core           ← types, interfaces, predicates (framework foundation)
@intentweave/analyzer       ← pipeline stages as composable functions (framework)
@intentweave/ast-extractor  ← AST parsing, language-pluggable (framework)
@intentweave/profiles       ← extraction profiles (framework)
@intentweave/cli            ← `iw` commands (product — composes framework packages)
@intentweave/server-core    ← Fastify + middleware (product)
@intentweave/server-open    ← REST API routes (product)
apps/server                 ← Runnable server (product)
apps/ui                     ← React UI (product)
```

The split is clean: `core`, `analyzer`, `ast-extractor`, `profiles` are **framework packages** —
pure library, no CLI, no server. `cli`, `server-*`, `apps/*` are **product packages** — they
compose the framework into a usable tool.

Framework users can depend on just the libraries:

```json
{
  "dependencies": {
    "@intentweave/core": "^1.0.0",
    "@intentweave/analyzer": "^1.0.0",
    "@intentweave/ast-extractor": "^1.0.0"
  }
}
```

---

## 15. Roadmap & Open Questions

### Implementation Phases

The roadmap follows the evidence-first principle: build the non-LLM foundation, then add semantic
overlays where evidence shows they're needed.

#### Phase A: Mention & Evidence Graph — ✅ Complete

> **Goal:** A useful, queryable graph for $0 — mentions, co-occurrence, clusters, signal qualifiers.
>
> **Detailed spec:** [PHASE-A-SPEC.md](PHASE-A-SPEC.md) — split into "Build-Now v1" (minimal E2E
> happy path) and "Target Architecture v2+" (interfaces, abstractions for later).

**Build-Now v1 pipeline:** `IN → KWX → COX → CLX → persist`

| Stage   | Purpose                                                                                 | Scope         |
| ------- | --------------------------------------------------------------------------------------- | ------------- |
| **KWX** | Keyword extraction: mentions, qualifiers, positions                                     | Per-file      |
| **COX** | Co-occurrence edge computation (per-doc sliding window, then session-level aggregation) | Session-level |
| **CLX** | Cluster detection (connected components, envelope entities)                             | Session-level |

**v1 approach — one implementation per concern, no interfaces:**

| Concern             | v1 implementation                                                       | v2 (when needed)                                            |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Keyword extraction  | `HeuristicKeywordExtractor` (class)                                     | `KeywordExtractor` interface + `DictionaryKeywordExtractor` |
| Qualifier detection | `RegexQualifierDetector` (class)                                        | `QualifierDetector` interface + `LLMQualifierDetector`      |
| Co-occurrence       | `SlidingWindowCoOccurrence` (class)                                     | `CoOccurrenceAnalyzer` interface + `PmiCoOccurrence`        |
| Persistence         | `persistKwg()` (direct Neo4j, basic delta: MERGE + file-level mentions) | `GraphPersister` interface + advanced delta                 |
| Embeddings          | _Not in v1_                                                             | `EmbeddingProvider` + ONNX/Ollama/OpenAI                    |
| Caching             | _Not in v1_                                                             | Content-addressed `KwgCache`                                |

**v1 design decisions:**

- No interfaces — abstractions earn their way in with a second implementation
- No incremental caching — full recompute takes <2s on 100 files (CPU-only, no LLM)
- Basic delta persistence — MERGE entities/docs, file-level delete+recreate mentions, session-level rewrite edges/clusters
- No embeddings — graph is structural and queryable via Cypher without vectors
- Co-occurrence computed **per-document** within sentence windows, then aggregated at session level

| Step                                                | Description                                                                                               | Effort     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------- |
| **1** Core types                                    | `MentionRecord`, `KwgEntityRecord`, `CoOccurrenceEdge`, `EntityCluster`, `SignalQualifier`, stage outputs | ½ day      |
| **2** `HeuristicKeywordExtractor`                   | Port from `preflightDocHealth.extractMarkdownEntities()` — headings, bold, code spans, identifiers        | 1 day      |
| **3** `RegexQualifierDetector`                      | Pattern matching for 8 qualifier types                                                                    | ½ day      |
| **4** `runKwxStage()`                               | Per-file keyword extraction + golden test                                                                 | 1 day      |
| **5** `SlidingWindowCoOccurrence` + `runCoxStage()` | Per-doc co-occurrence + session aggregation + golden test                                                 | 1 day      |
| **6** `detectClusters()` + `runClxStage()`          | Connected components + golden test                                                                        | ½ day      |
| **7** `persistKwg()`                                | Direct Neo4j persist (basic delta: MERGE entities/docs, file-level mentions) + integration test           | 1–1.5 days |
| **8** `iw build kwg` CLI                            | `iw build kwg <paths...> --session <name> [--persist] [--force] [-v]` + E2E test                          | 1 day      |

**CLI (v1):** `iw build kwg <paths...> --session <name> [--persist] [--force] [-v]`

**Exit criteria:** `iw build kwg --persist` produces a browsable keyword graph with mentions,
co-occurrence, and clusters. 3 golden tests pass. `iw query` and `iw context` work against
KWG data.

#### Phase B: Temporal Change Graph — ✅ Complete

> **Goal:** Git history as a first-class knowledge source — co-change, hotspots, ownership, staleness.

| Item                          | Description                                                                | Depends on          |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------- |
| **B1** Git log parser         | Parse `git log --numstat` / `git log --follow` into structured commit data | -                   |
| **B2** Co-change analysis     | `CO_CHANGED_WITH` edges with confidence scores                             | B1                  |
| **B3** Hotspot detection      | Files changed in >N% of recent commits, weighted by recency                | B1                  |
| **B4** Ownership/bus factor   | `OWNS` edges: author → file, with commit count + recency weighting         | B1                  |
| **B5** Staleness scoring      | `lastModified`, `commitCount`, `authorCount` on file nodes                 | B1                  |
| **B6** TCG Neo4j persistence  | Write `:TCG:*` nodes and edges to Neo4j                                    | B1-B5               |
| **B7** `iw build tcg` command | CLI command for TCG pipeline                                               | B1-B6               |
| **B8** TCG in `iw impact`     | Add co-change signals to impact analysis                                   | B2, existing impact |

**Exit criteria:** `iw build tcg --persist` produces co-change edges, hotspot scores, ownership
data. `iw impact` includes "co-changed with X (90%)" signals. Staleness scores available for
doc-health.

#### Phase C: Drift Detectors — ✅ Complete

> **Goal:** Actionable drift signals combining KWG + TCG + SCG, without LLM.

| Item                                  | Description                                                                           | Depends on |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| **C1** drift-doc-code                 | Doc mentions entity with wrong signature/type vs. SCG                                 | A1, SCG    |
| **C2** drift-temporal                 | Doc's mention footprint hasn't been updated despite code changes (uses TCG staleness) | A1, B5     |
| **C3** drift-deps                     | `package.json` / `Cargo.toml` dependencies vs. actual imports in code                 | SCG        |
| **C4** drift-doc-doc                  | Two docs cover same topic but mention footprints have diverged                        | A1, A3     |
| **C5** Integrate into `iw doc-health` | Drift detectors as the default `--lite` mode (replaces current keyword-only checks)   | C1-C4      |
| **C6** `--cheap` shorthand            | `iw build --cheap` = kwg + tcg + doc-health + scg + embed                             | A7, B7, C5 |

**Exit criteria:** `iw doc-health` reports evidence-based staleness, signature drift, and
cross-document divergence. `iw build --cheap` does a full evidence graph build in <3 minutes.

#### Phase D: Selective SKG Overlays — ✅ Complete

> **Goal:** LLM extraction only where evidence warrants it — SKG as enhancement, not foundation.

| Item                                 | Description                                                                                     | Status                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **D-1** Evidence-guided triage       | Score KWG entities by mention density, file spread, qualifier signals → rank candidates for SKG | ✅ `triageAnalyzer.ts`, `iw triage` CLI   |
| **D-2** `EVIDENCED_BY` linking       | Canon entities → KWG mentions that support them (name match, same-file, position)               | ✅ `evidenceLinker.ts`, `iw evidence` CLI |
| **D-3** Multi-layer Neo4j schema     | `:KWG`, `:TCG`, `:SCG`, `:SKG` label prefixes, layer-aware constraints/indexes                  | ✅ `graphSchema.ts`                       |
| **D-4** Layer-routed queries         | `--layer kwg\|tcg\|scg\|skg` flag on `iw query`, MCP `kg_query`                                 | ✅ `query.ts`, `mcp/server.ts`            |
| **D-5** Verb hint detector           | OpenIE-lite regex → weak `subject–verb–object` hints on co-occurring pairs. Off by default.     | ✅ `verbDetector.ts`, `--verb-hints` flag |
| **D-6** ONNX embedding provider      | Local all-MiniLM-L6-v2 (384-dim) via `@huggingface/transformers`. $0, no API key.               | ✅ `onnxEmbedding.ts`                     |
| **D-7** Embedding pipeline + CLI     | Embed Canon entities + KWEntities + KWClusters. Neo4j vector index.                             | ✅ `embedPipeline.ts`, `iw embed` CLI     |
| **D-8** `iw build full` orchestrator | 5-stage pipeline: CHEAP → TRIAGE → SKG → LINK → EMBED. Incremental FX/KX cache.                 | ✅ `buildFull.ts`                         |

#### Phase E: SCG Neo4j Persistence — ✅ Complete

> **Goal:** Persist the Static Code Graph (AX output) to Neo4j, completing the middle layer of the
> evidence stack and unlocking cross-layer queries, drift detection, and the progressive enrichment
> feedback loop.

**Production metrics (intentweave session):**

| SCG Node/Edge            | Count                  |
| ------------------------ | ---------------------- |
| `:SCG:Dir`               | 73                     |
| `:SCG:File`              | 250                    |
| `:SCG:Symbol`            | 5,128                  |
| `SCG_CONTAINS`           | 5,448                  |
| `SCG_IMPORTS`            | 0 (see remaining gaps) |
| `REALIZED_BY` (KWG→SCG)  | 1,448                  |
| `EVIDENCED_BY` (SKG→KWG) | 4,875                  |

**What SCG persistence unlocked:**

| Capability                        | Section | Status                                                                   |
| --------------------------------- | ------- | ------------------------------------------------------------------------ |
| **KWG → SCG cross-link**          | §6      | ✅ 1,448 `REALIZED_BY` edges grounding keyword mentions to AST symbols   |
| **SKG → SCG cross-link**          | §6      | ✅ Canon entities link to real `:SCG:Symbol` nodes, not stubs            |
| **Doc ↔ Code drift**              | §4.7.1  | ⚠️ Partial — runs against in-memory AX, not yet ported to Cypher (E-6)   |
| **Dependency drift**              | §4.7.2  | ⚠️ Blocked — needs `SCG_IMPORTS` edges                                   |
| **Progressive enrichment loop**   | §3      | ✅ "Entities in KWG but NOT in SCG" yields drift signals                 |
| **`iw build scg` command**        | §5.4    | ✅ `iw build scg --session X --persist` operational                      |
| **Full 3-layer Cypher traversal** | §7      | ✅ KWG → SCG → SKG traversal works in single Cypher query                |
| **KWG+ unified visualization**    | —       | ✅ Bonus: 4-layer graph UI with cross-layer bridge injection (see below) |

**Implementation results:**

| Step                                 | Description                                                                                              | Status     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------- |
| **E-1** `scgPersist.ts`              | `:SCG:Dir`, `:SCG:File`, `:SCG:Symbol` nodes + `SCG_CONTAINS` edges. Session-scoped, idempotent (MERGE). | ✅         |
| **E-2** `iw build scg` subcommand    | Standalone SCG build + persist with `--session`, `--persist`, `--incremental`.                           | ✅         |
| **E-3** Wire into cheap/full         | SCG persist in `iw build cheap --persist` and `iw build full --persist`.                                 | ✅         |
| **E-4** Update `graphSchema.ts`      | SCG layer in schema. MCP/query routing with `--layer code`.                                              | ✅         |
| **E-5** KWG↔SCG `REALIZED_BY` linker | Build-time name+filePath join: `(:KW:Entity)-[:REALIZED_BY]->(:SCG:Symbol)`.                             | ✅         |
| **E-6** Doc↔Code drift (Neo4j)       | Port in-memory drift to Cypher queries against KWG + SCG.                                                | ⚠️ Partial |

**Remaining gaps:**

| Gap                 | Description                                                                                                      | Impact                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `SCG_IMPORTS` edges | Import relationships between `:SCG:File` nodes not yet extracted/persisted                                       | Blocks dependency drift (§4.7.2), circular-dep detection                          |
| E-6 Cypher port     | `docCodeDrift.ts` still reads in-memory `AxOutput` for code symbols instead of querying `:SCG:Symbol` from Neo4j | Drift detection works but doesn't benefit from Neo4j joins or incremental updates |

#### Phase E+ (Bonus): KWG+ Unified Visualization

> **Goal:** A single graph view that renders all four layers (KWG + TCG + SCG + Drift) with
> cross-layer edges, enabling visual inspection of the full evidence stack.

Not in the original plan — emerged as the natural way to validate cross-layer connectivity.

| Item                            | Description                                                                          | Status           |
| ------------------------------- | ------------------------------------------------------------------------------------ | ---------------- |
| **E+1** `kwg-plus-graph.ts`     | 5-section graph builder: KWG → TCG → SCG → cross-links → drift                       | ✅               |
| **E+2** Cypher bridge injection | Query Neo4j for file-path overlaps, inject SAME_FILE/GROUNDED_IN edges at query time | ✅               |
| **E+3** Drift→file linking      | DriftSignals link to `:SCG:File`/`:TCG:File` nodes via `files[]` property            | ✅               |
| **E+4** Evaluation test suite   | 10-test suite measuring SCG isolation, cross-layer %, bridge correctness             | ✅ 43/43 passing |
| **E+5** UI predicates           | `GROUNDED_IN`, `DRIFTED`, `DRIFTED_FILE` labels in React UI                          | ✅               |

**KWG+ cross-layer metrics:**

- SCG isolated ratio: 19% (target: <30%) — down from 100% before bridge injection
- Drift isolated ratio: 0% (target: 0%) — down from 100%
- Cross-layer edges: 102/469 (21.7%) — SAME_FILE, GROUNDED_IN, DRIFTED_FILE
- Bridge types: TCGFile↔SCGFile (SAME_FILE), KWDoc↔TCGFile (SAME_FILE), KWEntity→SCG:Symbol (GROUNDED_IN)

---

#### Future (Phase F+)

| Item                           | Description                                                           |
| ------------------------------ | --------------------------------------------------------------------- |
| SCG extended sub-graphs        | API Surface, Test Coverage, Config Graph, Build/Runtime Wiring (§4.3) |
| DCG: runtime trace integration | `trace-calls` stage with instrumentation                              |
| Additional language parsers    | Python, Rust, Go via tree-sitter                                      |
| Neo4j GDS community detection  | Leiden/Louvain for better clustering at scale                         |
| Cluster summarization (LLM)    | Optional LLM-generated cluster labels/descriptions                    |
| Framework API stabilization    | Clean exports from analyzer, ast-extractor, core                      |

### Phase timeline

```
Phase A:  ████████████████  KWG v1: mentions, co-occurrence, clusters     ✅ Complete
Phase B:  ████████████████  TCG from git: co-change, hotspots, ownership  ✅ Complete
Phase C:  ████████████████  Drift detectors: doc↔code, temporal           ✅ Complete
Phase D:  ████████████████  Selective SKG overlays: triage, embed, full   ✅ Complete
Phase E:  ██████████████░░  SCG Neo4j + cross-layer + KWG+ visualization  ✅ Complete (2 gaps)
Phase F+: ░░░░░░░░░░░░░░░░  Extended SCG, DCG, GDS, SaaS                 📋 Planned
```

> **Status (2026-03-16):** Phases A–E are complete. The full 5-layer evidence graph (KWG + TCG +
> SCG + Drift + SKG) is persisted to Neo4j with 2,453 keyword entities, 5,128 code symbols, 345
> tracked files, 1,721 drift signals, and 2,911 canon entities. Cross-layer linking works:
> 1,448 `REALIZED_BY` edges connect keywords to code, 4,875 `EVIDENCED_BY` edges connect SKG
> to KWG. The KWG+ unified visualization renders all layers with 21.7% cross-layer connectivity.
> **Two gaps remain:** `SCG_IMPORTS` edges (import relationships) and porting `docCodeDrift` from
> in-memory AX to Neo4j Cypher queries (E-6).

### Open questions

| #   | Question                                                     | Options                                                               | Recommendation                                                                        |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Should `iw build kwg` replace `iw doc-health --lite`?        | (a) Replace, (b) Keep both, (c) `--lite` becomes alias                | **(c)** `--lite` = build kwg + run drift detectors                                    |
| 2   | Should cluster labels be auto-generated by LLM?              | (a) Highest-degree member, (b) LLM naming, (c) Both                   | **(c)** v1: heuristic, v2: optional LLM naming                                        |
| 3   | Should verb extraction (OpenIE-lite) be on by default?       | (a) Always, (b) Opt-in, (c) Off by default                            | **(c)** Off by default — weak hints, not semantics. Opt-in with `--verb-hints`.       |
| 4   | Should vector embedding happen automatically on `--persist`? | (a) Always, (b) With `--embed` flag, (c) Separate command             | **(a)** Always — local embeddings are free, no API key needed                         |
| 5   | How should layers interact in `iw query`?                    | (a) Query router auto-selects, (b) User specifies `--layer`, (c) Both | **(c)** Auto by default, `--layer` for explicit control                               |
| 6   | Default local embedding model?                               | (a) all-MiniLM-L6-v2, (b) nomic-embed-text, (c) BGE-small             | **(a)** Best speed/quality/size trade-off, Apache-2.0                                 |
| 7   | ONNX Runtime vs. Transformers.js for local embeddings?       | (a) ONNX, (b) Transformers.js, (c) Both with auto-detect              | **(a)** ONNX — faster, more portable, better Node.js support                          |
| 8   | Should `iw build --cheap` auto-embed?                        | (a) Yes, (b) No (only with `--embed`), (c) Only if model cached       | **(a)** Yes — `--cheap` should include embed since it's free with ONNX                |
| 9   | Should TCG co-change thresholds be configurable?             | (a) Fixed (70%), (b) Per-project config, (c) Auto-calibrate           | **(b)** Per-project config with sensible default (70%)                                |
| 10  | Should drift detectors run automatically on every `build`?   | (a) Always, (b) Only with `--cheap`/`--full`, (c) Separate command    | **(b)** Part of `--cheap` and `--full`, but `iw doc-health` also runs them standalone |

---

### Retrospective: Phases A–E

#### What worked well

1. **Evidence-first principle validated.** Building the $0 foundation (KWG, TCG, drift) before
   adding LLM overlays (SKG) meant the graph was already useful before incurring API costs.
   The evidence layers caught real drift signals and structural patterns that LLM extraction alone
   would have missed.

2. **Incremental phase delivery.** Each phase produced a testable artifact with clear exit
   criteria (`iw build kwg --persist`, `iw build tcg --persist`, etc.). This made it easy to
   validate progress in isolation before integrating cross-layer concerns.

3. **Neo4j as the integration surface.** Having all layers in a single Neo4j instance with
   label prefixes (`:KWG:*`, `:TCG:*`, `:SCG:*`, `:SKG:*`) meant cross-layer queries could be
   explored ad-hoc via Cypher before building UI or CLI features around them.

4. **MCP/CLI as the verification loop.** `iw query --cypher` and the MCP `kg_query` tool
   provided ground-truth production metrics (live node/edge counts) that caught discrepancies
   between what the code _should_ produce and what Neo4j _actually_ contains.

#### What could be done better

1. **Schema documentation lagged behind implementation.** The DriftSignal Neo4j schema used
   `name`, `files[]`, `message`, `category` — but the visualization code assumed `headline`,
   `file` (singular), `anchorEntity`, `anchorDoc`. This mismatch went undetected until the
   drift layer showed 100% isolation in the KWG+ graph. **Lesson:** Persist a machine-readable
   schema manifest (e.g., `schema.json` generated from `graphSchema.ts`) and validate new code
   against it.

2. **Cross-layer connectivity was an afterthought.** Each layer was designed and persisted
   independently, but the _bridge edges_ between layers (SAME*FILE, GROUNDED_IN, DRIFTED_FILE)
   were only added when the KWG+ visualization revealed disconnected subgraphs. **Lesson:**
   Define cross-layer edge contracts \_alongside* each phase, not after the fact. The roadmap
   should have included a "cross-layer linking" sub-step in every phase.

3. **`SCG_IMPORTS` was deferred too long.** The original plan listed `SCG_IMPORTS` as part of
   E-1, but in practice only `SCG_CONTAINS` was implemented because containment was sufficient
   for the immediate use cases (REALIZED_BY linking, drift file matching). Import edges would
   have unlocked dependency drift (§4.7.2) and circular-dep detection. **Lesson:** When a step
   has two sub-deliverables, split them into separate tracked items so one doesn't silently drop.

4. **In-memory ↔ Neo4j duality creates maintenance burden.** The drift detectors work against
   in-memory `AxOutput` but the visualization queries Neo4j. Two code paths for the same data
   means bugs in one don't surface in the other. **Lesson:** Once data is persisted to Neo4j,
   port consumers to query Neo4j rather than maintaining parallel in-memory paths.

5. **Visualization drove better architecture.** The KWG+ graph was not in the original plan,
   but building it forced the team to think about node identity, file-path normalization, and
   bridge injection — all of which improved the underlying data model. **Lesson:** Build a
   visual cross-layer view early (even a rough one) to surface integration gaps before they
   compound.

#### Recommendations for Phase F+

- **Ship `SCG_IMPORTS` before extending to new languages.** Import edges are the prerequisite for
  dependency drift, dead-export detection, and the full progressive enrichment loop.
- **Port `docCodeDrift` to Cypher (E-6).** This removes the last in-memory→Neo4j duality and
  enables incremental drift detection without re-running AX.
- **Generate `schema.json` from `graphSchema.ts`.** Use it as a contract: new code that
  references Neo4j properties must pass a schema lint check.
- **Add cross-layer edge definitions to each new phase spec.** Every phase that introduces a
  new node type should also specify which existing layers it connects to and via what predicates.

---

_End of specification._
