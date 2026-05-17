// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/cari-native — binary resolver
 *
 * Returns the path to the platform-specific `cari-build` binary installed
 * via the matching `@intentweave/cari-native-{os}-{arch}` optional package.
 *
 * Returns `null` when:
 *  - the current platform has no matching package (unsupported target)
 *  - the optional dependency was not installed (e.g. wrong os/cpu, air-gapped CI)
 *
 * The caller (packages/cli) falls back to the dev-mode target/ binary in that case.
 */

import { platform, arch } from "node:process";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/** Maps `${os}-${arch}` to the npm package name containing the binary. */
const PLATFORM_PACKAGES = {
  "darwin-arm64": "@intentweave/cari-native-darwin-arm64",
  "darwin-x64":   "@intentweave/cari-native-darwin-x64",
  "linux-x64":    "@intentweave/cari-native-linux-x64",
  "linux-arm64":  "@intentweave/cari-native-linux-arm64",
  "win32-x64":    "@intentweave/cari-native-win32-x64",
};

const EXE_SUFFIX = platform === "win32" ? ".exe" : "";

/**
 * Returns the absolute path to the `cari-build` native binary for the
 * current platform, or `null` if the platform-specific package is not
 * installed.
 */
export function getBinaryPath() {
  const key = `${platform}-${arch}`;
  const pkgName = PLATFORM_PACKAGES[key];
  if (!pkgName) return null;
  try {
    return _require.resolve(`${pkgName}/bin/cari-build${EXE_SUFFIX}`);
  } catch {
    return null;
  }
}
