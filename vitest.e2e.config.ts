import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // See vitest.config.ts: workspace packages resolve to source, not `dist/`.
  resolve: {
    alias: {
      "@milo/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@milo/billing": fileURLToPath(new URL("./packages/billing/src/index.ts", import.meta.url)),
      "@milo/provisioning": fileURLToPath(new URL("./packages/provisioning/src/index.ts", import.meta.url)),
      "@milo/stripe": fileURLToPath(new URL("./packages/stripe/src/index.ts", import.meta.url)),
      "@milo/gateway/server": fileURLToPath(new URL("./packages/gateway/src/server.ts", import.meta.url)),
      "@milo/gateway": fileURLToPath(new URL("./packages/gateway/src/index.ts", import.meta.url)),
      "@milo/evals": fileURLToPath(new URL("./packages/evals/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.e2e.test.ts", "packages/*/test/**/*.e2e.test.ts"],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
