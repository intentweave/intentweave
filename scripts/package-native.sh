#!/usr/bin/env bash
# scripts/package-native.sh
#
# Build the cari-build binary for the current platform and copy it into the
# matching platform-specific npm package directory (packages/cari-native-{os}-{arch}/).
#
# Used in CI before `pnpm publish` to populate the binary that gets shipped.
# Also useful locally when you want to test the npm resolution path.
#
# Usage:
#   ./scripts/package-native.sh              # release build (default)
#   ./scripts/package-native.sh --debug      # debug build
#
# After running, commit the binary OR publish the platform package to npm:
#   pnpm --filter @intentweave/cari-native-darwin-arm64 publish

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Parse args ────────────────────────────────────────────────────────────────
PROFILE="release"
CARGO_FLAGS="--release"
for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE="debug"; CARGO_FLAGS="" ;;
  esac
done

# ── Detect platform ───────────────────────────────────────────────────────────
OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  Darwin) NPM_OS="darwin" ;;
  Linux)  NPM_OS="linux"  ;;
  MINGW*|MSYS*|CYGWIN*) NPM_OS="win32" ;;
  *) echo "error: unsupported OS: $OS_RAW" >&2; exit 1 ;;
esac

case "$ARCH_RAW" in
  arm64|aarch64) NPM_ARCH="arm64" ;;
  x86_64)        NPM_ARCH="x64"   ;;
  *) echo "error: unsupported arch: $ARCH_RAW" >&2; exit 1 ;;
esac

PKG_NAME="cari-native-${NPM_OS}-${NPM_ARCH}"
PKG_DIR="$REPO_ROOT/packages/$PKG_NAME"
BIN_NAME="cari-build"
[ "$NPM_OS" = "win32" ] && BIN_NAME="cari-build.exe"

echo "==> Building $BIN_NAME for ${NPM_OS}-${NPM_ARCH} ($PROFILE)"

# ── Build ─────────────────────────────────────────────────────────────────────
# shellcheck source=/dev/null
source "$HOME/.cargo/env" 2>/dev/null || true

cd "$REPO_ROOT/packages/cari-native"
# shellcheck disable=SC2086
cargo build $CARGO_FLAGS

BIN_SRC="$REPO_ROOT/packages/cari-native/target/${PROFILE}/${BIN_NAME}"
BIN_DST="$PKG_DIR/bin/${BIN_NAME}"

if [ ! -f "$BIN_SRC" ]; then
  echo "error: build succeeded but binary not found at $BIN_SRC" >&2
  exit 1
fi

# ── Copy ──────────────────────────────────────────────────────────────────────
mkdir -p "$PKG_DIR/bin"
cp "$BIN_SRC" "$BIN_DST"
chmod +x "$BIN_DST"

echo "==> Copied binary → $BIN_DST"
echo "==> Done.  To publish: pnpm --filter @intentweave/$PKG_NAME publish"
