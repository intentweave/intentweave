# @intentweave/index

**Code-Aware Retrieval Index (CARI)** — a lightweight, precomputed SQLite index for
ranked file retrieval, connection discovery, and CI drift detection.

## What It Does

CARI combines three independent signals into a single queryable index:

| Signal                 | Source                                                     | What It Captures                                    |
| ---------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| **Code structure**     | AST extraction (tree-sitter)                               | Exported symbols, classes, functions, methods       |
| **Document semantics** | Keyword extraction (headings, bold, code spans, body text) | Mentions of code symbols in docs                    |
| **Temporal coupling**  | Git log analysis                                           | Co-change frequency, hotspots, staleness, ownership |

The output is a single `.iw/index.db` SQLite file. No LLM calls, no external services, $0 cost.

## Installation

```bash
pnpm add @intentweave/index
```

Or as part of the full IntentWeave CLI:

```bash
npm install -g @intentweave/cli
iw index build
```

## SQLite Schema

| Table            | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `symbols`        | Code symbols from AST extraction (name, kind, file, line, export status) |
| `annotations`    | Document spans linked to code symbols (confidence-scored, source-tagged) |
| `co_occurrences` | Entity pairs that appear together in docs or code                        |
| `co_changes`     | File pairs that change together in git (Jaccard + recency)               |
| `files`          | Per-file metadata (last modified, churn, hotspot, owner, content hash)   |

## API

### Build an Index

```typescript
import { buildIndex } from "@intentweave/index";

const stats = buildIndex(dbPath, {
  symbols, // AxOutput from ast-extractor
  annotations, // from annotate()
  coOccurrences, // from COX stage
  coChanges, // from TCG pipeline
  files, // file metadata
});
```

### Annotate Documents

```typescript
import { annotate } from "@intentweave/index";

const annotations = annotate(kwxOutputs, symbols, {
  minConfidence: 0.1,
  applyIdfPenalty: true, // enable IDF noise filtering for full-depth mode
  idfScores, // from computeIdf()
});
```

### Compute IDF Scores

```typescript
import { computeIdf } from "@intentweave/index";

const idfScores = computeIdf(kwxOutputs);
// High-value terms: ~0.85 confidence
// Filler words ("system", "data"): floored at 0.1
```

### Query the Index

```typescript
import { openIndex } from "@intentweave/index";

const db = openIndex(".iw/index.db");

// Ranked file retrieval
const files = db.retrieve({ query: "authentication", limit: 10 });

// Cross-layer connections
const conn = db.connections({ entity: "AuthService" });

// CI drift detection
const findings = db.check({ changed: ["src/auth.ts"] });

// Corpus-wide report
const report = db.report();
```

## Depth Modes

| Mode                     | Flag                 | Sources                                         | Use Case                                 |
| ------------------------ | -------------------- | ----------------------------------------------- | ---------------------------------------- |
| **Structured** (default) | `--depth structured` | Headings, bold, code spans, identifiers         | Fast, precise, low noise                 |
| **Full**                 | `--depth full`       | + body text dictionary matching + IDF filtering | Higher recall, more grounded annotations |

Full-depth mode uses a symbol dictionary (from AX) to match terms in markdown body text,
then applies IDF penalties to suppress high-frequency filler words. The IDF scorer includes
a baseline of 50 common stopwords pre-seeded at a 0.15 confidence ceiling.

## Benchmark

Measured on the IntentWeave monorepo (264 code files, 7 docs, 5316 symbols):

| Metric              | Structured |          Full |
| ------------------- | ---------: | ------------: |
| Build time          |      1.1 s |         2.8 s |
| Annotations         |      6,721 | 11,533 (+72%) |
| Grounded            |      2,548 | 7,360 (+189%) |
| Co-occurrence edges |      1,099 | 2,631 (+139%) |

## Dependencies

- `better-sqlite3` ^11.7.0 — synchronous SQLite for Node.js

## License

Apache-2.0
