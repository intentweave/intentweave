Priority plan across all adaptive options, with my preferred rollout order:

**Priority Order**

1. Option 2: Repo-shape adaptation
2. Option 3: Anchor-aware adaptation
3. Option 1: Light intent adaptation
4. Option 4: Section confidence adaptation
5. Option 5: Feedback loop adaptation

**Why this order**

- 2 + 3 give the highest immediate precision gains with low risk.
- 1 is useful, but should start minimal to avoid brittle query classification.
- 4 improves output quality polish after ranking is stable.
- 5 is powerful but introduces persistence/behavior drift complexity, so best last.

**Implementation Plan**

1. Phase A: Baseline and Guardrails (quick)

- Add evaluation set of 20–30 representative queries per repo type (code-heavy, docs-heavy, mixed).
  - Storage: `.iw/eval/<repo-type>/queries.json` — array of `{query, intent, expected_files[], anchor_files[]}`
  - Format: JSON array with minimal metadata; human-curated per-repo
  - Run: `iw index eval` CLI command (dry-run, shows metrics without persisting scores)
- Define target metrics with concrete targets:
  - **top-10 code relevance**: ≥75% of top-10 results are files a developer would open for the query task (subjective eval, but consistent)
  - **anchor-file neighborhood hit rate**: ≥60% of queries with provided anchors return ≥1 file from same folder/package as anchor in top-5
  - **noisy-path share in top-20**: ≤15% of top-20 results from meta paths (`.changeset/`, `.specstory/`, docs/archive/, etc.)
  - **latency SLOs (steady-state)**: `p50 < 0.8s`, `p95 < 1.5s` on both backstage and codegraphchat-v2
  - **latency SLOs (cold-start tolerance)**: first query may exceed steady-state; require `max < 4.0s`
- **Deterministic mode flag**: `--adaptive=off` (CLI/MCP input) disables all adaptive scoring, returns raw FTS ranked results. Fallback behavior: skip all boost/decay, return uniform section mix.
- Baselines are enforced as non-regression guardrails from the pre-implementation evaluation section below.

2. Phase B: Option 2 (Repo-shape adaptation)

- **Algorithm for path priors**:
  - Precompute per-directory annotation density with SQL aggregation:
    - `SELECT dir, COUNT(*) AS ann, COUNT(DISTINCT symbol_id) AS syms, CAST(COUNT(*) AS REAL) / NULLIF(COUNT(DISTINCT symbol_id), 0) AS ann_per_sym FROM annotations GROUP BY dir`
  - Normalize density to `[0, 1]` for scoring (`densityNorm = min(1.0, ann_per_sym / 50.0)`)
  - If `densityNorm < 0.5`: mark as "low-signal" (meta/config/build directories)
  - If directory name matches regex `(archive|deprecated|legacy|backup|\.changeset|\.claude|\.specstory|node_modules|dist|build)`: mark as "meta"
  - Apply **downweight multipliers** (not boosts): low-signal paths get `0.2×`, meta paths get `0.05×`
- **Allowlist overrides** (optional, in `.iw/config.yaml`):
  ```yaml
  adaptive:
    path_exceptions:
      - path: docs/decisions/
        multiplier: 1.2
      - path: packages/core-api/README
        multiplier: 1.5
  ```

  - Allowlist takes precedence; guards important docs paths from over-penalization
- **Code touch points**:
  - `packages/index/src/queries/retrieve.ts`: scoring aggregation loop (`addFileScore` and final score assembly) — add path prior multiplication
  - `packages/index/src/types.ts`: add `pathPriors?: Map<string, number>` to `ContextPackInput`
  - `packages/index/src/queries/contextPack.ts`: compute priors from `.iw/config.yaml` allowlist + density heuristics
- **Validation**: Run `iw index eval` before/after on backstage/codegraphchat-v2; target: noisy-path share ≤15%, top-10 relevance ≥75%

3. Phase C: Option 3 (Anchor-aware adaptation)

- **Neighborhood definition**:
  - Exact anchor: `1.5×` boost (always returned if match exists)
  - Same folder (e.g., `packages/catalog-backend/`): `1.2×` boost if any anchor is in that folder
  - Same monorepo package (same `packages/*/`): `1.1×` boost
  - File import-neighbor (1-hop in `imports` table): `1.05×` boost
  - Symbol call-neighbor (1-hop in `symbol_calls` table, optional additional signal): `1.03×` boost
- **Distance-based decay formula**: For non-anchor files, apply decay by minimum hop count:
  - 0 hops (exact anchor): no decay (1.0×)
  - 1 hop (import-neighbor): `0.95×` of boost
  - 2+ hops: `0.85×` of boost
  - Unrelated files: no boost, compete on FTS rank
- **Code touch points**:
  - `packages/index/src/queries/retrieve.ts`: anchor neighborhood and neighbor-score composition
  - `packages/index/src/types.ts`: add `anchorFiles?: string[]` to `ContextPackInput`
  - Query `imports` table directly for file-level 1-hop neighbors (do not route via `packages/index/src/queries/imports.ts`, which is for circular-import analysis)
  - Query `symbol_calls` table directly only for optional symbol-level neighbor signal
- **Validation**: Run queries with anchors (e.g., "current task in auth.ts"); target: anchor-file neighborhood hit rate ≥60% in top-5

4. Phase D: Option 1 (Light intent adaptation)

- **Deterministic intent classifier** (keyword/token matching, no LLM):
  - **code-task** (default): query contains code identifiers (e.g., `auth.ts`, `loginUser()`, CamelCase symbols, or imports like `@org/pkg`)
  - **architecture/rules**: query mentions patterns like "decision", "ADR", "pattern", "constraint", "layer", "boundary", "design"
  - **docs/process**: query mentions "guide", "tutorial", "workflow", "setup", "deploy", "troubleshoot"
  - Matching: case-insensitive substring or regex match against known glossary. First match wins (priority: code-task > architecture > docs).
  - **Fallback confidence**: If no match or low-signal query (e.g., "?" or very short), use neutral confidence = 0.5 (no section mix adjustment)
- **Intent → section mix mapping** (applied if confidence > 0.5):

  | Intent             | Files % | Symbols % | Rules % | Connections % | Rationale % |
  | ------------------ | ------- | --------- | ------- | ------------- | ----------- |
  | code-task          | 60      | 25        | 5       | 8             | 2           |
  | architecture/rules | 20      | 10        | 50      | 15            | 5           |
  | docs/process       | 40      | 5         | 10      | 5             | 40          |
  | neutral (default)  | 50      | 15        | 15      | 12            | 8           |

- **Code touch points**:
  - `packages/index/src/queries/contextPack.ts`: add `classifyIntent(query: string)` function (deterministic, <5ms)
  - `packages/index/src/types.ts`: add `intentMode?: 'code-task' | 'architecture/rules' | 'docs/process'` to `ContextPackInput`
  - Update section allocation logic to check confidence > 0.5 before applying mix
- **Confidence threshold**: 0.5 is hard minimum; fallback to neutral (no intent boost) if unmatched

5. Phase E: Option 4 (Section confidence adaptation)

- **Per-section confidence formulas**:
  - **Files confidence**: `min(1.0, matched_annotations / max(1, query_tokens))` — fraction of query tokens with matching code/doc annotations, capped to `[0,1]`. High = >0.7, Med = 0.4–0.7, Low = <0.4
  - **Symbols confidence**: `(found_symbols / total_symbols_in_top_files)` — what % of code symbols in top result files are actually referenced by query. High = >0.6, Med = 0.3–0.6, Low = <0.3
  - **Rules confidence**: `has_conformance_data ? 0.8 : 0.2` — if conformance_snapshots exist for repo, high; else low (no rule data)
  - **Connections confidence**: `entity_co_occurrence_frequency / max_possible` — how often are top entities mentioned together in docs or imported together. High = >0.5, Med = 0.2–0.5, Low = <0.2
  - **Rationale confidence**: `(found_rationale_markers / top_files)` — % of top files containing WHY/NOTE/IMPORTANT markers. High = >0.3, Med = 0.1–0.3, Low = <0.1
- **Thresholds for action**:
  - Low confidence (<0.3): 50% section budget (skip if >1 high-conf section exists)
  - Med confidence (0.3–0.7): 100% section budget
  - High confidence (>0.7): 150% section budget (expand result set)
- **Best entity selection for Connections**:
  - Instead of first symbol in top file, rank all symbols in top-5 files by `co_occurrence_score + query_mention_frequency`
  - Pick top-3 entities; seed Connections expansion from those
- **Code touch points**:
  - `packages/index/src/queries/contextPack.ts`: add `computeSectionConfidence(section: string, ...)` function
  - Update per-section `trimToChars(...)` budgets in `contextPackFromDb` (files/symbols/rules/connections/rationale/drift) to scale by confidence tiers

6. Phase F: Option 5 (Feedback loop)

- **Cache schema** (`.iw/adaptive-cache.json`, repo-scoped to workspace root):
  ```json
  {
    "version": 1,
    "lastReset": "2026-06-21T10:30:00Z",
    "pathBoosts": {
      "packages/auth/": {
        "boost": 1.15,
        "hits": 8,
        "lastSeen": "2026-06-21T10:25:00Z"
      },
      "docs/decisions/": {
        "boost": 1.05,
        "hits": 3,
        "lastSeen": "2026-06-21T10:20:00Z"
      }
    },
    "entityBoosts": {
      "AuthService": {
        "boost": 1.2,
        "hits": 12,
        "lastSeen": "2026-06-21T10:18:00Z"
      }
    },
    "queryPatterns": {
      "auth": { "count": 5, "typical_intent": "code-task" },
      "architecture": { "count": 2, "typical_intent": "architecture/rules" }
    }
  }
  ```
- **Decay and adjustment rules**:
  - Each file/entity used (clicked/accepted by user) increments `hits` and updates `lastSeen`
  - Boost multiplier: `1.0 + (hits / max_hits_cap) × 0.3`, capped at `1.5×` (max boost = +50%)
  - Decay: every 7 days without use, boost multiplies by `0.95^(days_unused / 7)` (half-life: ~47 days)
  - Reset triggers:
    - Manual: `iw index adaptive-reset` command
    - Automatic: `iw index build` with `--no-adaptive-carryover` flag (full rebuild resets cache)
    - TTL: entries older than 90 days automatically expire
- **Monorepo scope boundary**:
  - Workspace root (where `.iw/` lives) is the scope; monorepo packages share one cache
  - If multi-root workspace: each root has own cache
- **Code touch points**:
  - `packages/index/src/queries/contextPack.ts`: load `.iw/adaptive-cache.json` on first call; call `updateAdaptiveCache()` after user feedback (MCP tool)
  - New CLI: `iw index adaptive-reset`, `iw index adaptive-stats`
  - MCP tool: `cari_feedback` — record file as used/skipped

7. Phase G: Rollout strategy

- **Feature flag modes** (input `--adaptive=<mode>` or `adaptive` in `.iw/config.yaml`):

  | Mode           | Phase B (repo-shape) | Phase C (anchor) | Phase D (intent) | Phase E (confidence) | Phase F (feedback) | Default threshold |
  | -------------- | -------------------- | ---------------- | ---------------- | -------------------- | ------------------ | ----------------- |
  | `off`          | ✗                    | ✗                | ✗                | ✗                    | ✗                  | Raw FTS rank only |
  | `conservative` | ✓ (priors only)      | ✓                | ✗                | ✓ (med/high only)    | ✗                  | Confidence >0.4   |
  | `aggressive`   | ✓ (with exceptions)  | ✓ (with decay)   | ✓                | ✓ (all tiers)        | ✓                  | Confidence >0.2   |

- **Explain/debug output** (`--adaptive-explain` flag or `explain: true` in input):
  - Per result file, append comment showing boosts and rank delta:
    ```markdown
    ## Analysis

    - Rank delta: +2 (FTS rank 12 → display rank 10)
    - Boosts applied: path-prior (0.2×) + anchor-neighborhood (1.2×) + feedback (1.08×)
    - Final score: 42.5
    ```
  - Per section, show confidence + budget applied:
    ```
    Files: 60 results (confidence: 0.65, budget: 100%)
    Rules: skipped (confidence: 0.2, budget: 50% < threshold)
    ```
- **Rollout process**:
  1. Ship Phase B–C with `--adaptive=conservative` (default in config)
  2. Run on backstage + codegraphchat-v2 for 2 weeks; collect metrics
  3. If top-10 relevance >75% + latency SLOs pass (`p50 < 0.8s`, `p95 < 1.5s`), promote conservative to default
  4. Phase D–E opt-in to conservative (flag: `--adaptive=conservative:with-intent`)
  5. After 1 month of Phase F feedback collection, enable aggressive mode with manual opt-in
  6. Final: A/B test aggressive vs conservative on 5 real repos; define passing criteria:
     - Top-10 relevance: +3% vs conservative (not -3%)
     - Noisy-path share: no regression vs conservative, and stays ≤15%
     - Anchor neighborhood hit rate: no regression vs conservative, and stays ≥60%
     - Latency: `p50 < 0.8s`, `p95 < 1.5s`, cold-start `max < 4.0s`
     - User feedback: >60% satisfaction on "did this match your intent?"
- **CLI entry points**:
  - `iw index context-pack --adaptive=conservative --adaptive-explain`
  - `iw index context-pack --adaptive=off` (deterministic mode)
  - MCP input: `ContextPackInput` type with `adaptiveMode?: 'off' | 'conservative' | 'aggressive'` and `explainScoring?: boolean`

**Concrete Milestones**

**M1: Option 2 shipped behind conservative mode** (Scope: M)

- Acceptance criteria:
  - Phase A eval set created for backstage, codegraphchat-v2, intentweave
  - Phase B path priors + allowlist implemented and tested
  - `.iw/config.yaml` allowlist parsing works
  - `iw index eval` CLI runs and shows before/after metrics
  - noisy-path share improves vs baseline by repo:
    - backstage: ≤12% (baseline 9.4% + allow small variance)
    - codegraphchat-v2: ≤20% (baseline 25.0%, first-step reduction target)
- Code touch points:
  - `packages/index/src/queries/retrieve.ts` (scoring loop)
  - `packages/index/src/queries/contextPack.ts` (priors loading)
  - `packages/cli/src/commands/indexBuild.ts` (eval subcommand)

**M2: Option 3 added, conservative mode default** (Scope: M)

- Acceptance criteria:
  - Phase C anchor neighborhood + import-neighbor boosting works
  - Validated on anchor-aware queries (e.g., "changes affecting auth.ts")
  - anchor-file neighborhood hit rate ≥50% in top-5
  - noisy-path share reaches global target ≤15% on both backstage and codegraphchat-v2
  - Latency stable (`p50 < 0.8s`, `p95 < 1.5s`, cold-start `max < 4.0s`)
  - `--adaptive=conservative` becomes default in `.iw/config.yaml`
- Code touch points:
  - `packages/index/src/queries/retrieve.ts` (neighborhood scoring)
  - `packages/index/src/types.ts` (`anchorFiles` field)

**M3: Option 1 + 4 integrated with confidence gating** (Scope: L)

- Acceptance criteria:
  - Phase D intent classifier (code-task, architecture, docs) works with 100% deterministic output
  - Phase E confidence formulas tested on 20+ queries across intent types
  - Section budgeting respects confidence tiers (low/med/high)
  - top-10 code relevance ≥75% on eval set
  - No LLM calls or external dependencies in intent path
- Code touch points:
  - `packages/index/src/queries/contextPack.ts` (classifyIntent, confidence formulas)
  - `packages/index/src/types.ts` (intent fields)

**M4: Option 5 optional opt-in learning mode** (Scope: M)

- Acceptance criteria:
  - `.iw/adaptive-cache.json` schema and decay logic implemented
  - `iw index adaptive-reset` and `iw index adaptive-stats` commands work
  - MCP `cari_feedback` tool persists user feedback to cache
  - Decay formula tested (verify 7-day half-life behavior)
  - Cache does not impact latency (async update)
- Code touch points:
  - `packages/index/src/queries/contextPack.ts` (cache load/update)
  - `packages/cli/src/commands/indexBuild.ts` (adaptive-reset, adaptive-stats subcommands)

**M5: Aggressive mode with all options enabled by default** (Scope: S)

- Acceptance criteria:
  - Aggressive mode A/B tested on 5 repos (backstage, codegraphchat-v2, intentweave, planpling, 1 internal)
  - Passing criteria met: top-10 relevance +3%, noisy-path share ≤15%, anchor hit rate ≥60%, latency SLOs pass (`p50 < 0.8s`, `p95 < 1.5s`, cold-start `max < 4.0s`), user satisfaction >60%
  - `--adaptive-explain` flag shows scoring breakdown
  - Documentation updated with mode guidance + examples
  - Rollout decision: if passing, set `aggressive` as new default; else stay conservative
- Code touch points:
  - Phase G mode table integration
  - `packages/cli/src/commands/indexBuild.ts` (mode routing)
  - docs/CLI-USAGE.md (new modes section)

**Pre-Implementation Evaluation Results (2026-06-21)**

1. **Annotation density audit per directory** (completed)

- Query used:
  - `SELECT dir, COUNT(*) AS ann, COUNT(DISTINCT symbol_id) AS syms, CAST(COUNT(*) AS REAL)/NULLIF(COUNT(DISTINCT symbol_id),0) AS ann_per_sym FROM annotations GROUP BY dir ORDER BY ann_per_sym DESC`
- Highlights:
  - backstage: `docs` 182.893, `plugins` 111.544, `packages` 57.687, `.changeset` 3.365
  - codegraphchat-v2: `.specstory` 377.534, `docs` 65.326, `packages` 22.598, `src` 18.880
- Interpretation: codegraphchat-v2 has extreme high-density noise concentration in `.specstory`; repo-shape penalties are required.

2. **Current noisy-path share baseline** (completed, top-20 across 10 representative queries)

- backstage: `9.4%` (18/192)
- codegraphchat-v2: `25.0%` (50/200)
- Worst-case query shares:
  - backstage: `35%` (`catalog plugin architecture`)
  - codegraphchat-v2: `65%` (`context-pack ranking noise`)
- Interpretation: target `≤15%` is realistic for backstage baseline, but codegraphchat-v2 requires Phase B improvements before meeting target.

3. **`symbol_calls` population check** (completed)

- `symbol_calls` row counts:
  - backstage: `11,644`
  - codegraphchat-v2: `34,669`
  - intentweave: `12,548`
- Interpretation: symbol-level 1-hop neighbor signals are feasible (table is populated).

4. **Section budget utilization audit** (completed, 10-query average, budget=4000)

- backstage:
  - files: `18.6%` utilization, symbols: `0.0%`, rules: `15.0%`, connections: `0.0%`, rationale: `2.8%`, drift: `0.0%`
- codegraphchat-v2:
  - files: `17.8%` utilization, symbols: `99.1%`, rules: `0.0%`, connections: `9.8%`, rationale: `0.0%`, drift: `0.0%`
- Interpretation: budget pressure is section-specific (symbols saturated in codegraphchat-v2; most sections under-utilized elsewhere). Confidence adaptation must redistribute budget per section, not globally.

5. **Intent classifier spot-check** (completed, 30-query heuristic simulation)

- Accuracy: `93.3%` (28/30)
- Mismatches:
  - `architecture/rules -> neutral`: `context-pack ranking noise`
  - `code-task -> neutral`: `plugin-catalog-backend package internals`
- Interpretation: deterministic classifier is viable, but add terms for `ranking` and `package internals` to reduce neutral fallthrough.

6. **Latency baseline sweep** (completed, 10 representative queries per repo)

- backstage: avg `391ms`, p50 `341ms`, p95 `486ms`, max `617ms`
- codegraphchat-v2: avg `946ms`, p50 `587ms`, p95 `1001ms`, max `3884ms` (cold/outlier run)
- Interpretation: steady-state is sub-second, but rollout criteria must include explicit cold-start tolerance.

**Immediate Execution Checklist (next 1-2 weeks)**

1. **Week 1: Phase B prototype behind flag**

- Add `adaptiveMode` wiring to `ContextPackInput` and CLI/MCP entry points.
- Implement path-prior scoring in `retrieve.ts` with:
  - regex-based meta penalties
  - SQL-derived density-based low-signal penalties
  - allowlist overrides from `.iw/config.yaml`
- Add explain output for per-file applied multipliers.

2. **Week 1: Add reproducible eval harness**

- Create `iw index eval` with:
  - fixed query-set input file support
  - noisy-path share metric
  - latency p50/p95/max metric
  - optional JSON report output for CI (`--output eval-report.json`)

3. **Week 2: Tune multipliers with sensitivity sweep**

- Sweep low-signal multiplier in `{0.1, 0.2, 0.3, 0.5}` and meta multiplier in `{0.01, 0.05, 0.1}`.
- Select pair that maximizes noisy-path reduction on codegraphchat-v2 while preserving backstage relevance.
- Lock chosen defaults in `.iw/config.yaml` docs.

4. **Week 2: Phase C minimal neighbor boost**

- Implement file-level 1-hop import-neighbor boost only (symbol_calls boost stays optional).
- Re-run anchor-hit metric; require ≥50% in top-5 before enabling by default.

5. **Week 2 exit criteria**

- M1 and M2 gates pass with measured report artifacts committed under `.iw/eval/reports/`.
- Conservative mode can be enabled by default only if noisy-path and latency gates pass for both target repos.

**Follow-up Evaluations Still Needed (post-implementation)**

1. **Path-prior sensitivity results**

- Compare top-10 relevance and noisy-path share across multiplier grid.

2. **Anchor-boost ablation study**

- Evaluate exact-anchor-only vs +folder vs +imports to isolate which signal improves anchor hit rate most.

3. **Explainability quality audit**

- Manually review 20 outputs to ensure boost reasons are understandable and not misleading.

4. **Cold-start latency repeatability**

- Run 30-query latency sweeps on codegraphchat-v2 across fresh process starts to verify `max < 4.0s` is stable.

5. **Intent dictionary refinement**

- Re-run 30-query classifier spot-check after adding terms (`ranking`, `internals`, `module`) and verify improved neutral fallthrough.
