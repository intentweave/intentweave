// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { discoverFastifyObservations } from "./fastifyEndpointDiscovery.js";

const AUTH_PLUGIN = `
import fp from "fastify-plugin";
export default fp(async function authPlugin(fastify) {
  fastify.decorate("checkToken", async (request, reply) => {
    await request.jwtVerify();
  });
  fastify.decorate("checkRole", (role) => async (request) => {
    if (request.user.role !== role) throw new Error("forbidden");
  });
});
`;

const USER_ROUTES = `
export default async function usersRoutes(fastify) {
  const cache = new Map();
  cache.get("key");
  fastify.get("/me", { preHandler: [fastify.checkToken] }, async () => ({}));
  fastify.post("/login", async () => ({}));
  fastify.delete(
    "/users/:id",
    { preHandler: [fastify.checkToken, fastify.checkRole('USER')] },
    removeUser,
  );
  fastify.get("/unknown", { preHandler: [fastify.mysteryGuard] }, async () => ({}));
}
`;

function observationsFor(sources: Record<string, string>) {
  return discoverFastifyObservations(new Map(Object.entries(sources)));
}

describe("discoverFastifyObservations", () => {
  it("counts only literal route registrations", () => {
    const observations = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "modules/users.routes.ts": USER_ROUTES,
    });
    expect(
      observations.map((item) => `${item.method} ${item.routePath}`),
    ).toEqual([
      "GET /me@modules/users.routes.ts",
      "POST /login@modules/users.routes.ts",
      "DELETE /users/:id@modules/users.routes.ts",
      "GET /unknown@modules/users.routes.ts",
    ]);
  });

  it("ignores route registrations in test files", () => {
    const observations = observationsFor({
      "test/plugins/check-role.plugin.test.ts": USER_ROUTES,
      "src/modules/users.routes.ts": USER_ROUTES,
    });
    expect(observations.every((item) => item.filePath.startsWith("src/"))).toBe(
      true,
    );
    expect(observations).toHaveLength(4);
  });

  it("treats a route guard as positive Evidence only when its decorator verifies a token", () => {
    const [me] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "modules/users.routes.ts": USER_ROUTES,
    });
    expect(me).toMatchObject({
      routeKnown: false,
      guards: ["checkToken"],
      unverifiedGuards: [],
      guardSource: "handler",
      publicExemption: false,
      ambiguous: false,
    });
  });

  it("keeps non-verifying guards out of the positive guard list", () => {
    const [, , deleteRoute] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "modules/users.routes.ts": USER_ROUTES,
    });
    expect(deleteRoute?.guards).toEqual(["checkToken"]);
    expect(deleteRoute?.unverifiedGuards).toEqual(["checkRole('USER')"]);
  });

  it("leaves a route with no guard as having no positive guard Evidence", () => {
    const [, login] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "modules/users.routes.ts": USER_ROUTES,
    });
    expect(login).toMatchObject({
      guards: [],
      unverifiedGuards: [],
      guardSource: "none",
    });
  });

  it("does not treat an undecorated guard name as verified", () => {
    const [, , , unknown] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "modules/users.routes.ts": USER_ROUTES,
    });
    expect(unknown?.guards).toEqual([]);
    expect(unknown?.unverifiedGuards).toEqual(["mysteryGuard"]);
  });

  it("marks a scope-level hook as a scope guard and ambiguous", () => {
    const scoped = `
      export default async function scoped(fastify) {
        fastify.addHook("onRequest", fastify.checkToken);
        fastify.get("/items", async () => ({}));
      }
    `;
    const [item] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "modules/items.routes.ts": scoped,
    });
    expect(item).toMatchObject({
      guards: ["checkToken"],
      guardSource: "scope-hook",
      ambiguous: true,
    });
  });

  it("marks a guard with conflicting decorator definitions as ambiguous", () => {
    const unverifiedAuth = `
      export default async function other(fastify) {
        fastify.decorate("checkToken", async () => undefined);
      }
    `;
    const [me] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "plugins/other.ts": unverifiedAuth,
      "modules/users.routes.ts": USER_ROUTES,
    });
    // Conflicting definitions are not positive Evidence, whatever the order.
    expect(me).toMatchObject({ ambiguous: true, guards: [] });
    expect(me?.unverifiedGuards).toEqual(["checkToken"]);
  });
});
