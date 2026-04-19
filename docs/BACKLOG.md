# IntentWeave — Feature Backlog

> Checks, discoveries, and intelligence features — prioritised by value and effort.

---

## Legend

| Tag       | Meaning                       |
| --------- | ----------------------------- |
| **CARI**  | SQLite-only, $0, no LLM       |
| **KG**    | Requires Neo4j + LLM pipeline |
| **AX**    | Extends AST extractor         |
| **INT**   | Integration / embedding mode  |
| **PLT**   | Platform / plugin infra       |
| **Docs**  | Documentation only            |
| **S/M/L** | T-shirt size effort           |

---

## 1. Documentation Intelligence

### 1.1 Doc-Group Classification _(CARI, S)_ ✅

Add `doc_group` column to `files` table. Auto-classify by path convention
(`docs/api/**` → "api-reference", `docs/decisions/*` → "architecture", `README*` → "readme")
with optional `.iw/doc-groups.yaml` override. Foundation for all cross-group checks below.

### 1.2 Cross-Group Drift Detection _(CARI, M)_ ✅

Compare entity coverage across doc groups. Flag when two groups describe the same entity
with conflicting qualifiers or divergent detail level. Surface: _"ARCHITECTURE.md and
API.md diverge 42% on AuthService — check for stale cross-references."_

### 1.3 Orphaned Documentation Sections _(CARI, S)_ ✅

Detect heading sections in docs where **none** of the mentioned entities resolve to symbols
in the codebase. Likely: outdated feature descriptions, removed API docs, dead tutorials.

### 1.4 Documentation Coverage by Module _(CARI, S)_ ✅

Roll up symbol coverage per directory/package. Show: `packages/analyzer/: 72% documented,
packages/cli/: 45% documented`. Identify under-documented modules at a glance.

### 1.5 Terminology Inconsistency Detection _(CARI, M)_ ✅

Detect when docs use different names for the same code symbol (e.g., "auth service",
"AuthService", "authentication module" all referring to `AuthService` class). Surface
a suggested canonical name per entity.

### 1.6 Decision Lifecycle Tracking _(KG, M)_

Track decisions through states: proposed → accepted → superseded → deprecated.
Flag decisions that were accepted but never implemented (no code symbol reference),
and decisions that were superseded but still referenced in active docs.

### 1.7 Doc Completeness Scoring _(CARI, S)_ ✅

Per-file completeness score: does the doc cover all exported symbols from the files it
references? A doc about `AuthService` that covers 3/7 public methods scores 43%.

---

## 2. Code Duplication & Similarity

### 2.1 Exact Clone Detection _(AX + CARI, S)_ ✅

Add `body_hash` (SHA-256 of normalised body, whitespace/comments stripped) to `symbols`
table during AX. Query: self-join on `body_hash` where `body_lines > 5`. Surface:
_"formatDate() in utils/date.ts is identical to formatDate() in helpers/format.ts"_.

### 2.2 Structural Clone Detection — Type 2 _(AX + CARI, M)_ ✅

Add `structure_hash` (hash of AST node-type sequence, ignoring identifiers/literals).
Catches renamed-variable copies. Surface: _"validateEmail() and validatePhone() share
identical control flow — consider extracting a generic validator."_

### 2.3 Semantic Clone Detection — Type 3/4 _(KG, L)_

Use LLM embeddings on function-level summaries. Compare cosine similarity across all
function pairs. Catches behaviourally equivalent but structurally different implementations.

### 2.4 Copy-Paste Lineage Tracking _(AX + CARI, M)_

When exact clones exist, track which was created first (git blame). Surface the original
and its copies so teams can decide which to keep and which to eliminate.

---

## 3. Dependency & Import Intelligence

### 3.1 Circular Import Detection _(AX + CARI, S)_ ✅

Build import graph from `ExtractedImport` data already captured by AX. Run cycle detection
(Tarjan/Johnson). Surface: _"Circular dependency: auth.ts → user.ts → permission.ts → auth.ts"_.

### 3.2 Unused Export Detection _(AX + CARI, S)_ ✅

Cross-reference exported symbols against all import statements. Flag exports that are
never imported anywhere in the workspace. Distinguish: truly unused vs. entry-point exports.

### 3.3 Dependency Depth Analysis _(AX + CARI, S)_ ✅

For each file, compute transitive import depth. Flag files with excessive fan-in (many
dependents — high-risk to change) or fan-out (many dependencies — fragile).

### 3.4 Package Boundary Violations _(AX + CARI, M)_ ✅

In monorepos, detect when a file imports from another package's internal modules
(not the package's public API). Surface: _"analyzer/src/stages/fx.ts imports from
cli/src/drift/docDocDrift.ts — should go through @intentweave/cli public exports."_

---

## 4. Git & Temporal Intelligence

### 4.1 Ownership Drift _(CARI, S)_

Detect when the git-blame owner of a code file differs from the last doc editor.
Surface: _"auth.ts now owned by @alice but AUTH.md last edited by @bob (6 months ago)"_.

### 4.2 Change Coupling Anomalies _(CARI, S)_

Files that historically co-change but haven't recently — either the coupling broke
(refactor) or one side is silently drifting. Surface: _"auth.ts and user.ts co-changed
in 12/15 commits but diverged 3 months ago."_

### 4.3 Hotspot → Documentation Priority _(CARI, S)_ ✅

Combine churn rate (change frequency) with documentation coverage. High-churn,
low-doc files are the highest-priority documentation targets. Output a ranked list.

### 4.4 Bus Factor per Module _(CARI, M)_

Count distinct committers per file/directory. Flag modules where only 1 person has
ever committed. Cross-reference with documentation coverage — low bus factor +
low docs = critical knowledge risk.

---

## 5. Architecture & Design Intelligence

### 5.1 Layer Architecture Analysis

Layer analysis is split into three phases so that auto-inference ($0) comes first,
validation second, and optional LLM naming last.

#### 5.1a Layer Inference _(CARI, M)_ ✅

Auto-infer architectural layers from existing import graph data. Uses import directionality
(topological sort of the file dependency graph), community detection (from 9.1), and
fan-in/fan-out metrics (from 3.3) to cluster files into tiers. Outputs a draft
`.iw/layers.yaml` as the "as-is" architecture — users review and commit as the
"as-should" definition.

Algorithm:

1. Build the import DAG (same as 3.3's `dependencyDepth`)
2. Topological-sort the DAG → assign each file a depth rank
3. Bucket depth ranks into layers (e.g., 0–1 = "foundation", 2–3 = "core", etc.)
4. Cross-reference with communities (9.1) — files in the same community at similar
   depth form one named layer
5. Emit `.iw/layers.yaml` with layer definitions and file→layer assignments

CLI: `iw index layers-infer`. MCP: `cari_layers_infer`.

#### 5.1b Layer Check _(CARI, S)_ ✅

Validate all imports against a committed `.iw/layers.yaml` config. Detect:

- **Reverse imports**: lower layer importing from higher layer
- **Skip-layer imports**: layer N importing from layer N+2 (skipping N+1)

Each violation includes source file, target file, source layer, target layer, and a
human-readable reason.

CLI: `iw index layers-check`. MCP: `cari_layers_check`.

#### 5.1c Layer Naming Suggestions _(KG, S)_ ✅

Optional LLM pass to name inferred layers based on their file contents and symbol types.
E.g., a layer containing `server/`, `routes/`, `middleware/` gets named "HTTP Layer".
Depends on 5.1a output. Not needed for validation — pure ergonomics.

### 5.2 Interface Conformance Drift _(AX, M)_ ✅

Track when a class claims to implement an interface but the method signatures have
diverged (missing methods, changed parameters). More precise than tsc for cross-package
scenarios.

### 5.3 Dead Feature Detection _(CARI + AX, M)_ ✅

Combine: (a) code symbols never called from tests or entry points, (b) doc sections
with zero code references, (c) git: no commits in 6+ months. When all three align,
flag as likely dead feature.

### 5.4 API Surface Changelog _(AX + CARI, M)_ ✅

Track exported symbols over time (git history). Detect additions, removals, signature
changes per release. Auto-generate: _"v0.2.0: +3 exports, -1 export, 2 signature changes
in @intentweave/cli"_.

### 5.5 Hierarchical Sub-Layering _(CARI, M)_ ✅

**Problem:** Flat layer inference treats the entire workspace as one graph. In monorepos,
this causes internal sub-layers of a single package (e.g., the analyzer's pipeline
orchestration) to appear as top-level peers of much larger layers (e.g., "User Interface").

**Solution:** Two-level layer inference — macro layers at the package boundary, then
sub-layers within each package:

1. Build a **package-level** import graph (collapse each `packages/*` into a supernode)
2. Run topological depth on the package graph → **macro layers**
3. For each package with >N files (configurable, default 10), run a second topological
   sort on its internal import subgraph → **sub-layers**
4. HTML report renders nested bands (a layer band with lighter sub-bands inside)

```
┌─────────────────────────────────────────────────────────┐
│ Macro Layer 3: apps/ui, apps/server  (entry)            │
├─────────────────────────────────────────────────────────┤
│ Macro Layer 2: packages/cli          (interface)         │
│   ├── Sub-layer 2: commands/                             │
│   ├── Sub-layer 1: mcp/                                  │
│   └── Sub-layer 0: doc-health/, impact/                  │
├─────────────────────────────────────────────────────────┤
│ Macro Layer 1: packages/analyzer     (core)              │
│   ├── Sub-layer 2: pipeline/ (openTrack, buildFull)      │
│   ├── Sub-layer 1: stages/, cache/                       │
│   └── Sub-layer 0: kwg/, extractors                      │
├─────────────────────────────────────────────────────────┤
│ Macro Layer 0: packages/core, packages/index             │
└─────────────────────────────────────────────────────────┘
```

Also supports scoped inference: `iw index layers-infer --scope packages/analyzer` runs
only on that package's internal graph — useful for deep-diving into one module.

CLI: `iw index layers-infer --hierarchical`. MCP: `cari_layers_infer` (new `hierarchical` param).

Depends on: 5.1a (existing flat inference), 3.4 (package boundary detection).

### 5.6 As-Is vs. As-Should Comparison _(CARI, M)_ ✅

**Problem:** Users can infer layers (as-is) and define a should-architecture in
`.iw/layers.yaml`, but there's no way to see both simultaneously and identify drift
between intent and reality.

**Solution:** A `--compare` mode that runs inference, loads the config, and outputs a
three-column delta view showing where files are vs. where they should be:

```bash
iw index layers-check --compare
iw index layers-check --compare --config .iw/layers-should.yaml
```

```
File                       │ Inferred Layer  │ Should Layer     │ Status
───────────────────────────┼─────────────────┼──────────────────┼────────
packages/cli/src/cli.ts    │ 4 (entry)       │ 3 (interface)    │ ⚠ DRIFT
packages/index/src/...     │ 0 (foundation)  │ 0 (foundation)   │ ✓ OK
packages/analyzer/src/...  │ 1 (core)        │ 2 (application)  │ ⚠ DRIFT
```

In the HTML report, this renders as **two-tone layer bands** — the actual position vs.
where the config says it should be, with visual indicators for mismatches.

CLI: `iw index layers-check --compare`. MCP: `cari_layers_check` (new `compare` param).

Depends on: 5.1a (inference), 5.1b (config validation).

### 5.7 Vertical Slice Detection _(CARI, M)_ ✅

**Problem:** Layers show horizontal stratification but not vertical feature cohorts.
"Which files form the auth feature end-to-end?" requires cross-referencing layers
with communities.

**Solution:** Identify communities whose members span ≥3 layers as **vertical slices**
(feature cuts through the architecture). Communities spanning only 1 layer are
horizontal modules.

```
         │ Auth Slice │   │ Pipeline Slice │
─────────┼────────────┼───┼────────────────┼──── Entry
         │ auth/route │   │ cli/run.ts     │
─────────┼────────────┼───┼────────────────┼──── Interface
         │ auth/svc   │   │ openTrack.ts   │
─────────┼────────────┼───┼────────────────┼──── Core
         │ auth/model │   │ fx.ts, kx.ts   │
─────────┼────────────┼───┼────────────────┼──── Foundation
         │ auth/types │   │ types.ts       │
```

In the HTML report, clicking a community in the legend highlights its slice as a
**coloured vertical column** overlaying the layer bands. Non-member nodes dim.

CLI: `iw index slices`. MCP: `cari_slices`.

Depends on: 5.1a (layers), 9.1 (communities).

### 5.8 Architecture Diagram Validation _(CARI, L)_

**Problem:** Teams document intended architectures as diagrams (pipeline flows, component
boundaries, data-flow graphs), but nothing validates whether the code actually conforms
to the documented design.

**Solution:** A `diagram-as-config` format (`.iw/architecture.yaml`) that defines
components (file globs), allowed flows (directed edges), and constraints (forbidden
dependencies). CARI validates the real import graph against this config.

> **See also 11.8:** With selective semantic enrichment, the LLM can parse ASCII art and
> Mermaid diagrams directly — no manual YAML authoring needed. The diagram in your docs
> becomes the architecture spec automatically.

```yaml
# .iw/architecture.yaml
components:
  - name: "AX Stage"
    files: ["packages/ast-extractor/**", "packages/analyzer/src/stages/ax*.ts"]
  - name: "KWX Stage"
    files: ["packages/analyzer/src/kwg/**"]
  - name: "Annotate"
    files: ["packages/index/src/annotator.ts"]
  - name: "SQLite Writer"
    files: ["packages/index/src/writer.ts"]

flows:
  - from: "AX Stage"
    to: "Annotate"
  - from: "KWX Stage"
    to: ["Annotate", "COX Stage"]

constraints:
  - type: no-direct-dependency
    from: "AX Stage"
    to: "SQLite Writer"
    reason: "AX output should flow through Annotate, not directly to Writer"
```

```bash
iw index arch-check --config .iw/architecture.yaml

# ✓ AX Stage → Annotate: confirmed (annotator.ts imports axStage)
# ⚠ KWX Stage → Annotate: MISSING — no direct import path found
# ✗ Undocumented: writer.ts imports from idf.ts — not in diagram
# ✓ No constraint violations
```

Validates: expected flows exist, no undocumented flows, constraint compliance.
Closes the loop: documentation describes architecture → CARI validates code matches.

CLI: `iw index arch-check`. MCP: `cari_arch_check`.

Depends on: `imports` table (exists), file glob resolution (exists).

---

## 6. Quality & Consistency Checks

### 6.1 Naming Convention Violations _(AX, S)_

Check symbol names against configurable patterns (camelCase functions, PascalCase classes,
UPPER_SNAKE constants). Flag violations per file. No new dependencies — regex on existing
symbol data.

### 6.2 Test Coverage Mapping _(AX + CARI, M)_ ✅

Map test files to their targets via naming convention (`foo.test.ts` → `foo.ts`) and
import analysis. Surface untested exported symbols: _"12 exported functions in
packages/analyzer/ have no corresponding test file."_

### 6.3 TODO/FIXME/HACK Inventory _(AX, S)_ ✅

Extract inline markers from source during AX. Store in index with file, line, age
(git blame). Surface: _"47 TODOs, 12 older than 6 months, 3 reference deleted functions."_
Cross-reference with doc coverage — undocumented TODOs are invisible technical debt.

### 6.4 Comment-to-Code Ratio Anomalies _(AX, S)_

Flag files with unusually low or high comment ratios compared to workspace average.
Very low → complex undocumented code. Very high → possibly stale comments describing
old behaviour.

---

## 7. Language Support

### 7.1 Python AST Extractor _(AX, M)_ ✅ Done

Create `packages/python-parser/` using `tree-sitter-python`. Extract: functions, classes,
methods, decorators, imports (`import X`, `from X import Y`), module-level variables,
type hints. Map to the existing `ExtractedSymbol` / `ExtractedImport` interfaces so all
downstream stages (KWX, COX, Annotate, CARI queries) work without changes.

**Current language dispatch** (in `packages/analyzer/src/stages/ax.ts`) is hardcoded:
TS/JS files → `ast-extractor`, `.swift` → `swift-parser`. Adding Python requires a
third branch — or better, the generic dispatch in 7.2.

### 7.2 Language-Agnostic AX Dispatch _(AX, M)_ ✅ Done

Replaced the hardcoded if/else in the AX stage with a **language registry**:

```typescript
// .iw/languages.ts or built-in registry
const languages: LanguageAdapter[] = [
  {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    extractor: "@intentweave/ast-extractor",
  },
  { extensions: [".swift"], extractor: "@intentweave/swift-parser" },
  { extensions: [".py"], extractor: "@intentweave/python-parser" },
];
```

Each adapter implements a common `LanguageExtractor` interface:

```typescript
interface LanguageExtractor {
  extractFile(filePath: string): Promise<FileExtractionResult>;
  supportedExtensions(): string[];
}
```

This makes adding new languages a single package + one registry line.

### 7.3 Go / Rust / Java Extractors _(AX, M each)_

With the registry from 7.2, each new language is a self-contained package:

- `packages/go-parser/` — `tree-sitter-go` (functions, structs, interfaces, imports)
- `packages/rust-parser/` — `tree-sitter-rust` (fn, struct, impl, trait, mod, use)
- `packages/java-parser/` — `tree-sitter-java` (class, method, interface, import)

Each maps to `ExtractedSymbol` + `ExtractedImport`. Downstream pipeline unchanged.

---

## 8. Embedded / Integration Mode

IntentWeave's packages (`@intentweave/index`, `@intentweave/core`, `@intentweave/ast-extractor`)
already export programmatic APIs — but the **query** side is library-ready while the
**build** side is not. The pipeline orchestration (AX → KWX → COX → TCG → annotate → write)
lives inside the CLI's `.action()` handler, requiring consumers to either shell out or
re-implement ~200 lines of stage wiring. This section restructures the embedding story
around a proper **library facade** first, then builds integrations on top.

### Current API Surface

| Layer                                        | Status                                                            | Package              |
| -------------------------------------------- | ----------------------------------------------------------------- | -------------------- |
| Query (retrieve, check, connections, …)      | ✅ Library-ready — 14 dual-signature functions                    | `@intentweave/index` |
| Build (full pipeline orchestration)          | ❌ Locked in CLI `.action()` handler                              | `@intentweave/cli`   |
| Incremental (detectChanges, applyChanges)    | ⚠️ Exported but requires pre-computed stage outputs               | `@intentweave/index` |
| Entity bridge (external entity → annotation) | ✅ `registerEntities()` + `mentionsOf()` + `annotationsForFile()` | `@intentweave/index` |

### 8.0 `CariIndex` Facade + Orchestration Extraction _(CARI, M)_ ✅

Extract the pipeline orchestration from `indexBuild.ts` into an exported, consumer-friendly
facade. This is the **prerequisite** for all embedded use cases.

**Step 1 — Extract `buildFromPaths()`:** Move the ~200-line pipeline
(file discovery → AX → KWX → COX → TCG → IDF → annotate → write) out of the Commander
`.action()` into an exported async function in `@intentweave/index` (or a new
`@intentweave/embed` package). The CLI handler becomes a thin wrapper.

**Step 2 — `CariIndex` class:** Stateful wrapper that manages the DB lifecycle and
exposes typed query methods. Consumers open one handle at startup and query throughout.

```typescript
import { CariIndex } from "@intentweave/index";

// High-level build (runs AX → KWX → COX → TCG → annotate → SQLite)
const index = await CariIndex.build({
  paths: ["docs/", "packages/", "apps/"],
  exclude: ["**/node_modules/**"],
  depth: "full",
  workspaceRoot: process.cwd(),
});

// Or load existing index
const index = CariIndex.load(".iw/index.db");

// Typed queries — no raw SQL, no dbPath juggling
const results = index.retrieve({ query: "authentication", limit: 10 });
const findings = index.check({ changed: ["src/auth.ts"] });
const conns = index.connections({ entity: "AuthService" });
const health = index.report();

// Incremental update — consumer passes file paths, facade runs stages internally
await index.updateFiles(["src/auth.ts", "docs/AUTH.md"]);

// Partial build modes — trade completeness for speed
const symbols = await CariIndex.buildSymbolsOnly({ workspaceRoot: "." });
```

**What this unlocks:** Any Node.js consumer (`npm install @intentweave/index`) gets
full CARI capability with a single `build()` call — no subprocess spawning, no stdout
parsing, no raw SQL. The CLI becomes a thin shell over this facade.

### 8.0a Entity Bridge _(CARI, M)_ ✅

The **killer feature** for pipeline integration. Today CARI only knows about
`AxSymbol` (AST-extracted code entities). The entity bridge lets consumers inject
arbitrary entities (domain concepts, pipeline entities, third-party models) so that
annotation matching and `mentionsOf()` work across both code symbols and external
entities.

```typescript
import { CariIndex, type ExternalEntity } from "@intentweave/index";

const index = CariIndex.load(".iw/index.db");

// Inject external entities alongside AST-extracted symbols
index.registerEntities([
  {
    id: "entity:auth-service",
    name: "AuthService",
    type: "component",
    aliases: ["auth service", "authentication module"],
  },
  {
    id: "entity:adr-005",
    name: "ADR-005",
    type: "decision",
    aliases: ["token rotation decision"],
  },
]);

// Now annotations link doc mentions to external entities, not just code symbols
const mentions = index.mentionsOf("entity:auth-service");
// → [{ docPath: 'docs/AUTH.md', line: 52, text: 'AuthService', confidence: 0.95 },
//    { docPath: 'copilot-instructions.md', line: 172, text: 'authentication module', confidence: 0.82 }]

// File-level annotation lookup
const annotations = index.annotationsForFile("docs/AUTH.md");
// → [{ mention: 'AuthService', entityId: 'entity:auth-service', line: 52, confidence: 0.95 }]
```

**Implementation:** New `external_entities` table in SQLite. New annotation source type
`"external"`. The `annotate()` function gains an optional `externalEntities` parameter.
`mentionsOf(entityId)` is a new query function that joins annotations on entity ID.

**Why this matters:** Consumers operating on entities (not files) — like pipeline workers,
domain-driven tools, or AI agents — can bridge _"this entity is mentioned in these docs"_
without building their own mention scanner. The integration analysis shows this cuts
effort from ~3d to ~1.5d for a typical pipeline consumer.

### 8.1 Programmatic CARI API Documentation _(Docs, S)_ ✅ ✅

Write a guide showing how to use the `CariIndex` facade (from 8.0) and the raw
query functions. Cover three usage patterns:

1. **Facade mode** (recommended): `CariIndex.build()` → typed methods
2. **Low-level mode**: `openIndex()` + `retrieveFromDb()` / `checkFromDb()` etc.
3. **Incremental mode**: `detectChanges()` + `applyChanges()` for CI/CD pipelines

```typescript
// Pattern 1: Facade (high-level, depends on 8.0)
import { CariIndex } from "@intentweave/index";
const index = await CariIndex.build({ paths: ["docs/"], depth: "full" });
const drift = index.check({ changed: ["src/auth.ts"] });

// Pattern 2: Low-level (works today)
import { openIndex, retrieveFromDb, checkFromDb } from "@intentweave/index";
const db = openIndex(".iw/index.db");
const results = retrieveFromDb(db, { query: "authentication", limit: 10 });
const findings = checkFromDb(db, { changed: ["src/auth.ts"] });
db.close();

// Pattern 3: Incremental (works today)
import { detectChanges, applyChanges } from "@intentweave/index";
const changes = detectChanges(".iw/index.db", process.cwd(), currentFiles);
await applyChanges(
  ".iw/index.db",
  changes,
  { ax, kwxOutputs, annotations },
  opts,
);
```

### 8.2 Docusaurus / Starlight Plugin _(INT, M)_

A plugin that runs `CariIndex.build()` + `index.report()` during the doc build and:

- **Warns** on stale references (symbol renamed / deleted but doc still mentions it)
- **Blocks** the build on critical drift (configurable threshold)
- **Injects** a coverage badge per page: _"This page covers 8/12 exported symbols"_
- **Sidebar widget** showing documentation health score

Depends on **8.0** for the build facade. Without it, this plugin would need to shell
out to `iw index build` (slow, untyped) or re-implement the pipeline internally.

```js
// docusaurus.config.js
plugins: [
  [
    "@intentweave/docusaurus-plugin",
    {
      indexPath: ".iw/index.db",
      failOnCritical: true,
      badge: true,
    },
  ],
];
```

### 8.3 Sphinx / MkDocs Integration _(INT, M)_

Same concept for Python-ecosystem doc tools:

- **Sphinx extension**: `iw_health` directive renders inline drift warnings
- **MkDocs plugin**: runs `check` on build, injects admonitions into pages
- Particularly valuable combined with 7.1 (Python AST support)

### 8.4 CI Artifact Validation Action _(INT, M)_

GitHub Action / GitLab CI template that:

1. Runs `iw index build` (or `iw index update` incrementally)
2. Runs `iw index check --changed $(git diff --name-only HEAD~1)` on PR files
3. Posts a PR comment with drift findings and coverage delta
4. Optionally fails the build on critical severity

```yaml
# .github/workflows/doc-health.yml
- uses: intentweave/doc-health-action@v1
  with:
    severity-threshold: warning # fail on warning+
    post-comment: true
```

Already partially possible with `iw index check` — this wraps it for CI ergonomics.
CI mode uses CLI (not library) — no dependency on 8.0.

### 8.5 REST API for External Doc Systems _(INT, S)_

The server (`@intentweave/server-core` + `@intentweave/server-open`) already exposes
REST endpoints for queries, context, health. Document and version-stamp the API so
external doc systems (Confluence, Notion, custom wikis) can call it:

- `POST /api/doc-health` — check specific files
- `POST /api/query` — answer questions about documented entities
- `GET /api/entities?type=component` — list entities for navigation

### 8.6 Webhook-Triggered Re-Index _(INT, M)_

Listen for git push / doc-system save events and rebuild the index incrementally.
Enables: _doc saved in Confluence → webhook → re-index → updated drift status_.
Compose with `@intentweave/index` `detectChanges` + `applyChanges` (already exported).

---

## 9. Graph Topology & Structure _(inspired by [graphify](https://github.com/safishamsi/graphify))_

### 9.1 Community Detection _(CARI, M)_ ✅

Run Leiden community detection on the combined co-occurrence + import + co-change graph.
Automatically discover natural module clusters without user-defined layers. Surface:
_"5 communities detected — auth cluster (12 entities), data layer (8 entities), ..."_.
Visualise in the React UI as colour-coded groups. Use an existing JS implementation
(e.g., `graphology-communities-louvain`) to keep this $0/no-LLM.

**Data sources** (all in SQLite already):

- `co_occurrences` — doc co-mention edges
- `imports` — structural code edges
- `co_changes` — temporal coupling edges

CLI: `iw index communities`. MCP: `cari_communities`.

### 9.2 God-Node / Hub Analysis _(CARI, S)_ ✅

Compute degree centrality across all edge types (annotations, imports, co-occurrences,
co-changes). Rank entities by total degree. Surface: _"Top hubs: AuthService (42 edges),
DatabasePool (28 edges), AppConfig (19 edges)"_. God nodes are the entities everything
connects through — highest architectural risk and highest documentation priority.

CLI: `iw index hubs`. MCP: `cari_hubs`.

### 9.3 Surprising Connection Ranking _(CARI, M)_ ✅

Extend the existing hidden-couplings analysis with a composite surprise score. Rank
by: (a) cross-layer weight (code↔doc edges score higher than code↔code), (b) community
distance (connections spanning different communities from 9.1 rank higher),
(c) inverse frequency (rare co-occurrences are more surprising). Each result includes
a plain-English _why_ explanation.

Builds on: 9.1 (communities), existing `co_occurrences` + `co_changes` data.

CLI: `iw index surprises`. MCP: `cari_surprises`.

### 9.4 Rationale Extraction _(AX, S)_ ✅

Extract `// WHY:`, `// NOTE:`, `// IMPORTANT:`, `// DESIGN:` comments during AX as
first-class knowledge nodes (alongside existing TODO/FIXME/HACK extraction). Store in
a `rationale` table with file, line, kind, text, and linked symbol. Surface: _"14
rationale comments found — 3 explain architectural decisions, 2 document workarounds."_

Not just _what_ the code does — _why_ it was written that way.

CLI: `iw index rationale`. MCP: `cari_rationale`.

---

## 10. Output & Export

### 10.1 Standalone HTML Architecture Report _(CARI, M)_ ✅

Generate a self-contained `architecture.html` that renders a **layered, spatial**
architecture view rather than a generic node-and-edge graph. Combines outputs from
multiple CARI analyses into a single interactive visualization:

- **Layout**: Layer bands from 5.1a/b — files positioned in their inferred or declared
  tier (foundation at bottom, UI at top)
- **Node size**: Proportional to transitive dependents (3.3) — bigger = higher impact
- **Node colour**: Community membership (9.1) — coloured clusters
- **Edges**: Import arrows, with layer violations (5.1b) drawn in red as reverse-arrows,
  boundary violations (3.4) as dashed cross-zone edges
- **Interactivity**: Click to expand/collapse layers, search files, filter by community,
  hover for metrics (fan-in/fan-out, depth, risk)

Uses D3 or vis.js bundled inline — zero server dependency, shareable as a single file.
Complements the full React UI with a zero-dependency deployment artifact.

CLI: `iw index export --html`.

Depends on: 5.1a (layers), 9.1 (communities), 3.3 (depth), 3.4 (boundary violations).

### 10.2 Focus Architecture Report _(CARI, S)_ ✅

Generate a focused Graphviz SVG report centered on a target entity with configurable
hop depth and max nodes.

CLI: `iw index export --focus <target>`. MCP: `cari_focus`.

### 10.3 Watch Mode _(CARI, M)_

Run `iw index watch` in a background terminal. On file save: code files trigger instant
AST re-extraction (no LLM), doc changes re-run annotation matching. Keeps `.iw/index.db`
continuously up to date. Compose with `detectChanges` + `applyChanges` (already exported).

CLI: `iw index watch`.

### 10.3 Git Hooks Integration _(CARI, S)_

`iw hook install` adds `post-commit` and `post-checkout` git hooks that run
`iw index update` automatically. Graph stays current without manual intervention.
`iw hook uninstall` removes them cleanly.

CLI: `iw hook install`, `iw hook uninstall`, `iw hook status`.

### 10.4 Obsidian Vault Export _(CARI, M)_

Export the knowledge graph as a set of interlinked markdown files — one per community
(from 9.1) plus an `index.md` entry point. Each file lists entities, relationships,
and links to related communities. Directly importable into Obsidian, Logseq, or any
markdown-based knowledge base.

CLI: `iw index export --obsidian`.

---

## 11. Plugin Architecture & Platform

### 11.1 Plugin Interface & Registry _(CARI, M)_ ✅

Define the `IWPlugin` interface and `PluginRegistry` class in `@intentweave/core`. A
plugin is an npm package (`@intentweave/plugin-<name>`) that exports a default object
implementing `IWPlugin`:

```typescript
export interface IWPlugin {
  name: string;
  version: string;
  description: string;
  dependencies?: string[];           // other plugin names required
  capabilities?: string[];           // capability identifiers this plugin provides

  registerCommands?(program: Command): void;
  registerMcpTools?(server: McpServer, context: McpContext): void;
  getApi?(): Record<string, unknown>;
}
```

The registry auto-discovers installed `@intentweave/plugin-*` packages via dynamic
`import()` with try/catch — no custom loader, no configuration file needed.

CLI entry point and MCP server call `registry.discover()` at startup, then
`registry.registerAllCommands(program)` / `registry.registerAllMcpTools(server, ctx)`.

### 11.2 Capability Provider System _(CARI, M)_ ✅

Generic provider interfaces that plugins can implement and core features can consume
**without depending on a specific plugin**. Core defines the interface, plugins supply
implementations.

Initial capabilities:

| Capability     | Interface                                         | Used By                                |
| -------------- | ------------------------------------------------- | -------------------------------------- |
| `llm`          | `generate(prompt, opts?) → string`                | `--explain`, `--provider`, layer naming |
| `vcs`          | `log()`, `blame()`, `diff()`                      | TCG stage, staleness detection          |
| `persistence`  | `persist(entities, rels)`, `query(cypher)`         | KG plugin only                         |

When core needs an LLM (e.g., `iw index export --focus X --explain`), it asks the
registry: `registry.getCapability<LlmCapability>("llm")`. If no plugin provides it,
the command prints: _"No LLM provider installed. Run: iw plugin add llm"_.

This decouples reports from the KG plugin. A lightweight `plugin-llm` can provide
just the LLM capability (~50 lines + `openai` dep) without Neo4j, the analyzer pipeline,
or any KG infrastructure.

```typescript
// @intentweave/core/src/capabilities.ts
export interface LlmCapability {
  name: "llm";
  generate(prompt: string, options?: { model?: string; maxTokens?: number }): Promise<string>;
}

export interface VcsCapability {
  name: "vcs";
  log(file: string, limit?: number): Promise<CommitInfo[]>;
  blame(file: string): Promise<BlameInfo[]>;
}

export type Capability = LlmCapability | VcsCapability;
```

### 11.3 KG Plugin Extraction _(KG, L)_ ✅

Decouple all KG-related code from the core CLI via a **dual-backend** persistence
architecture. A lightweight CypherLite engine translates the Cypher subset used in
IntentWeave to SQL, so the consuming code (query, context, persist, impact) speaks
Cypher regardless of backend.

#### 11.3a CypherLite Engine (`@intentweave/cypher-lite`, M) ✅

A zero-dependency Cypher subset parser + SQLite transpiler (~800 lines).

**Supported Cypher subset** (covers 100% of existing queries):
- `MATCH (n:Label) WHERE n.prop = $param` → `SELECT ... FROM ... WHERE`
- `MATCH (a)-[r:REL]->(b)` → `JOIN kg_relationships`
- `MATCH (a)-[r*1..N]-(b)` → Recursive CTEs
- `OPTIONAL MATCH` → `LEFT JOIN`
- `MERGE ... ON CREATE SET ... ON MATCH SET` → `INSERT OR REPLACE`
- `CREATE` / `DELETE` / `DETACH DELETE` → `INSERT` / `DELETE`
- `UNWIND $list AS x` → parameter expansion
- `RETURN ... ORDER BY ... LIMIT` → `SELECT ... ORDER BY ... LIMIT`
- Functions: `toLower()`, `coalesce()`, `count()`, `collect()`, `DISTINCT`
- Predicates: `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN`, `ANY(...)`
- `WITH` clause for chaining

**Out of scope:** `SHORTEST PATH`, `APOC`, graph algorithms, `CALL`, subqueries.

**SQLite Schema:**
```sql
-- Core KG tables
CREATE TABLE kg_entities (
  id          INTEGER PRIMARY KEY,
  canon_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  aliases     TEXT,          -- JSON array
  confidence  REAL DEFAULT 1.0,
  artifact_id TEXT,
  run_id      TEXT,
  workspace_id TEXT,
  track       TEXT DEFAULT 'open',
  props       TEXT,          -- JSON for extra properties
  created_at  TEXT,
  updated_at  TEXT,
  UNIQUE(canon_id, session_id)
);

CREATE TABLE kg_relationships (
  id          INTEGER PRIMARY KEY,
  from_id     INTEGER NOT NULL REFERENCES kg_entities(id),
  to_id       INTEGER NOT NULL REFERENCES kg_entities(id),
  predicate   TEXT NOT NULL,
  confidence  REAL DEFAULT 1.0,
  raw_predicate TEXT,
  artifact_id TEXT,
  run_id      TEXT,
  track       TEXT DEFAULT 'open',
  props       TEXT           -- JSON for extra properties
);

CREATE TABLE kg_raw_triples (
  id             INTEGER PRIMARY KEY,
  subject        TEXT,
  predicate      TEXT,
  object         TEXT,
  subject_kind   TEXT,
  object_kind    TEXT,
  confidence     REAL,
  rationale      TEXT,
  triple_index   INTEGER,
  artifact_id    TEXT,
  source_file    TEXT,
  session_id     TEXT NOT NULL,
  run_id         TEXT,
  track          TEXT DEFAULT 'open',
  created_at     TEXT,
  subject_canon_id TEXT,
  object_canon_id  TEXT
);

CREATE INDEX idx_kg_entities_session ON kg_entities(session_id);
CREATE INDEX idx_kg_entities_name ON kg_entities(name);
CREATE INDEX idx_kg_entities_type ON kg_entities(type);
CREATE INDEX idx_kg_rels_from ON kg_relationships(from_id);
CREATE INDEX idx_kg_rels_to ON kg_relationships(to_id);
CREATE INDEX idx_kg_raw_session ON kg_raw_triples(session_id);
```

#### 11.3b KG-Lite Plugin (`@intentweave/plugin-kg-lite`, M) ✅

`PersistenceCapability` backed by CypherLite + better-sqlite3. Ships with the CLI
by default — zero config, no external database.

#### 11.3c KG Plugin (`@intentweave/plugin-kg`, L) ✅

Existing Neo4j code extracted into a plugin. Passthrough to `neo4j-driver`.
Installed via `iw plugin add kg`.

#### Architecture

```
PersistenceCapability.query(cypher, params)
       │
       ├──▶ plugin-kg (Neo4j)        → pass through to neo4j-driver
       │
       └──▶ plugin-kg-lite (SQLite)  → CypherLite parser → SQL → better-sqlite3
```

**What moves to plugin-kg:**
- Commands: `iw run`, `iw query`, `iw context`, `iw persist`, `iw impact`,
  `iw doc-health --neo4j`, `iw xlink`
- MCP tools: `kg_query`, `kg_context`, `kg_entities`, `kg_impact`, `kg_doc_health`,
  `kg_schema`
- Dependencies: `neo4j-driver`

**What stays in core CLI:**
- All `iw index *` commands (CARI)
- All `cari_*` MCP tools
- `iw init`, `iw plugin *`
- `iw doc-health` (CARI mode — default)

**Result:** `npm install -g @intentweave/cli` installs CARI + KG-Lite. Full Neo4j
users run `iw plugin add kg` for the production backend. The consuming code
(query.ts, context.ts, persist.ts, impact.ts) speaks Cypher to whichever backend
is active — zero code changes needed.

### 11.4 Plugin CLI Commands _(CARI, S)_ ✅

Add `iw plugin` subcommands for plugin lifecycle management:

```bash
iw plugin list                  # show installed plugins + capabilities
iw plugin add <name>            # npm install -g @intentweave/plugin-<name>
iw plugin remove <name>         # npm uninstall -g @intentweave/plugin-<name>
iw plugin info <name>           # show plugin details, version, capabilities
```

`iw plugin list` output:

```
Plugin          Version  Capabilities    Commands Added
──────────────  ───────  ──────────────  ─────────────────────
kg              0.8.0    llm, persist    run, query, context, persist, impact
llm             0.1.0    llm             (none — enhances --explain/--provider)
swift           0.8.0    language:swift  (extends iw index build)
```

### 11.5 Lightweight LLM Plugin _(INT, S)_ ✅

A minimal plugin that provides just the `LlmCapability` — OpenAI SDK + a thin wrapper.
No Neo4j, no analyzer, no pipeline. For users who want `--explain` and `--provider`
on reports without the full KG stack.

```bash
iw plugin add llm
iw index export --html --provider openai          # now works
iw index export --focus auth.ts --explain          # now works
```

Package: `@intentweave/plugin-llm`. Dependencies: just `openai`.

### 11.6 Language Parser as Plugins _(AX, M)_ ✅

Convert existing language parsers to the plugin format. The `LanguageRegistry` from 7.2
already defines the adapter interface — plugins register their adapters at discovery time.

```bash
# Core ships with: TS/JS (built-in)
# Optional:
iw plugin add swift           # @intentweave/plugin-swift
iw plugin add python          # @intentweave/plugin-python
```

Core's `LanguageRegistry` gains a `registerFromPlugin(plugin)` method. Each language
plugin implements `IWPlugin` with a `registerLanguages?(registry)` hook.

This means `tree-sitter-swift` and `tree-sitter-python` native binaries are only
downloaded by users who need them — not everyone.

### 11.7 CLI Neo4j Migration to PersistenceCapability _(KG, L)_

Migrate CLI commands that currently import `neo4j-driver` directly to route through
`PersistenceCapability.query()` instead. This enables `query.ts`, `context.ts`,
`persist.ts`, `impact.ts`, `doc-health.ts`, `xlink.ts`, and MCP `kg_*` tools to
work against **either** backend (Neo4j or SQLite) transparently.

**Scope:**
- ~12 files in `packages/cli/src/` with direct `neo4j-driver` imports
- Move `kg_*` MCP tools to `plugin-kg`'s `registerMcpTools()`
- Remove `neo4j-driver` from CLI's direct dependencies (keep only in `plugin-kg`)
- Result: `@intentweave/cli` ships zero-Neo4j — full Neo4j via `iw plugin add kg`

### 11.8 Selective Semantic Enrichment _(CARI + KG, L)_

**Problem:** Full KG extraction (FX + KX on every file) is expensive and slow. But pure
CARI misses semantic relationships that only an LLM can extract: decisions, rationale,
cross-doc contradictions, intent-to-code links. Most files don't need semantic analysis —
only the ones CARI flags as high-value or ambiguous.

**Solution:** A budget-controlled enrichment pass that uses CARI signals to select targets,
runs LLM extraction on just those files, and writes the results back into the same
`index.db` via CypherLite's `kg_*` tables.

#### Architecture

```
iw index build                           # 1. CARI pass (free, fast)
     │
     ├─ hotspotPriority()                # high-churn, low-doc files
     ├─ orphanedSections()               # doc sections with no code grounding
     ├─ hubs()                           # god-nodes needing semantic context
     ├─ moduleCoverage() < threshold     # under-documented modules
     ├─ crossGroupDrift()                # conflicting doc groups
     │
     └──▶ enrichment candidate list (ranked by impact score)

iw index enrich [--budget 20] [--provider openai]
     │                                   # 2. Targeted LLM (budget-controlled)
     ├─ FX (extract triples for top-N files only)
     ├─ KX (canonicalize entities + predicates)
     ├─ Bridge: inject Canon entities → CARI annotation engine
     └─ Write to kg_* tables in index.db  # Same SQLite file!
     │
iw index retrieve "auth decisions"       # 3. Unified query
     └─ returns CARI annotations + semantic triples in one result
```

**Storage:** Semantic triples live in `kg_entities` / `kg_relationships` tables alongside
CARI's `symbols` / `annotations` tables — single `index.db` file, no second database.
Canonical entities are also injected via the Entity Bridge (`registerEntities()`) so CARI
queries like `retrieve`, `connections`, and `mentions_of` surface them naturally.

**Budget control:**
- `--budget N` limits to N LLM calls (default: 20)
- `--threshold 0.7` only enriches files with impact score ≥ 0.7
- `--focus "packages/auth/"` restricts to a directory subtree
- Incremental: re-enrichment skips files whose content hash hasn't changed

**Impact scoring** (composite of CARI signals):

```
impact = w₁ · hotspot_rank + w₂ · orphan_ratio + w₃ · hub_degree
       + w₄ · (1 - module_coverage) + w₅ · drift_severity
```

Default weights bias toward orphaned sections (high w₂) and hotspots (high w₁) — files
where understanding is most needed and most likely stale.

#### Use Cases for Selective Enrichment

Each use case follows the same pattern: CARI identifies the target, LLM extracts the
semantics, CARI validates the result against the code graph.

**1. ASCII / Mermaid diagram validation** _(extends 5.8)_

Instead of requiring a formal `.iw/architecture.yaml`, the LLM reads ASCII art or
Mermaid diagrams embedded in docs and extracts component-flow triples:

```
CARI detects:  README.md has a ```mermaid block mentioning 6 components
LLM extracts:  (AX Stage) -[FLOWS_TO]-> (Annotator) -[FLOWS_TO]-> (Writer)
CARI validates: import graph confirms AX→Annotator, but Writer←IDF is undocumented
```

No manual YAML authoring — the diagram **is** the architecture spec. The LLM parses it,
CypherLite stores it, CARI validates it. Closes the loop on 5.8 without requiring format
changes to existing docs.

**2. Decision-to-implementation tracking**

```
CARI detects:  docs/decisions/ has 12 ADR files, 4 mention entities with no code grounding
LLM extracts:  (ADR-007: Use JWT) -[DECIDED_FOR]-> (JWT) -[IMPLEMENTED_BY]-> (AuthService)
CARI validates: AuthService symbol exists → grounded ✓. ADR-011 mentions "Redis cache"
               → no symbol found → flagged as unimplemented decision
```

**3. Cross-document contradiction detection**

```
CARI detects:  crossGroupDrift() flags AuthService coverage conflict between API.md
               and ARCHITECTURE.md
LLM extracts:  API.md says (AuthService) -[USES]-> (session tokens)
               ARCHITECTURE.md says (AuthService) -[USES]-> (JWT stateless)
Enriched:      contradicting USES predicates on same entity → surfaced as conflict
```

**4. Config-to-docs synchronisation**

```
CARI detects:  config.ts exports 14 constants, docs reference only 6
LLM extracts:  "MAX_RETRIES controls retry count for API calls" →
               (MAX_RETRIES) -[CONTROLS]-> (API retry behaviour)
CARI validates: MAX_RETRIES=5 in code, docs say "3 retries" → value drift
```

**5. Error-path documentation**

```
CARI detects:  errorHandler.ts is a hub (high fan-in) with zero doc coverage
LLM extracts:  (RateLimitError) -[TRIGGERS]-> (429 response) -[FOLLOWS]-> (retry-after header)
CARI validates: RateLimitError class exists ✓, but retry-after header not in response builder → gap
```

**6. Onboarding / setup instruction validation**

```
CARI detects:  CONTRIBUTING.md references 8 commands, 3 don't match package.json scripts
LLM extracts:  (Step 1: pnpm install) -[PRECEDES]-> (Step 2: pnpm build) -[PRECEDES]-> (Step 3: pnpm test)
CARI validates: scripts exist ✓, but build depends on codegen step not mentioned → missing step
```

#### CLI & MCP

```bash
# Enrich top-20 highest-impact files
iw index enrich --budget 20 --provider openai

# Enrich only a specific area
iw index enrich --focus "packages/auth/" --provider openai

# Dry run — show what would be enriched and why
iw index enrich --dry-run

# Re-enrich only changed files
iw index enrich -i --provider openai

# Query enriched data alongside CARI results
iw index retrieve "authentication decisions"   # both code symbols and KG entities
iw index connections "AuthService"              # structural + semantic connections
```

MCP tools: existing `cari_retrieve`, `cari_connections` etc. return enriched results
automatically — no new tools needed. Add `cari_enrich` for triggering enrichment from
Copilot: _"Enrich the auth module with semantic analysis"_.

#### Dependencies

- CypherLite (11.3a ✅) — SQLite KG storage
- Entity Bridge (exists ✅) — inject KG entities into CARI queries
- LLM Capability (11.5 ✅) — `plugin-llm` provides the LLM calls
- FX/KX stages (exist ✅) — extraction + canonicalization
- CARI scoring queries (exist ✅) — hotspots, hubs, orphans, coverage, drift

---

## 12. Intent Verification (Future Vision)

> _The "weave" in IntentWeave — bridging what you said you'd build with what you actually built._

### 12.1 Spec-to-Code Verification _(KG + CARI, L)_

Given a specification document (requirements, user stories, ADRs), verify that each
stated intent has a corresponding implementation in the codebase:

1. **KG** extracts requirements/decisions/constraints from the spec as entities
2. **CARI** maps those entities to code symbols via the annotation engine
3. **Verification** checks: is each requirement entity grounded in at least one code
   symbol? Are implementation constraints (max retries, timeout values, etc.) reflected
   in the actual code?

```bash
iw verify specs/auth-requirements.md

# ✓ "Rate limiting on all endpoints" → found: rateLimiter middleware in routes/*.ts
# ✗ "Max 3 retries on token refresh" → code has MAX_RETRIES=5 (constraint mismatch)
# ✗ "Audit logging for all admin actions" → no code references found (unimplemented)
# ⚠ "OAuth2 PKCE flow" → mentioned in auth.ts but no test coverage
```

Depends on: `plugin-kg` (entity extraction), CARI (code grounding), entity bridge (8.0a).

### 12.2 Constraint Consistency Check _(KG, M)_

Verify that constraints stated across different spec documents don't contradict each
other. Uses KG entity relationships to find constraint entities and checks for conflicts:

```bash
iw verify --consistency specs/

# ✗ ARCHITECTURE.md says "stateless services" but AUTH-SPEC.md requires "session store"
# ⚠ API-SPEC.md says "max 100 items per page" but PERF-SPEC.md says "max 50 items"
# ✓ 14/16 constraints are internally consistent
```

Depends on: `plugin-kg` (constraint extraction with relationship types).

### 12.3 Living Documentation Score _(KG + CARI, M)_

A composite score per project combining:

- **Spec coverage** (12.1): % of requirements with code grounding
- **Constraint consistency** (12.2): % of constraints without contradictions
- **Documentation freshness** (existing `doc-health`): % of docs up to date
- **Architecture conformance** (5.1b, 5.8): % of imports respecting boundaries

```bash
iw verify --score

# Living Documentation Score: 78/100
#   Spec coverage:           85% (17/20 requirements grounded)
#   Constraint consistency:  94% (15/16 consistent)
#   Doc freshness:           72% (18/25 docs current)
#   Architecture conformance: 60% (3 layer violations, 2 boundary violations)
```

---

## Priority Matrix

| #    | Feature                          | Tier | Size   | Value  | Dependencies         | Status  |
| ---- | -------------------------------- | ---- | ------ | ------ | -------------------- | ------- |
| 2.1  | Exact clone detection            | CARI | S      | High   | AX body_hash         | ✅      |
| 1.1  | Doc-group classification         | CARI | S      | High   | None                 | ✅      |
| 3.1  | Circular import detection        | CARI | S      | High   | AX imports (exists)  | ✅      |
| 3.2  | Unused export detection          | CARI | S      | High   | AX imports (exists)  | ✅      |
| 4.3  | Hotspot → doc priority           | CARI | S      | High   | TCG data (exists)    | ✅      |
| 6.3  | TODO/FIXME inventory             | CARI | S      | High   | None                 | ✅      |
| 1.4  | Coverage by module               | CARI | S      | Medium | None                 | ✅      |
| 1.3  | Orphaned doc sections            | CARI | S      | Medium | None                 | ✅      |
| 1.7  | Doc completeness scoring         | CARI | S      | Medium | None                 | ✅      |
| 2.2  | Structural clones                | CARI | M      | High   | 2.1                  | ✅      |
| 1.2  | Cross-group drift                | CARI | M      | High   | 1.1                  | ✅      |
| 6.2  | Test coverage mapping            | CARI | M      | High   | AX imports (exists)  | ✅      |
| 3.3  | Dependency depth                 | CARI | S      | Medium | AX imports (exists)  | ✅ Done |
| 4.4  | Bus factor per module            | CARI | M      | Medium | TCG data (exists)    |         |
| 3.4  | Package boundary violations      | CARI | M      | Medium | 5.1 concept          | ✅ Done |
| 5.3  | Dead feature detection           | CARI | M      | Medium | 3.2, 1.3             | ✅ Done |
| 4.1  | Ownership drift                  | CARI | S      | Medium | TCG data (exists)    |         |
| 4.2  | Change coupling anomalies        | CARI | S      | Medium | TCG data (exists)    |         |
| 1.5  | Terminology inconsistency        | CARI | M      | Medium | None                 | ✅ Done |
| 5.1a | Layer inference                  | CARI | M      | High   | 9.1, 3.3             | ✅ Done |
| 5.1b | Layer check                      | CARI | S      | High   | 5.1a                 | ✅ Done |
| 5.1c | Layer naming suggestions         | KG   | S      | Low    | 5.1a                 | ✅      |
| 5.5  | Hierarchical sub-layering        | CARI | M      | High   | 5.1a, 3.4            |         |
| 5.6  | As-is vs. as-should comparison   | CARI | M      | High   | 5.1a, 5.1b           | ✅ Done |
| 5.7  | Vertical slice detection         | CARI | M      | High   | 5.1a, 9.1            | ✅ Done |
| 5.8  | Architecture diagram validation  | CARI | L      | High   | imports (exists)     |         |
| 6.1  | Naming convention checks         | CARI | S      | Low    | None                 |         |
| 6.4  | Comment-to-code ratio            | CARI | S      | Low    | None                 |         |
| 5.4  | API surface changelog            | CARI | M      | Medium | Git history          | ✅ Done |
| 5.2  | Interface conformance            | AX   | M      | Medium | None                 | ✅ Done |
| 2.4  | Clone lineage tracking           | CARI | M      | Low    | 2.1                  |         |
| 1.6  | Decision lifecycle               | KG   | M      | Medium | Neo4j pipeline       |         |
| 2.3  | Semantic clone detection         | KG   | L      | Medium | LLM embeddings       |         |
| 7.1  | Python AST extractor             | AX   | M      | High   | tree-sitter-python   | ✅ Done |
| 7.2  | Language-agnostic AX dispatch    | AX   | M      | High   | 7.1                  | ✅ Done |
| 7.3  | Go / Rust / Java extractors      | AX   | M each | Medium | 7.2                  |         |
| 8.0  | CariIndex facade + orchestration | CARI | M      | High   | None (refactor)      | ✅ Done |
| 8.0a | Entity bridge                    | CARI | M      | High   | 8.0                  | ✅ Done |
| 8.1  | Programmatic CARI API docs       | Docs | S      | High   | 8.0                  | ✅ Done |
| 8.2  | Docusaurus/Starlight plugin      | INT  | M      | High   | 8.0                  |         |
| 8.3  | Sphinx / MkDocs integration      | INT  | M      | Medium | 8.0                  |         |
| 8.4  | CI artifact validation action    | INT  | M      | High   | `iw index check`     |         |
| 8.5  | REST API for doc systems         | INT  | S      | Medium | server-core (exists) |         |
| 8.6  | Webhook-triggered re-index       | INT  | M      | Medium | 8.5                  |         |
| 9.1  | Community detection              | CARI | M      | High   | co_occ + imports     | ✅ Done |
| 9.2  | God-node / hub analysis          | CARI | S      | High   | None                 | ✅ Done |
| 9.3  | Surprising connection ranking    | CARI | M      | High   | 9.1                  | ✅ Done |
| 9.4  | Rationale extraction             | AX   | S      | Medium | TODO infra (exists)  | ✅ Done |
| 10.1 | Standalone HTML architecture rpt | CARI | M      | High   | 5.1a, 9.1, 3.3       | ✅ Done |
| 10.2 | Watch mode                       | CARI | M      | Medium | incremental (exists) |         |
| 10.3 | Git hooks integration            | CARI | S      | Medium | 10.2                 |         |
| 10.4 | Obsidian vault export            | CARI | M      | Low    | 9.1                  |         |
| 11.1 | Plugin interface & registry      | CARI | M      | High   | None                 |         |
| 11.2 | Capability provider system       | CARI | M      | High   | 11.1                 |         |
| 11.3 | KG plugin extraction (CypherLite)| KG   | L      | High   | 11.1, 11.2           |         |
| 11.4 | Plugin CLI commands              | CARI | S      | High   | 11.1                 |         |
| 11.5 | Lightweight LLM plugin           | INT  | S      | Medium | 11.2                 |         |
| 11.6 | Language parser as plugins       | AX   | M      | Medium | 11.1, 7.2            |         |
| 12.1 | Spec-to-code verification        | KG   | L      | High   | plugin-kg, 8.0a      |         |
| 12.2 | Constraint consistency check     | KG   | M      | High   | plugin-kg            |         |
| 12.3 | Living documentation score       | KG   | M      | Medium | 12.1, 12.2           |         |
