// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-Layer Graph Schema Description
 *
 * Shared schema description for the IntentWeave knowledge graph, covering
 * all five layers (KWG, TCG, Drift, SKG, Code) and cross-layer links.
 * Used by both the CLI query command and the MCP server.
 *
 * @see PHASE-D-SPEC.md §5 (D3: Multi-Layer Schema)
 * @version 0.1
 */

// =============================================================================
// Full multi-layer schema (for NL → Cypher generation)
// =============================================================================

export const MULTI_LAYER_SCHEMA = `
## Neo4j Knowledge-Graph Schema — Multi-Layer

IntentWeave stores a **6-layer graph**. Each layer is produced by a different
pipeline stage. Cross-layer edges connect them.

---

### Layer 1: KWG (Keyword Graph) — $0 evidence layer
Produced by: \`iw build cheap\` (no LLM cost)

**Nodes:**
- **:KWEntity** — keyword entities extracted from documents
  Properties: name, mentionCount, session_id
- **:KWDoc** — documents that mention entities
  Properties: name, filePath, session_id
- **:KWCluster** — topic clusters of co-occurring entities
  Properties: clusterId, label, members (string[]), size, session_id

**Relationships:**
- \`(:KWEntity)-[:CO_OCCURS {weight}]->(:KWEntity)\` — co-occurrence in same chunk
- \`(:KWDoc)-[:MENTIONS {count}]->(:KWEntity)\` — document mentions entity
- \`(:KWCluster)-[:CONTAINS]->(:KWEntity)\` — cluster membership
- \`(:KWDoc)-[:IN_CLUSTER]->(:KWCluster)\` — document belongs to cluster

---

### Layer 2: TCG (Temporal Co-change Graph) — git history layer
Produced by: \`iw build cheap\` (git log analysis)

**Nodes:**
- **:TCGCommit** — git commits
  Properties: sha, message, authorName, authorEmail, date, session_id
- **:TCGFile** — files tracked in git
  Properties: filePath, session_id
- **:TCGAuthor** — commit authors
  Properties: name, email, session_id

**Relationships:**
- \`(:TCGCommit)-[:TOUCHED]->(:TCGFile)\` — commit modified file
- \`(:TCGAuthor)-[:AUTHORED]->(:TCGCommit)\` — author made commit
- \`(:TCGFile)-[:CO_CHANGED {weight}]->(:TCGFile)\` — files changed together

---

### Layer 3: Drift Signals — staleness/divergence layer
Produced by: \`iw build cheap\` (drift detectors)

**Nodes:**
- **:DriftSignal** — staleness/divergence signals
  Properties: id, name, detector, severity, message, category, files (string[]), session_id, createdAt

**Relationships:**
- \`(:DriftSignal)-[:ABOUT]->(:KWEntity)\` — drift signal about a KWG entity
- \`(:DriftSignal)-[:AFFECTS]->(:KWDoc)\` — drift signal affects a document
- \`(:DriftSignal)-[:AFFECTS]->(:TCGFile)\` — drift signal affects a file

Detectors: doc-code (documentation vs code drift), doc-doc (cross-document contradictions), deps (dependency issues)
Severities: critical, warning, info

---

### Layer 4: SKG (Semantic Knowledge Graph) — LLM-extracted layer
Produced by: \`iw run\` / \`iw build full\` (LLM extraction)

**Nodes:**
- **:Canon:Entity** — canonical entities extracted by LLM
  Properties: canonId, name, type, aliases (string[]), confidence (float 0-1), session_id, run_id, track
- **:RawTriple** — pre-canonicalization triples from LLM
  Properties: subject, predicate, object, subjectKind, objectKind, confidence, rationale, session_id, run_id

**Relationships:**
- \`(:Canon:Entity)-[:CANON_REL {predicate}]->(:Canon:Entity)\` — semantic relationships
  Predicates (stored in \`predicate\` property):
    Structural:  CONTAINS, DEPENDS_ON, ALTERNATIVE_TO
    Behavioral:  HAS_STATE, TRANSITIONS_TO, TRIGGERS
    Decision:    DECIDED_FOR, DECIDED_AGAINST, SUPERSEDES, MOTIVATED_BY, ENABLES, BLOCKS, RISKS, DEFERRED_TO
    Interaction: CALLS, USES, PRODUCES, CONSUMES
    Fallback:    RELATED_TO
- \`(:RawTriple)-[:CANONICALIZED_FROM {role}]->(:Canon:Entity)\` — provenance

Entity types: concept, decision, option, requirement, feature, component, technology, resource, role, risk, phase, constraint, question, tradeoff

---

### Layer 5: SCG (Static Code Graph) — code structure layer
Produced by: \`iw build scg\` / \`iw build cheap\` (ast-extractor)

**Nodes:**
- **:SCG:Dir** — directory nodes in the workspace tree
  Properties: filePath, session_id, createdAt
- **:SCG:File** — source files with extracted symbols
  Properties: filePath, language, contentHash, symbolCount, session_id, createdAt
- **:SCG:Symbol** — code symbols (functions, classes, methods, variables, types, etc.)
  Properties: symbolId, name, kind, container, signature, filePath, export, startLine, startCol, endLine, endCol, parameters, docSummary, session_id, createdAt
  Kinds: function, class, method, variable, type, interface, enum, struct, protocol, property, constructor

**Relationships:**
- \`(:SCG:Dir)-[:SCG_CONTAINS]->(:SCG:Dir)\` — directory contains subdirectory
- \`(:SCG:Dir)-[:SCG_CONTAINS]->(:SCG:File)\` — directory contains file
- \`(:SCG:File)-[:SCG_CONTAINS]->(:SCG:Symbol)\` — file contains top-level symbol
- \`(:SCG:Symbol)-[:SCG_CONTAINS]->(:SCG:Symbol)\` — class/interface contains method/property

---

### Layer 6: Code References — cross-layer code links
Produced by: \`iw xlink\` / \`iw build full\`

**Nodes:**
- **:CodeRef** — code references linked to Canon entities
  Properties: filePath, name, kind, language, session_id
  Kinds: package-dep, import, symbol, file, directory

**Relationships:**
- \`(:Canon:Entity)-[:REALIZED_BY {strategy, confidence, detail}]->(:CodeRef)\` — semantic-to-code link
  Strategies: dep (package.json), import (source imports), name (exported symbols), path (file paths)

---

### Cross-Layer Links

- \`(:Canon:Entity)-[:EVIDENCED_BY {mentionCount, driftCount, confidence}]->(:KWEntity)\`
  Links SKG Canon entities to their KWG evidence (name/alias matching)
- \`(:Canon:Entity)-[:REALIZED_BY]->(:CodeRef)\`
  Links SKG Canon entities to code references
- \`(:Canon:Entity)-[:REALIZED_BY]->(:SCG:Symbol)\`
  Links SKG Canon entities to SCG code symbols (future)
- \`(:DriftSignal)-[:ABOUT]->(:KWEntity)\`
  Links drift signals to the KWG entities they concern
- \`(:DriftSignal)-[:AFFECTS]->(:KWDoc)\`
  Links drift signals to affected documents
- \`(:DriftSignal)-[:AFFECTS]->(:TCGFile)\`
  Links drift signals to affected files

---

### Query patterns

**KWG queries:**
  MATCH (e:KWEntity {session_id: $sid}) WHERE e.mentionCount > 5 RETURN e.name, e.mentionCount ORDER BY e.mentionCount DESC
  MATCH (a:KWEntity)-[co:CO_OCCURS]->(b:KWEntity) WHERE a.session_id = $sid RETURN a.name, b.name, co.weight ORDER BY co.weight DESC
  MATCH (cl:KWCluster {session_id: $sid}) RETURN cl.label, cl.size, cl.members ORDER BY cl.size DESC

**TCG queries:**
  MATCH (c:TCGCommit {session_id: $sid}) RETURN c.message, c.date ORDER BY c.date DESC LIMIT 20
  MATCH (a:TCGFile)-[cc:CO_CHANGED]->(b:TCGFile) WHERE a.session_id = $sid RETURN a.filePath, b.filePath, cc.weight ORDER BY cc.weight DESC

**Drift queries:**
  MATCH (d:DriftSignal {session_id: $sid}) WHERE d.severity = 'critical' RETURN d.name, d.message, d.detector
  MATCH (d:DriftSignal {session_id: $sid})-[:ABOUT]->(e:KWEntity) RETURN e.name, count(d) as driftCount ORDER BY driftCount DESC

**SKG queries:**
  MATCH (a:Canon:Entity {session_id: $sid})-[r:CANON_REL {predicate: "DECIDED_FOR"}]->(b:Canon:Entity) RETURN a.name, b.name
  MATCH (a:Canon:Entity)-[r:CANON_REL]->(b:Canon:Entity) WHERE a.session_id = $sid RETURN a.name, r.predicate, b.name

**SCG queries:**
  MATCH (f:SCG:File {session_id: $sid}) RETURN f.filePath, f.language, f.symbolCount ORDER BY f.symbolCount DESC
  MATCH (s:SCG:Symbol {session_id: $sid}) WHERE s.kind = 'class' RETURN s.name, s.filePath, s.export
  MATCH (f:SCG:File {session_id: $sid})-[:SCG_CONTAINS]->(s:SCG:Symbol) RETURN f.filePath, collect(s.name) AS symbols
  MATCH (cls:SCG:Symbol {kind: 'class', session_id: $sid})-[:SCG_CONTAINS]->(m:SCG:Symbol) RETURN cls.name, m.name, m.kind

**Cross-layer queries:**
  MATCH (c:Canon:Entity {session_id: $sid})-[ev:EVIDENCED_BY]->(e:KWEntity) RETURN c.name, e.name, ev.mentionCount, ev.confidence ORDER BY ev.confidence DESC
  MATCH (d:DriftSignal {session_id: $sid})-[:ABOUT]->(e:KWEntity)<-[:EVIDENCED_BY]-(c:Canon:Entity) RETURN c.name, d.severity, d.message
  MATCH (c:Canon:Entity {session_id: $sid}), (s:SCG:Symbol {session_id: $sid}) WHERE toLower(c.name) CONTAINS toLower(s.name) RETURN c.name AS canon, s.name AS symbol, s.kind, s.filePath

### Important notes
- Always filter by session_id when the user mentions a workspace.
- Relationship predicates on CANON_REL are stored in the \`predicate\` property, NOT as separate relationship types.
- Use OPTIONAL MATCH when relationships might not exist.
- Return human-readable columns (name, type) rather than raw IDs.
- When asked about decisions, use predicate "DECIDED_FOR" or "DECIDED_AGAINST".
- For evidence queries, join through EVIDENCED_BY to connect SKG ↔ KWG layers.
`.trim();

// =============================================================================
// Compact schema (for MCP tool description, token-efficient)
// =============================================================================

export const COMPACT_SCHEMA = `
Neo4j Multi-Layer Graph Schema:

Layer 1 — KWG (Keywords):
  :KWEntity (name, mentionCount, session_id)
  :KWDoc (name, filePath, session_id)
  :KWCluster (clusterId, label, members[], size, session_id)
  Edges: CO_OCCURS, MENTIONS, CONTAINS, IN_CLUSTER

Layer 2 — TCG (Temporal):
  :TCGCommit (sha, message, authorName, date, session_id)
  :TCGFile (filePath, session_id)
  :TCGAuthor (name, email, session_id)
  Edges: TOUCHED, AUTHORED, CO_CHANGED

Layer 3 — Drift:
  :DriftSignal (id, name, detector, severity, message, category, files[], session_id)
  Edges: ABOUT→KWEntity, AFFECTS→KWDoc, AFFECTS→TCGFile
  Detectors: doc-code, doc-doc, deps  |  Severities: critical, warning, info

Layer 4 — SKG (Semantic):
  :Canon:Entity (canonId, name, type, aliases[], confidence, session_id)
  :RawTriple (subject, predicate, object, confidence, session_id)
  Edges: CANON_REL {predicate}, CANONICALIZED_FROM {role}
  Predicates: CONTAINS, DEPENDS_ON, DECIDED_FOR, DECIDED_AGAINST, ENABLES, BLOCKS, CALLS, USES, RELATED_TO, ...
  Entity types: concept, decision, option, requirement, feature, component, technology, resource, role, risk, phase, constraint, question, tradeoff

Layer 5 — SCG (Static Code Graph):
  :SCG:Dir (filePath, session_id)
  :SCG:File (filePath, language, contentHash, symbolCount, session_id)
  :SCG:Symbol (symbolId, name, kind, container, signature, filePath, export, startLine, endLine, session_id)
  Edges: SCG_CONTAINS (Dir→Dir, Dir→File, File→Symbol, Symbol→Symbol)

Layer 6 — Code References:
  :CodeRef (filePath, name, kind, language, session_id)
  Edges: REALIZED_BY {strategy, confidence}

Cross-Layer:
  EVIDENCED_BY (Canon→KWEntity, mentionCount, driftCount, confidence)
  REALIZED_BY (Canon→CodeRef, strategy, confidence)
  ABOUT (DriftSignal→KWEntity)
  AFFECTS (DriftSignal→KWDoc, DriftSignal→TCGFile)
`.trim();

// =============================================================================
// Layer filter (for --layer routing)
// =============================================================================

export type GraphLayer = "kwg" | "tcg" | "drift" | "skg" | "scg" | "code" | "all";

export const LAYER_LABELS: Record<Exclude<GraphLayer, "all">, string[]> = {
  kwg: ["KWEntity", "KWDoc", "KWCluster"],
  tcg: ["TCGCommit", "TCGFile", "TCGAuthor"],
  drift: ["DriftSignal"],
  skg: ["Canon", "RawTriple"],
  scg: ["SCG:Dir", "SCG:File", "SCG:Symbol"],
  code: ["CodeRef"],
};

/**
 * Build a schema subset for a specific layer (or the full schema).
 */
export function getSchemaForLayer(layer: GraphLayer): string {
  if (layer === "all") return MULTI_LAYER_SCHEMA;
  // For layer-specific queries, still return full schema but add a focus hint
  return `${MULTI_LAYER_SCHEMA}\n\n**FOCUS: The user is asking about the ${layer.toUpperCase()} layer. Prefer nodes/relationships from that layer unless cross-layer joins are needed.**`;
}
