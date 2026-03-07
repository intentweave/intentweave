/**
 * iw context — RAG context builder for the knowledge graph.
 *
 * Retrieves entities + relationships from Neo4j and assembles a structured
 * Markdown context block ready to be pasted into an LLM prompt, MCP tool,
 * or chat session.
 *
 * Three retrieval strategies:
 *   1. Topic (default): NL topic -> find matching entities -> expand neighborhood
 *   2. Entity (--entity): seed from a named entity -> expand N hops
 *   3. All (--all): dump entire session as structured context
 *
 * New features (Extended RAG builder):
 *   - --rationales:     Include raw triple rationales (LLM explanations)
 *   - --provenance:     Include source document attribution
 *   - --descriptions:   Include entity descriptions derived from rationales
 *   - --min-confidence: Filter by confidence threshold
 *   - --token-budget:   Auto-trim output to fit LLM context windows
 *
 * Environment variables:
 *   NEO4J_URI      (default: bolt://localhost:7687)
 *   NEO4J_USER     (default: neo4j)
 *   NEO4J_PASSWORD (required)
 *   OPENAI_API_KEY (required for topic mode)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import {
  buildTopicContext,
  buildEntityContext,
  buildFullContext,
  enrichWithDescriptions,
  enrichWithCodeRefs,
  formatContextMarkdown,
  formatContextJson,
  type Neo4jRunner,
  type ContextOptions,
  type ContextBundle,
  type FormatOptions,
} from '../context/index.js';

// =============================================================================
// Neo4j connection helper (CLI-specific — creates and owns the driver)
// =============================================================================

interface Neo4jConnection {
  driver: any;
  session: any;
  close: () => Promise<void>;
}

async function connectNeo4j(opts: {
  uri?: string;
  user?: string;
  password?: string;
}): Promise<Neo4jConnection> {
  const neo4j = await import('neo4j-driver');

  const uri = opts.uri ?? process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const user = opts.user ?? process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j';
  const password = opts.password ?? process.env.NEO4J_PASSWORD;

  if (!password) {
    throw new Error(
      'Neo4j password required. Set NEO4J_PASSWORD environment variable.\n' +
      'Example: export NEO4J_PASSWORD=codegraph',
    );
  }

  const driver = neo4j.default.driver(uri, neo4j.default.auth.basic(user, password));
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
// Neo4j -> Runner adapter
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
// LLM helper (topic mode only)
// =============================================================================

async function createLlmCompleter(opts: { model?: string; apiKey?: string }) {
  const { OpenAILLMProvider } = await import('@intentweave/analyzer/llm');
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenAI API key required for topic-based context retrieval.\n' +
      'Set OPENAI_API_KEY or use --entity / --all instead.',
    );
  }

  const provider = new OpenAILLMProvider({
    apiKey,
    model: opts.model ?? 'gpt-4o-mini',
    timeoutMs: 30_000,
  });

  return async (input: { system: string; userMessage: string }): Promise<string> => {
    const response = await provider.complete({
      system: input.system,
      messages: [{ role: 'user', content: input.userMessage }],
      temperature: 0,
      maxTokens: 2048,
    });
    if (response.finishReason === 'error') {
      throw new Error(`LLM error: ${response.error}`);
    }
    return response.content.trim();
  };
}

// =============================================================================
// Command definition
// =============================================================================

export const contextCommand = new Command('context')
  .description('Build structured LLM context from the knowledge graph (RAG retrieval)')
  .argument('[topic]', 'Topic or question to build context for')
  .option('-e, --entity <name>', 'Seed from a specific entity name')
  .option('-a, --all', 'Dump entire session as context')
  .option('-s, --session <id>', 'Session ID (required)', '')
  .option('--hops <n>', 'Neighborhood expansion depth', '2')
  .option('--limit <n>', 'Max entities to include', '200')
  .option('--min-confidence <n>', 'Min confidence threshold (0.0-1.0)', '0')
  .option('--rationales', 'Include raw triple rationales in output')
  .option('--provenance', 'Include source document attribution')
  .option('--descriptions', 'Include entity descriptions from rationales')
  .option('--code-refs', 'Include cross-layer code references (files implementing concepts)')
  .option('--token-budget <n>', 'Max output tokens (auto-trims to fit)')
  .option('-f, --format <fmt>', 'Output format: markdown | json', 'markdown')
  .option('-o, --output <path>', 'Write context to file')
  .option('-v, --verbose', 'Show retrieval progress on stderr')
  .option('--model <model>', 'LLM model for topic selection', 'gpt-4o-mini')
  .option('--neo4j-uri <uri>', 'Neo4j connection URI')
  .option('--api-key <key>', 'OpenAI API key override')
  .action(async (topicArg: string | undefined, options) => {
    const {
      entity: entityName,
      all: allMode,
      session: sessionId,
      hops: hopsStr,
      limit: limitStr,
      minConfidence: minConfStr,
      rationales: includeRationales,
      provenance: includeProvenance,
      descriptions: includeDescriptions,
      codeRefs: includeCodeRefs,
      tokenBudget: tokenBudgetStr,
      format,
      output,
      verbose,
      model,
      apiKey,
    } = options;

    const hops = parseInt(hopsStr, 10) || 2;
    const limit = parseInt(limitStr, 10) || 200;
    const minConfidence = parseFloat(minConfStr) || 0;
    const tokenBudget = tokenBudgetStr ? parseInt(tokenBudgetStr, 10) : undefined;

    if (!topicArg && !entityName && !allMode) {
      console.error(chalk.red('Provide a topic, --entity <name>, or --all.'));
      console.error('');
      console.error('Examples:');
      console.error('  iw context -s planpling "tech stack decisions"');
      console.error('  iw context -s planpling --entity React --rationales');
      console.error('  iw context -s planpling --all --provenance');
      console.error('  iw context -s planpling "auth" --token-budget 2000');
      process.exit(1);
    }

    if (!sessionId) {
      console.error(chalk.red('Session ID required. Use --session <id> (e.g., --session planpling).'));
      process.exit(1);
    }

    let conn: Neo4jConnection | undefined;

    try {
      conn = await connectNeo4j({ uri: options.neo4jUri });
      if (verbose) {
        console.error(chalk.blue('Connected to Neo4j'));
      }

      const runner = createRunner(conn);
      const log = verbose ? (msg: string) => console.error(chalk.blue(msg)) : undefined;

      const contextOpts: ContextOptions = {
        runner,
        sessionId,
        limit,
        hops,
        minConfidence,
        includeRationales,
        includeProvenance,
        tokenBudget,
        log,
      };

      let bundle: ContextBundle;

      if (allMode) {
        bundle = await buildFullContext(contextOpts);
      } else if (entityName) {
        bundle = await buildEntityContext(entityName, contextOpts);
      } else {
        contextOpts.llm = await createLlmCompleter({ model, apiKey });
        bundle = await buildTopicContext(topicArg!, contextOpts);
      }

      if (includeDescriptions) {
        await enrichWithDescriptions(runner, sessionId, bundle.entities);
      }

      if (includeCodeRefs) {
        await enrichWithCodeRefs(runner, sessionId, bundle.entities);
      }

      const formatOpts: FormatOptions = {
        tokenBudget,
        includeRationales,
        includeProvenance,
        includeDescriptions,
        includeCodeRefs,
      };

      const formatted = format === 'json'
        ? formatContextJson(bundle)
        : formatContextMarkdown(bundle, formatOpts);

      if (output) {
        writeFileSync(output, formatted, 'utf-8');
        console.error(chalk.green(`Context written to ${output}`));
        console.error(chalk.blue(
          `${bundle.stats.totalEntities} entities, ${bundle.stats.totalRelationships} relationships`,
        ));
      } else {
        console.log(formatted);
      }

      if (verbose) {
        console.error(chalk.blue('\nEntity types:'));
        for (const [type, count] of Object.entries(bundle.stats.entityTypes)) {
          console.error(chalk.gray(`  ${type}: ${count}`));
        }
        console.error(chalk.blue('Predicates:'));
        for (const [pred, count] of Object.entries(bundle.stats.predicateCounts)) {
          console.error(chalk.gray(`  ${pred}: ${count}`));
        }
      }
    } catch (err: any) {
      console.error(chalk.red('Error:'), err.message ?? err);
      process.exit(1);
    } finally {
      if (conn) await conn.close();
    }
  });
