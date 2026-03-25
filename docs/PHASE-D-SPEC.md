# Phase D: Selective SKG Overlays — Detailed Specification

> **Version:** 0.1
> **Status:** Draft / Proposal
> **Date:** 2025-03-15
> **Parent:** [LAYERED-GRAPH-ARCHITECTURE.md](LAYERED-GRAPH-ARCHITECTURE.md) §15, Phase D
> **Depends on:** [PHASE-A-SPEC.md](PHASE-A-SPEC.md) (KWG built + persisted),
> [PHASE-B-SPEC.md](PHASE-B-SPEC.md) (TCG built + persisted),
> [PHASE-C-SPEC.md](PHASE-C-SPEC.md) (Drift detectors + `iw build cheap`),
> AX stage (AST extraction), existing open-track SKG pipeline (FX → KX → GX)
> **Scope:** Evidence-guided LLM triage, cross-layer EVIDENCED*BY linking,
> embeddings pipeline, multi-layer query router, `iw build full` orchestrator,
> and verb extraction hints. LLM cost is spent \_precisely* where Phases A-C
> identify high-value gaps.

---

## Document Structure

| Part                                          | Purpose                                                                                                              | Read when                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Part 1: Build-Now v1** (§1–§12)             | Evidence-guided triage, EVIDENCED_BY links, embeddings, query router, `iw build full`. Ship it, prove it works.      | Now — this is what we build next. |
| **Part 2: Target Architecture v2+** (§13–§17) | Additional parsers, cluster summarization, advanced hybrid retrieval, CI quality gates. Reference for future growth. | After v1 is stable and proven.    |

**Guiding rule:** Nothing from Part 2 enters the codebase until Part 1 is stable, tested, and
used in anger. Abstractions earn their way in with a concrete second implementation that needs them.

---

# Part 1: Build-Now v1

---

## Table of Contents (Part 1)

1. [Design Principles](#1-design-principles)
2. [What We Already Have](#2-what-we-already-have)
3. [D1: Evidence-Guided Triage](#3-d1-evidence-guided-triage)
4. [D2: EVIDENCED_BY Cross-Layer Links](#4-d2-evidenced_by-cross-layer-links)
5. [D3: Verb Extraction Hints](#5-d3-verb-extraction-hints)
6. [D4: `iw build full`](#6-d4-iw-build-full)
7. [D5: Embeddings Pipeline](#7-d5-embeddings-pipeline)
8. [D6: Multi-Layer Query Router](#8-d6-multi-layer-query-router)
9. [D8: LLM-Assisted Drift Triage](#9-d8-llm-assisted-drift-triage)
10. [Neo4j Schema Extensions](#10-neo4j-schema-extensions)
11. [Golden Tests](#11-golden-tests)
12. [Implementation Plan (Build-Now)](#12-implementation-plan-build-now)

> **Note:** D7 (additional language parsers) is deferred to Part 2. It's independently
> valuable but doesn't depend on — or block — the core Phase D flow. The existing TypeScript
>
> - Swift parsers cover the primary use cases.

---

## 1. Design Principles

### 1.1 One implementation, no interface (continued)

Same rule as Phases A-C: every new capability is a single concrete function. No
`TriageStrategy` interface — just `triageFromEvidence()`. No `EmbeddingProvider` interface —
just `embedWithOnnx()` (v1 uses ONNX only; when OpenAI embeddings are needed, introduce the
interface then).

**Exception:** `LLMProvider.embed()` already exists as an optional method on the interface
(see `packages/core/src/interfaces.ts:48`). v1 adds the ONNX implementation and calls it
through that interface. This is the rare case where the interface came free — we don't need
a new one.

### 1.2 LLM cost is evidence-guided, never blanket

Every LLM call in Phase D is justified by evidence from Phases A-C:

```
KWG entity with 15 mentions, 8 co-occurrences, high cluster degree
  + NOT already in SKG
  + HAS drift signals (signature mismatch, doc divergence)
  → CANDIDATE for LLM extraction
```

No entity gets an LLM call "just because it exists." The triage function ranks candidates by
evidence score and caps at a configurable budget (default: 50 entities per run).

### 1.3 Embeddings are local-first, always-on

v1 uses ONNX Runtime with `all-MiniLM-L6-v2` (Apache-2.0, 22MB). No API key needed, no
cost, runs in ~50ms per batch of 100 texts. Embeddings run as part of every `build full`
and can optionally run in `build cheap` with `--embed`.

### 1.4 Query routing is additive, not exclusive

The multi-layer query router doesn't replace existing `iw query` behavior — it extends it.
By default, the LLM sees the full schema (KWG + SKG + TCG + Drift). Users can constrain
with `--layer kwg|skg|tcg|drift|all` (default: `all`).

### 1.5 Compose from existing data, don't re-extract

Same principle as Phase C: D1 triage queries existing KWG/TCG/Drift data and ranks entities.
D2 linking matches existing Canon entities to existing KWG mentions. D5 embeddings operate
on entities already persisted. No stage re-parses source files.

---

## 2. What We Already Have

### 2.1 KWG Layer (Phase A — complete)

| Artifact          | Location                                     | Description                                                     |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------- |
| `KWEntity` nodes  | Neo4j `:KWEntity`                            | 2202+ entities with `mentionCount`, `qualifiers`                |
| `KWMention` nodes | Neo4j `:KWMention`                           | 5286+ mentions with `entityName`, `text`, `heading`, `filePath` |
| `CO_OCCURS` edges | Neo4j `(:KWEntity)-[:CO_OCCURS]-(:KWEntity)` | 907+ co-occurrence edges with `count`, `score`                  |
| `KWCluster` nodes | Neo4j `:KWCluster`                           | 32+ clusters with `label`, `members`                            |
| `KWDoc` nodes     | Neo4j `:KWDoc`                               | Per-document metadata                                           |

### 2.2 TCG Layer (Phase B — complete)

| Artifact                | Location                                 | Description                                    |
| ----------------------- | ---------------------------------------- | ---------------------------------------------- |
| `TCGCommit` nodes       | Neo4j `:TCGCommit`                       | 20+ commits with hash, author, date            |
| `TCGFile` nodes         | Neo4j `:TCGFile`                         | 345+ file nodes with ownership, hotspot scores |
| `CO_CHANGED_WITH` edges | Neo4j                                    | 60+ temporal co-change edges                   |
| Cross-layer links       | Neo4j `INTRODUCED_IN`, `LAST_TOUCHED_IN` | 712+ KWEntity ↔ TCGCommit links                |

### 2.3 Drift Layer (Phase C — complete)

| Artifact            | Location             | Description                              |
| ------------------- | -------------------- | ---------------------------------------- |
| `DriftSignal` nodes | Neo4j `:DriftSignal` | 1684+ signals (11 critical, 628 warning) |
| 4 detectors         | CLI + lib            | doc↔code, temporal, deps, doc↔doc        |
| `iw build cheap`    | CLI                  | Full $0 evidence pipeline                |
| `iw doc-health`     | CLI                  | Unified drift report                     |

### 2.4 SKG Layer (existing open track)

| Artifact              | Location                | Description                                      |
| --------------------- | ----------------------- | ------------------------------------------------ |
| FX → KX → GX pipeline | `@intentweave/analyzer` | LLM-based semantic extraction                    |
| `Canon:Entity` nodes  | Neo4j `:Canon:Entity`   | Semantic entities with type, confidence, aliases |
| `CANON_REL` edges     | Neo4j `{predicate}`     | 30 canonical predicates                          |
| `RawTriple` nodes     | Neo4j `:RawTriple`      | Pre-canonicalization triples                     |
| Cross-layer links     | Neo4j `REALIZED_BY`     | Canon → CodeRef code links                       |

### 2.5 Code Layer (AX/ast-extractor)

| Artifact        | Location                     | Description                       |
| --------------- | ---------------------------- | --------------------------------- |
| TS/JS extractor | `@intentweave/ast-extractor` | tree-sitter TypeScript/JavaScript |
| Swift extractor | `@intentweave/swift-parser`  | tree-sitter Swift                 |
| AX stage output | `@intentweave/analyzer`      | 5021+ code symbols                |
| `CodeRef` nodes | Neo4j `:CodeRef`             | Function/class/type references    |

### 2.6 Embedding Infrastructure (partial)

| Artifact                    | Location                                            | Description                                |
| --------------------------- | --------------------------------------------------- | ------------------------------------------ |
| `LLMProvider.embed?()`      | `packages/core/src/interfaces.ts:48`                | Optional method on interface               |
| `supportsEmbeddings`        | `packages/core/src/interfaces.ts:133`               | Capability flag                            |
| `OpenAILLMProvider.embed()` | `packages/analyzer/src/providers/llm/openai.ts:312` | Implemented, uses `text-embedding-3-small` |
| No ONNX provider            | —                                                   | Not yet implemented                        |
| No vector index             | Neo4j                                               | Not yet created                            |

---

## 3. D1: Evidence-Guided Triage

### 3.1 Problem

The existing SKG pipeline (FX → KX → GX) runs LLM extraction on _every_ chunk blindly —
equal cost per chunk regardless of whether it contains high-value entities or boilerplate.
With Phases A-C complete, we know _exactly_ which entities are most important:

- **High-degree KWG entities** (many mentions, many co-occurrences)
- **Entities with drift signals** (signature mismatch, doc divergence)
- **Cluster hub entities** (central to topic clusters)
- **Entities NOT yet in SKG** (gap between evidence graph and semantic graph)

### 3.2 Triage scoring function

```typescript
interface TriageCandidate {
  /** KWG entity name (lowercased, normalized) */
  entityName: string;
  /** Session that the entity belongs to */
  sessionId: string;

  // ── Evidence signals ──
  mentionCount: number; // from KWEntity.mentionCount
  coOccurrenceDegree: number; // count of CO_OCCURS edges
  clusterSize: number; // size of entity's cluster (0 if singleton)
  driftSignalCount: number; // count of DriftSignals that AFFECTS this entity
  driftMaxSeverity: string; // "critical" | "warning" | "info" | "none"
  isInSkg: boolean; // already has a matching Canon:Entity?

  // ── Computed ──
  score: number; // weighted evidence score
  rank: number; // 1-based rank (1 = highest priority)
}
```

### 3.3 Scoring formula

```
score = mentionCount × 1.0
      + coOccurrenceDegree × 2.0
      + clusterSize × 0.5
      + driftSignalCount × 3.0
      + (driftMaxSeverity === "critical" ? 10 : driftMaxSeverity === "warning" ? 5 : 0)
      + (isInSkg ? -20 : 0)     // penalize entities already extracted
```

**Rationale:**

- `coOccurrenceDegree × 2.0` — entities that co-occur with many others are structural hubs
- `driftSignalCount × 3.0` — drifted entities are the highest-value extraction targets
- `isInSkg ? -20` — don't waste LLM budget re-extracting what we already have

### 3.4 Implementation

**File:** `packages/cli/src/triage/triageAnalyzer.ts`

```typescript
import type { Driver } from "neo4j-driver";

export interface TriageOptions {
  sessionId: string;
  maxCandidates?: number; // default: 50
  minScore?: number; // default: 5
}

export interface TriageResult {
  candidates: TriageCandidate[];
  totalKwgEntities: number;
  totalSkgEntities: number;
  skippedAlreadyInSkg: number;
  skippedBelowThreshold: number;
}

/**
 * Query the evidence graph and rank KWG entities for LLM extraction.
 *
 * Runs a single Cypher query that computes all evidence signals per entity,
 * scores them, and returns the top-N candidates.
 */
export async function triageFromEvidence(
  driver: Driver,
  opts: TriageOptions,
): Promise<TriageResult> {
  // Implementation: single Cypher query with aggregate scoring
}
```

### 3.5 Cypher query (core logic)

```cypher
// D1: Evidence-guided triage — find high-value KWG entities not yet in SKG
MATCH (e:KWEntity {session_id: $sessionId})
OPTIONAL MATCH (e)-[co:CO_OCCURS]-()
WITH e, count(DISTINCT co) AS coOccDegree
OPTIONAL MATCH (e)<-[:CONTAINS]-(cl:KWCluster {session_id: $sessionId})
WITH e, coOccDegree, COALESCE(size(cl.members), 0) AS clusterSize
OPTIONAL MATCH (d:DriftSignal {session_id: $sessionId})-[:AFFECTS]->(e)
WITH e, coOccDegree, clusterSize,
     count(d) AS driftCount,
     COALESCE(
       CASE WHEN any(s IN collect(d.severity) WHERE s = 'critical') THEN 'critical'
            WHEN any(s IN collect(d.severity) WHERE s = 'warning') THEN 'warning'
            ELSE 'none' END,
       'none'
     ) AS maxSeverity
OPTIONAL MATCH (c:Canon:Entity {session_id: $sessionId})
  WHERE toLower(c.name) = toLower(e.name)
WITH e, coOccDegree, clusterSize, driftCount, maxSeverity,
     c IS NOT NULL AS isInSkg
WITH e, coOccDegree, clusterSize, driftCount, maxSeverity, isInSkg,
     e.mentionCount * 1.0
     + coOccDegree * 2.0
     + clusterSize * 0.5
     + driftCount * 3.0
     + CASE maxSeverity WHEN 'critical' THEN 10 WHEN 'warning' THEN 5 ELSE 0 END
     + CASE WHEN isInSkg THEN -20 ELSE 0 END AS score
WHERE score >= $minScore
RETURN e.name AS entityName,
       e.mentionCount AS mentionCount,
       coOccDegree, clusterSize, driftCount, maxSeverity,
       isInSkg, score
ORDER BY score DESC
LIMIT $maxCandidates
```

### 3.6 CLI integration

```bash
iw triage -s intentweave -v                   # Show ranked candidates
iw triage -s intentweave --max 20 --min 10    # Custom thresholds
iw triage -s intentweave -f json -o triage.json
```

**File:** `packages/cli/src/commands/triage.ts`

```typescript
export const triageCommand = new Command("triage")
  .description("Rank KWG entities for LLM extraction based on evidence scores")
  .requiredOption("-s, --session <name>", "Session name")
  .option("--max <n>", "Maximum candidates", "50")
  .option("--min <n>", "Minimum score threshold", "5")
  .option("-f, --format <fmt>", "Output format: table | json", "table")
  .option("-o, --output <file>", "Write output to file")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts) => {
    /* ... */
  });
```

### 3.7 Example output

```
  ▸ Triage — session: intentweave

  KWG entities: 2202 │ Already in SKG: 251 │ Below threshold: 1801

  Top 50 extraction candidates:

  #   Entity                    Score  Mentions  Co-occ  Drift  In SKG
  1   kwg                       42.5   25        8       3      ✗
  2   neo4j                     38.0   20        6       4      ✗
  3   drift                     35.0   18        7       2      ✗
  4   pipeline                  31.5   15        5       2      ✗
  5   canon                     28.0   12        6       1      ✗
  ...
```

---

## 4. D2: EVIDENCED_BY Cross-Layer Links

### 4.1 Problem

SKG Canon entities exist in isolation from the evidence graph. A `Canon:Entity` named
"Pipeline" has `CANON_REL` edges to other Canon entities, but no link to the 18 KWG mentions
of "pipeline" that _motivated_ its extraction. This means:

- No provenance trail: "Why was this entity extracted?"
- No confidence boost: entities with 20 KWG mentions + 5 drift signals should rank
  higher than entities with 1 mention
- No UI enrichment: the KWG+ visualization shows both layers but no cross-layer links

### 4.2 Design

New relationship type:

```
(:Canon:Entity)-[:EVIDENCED_BY {
  mentionCount: integer,    // how many KWG mentions match
  driftCount: integer,      // how many drift signals affect the KWG entity
  confidence: float         // 0-1 boosted confidence
}]->(:KWEntity)
```

### 4.3 Matching logic

```typescript
/**
 * Link Canon entities to their KWG evidence.
 *
 * Matching strategy (same as drift doc-code detector):
 *   1. Exact: toLower(canon.name) === toLower(kwEntity.name)
 *   2. Slug:  slug(canon.name) === slug(kwEntity.name)
 *   3. Alias: any alias in canon.aliases matches kwEntity name
 *
 * Does NOT use embeddings (that's v2 enhancement).
 */
export async function linkEvidencedBy(
  driver: Driver,
  sessionId: string,
  verbose?: boolean,
): Promise<EvidenceLinkResult> {
  // Cypher: MATCH Canon + KWEntity where names overlap, CREATE EVIDENCED_BY
}

export interface EvidenceLinkResult {
  linksCreated: number;
  canonEntitiesLinked: number;
  canonEntitiesUnlinked: number; // Canon entities with no KWG evidence
  kwEntitiesLinked: number;
}
```

### 4.4 Cypher (link creation)

```cypher
// D2: Link Canon entities to KWG evidence
MATCH (c:Canon:Entity {session_id: $sessionId})
MATCH (e:KWEntity {session_id: $sessionId})
WHERE toLower(c.name) = toLower(e.name)
   OR any(alias IN COALESCE(c.aliases, [])
          WHERE toLower(alias) = toLower(e.name))
// Count evidence signals
OPTIONAL MATCH (d:DriftSignal {session_id: $sessionId})-[:AFFECTS]->(e)
WITH c, e, count(d) AS driftCount
MERGE (c)-[ev:EVIDENCED_BY]->(e)
SET ev.mentionCount = e.mentionCount,
    ev.driftCount = driftCount,
    ev.confidence = CASE
      WHEN e.mentionCount >= 10 AND driftCount >= 2 THEN 0.95
      WHEN e.mentionCount >= 5 THEN 0.85
      WHEN e.mentionCount >= 2 THEN 0.70
      ELSE 0.50
    END,
    ev.updatedAt = datetime()
RETURN count(ev) AS linksCreated,
       count(DISTINCT c) AS canonLinked,
       count(DISTINCT e) AS kwLinked
```

### 4.5 Persistence integration

`linkEvidencedBy()` runs:

- After `iw persist` (existing SKG persist + evidence linking)
- After `iw xlink` (code linking + evidence linking)
- As part of `iw build full` (after SKG + evidence stages)

**File:** `packages/cli/src/linker/evidenceLinker.ts`

### 4.6 KWG+ visualization update

The existing `kwg-plus-graph.ts` builder already queries KWG + TCG layers. D2 extends it to
include `EVIDENCED_BY` edges as cross-layer links:

```typescript
// In kwg-plus-graph.ts — add to buildKwgPlusGraph():
// Layer 4: EVIDENCED_BY cross-layer links (Canon → KWEntity)
const evidenceLinks = await run(`
  MATCH (c:Canon:Entity {session_id: $sid})-[ev:EVIDENCED_BY]->(e:KWEntity {session_id: $sid})
  RETURN c.canonId AS canonId, e.name AS kwEntityName,
         ev.mentionCount AS mentions, ev.confidence AS confidence
`);
```

Node kind extension: `"canon"` (new color: `#34d399` / emerald-400) for Canon entities
in the KWG+ visualization.

---

## 5. D3: Verb Extraction Hints

### 5.1 Problem

KWG captures entity _co-occurrence_ but not the _verb_ connecting them. "Pipeline enables
caching" and "Pipeline disables caching" both produce a `CO_OCCURS(pipeline, caching)` edge.
The verb is lost.

### 5.2 Design (lightweight, opt-in)

Verb hints are **not full triples** — they're lightweight annotations on co-occurrence edges.
They don't replace SKG extraction; they provide cheap directional hints.

### 5.3 Verb patterns (regex-based)

```typescript
/**
 * Detect verb patterns between co-occurring entities in the same sentence.
 *
 * Pattern: <entity_A> <verb_phrase> <entity_B>
 *
 * We match a small set of high-confidence verb patterns that appear in
 * technical documents. This is NOT OpenIE — it's targeted regex matching.
 */

const VERB_PATTERNS: Array<{
  pattern: RegExp;
  predicate: string;
  direction: "forward" | "backward";
}> = [
  // Structural
  { pattern: /\bcontains?\b/i, predicate: "CONTAINS", direction: "forward" },
  {
    pattern: /\bdepends?\s+on\b/i,
    predicate: "DEPENDS_ON",
    direction: "forward",
  },
  { pattern: /\bextends?\b/i, predicate: "EXTENDS", direction: "forward" },
  {
    pattern: /\bimplements?\b/i,
    predicate: "IMPLEMENTS",
    direction: "forward",
  },
  { pattern: /\breplaces?\b/i, predicate: "REPLACES", direction: "forward" },
  { pattern: /\brequires?\b/i, predicate: "REQUIRES", direction: "forward" },

  // Behavioral
  { pattern: /\benables?\b/i, predicate: "ENABLES", direction: "forward" },
  { pattern: /\bblocks?\b/i, predicate: "BLOCKS", direction: "forward" },
  { pattern: /\btriggers?\b/i, predicate: "TRIGGERS", direction: "forward" },
  { pattern: /\bproduces?\b/i, predicate: "PRODUCES", direction: "forward" },
  { pattern: /\bconsumes?\b/i, predicate: "CONSUMES", direction: "forward" },
  { pattern: /\buses?\b/i, predicate: "USES", direction: "forward" },
  { pattern: /\bcalls?\b/i, predicate: "CALLS", direction: "forward" },

  // Decision
  {
    pattern: /\bis\s+(?:an?\s+)?alternative\s+to\b/i,
    predicate: "ALTERNATIVE_TO",
    direction: "forward",
  },
  {
    pattern: /\bsupersedes?\b/i,
    predicate: "SUPERSEDES",
    direction: "forward",
  },
];
```

### 5.4 Data type

```typescript
export interface VerbHint {
  /** Source entity (before the verb) */
  subjectName: string;
  /** Target entity (after the verb) */
  objectName: string;
  /** Detected predicate */
  predicate: string;
  /** Confidence (always low: 0.3-0.6 for regex matches) */
  confidence: number;
  /** Source text snippet for provenance */
  sourceText: string;
  /** File where the pattern was found */
  filePath: string;
}
```

### 5.5 Integration point

Verb extraction runs inside `runKwxStage()` as an optional pass (off by default):

```typescript
// In kwx stage, after entity extraction:
if (options.verbHints) {
  const hints = detectVerbHints(mentions, text);
  output.verbHints = hints;
}
```

### 5.6 Neo4j persistence

Verb hints are stored as properties on `CO_OCCURS` edges (not as separate relationships):

```cypher
MATCH (a:KWEntity {session_id: $sid})-[co:CO_OCCURS]-(b:KWEntity {session_id: $sid})
WHERE toLower(a.name) = toLower($subjectName)
  AND toLower(b.name) = toLower($objectName)
SET co.verbHints = COALESCE(co.verbHints, []) + [$predicate]
```

### 5.7 CLI flag

```bash
iw build kwg docs/ -s intentweave --verb-hints -v
iw build cheap docs/ -s intentweave --verb-hints -v
```

**File:** `packages/analyzer/src/kwg/verbDetector.ts`

---

## 6. D4: `iw build full`

### 6.1 Problem

Users currently need multiple commands to build the complete evidence + semantic graph:

```bash
iw build cheap docs/ -s myproject --persist -v    # KWG + TCG + AX + Drift
iw run docs/ --track open --provider openai -i --persist -v  # SKG (LLM)
iw xlink -s myproject -v                          # Code linking
```

### 6.2 Design

`iw build full` orchestrates all layers in the correct order:

```
iw build full docs/ -s myproject --persist -v

  ┌─────────────────────────────────────────────────────────┐
  │  Stage 1: Cheap Pipeline (KWG + TCG + AX + Drift)  $0  │
  ├─────────────────────────────────────────────────────────┤
  │  Stage 2: Triage (D1)                              $0  │
  │    → Rank KWG entities, select top-N for LLM           │
  ├─────────────────────────────────────────────────────────┤
  │  Stage 3: Selective SKG (FX → KX)                  $$  │
  │    → LLM extraction, guided by triage candidates       │
  │    → Only extract chunks containing triage candidates  │
  ├─────────────────────────────────────────────────────────┤
  │  Stage 4: Evidence Linking (D2)                    $0  │
  │    → EVIDENCED_BY: Canon → KWEntity                    │
  │    → REALIZED_BY: Canon → CodeRef (xlink)              │
  ├─────────────────────────────────────────────────────────┤
  │  Stage 5: Embeddings (D5)                          $0  │
  │    → ONNX embeddings on all entities                   │
  │    → Vector index for hybrid retrieval                 │
  └─────────────────────────────────────────────────────────┘
```

### 6.3 Selective extraction (triage → FX)

The key innovation: D1 triage identifies _which_ entities need LLM extraction. The FX stage
then only processes chunks where those entities appear (based on KWG mentions):

```typescript
// Filter chunks to only those containing triage candidates
const candidateNames = new Set(
  triageResult.candidates.map((c) => c.entityName),
);
const targetChunks = allChunks.filter((chunk) => {
  const mentionsInChunk = kwgMentions.filter(
    (m) =>
      m.filePath === chunk.filePath &&
      m.startLine >= chunk.startLine &&
      m.startLine <= chunk.endLine,
  );
  return mentionsInChunk.some((m) =>
    candidateNames.has(m.entityName.toLowerCase()),
  );
});
```

**Cost impact:** If triage selects 50 entities from a 500-entity project, and those entities
appear in ~30% of chunks, FX cost drops by ~70%.

### 6.4 Command

```bash
iw build full <paths...> [options]
  -s, --session <name>        Session name (required)
  --persist                   Persist all layers to Neo4j
  --provider <name>           LLM provider for SKG: openai | anthropic (default: openai)
  --model <name>              Model for extraction (default: gpt-4o-mini)
  --max-candidates <n>        Max triage candidates (default: 50)
  --skip-skg                  Skip SKG extraction (cheap + embed only)
  --skip-embed                Skip embeddings
  -v, --verbose               Verbose output
```

### 6.5 Cost estimate display

```
  ▸ Full Pipeline — session: intentweave

  Stage 1: Cheap pipeline  (KWG + TCG + AX + Drift)     $0.00   3.2s
  Stage 2: Triage          (50 candidates from 2202)     $0.00   0.1s
  Stage 3: Selective SKG   (142 chunks out of 467)       ~$0.35  45s
  Stage 4: Evidence links  (EVIDENCED_BY + REALIZED_BY)  $0.00   0.8s
  Stage 5: Embeddings      (2453 entities, ONNX local)   $0.00   2.1s
  ─────────────────────────────────────────────────────────────────────
  Total                                                  ~$0.35  51.2s
```

**File:** `packages/cli/src/commands/buildFull.ts`

---

## 7. D5: Embeddings Pipeline

### 7.1 Problem

Without embeddings, all matching is string-based (exact, slug, token overlap). This misses
semantic matches:

- "authentication service" ↔ `AuthenticationManager`
- "data layer" ↔ `DatabaseRepository`
- "config management" ↔ `SettingsStore`

### 7.2 Architecture

```
┌────────────────────────────────┐
│   EmbeddingPipeline            │
│                                │
│   Input: persist entities      │
│   Model: all-MiniLM-L6-v2     │
│   Runtime: ONNX (Node.js)     │
│   Batch: 100 texts per call   │
│   Output: 384-dim float[]     │
│                                │
│   Stores:                      │
│   - Neo4j: entity.embedding    │
│   - Vector index for search    │
└────────────────────────────────┘
```

### 7.3 ONNX Embedding Provider

**File:** `packages/analyzer/src/providers/embedding/onnxEmbedding.ts`

```typescript
import * as ort from "onnxruntime-node";

export interface EmbeddingResult {
  text: string;
  embedding: number[]; // 384 dimensions
}

/**
 * Local embedding using ONNX Runtime + all-MiniLM-L6-v2.
 *
 * No API key, no cost, ~50ms per batch of 100 texts.
 * Model downloaded on first use and cached in .iw/models/
 */
export async function embedBatch(
  texts: string[],
  options?: {
    modelPath?: string; // default: .iw/models/all-MiniLM-L6-v2.onnx
    batchSize?: number; // default: 100
  },
): Promise<EmbeddingResult[]> {
  // 1. Load model (cached after first call)
  // 2. Tokenize texts
  // 3. Run inference
  // 4. Mean-pool token embeddings → sentence embedding
  // 5. L2-normalize
}
```

### 7.4 Model management

```
.iw/models/
  all-MiniLM-L6-v2/
    model.onnx          # 22MB, downloaded on first use
    tokenizer.json      # HuggingFace tokenizer config
    config.json         # Model config (hidden_size: 384)
    DOWNLOADED           # Sentinel file with download timestamp
```

Download is triggered by `iw build full`, or manually via:

```bash
iw embed --download-model     # Download model if not cached
iw embed --list-models        # Show available models
```

### 7.5 What gets embedded

| Entity type  | Source | Embedding text                                      |
| ------------ | ------ | --------------------------------------------------- |
| KWEntity     | KWG    | `entity.name` (optionally + first mention text)     |
| Canon:Entity | SKG    | `entity.name + " (" + entity.type + ")"`            |
| CodeRef      | xlink  | `codeRef.name + " (" + codeRef.kind + ")"`          |
| KWCluster    | KWG    | `cluster.label + ": " + cluster.members.join(", ")` |

### 7.6 Neo4j vector index

```cypher
// Create vector index (one-time schema migration)
CREATE VECTOR INDEX kwEntityEmbedding IF NOT EXISTS
  FOR (e:KWEntity)
  ON (e.embedding)
  OPTIONS {indexConfig: {
    `vector.dimensions`: 384,
    `vector.similarity_function`: 'cosine'
  }}

CREATE VECTOR INDEX canonEntityEmbedding IF NOT EXISTS
  FOR (c:Canon:Entity)
  ON (c.embedding)
  OPTIONS {indexConfig: {
    `vector.dimensions`: 384,
    `vector.similarity_function`: 'cosine'
  }}
```

### 7.7 Hybrid retrieval

Vector search seeds the graph traversal:

```typescript
/**
 * Hybrid retrieval: vector search → graph expansion
 *
 * 1. Embed the query text
 * 2. Vector search: top-K nearest entities (across KWG + SKG)
 * 3. Graph expand: N hops from seed entities
 * 4. Combine and rank results
 */
export async function hybridRetrieve(
  driver: Driver,
  queryText: string,
  options?: {
    topK?: number; // default: 10
    hops?: number; // default: 2
    sessionId?: string;
    layers?: ("kwg" | "skg" | "tcg")[];
  },
): Promise<RetrievalResult> {
  // Step 1: Embed query
  const queryEmbedding = await embedBatch([queryText]);

  // Step 2: Vector search
  // CALL db.index.vector.queryNodes('kwEntityEmbedding', $topK, $embedding)
  // YIELD node, score

  // Step 3: Graph expand from seed nodes
  // MATCH (seed)-[*1..hops]-(neighbor) ...

  // Step 4: Combine, deduplicate, rank by distance + graph centrality
}
```

### 7.8 CLI

```bash
iw embed -s intentweave -v                    # Embed all entities in session
iw embed -s intentweave --model openai        # Use OpenAI instead of ONNX
iw embed --download-model                     # Pre-download ONNX model
```

**File:** `packages/cli/src/embed/embedPipeline.ts`

### 7.9 Dependencies

```json
{
  "onnxruntime-node": "^1.20.0"
}
```

Added to `packages/analyzer/package.json`. The ONNX runtime is ~15MB (prebuilt binary).
Uses `onnxruntime-node` (not `onnxruntime-web`) for best Node.js performance.

---

## 8. D6: Multi-Layer Query Router

### 8.1 Problem

The current `iw query` only knows about SKG nodes (Canon, RawTriple). It can't answer
questions about KWG mentions, TCG commits, drift signals, or cross-layer relationships.
The MCP `kg_query` tool has the same limitation.

### 8.2 Extended GRAPH_SCHEMA

The LLM prompt for Cypher generation gets the complete multi-layer schema:

```typescript
const MULTI_LAYER_SCHEMA = `
## Neo4j Multi-Layer Knowledge Graph Schema

### Layer 1: KWG (Keyword/Evidence Graph — Phase A)

**:KWEntity** — Keyword entities extracted from documents
  Properties: name, mentionCount, qualifiers[], session_id

**:KWMention** — Individual mentions of entities in documents
  Properties: entityName, text, heading, filePath, startLine, endLine, session_id

**:KWDoc** — Document metadata
  Properties: filePath, session_id

**:KWCluster** — Entity clusters (topic groupings)
  Properties: label, members[], session_id

Relationships:
  (:KWEntity)-[:CO_OCCURS {count, score}]-(:KWEntity)
  (:KWDoc)-[:HAS_MENTION]->(:KWMention)
  (:Session)-[:CONTAINS]->(:KWEntity)

### Layer 2: SKG (Semantic Knowledge Graph — Open Track)

**:Canon:Entity** — Canonical entities extracted by LLM
  Properties: canonId, name, type, aliases[], confidence, session_id

**:RawTriple** — Raw pre-canonicalization triples
  Properties: subject, predicate, object, confidence, session_id

Relationships:
  (:Canon:Entity)-[:CANON_REL {predicate}]->(:Canon:Entity)
  (:RawTriple)-[:CANONICALIZED_FROM {role}]->(:Canon:Entity)

Canonical predicates (r.predicate):
  Structural:  CONTAINS, DEPENDS_ON, ALTERNATIVE_TO
  Behavioral:  HAS_STATE, TRANSITIONS_TO, TRIGGERS
  Decision:    DECIDED_FOR, DECIDED_AGAINST, SUPERSEDES, MOTIVATED_BY,
               ENABLES, BLOCKS, RISKS, DEFERRED_TO
  Interaction: CALLS, USES, PRODUCES, CONSUMES
  Fallback:    RELATED_TO

### Layer 3: TCG (Temporal Change Graph — Phase B)

**:TCGCommit** — Git commits
  Properties: hash, shortHash, authorName, authorEmail, date, message, session_id

**:TCGFile** — Files tracked in git history
  Properties: filePath, session_id, isHotspot, hotspotScore, staleDays, ownership

**:TCGAuthor** — Code authors
  Properties: name, email, session_id

Relationships:
  (:TCGCommit)-[:MODIFIED {additions, deletions}]->(:TCGFile)
  (:TCGAuthor)-[:AUTHORED]->(:TCGCommit)
  (:TCGFile)-[:CO_CHANGED_WITH {count, score}]->(:TCGFile)
  (:TCGAuthor)-[:OWNS {fileCount}]->(:TCGFile)

### Layer 4: Cross-Layer Links

  (:KWEntity)-[:INTRODUCED_IN]->(:TCGCommit)            — first mention in commit
  (:KWEntity)-[:LAST_TOUCHED_IN]->(:TCGCommit)          — most recent commit
  (:Canon:Entity)-[:REALIZED_BY]->(:CodeRef)             — code implementation
  (:Canon:Entity)-[:EVIDENCED_BY {mentionCount, confidence}]->(:KWEntity) — evidence trail

### Layer 5: Drift Signals (Phase C)

**:DriftSignal** — Evidence-based drift/staleness signals
  Properties: type, severity, message, category, session_id
  Types: ungrounded, undocumented, signature-mismatch, temporal-stale,
         temporal-volatile, abandoned-code, dep-unused, dep-undeclared,
         dep-version-drift, doc-doc-diverged, doc-doc-contradicts

Relationships:
  (:DriftSignal)-[:AFFECTS]->(:KWEntity | :TCGFile | :KWDoc)

### Important notes
- Always filter by session_id when the user mentions a workspace.
- CANON_REL predicates are in the \`predicate\` property, not separate relationship types.
- Use OPTIONAL MATCH when relationships might not exist across layers.
- Return human-readable columns (name, type, filePath) rather than raw IDs.
- For "hot" or "frequently changed" questions, use TCG layer.
- For "what does X mean" or "how are things related", use SKG layer.
- For "where is X mentioned" or "how often", use KWG layer.
- For "what's outdated" or "what's drifting", use Drift layer.
`;
```

### 8.3 Layer routing logic

```typescript
/**
 * Auto-detect which layers to query based on the question.
 *
 * Simple keyword-based routing (no LLM needed):
 */
function detectLayers(question: string): Set<string> {
  const q = question.toLowerCase();
  const layers = new Set<string>();

  // TCG signals
  if (
    /\b(commit|author|change|hot\s?spot|recent|frequently|ownership|co.?change)\b/.test(
      q,
    )
  ) {
    layers.add("tcg");
  }

  // Drift signals
  if (
    /\b(drift|stale|outdated|mismatch|unused|undeclared|contradiction|diverge)\b/.test(
      q,
    )
  ) {
    layers.add("drift");
  }

  // KWG signals
  if (/\b(mention|keyword|co.?occur|cluster|evidence|document)\b/.test(q)) {
    layers.add("kwg");
  }

  // SKG signals (default)
  if (
    /\b(decision|component|architecture|design|relationship|depends|enables|blocks)\b/.test(
      q,
    )
  ) {
    layers.add("skg");
  }

  // Default: include all if no specific signal detected
  if (layers.size === 0) layers.add("all");

  return layers;
}
```

### 8.4 CLI extension

```bash
iw query "What changed recently?" -s intentweave -v         # Auto-routes to TCG
iw query "What's outdated?" -s intentweave                   # Auto-routes to Drift
iw query "How are components related?" -s intentweave        # Auto-routes to SKG
iw query "Where is 'pipeline' mentioned?" -s intentweave     # Auto-routes to KWG
iw query "..." -s intentweave --layer kwg                    # Explicit layer
iw query "..." -s intentweave --layer all                    # All layers
```

### 8.5 Implementation changes

**File:** `packages/cli/src/commands/query.ts`

Changes:

1. Replace `GRAPH_SCHEMA` with `MULTI_LAYER_SCHEMA`
2. Add `--layer <kwg|skg|tcg|drift|all>` option
3. Add layer detection to system prompt
4. Update MCP `kg_query` tool schema text

**File:** `packages/cli/src/mcp/server.ts`

Changes:

1. Update `GRAPH_SCHEMA_TEXT` to include all layers
2. Add optional `layer` parameter to `kg_query` tool

---

## 9. D8: LLM-Assisted Drift Triage

### 9.1 Problem

Phase C's drift detectors are heuristic — they flag signals but can't assess _intent_. A
"decision" qualifier in one doc and "alternative" qualifier in another might be a genuine
contradiction, or it might be correct (the alternative was evaluated, and the decision was
made separately).

### 9.2 Design

Optional `--triage` flag on `iw doc-health`:

```bash
iw doc-health -s intentweave --triage -v               # Triage top-10 signals
iw doc-health -s intentweave --triage --max 20 -v      # Triage top-20
iw doc-health -s intentweave --triage --provider openai # Explicit provider
```

### 9.3 Triage process

```
1. Collect top-N drift signals (by severity × mention count)
2. For each signal, build a focused LLM prompt:
   - Signal type and message
   - Source mention text (from KWG, ±5 lines context)
   - Code signature (from AX, if applicable)
   - Related signals (same entity)
3. Ask LLM:
   - Is this a genuine drift issue? (yes/no/uncertain)
   - Severity assessment (critical/warning/info)
   - Suggested fix (1-2 sentences)
4. Update signal with LLM assessment
```

### 9.4 Types

```typescript
export interface TriagedSignal {
  /** Original drift signal */
  signal: DriftSignal;
  /** LLM assessment: is this genuine? */
  isGenuine: "yes" | "no" | "uncertain";
  /** LLM-adjusted severity */
  adjustedSeverity: "critical" | "warning" | "info";
  /** LLM suggested fix */
  suggestedFix: string;
  /** LLM reasoning */
  reasoning: string;
  /** Token cost for this triage */
  tokens: { prompt: number; completion: number };
}
```

### 9.5 Cost model

| Parameter             | Value                      |
| --------------------- | -------------------------- |
| Signals per run       | 10 (default, configurable) |
| Prompt per signal     | ~500 tokens                |
| Completion per signal | ~200 tokens                |
| Total per run         | ~7,000 tokens              |
| Cost (GPT-4o-mini)    | ~$0.01                     |
| Cost (GPT-4o)         | ~$0.07                     |

### 9.6 Implementation

**File:** `packages/cli/src/triage/llmDriftTriage.ts`

```typescript
export interface DriftTriageOptions {
  sessionId: string;
  maxSignals?: number; // default: 10
  provider: LLMProvider;
  verbose?: boolean;
}

export interface DriftTriageResult {
  triaged: TriagedSignal[];
  genuineCount: number;
  falsePositiveCount: number;
  uncertainCount: number;
  totalTokens: { prompt: number; completion: number };
  costEstimate: string; // e.g. "$0.01"
}

export async function triageDriftSignals(
  driver: Driver,
  opts: DriftTriageOptions,
): Promise<DriftTriageResult> {
  // 1. Fetch top-N signals from Neo4j
  // 2. For each, build context (mentions, code, related signals)
  // 3. LLM call with structured JSON response
  // 4. Parse and return
}
```

---

## 10. Neo4j Schema Extensions

### 10.1 New relationship types

| Relationship   | From            | To          | Properties                                 | Phase |
| -------------- | --------------- | ----------- | ------------------------------------------ | ----- |
| `EVIDENCED_BY` | `:Canon:Entity` | `:KWEntity` | `mentionCount`, `driftCount`, `confidence` | D2    |

### 10.2 New properties on existing nodes

| Node            | Property        | Type                | Phase |
| --------------- | --------------- | ------------------- | ----- |
| `:KWEntity`     | `embedding`     | `float[]` (384-dim) | D5    |
| `:Canon:Entity` | `embedding`     | `float[]` (384-dim) | D5    |
| `:CO_OCCURS`    | `verbHints`     | `string[]`          | D3    |
| `:DriftSignal`  | `llmAssessment` | `string`            | D8    |
| `:DriftSignal`  | `llmSeverity`   | `string`            | D8    |
| `:DriftSignal`  | `suggestedFix`  | `string`            | D8    |

### 10.3 New indexes

```cypher
// Vector indexes (D5)
CREATE VECTOR INDEX kwEntityEmbedding IF NOT EXISTS
  FOR (e:KWEntity) ON (e.embedding)
  OPTIONS {indexConfig: {`vector.dimensions`: 384, `vector.similarity_function`: 'cosine'}}

CREATE VECTOR INDEX canonEntityEmbedding IF NOT EXISTS
  FOR (c:Canon:Entity) ON (c.embedding)
  OPTIONS {indexConfig: {`vector.dimensions`: 384, `vector.similarity_function`: 'cosine'}}
```

### 10.4 Schema migration

All new relationships, properties, and indexes are additive — no breaking changes to
existing data. The migration is implicit: each feature creates its own schema elements on
first use (same pattern as Phase A-C).

---

## 11. Golden Tests

### 11.1 Test fixtures

Use the same `intentweave` session data as Phase A-C golden tests:

| Test                | Input                                    | Expected                                            |
| ------------------- | ---------------------------------------- | --------------------------------------------------- |
| `triage-basic`      | KWG + SKG for intentweave                | Top candidates sorted by score, none already in SKG |
| `evidence-link`     | Canon entities + KWG entities            | EVIDENCED_BY edges created for matching names       |
| `verb-detect`       | Markdown with "Pipeline enables caching" | VerbHint `{pipeline, caching, ENABLES}`             |
| `embed-basic`       | 10 entity names                          | 384-dim embeddings, L2-normalized                   |
| `query-route-tcg`   | "What changed recently?"                 | Layer detection returns `tcg`                       |
| `query-route-drift` | "What's outdated?"                       | Layer detection returns `drift`                     |
| `query-route-kwg`   | "Where is pipeline mentioned?"           | Layer detection returns `kwg`                       |
| `drift-triage`      | 3 drift signals + mock LLM               | TriagedSignal with fix suggestions                  |

### 11.2 Test layout

```
packages/cli/src/__tests__/
  triage/
    triageAnalyzer.test.ts
  linker/
    evidenceLinker.test.ts
  embed/
    onnxEmbedding.test.ts
    embedPipeline.test.ts

packages/analyzer/src/__tests__/
  kwg/
    verbDetector.test.ts

packages/cli/src/__tests__/
  commands/
    query-router.test.ts
  triage/
    llmDriftTriage.test.ts
```

---

## 12. Implementation Plan (Build-Now)

### Dependencies

```
D1 (Triage) ──────────── depends on: Phase A (KWG), Phase C (Drift)
    │
D2 (EVIDENCED_BY) ────── depends on: D1 + existing SKG
    │
D3 (Verb Hints) ──────── depends on: Phase A (KWG) — independent of D1/D2
    │
D4 (build full) ──────── depends on: D1 + D2 + D5
    │
D5 (Embeddings) ──────── depends on: Phase A (KWG) — independent of D1-D3
    │
D6 (Query Router) ────── depends on: all layers in Neo4j — independent impl
    │
D8 (LLM Triage) ──────── depends on: Phase C (Drift) + LLM provider
```

### Step sequence

| Step    | Item                           | Files to create/modify                                                                                        | Depends on                    | Testable?                                                           |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| **D-1** | Triage scoring + CLI           | `packages/cli/src/triage/triageAnalyzer.ts`, `packages/cli/src/commands/triage.ts`, `packages/cli/src/cli.ts` | KWG + Drift in Neo4j          | `iw triage -s intentweave -v` → ranked list                         |
| **D-2** | EVIDENCED_BY linker            | `packages/cli/src/linker/evidenceLinker.ts`                                                                   | D-1 + existing Canon entities | Cypher verify: `MATCH ()-[:EVIDENCED_BY]->() RETURN count(*)`       |
| **D-3** | Multi-layer GRAPH_SCHEMA       | `packages/cli/src/commands/query.ts` (update schema), `packages/cli/src/mcp/server.ts` (update schema)        | Layers in Neo4j               | `iw query "What changed recently?" -s intentweave` routes correctly |
| **D-4** | Layer routing + `--layer` flag | `packages/cli/src/commands/query.ts` (add flag + router)                                                      | D-3                           | `iw query "..." --layer tcg` scopes to TCG                          |
| **D-5** | Verb hint detector             | `packages/analyzer/src/kwg/verbDetector.ts`, update `runKwxStage`                                             | Phase A                       | Golden test: markdown → VerbHint[]                                  |
| **D-6** | ONNX embedding provider        | `packages/analyzer/src/providers/embedding/onnxEmbedding.ts`                                                  | npm: `onnxruntime-node`       | Unit test: embedBatch → 384-dim vectors                             |
| **D-7** | Embedding pipeline + persist   | `packages/cli/src/embed/embedPipeline.ts`, Neo4j vector indexes                                               | D-6                           | `iw embed -s intentweave` → embeddings on entities                  |
| **D-8** | `iw build full` orchestrator   | `packages/cli/src/commands/buildFull.ts`, update `buildCommand`                                               | D-1 through D-7               | Full pipeline end-to-end                                            |

### Estimated effort

| Step                     | Effort           | Cost per run                        |
| ------------------------ | ---------------- | ----------------------------------- |
| D-1 (Triage)             | 2-3 hours        | $0                                  |
| D-2 (Evidence links)     | 1-2 hours        | $0                                  |
| D-3 (Multi-layer schema) | 1-2 hours        | $0                                  |
| D-4 (Layer routing)      | 1-2 hours        | $0                                  |
| D-5 (Verb hints)         | 2-3 hours        | $0                                  |
| D-6 (ONNX embeddings)    | 3-4 hours        | $0                                  |
| D-7 (Embed pipeline)     | 2-3 hours        | $0                                  |
| D-8 (build full)         | 2-3 hours        | ~$0.35/run                          |
| **Total**                | **~16-22 hours** | **$0 for evidence, ~$0.35 for SKG** |

---

# Part 2: Target Architecture v2+

The following features are deferred until Part 1 is stable and proven.

---

## 13. Additional Language Parsers (D7)

### 13.1 Problem

The AX stage currently supports TypeScript/JavaScript and Swift. Many projects also need
Python, Rust, Go, or other languages.

### 13.2 Design

Follow the `@intentweave/swift-parser` pattern: one package per language.

| Package                      | Parser             | Dependencies         |
| ---------------------------- | ------------------ | -------------------- |
| `@intentweave/python-parser` | tree-sitter-python | `tree-sitter-python` |
| `@intentweave/rust-parser`   | tree-sitter-rust   | `tree-sitter-rust`   |
| `@intentweave/go-parser`     | tree-sitter-go     | `tree-sitter-go`     |

Each package exports:

```typescript
export interface LanguageExtractor {
  extractFromFile(filePath: string): Promise<CodeSymbol[]>;
  supportedExtensions: string[];
}
```

### 13.3 When to introduce

When a user needs analysis of a non-TS/Swift project. The interface emerges naturally from
having a second implementation (swift-parser) as template.

---

## 14. Cluster Summarization (LLM, D8 extension)

### 14.1 Problem

KWG clusters have heuristic labels (highest-degree member name), which are often cryptic:
`"neo4j"` for a cluster about database architecture, `"entity"` for a cluster about
semantic extraction.

### 14.2 Design

Optional LLM call to generate human-readable cluster descriptions:

```bash
iw build kwg docs/ -s intentweave --summarize-clusters -v
```

Prompt per cluster:

```
Given these related terms from a technical project:
Members: neo4j, graph, database, cypher, bolt, driver, schema
Context: These terms co-occur frequently in documentation about [project].

Generate a concise label (3-5 words) and description (1-2 sentences).
```

### 14.3 Cost model

32 clusters × ~200 tokens = ~6,400 tokens = ~$0.006 with GPT-4o-mini.

### 14.4 When to introduce

When users report that cluster labels are confusing in the UI. This is a low-priority,
nice-to-have enhancement.

---

## 15. Advanced Hybrid Retrieval (v2)

### 15.1 Problem

v1 hybrid retrieval (D5) uses a simple pipeline: vector search → graph expand. v2 adds
re-ranking, cross-layer fusion, and relevance feedback.

### 15.2 Design

```
Query → Embed → Vector Search (top-50)
                     │
                     ├─→ KWG Vector Search: similar KWEntities
                     ├─→ SKG Vector Search: similar Canon entities
                     └─→ Code Vector Search: similar CodeRefs
                            │
                            v
                    Graph Expansion (2 hops)
                            │
                            v
                     Cross-Layer Fusion
                     (score = α·vectorSim + β·graphCentrality + γ·driftRelevance)
                            │
                            v
                     Re-ranked Results
```

### 15.3 When to introduce

After D5 v1 is deployed and users report retrieval quality issues. The simple vector +
graph pipeline likely handles 90%+ of use cases.

---

## 16. CI Quality Gates (v2)

### 16.1 Problem

Phase D evidence is valuable for CI: "Block merge if drift score exceeds threshold" or
"Require LLM triage for critical drift signals."

### 16.2 Design

```bash
# CI mode: exit code reflects quality score
iw quality-gate -s myproject --fail-on critical

# Exit codes:
# 0: all gates pass
# 1: quality threshold exceeded
# 2: infrastructure error

# GitHub Actions annotations:
iw quality-gate -s myproject --format github-actions
```

### 16.3 When to introduce

When at least 3 projects use IntentWeave in CI and need automated gating.

---

## 17. Framework API Stabilization (v2+)

### 17.1 Problem

Phase D adds many new modules. The public API surface should be defined for external consumers.

### 17.2 Design

```typescript
// @intentweave/analyzer — public API
export {
  // KWG stages
  runKwxStage,
  runCoxStage,
  runClxStage,
  // TCG stages
  runTcxStage,
  runCocStage,
  runHotStage,
  runOwnStage,
  runStlStage,
  // Embedding
  embedBatch,
  // Types
  type KwxStageOutput,
  type CoxStageOutput,
  type ClxStageOutput,
  type EmbeddingResult,
} from "./index.js";
```

### 17.3 When to introduce

When external packages or plugins need to import IntentWeave analysis capabilities.

---

## Appendix A: Dependency Map

```
Phase A (KWG) ──────── COMPLETE
    │
Phase B (TCG) ──────── COMPLETE
    │
Phase C (Drift) ─────── COMPLETE
    │
    └── Phase D (Selective SKG) ← this spec
            │
            ├── D-1: Triage scoring + CLI          (depends: KWG + Drift in Neo4j)
            ├── D-2: EVIDENCED_BY linker           (depends: D-1 + Canon entities)
            ├── D-3: Multi-layer GRAPH_SCHEMA      (depends: all layers in Neo4j)
            ├── D-4: Layer routing + --layer flag  (depends: D-3)
            ├── D-5: Verb hint detector            (depends: Phase A, independent)
            ├── D-6: ONNX embedding provider       (depends: onnxruntime-node)
            ├── D-7: Embedding pipeline + persist  (depends: D-6)
            └── D-8: iw build full orchestrator    (depends: D-1 through D-7)
```

## Appendix B: Phase E Preview

| Item | Description                                                               | Depends on |
| ---- | ------------------------------------------------------------------------- | ---------- |
| E1   | DCG: runtime trace integration (`trace-calls` stage with instrumentation) | D4         |
| E2   | Neo4j GDS community detection (Leiden/Louvain for clustering at scale)    | D5         |
| E3   | Framework API stabilization (clean exports from all packages)             | D          |
| E4   | VS Code extension: inline drift annotations                               | D2 + D6    |
| E5   | Auto-fix suggestions (LLM-generated PRs for critical drift)               | D8         |

## Appendix C: Cost Comparison

| Pipeline                    | Layers Built               | LLM Calls    | Cost   | Time  |
| --------------------------- | -------------------------- | ------------ | ------ | ----- |
| `iw build cheap`            | KWG + TCG + AX + Drift     | 0            | $0.00  | ~10s  |
| `iw build full --skip-skg`  | Cheap + Embed + Triage     | 0            | $0.00  | ~15s  |
| `iw build full`             | All layers + Selective SKG | ~50 entities | ~$0.35 | ~50s  |
| `iw run --track open` (old) | SKG only (all chunks)      | ~500 chunks  | ~$3.50 | ~5min |

Phase D's selective extraction achieves ~90% of the old pipeline's result quality at ~10% of
the cost, because the evidence graph identifies precisely which entities are worth the LLM budget.

---

_End of Phase D specification._
