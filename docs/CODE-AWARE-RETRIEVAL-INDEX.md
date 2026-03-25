# Code-Aware Retrieval Index (CARI)

> **Status:** Implemented (Phases 1–5 complete, 92 tests passing)
> **Date:** 2026-03-19 (spec) / 2026-03-21 (Phase 5 complete)
> **Package:** `packages/index` (`@intentweave/index`)
> **Context:** Evolution of the IntentWeave layered graph architecture toward a lightweight,
> agent-friendly, CI-integrable retrieval index.

## 1. Problem Statement

IntentWeave's layered knowledge graph (KWG + TCG + SCG + SKG + Drift) is technically validated but
architecturally heavy: Neo4j dependency, 14+ node types, Cypher query language, minutes-long build
pipeline. Meanwhile, the three concrete use cases it serves — **PR-time drift detection**, **agent
context retrieval**, and **interconnection discovery** — don't require a full graph database.

The industry is moving toward agents with tool use (grep, file read, symbol search). For small/medium
repos, an agent with grep matches or exceeds a knowledge graph for most queries. But at scale (1k+
files), agents need **ranked retrieval** — and a code-aware index that knows about symbols,
doc↔code annotations, and co-relevance is strictly better than vector-only or grep-only retrieval.

**Goal:** Distill IntentWeave's proven extraction stages into a **lightweight, precomputed index**
stored in SQLite (or exported as JSON), consumable by agents, CI, and editors — without requiring
Neo4j, Cypher, or LLM calls.

## 2. Design Principles

| #   | Principle                  | Implication                                                                             |
| --- | -------------------------- | --------------------------------------------------------------------------------------- |
| 1   | **$0 by default**          | No LLM calls in the core pipeline. Local AST + heuristics + git only.                   |
| 2   | **Single file output**     | Index is one `.iw/index.db` (SQLite) or `.iw/index.json`. No server needed.             |
| 3   | **Predefined use cases**   | Users don't query the index — agents and CI consume it via predefined APIs.             |
| 4   | **Statistical indication** | Scores and weights, not binary truth. Co-occurrence is a signal, not a fact.            |
| 5   | **Incremental**            | On-save or on-commit update. Not a batch pipeline users must remember to run.           |
| 6   | **Agent-native**           | MCP tools or file-readable format. Agents ask structured questions, get ranked answers. |
| 7   | **CI-native**              | `iw check --pr` exits 0/1 with actionable findings. No Neo4j in CI.                     |

## 3. What the Index Contains

### 3.1 Symbol Registry

Every exported code symbol, extracted via tree-sitter (AST). Already built: `packages/ast-extractor`.

```
┌──────────────────────────────────────────────────────────────────────┐
│ symbols                                                              │
├──────────┬───────────┬──────────┬────────────────┬──────┬───────────┤
│ id (PK)  │ name      │ kind     │ file_path      │ line │ export    │
├──────────┼───────────┼──────────┼────────────────┼──────┼───────────┤
│ impl:... │ AuthSvc   │ class    │ src/auth/svc.ts│ 12   │ exported  │
│ impl:... │ validate  │ method   │ src/auth/svc.ts│ 45   │ exported  │
│ impl:... │ JwtUtil   │ class    │ src/auth/jwt.ts│ 8    │ internal  │
└──────────┴───────────┴──────────┴────────────────┴──────┴───────────┘
```

**Source:** `AxOutput` from `packages/ast-extractor`. Fields: `id`, `name`, `kind`, `container`,
`signature`, `filePath`, `span`, `export`, `parameters`, `docSummary`.

**Filter:** By default, only `exported` symbols + all `class`/`interface`/`enum` regardless of
export. Internal helper functions are noise for doc↔code linking.

### 3.2 Doc Annotations (doc span → code symbol)

The core data structure. Each annotation links a text span in a document to a code symbol.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ annotations                                                                      │
├──────┬────────────┬──────┬──────────────────┬───────────┬────────────┬───────────┤
│ id   │ doc_path   │ line │ text             │ symbol_id │ confidence │ source    │
├──────┼────────────┼──────┼──────────────────┼───────────┼────────────┼───────────┤
│ 1    │ docs/auth  │ 47   │ AuthService      │ impl:...  │ 0.95       │ exact     │
│ 2    │ docs/auth  │ 52   │ validateUser     │ impl:...  │ 0.88       │ slug      │
│ 3    │ docs/arch  │ 15   │ authentication   │ NULL      │ 0.40       │ heading   │
│ 4    │ docs/auth  │ 80   │ jwt tokens       │ impl:...  │ 0.60       │ token     │
└──────┴────────────┴──────┴──────────────────┴───────────┴────────────┴───────────┘
```

**`confidence` scoring:**

| Match type   | Score     | Description                                                 |
| ------------ | --------- | ----------------------------------------------------------- |
| `exact`      | 0.90–1.0  | Doc text exactly matches symbol name (case-insensitive)     |
| `slug`       | 0.75–0.90 | Slugified forms match (`validate-user` ↔ `validateUser`)    |
| `token`      | 0.50–0.75 | Token overlap ≥50% (multi-word mentions)                    |
| `heading`    | 0.30–0.50 | Heading/bold text matches but no direct code symbol         |
| `ungrounded` | 0.0–0.30  | Keyword entity with no code match (concept, decision, etc.) |

**`source` — how the mention was detected (from KWX):**
`heading` | `bold` | `code-span` | `identifier` | `dictionary` | `custom-pattern`

> **`dictionary`** source (Phase 5): In `--depth full` mode, the KWX stage builds a symbol
> dictionary from AX output and scans markdown body text for matches using word-boundary regex.
> Dictionary-sourced annotations receive IDF penalties to suppress high-frequency terms.

**Annotations with `symbol_id = NULL`** are ungrounded mentions — concepts, decisions, requirements
that exist in docs but have no code counterpart. These are still valuable: they represent the
"architecture around the code" and feed into drift detection (if a decision exists in docs but
nothing in code implements it, that's a signal).

**TF-IDF filtering (implemented):** Before annotation, filler words are suppressed via IDF scoring.
`computeIdf()` in `packages/index/src/idf.ts` computes inverse document frequency across the corpus.
Terms appearing in many documents get low IDF scores. A baseline of **50 common stopwords**
("system", "implementation", "approach", etc.) is pre-seeded at `STOPWORD_CEILING = 0.15` even in
small corpora. The annotator applies IDF as a confidence multiplier on `dictionary` and `identifier`
sources only — structured sources (`heading`, `bold`, `code-span`) are exempt. A floor of `0.1`
prevents complete suppression.

Benchmark results on the IntentWeave repo:

- High-value terms: ~0.857 confidence
- Filler words: floored at 0.1
- Full-depth mode: +72% annotations, +189% grounded links vs structured-only

### 3.3 Co-occurrence Scores

How often two symbols (or keywords) are mentioned together. Already computed: `CoxStageOutput`.

```
┌─────────────────────────────────────────────────────────────────────┐
│ co_occurrences                                                      │
├───────────┬───────────┬───────┬───────┬───────────────┬────────────┤
│ entity_a  │ entity_b  │ count │ score │ file_paths    │ source     │
├───────────┼───────────┼───────┼───────┼───────────────┼────────────┤
│ AuthSvc   │ JwtUtil   │ 8     │ 0.72  │ [auth.md,...] │ doc_cooc   │
│ AuthSvc   │ RateLimit │ 4     │ 0.45  │ [sec.md,...]  │ doc_cooc   │
│ AuthSvc   │ UserModel │ 12    │ 0.91  │ [auth.md,...] │ code_import│
└───────────┴───────────┴───────┴───────┴───────────────┴────────────┘
```

**Two sources of co-occurrence:**

| Source        | What it captures                                                | From           |
| ------------- | --------------------------------------------------------------- | -------------- |
| `doc_cooc`    | Two entities mentioned near each other in docs (sliding window) | COX stage      |
| `code_import` | Two symbols in the same file or import chain                    | AST extraction |

**The insight lives in the gap:** Entities that co-occur in docs but NOT in code imports = conceptual
coupling without structural coupling. Entities that co-import in code but NOT in docs = undocumented
dependency.

### 3.4 Co-change Scores

How often two files change together in git. Already computed: `CocStageOutput`.

```
┌──────────────────────────────────────────────────────────────────────┐
│ co_changes                                                           │
├───────────────────┬───────────────────┬────────┬─────────┬──────────┤
│ file_a            │ file_b            │ count  │ jaccard │ recency  │
├───────────────────┼───────────────────┼────────┼─────────┼──────────┤
│ src/auth/svc.ts   │ src/auth/jwt.ts   │ 15     │ 0.68    │ 0.95     │
│ src/auth/svc.ts   │ docs/auth.md      │ 3      │ 0.12    │ 0.30     │
│ src/pay/stripe.ts │ src/pay/webhook.ts│ 22     │ 0.81    │ 0.88     │
└───────────────────┴───────────────────┴────────┴─────────┴──────────┘
```

**`recency`:** Exponential decay — recent co-changes count more. A pair that co-changed last week
matters more than a pair that co-changed a year ago.

### 3.5 File Metadata

Per-file staleness and ownership. Already computed: `HotStageOutput` + `OwnStageOutput` + `StlStageOutput`.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ files                                                                                  │
├──────────────────┬─────────────┬──────┬─────────┬───────────────┬──────────┬──────────┤
│ path             │ last_mod    │ churn│ hotspot │ primary_owner │ bus_fac  │ is_doc   │
├──────────────────┼─────────────┼──────┼─────────┼───────────────┼──────────┼──────────┤
│ src/auth/svc.ts  │ 2026-03-15  │ 450  │ true    │ alice         │ 2        │ false    │
│ docs/auth.md     │ 2026-02-01  │ 30   │ false   │ bob           │ 1        │ true     │
│ src/pay/stripe.ts│ 2026-03-18  │ 800  │ true    │ alice         │ 1        │ false    │
└──────────────────┴─────────────┴──────┴─────────┴───────────────┴──────────┴──────────┘
```

## 4. Index Storage

### 4.1 SQLite (primary)

Single file: `.iw/index.db`. Zero-config, no server, works in CI.

```sql
-- Core tables
CREATE TABLE symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,        -- function|class|method|interface|type|enum
  container TEXT,            -- parent class/module name
  signature TEXT,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER,
  export TEXT NOT NULL,      -- exported|internal
  doc_summary TEXT
);

CREATE TABLE annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  text TEXT NOT NULL,
  symbol_id TEXT,            -- FK → symbols.id (NULL = ungrounded)
  confidence REAL NOT NULL,
  source TEXT NOT NULL,      -- heading|bold|code-span|identifier|...
  qualifier TEXT,            -- decision|deprecated|planned|must|should|...
  idf_score REAL,           -- inverse document frequency (filtering)
  FOREIGN KEY (symbol_id) REFERENCES symbols(id)
);

CREATE TABLE co_occurrences (
  entity_a TEXT NOT NULL,
  entity_b TEXT NOT NULL,
  count INTEGER NOT NULL,
  score REAL NOT NULL,       -- normalized 0–1
  source TEXT NOT NULL,      -- doc_cooc|code_import
  file_paths TEXT,           -- JSON array
  PRIMARY KEY (entity_a, entity_b, source)
);

CREATE TABLE co_changes (
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  count INTEGER NOT NULL,
  jaccard REAL NOT NULL,
  recency REAL NOT NULL,     -- exponential decay score
  commit_hashes TEXT,        -- JSON array
  PRIMARY KEY (file_a, file_b)
);

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  last_modified TEXT,        -- ISO-8601
  churn INTEGER,             -- total lines added + removed
  is_hotspot BOOLEAN,
  primary_owner TEXT,
  bus_factor INTEGER,
  is_doc BOOLEAN,
  content_hash TEXT          -- SHA-256 for incremental updates
);

-- Indexes for retrieval
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_path);
CREATE INDEX idx_annotations_doc ON annotations(doc_path);
CREATE INDEX idx_annotations_symbol ON annotations(symbol_id);
CREATE INDEX idx_annotations_confidence ON annotations(confidence);
CREATE INDEX idx_co_occurrences_score ON co_occurrences(score);
CREATE INDEX idx_co_changes_jaccard ON co_changes(jaccard);
CREATE INDEX idx_files_doc ON files(is_doc);

-- Full-text search for fuzzy retrieval
CREATE VIRTUAL TABLE symbols_fts USING fts5(name, signature, doc_summary, content=symbols);
CREATE VIRTUAL TABLE annotations_fts USING fts5(text, content=annotations);
```

**Size estimate:** For a 5k-file repo with ~50k symbols and ~100k annotations: ~20–50 MB.
Fits in memory for fast queries.

### 4.2 JSON Export (portable)

For environments where SQLite isn't available (browser, some CI), export a flat JSON:

```json
{
  "$schema": "intentweave://schemas/cari/v1",
  "version": "1.0",
  "generatedAt": "2026-03-19T10:00:00Z",
  "session": "my-project",
  "stats": {
    "symbols": 5128,
    "annotations": 12450,
    "coOccurrences": 3200,
    "coChanges": 890,
    "files": 450
  },
  "symbols": [ ... ],
  "annotations": [ ... ],
  "coOccurrences": [ ... ],
  "coChanges": [ ... ],
  "files": [ ... ]
}
```

JSON is read-only (for agents that can consume files). SQLite is the read-write working format.

## 5. Predefined Query Modes

Users don't query the index directly. These are the **predefined APIs** consumed by agents, CI, and
editors.

### 5.1 `retrieve` — Agent Context Retrieval

**Input:** A natural language topic or symbol name.
**Output:** Ranked list of files + relevant spans, with reasons.

```
iw retrieve "authentication" --limit 10

# Returns:
# 1. src/auth/service.ts     (score: 0.95) — 12 annotations, AuthService class
# 2. docs/auth.md            (score: 0.92) — 18 mentions, primary auth doc
# 3. src/auth/jwt.ts         (score: 0.78) — co-occurs with AuthService (0.72)
# 4. src/middleware/rate.ts   (score: 0.45) — co-changes with auth (jaccard 0.31)
# 5. docs/security.md        (score: 0.38) — 4 auth-related mentions
```

**Ranking algorithm:**

```
file_score(query, file) =
    α · annotation_relevance(query, file)   -- do annotations in this file match the query?
  + β · symbol_relevance(query, file)       -- do symbols in this file match the query?
  + γ · co_occurrence_boost(query, file)    -- is this file co-mentioned with query matches?
  + δ · co_change_boost(query, file)        -- does this file co-change with query matches?
  - ε · staleness_penalty(file)             -- penalize very old files

where α=0.4, β=0.3, γ=0.15, δ=0.10, ε=0.05
```

**MCP tool signature:**

```typescript
interface RetrieveParams {
  query: string; // NL topic or symbol name
  limit?: number; // default 10
  scope?: "code" | "docs" | "all"; // filter by file type
}

interface RetrieveResult {
  files: Array<{
    path: string;
    score: number;
    reason: string; // human-readable: "12 annotations matching 'auth'"
    spans?: Array<{ line: number; text: string }>; // relevant lines
  }>;
}
```

### 5.2 `connections` — Interconnection Discovery

**Input:** A symbol or keyword name.
**Output:** Related entities, scored and categorized by relationship type.

```
iw connections "AuthService" --limit 15

# Returns:
# Co-mentioned in docs:
#   JwtValidator     (score: 0.72, in 4 docs)
#   RateLimiter      (score: 0.45, in 2 docs)
#   SessionManager   (score: 0.38, in 3 docs)
#
# Co-changes in git:
#   src/auth/jwt.ts        (jaccard: 0.68, 15 commits)
#   src/middleware/rate.ts  (jaccard: 0.31, 5 commits)
#
# Structural (code imports):
#   UserModel        (direct import)
#   DatabasePool     (transitive, via UserModel)
#
# ⚠ Gaps:
#   RateLimiter co-mentioned in 2 docs but NO code dependency → hidden coupling?
#   DatabasePool imported in code but ZERO doc mentions → undocumented dependency
```

**The value is in the gaps.** This query cross-references three signals (doc co-occurrence, git
co-change, code structure) and highlights where they disagree.

**MCP tool signature:**

```typescript
interface ConnectionsParams {
  entity: string; // symbol name or keyword
  limit?: number;
  include?: ("doc_cooc" | "co_change" | "code_import")[]; // filter sources
}

interface ConnectionsResult {
  entity: string;
  connections: Array<{
    name: string;
    sources: Array<{
      type: "doc_cooc" | "co_change" | "code_import";
      score: number;
      detail: string; // "4 docs", "15 commits", "direct import"
    }>;
    gap?: string; // "co-mentioned but no code dependency"
  }>;
  gaps: Array<{
    description: string;
    severity: "info" | "warning";
    entities: string[];
  }>;
}
```

### 5.3 `check` — CI Drift Detection

**Input:** Changed files (from PR diff or git status).
**Output:** Actionable findings with exit code.

```
iw check --changed src/auth/service.ts src/auth/jwt.ts

# ⚠ docs/auth.md references AuthService (line 47, confidence 0.95)
#   but was last modified 2026-02-01 (42 days ago)
#   while src/auth/service.ts was modified 2026-03-15
#
# ⚠ docs/api.md references validateUser (line 112, confidence 0.88)
#   signature in doc: "validateUser(email, password)"
#   signature in code: "validateUser(credentials: Credentials)"
#
# ℹ src/auth/jwt.ts co-changes with src/middleware/rate.ts (jaccard 0.68)
#   but src/middleware/rate.ts is not in this PR — intentional?
#
# Exit code: 1 (2 warnings, 1 info)
```

**CI integration (GitHub Action):**

```yaml
- name: Check docs freshness
  run: iw check --changed $(git diff --name-only origin/main...HEAD) --format github
```

The `--format github` flag outputs GitHub Actions annotations (`::warning file=...`).

**MCP tool signature:**

```typescript
interface CheckParams {
  changed: string[]; // file paths from PR diff
  severity?: "info" | "warning" | "critical"; // minimum severity to report
  format?: "text" | "json" | "github";
}

interface CheckResult {
  findings: Array<{
    severity: "info" | "warning" | "critical";
    message: string;
    file: string;
    line?: number;
    related: string[]; // files that should be checked/updated
  }>;
  exitCode: number; // 0 = clean, 1 = warnings, 2 = critical
}
```

### 5.4 `report` — Corpus-Wide Insights (batch)

**Input:** None (runs against full index).
**Output:** Aggregate statistics and top findings.

```
iw report

# Documentation Coverage:
#   342 / 512 exported symbols documented (66.8%)
#   Top undocumented: PaymentGateway, WebhookHandler, MigrationRunner
#
# Staleness:
#   12 docs reference code modified in last 30 days but not updated
#   Top stale: docs/auth.md (42 days behind), docs/deploy.md (60 days behind)
#
# Hidden Couplings:
#   8 entity pairs co-mentioned in docs but no code dependency
#   Top: AuthService↔RateLimiter (4 docs, 0 imports)
#
# Undocumented Dependencies:
#   15 import relationships with zero doc mentions
#   Top: DatabasePool→ConnectionRetry (12 co-changes, 0 doc mentions)
#
# Documentation Fragmentation:
#   3 topics spread across >3 docs with diverging mention sets
```

## 6. Pipeline Architecture

### 6.1 Build Pipeline

```
Source files
    │
    ├── *.ts, *.js, *.swift         *.md, *.mdx
    │         │                          │
    │    ┌────▼─────┐             ┌──────▼──────┐
    │    │ AX Stage │             │  KWX Stage  │
    │    │ (AST)    │             │ (keywords)  │
    │    └────┬─────┘             └──────┬──────┘
    │         │                          │
    │    AxOutput                   KwxOutput[]
    │    (symbols)                  (mentions, entities)
    │         │                          │
    │         │    ┌─────────────────────┤
    │         │    │                     │
    │    ┌────▼────▼───┐          ┌──────▼──────┐
    │    │  Annotate    │          │  COX Stage  │
    │    │ (match doc   │          │ (co-occur)  │
    │    │  spans→code) │          └──────┬──────┘
    │    └────┬────────┘                 │
    │         │                    CoxOutput
    │    annotations[]             (co-occurrence edges)
    │         │                          │
    ├─────────┤                          │
    │         │                          │
    │    ┌────▼──────────────────────────▼───┐
    │    │         Git Analysis               │
    │    │  TCX → COC → HOT → OWN → STL     │
    │    └────┬──────────────────────────────┘
    │         │
    │    co-changes, hotspots, ownership, staleness
    │         │
    │    ┌────▼──────────────────────────────────┐
    │    │         SQLite Writer                   │
    │    │  symbols + annotations + co_occur +    │
    │    │  co_changes + files → .iw/index.db     │
    │    └────────────────────────────────────────┘
```

### 6.2 Incremental Updates

```
File changed (save / commit)
    │
    ├── content_hash matches index? → skip
    │
    ├── Code file changed:
    │     Re-extract symbols for that file only
    │     Re-score annotations referencing those symbols
    │     Update file metadata
    │
    ├── Doc file changed:
    │     Re-extract mentions for that file only
    │     Re-match annotations against symbol registry
    │     Recompute co-occurrence edges involving this file
    │
    └── Git commit:
          Update co-change scores (append, recompute jaccard)
          Update staleness/hotspot/ownership for changed files
```

**Content-addressed caching:** Each file's `content_hash` (SHA-256) is stored in the `files`
table. On incremental update, only files with changed hashes are reprocessed. The existing
`.iw/cache/` infrastructure can be reused.
