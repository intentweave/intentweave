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
 *   iw intent check   → iw index rules-check    (structural + behavioral rules)
 *   iw intent extract → iw index rules-extract   (LLM rule extraction from ADRs)
 *   iw intent scan    → iw index scan-diagrams   (diagram component scanning)
 *   iw intent living  → iw doc-health            (documentary domain health)
 *   iw intent score   → iw verify --score        (living documentation score)
 *
 * Phase 1 will promote these to first-class subcommands with a unified
 * `--domain structural|behavioral|documentary` flag.
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
  check    Check codebase against rules from .iw/rules.yaml
  extract  Extract architectural rules from ADR files via LLM
  scan     Scan diagrams (Mermaid / PlantUML) for architecture components
  living   Living documentation health (coverage, stale docs, terminology)
  score    Living documentation score (A–F composite)

Run 'iw intent <subcommand> --help' for options.

Backward-compatible aliases:
  iw guardrails *  →  iw intent * (structural/behavioral domain)
  iw living        →  iw intent living (documentary domain)
  iw doc-health    →  unchanged (also maps to iw intent living)
`,
  )
  .action(function () {
    // Invoked when no subcommand is given (e.g. bare `iw intent`)
    intentCommand.help();
  });
