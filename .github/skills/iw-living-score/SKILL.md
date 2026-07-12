---
name: iw-living-score
description: "Living Documentation Score (12.3) with CARI. Use when: computing composite documentation health, checking iw verify --score, interpreting the 4-dimension score, investigating low dimension scores, using cari_living_score MCP tool, tracking documentation quality over time."
---

# IntentWeave Living Documentation Score

Compute a composite 0–100 score with letter grade (A–F) that measures the health
of a project's living documentation across four dimensions.

## When to Use

- Getting an at-a-glance health score before a release or review
- Tracking documentation quality over time (trend analysis)
- Diagnosing which dimension is dragging the overall score down
- Gating CI pipelines on documentation quality
- Answering "how well does our documentation reflect reality?"

## The Four Dimensions

| Dimension                    | Measures                                               | Requires            |
| ---------------------------- | ------------------------------------------------------ | ------------------- |
| **Spec Coverage**            | % of KG entities grounded in code symbols              | `iw run` enrichment |
| **Constraint Consistency**   | % of relationships without contradictions              | `iw run` enrichment |
| **Doc Freshness**            | % of doc files not stale (git churn vs. doc age)       | `iw index build`    |
| **Architecture Conformance** | % of import edges respecting inferred layer boundaries | `iw index build`    |

Dimensions that lack the required data are excluded from the composite average.
The score = average of available dimensions (minimum 1 available required).

### Grade Scale

| Grade | Score | Meaning                                     |
| ----- | ----- | ------------------------------------------- |
| A     | ≥ 90  | Excellent — docs closely track the codebase |
| B     | ≥ 75  | Good — minor gaps                           |
| C     | ≥ 60  | Fair — noticeable drift, investigate        |
| D     | ≥ 45  | Poor — significant documentation debt       |
| F     | < 45  | Critical — docs have diverged from code     |

## CLI Usage

```bash
# Text output (default) — color bars + detail
iw verify --score

# JSON output — for scripts / CI integration
iw verify --score -f json

# Save to file
iw verify --score -f json -o .iw/living-score.json

# With custom confidence threshold (default 0.5)
iw verify --score --min-confidence 0.7

# Allow skip-layer imports without counting as violations
iw verify --score --allow-skip-layer

# Exit codes:  0 = grade A/B,  1 = grade C,  2 = grade D/F
```

### Prerequisites

```bash
# For Doc Freshness + Architecture Conformance:
iw index build

# Spec Coverage + Constraint Consistency require a populated Neo4j knowledge
# graph (kg_entities / kg_relationships tables) — there is currently no CLI
# command to populate one from scratch; see docs/kg/try-it.mdx.
```

## MCP Tool

```
cari_living_score
```

**Parameters:**

- `minConfidence` (number, default 0.5) — min annotation confidence for spec grounding
- `allowSkipLayer` (boolean, default false) — allow skip-layer imports without penalty

**Example Copilot prompts:**

- "What's the living documentation score for this project?"
- "Are our docs healthy? Run cari_living_score."
- "What's dragging down our documentation score?"

**Output format:** Markdown table with score, grade emoji, per-dimension score and detail.

```markdown
## Living Documentation Score: 92/100 (🟢 Grade A)

| Dimension                | Score | Detail                                                                 | Available |
| ------------------------ | ----- | ---------------------------------------------------------------------- | --------- |
| Spec Coverage            | N/A   | No KG entities — requires a populated knowledge graph                  | ✗         |
| Constraint Consistency   | N/A   | No KG relationships — requires a populated knowledge graph             | ✗         |
| Doc Freshness            | 96%   | 1 stale doc out of 27 total                                            | ✓         |
| Architecture Conformance | 88%   | 53 layer violations across 458 import edges (0 reverse, 53 skip-layer) | ✓         |
```

## Interpreting Each Dimension

### Spec Coverage (requires enrichment)

Measures how many knowledge-graph entities can be traced to real code symbols.

- **High (> 80%)** — architecture concepts are well-grounded in code
- **Low (< 60%)** — entities exist in docs but have no matching code; check for renamed symbols
- **N/A** — no knowledge graph populated; see docs/kg/try-it.mdx (query-only
  today, no CLI ingestion path)

Investigation:

```bash
iw verify -v                        # see per-entity grounding detail
iw index retrieve "AuthService"     # check if symbol exists in index
```

### Constraint Consistency (requires enrichment)

Measures how many KG relationships are free of contradictions.

- **High (> 90%)** — specifications are internally consistent
- **Low (< 70%)** — conflicting statements exist; run `iw verify --consistency -v`
- **N/A** — no knowledge graph populated

Investigation:

```bash
iw verify --consistency -v          # list all conflicts
iw verify --consistency -f json     # export for review
```

### Doc Freshness

Measures what fraction of documentation files are not stale relative to code churn.

- **High (> 90%)** — docs are up to date
- **Low (< 70%)** — many stale docs; common after large refactors
- Staleness is determined by comparing git-churn history of doc files vs. related code files

Investigation:

```bash
iw doc-health                       # list stale documents with age + drift signals
iw index hotspot-priority           # find high-churn files that lack docs
cari_check --changed src/auth.ts    # which docs reference changed files?
```

### Architecture Conformance

Measures whether import edges respect the inferred architectural layering.

- **High (> 90%)** — code structure matches the inferred layers
- **Low (< 70%)** — significant layering violations; likely architectural debt
- **skip-layer** violations = layer N imports from layer N+2, skipping intermediate
- **reverse** violations = lower layer imports from higher layer

Investigation:

```bash
iw index layers-infer               # see inferred layer assignments
iw index layers-check               # list all violations (requires .iw/layers.yaml)
iw index arch-check --from-scan docs/  # diagram-based validation
```

To reduce skip-layer count:

1. Run `iw index layers-infer` and inspect the output
2. Save to `.iw/layers.yaml` and tune patterns
3. Run `iw index layers-check` for a detailed violation report

## CI Integration

```yaml
# .github/workflows/doc-health.yml
- name: Living Documentation Score
  run: |
    iw index build
    iw verify --score -f json -o .iw/living-score.json
    iw verify --score   # exits 1 for grade C, 2 for D/F
  # Tip: use "continue-on-error: true" for reporting-only mode
```

### Trend Tracking

```bash
# Append score to a history file
iw verify --score -f json | jq '{date: now | todate, score: .score, grade: .grade}' \
  >> .iw/score-history.jsonl
```

## Troubleshooting

| Symptom                       | Cause                                    | Fix                                                                    |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| All dimensions N/A            | Index not built                          | `iw index build`                                                       |
| Arch Conformance N/A          | No relative imports resolved             | Check that source files use relative imports                           |
| Spec Coverage stuck at N/A    | No knowledge graph populated             | See docs/kg/try-it.mdx — requires an existing populated Neo4j instance |
| Score 100 but docs feel stale | `is_doc` flag not set                    | Confirm docs/ files are picked up: `iw index build -v`                 |
| Very low Arch Conformance     | Auto-inferred layers don't match reality | Tune with `iw index layers-infer > .iw/layers.yaml` then re-run        |
