import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("tracks only the root app, proof adapters, static site, registry, configuration and five workflows", () => {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  const files = new Set([".dockerignore", ".gitignore", "CLAUDE.md", "README.md", "VISION.md", "CHANGELOG.md", "Dockerfile", "fly.toml", "package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.js", "vitest.config.ts", "docs/reference.md", "docs/efficiency.md", "docs/router.md", "docs/antseed-vikey-provisioning.md", "docs/providers/freepi.md", "docs/admin-deployment.md", "docs/admin-collector.md", "PRODUCT.md", "DESIGN.md", "registry/adapters.json", "proof/freebuff-json-bridge.md", "proof/kilo.mjs", "proof/add-url.mjs", "proof/vetted-onboarding.mjs", "proof/free-api-route.mjs", "proof/nvidia-route.mjs", "proof/opencode-model-pool.mjs"]);
  for (const image of ["desktop", "registry", "phone", "installation-phone"]) files.add(`docs/dashboard-proof/${image}.png`);
  files.add("scripts/fleet-report.mjs");
  files.add("scripts/recovery-audit.mjs");
  files.add("docs/fleet-audit-proof/desktop.png");
  files.add("docs/fleet-audit-proof/phone.png");
  files.add("scripts/verification-benchmark.ts");
  for (const path of ["docs/efficiency-round3-results.md", "docs/efficiency-empirical-results.md", "docs/passive-efficiency.md", "scripts/metadata-benchmark.ts", "scripts/routing-replay-benchmark.ts", "scripts/passive-efficiency-collector.py", "scripts/test_passive_efficiency_collector.py"]) files.add(path);
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) expect(files.has(path) || path.startsWith("src/") || path.startsWith("site/") || [".github/workflows/check.yml", ".github/workflows/ci.yml", ".github/workflows/deploy.yml", ".github/workflows/publish.yml", ".github/workflows/site.yml"].includes(path), path).toBe(true);
  expect(paths).toContain("src/server.ts");
  expect(paths).toContain("registry/adapters.json");
});

it("packages usegrunt with the primary command and compatibility aliases", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.name).toBe("usegrunt");
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.description).toBe("One-command setup for grunt");
  expect(pkg.bin).toEqual({ usegrunt: "dist/local/main.js", "grunt-local": "dist/local/main.js", milo: "dist/local/main.js", "milo-local": "dist/local/main.js" });
});
