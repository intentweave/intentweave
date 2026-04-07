# Library API Guide

> **Package:** `@intentweave/index`
> **Version:** 0.3.0
> **Status:** Stable

This guide documents the programmatic API for building and querying CARI indexes.
Three usage patterns are covered: **facade** (recommended), **low-level**, and
**incremental**.

---

## Installation

```bash
# Core package (queries only)
npm install @intentweave/index

# Full build pipeline (requires analyzer)
npm install @intentweave/index @intentweave/analyzer @intentweave/core
```

---

## 1. Facade Mode (Recommended)

The `CariIndex` class provides a single entry point for building and querying
indexes. It manages the database lifecycle and exposes typed query methods.

### Build + Query

```typescript
import { CariIndex } from "@intentweave/index";

// Build from scratch — runs AX → KWX → COX → TCG → annotate → write
const index = await CariIndex.build({
  paths: ["docs/", "packages/"],
  workspaceRoot: process.cwd(),
  depth: "full", // 'structured' (default) or 'full' (+ IDF scoring)
});

// Query
const results = index.retrieve({ query: "authentication" });
console.log(results.files); // Ranked file list

const drift = index.check({ changed: ["src/auth.ts"] });
console.log(drift.findings); // CI findings

// Always close when done
index.close();
```

### Load Existing Index

```typescript
import { CariIndex } from "@intentweave/index";

// Open a pre-built index (read-only)
const index = CariIndex.load(".iw/index.db");

const connections = index.connections({ entity: "AuthService" });
const clones = index.clones();
const todos = index.todos();

index.close();
```

### Build with Progress Reporting

```typescript
import { CariIndex, type CariStageProgress } from "@intentweave/index";

const index = await CariIndex.build({
  paths: ["docs/"],
  workspaceRoot: process.cwd(),
  depth: "structured",
  exclude: ["**/draft/**"],
  include: ["**/*.md"],
  session: "my-project",
  onProgress: (stage: CariStageProgress) => {
    console.log(`${stage.stage}: ${stage.detail} (${stage.durationMs}ms)`);
  },
  log: (msg) => console.log(msg),
});

index.close();
```

### CariConfig Reference

```typescript
interface CariConfig {
  /** Document file paths or directories to analyze */
  paths: string[];

  /** Workspace root directory */
  workspaceRoot: string;

  /** Annotation depth: 'structured' (default) or 'full' (+ IDF scoring) */
  depth?: "structured" | "full";

  /** Glob patterns to exclude (added to defaults + .iwignore) */
  exclude?: string[];

  /** Glob patterns — only include files matching these */
  include?: string[];

  /** Session name (default: directory basename) */
  session?: string;

  /** Output path for the SQLite database (default: .iw/index.db) */
  outputPath?: string;

  /** Logging callback for verbose output */
  log?: (msg: string) => void;

  /** Callback after each pipeline stage completes */
  onProgress?: (stage: CariStageProgress) => void;
}
```

### Entity Bridge

The Entity Bridge lets consumers inject external entities (domain concepts, pipeline
entities, third-party models) so that annotation matching works across both
AST-extracted code symbols and external entities.

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
    metadata: { status: "accepted", date: "2024-03-15" },
  },
]);

// Find all doc mentions of an entity (code symbol or external)
const mentions = index.mentionsOf({ entityId: "entity:auth-service" });
// → [{ docPath: 'docs/AUTH.md', line: 52, text: 'AuthService', confidence: 0.95, source: 'external' }]

// List all annotations for a documentation file
const annotations = index.annotationsForFile({ filePath: "docs/AUTH.md" });
// → [{ mention: 'AuthService', entityId: 'entity:auth-service', entityName: 'AuthService',
//      entitySource: 'external', line: 52, confidence: 0.95 }]

// Map test files to source files and find untested exports
const coverage = index.testCoverage();
// → { totalExported: 45, covered: 38, coveragePercent: 84.4, untested: [...], ... }
```

**Low-level API:** Use `registerExternalEntities(dbPath, entities)` from `@intentweave/index`
for direct SQLite access without the facade.

**CLI:** `iw index register-entities entities.json` reads a JSON array of `ExternalEntity`
objects and writes them to the index.

---

## 2. Query Methods

All query methods are synchronous and return typed results. Each method delegates
to the underlying SQLite database.

### `retrieve(params)` — Ranked File Retrieval

Find files relevant to a topic or symbol name, ranked by annotation density,
co-occurrence score, and co-change recency.

```typescript
const result = index.retrieve({
  query: "authentication",
  scope: "docs", // optional: 'docs' | 'code' | 'all'
  limit: 10, // optional: max results (default: 20)
});

// result.files: Array<{ path, score, reason, spans? }>
```

### `connections(params)` — Cross-Layer Connection Discovery

Find entities connected to a symbol across three layers: doc co-occurrence, code
imports, and git co-change.

```typescript
const result = index.connections({
  entity: "AuthService",
  limit: 10,
  include: ["doc_cooc", "co_change", "code_import"],
});

// result.connections: Array<{ entity, score, sources: ConnectionSource[] }>
// result.gaps: Array<{ entity, expectedIn, reason }>
```

### `check(params)` — CI Drift Detection

Detect documentation drift when code files change. Returns actionable findings
suitable for CI integration.

```typescript
const result = index.check({
  changed: ["src/auth/service.ts", "src/auth/jwt.ts"],
  severity: "warning", // optional: 'info' | 'warning' | 'error'
});

// result.findings: Array<{ file, line, severity, message, relatedDocs }>
```

### `report(opts?)` — Corpus Health Report

Comprehensive health dashboard covering documentation coverage, staleness,
hidden couplings, and undocumented dependencies.

```typescript
const result = index.report();

// result.coverage: { documented, total, percentage, topUndocumented }
// result.staleness: { staleDocCount, topStale }
// result.hiddenCouplings: Array<{ entityA, entityB, docCoocScore, hasCodeDependency }>
// result.undocumentedDeps: Array<{ entityA, entityB, coChangeCount, docMentions }>
```

### `clones()` — Exact Clone Detection

Find functions/methods with identical normalised body hashes.

```typescript
const result = index.clones();
// result.cloneGroups: Array<{ bodyHash, bodyLines, symbols }>
// result.totalCloneGroups: number
// result.totalClonedSymbols: number
```

### `structuralClones()` — Type-2 Clone Detection

Find functions with the same AST structure but different identifiers/literals.

```typescript
const result = index.structuralClones();
// result.cloneGroups: Array<{ structureHash, bodyLines, symbols }>
```

### `circularImports()` — Import Cycle Detection

```typescript
const result = index.circularImports();
// result.cycles: Array<{ files: string[], length: number }>
// result.totalCycles: number
```

### `unusedExports()` — Dead Export Detection

```typescript
const result = index.unusedExports();
// result.unused: Array<{ name, filePath, kind, line }>
// result.totalUnused: number
// result.totalExported: number
```

### `hotspotPriority()` — Documentation Urgency Ranking

High-churn files with low documentation coverage, ranked by urgency.

```typescript
const result = index.hotspotPriority();
// result.priorities: Array<{
//   filePath, churn, documentedSymbols, totalExportedSymbols,
//   coveragePercent, priorityScore
// }>
```

### `todos()` — TODO/FIXME/HACK/XXX Inventory

```typescript
const result = index.todos();
// result.todos: Array<{ filePath, line, kind, text }>
// result.totalCount: number
// result.byKind: Record<string, number>
```

### `moduleCoverage()` — Per-Directory Coverage

```typescript
const result = index.moduleCoverage();
// result.modules: Array<{ module, ... }>
```

### `orphanedSections()` — Ungrounded Doc Sections

Doc sections where all mentions are ungrounded (no matching code symbol).

```typescript
const result = index.orphanedSections();
// result.sections: Array<{ ... }>
```

### `docCompleteness()` — Per-Doc Completeness

```typescript
const result = index.docCompleteness();
// result.docs: Array<{ ... }>
```

### `crossGroupDrift()` — Cross-Group Entity Conflicts

```typescript
const result = index.crossGroupDrift();
// result.drifts: Array<{ entity, groups, reason }>
// result.totalDrifts: number
```

### `mentionsOf(params)` — Entity → Doc Mentions

Find all documentation mentions of a specific entity (code symbol or external).

```typescript
const result = index.mentionsOf({ entityId: "entity:auth-service" });
// result: Array<{ docPath, line, text, confidence, source }>
// Options: minConfidence?: number, limit?: number
```

### `annotationsForFile(params)` — File → All Annotations

List all annotations for a documentation file, resolving entity names from both
symbols and external entities.

```typescript
const result = index.annotationsForFile({ filePath: "docs/AUTH.md" });
// result: Array<{ mention, entityId, entityName, entitySource, line, confidence }>
// entitySource: "symbol" | "external" | undefined
// Options: minConfidence?: number, limit?: number
```

### `testCoverage(params)` — Test → Source Mapping

Map test files to their source files via naming convention and import analysis.
Identifies exported symbols lacking test coverage.

```typescript
const result = index.testCoverage({ limit: 20 });
// result.totalExported: number — total exported symbols in source files
// result.covered: number — symbols with at least one test mapping
// result.coveragePercent: number — covered/totalExported * 100
// result.mappings: Array<{ testFile, sourceFile, strategy, importedNames }>
//   strategy: "naming" | "import" | "both"
// result.untested: Array<{ name, filePath, kind, line }>
// result.byDirectory: Array<{ directory, totalExported, covered, coveragePercent }>
```

---

## 3. Low-Level Mode

For fine-grained control, use the individual functions directly. This is useful
when you need custom pipeline logic or want to skip certain stages.

### Query Functions (Dual Signature)

Every query function has two signatures: path-based (opens+closes DB) and
database-based (reuses an open handle).

```typescript
import { retrieve, retrieveFromDb, openIndex } from "@intentweave/index";

// Path-based (opens and closes DB internally)
const result = retrieve(".iw/index.db", { query: "auth" });

// DB-based (you manage the connection)
const db = openIndex(".iw/index.db");
const r1 = retrieveFromDb(db, { query: "auth" });
const r2 = retrieveFromDb(db, { query: "database" });
db.close();
```

Available functions:
`retrieve`, `connections`, `check`, `report`, `clones`, `structuralClones`,
`circularImports`, `unusedExports`, `hotspotPriority`, `todos`,
`moduleCoverage`, `orphanedSections`, `docCompleteness`, `crossGroupDrift`,
`testCoverage`

### Build Pipeline Functions

```typescript
import { buildIndex, annotate, computeIdf } from "@intentweave/index";
import {
  runAxStage,
  runInStage,
  runKwxStage,
  runCoxStage,
} from "@intentweave/analyzer";

// 1. Run AX (AST extraction)
const ax = await runAxStage({ workspaceRoot: process.cwd() });

// 2. Run KWX per file (keyword extraction)
const kwxOutputs = [];
for (const file of docFiles) {
  const inOutput = await runInStage(/*...*/);
  const kwx = await runKwxStage({ inOutput }, { depth: "full" });
  kwxOutputs.push(kwx);
}

// 3. Co-occurrence scoring
const cox = await runCoxStage({ kwxOutputs });

// 4. Annotate
const idf = computeIdf(kwxOutputs);
const annotations = annotate(ax, kwxOutputs, { idfScores: idf });

// 5. Build SQLite index
const result = buildIndex(ax, kwxOutputs, cox, tcg, annotations, {
  session: "my-project",
  workspaceRoot: process.cwd(),
  depth: "full",
});
```

---

## 4. Incremental Mode

Update an existing index when only a few files change, avoiding a full rebuild.

```typescript
import { detectChanges, applyChanges, hashFile } from "@intentweave/index";

// Detect which files changed since last build
const changes = detectChanges(".iw/index.db", process.cwd());
// changes.added, changes.modified, changes.deleted

// Apply changes (re-indexes only affected files)
const result = await applyChanges(".iw/index.db", changes, {
  workspaceRoot: process.cwd(),
  depth: "structured",
});
```

---

## 5. File Discovery Utilities

The facade exports file discovery functions for finding document files:

```typescript
import {
  DEFAULT_EXCLUDES, // Pre-defined glob patterns for common directories
  loadIwIgnore, // Load .iwignore patterns from workspace root
  buildExcludeList, // Combine defaults + .iwignore + custom excludes
  discoverFiles, // Find document files (.md, .mdx, .txt, .rst)
  isExcluded, // Check if a path matches any exclude pattern
} from "@intentweave/index";

// Discover all docs, respecting exclusions
const excludes = buildExcludeList(["custom/**"], await loadIwIgnore(cwd), true);
const files = await discoverFiles(["docs/", "guides/"], cwd, {
  exclude: excludes,
});
```

---

## 6. Type Exports

All result types are exported for TypeScript consumers:

```typescript
import type {
  // Config
  CariConfig,
  CariStageProgress,
  // Build
  IndexBuildOptions,
  IndexBuildResult,
  // Queries
  RetrieveParams,
  RetrieveResult,
  ConnectionsParams,
  ConnectionsResult,
  CheckParams,
  CheckResult,
  ReportResult,
  ClonesResult,
  StructuralClonesResult,
  CircularImportsResult,
  UnusedExportsResult,
  HotspotPriorityResult,
  TodosResult,
  ModuleCoverageResult,
  OrphanedSectionsResult,
  DocCompletenessResult,
  CrossGroupDriftResult,
} from "@intentweave/index";
```

---

## 7. Depth Modes

| Mode         | What's extracted                                 | Speed  | Coverage         |
| ------------ | ------------------------------------------------ | ------ | ---------------- |
| `structured` | Headings, bold, code-spans, identifiers          | Fast   | Baseline         |
| `full`       | All of structured + body text with IDF filtering | Slower | +72% annotations |

Use `structured` for quick iterations, `full` for thorough analysis.

---

## 8. Error Handling

- `CariIndex.build()` throws if no document files are found in the given paths
- `CariIndex.load()` throws if the database file doesn't exist
- Query methods throw if the database connection is closed
- The `onProgress` callback is never called if a stage fails (the build throws instead)
