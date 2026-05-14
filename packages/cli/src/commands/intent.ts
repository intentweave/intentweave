// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw intent — Intent Engine namespace (Phase 0 alias layer)
 *
 * This command is a top-level namespace for the Intent Engine. In Phase 0,
 * every subcommand is translated at the argv level (before Commander parses)
 * to its canonical `iw index *` or `iw doc-health` equivalent — so all option
 * validation, help text, and error handling is preserved with zero duplication.
 *
 * Canonical mapping:
 *   iw intent check [--domain X] → iw index rules-check [--domain X]
 *   iw intent extract             → iw index rules-extract
 *   iw intent scan                → iw index scan-diagrams
 *   iw intent living              → iw doc-health
 *   iw intent score               → iw verify --score
 *
 * Domain shortcuts:
 *   iw living verify              → iw intent check --domain documentary
 *
 * Phase 1: --domain flag enables documentary built-in checks (CARI-backed):
 *   structural  — rules.yaml structural rules (default)
 *   behavioral  — rules.yaml behavioral rules
 *   documentary — built-in: coverage, terminology, orphaned sections, completeness
 *   all         — all domains combined
 */

import { Command } from "commander";

export const intentCommand = new Command("intent")
  .description(
    "Intent Engine — check, extract, and score architectural intent (13.x)",
  )
  .addHelpText(
    "after",
    `
Subcommands:
  check [--domain <domain>]  Check against rules — domain: structural|behavioral|documentary|all
  extract                    Extract architectural rules from ADR files via LLM
  scan                       Scan diagrams (Mermaid / PlantUML) for architecture components
  living                     Living documentation health (coverage, stale docs, terminology)
  score                      Living documentation score (A–F composite)

Run 'iw intent <subcommand> --help' for options.

Domain-specific shortcuts:
  iw intent check --domain documentary  → run built-in documentary checks (CARI-backed)
  iw living verify                      → same as above

Backward-compatible aliases:
  iw guardrails *  →  iw intent * (structural/behavioral domain)
  iw living        →  iw doc-health (documentary health overview)
  iw doc-health    →  unchanged (also maps to iw intent living)
`,
  )
  .action(function () {
    // Invoked when no subcommand is given (e.g. bare `iw intent`)
    intentCommand.help();
  });
