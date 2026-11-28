import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { vetArchive } from "./local/update.js";

it("tracks only the local app, packaged skill, proof adapters, static site, registry, configuration and five workflows", () => {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  const files = new Set([".gitignore", "CLAUDE.md", "README.md", "VISION.md", "CHANGELOG.md", "package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.js", "vitest.config.ts", "docs/reference.md", "docs/efficiency.md", "docs/router.md", "docs/antseed-vikey-provisioning.md", "docs/providers/freepi.md", "PRODUCT.md", "DESIGN.md", "registry/adapters.json", "proof/freebuff-json-bridge.md", "proof/vetted-onboarding.mjs", "proof/free-api-route.mjs", "proof/nvidia-route.mjs", "proof/opencode-model-pool.mjs"]);
  files.add("scripts/build.mjs");
  files.add("scripts/smoke-daemon.mjs");
  files.add("scripts/recovery-audit.mjs");
  files.add("scripts/verification-benchmark.ts");
  files.add("skills/grunt-status/SKILL.md");
  for (const path of ["docs/efficiency-round3-results.md", "docs/efficiency-empirical-results.md", "docs/passive-efficiency.md", "scripts/metadata-benchmark.ts", "scripts/routing-replay-benchmark.ts", "scripts/passive-efficiency-collector.py", "scripts/test_passive_efficiency_collector.py"]) files.add(path);
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) expect(files.has(path) || path.startsWith("src/") || path.startsWith("site/") || [".github/workflows/check.yml", ".github/workflows/ci.yml", ".github/workflows/npm-stats.yml", ".github/workflows/publish.yml", ".github/workflows/site.yml"].includes(path), path).toBe(true);
  expect(paths.some((path) => path === "src/server.ts" || path.startsWith("src/admin/") || path.startsWith("site/admin/"))).toBe(false);
  expect(paths).toContain("src/local/main.ts");
  expect(paths).toContain("registry/adapters.json");
  expect(paths).toContain("site/registry.json");
  expect(paths).toContain("skills/grunt-status/SKILL.md");
});

it("packages usegrunt with the primary command and compatibility aliases", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.name).toBe("usegrunt");
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.description).toBe("One-command setup for grunt");
  expect(pkg.bin).toEqual({ usegrunt: "dist/local/main.js", "grunt-local": "dist/local/main.js" });
  expect(pkg.files).toEqual(["dist", "README.md"]);
  expect(pkg.pi).toEqual({ skills: ["./dist/skills"] });
});

it("packs a release archive accepted by vetArchive with the skill inside dist/", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string };
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "pipe" });
  const destination = mkdtempSync(join(tmpdir(), "grunt-pack-test-"));
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", destination], { stdio: "pipe" });
    const archive = join(destination, `${pkg.name}-${pkg.version}.tgz`);
    const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    const verbose = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    expect(() => vetArchive(names, verbose)).not.toThrow();

    const paths = names.trimEnd().split("\n");
    expect(paths).toContain("package/dist/skills/grunt-status/SKILL.md");
    expect(paths.some((path) => path.startsWith("package/skills/"))).toBe(false);
    expect(execFileSync("tar", ["-xOf", archive, "package/dist/skills/grunt-status/SKILL.md"], { encoding: "utf8" }))
      .toBe(readFileSync("skills/grunt-status/SKILL.md", "utf8"));

    expect(() => vetArchive(
      `${names}package/skills/grunt-status/SKILL.md\n`,
      `${verbose}-rw-r--r-- 0/0 100 2026-11-28 00:00 package/skills/grunt-status/SKILL.md\n`,
    )).toThrow("unsafe path or link");
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}, 60000);
