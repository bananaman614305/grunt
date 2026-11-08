import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeBackend, parseClaudeRateLimit } from "./claude.js";
import { CodexBackend, parseCodexRateLimits } from "./codex.js";
import { writeFakeClis } from "./test-support.js";
import type { FakeClis } from "./test-support.js";

type Invocation = { args: string[]; input: string; cwd: string; env: Record<string, string | null> };

describe("subscription CLI backends (fake binaries)", () => {
  let fakes: FakeClis;
  const env = (scenario = "ok"): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    FAKE_LOG: fakes.log,
    FAKE_SCENARIO: scenario,
    ANTHROPIC_API_KEY: "sk-ant-should-not-reach-cli",
    OPENAI_API_KEY: "sk-should-not-reach-cli",
    KEEP_ME: "kept",
  });
  const invocation = (): Invocation => JSON.parse(readFileSync(fakes.log, "utf8")) as Invocation;

  beforeEach(() => {
    fakes = writeFakeClis();
  });
  afterEach(() => {
    rmSync(fakes.dir, { recursive: true, force: true });
  });

  describe("codex", () => {
    it("spawns the codex binary read-only in the scratch directory and parses the answer", async () => {
      const backend = new CodexBackend({ binary: fakes.codex, workdir: fakes.dir, env: env() });
      const deltas: string[] = [];

      const outcome = await backend.run({ system: "Be terse.", prompt: "ping", onText: (d) => deltas.push(d) });

      expect(outcome).toMatchObject({
        ok: true,
        text: "pong from codex",
        usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 7 },
      });
      expect(deltas).toEqual(["pong from codex"]);
      const call = invocation();
      expect(call.args.slice(0, 6)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"]);
      expect(call.args).toContain("-C");
      expect(call.args.at(-1)).toBe("-");
      expect(call.input).toBe("Instructions:\nBe terse.\n\nping");
      expect(call.cwd).toBe(fakes.dir);
    });

    it("removes pay-per-token API keys from the CLI's environment and keeps the rest", async () => {
      const backend = new CodexBackend({ binary: fakes.codex, workdir: fakes.dir, env: env() });
      await backend.run({ prompt: "ping" });
      expect(invocation().env).toEqual({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null, KEEP_ME: "kept" });
    });

    it("passes a model override with -m", async () => {
      const backend = new CodexBackend({ binary: fakes.codex, workdir: fakes.dir, env: env(), model: "gpt-x" });
      await backend.run({ prompt: "ping", model: "gpt-y" });
      const args = invocation().args;
      expect(args[args.indexOf("-m") + 1]).toBe("gpt-y");
    });

    it("reports a usage-limit refusal as rate_limited", async () => {
      const backend = new CodexBackend({ binary: fakes.codex, workdir: fakes.dir, env: env("rate_limited") });
      const outcome = await backend.run({ prompt: "ping" });
      expect(outcome).toMatchObject({ ok: false, error: "rate_limited" });
    });

    it("reports a missing binary as unavailable", async () => {
      const backend = new CodexBackend({ binary: join(fakes.dir, "nope"), workdir: fakes.dir, env: env() });
      const outcome = await backend.run({ prompt: "ping" });
      expect(outcome).toMatchObject({ ok: false, error: "unavailable" });
    });

    it("times out a CLI that never finishes", async () => {
      const backend = new CodexBackend({ binary: fakes.codex, workdir: fakes.dir, env: env("slow"), timeoutMs: 300 });
      const outcome = await backend.run({ prompt: "ping" });
      expect(outcome).toMatchObject({ ok: false, error: "timeout" });
    });

    it("reads plan limits from codex app-server without running a prompt", async () => {
      const backend = new CodexBackend({ binary: fakes.codex, workdir: fakes.dir, env: env(), now: () => 0 });
      const limits = await backend.readLimits();
      expect(limits).toEqual({
        observedAt: new Date(0).toISOString(),
        status: "allowed",
        windows: [
          { name: "5h", usedPercent: 37, resetsAt: new Date(1_900_000_000_000).toISOString(), windowMinutes: 300 },
          { name: "weekly", usedPercent: 12, resetsAt: new Date(1_900_500_000_000).toISOString(), windowMinutes: 10080 },
        ],
      });
    });

    it("resolves undefined when the limits read fails", async () => {
      const backend = new CodexBackend({
        binary: fakes.codex,
        workdir: fakes.dir,
        env: env("limits_fail"),
        limitsTimeoutMs: 2_000,
      });
      expect(await backend.readLimits()).toBeUndefined();
    });

    it("parses a reached limit as limited", () => {
      const parsed = parseCodexRateLimits(
        { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 10 }, rateLimitReachedType: "primary" } },
        "t",
      );
      expect(parsed?.status).toBe("limited");
      expect(parseCodexRateLimits({}, "t")).toBeUndefined();
    });
  });

  describe("claude", () => {
    it("spawns claude -p with every tool disabled and parses the streamed answer and plan limits", async () => {
      const backend = new ClaudeBackend({ binary: fakes.claude, workdir: fakes.dir, env: env(), now: () => 0 });
      const deltas: string[] = [];

      const outcome = await backend.run({ prompt: "ping", onText: (d) => deltas.push(d) });

      expect(outcome).toMatchObject({
        ok: true,
        text: "pong from claude",
        model: "claude-sonnet-5-5",
        usage: { inputTokens: 905, cachedInputTokens: 600, outputTokens: 9, apiEquivalentUsd: 0.0123 },
        limits: {
          status: "warning",
          windows: [
            { name: "seven_day", usedPercent: 83 },
            { name: "five_hour", usedPercent: 20 },
          ],
        },
      });
      expect(deltas).toEqual(["pong ", "from claude"]);
      const call = invocation();
      expect(call.args.slice(0, 3)).toEqual(["-p", "--output-format", "stream-json"]);
      expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
      expect(call.args).toEqual(expect.arrayContaining(["--restricted", "--strict-mcp-config", "--no-session-persistence"]));
      expect(call.input).toBe("ping");
      expect(call.env).toEqual({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null, KEEP_ME: "kept" });
    });

    it("sends the request's system message as the system prompt", async () => {
      const backend = new ClaudeBackend({ binary: fakes.claude, workdir: fakes.dir, env: env() });
      await backend.run({ prompt: "ping", system: "Answer in French." });
      const args = invocation().args;
      expect(args[args.indexOf("--system-prompt") + 1]).toBe("Answer in French.");
    });

    it("reports a rejected plan as rate_limited, with the limits it saw", async () => {
      const backend = new ClaudeBackend({ binary: fakes.claude, workdir: fakes.dir, env: env("rate_limited") });
      const outcome = await backend.run({ prompt: "ping" });
      expect(outcome).toMatchObject({ ok: false, error: "rate_limited", limits: { status: "limited" } });
    });

    it("reports other CLI errors as failed", async () => {
      const backend = new ClaudeBackend({ binary: fakes.claude, workdir: fakes.dir, env: env("error") });
      const outcome = await backend.run({ prompt: "ping" });
      expect(outcome).toMatchObject({ ok: false, error: "failed", message: "something broke" });
    });

    it("parses a single-window rate limit event", () => {
      expect(parseClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1 }, "t")).toEqual({
        observedAt: "t",
        status: "allowed",
        windows: [{ name: "five_hour", usedPercent: 50, resetsAt: new Date(1000).toISOString() }],
      });
    });
  });
});
