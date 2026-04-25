---
name: iw-arch-analysis
description: "Architecture diagram validation with CARI. Use when: validating that code matches architecture diagrams, checking component grounding in the index, investigating missing flows, using cari_arch_diff/cari_resolve/cari_component_evidence MCP tools, running iw index arch-check or scan-diagrams."
---

# IntentWeave Architecture Analysis

Validate architecture diagrams against actual code and documentation evidence using CARI.

## When to Use

- Checking whether diagram-declared components and flows exist in the codebase
- Investigating why a component shows as "ungrounded" in arch-check output
- Using Copilot to answer "does this diagram reflect reality?"
- Before a release: confirming architecture docs haven't drifted from code

## Two Validation Modes

### Mode A — Entity Evidence (`--from-scan`)

Scans Mermaid/PlantUML diagrams in markdown files via LLM, then checks each component
against CARI annotations and co-occurrences. **No YAML config needed.**

Best for: early-stage projects, docs-first validation, when import paths don't map cleanly to components.

```bash
# Single run (uses smart-mock LLM; real results need --provider openai)
iw index arch-check --from-scan docs/ --provider openai

# Force re-scan (ignore cache)
iw index arch-check --from-scan docs/ --provider openai --refresh

# JSON output (scriptable)
iw index arch-check --from-scan docs/ --provider openai -f json
```

Result includes:

- Per-component grounding (`co_occurrence` / `annotation` / `none`)
- Per-flow status (`confirmed` / `missing`)
- Conformance percentage

### Mode B — Import-Level (`--config` or `.iw/architecture.yaml`)

Validates actual file import edges against a YAML constraint file. More precise but
requires explicit file→component mapping.

```bash
# Auto-discover .iw/architecture.yaml
iw index arch-check

# Explicit config path
iw index arch-check --config .iw/architecture.yaml

# Fail on undocumented flows (for CI enforcement)
iw index arch-check --strict
```

### Mode C — Enriched Diagram Triples (`--from-diagrams`)

Uses KG entities extracted by `iw index enrich` — no LLM call at check time.
Requires prior enrichment.

```bash
iw index enrich --provider openai   # one-time enrichment
iw index arch-check --from-diagrams
```

## Diagram Scan Cache

`--from-scan` caches LLM output to `.iw/arch-scan-cache.json` keyed on SHA-256 of
all scanned file contents. Repeat runs on unchanged docs are instant.

```bash
# Check what's cached
cat .iw/arch-scan-cache.json | jq '.scannedAt, (.result.components | length)'

# Bust cache (re-run LLM)
iw index arch-check --from-scan docs/ --provider openai --refresh
```

Cache is invalidated automatically when any scanned markdown file changes.

## Scan Diagrams Standalone

To extract components and flows without running validation:

```bash
iw index scan-diagrams docs/
iw index scan-diagrams docs/ --provider openai
iw index scan-diagrams docs/ -f json | jq '.components[].name'
```

Useful for: auditing what the LLM extracted, debugging why a component was or wasn't found.

## Interpreting Results

### Component Grounding Status

| Icon | Status          | Meaning                                                  |
| ---- | --------------- | -------------------------------------------------------- |
| ✓    | `annotation`    | Mentioned in docs AND linked to a code symbol            |
| ~    | `co_occurrence` | Entity name appears in co-occurrence table (weak signal) |
| ✗    | `none`          | No evidence in the CARI index — likely a naming mismatch |

### Flow Status

| Icon | Status      | Meaning                                                   |
| ---- | ----------- | --------------------------------------------------------- |
| ✓    | `confirmed` | Co-occurrence or import evidence found for both endpoints |
| ⚠    | `missing`   | Declared flow has no supporting evidence                  |

### What "Ungrounded" Usually Means

1. **Name mismatch** — diagram says "Auth Service" but code has `AuthService`
2. **Index not built** — run `iw index build` first
3. **Doc coverage gap** — component exists in code but isn't mentioned in docs
4. **Diagram-only concept** — high-level label with no code counterpart (normal for vision diagrams)

## Investigating Ungrounded Components

### With CLI

```bash
# Resolve a specific component name to index entries
iw index resolve "Auth Service"

# Check what's connected to it
iw index connections "AuthService"

# Find docs mentioning it
iw index retrieve "AuthService" --scope docs
```

### With MCP (Copilot)

Ask: "Investigate the ungrounded component 'Auth Service'" — Copilot will use:

1. `cari_resolve` — map the component name to code symbols and doc files
2. `cari_component_evidence` — gather all evidence (symbols, docs, connections)
3. `cari_arch_diff` — compare all diagram flows against entity evidence

## MCP Tools Reference

### `cari_arch_diff`

Run a full diagram scan + entity validation in one shot.

```
Use cari_arch_diff with paths=["docs"] and provider="openai" to validate the architecture.
```

Parameters:

- `paths` — directories to scan (default: `["docs"]`)
- `provider` — `openai` or `smart-mock`
- `refresh` — ignore cache

### `cari_resolve`

Ground a component name against the CARI index.

```
Use cari_resolve with name="Authentication" to find matching symbols and docs.
```

Parameters:

- `name` — component name (as it appears in the diagram)
- `limitSymbols` — max code symbols to return (default: 10)
- `limitDocs` — max doc files to return (default: 5)

### `cari_component_evidence`

All evidence layers for one component.

```
Use cari_component_evidence with name="FX Stage" to see symbols, docs, and connections.
```

Parameters:

- `name` — component name
- `limit` — max items per section (default: 10)

### `cari_arch_check`

Import-level validation against `.iw/architecture.yaml`.

```
Use cari_arch_check to validate import boundaries against the architecture config.
```

## Writing `.iw/architecture.yaml`

```yaml
components:
  - name: cli
    files: ["packages/cli/src/**"]
  - name: analyzer
    files: ["packages/analyzer/src/**"]
  - name: index
    files: ["packages/index/src/**"]

flows:
  - from: cli
    to: analyzer
  - from: cli
    to: index

constraints:
  - type: forbidden
    from: index
    to: cli
    reason: "index must not depend on cli"
```

## CI Integration

### Diagram Validation Gate

```yaml
- name: Architecture diagram check
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: |
    npx @intentweave/cli index arch-check \
      --from-scan docs/ \
      --provider openai \
      --strict
```

First run incurs LLM cost; subsequent runs hit cache (fast). Use `--refresh` only when
diagrams change intentionally.

### Import Boundary Gate

```yaml
- name: Architecture import check
  run: npx @intentweave/cli index arch-check --strict
```

## Troubleshooting

| Symptom                                     | Cause                                | Fix                                                         |
| ------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| All components ungrounded                   | Index not built or empty             | Run `iw index build` first                                  |
| "No components found in scanned diagrams"   | No Mermaid/ASCII art found           | Check diagram format; use `iw index scan-diagrams` to debug |
| Same result after doc change                | Stale cache                          | Add `--refresh`                                             |
| `smart-mock` always returns generic results | Default provider                     | Use `--provider openai` for real diagram extraction         |
| High missing-flow rate                      | Entity-level check, not import check | Normal — entity evidence is weaker than imports             |
| `OPENAI_API_KEY` required error             | Missing env var                      | Export `OPENAI_API_KEY` or use `--api-key`                  |
