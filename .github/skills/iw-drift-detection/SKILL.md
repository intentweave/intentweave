---
name: iw-drift-detection
description: "Documentation and architecture drift detection with CARI and KG. Use when: checking if docs are stale, finding which docs reference changed code, running doc-health, using cari_check MCP tool, detecting annotation drift, cross-group inconsistency, orphaned sections, or temporal staleness."
---

# IntentWeave Drift Detection

Detect when documentation, architecture diagrams, and code have diverged — at commit time, in CI,
or as an ongoing health check.

## When to Use

- Reviewing a PR: "Which docs reference code I just changed?"
- Release preparation: "Is our documentation still accurate?"
- Ongoing health: "Which docs are most at risk of being stale?"
- After a refactor: identifying documentation that still refers to removed symbols

## Types of Drift

| Type                  | Detector                        | What It Catches                                                 |
| --------------------- | ------------------------------- | --------------------------------------------------------------- |
| **Temporal**          | `cari_check` / `iw index check` | Docs last edited before the code they reference                 |
| **Annotation**        | `cari_check`                    | Doc spans that linked to symbols now changed or deleted         |
| **Cross-group**       | `cari_cross_group_drift`        | Two doc groups describe the same entity with conflicting detail |
| **Orphaned sections** | `cari_orphaned_sections`        | Heading sections where no mentions resolve to real code         |
| **Coverage**          | `cari_module_coverage`          | Directories with low/zero documentation                         |
| **Completeness**      | `cari_doc_completeness`         | Docs about a file that miss exported symbols                    |

---

## Checking Drift for Changed Files

### CLI

```bash
# Check files changed in the current branch
iw index check --changed $(git diff --name-only origin/main...HEAD)

# Check staged files only
iw index check --changed $(git diff --cached --name-only)

# Specific files
iw index check --changed src/auth.ts docs/auth.md

# Exit code: 0 = clean, 1 = drift found
# Output formats: text (default), json, github (PR annotations)
iw index check --changed src/auth.ts -f github
```

### MCP (`cari_check`)

```
Use cari_check with changed=["src/auth.ts", "src/pipeline.ts"] to find docs that need updating.
```

Parameters:

- `changed` — list of file paths changed in the PR/commit
- `severity` — minimum severity to report: `info`, `warning`, `critical`

Output: findings with severity, affected doc, and related code files.

---

## Documentation Health Overview

### Full health dashboard

```bash
iw index report
iw index report -f json | jq '.staleness.topStale[:5]'
```

Shows: coverage %, orphaned sections count, top stale docs, hotspot files.

### Temporal staleness (docs older than the code they reference)

```bash
# Which docs are most behind their referenced code?
iw index report -f json | jq '.staleness.topStale[] | select(.daysBehind > 30)'
```

Severity thresholds: `info` < 30 days, `warning` 30–90 days, `critical` > 90 days.

### Orphaned sections

```bash
iw index orphaned-sections
```

Surfaces doc heading sections where **all** entity mentions are ungrounded — the entire
section likely describes removed or renamed code.

### Documentation coverage per module

```bash
iw index module-coverage
```

Shows coverage % per directory. Useful for finding wholly undocumented packages.

### Per-doc completeness

```bash
iw index doc-completeness
```

For each doc file, shows how many of the exported symbols from referenced files it covers.
A doc about `AuthService` that covers 3/7 public methods scores 43%.

### Cross-group drift

```bash
iw index cross-group-drift
```

Compares entity coverage across doc groups (API docs vs. architecture docs vs. READMEs).
Flags when the same entity is described with incompatible qualifiers across groups.

---

## Hotspot Priority

Find files that are high-churn AND low-documentation — the highest risk for drift:

```bash
iw index hotspot-priority
iw index hotspot-priority --limit 20
```

Also available as `cari_hotspot_priority` MCP tool.

---

## Investigation Workflow

When `cari_check` or `iw index check` reports drift:

### 1. Identify affected entities

```bash
# Which docs mention the changed file?
iw index retrieve "AuthService" --scope docs

# All annotations for the changed file
iw index annotations-for src/auth/service.ts
```

### 2. Understand connections

```bash
# What's connected to this entity across all layers?
iw index connections "AuthService"
```

### 3. Check if drift is real

Compare annotation confidence: if the annotation linking the doc to the changed symbol
had confidence < 0.4, the connection may be incidental (not a real documentation relationship).

```bash
iw index annotations-for src/auth/service.ts -f json | jq '.[] | select(.confidence > 0.4)'
```

---

## MCP Tools for Drift Detection

### `cari_check`

CI-style drift check for changed files.

```
Use cari_check with changed=["src/auth.ts"] to find documentation that needs updating.
```

### `cari_doc_completeness`

Per-doc completeness scoring.

```
Use cari_doc_completeness to find docs that are missing coverage of exported symbols.
```

### `cari_orphaned_sections`

Doc sections where no mentions resolve to real code.

```
Use cari_orphaned_sections to find documentation about code that no longer exists.
```

### `cari_cross_group_drift`

Inconsistencies between different documentation groups.

```
Use cari_cross_group_drift to find conflicting descriptions across API docs and architecture docs.
```

### `cari_module_coverage`

Coverage percentage per directory.

```
Use cari_module_coverage to find packages with no documentation.
```

### `cari_hotspot_priority`

High-churn, low-doc files ranked by urgency.

```
Use cari_hotspot_priority to find the files most at risk of being under-documented.
```

### `cari_mentions_of`

Find all doc mentions of a specific entity.

```
Use cari_mentions_of with entityId="class.src.auth.AuthService" to find all docs that reference it.
```

### `cari_annotations_for`

All annotations linking a source file to documentation.

```
Use cari_annotations_for with filePath="src/auth/service.ts" to see which docs cover it.
```

---

## CI Integration

### Minimal — drift check on PR

```yaml
name: Documentation Drift
on:
  pull_request:
    branches: [main]

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: actions/cache@v4
        with:
          path: .iw
          key: iw-index-${{ hashFiles('**/*.ts', '**/*.md') }}
          restore-keys: iw-index-

      - name: Build or update index
        run: |
          npx @intentweave/cli init
          npx @intentweave/cli index build --depth structured

      - name: Check drift
        run: |
          CHANGED=$(git diff --name-only origin/${{ github.base_ref }}...HEAD)
          if [ -n "$CHANGED" ]; then
            npx @intentweave/cli index check --changed $CHANGED --format github
          fi
```

### With severity threshold

```bash
# Only fail on critical drift (>90 days stale)
npx @intentweave/cli index check --changed $CHANGED --severity critical -f github
```

### Full quality gate

```yaml
- name: Documentation drift
  run: |
    CHANGED=$(git diff --name-only origin/${{ github.base_ref }}...HEAD)
    npx @intentweave/cli index check --changed $CHANGED -f github

- name: Orphaned sections
  run: npx @intentweave/cli index orphaned-sections -f json

- name: Module coverage regression
  run: npx @intentweave/cli index module-coverage -f json
```

---

## Annotation Confidence Guide

CARI assigns a confidence score to each annotation (doc span → code symbol link):

| Score     | Source                  | Interpretation                                   |
| --------- | ----------------------- | ------------------------------------------------ |
| 0.85–1.0  | Exact symbol name match | Strong — doc explicitly names the symbol         |
| 0.65–0.84 | FTS match + grounded    | Medium — related term, symbol confirmed in index |
| 0.35–0.64 | FTS match only          | Weak — possible reference, not confirmed         |
| 0.2–0.34  | Co-occurrence signal    | Very weak — entities mentioned together          |
| < 0.2     | Below threshold         | Filtered out — not surfaced as drift             |

Annotations below **0.4** are rarely meaningful for drift detection. Use `--severity warning`
or filter by confidence when investigating noisy results.

---

## Troubleshooting

| Symptom                                 | Cause                                     | Fix                                                      |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| `check` reports everything as drifted   | Index built from scratch against old docs | Run `iw index update` incrementally                      |
| High false-positive rate                | Low-confidence annotations                | Filter with `--severity warning` or `critical`           |
| Orphaned sections for valid docs        | Symbol renamed or moved                   | Rebuild index after refactor                             |
| `module-coverage` shows 0% everywhere   | No docs reference code yet                | Run `iw index build --depth full` for body-text matching |
| Cross-group drift shows false conflicts | Doc groups not configured                 | Create `.iw/doc-groups.yaml` to classify properly        |
| `git diff` returns nothing in CI        | Shallow clone                             | Add `fetch-depth: 0` to checkout action                  |
