import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROSTER, PI_PROVIDER_ID } from "@milo/core";
import type { Roster } from "@milo/core";
import type { Gateway, GatewayOptions } from "@milo/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../index.js";
import { createTestDeps } from "../test-support.js";
import type { FetchLike, ServeFn, ServeOptions } from "../deps.js";
import { run } from "./configure.js";

const SMOKE_PORT = 45123;
const ROUTED_MODEL = "deepseek/deepseek-v4-flash";

function fakeGateway(): {
  createGateway: (options: GatewayOptions) => Promise<Gateway>;
  calls: GatewayOptions[];
} {
  const calls: GatewayOptions[] = [];
  return {
    calls,
    createGateway: async (options: GatewayOptions) => {
      calls.push(options);
      return {
        app: { fetch: async () => new Response("ok") } as unknown as Gateway["app"],
        log: {} as Gateway["log"],
        close: async () => undefined,
      };
    },
  };
}

/** Serves nothing: just reports an already-listening fake port. */
function fakeServe(): { serve: ServeFn; calls: ServeOptions[] } {
  const calls: ServeOptions[] = [];
  const serve: ServeFn = (options, listener) => {
    calls.push(options);
    if (listener) listener({ address: "127.0.0.1", port: SMOKE_PORT });
    return { close: (cb) => cb?.() };
  };
  return { serve, calls };
}

function fakeFetch(onCall?: (url: string, init: RequestInit) => void): { fetch: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const record = { url, init };
    calls.push(record);
    onCall?.(url, init);
    return new Response("", {
      status: 200,
      headers: { "content-type": "application/json", "x-milo-model": ROUTED_MODEL },
    });
  };
  return { fetch, calls };
}

describe("milo configure", () => {
  let dir: string;
  const config = (name = "milo.config.json") => join(dir, name);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "milo-cli-configure-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints help with --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--help"], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo configure");
    expect(stdout.toString()).toContain("--no-pi");
    expect(stdout.toString()).toContain("--no-verify");
    expect(stdout.toString()).toContain("x-milo-model");
  });

  it("scaffolds a new config with the default roster and nothing to back up", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await run(["--config", config(), "--pi-config", join(dir, "pi.json"), "--no-verify"], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(config(), "utf8")) as Record<string, unknown>;
    expect(parsed.roster).toEqual(DEFAULT_ROSTER);
    expect(parsed.port).toBe(8787);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.decisionLog).toBe("file:./.milo/decisions.db");
    expect(existsSync(`${config()}.bak`)).toBe(false);
    expect(stdout.toString()).toContain("default roster");
  });

  it("merges additively into an existing config and backs it up byte-for-byte", async () => {
    const path = config();
    writeFileSync(path, '{\n  "port": 9123,\n  "hostname": "0.0.0.0"\n}\n');

    const { deps } = createTestDeps();
    const code = await run(["--config", path, "--no-pi", "--no-verify"], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // The user's fields win untouched; only the roster was added.
    expect(parsed.port).toBe(9123);
    expect(parsed.hostname).toBe("0.0.0.0");
    expect(parsed.roster).toEqual(DEFAULT_ROSTER);

    // The backup is the exact original bytes.
    expect(readFileSync(`${path}.bak`, "utf8")).toBe('{\n  "port": 9123,\n  "hostname": "0.0.0.0"\n}\n');
  });

  it("keeps the user's own roster instead of writing the default", async () => {
    const path = config();
    const mine: Roster = { fast: ["custom/fast"], mid: ["custom/mid"], frontier: ["custom/frontier"] };
    writeFileSync(path, JSON.stringify({ roster: mine }));

    const { deps } = createTestDeps();
    const code = await run(["--config", path, "--no-pi", "--no-verify"], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(parsed.roster).toEqual(mine);
  });

  it("refuses an existing config the gateway would refuse, leaving it untouched", async () => {
    const path = config();
    writeFileSync(path, '{"unknownTopLevelField": true}');

    const { deps, stderr } = createTestDeps();
    const code = await run(["--config", path, "--no-pi", "--no-verify"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("invalid");
    expect(readFileSync(path, "utf8")).toBe('{"unknownTopLevelField": true}');
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it("merges the milo provider into pi's models.json additively, with a backup", async () => {
    const piPath = join(dir, "pi.json");
    const originalPi = JSON.stringify({
      providers: {
        ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "llama3.1:8b" }] },
      },
    });
    writeFileSync(piPath, originalPi);

    const { deps, stdout } = createTestDeps();
    const code = await run(["--config", config(), "--pi-config", piPath, "--no-verify"], deps);

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(piPath, "utf8")) as {
      providers: Record<string, { baseUrl: string; apiKey: string; models: Array<{ id: string }> }>;
    };
    // The pre-existing provider survives untouched.
    expect(parsed.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");
    // The milo provider points at the local gateway and names the key by env
    // variable -- a literal never reaches the file.
    const milo = parsed.providers[PI_PROVIDER_ID];
    expect(milo.baseUrl).toBe("http://127.0.0.1:8787/v1");
    expect(milo.apiKey).toBe("$OPENROUTER_API_KEY");
    expect(milo.models[0].id).toBe("milo/auto");
    expect(JSON.stringify(parsed)).not.toContain("sk-");
    // The models list carries the roster this config runs.
    for (const id of DEFAULT_ROSTER.fast) {
      expect(milo.models.map((m) => m.id)).toContain(id);
    }
    // Backup of the original pi file: the exact bytes from before the merge.
    expect(readFileSync(`${piPath}.bak`, "utf8")).toBe(originalPi);
    expect(stdout.toString()).toContain(`"${PI_PROVIDER_ID}" provider`);
  });

  it("uses --base-url for the pi provider instead of the local gateway", async () => {
    const piPath = join(dir, "pi.json");
    const { deps } = createTestDeps();
    const code = await run(
      ["--config", config(), "--pi-config", piPath, "--base-url", "https://milo.example.com", "--no-verify"],
      deps,
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(piPath, "utf8")) as {
      providers: Record<string, { baseUrl: string }>;
    };
    expect(parsed.providers[PI_PROVIDER_ID].baseUrl).toBe("https://milo.example.com/v1");
  });

  it("creates the pi models directory on a fresh home", async () => {
    // A fresh machine has no ~/.pi/agent/ at all; the wizard must create it
    // instead of crashing with an uncaught ENOENT.
    const nested = join(dir, "home", "user", ".pi", "agent", "models.json");

    const { deps, stderr } = createTestDeps();
    const code = await run(["--config", config(), "--pi-config", nested, "--no-verify"], deps);

    expect(code).toBe(0);
    expect(existsSync(nested)).toBe(true);
    expect(JSON.parse(readFileSync(nested, "utf8"))).toBeTruthy();
    expect(stderr.toString()).toBe("");
  });

  it("creates parent directories for --config too", async () => {
    const nested = join(dir, "configs", "deep", "milo.config.json");

    const { deps } = createTestDeps();
    const code = await run(["--config", nested, "--no-pi", "--no-verify"], deps);

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(nested, "utf8"))).toBeTruthy();
  });

  it("reports a write failure cleanly instead of crashing", async () => {
    // `blocked` is a file, so nothing can be created under it: the backup
    // write must fail and the error must reach stderr with exit 1.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "i am a file");

    const { deps, stderr } = createTestDeps();
    const code = await run(["--config", join(blocked, "milo.config.json"), "--no-pi", "--no-verify"], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("could not write");
    // No uncaught exception propagates; the original file is untouched.
    expect(readFileSync(blocked, "utf8")).toBe("i am a file");
  });

  it("leaves pi's models.json alone under --no-pi", async () => {
    const piPath = join(dir, "pi.json");
    writeFileSync(piPath, JSON.stringify({ providers: { ollama: {} } }));

    const { deps } = createTestDeps();
    const code = await run(["--config", config(), "--pi-config", piPath, "--no-pi", "--no-verify"], deps);

    expect(code).toBe(0);
    expect(readFileSync(piPath, "utf8")).toBe(JSON.stringify({ providers: { ollama: {} } }));
    expect(existsSync(`${piPath}.bak`)).toBe(false);
  });

  it("smoke-verifies end to end and prints the x-milo-model header", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { fetch, calls: fetchCalls } = fakeFetch();
    const { deps, stdout } = createTestDeps({
      env: { JEV_API_KEY: "jev-key", OPENROUTER_API_KEY: "or-key" },
      createGateway,
      serve,
      fetch,
    });

    const code = await run(["--config", config(), "--pi-config", join(dir, "pi.json")], deps);

    expect(code).toBe(0);
    expect(stdout.toString()).toContain(`x-milo-model: ${ROUTED_MODEL}`);

    // The gateway got the running config and Milo's key.
    expect(calls).toHaveLength(1);
    expect(calls[0].jevApiKey).toBe("jev-key");
    expect((calls[0].roster as Roster | undefined)?.fast).toContain(DEFAULT_ROSTER.fast[0]);

    // One routed request: model milo/auto, the user's OpenRouter key.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`http://127.0.0.1:${SMOKE_PORT}/v1/chat/completions`);
    expect(JSON.parse(String(fetchCalls[0].init.body)).model).toBe("milo/auto");
    const auth = fetchCalls[0].init.headers as Record<string, string>;
    expect(auth.authorization).toBe("Bearer or-key");
  });

  it("prompts for keys only when the environment is missing them, and never stores them", async () => {
    const { createGateway, calls } = fakeGateway();
    const { serve } = fakeServe();
    const { fetch, calls: fetchCalls } = fakeFetch();
    const prompts: Array<{ label: string; secret: boolean }> = [];
    const { deps, stdout } = createTestDeps({
      env: {},
      createGateway,
      serve,
      fetch,
      prompt: async (label, secret) => {
        prompts.push({ label, secret });
        return label.includes("Jev") ? "prompted-jev" : "prompted-or";
      },
    });

    const code = await run(["--config", config(), "--pi-config", join(dir, "pi.json")], deps);

    expect(code).toBe(0);
    expect(prompts.map((p) => p.label)).toEqual([
      expect.stringContaining("Jev key"),
      expect.stringContaining("OpenRouter"),
    ]);
    expect(prompts.every((p) => p.secret)).toBe(true);
    // The prompted keys flowed into the smoke run...
    expect(calls[0].jevApiKey).toBe("prompted-jev");
    const auth = fetchCalls[0].init.headers as Record<string, string>;
    expect(auth.authorization).toBe("Bearer prompted-or");
    // ...and never into a file or the streams.
    expect(stdout.toString()).not.toContain("prompted-");
    for (const file of [config(), `${config()}.bak`, join(dir, "pi.json")]) {
      if (existsSync(file)) expect(readFileSync(file, "utf8")).not.toContain("prompted-");
    }
  });

  it("skips the smoke step when a key is missing and the prompt is unanswered", async () => {
    const { createGateway } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stderr } = createTestDeps({
      env: {},
      createGateway,
      serve,
      fetch: async () => new Response(""),
      prompt: async () => undefined,
    });

    const code = await run(["--config", config(), "--pi-config", join(dir, "pi.json")], deps);

    expect(code).toBe(0);
    expect(stderr.toString()).toContain("no JEV_API_KEY");
    // The config was still written -- the smoke step is optional.
    expect(JSON.parse(readFileSync(config(), "utf8"))).toBeTruthy();
  });

  it("fails (exit 1) when the smoke request itself fails", async () => {
    const { createGateway } = fakeGateway();
    const { serve } = fakeServe();
    const { deps, stderr } = createTestDeps({
      env: { JEV_API_KEY: "jev-key", OPENROUTER_API_KEY: "or-key" },
      createGateway,
      serve,
      fetch: async () => new Response("boom", { status: 503 }),
    });

    const code = await run(["--config", config(), "--pi-config", join(dir, "pi.json")], deps);

    expect(code).toBe(1);
    expect(stderr.toString()).toContain("smoke verify failed (HTTP 503)");
    expect(stderr.toString()).toContain("boom");
  });
});

describe("milo configure as wired through runCli", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "milo-cli-configure-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is dispatched from the top-level help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await runCli(["--help"], deps);
    expect(code).toBe(0);
    expect(stdout.toString()).toContain("configure");
    void dir;
  });

  it("dispatches to the configure command's own --help", async () => {
    const { deps, stdout } = createTestDeps();
    const code = await runCli(["configure", "--help"], deps);
    expect(code).toBe(0);
    expect(stdout.toString()).toContain("Usage: milo configure");
    void dir;
  });
});