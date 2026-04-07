---
name: iw-checks
description: "Run IntentWeave CARI checks locally and set up GitHub Actions CI. Use when: running iw index commands, checking documentation drift, setting up CI drift detection, diagnosing iw failures, adding drift checks to a pipeline, running code quality analysis with CARI."
---

# IntentWeave Checks

Run CARI quality checks locally during development and configure them in CI.

## When to Use

- Before committing, to catch documentation drift
- Setting up or updating GitHub Actions for drift detection
- Running code quality analysis (clones, unused exports, circular imports)
- Diagnosing why an `iw` command failed or returned unexpected results

## Local Development Workflow

### 1. Build the Index

Always build (or update) the index before running checks.

```bash
# First time — full build
iw init
iw index build docs/ packages/ --depth full -v

# Subsequent — incremental update (only changed files)
iw index update -v
```

**Depth modes:**

- `structured` (default): headings, bold, code-spans — fast, baseline coverage
- `full`: adds body text + IDF scoring — +72% annotations, slower

### 2. Pre-Commit Checks

Run these before committing code changes:

```bash
# Check drift for files you changed
iw index check --changed $(git diff --name-only) --format text

# Or for staged files only
iw index check --changed $(git diff --cached --name-only) --format text
```

Exit code 0 = clean, 1 = drift found.

### 3. Code Quality Analysis

Run targeted analysis commands as needed:

```bash
# Code duplication
iw index clones                    # Exact duplicates (same body hash)
iw index structural-clones         # Type-2 clones (same structure, different names)

# Dependencies
iw index circular-imports          # Import cycles
iw index unused-exports            # Dead exports

# Documentation health
iw index report                    # Full corpus health dashboard
iw index hotspot-priority          # High-churn, low-doc files
iw index todos                     # TODO/FIXME/HACK/XXX inventory
iw index module-coverage           # Coverage % per directory
iw index orphaned-sections         # Doc sections referencing no real code
iw index doc-completeness          # Per-doc completeness score
iw index cross-group-drift         # Entity conflicts across doc groups
```

### 4. Investigation Commands

When something looks wrong:

```bash
# What docs mention a symbol?
iw index retrieve "AuthService" --limit 20

# What's connected to an entity across code, docs, and git?
iw index connections "AuthService"

# JSON output for scripting
iw index check --changed src/auth.ts -f json
iw index report -f json
```

## GitHub Actions Setup

### Minimal Workflow

Add to `.github/workflows/doc-drift.yml`:

```yaml
name: Doc Drift Check
on:
  pull_request:
    branches: [main]

jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Build CARI index
        run: |
          npx @intentweave/cli init
          npx @intentweave/cli index build --depth structured

      - name: Check documentation drift
        run: |
          CHANGED=$(git diff --name-only origin/main...HEAD)
          if [ -n "$CHANGED" ]; then
            npx @intentweave/cli index check --changed $CHANGED --format github
          fi
```

`--format github` outputs annotations on the PR diff:

```
::warning file=docs/auth.md::References changed code: AuthService (12 annotations)
```

### With Caching (Recommended)

Cache the `.iw/` directory for faster repeat builds:

```yaml
- uses: actions/cache@v4
  with:
    path: .iw
    key: iw-index-${{ hashFiles('**/*.ts', '**/*.md') }}
    restore-keys: iw-index-

- name: Build or update index
  run: |
    npx @intentweave/cli init
    npx @intentweave/cli index build --depth structured
```

### Full Quality Gate

Add code quality checks alongside drift detection:

```yaml
- name: Check documentation drift
  run: |
    CHANGED=$(git diff --name-only origin/main...HEAD)
    if [ -n "$CHANGED" ]; then
      npx @intentweave/cli index check --changed $CHANGED --format github
    fi

- name: Check circular imports
  run: npx @intentweave/cli index circular-imports -f json

- name: Check unused exports
  run: npx @intentweave/cli index unused-exports --limit 50 -f json
```

### Existing CI Integration

To add drift checking to an existing CI workflow, add these steps after
the checkout and Node.js setup:

```yaml
- name: CARI drift check
  run: |
    npx @intentweave/cli init
    npx @intentweave/cli index build
    npx @intentweave/cli index check \
      --changed $(git diff --name-only origin/main...HEAD) \
      --format github
```

## Troubleshooting

| Symptom                   | Cause                       | Fix                                        |
| ------------------------- | --------------------------- | ------------------------------------------ |
| `No document files found` | Wrong paths or all excluded | Check path arguments and `.iwignore`       |
| `Database not found`      | Index not built             | Run `iw index build` first                 |
| Exit code 1 in CI         | Drift detected (expected)   | Review findings, update docs or suppress   |
| Slow builds               | Full depth on large repo    | Use `--depth structured` or enable caching |
| `git diff` empty          | Shallow clone               | Add `fetch-depth: 0` to checkout           |

## Reference

- [CLI Reference](./references/cli-commands.md) — Full command reference
- [CI Integration](https://intentweave.org/docs/integrations/ci) — Website docs
- [Library API](https://intentweave.org/docs/reference/library-api) — Programmatic usage
