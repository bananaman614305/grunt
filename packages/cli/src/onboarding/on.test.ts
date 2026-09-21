import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_PROVIDER_ID } from "@milo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NodeOs from "node:os";
import { createTestDeps } from "../test-support.js";
import type { FetchLike } from "../deps.js";
import { runOn, runStatus } from "./on.js";

const ROUTED_MODEL = "deepseek/deepseek-v4-flash";

// Plain `milo on pi` writes the host-level config, so its test points the
// real `homedir()` at a fake home instead of ~/.pi. All other tests use
// --dir and never see this mock.
const FAKE_HOME = "/tmp/milo-fake-home";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => FAKE_HOME };
});

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

function smokeFetch(calls: Array<{ url: string; init: RequestInit }>): FetchLike {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return new Response("", { status: 200, headers: { "x-milo-model": ROUTED_MODEL } });
  };
}

describe("milo on pi", () => {
  let dir: string;
  const configPath = () => join(dir, "agent", "models.json");
  const backupPath = () => join(dir, "agent", "models.json.milo-backup");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "milo-on-pi-"));
    mkdirSync(join(dir, "agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("plain `on pi` is the one-command host-level switch: it merges into ~/.pi additively", async () => {
    // Fake home -> /tmp/milo-fake-home/.pi/agent/models.json; never the real ~/.pi.
    const homeConfig = join(FAKE_HOME, ".pi", "agent", "models.json");
    const homeBackup = `${homeConfig}.milo-backup`;
    mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
    writeFileSync(homeConfig, EXISTING);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { deps, stdout } = createTestDeps({
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      fetch: smokeFetch(calls),
    });

    const code = await runOn(["pi", "--gateway", "http://127.0.0.1:9090"], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(homeConfig, "utf8")) as Record<string, unknown>;
    // Additive at the host level: the default and the user's provider survive.
    expect(parsed.default).toBe("deepseek/deepseek-v4-pro");
    const providers = parsed.providers as Record<string, unknown>;
    expect((providers.openrouter as { baseUrl: string }).baseUrl).toBe("https://openrouter.example/v1");
    expect((providers[PI_PROVIDER_ID] as { baseUrl: string }).baseUrl).toBe("http://127.0.0.1:9090/v1");
    expect(existsSync(homeBackup)).toBe(true);
    // Explicit messaging: host-level registration, machine-wide, nothing replaced.
    expect(stdout.toString()).toContain("HOST level");
    expect(stdout.toString()).toContain("machine-wide");
    expect(stdout.toString()).toContain("left untouched; only milo was added");
  });

  it("refuses --global together with --dir, and writes nothing", async () => {
    writeFileSync(configPath(), EXISTING);
    const { deps, stderr } = createTestDeps();
    const code = await runOn(["pi", "--global", "--dir", dir], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("either --global or --dir");
    expect(readFileSync(configPath(), "utf8")).toBe(EXISTING);
    expect(existsSync(backupPath())).toBe(false);
  });

  it("merges additively, backs up the prior bytes, and smoke-verifies x-milo-model", async () => {
    writeFileSync(configPath(), EXISTING);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { deps, stdout } = createTestDeps({
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      fetch: smokeFetch(calls),
    });

    const code = await runOn(["pi", "--dir", dir, "--gateway", "http://127.0.0.1:9090"], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    // Additive: the default and the user's provider survive.
    expect(parsed.default).toBe("deepseek/deepseek-v4-pro");
    const providers = parsed.providers as Record<string, unknown>;
    expect(providers.openrouter).toBeDefined();
    const milo = providers[PI_PROVIDER_ID] as { baseUrl: string; api: string; apiKey: string };
    expect(milo.baseUrl).toBe("http://127.0.0.1:9090/v1");
    expect(milo.apiKey).toBe("$OPENROUTER_API_KEY");

    // The backup is the exact pre-merge bytes.
    expect(readFileSync(backupPath(), "utf8")).toContain('"priorConfig"');
    const backup = JSON.parse(readFileSync(backupPath(), "utf8")) as { priorConfig: string };
    expect(backup.priorConfig).toBe(EXISTING);

    // One smoke request with the routed model, and the header printed.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:9090/v1/chat/completions");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "milo/auto",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(stdout.toString()).toContain(
      `smoke verify OK — routed to ${ROUTED_MODEL} (x-milo-model: ${ROUTED_MODEL})`,
    );
  });

  it("re-running never stacks backups and keeps the original bytes", async () => {
    writeFileSync(configPath(), EXISTING);
    const { deps } = createTestDeps({ env: { OPENROUTER_API_KEY: "sk-or-test" }, fetch: smokeFetch([]) });

    expect(await runOn(["pi", "--dir", dir], deps)).toBe(0);
    const firstBackup = readFileSync(backupPath(), "utf8");
    expect(await runOn(["pi", "--dir", dir], deps)).toBe(0);

    expect(readFileSync(backupPath(), "utf8")).toBe(firstBackup);
    expect(existsSync(`${backupPath()}.milo-backup`)).toBe(false);
  });

  it("--no-verify writes the provider and skips the smoke request", async () => {
    writeFileSync(configPath(), EXISTING);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { deps, stdout } = createTestDeps({
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      fetch: smokeFetch(calls),
    });

    const code = await runOn(["pi", "--dir", dir, "--no-verify"], deps);

    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stdout.toString()).toContain("Smoke verify skipped");
    expect((JSON.parse(readFileSync(configPath(), "utf8")) as { providers: Record<string, unknown> }).providers[PI_PROVIDER_ID]).toBeDefined();
  });

  it("scaffolds a fresh root and records a no-prior backup", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { deps } = createTestDeps({ env: { OPENROUTER_API_KEY: "sk-or-test" }, fetch: smokeFetch(calls) });

    const code = await runOn(["pi", "--dir", dir], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { providers: Record<string, unknown> };
    expect(Object.keys(parsed.providers)).toEqual([PI_PROVIDER_ID]);
    const backup = JSON.parse(readFileSync(backupPath(), "utf8")) as { priorConfigExisted: boolean };
    expect(backup.priorConfigExisted).toBe(false);
  });

  it("refuses invalid JSON, writes nothing, and reports the parse error", async () => {
    writeFileSync(configPath(), "{ not json");
    const { deps, stderr } = createTestDeps();

    const code = await runOn(["pi", "--dir", dir], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("not valid JSON");
    expect(readFileSync(configPath(), "utf8")).toBe("{ not json");
    expect(existsSync(backupPath())).toBe(false);
  });

  it("stores a prompted key in pi's auth.json (mode 600, api_key credential object) and uses it for the smoke", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { deps } = createTestDeps({
      env: {},
      isTTY: true,
      prompt: async () => "sk-or-prompted",
      fetch: smokeFetch(calls),
    });

    const code = await runOn(["pi", "--dir", dir], deps);

    expect(code).toBe(0);
    // pi's auth.json credential shape: an api_key object, not a bare string.
    expect(JSON.parse(readFileSync(join(dir, "agent", "auth.json"), "utf8"))).toEqual({
      [PI_PROVIDER_ID]: { type: "api_key", key: "sk-or-prompted" },
    });
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer sk-or-prompted" });
  });

  it("non-interactive with no key writes additively but refuses with export instructions", async () => {
    writeFileSync(configPath(), EXISTING);
    const { deps, stderr } = createTestDeps({
      env: {},
      isTTY: false,
      prompt: async () => {
        throw new Error("must not prompt without a TTY");
      },
    });

    const code = await runOn(["pi", "--dir", dir], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("export OPENROUTER_API_KEY");
    // The provider was still merged additively; only the smoke was skipped.
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    expect(parsed.default).toBe("deepseek/deepseek-v4-pro");
    expect((parsed.providers as Record<string, unknown>)[PI_PROVIDER_ID]).toBeDefined();
  });

  it("status reports routed and not-routed state", async () => {
    writeFileSync(configPath(), EXISTING);
    const { deps, stdout } = createTestDeps();
    expect(await runStatus(["pi", "--dir", dir], deps)).toBe(0);
    expect(stdout.toString()).toContain("not routed to Milo");

    expect(await runOn(["pi", "--dir", dir, "--no-verify"], createTestDeps({ env: { OPENROUTER_API_KEY: "k" } }).deps)).toBe(0);
    const { deps: deps2, stdout: stdout2 } = createTestDeps();
    expect(await runStatus(["pi", "--dir", dir], deps2)).toBe(0);
    expect(stdout2.toString()).toContain('routed to Milo at https://milo-gateway.fly.dev/v1');
  });
});