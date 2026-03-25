// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CLX Stage — Clustering
 *
 * Groups co-occurring entities into concept clusters using connected
 * components (BFS). Elects envelope entities (highest-degree member).
 * Runs at session level after COX.
 *
 * Algorithm:
 *   1. Build adjacency list from co-occurrence edges
 *   2. BFS to find connected components
 *   3. Filter: keep components with >= minSize members
 *   4. For each component: elect envelope (highest degree), count edges
 *   5. Return EntityCluster[]
 *
 * Connected-component clustering is the only algorithm in v1. Leiden/Louvain
 * (via Neo4j GDS) is a v2 concern.
 *
 * @version 0.1
 */

import type {
  ClxStageInput,
  ClxStageOutput,
  CoOccurrenceEdge,
  EntityCluster,
} from "@intentweave/core";
import { KWG_SCHEMAS, CURRENT_SCHEMA_VERSION } from "@intentweave/core";
import type { PipelineLogger } from "../pipeline/context.js";

// =============================================================================
// Constants
// =============================================================================

/** Minimum cluster size (components with fewer members are dropped) */
const MIN_CLUSTER_SIZE = 2;

// =============================================================================
// Connected Components
// =============================================================================

/**
 * Build an adjacency list from co-occurrence edges.
 */
function buildAdjacencyList(
  edges: CoOccurrenceEdge[],
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();

  const ensure = (node: string) => {
    if (!adj.has(node)) adj.set(node, new Set());
  };

  for (const edge of edges) {
    ensure(edge.entityA);
    ensure(edge.entityB);
    adj.get(edge.entityA)!.add(edge.entityB);
    adj.get(edge.entityB)!.add(edge.entityA);
  }

  return adj;
}

/**
 * Find connected components using BFS.
 * Returns an array of components (each component is a set of entity names).
 */
function findConnectedComponents(adj: Map<string, Set<string>>): Set<string>[] {
  const visited = new Set<string>();
  const components: Set<string>[] = [];

  for (const node of adj.keys()) {
    if (visited.has(node)) continue;

    // BFS from this node
    const component = new Set<string>();
    const queue: string[] = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.add(current);

      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    components.push(component);
  }

  return components;
}

// =============================================================================
// Cluster Detection
// =============================================================================

/**
 * Detect clusters from co-occurrence edges.
 *
 * Plain function — not an interface. Connected-component clustering is the
 * only algorithm in v1.
 */
function detectClusters(
  edges: CoOccurrenceEdge[],
  allEntityNames: Set<string>,
): { clusters: EntityCluster[]; unclustered: string[] } {
  const adj = buildAdjacencyList(edges);
  const components = findConnectedComponents(adj);

  // Compute degree for envelope election
  const degree = new Map<string, number>();
  for (const [node, neighbors] of adj) {
    degree.set(node, neighbors.size);
  }

  // Build edge lookup for internal/external edge counting
  const edgeSet = new Set<string>();
  for (const edge of edges) {
    edgeSet.add(`${edge.entityA}|||${edge.entityB}`);
  }

  const clusters: EntityCluster[] = [];
  const clusteredEntities = new Set<string>();
  let clusterIndex = 0;

  for (const component of components) {
    if (component.size < MIN_CLUSTER_SIZE) continue;

    const members = [...component].sort();

    // Elect envelope: highest degree in the co-occurrence graph
    let envelope = members[0];
    let maxDegree = 0;
    for (const member of members) {
      const d = degree.get(member) ?? 0;
      if (d > maxDegree) {
        maxDegree = d;
        envelope = member;
      }
    }

    // Count internal and external edges
    let internalEdges = 0;
    let externalEdges = 0;
    for (const member of members) {
      for (const neighbor of adj.get(member) ?? []) {
        const [a, b] =
          member < neighbor ? [member, neighbor] : [neighbor, member];
        const key = `${a}|||${b}`;
        if (!edgeSet.has(key)) continue;

        if (component.has(neighbor)) {
          internalEdges++;
        } else {
          externalEdges++;
        }
      }
    }
    // Each internal edge was counted twice (from both endpoints)
    internalEdges = Math.floor(internalEdges / 2);

    clusterIndex++;
    clusters.push({
      id: `cluster-${clusterIndex}`,
      label: envelope,
      members,
      envelope,
      internalEdges,
      externalEdges,
    });

    for (const member of members) {
      clusteredEntities.add(member);
    }
  }

  // Find unclustered entities (singletons not in any component with >= minSize)
  const unclustered: string[] = [];
  for (const entity of allEntityNames) {
    if (!clusteredEntities.has(entity)) {
      unclustered.push(entity);
    }
  }
  unclustered.sort();

  return { clusters, unclustered };
}

// =============================================================================
// CLX Stage
// =============================================================================

/**
 * Run the CLX (clustering) stage at session level.
 *
 * @param input   CLX stage input (COX output + KWX outputs)
 * @param ctx     Optional pipeline context (for logging)
 * @returns       CLX stage output with clusters and singletons
 */
export async function runClxStage(
  input: ClxStageInput,
  ctx?: { logger?: PipelineLogger },
): Promise<ClxStageOutput> {
  const start = performance.now();
  const logger = ctx?.logger;

  // Collect all unique entity names from KWX outputs
  const allEntityNames = new Set<string>();
  for (const kwxOutput of input.kwxOutputs) {
    for (const entity of kwxOutput.entities) {
      allEntityNames.add(entity.name);
    }
  }

  logger?.info(
    `CLX: clustering ${allEntityNames.size} entities from ${input.coxOutput.edges.length} edges`,
  );

  const { clusters, unclustered } = detectClusters(
    input.coxOutput.edges,
    allEntityNames,
  );

  const clusteredEntityCount = clusters.reduce(
    (sum, c) => sum + c.members.length,
    0,
  );

  const processingTimeMs = Math.round(performance.now() - start);

  logger?.info(`CLX: done`, {
    clusters: clusters.length,
    clustered: clusteredEntityCount,
    unclustered: unclustered.length,
    timeMs: processingTimeMs,
  });

  return {
    $schema: KWG_SCHEMAS.clx,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stage: "CLX",
    processedAt: new Date().toISOString(),
    clusters,
    unclustered,
    meta: {
      clusterCount: clusters.length,
      clusteredEntityCount,
      unclusteredEntityCount: unclustered.length,
      processingTimeMs,
    },
  };
}
