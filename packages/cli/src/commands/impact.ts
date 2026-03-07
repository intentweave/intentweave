// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw impact — Semantic impact analysis
 *
 * Answers: "If I change file X, what semantic concepts are affected?"
 *
 * Traverses:  file → :CodeRef ←[:REALIZED_BY]– :Canon –[:CANON_REL *1..N]→ :Canon
 *
 * Examples:
 *   iw impact package.json -s planpling
 *   iw impact ui/src/App.tsx -s planpling -v
 *   iw impact src/server/index.ts packages/cli/src/cli.ts -s codegraphchat-v2
 *   iw impact package.json -s planpling --hops 3 --format json -o impact.json
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import {
  analyzeImpact,
  formatImpactMarkdown,
  formatImpactJson,
  type ImpactOptions,
} from '../impact/index.js';
import type { Neo4jRunner } from '../context/index.js';

// =============================================================================
// Neo4j connection (same pattern as other commands)
// =============================================================================

interface Neo4jConnection {
  driver: any;
  session: any;
  close: () => Promise<void>;
}

async function connectNeo4j(uri?: string): Promise<Neo4jConnection> {
  const neo4j = await import('neo4j-driver');
  const neoUri = uri ?? process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j';
  const password = process.env.NEO4J_PASSWORD;

  if (!password) {
    throw new Error(
      'Neo4j password required. Set NEO4J_PASSWORD environment variable.\n' +
      'Example: export NEO4J_PASSWORD=codegraph',
    );
  }

  const driver = neo4j.default.driver(neoUri, neo4j.default.auth.basic(user, password));
  await driver.verifyConnectivity();
  const session = driver.session();

  return {
    driver,
    session,
    close: async () => {
      await session.close();
      await driver.close();
    },
  };
}

// =============================================================================
// Runner adapter
// =============================================================================

function toPlainValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object' && v !== null && 'toNumber' in v && typeof (v as any).toNumber === 'function') {
    return (v as any).toNumber();
  }
  if (Array.isArray(v)) return v.map(toPlainValue);
  return v;
}

function plainProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = toPlainValue(v);
  }
  return out;
}

function createRunner(conn: Neo4jConnection): Neo4jRunner {
  return {
    async run(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
      const neo4j = await import('neo4j-driver');
      const cleanParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        cleanParams[k] = typeof v === 'number' ? neo4j.default.int(Math.round(v)) : v;
      }
      const result = await conn.session.run(cypher, cleanParams);
      return result.records.map((rec: any) => {
        const row: Record<string, unknown> = {};
        for (const key of rec.keys) {
          const v = rec.get(key);
          if (v !== null && typeof v === 'object' && 'properties' in v) {
            row[key as string] = plainProps(v.properties);
          } else {
            row[key as string] = toPlainValue(v);
          }
        }
        return row;
      });
    },
  };
}

// =============================================================================
// Command
// =============================================================================

export const impactCommand = new Command('impact')
  .description('Analyze semantic impact of changing file(s) — shows affected concepts, decisions, and risks')
  .argument('<files...>', 'File path(s) to analyze (workspace-relative)')
  .option('-s, --session <id>', 'Session ID (required)', '')
  .option('--hops <n>', 'Ripple expansion depth (1-3)', '2')
  .option('--limit <n>', 'Max ripple entities', '100')
  .option('--min-confidence <n>', 'Min confidence threshold (0.0-1.0)', '0')
  .option('-f, --format <fmt>', 'Output format: markdown | json', 'markdown')
  .option('-o, --output <path>', 'Write output to file')
  .option('-v, --verbose', 'Show progress on stderr')
  .option('--neo4j-uri <uri>', 'Neo4j connection URI')
  .action(async (files: string[], options) => {
    const {
      session: sessionId,
      hops: hopsStr,
      limit: limitStr,
      minConfidence: minConfStr,
      format,
      output,
      verbose,
    } = options;

    if (!sessionId) {
      console.error(chalk.red('Session ID required. Use --session <id> (e.g., --session planpling).'));
      process.exit(1);
    }

    const hops = parseInt(hopsStr, 10) || 2;
    const limit = parseInt(limitStr, 10) || 100;
    const minConfidence = parseFloat(minConfStr) || 0;

    let conn: Neo4jConnection | undefined;

    try {
      conn = await connectNeo4j(options.neo4jUri);
      if (verbose) console.error(chalk.blue('Connected to Neo4j'));

      const runner = createRunner(conn);
      const log = verbose ? (msg: string) => console.error(chalk.blue(msg)) : undefined;

      const impactOpts: ImpactOptions = {
        runner,
        sessionId,
        hops,
        limit,
        minConfidence,
        log,
      };

      const result = await analyzeImpact(files, impactOpts);

      const formatted = format === 'json'
        ? formatImpactJson(result)
        : formatImpactMarkdown(result);

      if (output) {
        writeFileSync(output, formatted, 'utf-8');
        console.error(chalk.green(`Impact analysis written to ${output}`));
      } else {
        console.log(formatted);
      }

      if (verbose) {
        console.error(chalk.blue(`\n${result.stats.directCount} direct, ${result.stats.rippleCount} ripple, ${result.stats.decisionCount} decisions, ${result.stats.riskCount} risks`));
      }
    } catch (err: any) {
      console.error(chalk.red('Error:'), err.message ?? err);
      process.exit(1);
    } finally {
      if (conn) await conn.close();
    }
  });
