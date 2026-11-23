import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("tracks only the root app, operator tools, proof adapters, static site, registry, configuration and six workflows", () => {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  const files = new Set([".dockerignore", ".gitignore", "CLAUDE.md", "README.md", "VISION.md", "CHANGELOG.md", "Dockerfile", "fly.toml", "package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.js", "vitest.config.ts", "docs/reference.md", "docs/efficiency.md", "docs/router.md", "docs/antseed-vikey-provisioning.md", "docs/providers/freepi.md", "docs/admin-deployment.md", "docs/admin-collector.md", "PRODUCT.md", "DESIGN.md", "registry/adapters.json", "proof/freebuff-json-bridge.md", "proof/kilo.mjs", "proof/add-url.mjs", "proof/vetted-onboarding.mjs", "proof/free-api-route.mjs", "proof/nvidia-route.mjs", "proof/opencode-model-pool.mjs"]);
  const operatorFiles = new Set([
    "ops/adventure-execution/README.md", "ops/adventure-execution/CHECKPOINT_GATE.md", "ops/adventure-execution/baseline.json",
    "ops/adventure-execution/stage.py", "ops/adventure-execution/test_stage.py", "ops/adventure-execution/activate.py", "ops/adventure-execution/test_activate.py",
    "ops/adventure-execution/MAINTENANCE.md", "ops/adventure-execution/stage_maintenance.py", "ops/adventure-execution/test_stage_maintenance.py",
    "ops/adventure-feed/README.md", "ops/adventure-feed/activity.py", "ops/adventure-feed/uptime.py", "ops/adventure-feed/test_activity.py",
    "ops/provider-scout/.gitignore", "ops/provider-scout/POLICY.md", "ops/provider-scout/README.md",
    "ops/provider-scout/report.schema.json", "ops/provider-scout/scout.py", "ops/provider-scout/test_scout.py",
    "ops/provider-scout/pipeline.py", "ops/provider-scout/test_pipeline.py",
    "ops/provider-scout/sandbox.py", "ops/provider-scout/test_sandbox.py",
    "ops/provider-scout/validation.py", "ops/provider-scout/test_validation.py",
    "ops/provider-scout/context_policy.py",
    "ops/provider-scout/owner_policy.py",
    "ops/provider-scout/url_policy.py", "ops/provider-scout/test_url_policy.py",
    "ops/provider-scout/promotion.py", "ops/provider-scout/test_promotion.py",
    "ops/provider-scout/worker.py", "ops/provider-scout/test_worker.py",
    "ops/provider-scout/squire_proxy.py", "ops/provider-scout/test_squire_proxy.py",
    "ops/provider-scout/probe.mjs", "ops/provider-scout/test_probe.mjs",
    "ops/provider-scout/probe-child.mjs",
    "ops/provider-scout/publish.mjs",
    "ops/provider-scout/provision.mjs", "ops/provider-scout/test_provision.mjs"
  ]);
  files.add("scripts/verification-benchmark.ts");
  for (const path of ["docs/efficiency-round3-results.md", "docs/efficiency-empirical-results.md", "docs/passive-efficiency.md", "scripts/metadata-benchmark.ts", "scripts/routing-replay-benchmark.ts", "scripts/passive-efficiency-collector.py", "scripts/test_passive_efficiency_collector.py"]) files.add(path);
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) expect(files.has(path) || operatorFiles.has(path) || path.startsWith("src/") || path.startsWith("site/") || path === "proof/fake.mjs" || [".github/workflows/check.yml", ".github/workflows/ci.yml", ".github/workflows/deploy.yml", ".github/workflows/publish.yml", ".github/workflows/registry.yml", ".github/workflows/site.yml"].includes(path), path).toBe(true);
  expect(paths).toContain("src/server.ts");
  expect(paths).toContain("registry/adapters.json");
  expect(paths).toContain(".github/workflows/registry.yml");
});

it("packages usegrunt with the primary command and compatibility aliases", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.name).toBe("usegrunt");
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.description).toBe("One-command setup for grunt");
  expect(pkg.bin).toEqual({ usegrunt: "dist/local/main.js", "grunt-local": "dist/local/main.js", milo: "dist/local/main.js", "milo-local": "dist/local/main.js" });
});
