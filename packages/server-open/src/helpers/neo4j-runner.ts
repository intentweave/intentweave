/**
 * Neo4jRunner adapter — bridges the Fastify neo4j driver to the CLI's Neo4jRunner interface.
 */
import type { Driver } from 'neo4j-driver';

/**
 * Minimal runner interface matching the CLI's Neo4jRunner.
 * Defined inline to avoid coupling to CLI internals.
 */
export interface Neo4jRunner {
  run(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/**
 * Create a Neo4jRunner from a neo4j-driver Driver instance.
 *
 * Each `run()` call opens a session, executes the query, maps records to plain objects,
 * and closes the session. This is safe for concurrent use (driver manages the pool).
 */
export function createRunnerFromDriver(driver: Driver, database?: string): Neo4jRunner {
  return {
    async run(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
      const session = driver.session({ database: database ?? 'neo4j' });
      try {
        const result = await session.run(cypher, params);
        return result.records.map((record) => {
          const obj: Record<string, unknown> = {};
          for (const key of record.keys) {
            const val = record.get(key as string);
            obj[key as string] = toPlain(val);
          }
          return obj;
        });
      } finally {
        await session.close();
      }
    },
  };
}

/**
 * Convert neo4j-driver types to plain JS values.
 */
function toPlain(val: unknown): unknown {
  if (val === null || val === undefined) return val;

  // Neo4j Integer → number
  if (typeof val === 'object' && val !== null && 'toNumber' in val && typeof (val as { toNumber: unknown }).toNumber === 'function') {
    return (val as { toNumber(): number }).toNumber();
  }

  // Neo4j Node → properties
  if (typeof val === 'object' && val !== null && 'properties' in val && 'labels' in val) {
    return (val as { properties: Record<string, unknown> }).properties;
  }

  // Arrays
  if (Array.isArray(val)) return val.map(toPlain);

  return val;
}
