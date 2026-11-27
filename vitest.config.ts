import { defineConfig } from "vitest/config";
// An empty key keeps every test, and any daemon a test starts, from sending telemetry to production PostHog.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], maxWorkers: 4, env: { GRUNT_POSTHOG_KEY: "" } } });
