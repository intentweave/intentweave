# IntentWeave — Overview

> **One-line:** IntentWeave turns your docs, code, and git history into a queryable
> knowledge index — no LLM calls, no database server, no configuration.

---

## What It Does

Software teams write documentation, but it drifts from reality. Code changes, docs don't.
New developers join and can't find which files matter for a given topic. CI pipelines
catch syntax errors but miss semantic ones: a renamed function that three docs still reference.

IntentWeave solves this with two complementary systems:

### 1. Knowledge Graph (KG) — Deep Semantic Extraction

Uses LLMs to extract entities, decisions, relationships, and constraints from natural-language
documents. Persists to Neo4j for rich graph queries. Best for architecture exploration,
decision archaeology, and impact analysis.

- **Input:** Markdown docs, source files (any language)
- **Output:** Neo4j graph with canonical entities, relationships, provenance
- **Cost:** LLM API calls (OpenAI)
- **Use case:** "What decisions were made about authentication?" → structured answer with sources

### 2. Code-Aware Retrieval Index (CARI) — Lightweight, Zero-Cost

Builds a precomputed SQLite index from AST parsing, keyword extraction, git history,
and co-occurrence analysis. No LLM calls, no external services.

- **Input:** Source code + docs + git log
- **Output:** Single `.iw/index.db` file (SQLite)
- **Cost:** $0 — runs entirely locally
- **Use case:** "Which files should I look at for authentication?" → ranked list with reasons

---

## Key Numbers (Real Benchmark)

Measured on the IntentWeave monorepo itself (264 code files, 7 docs, 5316 symbols):

| Metric                    | Structured Mode | Full-Depth Mode |
| ------------------------- | --------------: | --------------: |
| Build time                |           1.1 s |           2.8 s |
| Annotations               |           6,721 |          11,533 |
| Grounded (linked to code) |     2,548 (38%) |     7,360 (64%) |
| Co-occurrence edges       |           1,099 |           2,631 |
| IDF terms tracked         |               — |           2,843 |
| LLM calls                 |               0 |               0 |
| External dependencies     |               0 |               0 |
| Index file size           |           ~2 MB |           ~4 MB |

**Full-depth mode** adds +72% more annotations and +189% more grounded links by scanning
document body text with dictionary matching and IDF-based noise filtering.

**Incremental updates** re-index only changed files — typically < 1 second.

---

## How Teams Use It

### For Developers

| Task                    | Command / API                          | What You Get                                                |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Find relevant files     | `iw index retrieve "auth"`             | Ranked files with confidence scores and reasons             |
| Understand connections  | `iw index connections "AuthService"`   | Co-mentions, co-changes, structural links, and **gaps**     |
| Check before PR         | `iw index check --changed src/auth.ts` | Docs that reference changed code and may need updating      |
| Health dashboard        | `iw index report`                      | Coverage %, stale docs, hidden couplings, undocumented deps |
| Find code clones        | `clones()` / `structuralClones()`      | Exact (Type 1) and structural (Type 2) duplicate detection  |
| Circular imports        | `circularImports()`                    | Import cycles: A → B → C → A                               |
| Unused exports          | `unusedExports()`                      | Exported symbols never imported anywhere                    |
| Hotspot priorities      | `hotspotPriority()`                    | High-churn, low-doc files ranked by documentation urgency   |
| TODO/FIXME inventory    | `todos()`                              | All inline markers with file, line, and kind                |
| Coverage by module      | `moduleCoverage()`                     | Documentation coverage % rolled up per directory            |
| Orphaned doc sections   | `orphanedSections()`                   | Doc headings where all mentions are unresolved              |
| Doc completeness        | `docCompleteness()`                    | Per-doc score: how many referenced exports are covered      |
| Cross-group drift       | `crossGroupDrift()`                    | Entity coverage conflicts across doc groups                 |

### For CI/CD

```yaml
# GitHub Action — 2 lines
- run: npx @intentweave/cli index build
- run: npx @intentweave/cli index check --changed $(git diff --name-only origin/main...HEAD)
```

Exit code 0 = clean, 1 = warnings (stale docs, missing coverage).

### For AI Agents (MCP)

IntentWeave exposes tools via the Model Context Protocol, usable by GitHub Copilot
and other LLM agents:

**CARI tools** (local SQLite — no LLM or Neo4j needed):

| Tool                     | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `cari_retrieve`          | "Find files about X" → ranked results                      |
| `cari_connections`       | "What's related to X?" → cross-layer connections           |
| `cari_check`             | "I changed X — what else needs updating?" → drift findings |
| `cari_clones`            | Exact code clone detection                                 |
| `cari_structural_clones` | Type 2 clone detection                                     |
| `cari_circular_imports`  | Import cycle detection                                     |
| `cari_unused_exports`    | Unused exported symbols                                    |
| `cari_hotspot_priority`  | High-churn low-doc file ranking                            |
| `cari_todos`             | TODO/FIXME/HACK/XXX inventory                              |
| `cari_module_coverage`   | Documentation coverage per directory                       |
| `cari_orphaned_sections` | Doc sections with ungrounded mentions                      |
| `cari_doc_completeness`  | Per-doc completeness scoring                               |
| `cari_cross_group_drift` | Cross-group entity coverage conflicts                      |

**Knowledge Graph tools** (require Neo4j):

| Tool               | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `kg_query`         | Natural-language graph query                               |
| `kg_context`       | Build RAG context from knowledge graph                     |
| `kg_impact`        | Semantic impact analysis for file changes                  |

---

## Architecture at a Glance

```
Source Code ──► AST Extraction ──► Symbol Registry
                                        │
Markdown Docs ──► Keyword Extraction ──►│──► Annotation Engine ──► SQLite Index
                                        │         │                    │
Git History ──► Co-change Analysis ─────┘    IDF Filtering        .iw/index.db
                                                                       │
                                              ┌────────────────────────┤
                                              │                        │
                                        CLI Queries               MCP Tools
                                    (retrieve, check,          (cari_retrieve,
                                     connections, report,       cari_connections,
                                     clones, todos,             cari_check, cari_clones,
                                     moduleCoverage, ...)       cari_todos, ...13 total)
```

**No servers to run.** The index is a single SQLite file. 14 built-in query modes,
all predefined SQL — < 100ms latency. The entire pipeline is local and deterministic.

---

## Competitive Positioning

| Approach             | Cost   | Setup                     | Retrieval Quality                           | Doc Drift Detection |
| -------------------- | ------ | ------------------------- | ------------------------------------------- | ------------------- |
| grep / ripgrep       | $0     | None                      | Low (string match only)                     | None                |
| Vector embeddings    | $$$    | Embedding API + vector DB | Medium (semantic but lossy)                 | None                |
| Language servers     | $0     | Per-language setup        | High (structural only)                      | None                |
| **IntentWeave CARI** | **$0** | **`iw index build`**      | **High (structural + semantic + temporal)** | **Built-in**        |
| IntentWeave KG       | $$$    | Neo4j + LLM API           | Highest (full semantic graph)               | Built-in            |

CARI's advantage: it combines **three independent signals** (code structure, document semantics,
git history) into a single ranked score. When these signals disagree, that disagreement itself
is the most valuable finding — it reveals hidden couplings, undocumented dependencies, and stale docs.

---

## Getting Started

```bash
# Install
npm install -g @intentweave/cli

# Build the index (< 3 seconds for most projects)
cd your-project
iw init && iw index build

# Start querying
iw index retrieve "authentication"
iw index connections "UserService"
iw index report

# Add to CI
iw index check --changed $(git diff --name-only origin/main...HEAD)
```

For full documentation, see:

- [CLI Usage Guide](CLI-USAGE.md)
- [CARI Technical Specification](CODE-AWARE-RETRIEVAL-INDEX.md)
- [Website](https://intentweave.org)
- [README](../README.md)
