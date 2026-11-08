/**
 * The ChatGPT subscription, through the official `codex` CLI (ADR-031).
 *
 * Answers run as `codex exec --json` in a scratch directory under the
 * read-only sandbox, so a prompt cannot make Codex edit files. Plan limits
 * are read from `codex app-server`'s documented `account/rateLimits/read`
 * request, which reports the plan's usage without spending any of it. Codex
 * authenticates both itself; Milo only reads what they print.
 */

import { spawn } from "node:child_process";
import { asRecord, classifyCliFailure, lastLine, num, parseJson, truncate } from "./util.js";
import { spawnProcess, subscriptionEnv } from "./spawn.js";
import type { Spawner } from "./spawn.js";
import type { BackendOutcome, BackendRequest, LimitSignal, LimitWindow, SubscriptionBackend } from "./types.js";

export type CodexBackendOptions = {
  /** Path or name of the binary. Default `codex` (resolved on PATH). */
  binary?: string;
  /** Default model for every call (`-m`). Absent: Codex's own configured default. */
  model?: string;
  /** Scratch working directory the CLI runs in. */
  workdir: string;
  env?: NodeJS.ProcessEnv;
  /** Keep `OPENAI_API_KEY`/`CODEX_API_KEY` in the child's environment. Default false. */
  keepApiKeys?: boolean;
  timeoutMs?: number;
  /** How long a limits read may take. Default 15 s. */
  limitsTimeoutMs?: number;
  spawn?: Spawner;
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LIMITS_TIMEOUT_MS = 15_000;

export class CodexBackend implements SubscriptionBackend {
  readonly id = "codex" as const;
  readonly label = "ChatGPT (codex)";
  private readonly binary: string;
  private readonly opts: CodexBackendOptions;
  private readonly spawner: Spawner;
  private readonly now: () => number;

  constructor(opts: CodexBackendOptions) {
    this.opts = opts;
    this.binary = opts.binary ?? "codex";
    this.spawner = opts.spawn ?? spawnProcess;
    this.now = opts.now ?? Date.now;
  }

  /** The exact argv `run` uses; exported for tests and `milo usage --verbose`. */
  args(model?: string): string[] {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-C",
      this.opts.workdir,
    ];
    const chosen = model ?? this.opts.model;
    if (chosen !== undefined) args.push("-m", chosen);
    // The prompt arrives on stdin.
    args.push("-");
    return args;
  }

  async run(req: BackendRequest): Promise<BackendOutcome> {
    const started = this.now();
    const texts: string[] = [];
    let usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let failure: string | undefined;

    const onLine = (line: string): void => {
      const event = parseJson(line);
      if (event === undefined) return;
      const type = event["type"];
      if (type === "item.completed") {
        const item = asRecord(event["item"]);
        if (item?.["type"] === "agent_message" && typeof item["text"] === "string") {
          // Separate consecutive messages the same way the final answer joins them.
          const delta = texts.length === 0 ? item["text"] : `\n\n${item["text"]}`;
          texts.push(item["text"]);
          req.onText?.(delta);
        }
      } else if (type === "turn.completed") {
        const u = asRecord(event["usage"]);
        usage = {
          inputTokens: num(u?.["input_tokens"]),
          cachedInputTokens: num(u?.["cached_input_tokens"]),
          outputTokens: num(u?.["output_tokens"]),
        };
      } else if (type === "turn.failed") {
        const error = asRecord(event["error"]);
        failure = typeof error?.["message"] === "string" ? error["message"] : "turn failed";
      } else if (type === "error" && typeof event["message"] === "string") {
        failure = event["message"];
      }
    };

    const stdin = req.system === undefined ? req.prompt : `Instructions:\n${req.system}\n\n${req.prompt}`;
    const result = await this.spawner(this.binary, this.args(req.model), {
      cwd: this.opts.workdir,
      env: subscriptionEnv(this.opts.env ?? process.env, this.opts.keepApiKeys ?? false),
      stdin,
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onLine,
    });
    const latencyMs = this.now() - started;

    if (result.spawnError !== undefined) {
      return { ok: false, error: "unavailable", message: `codex could not start: ${result.spawnError}`, latencyMs };
    }
    if (result.aborted) return { ok: false, error: "aborted", message: "request aborted", latencyMs };
    if (result.timedOut) return { ok: false, error: "timeout", message: "codex timed out", latencyMs };

    if (usage !== undefined && failure === undefined && result.code === 0) {
      const text = texts.join("\n\n");
      return {
        ok: true,
        text,
        ...(req.model ?? this.opts.model ? { model: req.model ?? this.opts.model } : {}),
        usage,
        latencyMs,
      };
    }

    const message = failure ?? lastLine(result.stderr) ?? `codex exited with code ${result.code}`;
    return { ok: false, error: classifyCliFailure(message), message: truncate(message), latencyMs };
  }

  /**
   * Asks `codex app-server` for the plan's rate limits. Starts the server,
   * sends `initialize`, `initialized` and `account/rateLimits/read`, and stops
   * it as soon as the answer arrives. Resolves `undefined` on any failure.
   */
  readLimits(signal?: AbortSignal): Promise<LimitSignal | undefined> {
    const timeoutMs = this.opts.limitsTimeoutMs ?? DEFAULT_LIMITS_TIMEOUT_MS;
    return new Promise((resolve) => {
      let settled = false;
      let buffered = "";
      const child = spawn(this.binary, ["app-server"], {
        cwd: this.opts.workdir,
        env: subscriptionEnv(this.opts.env ?? process.env, this.opts.keepApiKeys ?? false),
        stdio: ["pipe", "pipe", "ignore"],
      });
      const done = (value: LimitSignal | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.stdin.end();
        child.kill("SIGTERM");
        resolve(value);
      };
      const onAbort = (): void => done(undefined);
      const timer = setTimeout(() => done(undefined), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });

      const send = (message: Record<string, unknown>): void => {
        if (!child.stdin.writable) return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      child.on("error", () => done(undefined));
      child.on("close", () => done(undefined));
      child.stdin.on("error", () => {});
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          const message = parseJson(line);
          if (message === undefined) continue;
          if (message["id"] === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/rateLimits/read", params: null });
          } else if (message["id"] === 2) {
            done(parseCodexRateLimits(message["result"], new Date(this.now()).toISOString()));
          }
        }
      });

      send({ id: 1, method: "initialize", params: { clientInfo: { name: "milo", title: "Milo", version: "0.0.1" } } });
    });
  }
}

/** Parses an `account/rateLimits/read` result. Exported for tests. */
export function parseCodexRateLimits(result: unknown, observedAt: string): LimitSignal | undefined {
  const limits = asRecord(asRecord(result)?.["rateLimits"]);
  if (limits === undefined) return undefined;
  const windows: LimitWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const w = asRecord(limits[key]);
    if (w === undefined) continue;
    const minutes = typeof w["windowDurationMins"] === "number" ? w["windowDurationMins"] : undefined;
    const window: LimitWindow = { name: windowName(minutes, key) };
    if (typeof w["usedPercent"] === "number") window.usedPercent = clampPercent(w["usedPercent"]);
    if (typeof w["resetsAt"] === "number") window.resetsAt = new Date(w["resetsAt"] * 1000).toISOString();
    if (minutes !== undefined) window.windowMinutes = minutes;
    windows.push(window);
  }
  const reached = limits["rateLimitReachedType"] !== null && limits["rateLimitReachedType"] !== undefined;
  const maxUsed = Math.max(0, ...windows.map((w) => w.usedPercent ?? 0));
  const status = reached || maxUsed >= 100 ? "limited" : maxUsed >= 80 ? "warning" : "allowed";
  return { observedAt, status, windows };
}

function windowName(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined) return fallback;
  if (minutes === 300) return "5h";
  if (minutes === 10_080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
