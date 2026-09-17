import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.e2e.test.ts", "packages/*/test/**/*.e2e.test.ts"],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 30_000,
  },
});
