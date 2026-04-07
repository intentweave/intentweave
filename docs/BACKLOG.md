# IntentWeave — Feature Backlog

> Checks, discoveries, and intelligence features — prioritised by value and effort.

---

## Legend

| Tag | Meaning |
|-----|---------|
| **CARI** | SQLite-only, $0, no LLM |
| **KG** | Requires Neo4j + LLM pipeline |
| **AX** | Extends AST extractor |
| **INT** | Integration / embedding mode |
| **Docs** | Documentation only |
| **S/M/L** | T-shirt size effort |

---

## 1. Documentation Intelligence

### 1.1 Doc-Group Classification *(CARI, S)* ✅
Add `doc_group` column to `files` table. Auto-classify by path convention
(`docs/api/**` → "api-reference", `docs/decisions/*` → "architecture", `README*` → "readme")
with optional `.iw/doc-groups.yaml` override. Foundation for all cross-group checks below.

### 1.2 Cross-Group Drift Detection *(CARI, M)* ✅
Compare entity coverage across doc groups. Flag when two groups describe the same entity
with conflicting qualifiers or divergent detail level. Surface: *"ARCHITECTURE.md and
API.md diverge 42% on AuthService — check for stale cross-references."*

### 1.3 Orphaned Documentation Sections *(CARI, S)* ✅
Detect heading sections in docs where **none** of the mentioned entities resolve to symbols
in the codebase. Likely: outdated feature descriptions, removed API docs, dead tutorials.

### 1.4 Documentation Coverage by Module *(CARI, S)* ✅
Roll up symbol coverage per directory/package. Show: `packages/analyzer/: 72% documented,
packages/cli/: 45% documented`. Identify under-documented modules at a glance.

### 1.5 Terminology Inconsistency Detection *(CARI, M)*
Detect when docs use different names for the same code symbol (e.g., "auth service",
"AuthService", "authentication module" all referring to `AuthService` class). Surface
a suggested canonical name per entity.

### 1.6 Decision Lifecycle Tracking *(KG, M)*
Track decisions through states: proposed → accepted → superseded → deprecated.
Flag decisions that were accepted but never implemented (no code symbol reference),
and decisions that were superseded but still referenced in active docs.

### 1.7 Doc Completeness Scoring *(CARI, S)* ✅
Per-file completeness score: does the doc cover all exported symbols from the files it
references? A doc about `AuthService` that covers 3/7 public methods scores 43%.

---

## 2. Code Duplication & Similarity

### 2.1 Exact Clone Detection *(AX + CARI, S)* ✅
Add `body_hash` (SHA-256 of normalised body, whitespace/comments stripped) to `symbols`
table during AX. Query: self-join on `body_hash` where `body_lines > 5`. Surface:
*"formatDate() in utils/date.ts is identical to formatDate() in helpers/format.ts"*.

### 2.2 Structural Clone Detection — Type 2 *(AX + CARI, M)* ✅
Add `structure_hash` (hash of AST node-type sequence, ignoring identifiers/literals).
Catches renamed-variable copies. Surface: *"validateEmail() and validatePhone() share
identical control flow — consider extracting a generic validator."*

### 2.3 Semantic Clone Detection — Type 3/4 *(KG, L)*
Use LLM embeddings on function-level summaries. Compare cosine similarity across all
function pairs. Catches behaviourally equivalent but structurally different implementations.

### 2.4 Copy-Paste Lineage Tracking *(AX + CARI, M)*
When exact clones exist, track which was created first (git blame). Surface the original
and its copies so teams can decide which to keep and which to eliminate.

---

## 3. Dependency & Import Intelligence

### 3.1 Circular Import Detection *(AX + CARI, S)* ✅
Build import graph from `ExtractedImport` data already captured by AX. Run cycle detection
(Tarjan/Johnson). Surface: *"Circular dependency: auth.ts → user.ts → permission.ts → auth.ts"*.

### 3.2 Unused Export Detection *(AX + CARI, S)* ✅
Cross-reference exported symbols against all import statements. Flag exports that are
never imported anywhere in the workspace. Distinguish: truly unused vs. entry-point exports.

### 3.3 Dependency Depth Analysis *(AX + CARI, S)*
For each file, compute transitive import depth. Flag files with excessive fan-in (many
dependents — high-risk to change) or fan-out (many dependencies — fragile).

### 3.4 Package Boundary Violations *(AX + CARI, M)*
In monorepos, detect when a file imports from another package's internal modules
(not the package's public API). Surface: *"analyzer/src/stages/fx.ts imports from
cli/src/drift/docDocDrift.ts — should go through @intentweave/cli public exports."*

---

## 4. Git & Temporal Intelligence

### 4.1 Ownership Drift *(CARI, S)*
Detect when the git-blame owner of a code file differs from the last doc editor.
Surface: *"auth.ts now owned by @alice but AUTH.md last edited by @bob (6 months ago)"*.

### 4.2 Change Coupling Anomalies *(CARI, S)*
Files that historically co-change but haven't recently — either the coupling broke
(refactor) or one side is silently drifting. Surface: *"auth.ts and user.ts co-changed
in 12/15 commits but diverged 3 months ago."*

### 4.3 Hotspot → Documentation Priority *(CARI, S)* ✅
Combine churn rate (change frequency) with documentation coverage. High-churn,
low-doc files are the highest-priority documentation targets. Output a ranked list.

### 4.4 Bus Factor per Module *(CARI, M)*
Count distinct committers per file/directory. Flag modules where only 1 person has
ever committed. Cross-reference with documentation coverage — low bus factor +
low docs = critical knowledge risk.

---

## 5. Architecture & Design Intelligence

### 5.1 Layer Violation Detection *(AX + CARI, M)*
Define architectural layers (e.g., `ui → server → core`). Detect imports that skip
layers or go in the wrong direction. Requires user-defined layer config in `.iw/layers.yaml`.

### 5.2 Interface Conformance Drift *(AX, M)*
Track when a class claims to implement an interface but the method signatures have
diverged (missing methods, changed parameters). More precise than tsc for cross-package
scenarios.

### 5.3 Dead Feature Detection *(CARI + AX, M)*
Combine: (a) code symbols never called from tests or entry points, (b) doc sections
with zero code references, (c) git: no commits in 6+ months. When all three align,
flag as likely dead feature.

### 5.4 API Surface Changelog *(AX + CARI, M)*
Track exported symbols over time (git history). Detect additions, removals, signature
changes per release. Auto-generate: *"v0.2.0: +3 exports, -1 export, 2 signature changes
in @intentweave/cli"*.

---

## 6. Quality & Consistency Checks

### 6.1 Naming Convention Violations *(AX, S)*
Check symbol names against configurable patterns (camelCase functions, PascalCase classes,
UPPER_SNAKE constants). Flag violations per file. No new dependencies — regex on existing
symbol data.

### 6.2 Test Coverage Mapping *(AX + CARI, M)*
Map test files to their targets via naming convention (`foo.test.ts` → `foo.ts`) and
import analysis. Surface untested exported symbols: *"12 exported functions in
packages/analyzer/ have no corresponding test file."*

### 6.3 TODO/FIXME/HACK Inventory *(AX, S)* ✅
Extract inline markers from source during AX. Store in index with file, line, age
(git blame). Surface: *"47 TODOs, 12 older than 6 months, 3 reference deleted functions."*
Cross-reference with doc coverage — undocumented TODOs are invisible technical debt.

### 6.4 Comment-to-Code Ratio Anomalies *(AX, S)*
Flag files with unusually low or high comment ratios compared to workspace average.
Very low → complex undocumented code. Very high → possibly stale comments describing
old behaviour.

---

## 7. Language Support

### 7.1 Python AST Extractor *(AX, M)*
Create `packages/python-parser/` using `tree-sitter-python`. Extract: functions, classes,
methods, decorators, imports (`import X`, `from X import Y`), module-level variables,
type hints. Map to the existing `ExtractedSymbol` / `ExtractedImport` interfaces so all
downstream stages (KWX, COX, Annotate, CARI queries) work without changes.

**Current language dispatch** (in `packages/analyzer/src/stages/ax.ts`) is hardcoded:
TS/JS files → `ast-extractor`, `.swift` → `swift-parser`. Adding Python requires a
third branch — or better, the generic dispatch in 7.2.

### 7.2 Language-Agnostic AX Dispatch *(AX, M)*
Replace the hardcoded if/else in the AX stage with a **language registry**:

```typescript
// .iw/languages.ts or built-in registry
const languages: LanguageAdapter[] = [
  { extensions: ['.ts', '.tsx', '.js', '.jsx'], extractor: '@intentweave/ast-extractor' },
  { extensions: ['.swift'],                     extractor: '@intentweave/swift-parser' },
  { extensions: ['.py'],                        extractor: '@intentweave/python-parser' },
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

### 7.3 Go / Rust / Java Extractors *(AX, M each)*
With the registry from 7.2, each new language is a self-contained package:
- `packages/go-parser/` — `tree-sitter-go` (functions, structs, interfaces, imports)
- `packages/rust-parser/` — `tree-sitter-rust` (fn, struct, impl, trait, mod, use)
- `packages/java-parser/` — `tree-sitter-java` (class, method, interface, import)

Each maps to `ExtractedSymbol` + `ExtractedImport`. Downstream pipeline unchanged.

---

## 8. Embedded / Integration Mode

IntentWeave's packages (`@intentweave/index`, `@intentweave/core`, `@intentweave/ast-extractor`)
already export programmatic APIs. This section covers packaging them for use **inside**
documentation systems rather than just alongside them.

### 8.1 Programmatic CARI API Documentation *(Docs, S)*
Write a guide showing how to use the index API without the CLI:

```typescript
import { buildIndex, retrieve, check, report, openIndex } from '@intentweave/index';

// Build once (e.g., in a doc pipeline prebuild step)
await buildIndex({ root: './docs', depth: 'full' });

// Query at any time
const db = openIndex('.iw/index.db');
const results = retrieve(db, { query: 'authentication', limit: 10 });
const health  = report(db);
const drift   = check(db, { changed: ['src/auth.ts'] });
```

### 8.2 Docusaurus / Starlight Plugin *(INT, M)*
A plugin that runs `buildIndex` + `report` during the doc build and:
- **Warns** on stale references (symbol renamed / deleted but doc still mentions it)
- **Blocks** the build on critical drift (configurable threshold)
- **Injects** a coverage badge per page: *"This page covers 8/12 exported symbols"*
- **Sidebar widget** showing documentation health score

```js
// docusaurus.config.js
plugins: [
  ['@intentweave/docusaurus-plugin', {
    indexPath: '.iw/index.db',
    failOnCritical: true,
    badge: true,
  }]
]
```

### 8.3 Sphinx / MkDocs Integration *(INT, M)*
Same concept for Python-ecosystem doc tools:
- **Sphinx extension**: `iw_health` directive renders inline drift warnings
- **MkDocs plugin**: runs `check` on build, injects admonitions into pages
- Particularly valuable combined with 7.1 (Python AST support)

### 8.4 CI Artifact Validation Action *(INT, M)*
GitHub Action / GitLab CI template that:
1. Runs `iw index build` (or `iw index update` incrementally)
2. Runs `iw index check --changed $(git diff --name-only HEAD~1)` on PR files
3. Posts a PR comment with drift findings and coverage delta
4. Optionally fails the build on critical severity

```yaml
# .github/workflows/doc-health.yml
- uses: intentweave/doc-health-action@v1
  with:
    severity-threshold: warning   # fail on warning+
    post-comment: true
```

Already partially possible with `iw index check` — this wraps it for CI ergonomics.

### 8.5 REST API for External Doc Systems *(INT, S)*
The server (`@intentweave/server-core` + `@intentweave/server-open`) already exposes
REST endpoints for queries, context, health. Document and version-stamp the API so
external doc systems (Confluence, Notion, custom wikis) can call it:
- `POST /api/doc-health` — check specific files
- `POST /api/query` — answer questions about documented entities
- `GET /api/entities?type=component` — list entities for navigation

### 8.6 Webhook-Triggered Re-Index *(INT, M)*
Listen for git push / doc-system save events and rebuild the index incrementally.
Enables: *doc saved in Confluence → webhook → re-index → updated drift status*.
Compose with `@intentweave/index` `detectChanges` + `applyChanges` (already exported).

---

## Priority Matrix

| # | Feature | Tier | Size | Value | Dependencies | Status |
|---|---------|------|------|-------|--------------|--------|
| 2.1 | Exact clone detection | CARI | S | High | AX body_hash | ✅ |
| 1.1 | Doc-group classification | CARI | S | High | None | ✅ |
| 3.1 | Circular import detection | CARI | S | High | AX imports (exists) | ✅ |
| 3.2 | Unused export detection | CARI | S | High | AX imports (exists) | ✅ |
| 4.3 | Hotspot → doc priority | CARI | S | High | TCG data (exists) | ✅ |
| 6.3 | TODO/FIXME inventory | CARI | S | High | None | ✅ |
| 1.4 | Coverage by module | CARI | S | Medium | None | ✅ |
| 1.3 | Orphaned doc sections | CARI | S | Medium | None | ✅ |
| 1.7 | Doc completeness scoring | CARI | S | Medium | None | ✅ |
| 2.2 | Structural clones | CARI | M | High | 2.1 | ✅ |
| 1.2 | Cross-group drift | CARI | M | High | 1.1 | ✅ |
| 6.2 | Test coverage mapping | CARI | M | High | AX imports (exists) | |
| 3.3 | Dependency depth | CARI | S | Medium | AX imports (exists) | |
| 4.4 | Bus factor per module | CARI | M | Medium | TCG data (exists) | |
| 3.4 | Package boundary violations | CARI | M | Medium | 5.1 concept | |
| 5.3 | Dead feature detection | CARI | M | Medium | 3.2, 1.3 | |
| 4.1 | Ownership drift | CARI | S | Medium | TCG data (exists) | |
| 4.2 | Change coupling anomalies | CARI | S | Medium | TCG data (exists) | |
| 1.5 | Terminology inconsistency | CARI | M | Medium | None | |
| 5.1 | Layer violation detection | CARI | M | Medium | User config | |
| 6.1 | Naming convention checks | CARI | S | Low | None | |
| 6.4 | Comment-to-code ratio | CARI | S | Low | None | |
| 5.4 | API surface changelog | CARI | M | Medium | Git history | |
| 5.2 | Interface conformance | AX | M | Medium | None | |
| 2.4 | Clone lineage tracking | CARI | M | Low | 2.1 | |
| 1.6 | Decision lifecycle | KG | M | Medium | Neo4j pipeline | |
| 2.3 | Semantic clone detection | KG | L | Medium | LLM embeddings | |
| 7.1 | Python AST extractor | AX | M | High | tree-sitter-python | |
| 7.2 | Language-agnostic AX dispatch | AX | M | High | 7.1 | |
| 7.3 | Go / Rust / Java extractors | AX | M each | Medium | 7.2 | |
| 8.1 | Programmatic CARI API docs | Docs | S | High | None | |
| 8.2 | Docusaurus/Starlight plugin | INT | M | High | 8.1 | |
| 8.3 | Sphinx / MkDocs integration | INT | M | Medium | 8.1 | |
| 8.4 | CI artifact validation action | INT | M | High | `iw index check` | |
| 8.5 | REST API for doc systems | INT | S | Medium | server-core (exists) | |
| 8.6 | Webhook-triggered re-index | INT | M | Medium | 8.5 | |
