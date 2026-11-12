import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("tracks only the new root app, its proof adapter, configuration and three workflows", () => {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  const files = new Set([".dockerignore", ".gitignore", "CLAUDE.md", "README.md", "VISION.md", "Dockerfile", "fly.toml", "package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.js", "vitest.config.ts"]);
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) expect(files.has(path) || path.startsWith("src/") || path === "proof/fake.mjs" || [".github/workflows/ci.yml", ".github/workflows/deploy.yml", ".github/workflows/publish.yml"].includes(path), path).toBe(true);
  expect(paths).toContain("src/server.ts");
  expect(readFileSync(".github/workflows/deploy.yml", "utf8")).toContain("secrets.FLY_API_TOKEN");
});
