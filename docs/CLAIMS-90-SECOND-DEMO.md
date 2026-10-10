# Claims in 90 Seconds

This self-checking workflow demonstrates the deterministic Claims lifecycle
without an API key or network access:

```text
CARI build
-> Candidate discovery
-> human review
-> Explain
-> value change
-> --since impact
-> Reopen
```

Run it from the IntentWeave repository root:

```bash
./scripts/claims-90-second-demo.sh
```

The script creates a temporary Git repository containing one explicitly bound
`session.timeout` parameter. It builds a local CARI index, runs `iw claims check`,
shows the Candidate, records an accepted review, and explains the Claim. It then
changes the value from `1800` to `3600`, commits the change, runs
`iw claims check --since HEAD~1`, and explains the resulting material-change
reopen.

The demo is deliberately model-free. It does not use `.iw/claims/inference.yaml`,
`--semantic`, OpenAI, or any other provider. Its temporary repository and SQLite
index are removed automatically when the script exits.

Expected signals:

- the initial check exits with the review-required status after discovering the
  bound Claim;
- Explain shows the Claim, assessment dependencies, review, and Origin;
- the changed check exits with the contested status because the retained JSDoc
  `@default 1800` now contradicts the implementation value `3600`;
- the changed check creates a new material Assessment and leaves the prior review
  invalidated by an open `material-change` reopen;
- the final Explain output shows the reopen dependency and provenance.

The script asserts these exit codes, Assessment states, and the final open
Reopen. It exits non-zero when the lifecycle behavior regresses. The name is a
usability target rather than a hard timing assertion, so slower CI machines do
not fail solely because they exceed 90 seconds.

The script uses `iw.sh` from the current checkout, so it exercises the same
working-tree CLI that is being developed. A production installation can use the
same command sequence with `iw` after replacing the wrapper path.
