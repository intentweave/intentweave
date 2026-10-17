---
name: iw-living-score
description: "Living Documentation Score (12.3) with CARI. Use when: computing composite documentation health, checking iw verify --score, interpreting the two-dimension score, investigating low dimension scores, using cari_living_score MCP tool, tracking documentation quality over time."
---

# IntentWeave Living Documentation Score

Compute a composite 0–100 score with letter grade (A–F) that measures the health
of a project's living documentation across two dimensions.

## When to Use

- Getting an at-a-glance health score before a release or review
- Tracking documentation quality over time (trend analysis)
- Diagnosing which dimension is dragging the overall score down
- Gating CI pipelines on documentation quality
- Answering "how well does our documentation reflect reality?"

## The Two Dimensions

| Dimension                    | Measures                                               | Requires         |
| ---------------------------- | ------------------------------------------------------ | ---------------- |
| **Doc Freshness**            | % of doc files not stale (git churn vs. doc age)       | `iw index build` |
| **Architecture Conformance** | % of import edges respecting inferred layer boundaries | `iw index build` |

A dimension whose data is missing is excluded from the composite average. The
score is the average of the available dimensions, and at least one must be
available.

The spec-coverage and constraint-consistency dimensions were removed with the
knowledge-graph tables (schema 22). The score was already computed from these two
dimensions on every index without a knowledge graph.

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

# Exit codes:  0 = grade A/B,  1 = grade C,  2 = grade D/F
```

`iw verify` without flags prints the same score. `--score` is kept for scripts and
the Doc Health action.

### Prerequisites

```bash
# For Doc Freshness + Architecture Conformance:
iw index build
```

## MCP Tool

```
cari_living_score
```

**Parameters:**

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
| Doc Freshness            | 96%   | 1 stale doc out of 27 total                                            | ✓         |
| Architecture Conformance | 88%   | 53 layer violations across 458 import edges (0 reverse, 53 skip-layer) | ✓         |
```

## Interpreting Each Dimension

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

| Symptom                       | Cause                                    | Fix                                                             |
| ----------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| All dimensions N/A            | Index not built                          | `iw index build`                                                |
| Arch Conformance N/A          | No relative imports resolved             | Check that source files use relative imports                    |
| Score 100 but docs feel stale | `is_doc` flag not set                    | Confirm docs/ files are picked up: `iw index build -v`          |
| Very low Arch Conformance     | Auto-inferred layers don't match reality | Tune with `iw index layers-infer > .iw/layers.yaml` then re-run |
