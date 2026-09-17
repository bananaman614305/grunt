import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // See vitest.config.ts: workspace packages resolve to source, not `dist/`.
  resolve: {
    alias: {
      "@milo/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.e2e.test.ts", "packages/*/test/**/*.e2e.test.ts"],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
