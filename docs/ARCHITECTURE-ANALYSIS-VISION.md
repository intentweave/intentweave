# Architecture Analysis Vision

> **Version:** 0.1
> **Status:** Design / Proposal
> **Date:** 2025-07-19
> **Scope:** Design rationale and conceptual framework for CARI architecture analysis features
> (backlog items 5.5–5.8)

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [The Three Dimensions of Architecture](#2-the-three-dimensions-of-architecture)
3. [The Flat-Layer Problem](#3-the-flat-layer-problem)
4. [Hierarchical Sub-Layering](#4-hierarchical-sub-layering)
5. [As-Is vs. As-Should](#5-as-is-vs-as-should)
6. [Vertical Slices](#6-vertical-slices)
7. [Diagram Validation](#7-diagram-validation)
8. [Data Reuse — No New Extraction](#8-data-reuse--no-new-extraction)
9. [Interaction Model](#9-interaction-model)
10. [Open Questions](#10-open-questions)

---

## 1. Motivation

CARI's architecture features (5.1a Layer Inference, 5.1b Layer Check, 5.1c Layer Naming, 10.1 HTML
Report) already give developers a structural view of their codebase: topological depth from the import
graph, community detection from combined edges, and an interactive HTML report with three D3 views.

However, analysing the IntentWeave monorepo's own `layers-view.png` revealed a fundamental limitation:
**the current flat inference treats every file as a peer in one global graph**. Internal sub-layers of
a large package (e.g., the `analyzer`'s orchestration stages) appear at the same visual level as much
coarser top-level boundaries (e.g., "UI" or "CLI"). The result is structurally correct but
architecturally misleading — it answers "what depends on what?" but not "how is this codebase
actually organized?"

This document captures the design insights and conceptual framework that emerged from analysing that
gap. The concrete specifications live in [BACKLOG.md](BACKLOG.md) items 5.5–5.8; this doc captures
the _why_, the unifying model, and the data-reuse strategy.

## 2. The Three Dimensions of Architecture

Software architecture can be understood along three orthogonal dimensions. Most tools only analyse
one; CARI aims to cover all three from the same underlying data:

```
                    ┌─────────────────────────────────────────┐
                    │         Component Boundaries            │
                    │    "what is the intended design?"        │
                    │    (diagram validation, 5.8)             │
                    └───────────────────┬─────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
        ▼                               ▼                               ▼
 ┌──────────────┐              ┌──────────────┐              ┌──────────────┐
 │  Horizontal  │              │   Vertical   │              │  Conformance │
 │   Layers     │              │    Slices    │              │     Delta    │
 │ (tiers)      │              │ (features)   │              │ (as-is vs.  │
 │  5.1a, 5.5   │              │   5.7        │              │  as-should) │
 └──────────────┘              └──────────────┘              │  5.6        │
   "what level                   "what feature                └──────────────┘
    does this                     does this                   "does reality
    code live at?"                code serve?"                 match intent?"
```

### Horizontal layers (tiers)

The classic dependency-depth view. Foundation code at the bottom, entry points at the top. Derived
from the import graph via topological sort (Tarjan SCC → DAG → iterative depth). Already
implemented in 5.1a. **5.5 extends this with hierarchical nesting** — macro layers at package
boundaries, sub-layers within large packages.

### Vertical slices (feature cohorts)

Cross-cutting features that span multiple layers. The "auth feature" touches the UI, the route
handler, the service layer, and the types package — files at different depths that form one
functional cohort. Communities (label propagation on the combined graph) already detect these
clusters; **5.7 adds the layer-span analysis** that classifies communities as "horizontal module"
(all in one layer) vs. "vertical slice" (spanning ≥3 layers).

### Component boundaries (design conformance)

The intended architecture as documented by the team — pipeline stages, data flow, forbidden
dependencies. **5.8 introduces a `diagram-as-config` format** that captures this intent, and
**5.6 adds the comparison view** showing where inferred reality diverges from documented should-be
architecture.

## 3. The Flat-Layer Problem

### What we observed

Running `iw index layers-infer` on the IntentWeave monorepo produced this (simplified):

```
Layer 5 (entry):      apps/server, apps/ui
Layer 4 (interface):  packages/cli
Layer 3 (business):   packages/analyzer/src/pipeline/openTrack.ts
Layer 2 (core):       packages/analyzer/src/stages/fx.ts, kx.ts, gx.ts
Layer 1 (service):    packages/index/src/queries/*
Layer 0 (foundation): packages/core, packages/index/src/schema.ts
```

The problem: layers 1–3 are all _internal details_ of two packages (`analyzer` and `index`), yet
they appear as top-level peers of the CLI and UI layers. A developer looking at this view might
conclude there are six distinct architectural tiers, when in reality there are three macro tiers
(`core` → `analyzer/cli/index` → `apps`) with internal structure inside the larger packages.

### Root cause

The topological sort doesn't know about package boundaries. It sees a flat graph of ~500 files
connected by ~2000 import edges, and assigns depth purely by longest-path-from-sinks. Files at
different internal nesting levels of one package end up at different global depths.

### Why it matters

- The HTML report visually suggests complexity that doesn't exist at the architectural level
- Comparing to intended architecture is impossible without the right granularity
- Teams can't distinguish "these are separate layers we maintain" from "these are internal details
  of one component"

## 4. Hierarchical Sub-Layering

**Key insight:** Architecture is fractal. A monorepo has macro layers (packages/apps), and each
package has internal layers (stages, utilities, types). The inference should reflect both levels.

### The mechanism

1. **Collapse** each `packages/*` directory into a supernode in the import graph
2. Run topological depth on the supernode graph → **macro layer assignment**
3. For each supernode with >N files, build its internal subgraph and run topological depth
   again → **sub-layer assignment**
4. The HTML report renders this as nested bands — a macro layer band containing lighter sub-bands

This is not a new algorithm — it's the existing `computeDepthFromSinks` applied twice at different
granularity levels. The only new logic is the package-boundary detection (reusing the boundary
violation logic from 3.4) and the supernode collapse.

### Design principle

**Don't assume a well-structured project.** Some codebases have clean package boundaries; others
have everything in `src/`. The `--hierarchical` flag explicitly opts into two-level inference.
Without it, the existing flat inference remains the default and works well for smaller projects.

## 5. As-Is vs. As-Should

**Key insight:** Architecture drift happens when reality diverges from intent. Detecting it
requires knowing both.

Today, CARI supports:
- **As-is:** `layers-infer` (what the import graph reveals)
- **As-should:** `layers-check` (validation against `.iw/layers.yaml`)

But there's no unified view comparing them side-by-side. The user must mentally correlate the
output of two separate commands.

### The comparison model

```
File                    │ Inferred (as-is)  │ Config (as-should) │ Status
────────────────────────┼───────────────────┼────────────────────┼──────────
packages/cli/src/cli.ts │ Layer 4 (entry)   │ Layer 3 (iface)    │ ⚠ DRIFT
packages/core/types.ts  │ Layer 0 (found.)  │ Layer 0 (found.)   │ ✓ OK
```

This works at two levels:
- **File level:** Per-file comparison (detailed, useful for CI)
- **Layer level:** Do inferred layer boundaries roughly match config boundaries?
  (aggregate, useful for architecture reviews)

### Value for messy codebases

Well-architected projects will show mostly green. The real value is for **messy codebases** where
the team has an _intended_ architecture but suspects the code has drifted. The comparison view
pinpoints exactly where drift occurs and how far — turning a vague "it feels tangled" into
actionable file-level findings.

## 6. Vertical Slices

**Key insight:** Layers answer "what level?" but not "what feature?" Communities already cluster
related files, but the user doesn't know if a community represents a horizontal module (all at one
layer) or a vertical feature slice (cutting across layers).

### The classification rule

```
community.layer_span = max(member.layer) - min(member.layer)

if layer_span >= 3:    → vertical slice
elif layer_span >= 1:  → partial slice
else:                  → horizontal module
```

This is deliberately simple. It uses two existing datasets (community assignments from 9.1, layer
assignments from 5.1a) and requires no new extraction.

### Visualization synergy

In the HTML report:
- **Layers view:** Horizontal bands (already implemented)
- **Communities view:** Colour-coded clusters (already implemented)
- **Slices view (new):** Layers as horizontal bands + communities as vertical columns overlaid.
  Clicking a community highlights its vertical slice. Files not in the selected community dim.

This creates an **architecture crosshair** — you can select a layer to see what's at that tier,
or select a community to see what files form that feature, with the intersection showing exactly
which file serves which feature at which tier.

## 7. Diagram Validation

**Key insight:** Many teams have architecture diagrams (in docs, wikis, whiteboards) but no
mechanism to verify that the code conforms. CARI's pipeline diagram in the CARI spec is a perfect
example — it shows `AX → Annotate → Writer`, but nothing validates that the import graph actually
reflects these flows.

### Diagram-as-config

The `.iw/architecture.yaml` format captures the documented architecture as a machine-readable
config:

- **Components:** Named groups of files (defined by glob patterns)
- **Flows:** Directed edges between components (intended dependencies)
- **Constraints:** Forbidden dependencies (intentional architectural boundaries)

CARI validates the actual import graph against this config:
- **Expected flow present?** Check if any file in component A imports any file in component B
- **Unexpected flow detected?** Check for imports between components that have no declared flow
- **Constraint violated?** Check for imports that cross forbidden boundaries

### The capstone role

Diagram validation is the capstone of the architecture analysis suite because it closes the loop:

```
┌──────────────────────────────────────────────────────────────────┐
│  Documentation  ──[diagram-as-config]──►  .iw/architecture.yaml │
│        ▲                                          │              │
│        │                                          ▼              │
│        │                                  CARI validation        │
│        │                                          │              │
│   Update docs  ◄──[findings report]──── Violations / gaps       │
└──────────────────────────────────────────────────────────────────┘
```

The developer documents intent → CARI compares to reality → findings feed back into documentation
updates. This is the same feedback loop as CI drift detection (`cari_check`) but at the
architectural level rather than the file level.

## 8. Data Reuse — No New Extraction

A critical design principle: **all four features (5.5–5.8) operate on data CARI already
collects.** No new extraction stages are needed.

| Feature                  | Data source                                                |
|--------------------------|------------------------------------------------------------|
| 5.5 Sub-layering         | `imports` table (same as 5.1a), `files.filePath` for packages |
| 5.6 As-is vs. as-should  | `layersInfer()` output + `.iw/layers.yaml`                 |
| 5.7 Vertical slices       | `communities()` output + `layersInfer()` output            |
| 5.8 Diagram validation    | `imports` table + `.iw/architecture.yaml` (new config)     |

The only new inputs are two optional config files (`.iw/layers.yaml` for 5.6,
`.iw/architecture.yaml` for 5.8). Everything else comes from the existing index.

This means:
- **Zero additional cost** — no LLM calls, no new AST stages
- **Same incremental model** — if the index is up to date, all queries are instant
- **Composable** — features can be used independently or combined in the HTML report

## 9. Interaction Model

### CLI surface

```bash
# Hierarchical sub-layers (5.5)
iw index layers-infer --hierarchical
iw index layers-infer --scope packages/analyzer

# As-is vs. as-should comparison (5.6)
iw index layers-check --compare
iw index layers-check --compare --config .iw/layers-should.yaml

# Vertical slices (5.7)
iw index slices
iw index slices --min-span 3

# Diagram validation (5.8)
iw index arch-check --config .iw/architecture.yaml
iw index arch-check --strict   # fail on any undocumented flow
```

### MCP tools

| Tool                  | Feature | New params                              |
|-----------------------|---------|-----------------------------------------|
| `cari_layers_infer`   | 5.5     | `hierarchical?: boolean`, `scope?: string` |
| `cari_layers_check`   | 5.6     | `compare?: boolean`                     |
| `cari_slices`         | 5.7     | `minSpan?: number`                      |
| `cari_arch_check`     | 5.8     | `config?: string`, `strict?: boolean`   |

### HTML report views

The existing three views (layers, communities, dependencies) are extended:

1. **Layers view:** Optionally shows nested sub-bands for hierarchical mode
2. **Comparison view (new):** Two-tone bands showing inferred vs. config layers
3. **Slices view (new):** Layer bands + community columns as vertical overlays
4. **Validation view (new):** Component groups with flow arrows; violations highlighted red

All four views use the same D3 force simulation, just with different layout constraints and
colouring.

## 10. Open Questions

1. **Package detection heuristic.** For non-pnpm workspaces, how to detect package boundaries?
   Options: `package.json` presence, configurable directory depth, or explicit config.

2. **Sub-layer threshold (N).** Default 10 files, but should this be configurable? Too low
   creates noise; too high misses important internal structure.

3. **Vertical slice naming.** Communities are auto-labelled by directory prefix frequency. For
   slices, should the name reflect the feature or the community? Or both?

4. **Config format convergence.** Currently three config files: `.iw/layers.yaml` (5.1b),
   `.iw/architecture.yaml` (5.8), and `.iw/index.yaml` (general). Should these merge into one?

5. **Mermaid export.** Should `arch-check` support generating a Mermaid diagram from the config,
   showing violations as red edges? Useful for embedding in PRs and docs.

6. **Incremental slice detection.** When a file changes, do we need to recompute all communities
   to update slices? Or can we do local updates?

---

_This document is companion to [BACKLOG.md](BACKLOG.md) items 5.5–5.8 and extends the architectural
analysis vision from [CODE-AWARE-RETRIEVAL-INDEX.md](CODE-AWARE-RETRIEVAL-INDEX.md) §5.4 and
[LAYERED-GRAPH-ARCHITECTURE.md](LAYERED-GRAPH-ARCHITECTURE.md) §3._
