#!/usr/bin/env bash
# Copyright 2025-2026 Benjamin Becker
# SPDX-License-Identifier: Apache-2.0
#
# Lockstep version bump — sets the same version across all packages and apps.
#
# Usage:
#   ./scripts/bump-version.sh 0.4.0

set -euo pipefail

VERSION="${1:?Usage: bump-version.sh <version>}"

# Validate semver-ish format
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver version" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Bumping all packages to v${VERSION}..."

# Find all package.json files (skip node_modules, dist, .turbo)
find "$ROOT/packages" "$ROOT/apps" -name package.json -not -path '*/node_modules/*' -not -path '*/dist/*' | sort | while read -r pkg; do
  name=$(python3 -c "import json; print(json.load(open('$pkg'))['name'])")
  old=$(python3 -c "import json; print(json.load(open('$pkg'))['version'])")
  python3 -c "
import json, sys
p = json.load(open('$pkg'))
p['version'] = '$VERSION'
json.dump(p, open('$pkg', 'w'), indent=2)
print('')  # trailing newline
" && printf '\n' >> "$pkg"
  echo "  ${name}: ${old} → ${VERSION}"
done

echo ""
echo "Done. Run 'pnpm install' to update the lockfile, then commit."
