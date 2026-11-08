import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Opt-in tests against real services and the real `codex`/`claude` CLIs. */
export default defineConfig({
  resolve: {
    alias: {
      "@milo/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.live.test.ts"],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 180_000,
  },
});
