# Planpling Golden Example

This directory contains the golden test fixture for validating IntentWeave's file-based pipeline using the planpling IAM example.

## Purpose

- **Regression testing**: Ensure pipeline outputs remain stable across refactors
- **Format validation**: Verify all outputs conform to schema contracts
- **Documentation**: Provide concrete example of expected pipeline behavior
- **Server compatibility**: Golden outputs used to test server import capabilities

## Structure

```
tests/
├── README.md           # This file
├── prompt.md           # User's initial intent
├── spec.md             # Detailed specification
└── expected/           # Golden outputs (checked into git)
    └── .iw/
        └── runs/
            └── planpling-golden/
                ├── run.meta.json
                ├── artifacts/
                │   ├── <prompt-id>/{in,rx,cx,mx,px}.json
                │   └── <spec-id>/{in,rx,cx,mx}.json
                └── aggregate/
                    ├── lx.proposals.json
                    ├── coverage.json
                    └── findings.json
```

## Running the Test

### Manual Smoke Test

From this directory:

```bash
# Clean previous run
rm -rf .iw/

# Initialize workspace
iw init

# Run with planpling profile
iw run ./prompt.md ./spec.md \
      --profile starter,planpling \
      --run-id planpling-golden \
      --verbose

# Verify outputs exist
ls .iw/runs/planpling-golden/
```

### Automated Script

From repo root:

```bash
bash scripts/test-planpling-golden.sh
```

## When to Update

Update this fixture when planpling evolves, in this order:

1. **Update input fixtures**: Edit `prompt.md` or `spec.md`
2. **Update profile rules**: Modify shapes/rules if domain changes
3. **Re-run pipeline**: Execute smoke test above
4. **Inspect diffs**:
   - `px.json` (per artifact)
   - `aggregate/lx.proposals.json`
   - `aggregate/coverage.json`
   - `aggregate/findings.json`
5. **Update golden expectations**: Copy new outputs to `expected/` only if changes are intentional

## Golden Contracts

### Filesystem Contract (must exist)
- ✅ `.iw/runs/<runId>/artifacts/<artifactId>/{in,rx,cx,mx,px}.json`
- ✅ `.iw/runs/<runId>/aggregate/{lx.proposals,coverage,findings}.json`
- ✅ `.iw/runs/<runId>/run.meta.json`

### Schema Contract (must exist in each JSON)
- ✅ All files have `schemaVersion`
- ✅ Aggregate files have `$schema` headers
- ✅ Stage outputs have `$schema` (if implemented)

### Semantic Contract (pin minimal set)
- ✅ Expected kinds appear: `planpling:Role`, `planpling:Permission`
- ✅ At least one link proposal exists in `lx.proposals.json`
- ✅ Coverage report generated (even if empty)
- ✅ Findings generated (even if empty)

## CI Integration

This fixture is validated in CI via:
- `.github/workflows/golden-fixture.yml`
- `scripts/validate-golden-diff.js`

Any contract violation causes CI to fail.
