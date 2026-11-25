import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("tracks only the root app, operator tools, proof adapters, static site, registry, configuration and five workflows", () => {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  const files = new Set([".dockerignore", ".gitignore", "CLAUDE.md", "README.md", "VISION.md", "CHANGELOG.md", "Dockerfile", "fly.toml", "package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.js", "vitest.config.ts", "docs/reference.md", "docs/efficiency.md", "docs/router.md", "docs/antseed-vikey-provisioning.md", "docs/providers/freepi.md", "docs/admin-deployment.md", "docs/admin-collector.md", "PRODUCT.md", "DESIGN.md", "registry/adapters.json", "proof/freebuff-json-bridge.md", "proof/kilo.mjs", "proof/add-url.mjs", "proof/vetted-onboarding.mjs", "proof/free-api-route.mjs", "proof/nvidia-route.mjs", "proof/opencode-model-pool.mjs"]);
  const operatorFiles = new Set([
    "ops/adventure-execution/MAINTENANCE.md",
    "ops/live-upgrade/README.md", "ops/live-upgrade/acquisition_guard.py", "ops/live-upgrade/activate.py", "ops/live-upgrade/attempt.py", "ops/live-upgrade/check_runtime_contract.mjs",
    "ops/live-upgrade/checkpoint_gate.py", "ops/live-upgrade/collector_guard.py", "ops/live-upgrade/daemon_admission.py", "ops/live-upgrade/end_cycle.py", "ops/live-upgrade/host_metadata.py", "ops/live-upgrade/hostpaths.py",
    "ops/live-upgrade/maintenance_pause.py", "ops/live-upgrade/pause-and-activate.py", "ops/live-upgrade/preflight.py", "ops/live-upgrade/preparation.py", "ops/live-upgrade/quota_store.py",
    "ops/live-upgrade/registry_cache.py", "ops/live-upgrade/registry_cache_metadata.mjs", "ops/live-upgrade/registry_refresh.mjs", "ops/live-upgrade/registry_refresh.py", "ops/live-upgrade/release_pins.py", "ops/live-upgrade/release_proof.py",
    "ops/live-upgrade/rollout_checks.py", "ops/live-upgrade/rollout_config.py", "ops/live-upgrade/seed-routing-history.mjs", "ops/live-upgrade/source_transition.py",
    "ops/live-upgrade/sqlite_families.py", "ops/live-upgrade/stage.py", "ops/live-upgrade/startup_gate.py", "ops/live-upgrade/startup_gate_metadata.mjs", "ops/live-upgrade/test_admission_retry.py",
    "ops/live-upgrade/test_attempt.py", "ops/live-upgrade/test_checkpoint_floor.py", "ops/live-upgrade/test_controller.py", "ops/live-upgrade/test_daemon_admission.py",
    "ops/live-upgrade/test_end_cycle.py", "ops/live-upgrade/test_maintenance_pause.py", "ops/live-upgrade/test_no_hand_edited_versions.py", "ops/live-upgrade/test_owner_opt_ins.py", "ops/live-upgrade/test_preparation_wait.py",
    "ops/live-upgrade/test_registry_cache.py", "ops/live-upgrade/test_registry_refresh.py", "ops/live-upgrade/test_release_pins.py", "ops/live-upgrade/test_resource_policy.py", "ops/live-upgrade/test_source_transition.py",
    "ops/live-upgrade/test_sqlite_families.py", "ops/live-upgrade/test_startup_gate.py", "ops/live-upgrade/test_support.py", "ops/live-upgrade/test_upgrade.py",
    "ops/live-upgrade/test_upgrade_cli.py", "ops/live-upgrade/test_verify_success.py", "ops/live-upgrade/upgrade.py", "ops/live-upgrade/verify_success.py",
    "ops/adventure-feed/README.md", "ops/adventure-feed/activity.py", "ops/adventure-feed/uptime.py", "ops/adventure-feed/test_activity.py",
    "ops/adventure-feed/claude_session.py", "ops/adventure-feed/test_claude_session.py",
    "ops/provider-scout/.gitignore", "ops/provider-scout/POLICY.md", "ops/provider-scout/README.md",
    "ops/provider-scout/report.schema.json", "ops/provider-scout/scout.py", "ops/provider-scout/test_scout.py", "ops/provider-scout/test_strict_schema.py",
    "ops/provider-scout/pipeline.py", "ops/provider-scout/test_pipeline.py",
    "ops/provider-scout/lifecycle.py", "ops/provider-scout/test_lifecycle.py",
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
  for (const image of ["desktop", "registry", "phone", "signup-phone"]) files.add(`docs/dashboard-proof/${image}.png`);
  files.add("scripts/fleet-report.mjs");
  files.add("scripts/recovery-audit.mjs");
  files.add("docs/fleet-audit-proof/desktop.png");
  files.add("docs/fleet-audit-proof/phone.png");
  files.add("scripts/verification-benchmark.ts");
  for (const path of ["docs/efficiency-round3-results.md", "docs/efficiency-empirical-results.md", "docs/passive-efficiency.md", "scripts/metadata-benchmark.ts", "scripts/routing-replay-benchmark.ts", "scripts/passive-efficiency-collector.py", "scripts/test_passive_efficiency_collector.py"]) files.add(path);
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) expect(files.has(path) || operatorFiles.has(path) || path.startsWith("src/") || path.startsWith("site/") || path === "proof/fake.mjs" || [".github/workflows/check.yml", ".github/workflows/ci.yml", ".github/workflows/deploy.yml", ".github/workflows/publish.yml", ".github/workflows/site.yml"].includes(path), path).toBe(true);
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
