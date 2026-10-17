// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Endpoint discoverers as observation producers (Phase O3, option B).
 *
 * Each NestJS and Fastify discovery run also records an observation run in the
 * observation layer. Route-level observations use the `call-site` kind for Fastify
 * route registrations and the `symbol` kind for NestJS handlers. Their identity keys
 * use their own namespace (`endpoint-route:`, `endpoint-handler:`), so they never
 * collide with the inventory identities of the TypeScript adapter.
 *
 * The run is a dual write. Candidate persistence does not read it, so Candidate and
 * Assessment outcomes are unchanged. Coverage is complete over the files the
 * discoverer scanned, and `unsupported` when its framework is not in use.
 */

import { ObservationStore } from "@intentweave/index";
import type Database from "@intentweave/sqlite-compat";
import type { EndpointObservation } from "./endpointCandidatePersistence.js";

export interface EndpointProducerRecordInput {
  identityKey: string;
  filePath: string;
  line: number;
  endLine: number;
  payload: Record<string, unknown>;
}

export interface EndpointObservationRunInput {
  adapterId: string;
  contractVersion: string;
  /** The observation kind the route-level records use. */
  kind: "call-site" | "symbol";
  repositoryRevision: string;
  scopeFiles: readonly string[];
  description: string;
  records: readonly EndpointProducerRecordInput[];
  /** Set when the framework is not in use; coverage is then `unsupported`. */
  unsupportedReason?: string;
}

/** Record one endpoint discovery run. Returns the observation run id. */
export function recordEndpointObservationRun(
  database: Database.Database,
  input: EndpointObservationRunInput,
): string {
  const store = new ObservationStore(database);
  const scopeFiles = [...new Set(input.scopeFiles)].sort();
  if (input.unsupportedReason) {
    return store.recordRun({
      adapterId: input.adapterId,
      adapterContractVersion: input.contractVersion,
      scope: { files: scopeFiles, description: input.description },
      repositoryRevision: input.repositoryRevision,
      coverage: [
        {
          kind: input.kind,
          status: "unsupported",
          reason: input.unsupportedReason,
          objectCount: 0,
        },
      ],
      records: [],
    });
  }

  // Identity keys are unique within one run, so a repeated key keeps its first record.
  const unique = new Map<string, EndpointProducerRecordInput>();
  for (const record of input.records) {
    if (!unique.has(record.identityKey)) unique.set(record.identityKey, record);
  }
  return store.recordRun({
    adapterId: input.adapterId,
    adapterContractVersion: input.contractVersion,
    scope: { files: scopeFiles, description: input.description },
    repositoryRevision: input.repositoryRevision,
    coverage: [
      {
        kind: input.kind,
        status: "complete",
        objectCount: unique.size,
      },
    ],
    records: [...unique.values()].map((record) => ({
      kind: input.kind,
      identityKey: record.identityKey,
      locator: {
        filePath: record.filePath,
        line: record.line,
        endLine: record.endLine,
      },
      payload: record.payload,
    })),
  });
}

/** Payload shared by both frameworks: the route facts the Candidate path also uses. */
export function endpointPayload(
  framework: string,
  observation: EndpointObservation,
): Record<string, unknown> {
  return {
    framework,
    method: observation.method,
    routePath: observation.routePath,
    routeKnown: observation.routeKnown,
    controllerName: observation.controllerName,
    handlerName: observation.handlerName,
    guards: observation.guards,
    guardSource: observation.guardSource,
    publicExemption: observation.publicExemption,
    ambiguous: observation.ambiguous,
  };
}

/** Fastify identity: one route registration site, unique within the repository. */
export function fastifyRouteIdentityKey(
  observation: EndpointObservation,
): string {
  return `endpoint-route:fastify:${observation.filePath}#${observation.line}:${observation.method}:${observation.routePath}`;
}

/** NestJS identity: one handler method in one file. */
export function nestHandlerIdentityKey(
  observation: EndpointObservation,
): string {
  return `endpoint-handler:nest:${observation.filePath}#${observation.controllerName}.${observation.handlerName}`;
}
