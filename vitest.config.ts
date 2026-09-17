import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/*.e2e.test.ts", "**/*.live.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
