// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * xlink command — Cross-layer linker
 *
 * Connects IntentWeave's semantic knowledge graph to actual source code.
 * Scans a codebase and matches Canon entities against:
 *   - package.json dependencies
 *   - import statements
 *   - exported symbol names
 *   - file/directory paths
 *
 * Creates :CodeRef nodes and :REALIZED_BY relationships in Neo4j (--persist).
 *
 * Examples:
 *   iw xlink . --session planpling -v
 *   iw xlink ../planpling --session planpling --persist -v
 *   iw xlink . --session codegraphchat-v2 --strategies dep,import -v
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  runCrossLayerLinker,
  persistCrossLinks,
  formatXLinkReport,
  type MatchStrategy,
} from '../linker/index.js';
import type { Neo4jRunner } from '../context/index.js';

// =============================================================================
// Neo4j connection (same pattern as context.ts)
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
  for (const [k, v] of Object.entries(props)) out[k] = toPlainValue(v);
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

export const xlinkCommand = new Command('xlink')
  .description('Cross-layer linker: connect semantic knowledge graph to source code')
  .argument('[directory]', 'Codebase directory to scan', '.')
  .option('-s, --session <id>', 'IntentWeave session ID (required)', '')
  .option('--strategies <list>', 'Matching strategies: dep,import,name,path', 'dep,import,name,path')
  .option('--min-confidence <n>', 'Min confidence threshold (0.0-1.0)', '0.4')
  .option('--persist', 'Persist links to Neo4j (creates :CodeRef nodes and :REALIZED_BY relationships)')
  .option('-f, --format <fmt>', 'Output format: markdown | json', 'markdown')
  .option('-o, --output <path>', 'Write report to file')
  .option('-v, --verbose', 'Verbose output')
  .option('--neo4j-uri <uri>', 'Neo4j connection URI')
  .action(async (directory: string, options) => {
    const {
      session: sessionId,
      strategies: strategiesStr,
      minConfidence: minConfStr,
      persist,
      format,
      output,
      verbose,
    } = options;

    if (!sessionId) {
      console.error(chalk.red('Session ID required. Use --session <id>.'));
      console.error('');
      console.error('Examples:');
      console.error('  iw xlink . --session planpling -v');
      console.error('  iw xlink . --session codegraphchat-v2 --persist -v');
      process.exit(1);
    }

    const strategies = strategiesStr.split(',').map((s: string) => s.trim()) as MatchStrategy[];
    const minConfidence = parseFloat(minConfStr) || 0.4;
    const codebaseDir = path.resolve(directory);

    let conn: Neo4jConnection | undefined;

    try {
      conn = await connectNeo4j(options.neo4jUri);

      if (verbose) {
        console.error(chalk.blue('Connected to Neo4j'));
        console.error(chalk.blue(`Session: ${sessionId}`));
        console.error(chalk.blue(`Scanning: ${codebaseDir}`));
        console.error(chalk.blue(`Strategies: ${strategies.join(', ')}`));
        console.error('');
      }

      const runner = createRunner(conn);
      const log = verbose ? (msg: string) => console.error(chalk.blue(msg)) : undefined;

      const result = await runCrossLayerLinker({
        runner,
        sessionId,
        codebaseDir,
        strategies,
        minConfidence,
        log,
      });

      // Report
      if (verbose) {
        console.error('');
        console.error(chalk.green(`✓ ${result.stats.linkedEntities}/${result.stats.totalCanonEntities} entities linked to code`));
        console.error(chalk.blue(`  ${result.stats.totalCodeRefs} total code references`));
        for (const [strategy, count] of Object.entries(result.stats.byStrategy)) {
          if (count > 0) console.error(chalk.gray(`    ${strategy}: ${count}`));
        }
        console.error('');
      }

      // Persist if requested
      if (persist) {
        await persistCrossLinks(runner, sessionId, result.links, log);
        if (verbose) {
          console.error(chalk.green('✓ Cross-links persisted to Neo4j'));
          console.error(chalk.gray('  Query with: iw query --cypher "MATCH (c:Canon)-[r:REALIZED_BY]->(cr:CodeRef) WHERE c.session_id = \'planpling\' RETURN c.name, r.strategy, cr.filePath LIMIT 20"'));
        }
      }

      // Format output
      const formatted = format === 'json'
        ? JSON.stringify(result, null, 2)
        : formatXLinkReport(result);

      if (output) {
        writeFileSync(output, formatted, 'utf-8');
        console.error(chalk.green(`Report written to ${output}`));
      } else {
        console.log(formatted);
      }
    } catch (err: any) {
      console.error(chalk.red('Error:'), err.message ?? err);
      process.exit(1);
    } finally {
      if (conn) await conn.close();
    }
  });
