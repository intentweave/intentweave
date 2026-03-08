// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Smart Mock LLM Provider
 *
 * Deterministic provider that performs basic keyword-based extraction
 * for testing without requiring real LLM API calls.
 */

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMProviderCapabilities,
} from "@intentweave/core";
import { buildCgId } from "@intentweave/core";

/**
 * Smart Mock configuration
 */
export interface SmartMockConfig {
  /** Whether to capture requests for debugging */
  captureRequests?: boolean;
  /** Simulated latency in ms */
  latencyMs?: number;
  /** Workspace key for cgId generation */
  workspaceKey?: string;
  /** Whether to enable verbose debug logging (default: false) */
  debug?: boolean;
}

/** Debug logger that only logs when DEBUG_SMART_MOCK env var is set */
const debugLog = process.env.DEBUG_SMART_MOCK
  ? console.log.bind(console)
  : () => {};

/**
 * Smart Mock LLM Provider
 *
 * Performs basic rule-based extraction:
 * - Identifies entities from common patterns
 * - Extracts relationships from markdown structure
 * - Generates deterministic cgIds
 */
export class SmartMockLLMProvider implements LLMProvider {
  readonly name = "smart-mock";

  private readonly config: SmartMockConfig;
  private readonly capturedRequests: LLMRequest[] = [];

  constructor(config: SmartMockConfig = {}) {
    this.config = {
      captureRequests: config.captureRequests ?? false,
      latencyMs: config.latencyMs ?? 5,
      workspaceKey: config.workspaceKey ?? "test-workspace",
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  get capabilities(): LLMProviderCapabilities {
    return {
      maxInputTokens: 128000,
      supportsJsonSchema: true,
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsEmbeddings: false,
    };
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();

    if (this.config.captureRequests) {
      this.capturedRequests.push(structuredClone(request));
    }

    // Simulate latency
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.latencyMs),
      );
    }

    // Extract text content from messages
    const textContent = request.messages.map((m) => m.content).join("\n");

    // Perform smart extraction
    const extracted = this.extractFromText(textContent);

    debugLog("[SmartMock] Extraction complete, about to stringify...");

    try {
      const content = JSON.stringify(extracted, null, 2);
      debugLog("[SmartMock] Stringify successful");

      return {
        content,
        parsed: request.responseSchema ? extracted : undefined,
        tokensUsed: {
          prompt: Math.ceil(textContent.length / 4),
          completion: Math.ceil(content.length / 4),
        },
        latencyMs: Date.now() - startTime,
        model: "smart-mock",
        finishReason: "stop",
      };
    } catch (error) {
      console.error("[SmartMock] Error during stringify:", error);
      throw error;
    }
  }

  /**
   * Extract entities and statements from text using rules
   */
  private extractFromText(text: string): {
    entities: Array<{
      cgId: string;
      name: string;
      kind: string;
      description?: string;
      confidence?: number;
      evidenceSpan?: { start: number; end: number };
    }>;
    statements: Array<{
      sourceCgId: string;
      predicate: string;
      targetCgId: string;
      confidence?: number;
      evidenceSpan?: { start: number; end: number };
    }>;
  } {
    const entities: any[] = [];
    const statements: any[] = [];

    try {
      // Extract roles (workspace:owner, project:maintainer, etc.)
      const rolePattern = /([a-z]+):([a-z_-]+)/gi;
      let match;
      while ((match = rolePattern.exec(text)) !== null) {
        try {
          const scope = match[1];
          const roleName = match[2];

          // Defensive: ensure all values are strings
          if (
            !scope ||
            !roleName ||
            typeof scope !== "string" ||
            typeof roleName !== "string"
          ) {
            continue;
          }

          const fullName = `${scope}:${roleName}`;

          if (!entities.some((e) => e.name === fullName)) {
            // Debug: log types before buildCgId call
            const entityType = "role";
            const segment = fullName;
            const rootValue = this.config.workspaceKey;

            debugLog(`[SmartMock Debug] buildCgId args:`, {
              entityType,
              entityTypeType: typeof entityType,
              segment,
              segmentType: typeof segment,
              rootValue,
              rootValueType: typeof rootValue,
            });

            entities.push({
              cgId: buildCgId(entityType, segment, {
                root: rootValue,
                kind: "role",
              }),
              name: fullName,
              kind: "role",
              description: `${roleName} at ${scope} level`,
              confidence: 0.9,
            });
          }
        } catch (roleError) {
          console.error(
            `[SmartMock] Error building cgId for role "${match[1]}:${match[2]}":`,
            roleError,
          );
          throw roleError;
        }
      }

      // Extract actions (read, write, delete, admin, create, manage, etc.)
      const actionWords = [
        "read",
        "write",
        "delete",
        "admin",
        "create",
        "manage",
        "view",
        "edit",
        "approve",
        "assign",
        "remove",
        "update",
      ];
      for (const action of actionWords) {
        // Defensive: ensure action is a string
        if (!action || typeof action !== "string") continue;

        const regex = new RegExp(`\\b${action}\\b`, "gi");
        if (regex.test(text)) {
          if (!entities.some((e) => e.name === action)) {
            debugLog(`[SmartMock Debug Action] buildCgId args:`, {
              entityType: "action",
              segment: action,
              segmentType: typeof action,
              rootValue: this.config.workspaceKey,
              rootType: typeof this.config.workspaceKey,
            });
            entities.push({
              cgId: buildCgId("action", action, {
                root: this.config.workspaceKey,
                kind: "action",
              }),
              name: action,
              kind: "action",
              description: `${action} action`,
              confidence: 0.85,
            });
          }
        }
      }

      // Extract resources (document, project, workspace, user, member, etc.)
      const resourceWords = [
        "document",
        "project",
        "workspace",
        "user",
        "member",
        "resource",
        "permission",
        "role",
        "assignment",
      ];
      for (const resource of resourceWords) {
        // Defensive: ensure resource is a string
        if (!resource || typeof resource !== "string") continue;

        const regex = new RegExp(`\\b${resource}s?\\b`, "gi");
        if (regex.test(text)) {
          if (!entities.some((e) => e.name === resource)) {
            debugLog(`[SmartMock Debug Resource] buildCgId args:`, {
              entityType: "resource",
              segment: resource,
              segmentType: typeof resource,
              rootValue: this.config.workspaceKey,
              rootType: typeof this.config.workspaceKey,
            });
            entities.push({
              cgId: buildCgId("resource", resource, {
                root: this.config.workspaceKey,
                kind: "resource",
              }),
              name: resource,
              kind: "resource",
              description: `${resource} resource`,
              confidence: 0.8,
            });
          }
        }
      }

      debugLog(`[SmartMock Debug] About to extract states...`);

      // Extract states (pending, approved, active, etc.) - extended list
      const stateWords = [
        "pending",
        "approved",
        "active",
        "inactive",
        "archived",
        "deleted",
        "requested",
        "suspended",
        "retired",
        "completed",
        "draft",
        "published",
      ];
      for (const state of stateWords) {
        debugLog(`[SmartMock Debug] Checking state: ${state}`);
        // Defensive: ensure state is a string
        if (!state || typeof state !== "string") continue;

        const regex = new RegExp(`\\b${state}\\b`, "gi");
        if (regex.test(text)) {
          if (!entities.some((e) => e.name === state)) {
            debugLog(`[SmartMock Debug State] buildCgId args:`, {
              entityType: "state",
              segment: state,
              segmentType: typeof state,
              rootValue: this.config.workspaceKey,
              rootType: typeof this.config.workspaceKey,
            });
            entities.push({
              cgId: buildCgId("state", state, {
                root: this.config.workspaceKey,
                kind: "state",
              }),
              name: state,
              kind: "state",
              description: `${state} state`,
              confidence: 0.75,
            });
          }
        }
      }

      // Extract domain events from camelCase patterns like UserRequested, UserApproved
      const eventPattern = /\b([A-Z][a-z]+[A-Z][a-zA-Z]+)\s*\(/g;
      while ((match = eventPattern.exec(text)) !== null) {
        const eventName = match[1];
        if (!entities.some((e) => e.name === eventName)) {
          entities.push({
            cgId: buildCgId("event", eventName, {
              root: this.config.workspaceKey,
              kind: "event",
            }),
            name: eventName,
            kind: "event",
            description: `${eventName} domain event`,
            confidence: 0.85,
          });
        }
      }

      // Extract actions from dotted patterns like admin.approve, user.login
      const dottedActionPattern = /\b([a-z]+)\.([a-z_]+)\b/gi;
      while ((match = dottedActionPattern.exec(text)) !== null) {
        const actor = match[1];
        const actionName = `${actor}.${match[2]}`;
        if (!entities.some((e) => e.name === actionName)) {
          entities.push({
            cgId: buildCgId("action", actionName, {
              root: this.config.workspaceKey,
              kind: "action",
            }),
            name: actionName,
            kind: "action",
            description: `${actionName} action by ${actor}`,
            confidence: 0.85,
          });
        }
      }

      // Extract requirements from "must", "should", "shall" statements
      const requirementPattern = /(must|should|shall)\s+([^.]+)/gi;
      let reqIndex = 0;
      while ((match = requirementPattern.exec(text)) !== null) {
        const requirement = match[0]?.trim();

        // Defensive: ensure requirement is a string
        if (!requirement || typeof requirement !== "string") continue;

        const shortName = `req-${++reqIndex}`;

        debugLog(`[SmartMock Debug Requirement] buildCgId args:`, {
          entityType: "requirement",
          segment: shortName,
          segmentType: typeof shortName,
          rootValue: this.config.workspaceKey,
          rootType: typeof this.config.workspaceKey,
        });

        entities.push({
          cgId: buildCgId("requirement", shortName, {
            root: this.config.workspaceKey,
            kind: "requirement",
          }),
          name: shortName,
          kind: "requirement",
          description: requirement,
          confidence: 0.7,
        });
      }

      debugLog(
        `[SmartMock Debug] Starting relationship generation... Entities: ${entities.length}`,
      );

      // Generate relationships

      // Pattern: State transitions "from → to (via action)" or "from -> to (via action)"
      const transitionPattern =
        /\b([a-z]+)\s*(?:→|->)\s*([a-z]+)\s*\(via\s+([a-z._]+)\)/gi;
      while ((match = transitionPattern.exec(text)) !== null) {
        const fromState = match[1];
        const toState = match[2];
        const action = match[3];

        const fromEntity = entities.find(
          (e) => e.name === fromState && e.kind === "state",
        );
        const toEntity = entities.find(
          (e) => e.name === toState && e.kind === "state",
        );
        const actionEntity = entities.find((e) => e.name === action);

        // Create TRANSITIONS_TO statement
        if (fromEntity && toEntity) {
          statements.push({
            subject: fromEntity.name,
            predicate: "TRANSITIONS_TO",
            object: toEntity.name,
            confidence: 0.9,
          });
        }

        // Create TRIGGERS statement (action triggers transition)
        if (actionEntity && toEntity) {
          statements.push({
            subject: actionEntity.name,
            predicate: "TRIGGERS",
            object: toEntity.name,
            confidence: 0.85,
          });
        }
      }

      // Pattern: ROLE_CAN action (uppercase pattern like "ROLE_CAN approve")
      const roleCan = /\bROLE_CAN\s+([a-z_]+)/gi;
      while ((match = roleCan.exec(text)) !== null) {
        const actionName = match[1];
        const actionEntity = entities.find(
          (e) => e.name === actionName || e.name.endsWith(`.${actionName}`),
        );

        if (actionEntity) {
          // Find or create a generic "role" entity
          let roleEntity = entities.find((e) => e.kind === "role");
          if (!roleEntity) {
            roleEntity = {
              cgId: buildCgId("role", "authorized-role", {
                root: this.config.workspaceKey,
                kind: "role",
              }),
              name: "authorized-role",
              kind: "role",
              description: "Authorized role",
              confidence: 0.7,
            };
            entities.push(roleEntity);
          }

          statements.push({
            subject: roleEntity.name,
            predicate: "ROLE_CAN",
            object: actionEntity.name,
            confidence: 0.85,
          });
        }
      }

      // Pattern: "role can action" or "role can action resource" (lowercase)
      const canPattern =
        /\b([a-z:_-]+)\s+(?:can|grants?|allows?)\s+([a-z]+)(?:\s+([a-z]+))?\b/gi;
      while ((match = canPattern.exec(text)) !== null) {
        debugLog(`[SmartMock Debug] CAN pattern match:`, {
          role: match[1],
          action: match[2],
          resource: match[3],
        });
        const roleName = match[1];
        const actionName = match[2];
        const resourceName = match[3];

        const roleEntity = entities.find((e) => e.name === roleName);
        const actionEntity = entities.find((e) => e.name === actionName);

        debugLog(`[SmartMock Debug] Entity lookup:`, {
          roleName,
          roleFound: !!roleEntity,
          roleHasCgId: !!roleEntity?.cgId,
          roleCgId: roleEntity?.cgId,
          actionName,
          actionFound: !!actionEntity,
          actionHasCgId: !!actionEntity?.cgId,
          actionCgId: actionEntity?.cgId,
        });

        if (roleEntity && actionEntity) {
          statements.push({
            subject: roleEntity.name,
            predicate: "ROLE_CAN",
            object: actionEntity.name,
            confidence: 0.85,
          });
        }

        // If resource mentioned, add action->resource relationship
        if (resourceName) {
          const resourceEntity = entities.find((e) => e.name === resourceName);
          if (actionEntity && resourceEntity) {
            statements.push({
              subject: actionEntity.name,
              predicate: "ACTS_ON",
              object: resourceEntity.name,
              confidence: 0.8,
            });
          }
        }
      }

      debugLog(`[SmartMock Debug] Starting INHERITS pattern...`);

      // Pattern: "inherits from" or "inherits permissions from"
      const inheritsPattern =
        /\b([a-z:_-]+)\s+inherits?\s+(?:from|permissions from)\s+([a-z:_-]+)\b/gi;
      while ((match = inheritsPattern.exec(text)) !== null) {
        debugLog(`[SmartMock Debug] INHERITS match:`, {
          child: match[1],
          parent: match[2],
        });
        const childName = match[1];
        const parentName = match[2];

        const childEntity = entities.find((e) => e.name === childName);
        const parentEntity = entities.find((e) => e.name === parentName);

        if (childEntity && parentEntity) {
          statements.push({
            subject: childEntity.name,
            predicate: "INHERITS_FROM",
            object: parentEntity.name,
            confidence: 0.9,
          });
        }
      }

      debugLog(`[SmartMock Debug] Starting HAS pattern...`);

      // Pattern: "has permission" or "has state"
      const hasPattern = /\b([a-z:_-]+)\s+has\s+([a-z]+)\b/gi;
      while ((match = hasPattern.exec(text)) !== null) {
        debugLog(`[SmartMock Debug] HAS match:`, {
          source: match[1],
          target: match[2],
        });
        const sourceName = match[1];
        const targetName = match[2];

        const sourceEntity = entities.find((e) => e.name === sourceName);
        const targetEntity = entities.find((e) => e.name === targetName);

        debugLog(`[SmartMock Debug] HAS entity lookup:`, {
          sourceName,
          sourceFound: !!sourceEntity,
          sourceCgId: sourceEntity?.cgId,
          sourceCgIdType: typeof sourceEntity?.cgId,
          targetName,
          targetFound: !!targetEntity,
          targetCgId: targetEntity?.cgId,
          targetCgIdType: typeof targetEntity?.cgId,
        });

        debugLog(`[SmartMock Debug] Before if check...`);

        if (sourceEntity && targetEntity) {
          const predicate = targetEntity.kind === "state" ? "HAS_STATE" : "HAS";
          statements.push({
            subject: sourceEntity.name,
            predicate,
            object: targetEntity.name,
            confidence: 0.8,
          });
        }

        debugLog(`[SmartMock Debug] After if check, continuing...`);
      }

      debugLog(`[SmartMock Debug] Starting MANAGES pattern...`);

      // Pattern: "manages" or "controls"
      const managesPattern =
        /\b([a-z:_-]+)\s+(?:manages?|controls?)\s+([a-z]+)\b/gi;
      while ((match = managesPattern.exec(text)) !== null) {
        debugLog(`[SmartMock Debug] MANAGES match:`, {
          source: match[1],
          target: match[2],
        });
        const sourceName = match[1];
        const targetName = match[2];

        const sourceEntity = entities.find((e) => e.name === sourceName);
        const targetEntity = entities.find((e) => e.name === targetName);

        if (sourceEntity && targetEntity) {
          statements.push({
            subject: sourceEntity.name,
            predicate: "MANAGES",
            object: targetEntity.name,
            confidence: 0.85,
          });
        }
      }

      debugLog(`[SmartMock Debug] About to return results...`, {
        entitiesCount: entities.length,
        statementsCount: statements.length,
      });

      return { entities, statements };
    } catch (error) {
      // Log which entity type was being processed when error occurred
      console.error("[SmartMock] Error during extraction:", error);
      throw error;
    }
  }

  /**
   * Get captured requests (for testing/debugging)
   */
  getCapturedRequests(): LLMRequest[] {
    return [...this.capturedRequests];
  }

  /**
   * Clear captured requests
   */
  clearCapturedRequests(): void {
    this.capturedRequests.length = 0;
  }
}
