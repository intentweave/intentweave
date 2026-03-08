// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile converter utilities
 *
 * Converts between @intentweave/profiles registry Profile format
 * and @intentweave/analyzer pipeline Profile format.
 *
 * This lives in analyzer (not profiles) to avoid circular dependencies.
 */

import type { Profile as RegistryProfile } from "@intentweave/profiles";
import type { Profile as AnalyzerProfile } from "./context.js";

/**
 * Convert a profiles registry Profile to analyzer Profile.
 *
 * This is the canonical converter - all code (CLI, server, etc.) should
 * use this instead of implementing their own conversion.
 *
 * @param registryProfile - A resolved profile from profileRegistry.resolve()
 * @returns Profile compatible with @intentweave/analyzer runPipeline()
 * @throws Error if registryProfile is null
 */
export function convertProfileForAnalyzer(
  registryProfile: RegistryProfile | null,
): AnalyzerProfile {
  if (!registryProfile) {
    throw new Error("Profile not found");
  }

  return {
    name: registryProfile.name,
    version: registryProfile.version,
    kinds: registryProfile.entityTypes.map((et) => String(et)),
    predicates: ["relatedTo", "contains", "uses", "creates", "updates"],
    shapes: [],
    artifactMappings: [],
    confidenceThreshold: 0.5,
  };
}
