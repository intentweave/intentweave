// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared LLM helpers for server-open routes.
 *
 * Provides:
 *  - Graph schema constant (fed to the LLM for Cypher generation)
 *  - System prompt builders for NL→Cypher and summarisation
 *  - `createLlmCompleter()` factory that wraps `@intentweave/analyzer/llm`
 *  - `llmComplete()` convenience function for single completions
 */

import type { ServerConfig } from "@intentweave/server-core";

// =============================================================================
// Graph schema description (fed to the LLM for Cypher generation)
// =============================================================================

export const GRAPH_SCHEMA = `
## Neo4j Knowledge-Graph Schema

### Node labels

1. **:Canon:Entity**
   Every canonical entity extracted by the KX stage.
   Properties:
     - canonId   (string, unique per session)  — e.g. "schema_free_extraction"
     - name      (string)                      — human-readable label
     - type      (string)                      — one of: concept, decision, option, requirement,
                                                  feature, component, technology, resource, role,
                                                  risk, phase, constraint, question, tradeoff
     - aliases   (string[])                    — alternate surface forms
     - confidence (float 0-1)
     - session_id (string)                     — workspace / session scope
     - run_id     (string)
     - workspace_id (string)
     - track      (string)                     — always "open"

2. **:RawTriple**
   Every raw (pre-canonicalization) triple from the FX stage.
   Properties:
     - subject      (string)
     - predicate    (string)
     - object       (string)
     - subjectKind  (string)
     - objectKind   (string)
     - confidence   (float 0-1)
     - rationale    (string)
     - session_id   (string)
     - run_id       (string)

### Relationships between :Canon:Entity nodes

All canonical relationships are stored as **:CANON_REL** edges with a
\`predicate\` property that holds the semantic relationship type.

Canonical predicates (stored in r.predicate):
  Structural:  CONTAINS, DEPENDS_ON, ALTERNATIVE_TO
  Behavioral:  HAS_STATE, TRANSITIONS_TO, TRIGGERS
  Decision:    DECIDED_FOR, DECIDED_AGAINST, SUPERSEDES, MOTIVATED_BY,
               ENABLES, BLOCKS, RISKS, DEFERRED_TO
  Interaction: CALLS, USES, PRODUCES, CONSUMES
  Fallback:    RELATED_TO

**Example relationship queries:**
  // Find all "DECIDED_FOR" relationships:
  MATCH (a:Canon)-[r:CANON_REL {predicate: "DECIDED_FOR"}]->(b:Canon) ...

  // Find all relationships for a concept:
  MATCH (a:Canon)-[r:CANON_REL]->(b:Canon) WHERE toLower(a.name) CONTAINS "..." ...

  // Find by multiple predicates:
  MATCH (a:Canon)-[r:CANON_REL]->(b:Canon) WHERE r.predicate IN ["ENABLES","BLOCKS"] ...

### Other relationships

  (:RawTriple)-[:CANONICALIZED_FROM { role: "subject"|"object" }]->(:Canon:Entity)

### Important notes
- Always filter by session_id when the user mentions a workspace.
- Relationship predicates are stored in the \`predicate\` property of :CANON_REL, NOT as separate relationship types.
- Use OPTIONAL MATCH when relationships might not exist.
- Return human-readable columns (name, type) rather than raw IDs.
- When asked about decisions, use predicate "DECIDED_FOR" or "DECIDED_AGAINST".
`.trim();

// =============================================================================
// System prompts
// =============================================================================

/**
 * Build the system prompt for NL→Cypher translation.
 */
export function buildCypherSystemPrompt(sessionId?: string): string {
  const sessionClause = sessionId
    ? `\nThe current session_id is "${sessionId}". Always include \`WHERE ... session_id = "${sessionId}"\` unless the user explicitly asks for cross-session results.`
    : "";

  return `You are a Cypher query generator for a Neo4j knowledge graph.

${GRAPH_SCHEMA}
${sessionClause}

Rules:
1. Output ONLY the Cypher query — no explanation, no markdown fences, no preamble.
2. Always RETURN useful columns (name, type, relationship type, etc.).
3. Every column alias must be unique — NEVER duplicate AS names.
4. Respect the --limit the user provides (append LIMIT <n> if not already present).
5. Use case-insensitive matching (toLower / CONTAINS) for name searches.
6. If the user's question cannot be answered from the schema, return a comment line starting with // explaining why.
`;
}

/**
 * System prompt for summarising raw Cypher query results.
 */
export const SUMMARISE_SYSTEM = `You are a concise knowledge-graph analyst.
Given a user question and the raw query results (JSON rows), produce a short,
well-structured answer in Markdown. Use bullet lists for multiple items.
If results are empty, say "No results found." and suggest a refined query.
Do NOT fabricate data beyond what the results contain.`;

// =============================================================================
// LLM helpers
// =============================================================================

/** Options for a single LLM completion. */
export interface LlmCompleteOpts {
  system: string;
  userMessage: string;
}

/**
 * Create an LLM completion function from the server config.
 * Returns undefined if no LLM provider is configured.
 */
export function createLlmComplete(
  config: ServerConfig,
): ((opts: LlmCompleteOpts) => Promise<string>) | undefined {
  if (!config.llm) return undefined;

  const { provider, apiKey, model } = config.llm;

  return async (opts: LlmCompleteOpts): Promise<string> => {
    if (provider === "openai") {
      const { OpenAILLMProvider } = await import("@intentweave/analyzer/llm");
      if (!apiKey) {
        throw new Error(
          "OpenAI API key required. Set OPENAI_API_KEY environment variable.",
        );
      }
      const llmProvider = new OpenAILLMProvider({
        apiKey,
        model: model ?? "gpt-4o-mini",
        timeoutMs: 30_000,
      });
      const response = await llmProvider.complete({
        system: opts.system,
        messages: [{ role: "user", content: opts.userMessage }],
        temperature: 0,
        maxTokens: 2048,
      });
      if (response.finishReason === "error") {
        throw new Error(`LLM error: ${response.error}`);
      }
      return response.content.trim();
    }

    if (provider === "smart-mock") {
      const { SmartMockLLMProvider } =
        await import("@intentweave/analyzer/llm");
      const llmProvider = new SmartMockLLMProvider();
      const response = await llmProvider.complete({
        system: opts.system,
        messages: [{ role: "user", content: opts.userMessage }],
        temperature: 0,
        maxTokens: 2048,
      });
      return response.content.trim();
    }

    throw new Error(`Unknown LLM provider: ${provider}`);
  };
}
