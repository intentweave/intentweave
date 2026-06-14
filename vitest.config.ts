import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // @intentweave/sqlite-compat wraps node:sqlite (Node 22.15+ built-in).
        // Vite 5 strips the "node:" prefix before checking builtinModules, so
        // it can't find "sqlite". Externalising the shim makes Vitest load its
        // compiled dist/ via Node's native ESM loader, where node:sqlite works.
        external: [/sqlite-compat/],
      },
    },
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.test.ts",
        "**/*.spec.ts",
      ],
    },
    testTimeout: 30000,
  },
});
