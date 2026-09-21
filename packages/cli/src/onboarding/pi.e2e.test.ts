/**
 * Regression coverage for the reported failure: after `milo on --global pi`,
 * `pi --list-models milo` failed with "providers.milo.models.0: must be
 * object" in ~/.pi/agent/models.json (reproduced from usemilo@0.3.0, which
 * wrote `models: ["milo/auto"]` -- an array of strings -- plus legacy
 * `type`/`base_url`/`api_key_env` keys and stomped `default`).
 *
 * This e2e runs the REAL `pi` binary (when installed) as the consumer of the
 * file the onboarding writes: a temp `PI_CODING_AGENT_DIR` is populated by
 * the actual `milo on` flow, then `pi --list-models milo` must load it
 * without a schema error and list the milo models. The onboarding goes
 * through the prompted-key path so pi's auth.json gets the api_key
 * credential object it requires -- the subprocess must not depend on
 * OPENROUTER_API_KEY being set in the ambient environment. A negative
 * control writes the usemilo@0.3.0 legacy shape and asserts pi DOES flag
 * "must be object", proving the test would catch a regression back to
 * strings.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PI_PROVIDER_ID } from "@milo/core";
import { describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { runOn } from "./on.js";

const LEGACY_030_BLOCK = `{
  "default": "milo/auto",
  "providers": {
    "milo": {
      "type": "openai",
      "base_url": "https://milo-gateway.fly.dev/v1",
      "api_key_env": "OPENROUTER_API_KEY",
      "models": ["milo/auto"]
    }
  }
}
`;

const EXISTING = `{
  "default": "deepseek/deepseek-v4-pro",
  "providers": {
    "openrouter": {
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.example/v1",
      "api": "openai-completions",
      "apiKey": "abc",
      "models": [{ "id": "deepseek/deepseek-v4-pro" }]
    }
  }
}
`;

function piAvailable(): boolean {
  return spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Runs the real `pi --list-models milo` against an agent dir, capturing both streams. */
function piListMilo(agentDir: string): { stdout: string; stderr: string } {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const res = spawnSync("pi", ["--list-models", "milo"], { env, encoding: "utf8" });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe.skipIf(!piAvailable())("pi consumes the models.json the onboarding writes", () => {
  it("`pi --list-models milo` loads the merged file without a schema error (regression: must be object)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-on-pi-e2e-"));
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "models.json"), EXISTING);

      // The real onboarding flow: plain `milo on pi` against this root, no
      // gateway round-trip (--no-verify), with the key prompted so auth.json
      // is written in pi's api_key credential shape. The pi subprocess then
      // authenticates from auth.json, not from the ambient environment.
      const { deps } = createTestDeps({
        env: {},
        isTTY: true,
        prompt: async () => "sk-or-test",
      });
      const code = await runOn(["pi", "--dir", dir, "--no-verify"], deps);
      expect(code).toBe(0);

      // auth.json holds pi's required api_key object, not a bare string.
      const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
      expect(auth[PI_PROVIDER_ID]).toEqual({ type: "api_key", key: "sk-or-test" });

      const { stdout, stderr } = piListMilo(agentDir);
      expect(stderr).not.toContain("must be object");
      expect(stderr).not.toContain("Invalid models.json schema");
      expect(stderr).not.toContain("Invalid auth.json");
      // The additive merge survived and the credential makes it available:
      // milo/auto is listed alongside the roster.
      expect(stdout).toContain("milo/auto");
      // The user's provider and default were not replaced.
      const parsed = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
        default: string;
        providers: Record<string, unknown>;
      };
      expect(parsed.default).toBe("deepseek/deepseek-v4-pro");
      expect(parsed.providers.openrouter).toBeDefined();
      expect(parsed.providers[PI_PROVIDER_ID]).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("negative control: the usemilo@0.3.0 string-array shape is caught by pi", async () => {
    const dir = mkdtempSync(join(tmpdir(), "milo-on-pi-e2e-legacy-"));
    try {
      const agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "models.json"), LEGACY_030_BLOCK);

      const { stderr } = piListMilo(agentDir);
      expect(stderr).toContain("providers.milo.models.0: must be object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});