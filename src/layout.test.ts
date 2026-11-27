import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("tracks only the local app, proof adapters, static site, registry, configuration and five workflows", () => {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  const files = new Set([".gitignore", "CLAUDE.md", "README.md", "VISION.md", "CHANGELOG.md", "package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.js", "vitest.config.ts", "docs/reference.md", "docs/efficiency.md", "docs/router.md", "docs/antseed-vikey-provisioning.md", "docs/providers/freepi.md", "PRODUCT.md", "DESIGN.md", "registry/adapters.json", "proof/freebuff-json-bridge.md", "proof/vetted-onboarding.mjs", "proof/free-api-route.mjs", "proof/nvidia-route.mjs", "proof/opencode-model-pool.mjs"]);
  files.add("scripts/build.mjs");
  files.add("scripts/smoke-daemon.mjs");
  files.add("scripts/recovery-audit.mjs");
  files.add("scripts/verification-benchmark.ts");
  for (const path of ["docs/efficiency-round3-results.md", "docs/efficiency-empirical-results.md", "docs/passive-efficiency.md", "scripts/metadata-benchmark.ts", "scripts/routing-replay-benchmark.ts", "scripts/passive-efficiency-collector.py", "scripts/test_passive_efficiency_collector.py"]) files.add(path);
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) expect(files.has(path) || path.startsWith("src/") || path.startsWith("site/") || [".github/workflows/check.yml", ".github/workflows/ci.yml", ".github/workflows/npm-stats.yml", ".github/workflows/publish.yml", ".github/workflows/site.yml"].includes(path), path).toBe(true);
  expect(paths.some((path) => path === "src/server.ts" || path.startsWith("src/admin/") || path.startsWith("site/admin/"))).toBe(false);
  expect(paths).toContain("src/local/main.ts");
  expect(paths).toContain("registry/adapters.json");
  expect(paths).toContain("site/registry.json");
});

it("packages usegrunt with the primary command and compatibility aliases", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.name).toBe("usegrunt");
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.description).toBe("One-command setup for grunt");
  expect(pkg.bin).toEqual({ usegrunt: "dist/local/main.js", "grunt-local": "dist/local/main.js" });
});
