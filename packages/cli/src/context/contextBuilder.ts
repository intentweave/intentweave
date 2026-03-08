// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Extended RAG Context Builder
 *
 * Shared module for building structured knowledge-graph context from Neo4j.
 * Used by both the CLI `iw context` command and the MCP `kg_context` tool.
 *
 * Improvements over the original inlined implementation:
 * - RawTriple rationale injection (biggest quality boost)
 * - Confidence-weighted ranking (surface high-quality data first)
 * - Token-budget-aware formatting (prevents overrunning LLM windows)
 * - Provenance attribution (which document each fact comes from)
 * - Shared between CLI and MCP (eliminates code duplication)
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Abstraction over a Neo4j connection — callers provide their own session.
 */
export interface Neo4jRunner {
  /** Execute a Cypher query and return plain-object rows */
  run(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
}

/**
 * LLM completion function — callers provide their own provider.
 */
export type LLMCompleter = (opts: {
  system: string;
  userMessage: string;
}) => Promise<string>;

/**
 * A code reference linked to a Canon entity via the cross-layer linker.
 */
export interface CodeReference {
  /** Workspace-relative file path */
  filePath: string;
  /** Symbol / import / dep name */
  name: string;
  /** What this code ref represents */
  kind: "package-dep" | "import" | "symbol" | "file" | "directory";
  /** Matching strategy that produced this link */
  strategy: string;
  /** Match confidence */
  confidence: number;
}

/**
 * An entity in the context bundle.
 */
export interface ContextEntity {
  canonId: string;
  name: string;
  type: string;
  aliases: string[];
  confidence: number;
  /** Source document(s) this entity was extracted from */
  sources: string[];
  /** Short description derived from raw triple rationales */
  description?: string;
  /** Code references from cross-layer linker (files, imports, deps) */
  codeRefs?: CodeReference[];
}

/**
 * A relationship in the context bundle.
 */
export interface ContextRelationship {
  sourceName: string;
  sourceType: string;
  predicate: string;
  targetName: string;
  targetType: string;
  confidence: number;
  /** Raw/natural-language predicate before canonicalization */
  rawPredicate?: string;
  /** LLM-generated rationale for why this relationship exists */
  rationale?: string;
  /** Source document this relationship was extracted from */
  source?: string;
}

/**
 * Complete context bundle returned by the builder.
 */
export interface ContextBundle {
  topic: string;
  sessionId: string;
  entities: ContextEntity[];
  relationships: ContextRelationship[];
  stats: {
    totalEntities: number;
    totalRelationships: number;
    entityTypes: Record<string, number>;
    predicateCounts: Record<string, number>;
  };
}

/**
 * Options for context retrieval.
 */
export interface ContextOptions {
  /** Neo4j query runner */
  runner: Neo4jRunner;
  /** Session ID to scope queries */
  sessionId: string;
  /** Max entities to return */
  limit?: number;
  /** Neighborhood expansion depth (hops) */
  hops?: number;
  /** Min confidence threshold (0.0–1.0, default 0.0 = no filter) */
  minConfidence?: number;
  /** Include raw triple rationales in output */
  includeRationales?: boolean;
  /** Include source/provenance info */
  includeProvenance?: boolean;
  /** Token budget for the formatted output (default: unlimited) */
  tokenBudget?: number;
  /** LLM completer for topic-based seed selection */
  llm?: LLMCompleter;
  /** Include cross-layer code references (CodeRef nodes) */
  includeCodeRefs?: boolean;
  /** Verbose logging callback */
  log?: (msg: string) => void;
}

// =============================================================================
// Core Builder
// =============================================================================

/**
 * Build context from a natural-language topic.
 *
 * Flow: fetch all entity names → LLM picks seeds → expand neighborhood →
 * enrich with rationales + provenance.
 */
export async function buildTopicContext(
  topic: string,
  options: ContextOptions,
): Promise<ContextBundle> {
  const { runner, sessionId, llm, log } = options;
  const limit = options.limit ?? 200;
  const hops = options.hops ?? 2;

  if (!llm) {
    throw new Error(
      "LLM completer required for topic-based context retrieval.",
    );
  }

  // Step 1: Fetch all entity names (for LLM seed selection)
  log?.("Fetching entity names for seed selection…");
  const allNames = await runner.run(
    `MATCH (n:Canon)
     WHERE n.session_id = $sid
     RETURN n.name AS name, n.type AS type
     ORDER BY n.confidence DESC, n.name
     LIMIT 500`,
    { sid: sessionId },
  );

  if (allNames.length === 0) {
    return emptyBundle(topic, sessionId);
  }

  const nameList = allNames.map((r) => `- ${r.name} (${r.type})`).join("\n");

  // Step 2: LLM picks seeds
  log?.(`Selecting relevant entities for topic: "${topic}"…`);
  const seedJson = await llm({
    system: `You are a knowledge-graph context selector.
Given a topic and a list of entities, pick the entities most relevant to the topic.
Return ONLY a JSON array of entity names (strings). No explanation.
Pick 5-20 entities that are most relevant. If the topic is broad, pick more.
Prefer high-level concepts and decisions over low-level details.`,
    userMessage: `Topic: ${topic}\n\nEntities in the graph:\n${nameList}`,
  });

  let seedNames: string[];
  try {
    seedNames = JSON.parse(
      seedJson.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, ""),
    );
  } catch {
    seedNames = [...seedJson.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  log?.(`Selected ${seedNames.length} seed entities`);

  if (seedNames.length === 0) {
    return emptyBundle(topic, sessionId);
  }

  return expandAndEnrich(seedNames, topic, options, hops, limit);
}

/**
 * Build context from a specific entity name, expanding N hops.
 */
export async function buildEntityContext(
  entityName: string,
  options: ContextOptions,
): Promise<ContextBundle> {
  const { runner, sessionId, log } = options;
  const limit = options.limit ?? 200;
  const hops = options.hops ?? 2;

  log?.(`Matching entity: "${entityName}"…`);

  // Fuzzy match entity by name or alias
  const matches = await runner.run(
    `MATCH (n:Canon)
     WHERE n.session_id = $sid
       AND (toLower(n.name) = toLower($name)
            OR toLower(n.name) CONTAINS toLower($name)
            OR ANY(a IN coalesce(n.aliases, []) WHERE toLower(a) CONTAINS toLower($name)))
     RETURN n.name AS name
     LIMIT 10`,
    { sid: sessionId, name: entityName },
  );

  const seedNames = matches.map((r) => r.name as string);
  if (seedNames.length === 0) {
    return emptyBundle(entityName, sessionId);
  }

  log?.(`Matched ${seedNames.length} entities, expanding ${hops} hops…`);
  return expandAndEnrich(seedNames, entityName, options, hops, limit);
}

/**
 * Dump the full session as context.
 */
export async function buildFullContext(
  options: ContextOptions,
): Promise<ContextBundle> {
  const { runner, sessionId, log } = options;
  const limit = options.limit ?? 500;
  const minConf = options.minConfidence ?? 0;

  log?.("Retrieving full session context…");

  const entities = await fetchEntities(
    runner,
    `MATCH (n:Canon)
     WHERE n.session_id = $sid
       AND coalesce(n.confidence, 1.0) >= $minConf
     RETURN n.canonId AS canonId, n.name AS name, n.type AS type,
            coalesce(n.aliases, []) AS aliases,
            coalesce(n.confidence, 1.0) AS confidence,
            coalesce(n.artifactId, '') AS artifactId
     ORDER BY n.confidence DESC, n.type, n.name
     LIMIT $lim`,
    { sid: sessionId, lim: limit, minConf },
  );

  const entityNames = entities.map((e) => e.name);

  const relationships = await fetchRelationships(
    runner,
    `MATCH (a:Canon)-[r:CANON_REL]->(b:Canon)
     WHERE a.session_id = $sid
       AND coalesce(r.confidence, 1.0) >= $minConf
     RETURN a.name AS sourceName, a.type AS sourceType,
            r.predicate AS predicate,
            b.name AS targetName, b.type AS targetType,
            coalesce(r.confidence, 1.0) AS confidence,
            r.rawPredicate AS rawPredicate,
            coalesce(r.artifactId, '') AS artifactId
     ORDER BY r.confidence DESC, r.predicate, a.name
     LIMIT $lim`,
    { sid: sessionId, lim: limit * 3, minConf },
  );

  // Enrich with rationales if requested
  if (options.includeRationales) {
    await enrichWithRationales(runner, sessionId, relationships, entityNames);
  }

  // Add provenance to entities
  if (options.includeProvenance) {
    await enrichWithProvenance(runner, sessionId, entities);
  }

  return buildBundle("Full session", sessionId, entities, relationships);
}

// =============================================================================
// Internal: Expand + Enrich
// =============================================================================

async function expandAndEnrich(
  seedNames: string[],
  topic: string,
  options: ContextOptions,
  hops: number,
  limit: number,
): Promise<ContextBundle> {
  const { runner, sessionId, log } = options;
  const minConf = options.minConfidence ?? 0;
  const hopRange = hops > 1 ? `1..${hops}` : "1";

  // Expand neighborhood from seeds (directed awareness: follow outgoing first)
  const entities = await fetchEntities(
    runner,
    `MATCH (seed:Canon)
     WHERE seed.session_id = $sid AND seed.name IN $seeds
     WITH collect(seed) AS seedNodes
     UNWIND seedNodes AS s
     OPTIONAL MATCH (s)-[:CANON_REL*${hopRange}]-(neighbor:Canon)
     WHERE neighbor.session_id = $sid
       AND coalesce(neighbor.confidence, 1.0) >= $minConf
     WITH seedNodes, collect(DISTINCT neighbor) AS neighbors
     WITH seedNodes + neighbors AS all
     UNWIND all AS n
     WITH DISTINCT n
     RETURN n.canonId AS canonId, n.name AS name, n.type AS type,
            coalesce(n.aliases, []) AS aliases,
            coalesce(n.confidence, 1.0) AS confidence,
            coalesce(n.artifactId, '') AS artifactId
     ORDER BY n.confidence DESC, n.type, n.name
     LIMIT $lim`,
    { sid: sessionId, seeds: seedNames, lim: limit, minConf },
  );

  log?.(`Expanded to ${entities.length} entities`);

  const entityNames = entities.map((e) => e.name);

  // Fetch relationships within the subgraph
  const relationships = await fetchRelationships(
    runner,
    `MATCH (a:Canon)-[r:CANON_REL]->(b:Canon)
     WHERE a.session_id = $sid
       AND a.name IN $names AND b.name IN $names
       AND coalesce(r.confidence, 1.0) >= $minConf
     RETURN a.name AS sourceName, a.type AS sourceType,
            r.predicate AS predicate,
            b.name AS targetName, b.type AS targetType,
            coalesce(r.confidence, 1.0) AS confidence,
            r.rawPredicate AS rawPredicate,
            coalesce(r.artifactId, '') AS artifactId
     ORDER BY r.confidence DESC, r.predicate, a.name
     LIMIT $lim`,
    { sid: sessionId, names: entityNames, lim: limit * 3, minConf },
  );

  log?.(`Fetched ${relationships.length} relationships`);

  // Enrich with rationales from raw triples
  if (options.includeRationales) {
    log?.("Enriching with raw triple rationales…");
    await enrichWithRationales(runner, sessionId, relationships, entityNames);
  }

  // Add provenance to entities
  if (options.includeProvenance) {
    log?.("Adding provenance…");
    await enrichWithProvenance(runner, sessionId, entities);
  }

  return buildBundle(topic, sessionId, entities, relationships);
}

// =============================================================================
// Enrichment: Rationales + Provenance
// =============================================================================

/**
 * Enrich relationships with rationales from RawTriple nodes.
 *
 * For each canonical relationship, find the RawTriple that was canonicalized
 * into it and attach the rationale text.
 */
async function enrichWithRationales(
  runner: Neo4jRunner,
  sessionId: string,
  relationships: ContextRelationship[],
  entityNames: string[],
): Promise<void> {
  if (relationships.length === 0) return;

  // Fetch raw triples linked to entities in our subgraph
  const rawTriples = await runner.run(
    `MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(ce:Canon:Entity)
     WHERE rt.session_id = $sid AND ce.name IN $names
       AND rt.rationale IS NOT NULL AND rt.rationale <> ''
     RETURN rt.subject AS subject, rt.predicate AS predicate, rt.object AS object,
            rt.rationale AS rationale, rt.confidence AS confidence
     LIMIT 1000`,
    { sid: sessionId, names: entityNames },
  );

  if (rawTriples.length === 0) return;

  // Build a lookup: "subject|object" → best rationale
  const rationaleMap = new Map<
    string,
    { rationale: string; confidence: number }
  >();

  for (const rt of rawTriples) {
    const subj = String(rt.subject ?? "").toLowerCase();
    const obj = String(rt.object ?? "").toLowerCase();
    const rationale = String(rt.rationale ?? "");
    const conf = typeof rt.confidence === "number" ? rt.confidence : 0.5;
    const key = `${subj}|${obj}`;

    const existing = rationaleMap.get(key);
    if (!existing || conf > existing.confidence) {
      rationaleMap.set(key, { rationale, confidence: conf });
    }
  }

  // Match rationales to canonical relationships
  for (const rel of relationships) {
    const key = `${rel.sourceName.toLowerCase()}|${rel.targetName.toLowerCase()}`;
    const match = rationaleMap.get(key);
    if (match) {
      rel.rationale = match.rationale;
    }
  }
}

/**
 * Enrich entities with provenance (source document) information.
 */
async function enrichWithProvenance(
  runner: Neo4jRunner,
  sessionId: string,
  entities: ContextEntity[],
): Promise<void> {
  if (entities.length === 0) return;

  const entityNames = entities.map((e) => e.name);

  // Fetch distinct artifact IDs per entity from raw triples
  const provenanceRows = await runner.run(
    `MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(ce:Canon:Entity)
     WHERE rt.session_id = $sid AND ce.name IN $names
       AND rt.artifactId IS NOT NULL
     RETURN ce.name AS entityName, collect(DISTINCT rt.artifactId) AS sources
     LIMIT 1000`,
    { sid: sessionId, names: entityNames },
  );

  const sourceMap = new Map<string, string[]>();
  for (const row of provenanceRows) {
    const name = String(row.entityName);
    const sources = Array.isArray(row.sources) ? row.sources.map(String) : [];
    sourceMap.set(name, sources);
  }

  for (const entity of entities) {
    const sources = sourceMap.get(entity.name);
    if (sources && sources.length > 0) {
      entity.sources = sources;
    }
  }
}

/**
 * Enrich entities with short descriptions from raw triple rationales.
 */
export async function enrichWithDescriptions(
  runner: Neo4jRunner,
  sessionId: string,
  entities: ContextEntity[],
): Promise<void> {
  if (entities.length === 0) return;

  const entityNames = entities.map((e) => e.name);

  // Get the best rationale mentioning each entity as subject
  const descriptions = await runner.run(
    `MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(ce:Canon:Entity)
     WHERE rt.session_id = $sid AND ce.name IN $names
       AND rt.rationale IS NOT NULL AND rt.rationale <> ''
     WITH ce.name AS entityName, rt.rationale AS rationale, rt.confidence AS conf
     ORDER BY conf DESC
     WITH entityName, collect(rationale)[0] AS bestRationale
     RETURN entityName, bestRationale
     LIMIT 500`,
    { sid: sessionId, names: entityNames },
  );

  const descMap = new Map<string, string>();
  for (const row of descriptions) {
    descMap.set(String(row.entityName), String(row.bestRationale));
  }

  for (const entity of entities) {
    const desc = descMap.get(entity.name);
    if (desc) {
      entity.description = desc;
    }
  }
}

/**
 * Enrich entities with cross-layer code references from the linker.
 *
 * Queries (:Canon)-[:REALIZED_BY]->(:CodeRef) and attaches matching refs
 * to each entity in the bundle.
 */
export async function enrichWithCodeRefs(
  runner: Neo4jRunner,
  sessionId: string,
  entities: ContextEntity[],
): Promise<void> {
  if (entities.length === 0) return;

  const entityNames = entities.map((e) => e.name);

  const rows = await runner.run(
    `MATCH (c:Canon)-[r:REALIZED_BY]->(cr:CodeRef)
     WHERE c.session_id = $sid AND c.name IN $names
     RETURN c.name AS entityName,
            cr.filePath AS filePath,
            cr.name AS refName,
            cr.kind AS kind,
            r.strategy AS strategy,
            coalesce(r.confidence, 0.5) AS confidence
     ORDER BY r.confidence DESC`,
    { sid: sessionId, names: entityNames },
  );

  if (rows.length === 0) return;

  // Group by entity name
  const refMap = new Map<string, CodeReference[]>();
  for (const row of rows) {
    const name = String(row.entityName);
    const ref: CodeReference = {
      filePath: String(row.filePath ?? ""),
      name: String(row.refName ?? ""),
      kind: (row.kind as CodeReference["kind"]) ?? "file",
      strategy: String(row.strategy ?? ""),
      confidence: typeof row.confidence === "number" ? row.confidence : 0.5,
    };
    if (!refMap.has(name)) refMap.set(name, []);
    refMap.get(name)!.push(ref);
  }

  for (const entity of entities) {
    const refs = refMap.get(entity.name);
    if (refs && refs.length > 0) {
      entity.codeRefs = refs;
    }
  }
}

// =============================================================================
// Data helpers
// =============================================================================

async function fetchEntities(
  runner: Neo4jRunner,
  cypher: string,
  params: Record<string, unknown>,
): Promise<ContextEntity[]> {
  const rows = await runner.run(cypher, params);
  return rows.map((r) => ({
    canonId: String(r.canonId ?? ""),
    name: String(r.name ?? ""),
    type: String(r.type ?? ""),
    aliases: Array.isArray(r.aliases)
      ? (r.aliases as unknown[]).map(String)
      : [],
    confidence: typeof r.confidence === "number" ? r.confidence : 1.0,
    sources: r.artifactId ? [String(r.artifactId)] : [],
  }));
}

async function fetchRelationships(
  runner: Neo4jRunner,
  cypher: string,
  params: Record<string, unknown>,
): Promise<ContextRelationship[]> {
  const rows = await runner.run(cypher, params);
  return rows.map((r) => ({
    sourceName: String(r.sourceName ?? ""),
    sourceType: String(r.sourceType ?? ""),
    predicate: String(r.predicate ?? ""),
    targetName: String(r.targetName ?? ""),
    targetType: String(r.targetType ?? ""),
    confidence: typeof r.confidence === "number" ? r.confidence : 1.0,
    rawPredicate: r.rawPredicate ? String(r.rawPredicate) : undefined,
    source: r.artifactId ? String(r.artifactId) : undefined,
  }));
}

function emptyBundle(topic: string, sessionId: string): ContextBundle {
  return {
    topic,
    sessionId,
    entities: [],
    relationships: [],
    stats: {
      totalEntities: 0,
      totalRelationships: 0,
      entityTypes: {},
      predicateCounts: {},
    },
  };
}

function buildBundle(
  topic: string,
  sessionId: string,
  entities: ContextEntity[],
  relationships: ContextRelationship[],
): ContextBundle {
  const entityTypes: Record<string, number> = {};
  for (const e of entities) {
    entityTypes[e.type] = (entityTypes[e.type] ?? 0) + 1;
  }
  const predicateCounts: Record<string, number> = {};
  for (const r of relationships) {
    predicateCounts[r.predicate] = (predicateCounts[r.predicate] ?? 0) + 1;
  }

  return {
    topic,
    sessionId,
    entities,
    relationships,
    stats: {
      totalEntities: entities.length,
      totalRelationships: relationships.length,
      entityTypes,
      predicateCounts,
    },
  };
}

// =============================================================================
// Formatter: Token-budget-aware Markdown
// =============================================================================

/** Rough token estimate: ~4 chars per token for English */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface FormatOptions {
  /** Max token budget for the output (default: unlimited) */
  tokenBudget?: number;
  /** Include rationales inline with relationships */
  includeRationales?: boolean;
  /** Include provenance per entity */
  includeProvenance?: boolean;
  /** Include entity descriptions */
  includeDescriptions?: boolean;
  /** Include cross-layer code references */
  includeCodeRefs?: boolean;
}

/**
 * Format a ContextBundle into structured Markdown for LLM injection.
 *
 * When a token budget is provided, sections are progressively dropped to
 * stay under budget (from least to most important):
 *   1. Provenance / source attribution
 *   2. Entity descriptions
 *   3. Rationales (most verbose)
 *   4. Risks section
 *   5. Decision trail
 *   6. Relationships (trimmed)
 *   7. Entities (trimmed)
 *   8. Overview (always included)
 */
export function formatContextMarkdown(
  bundle: ContextBundle,
  options: FormatOptions = {},
): string {
  const budget = options.tokenBudget ?? Infinity;
  const sections: string[] = [];

  // ── Header ─────────────────────────────────────────────────────────
  sections.push(`# Knowledge Context: ${bundle.topic}`);
  sections.push(
    `> Session: ${bundle.sessionId} | ${bundle.stats.totalEntities} entities, ${bundle.stats.totalRelationships} relationships\n`,
  );

  // ── Entity Overview ────────────────────────────────────────────────
  if (bundle.stats.totalEntities > 0) {
    const overviewLines = ["## Entity Overview"];
    for (const [type, count] of Object.entries(bundle.stats.entityTypes).sort(
      (a, b) => b[1] - a[1],
    )) {
      overviewLines.push(`- **${type}**: ${count}`);
    }
    overviewLines.push("");
    sections.push(overviewLines.join("\n"));
  }

  // ── Entities by Type ───────────────────────────────────────────────
  const byType = new Map<string, ContextEntity[]>();
  for (const e of bundle.entities) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }

  for (const [type, ents] of [...byType.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const typeLines = [`## ${capitalize(type)}s`];
    for (const e of ents) {
      const parts: string[] = [`- **${e.name}**`];

      if (e.aliases.length > 0) {
        parts.push(` (aka: ${e.aliases.join(", ")})`);
      }

      // Confidence badge for non-max confidence
      if (e.confidence < 0.9) {
        parts.push(` [${Math.round(e.confidence * 100)}%]`);
      }

      typeLines.push(parts.join(""));

      // Description (from rationale)
      if (options.includeDescriptions && e.description) {
        typeLines.push(`  > ${e.description}`);
      }

      // Provenance
      if (options.includeProvenance && e.sources.length > 0) {
        typeLines.push(`  _Source: ${e.sources.join(", ")}_`);
      }

      // Code references (from cross-layer linker)
      if (options.includeCodeRefs && e.codeRefs && e.codeRefs.length > 0) {
        typeLines.push(
          `  📂 Code: ${e.codeRefs.map((r) => `\`${r.filePath}\` (${r.kind})`).join(", ")}`,
        );
      }
    }
    typeLines.push("");
    sections.push(typeLines.join("\n"));
  }

  // ── Code References Summary ────────────────────────────────────────
  if (options.includeCodeRefs) {
    const linkedEntities = bundle.entities.filter(
      (e) => e.codeRefs && e.codeRefs.length > 0,
    );
    if (linkedEntities.length > 0) {
      const codeLines = ["## Code References"];
      codeLines.push(
        `> ${linkedEntities.length} entities linked to source code\n`,
      );

      for (const e of linkedEntities) {
        codeLines.push(`### ${e.name} (${e.type})`);
        for (const ref of e.codeRefs!) {
          const stratBadge = ref.strategy ? `[${ref.strategy}]` : "";
          codeLines.push(`- \`${ref.filePath}\` — ${ref.kind} ${stratBadge}`);
        }
        codeLines.push("");
      }
      sections.push(codeLines.join("\n"));
    }
  }

  // ── Relationships by Predicate ─────────────────────────────────────
  if (bundle.relationships.length > 0) {
    const relLines = ["## Relationships"];
    const byPred = new Map<string, ContextRelationship[]>();
    for (const r of bundle.relationships) {
      if (!byPred.has(r.predicate)) byPred.set(r.predicate, []);
      byPred.get(r.predicate)!.push(r);
    }

    for (const [pred, rels] of [...byPred.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      relLines.push(`### ${pred}`);
      for (const r of rels) {
        const confStr =
          r.confidence < 0.9 ? ` [${Math.round(r.confidence * 100)}%]` : "";
        relLines.push(`- ${r.sourceName} → ${r.targetName}${confStr}`);

        // Inline rationale
        if (options.includeRationales && r.rationale) {
          relLines.push(`  > ${r.rationale}`);
        }
      }
      relLines.push("");
    }
    sections.push(relLines.join("\n"));
  }

  // ── Decision Trail ─────────────────────────────────────────────────
  const decisions = bundle.relationships.filter(
    (r) => r.predicate === "DECIDED_FOR" || r.predicate === "DECIDED_AGAINST",
  );
  if (decisions.length > 0) {
    const decLines = ["## Decision Trail"];
    for (const d of decisions) {
      const verb = d.predicate === "DECIDED_FOR" ? "✅ chose" : "❌ rejected";
      const line = `- **${d.sourceName}** ${verb} **${d.targetName}**`;
      decLines.push(d.rationale ? `${line}\n  > ${d.rationale}` : line);
    }
    decLines.push("");
    sections.push(decLines.join("\n"));
  }

  // ── Risks ──────────────────────────────────────────────────────────
  const risks = bundle.relationships.filter((r) => r.predicate === "RISKS");
  if (risks.length > 0) {
    const riskLines = ["## Risks"];
    for (const r of risks) {
      const line = `- ${r.sourceName} ⚠ ${r.targetName}`;
      riskLines.push(r.rationale ? `${line}\n  > ${r.rationale}` : line);
    }
    riskLines.push("");
    sections.push(riskLines.join("\n"));
  }

  // ── Token budget trimming ──────────────────────────────────────────
  let output = sections.join("\n");

  if (budget !== Infinity && estimateTokens(output) > budget) {
    // Progressive trimming: strip from least to most important
    // Pass 1: Remove provenance lines
    output = output.replace(/\n  _Source: .*_/g, "");

    if (estimateTokens(output) > budget) {
      // Pass 2: Remove descriptions
      output = output.replace(/\n  > (?!✅|❌).*$/gm, "");
    }

    if (estimateTokens(output) > budget) {
      // Pass 3: Remove Risks section
      output = output.replace(/## Risks[\s\S]*?(?=\n## |$)/, "");
    }

    if (estimateTokens(output) > budget) {
      // Pass 4: Remove Decision Trail
      output = output.replace(/## Decision Trail[\s\S]*?(?=\n## |$)/, "");
    }

    if (estimateTokens(output) > budget) {
      // Pass 5: Truncate to budget with indicator
      const cutLen = budget * 4;
      output =
        output.slice(0, cutLen) +
        "\n\n_[Context truncated to fit token budget]_";
    }
  }

  return output;
}

/**
 * Format a ContextBundle as JSON.
 */
export function formatContextJson(bundle: ContextBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
