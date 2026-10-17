// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  discoverFastifyObservations,
  mergeDuplicateObservations,
} from "./fastifyEndpointDiscovery.js";

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
      ambiguous: false,
    });
  });

  it("does not apply a scope hook declared after the route", () => {
    const after = `
      export default async function scoped(fastify) {
        fastify.get("/items", async () => ({}));
        fastify.addHook("onRequest", fastify.checkToken);
      }
    `;
    const [item] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "modules/items.routes.ts": after,
    });
    expect(item).toMatchObject({
      guards: [],
      guardSource: "none",
      ambiguous: false,
    });
  });

  it("marks a route ambiguous when an earlier hook cannot be parsed", () => {
    const inline = `
      export default async function scoped(fastify) {
        fastify.addHook("onRequest", async (request) => { request.log.info("x"); });
        fastify.get("/items", async () => ({}));
      }
    `;
    const [item] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "modules/items.routes.ts": inline,
    });
    expect(item).toMatchObject({ guards: [], ambiguous: true });
  });

  it("flags a guard whose verifier definitions cannot be told apart", () => {
    const secondVerifier = AUTH_PLUGIN.replace(
      "await request.jwtVerify();",
      "await request.jwtVerify({ secret: 'b' });",
    );
    const [me] = observationsFor({
      "plugins/auth.ts": AUTH_PLUGIN,
      "plugins/auth-b.ts": secondVerifier,
      "modules/users.routes.ts": USER_ROUTES,
    });
    expect(me).toMatchObject({
      guards: ["checkToken"],
      guardAmbiguous: true,
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

  describe("route prefix resolution", () => {
    const APP = `
      import AutoLoad from "@fastify/autoload";
      import { join } from "node:path";
      export default async function app(fastify, opts) {
        await fastify.register(AutoLoad, {
          dir: join(__dirname, "modules"),
          options: { ...opts, prefix: "/api" },
          maxDepth: 2,
        });
      }
    `;
    const USERS_PLUGIN = `
      import usersRoutes from "./users.routes";
      export default async function usersPlugin(fastify) {
        await fastify.register(usersRoutes);
      }
    `;
    const USERS_ROUTES = `
      export default async function usersRoutes(fastify) {
        fastify.get("/", { preHandler: [fastify.checkToken] }, async () => ({}));
        fastify.get("/:id", { preHandler: [fastify.checkToken] }, async () => ({}));
      }
    `;
    const INDEX_PLUGIN = `
      import indexRoutes from "./index.routes";
      export default async function indexPlugin(fastify) {
        await fastify.register(indexRoutes);
      }
    `;
    const INDEX_ROUTES = `
      export default async function indexRoutes(fastify) {
        fastify.get("/secure", { preHandler: [fastify.checkToken] }, async () => ({}));
      }
    `;

    it("composes the autoload prefix with the directory-name prefix", () => {
      const observations = observationsFor({
        "src/app.ts": APP,
        "src/plugins/auth.ts": AUTH_PLUGIN,
        "src/modules/users/users.plugin.ts": USERS_PLUGIN,
        "src/modules/users/users.routes.ts": USERS_ROUTES,
        "src/modules/index.plugin.ts": INDEX_PLUGIN,
        "src/modules/index.routes.ts": INDEX_ROUTES,
      });
      const byPath = Object.fromEntries(
        observations.map((item) => [`${item.method} ${item.routePath}`, item]),
      );
      expect(Object.keys(byPath).sort()).toEqual([
        "GET /api/secure",
        "GET /api/users",
        "GET /api/users/:id",
      ]);
      expect(byPath["GET /api/users/:id"]).toMatchObject({
        routeKnown: true,
        guards: ["checkToken"],
      });
    });

    it("applies a literal register prefix from the plugin", () => {
      const prefixed = USERS_PLUGIN.replace(
        "fastify.register(usersRoutes);",
        'fastify.register(usersRoutes, { prefix: "/v2" });',
      );
      const observations = observationsFor({
        "src/app.ts": APP,
        "src/plugins/auth.ts": AUTH_PLUGIN,
        "src/modules/users/users.plugin.ts": prefixed,
        "src/modules/users/users.routes.ts": USERS_ROUTES,
      });
      expect(observations.map((item) => item.routePath).sort()).toEqual([
        "/api/users/v2",
        "/api/users/v2/:id",
      ]);
    });

    it("keeps a route unknown when its register prefix is not a literal", () => {
      const dynamic = USERS_PLUGIN.replace(
        "fastify.register(usersRoutes);",
        "fastify.register(usersRoutes, { prefix: API_PREFIX });",
      );
      const observations = observationsFor({
        "src/app.ts": APP,
        "src/plugins/auth.ts": AUTH_PLUGIN,
        "src/modules/users/users.plugin.ts": dynamic,
        "src/modules/users/users.routes.ts": USERS_ROUTES,
      });
      expect(observations.every((item) => item.routeKnown === false)).toBe(
        true,
      );
      expect(observations[0]?.routePath).toContain(
        "@src/modules/users/users.routes.ts",
      );
    });

    it("keeps a routes file that no plugin registers unknown", () => {
      const observations = observationsFor({
        "src/app.ts": APP,
        "src/plugins/auth.ts": AUTH_PLUGIN,
        "src/modules/orphan/orphan.routes.ts": USERS_ROUTES,
      });
      expect(observations.every((item) => item.routeKnown === false)).toBe(
        true,
      );
    });
  });

  describe("duplicate registrations", () => {
    const base = {
      method: "GET",
      routePath: "/api/orders/orders",
      routeKnown: true,
      controllerName: "orders",
      handlerName: "handler",
      handlerSignature: null,
      filePath: "src/modules/orders/orders.routes.ts",
      line: 1,
      endLine: 1,
      publicExemption: false,
      guardSource: "handler" as const,
      unverifiedGuards: [],
      ambiguous: false,
    };

    it("keeps a guarded and an unguarded registration as ambiguous with no shared guard", () => {
      const merged = mergeDuplicateObservations([
        { ...base, guards: ["checkToken"] },
        {
          ...base,
          guards: [],
          guardSource: "none",
          filePath: "src/modules/orders/extra.routes.ts",
        },
      ]);
      expect(merged.get("GET /api/orders/orders")).toMatchObject({
        ambiguous: true,
        guards: [],
      });
    });

    it("keeps a guard only when every registration shares it", () => {
      const merged = mergeDuplicateObservations([
        { ...base, guards: ["checkToken", "checkRole('USER')"] },
        {
          ...base,
          guards: ["checkToken"],
          filePath: "src/modules/orders/extra.routes.ts",
        },
      ]);
      expect(merged.get("GET /api/orders/orders")?.guards).toEqual([
        "checkToken",
      ]);
    });

    it("returns a single registration unchanged", () => {
      const merged = mergeDuplicateObservations([
        { ...base, guards: ["checkToken"] },
      ]);
      expect(merged.get("GET /api/orders/orders")).toEqual({
        ...base,
        guards: ["checkToken"],
      });
    });
  });
});
