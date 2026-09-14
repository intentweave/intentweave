#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IW="${ROOT_DIR}/iw.sh"
DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/intentweave-claims-demo.XXXXXX")"
STARTED_AT="$(date +%s)"
export NODE_NO_WARNINGS=1

cleanup() {
  rm -rf "${DEMO_DIR}"
}
trap cleanup EXIT

say() {
  printf '\n== %s ==\n' "$1"
}

run_claims_check() {
  local output_path="$1"
  shift
  local exit_code
  set +e
  (cd "${DEMO_DIR}" && "${IW}" claims check "$@") >"${output_path}" 2>/dev/null
  exit_code=$?
  set -e
  printf '%s' "${exit_code}"
}

mkdir -p "${DEMO_DIR}/src" "${DEMO_DIR}/docs" "${DEMO_DIR}/.iw"

cat >"${DEMO_DIR}/intentweave.bindings.yaml" <<'YAML'
parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/session.ts
        export: SESSION_TIMEOUT
YAML

cat >"${DEMO_DIR}/src/session.ts" <<'TS'
/**
 * @default 1800
 */
export const SESSION_TIMEOUT = 1800;
TS

cat >"${DEMO_DIR}/docs/README.md" <<'MD'
# Claims Demo

This repository contains one explicitly bound session timeout.
MD

cat >"${DEMO_DIR}/.gitignore" <<'EOF'
.iw/index.db
.iw/index.db-*
EOF

git -C "${DEMO_DIR}" init -q
git -C "${DEMO_DIR}" config user.email "claims-demo@example.test"
git -C "${DEMO_DIR}" config user.name "IntentWeave Claims Demo"
git -C "${DEMO_DIR}" add .
git -C "${DEMO_DIR}" commit -qm "baseline session timeout"

say "1/6 Build deterministic CARI evidence"
(cd "${DEMO_DIR}" && "${IW}" index build --no-native --depth structured >/dev/null)
printf 'Index: %s\n' "${DEMO_DIR}/.iw/index.db"

say "2/6 Discover and evaluate the bound Claim"
INITIAL_JSON="${DEMO_DIR}/initial-check.json"
INITIAL_EXIT="$(run_claims_check "${INITIAL_JSON}" --format json)"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({
    gateStatus: value.gateStatus,
    claims: value.claims,
    candidates: value.candidates,
  }, null, 2));
' "${INITIAL_JSON}"
printf 'Initial claims exit: %s (review required is expected)\n' "${INITIAL_EXIT}"

say "3/6 Inspect Candidate governance"
(cd "${DEMO_DIR}" && "${IW}" claims candidates list --all --format json) |
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const candidates = value.candidates ?? value;
      console.log(JSON.stringify(candidates.map((candidate) => ({
        identityKey: candidate.identityKey,
        state: candidate.state,
        claimType: candidate.proposedClaimType,
      })), null, 2));
    });
  '

say "4/6 Record the human decision and explain the Claim"
(cd "${DEMO_DIR}" && "${IW}" claims review \
  --claim session.timeout \
  --type CLM-DEFAULT \
  --actor demo-reviewer \
  --decision accepted \
  --format text)
(cd "${DEMO_DIR}" && "${IW}" claims explain \
  --claim session.timeout \
  --type CLM-DEFAULT \
  --format text)

say "5/6 Change the value and run merge-base impact"
perl -0pi -e 's/SESSION_TIMEOUT = 1800/SESSION_TIMEOUT = 3600/' \
  "${DEMO_DIR}/src/session.ts"
git -C "${DEMO_DIR}" add src/session.ts
git -C "${DEMO_DIR}" commit -qm "change session timeout"
CHANGED_JSON="${DEMO_DIR}/changed-check.json"
CHANGED_EXIT="$(run_claims_check "${CHANGED_JSON}" --since HEAD~1 --format json)"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify({
    claims: value.claims,
    retiredClaims: value.retiredClaims,
  }, null, 2));
' "${CHANGED_JSON}"
printf 'Changed claims exit: %s (an open review/reopen is expected)\n' "${CHANGED_EXIT}"

say "6/6 Explain the reopened lifecycle"
(cd "${DEMO_DIR}" && "${IW}" claims explain \
  --claim session.timeout \
  --type CLM-DEFAULT \
  --format text)

ELAPSED="$(( $(date +%s) - STARTED_AT ))"
printf '\nDemo completed in %ss. Temporary workspace was removed.\n' "${ELAPSED}"
