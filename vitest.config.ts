import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages resolve to `dist/` through their package.json, which
  // would make `pnpm test` depend on a prior `pnpm build`. Point them at
  // source instead so tests always run against the code in the tree.
  resolve: {
    alias: {
      "@milo/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@milo/gateway/server": fileURLToPath(new URL("./packages/gateway/src/server.ts", import.meta.url)),
      "@milo/gateway": fileURLToPath(new URL("./packages/gateway/src/index.ts", import.meta.url)),
      "@milo/evals": fileURLToPath(new URL("./packages/evals/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/*.e2e.test.ts", "**/*.live.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
