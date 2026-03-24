// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * TCG (Temporal Change Graph) — Phase B
 *
 * Pipeline: TCX (commits) → COC (co-change) → HOT (hotspots) → OWN (ownership) → STL (staleness)
 *
 * Exports the five pipeline stages and the git log parser.
 */

// Git log parser
export { parseGitLog, parseGitLogOutput } from "./gitLogParser.js";
export type { GitLogOptions } from "./gitLogParser.js";

// TCX stage (commit extraction)
export { runTcxStage } from "./tcxStage.js";

// COC stage (co-change analysis)
export { runCocStage } from "./cocStage.js";

// HOT stage (hotspot detection)
export { runHotStage } from "./hotStage.js";

// OWN stage (ownership mapping)
export { runOwnStage } from "./ownStage.js";

// STL stage (staleness detection)
export { runStlStage } from "./stlStage.js";
