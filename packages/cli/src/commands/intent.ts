// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw intent — Intent Engine namespace
 *
 * Canonical subcommands:
 *   iw intent check [--domain X] → iw index rules-check [--domain X]
 *   iw intent extract             → iw index rules-extract
 *   iw intent scan                → iw index scan-diagrams
 *   iw intent living              → iw doc-health
 *   iw intent score               → iw verify --score
 *
 * Domain shortcuts:
 *   iw intent check --domain structural    — import-graph rules (default)
 *   iw intent check --domain behavioral    — Mermaid diagram rules
 *   iw intent check --domain documentary   — built-in CARI coverage/completeness checks
 *   iw intent check --domain all           — all domains combined
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
  iw intent check --domain structural    → import-graph rules only (default)
  iw intent check --domain behavioral    → Mermaid diagram rules only
  iw intent check --domain documentary   → built-in CARI coverage + completeness checks
  iw intent check --domain all           → all domains combined
`,
  )
  .action(function () {
    // Invoked when no subcommand is given (e.g. bare `iw intent`)
    intentCommand.help();
  });
