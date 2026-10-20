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

import { ObservationStore, fingerprint } from "@intentweave/index";
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
  // Canonical JSON rejects undefined, so optional fields are dropped, not set.
  return JSON.parse(JSON.stringify({ framework, ...observation })) as Record<
    string,
    unknown
  >;
}

/**
 * Read the endpoint observations of one run, in the order the run recorded them. The
 * Candidate path is derived from these, not from a fresh discovery pass.
 */
export function readEndpointObservations(
  database: Database.Database,
  runId: string,
): EndpointObservation[] {
  return new ObservationStore(database)
    .runItemPayloads(runId)
    .map((payload) => {
      const { framework: _framework, ...observation } = payload as Record<
        string,
        unknown
      >;
      return observation as unknown as EndpointObservation;
    });
}

/**
 * The run label for one discovery outcome. Runs are keyed by revision, and the revision
 * is HEAD, which does not change with working-tree edits. The content fingerprint keeps
 * an edited workspace from reusing a stale run.
 */
export function contentRevisionLabel(
  repositoryRevision: string,
  records: readonly EndpointProducerRecordInput[],
): string {
  const content = [...records]
    .sort((a, b) => a.identityKey.localeCompare(b.identityKey))
    .map((record) => ({
      identityKey: record.identityKey,
      payload: record.payload,
    }));
  return `${repositoryRevision}+${fingerprint({ content })}`;
}

/** Fastify identity: one route registration site, unique within the repository. */
export function fastifyRouteIdentityKey(
  observation: EndpointObservation,
): string {
  return `endpoint-route:fastify:${observation.filePath}#${observation.line}:${observation.method}:${observation.routePath}`;
}

/** NestJS identity: one route on one handler method in one file. */
export function nestHandlerIdentityKey(
  observation: EndpointObservation,
): string {
  return `endpoint-handler:nest:${observation.filePath}#${observation.controllerName}.${observation.handlerName}:${observation.method}:${observation.routePath}`;
}
