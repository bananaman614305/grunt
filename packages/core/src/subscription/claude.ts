/**
 * The Claude subscription, through the official `claude` CLI (ADR-031).
 *
 * Answers run as `claude -p --output-format stream-json` with every built-in
 * tool disabled, MCP servers and user settings ignored, and nothing persisted,
 * in a scratch directory. Claude Code reports the plan's limits on every call
 * as a `rate_limit_event` in that stream, so the meter learns how full the
 * plan is as a side effect of real work. There is no documented way to read
 * the limits without spending a call, so this backend has no `readLimits`.
 */

import { asRecord, classifyCliFailure, lastLine, num, parseJson, truncate } from "./util.js";
import { spawnProcess, subscriptionEnv } from "./spawn.js";
import type { Spawner } from "./spawn.js";
import type { BackendOutcome, BackendRequest, LimitSignal, LimitWindow, SubscriptionBackend } from "./types.js";

export type ClaudeBackendOptions = {
  /** Path or name of the binary. Default `claude` (resolved on PATH). */
  binary?: string;
  /** Default model for every call (`--model`). Absent: Claude Code's own default. */
  model?: string;
  /** Scratch working directory the CLI runs in. */
  workdir: string;
  env?: NodeJS.ProcessEnv;
  /** Keep `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` in the child's environment. Default false. */
  keepApiKeys?: boolean;
  timeoutMs?: number;
  spawn?: Spawner;
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Used when the request carries no system message, so Claude answers as a
 * plain assistant rather than as a coding agent with no tools.
 */
export const DEFAULT_CLAUDE_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer the user's request directly and completely.";

export class ClaudeBackend implements SubscriptionBackend {
  readonly id = "claude" as const;
  readonly label = "Claude (claude)";
  private readonly binary: string;
  private readonly opts: ClaudeBackendOptions;
  private readonly spawner: Spawner;
  private readonly now: () => number;

  constructor(opts: ClaudeBackendOptions) {
    this.opts = opts;
    this.binary = opts.binary ?? "claude";
    this.spawner = opts.spawn ?? spawnProcess;
    this.now = opts.now ?? Date.now;
  }

  /** The exact argv `run` uses. */
  args(opts: { model?: string; system?: string } = {}): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // No tools at all: the CLI answers, it does not act.
      "--tools",
      "",
      "--restricted",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--permission-prompts",
      "none",
      "--disable-slash-commands",
      "--system-prompt",
      opts.system ?? DEFAULT_CLAUDE_SYSTEM_PROMPT,
    ];
    const model = opts.model ?? this.opts.model;
    if (model !== undefined) args.push("--model", model);
    return args;
  }

  async run(req: BackendRequest): Promise<BackendOutcome> {
    const started = this.now();
    let streamed = false;
    let model: string | undefined;
    let limits: LimitSignal | undefined;
    let result: Record<string, unknown> | undefined;

    const onLine = (line: string): void => {
      const event = parseJson(line);
      if (event === undefined) return;
      const type = event["type"];
      if (type === "rate_limit_event") {
        limits = parseClaudeRateLimit(event["rate_limit_info"], new Date(this.now()).toISOString()) ?? limits;
      } else if (type === "stream_event") {
        const inner = asRecord(event["event"]);
        const delta = asRecord(inner?.["delta"]);
        if (inner?.["type"] === "content_block_delta" && delta?.["type"] === "text_delta") {
          const text = delta["text"];
          if (typeof text === "string" && text !== "") {
            streamed = true;
            req.onText?.(text);
          }
        }
      } else if (type === "assistant") {
        const message = asRecord(event["message"]);
        if (typeof message?.["model"] === "string") model = message["model"];
      } else if (type === "result") {
        result = event;
      }
    };

    const args = this.args({
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.system !== undefined ? { system: req.system } : {}),
    });
    const spawned = await this.spawner(this.binary, args, {
      cwd: this.opts.workdir,
      env: subscriptionEnv(this.opts.env ?? process.env, this.opts.keepApiKeys ?? false),
      stdin: req.prompt,
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onLine,
    });
    const latencyMs = this.now() - started;
    const withLimits = limits !== undefined ? { limits } : {};

    if (spawned.spawnError !== undefined) {
      return { ok: false, error: "unavailable", message: `claude could not start: ${spawned.spawnError}`, latencyMs };
    }
    if (spawned.aborted) return { ok: false, error: "aborted", message: "request aborted", ...withLimits, latencyMs };
    if (spawned.timedOut) return { ok: false, error: "timeout", message: "claude timed out", ...withLimits, latencyMs };

    if (result !== undefined && result["is_error"] !== true && result["subtype"] === "success") {
      const text = typeof result["result"] === "string" ? result["result"] : "";
      if (!streamed && text !== "") req.onText?.(text);
      const u = asRecord(result["usage"]);
      const cacheRead = num(u?.["cache_read_input_tokens"]);
      const usage = {
        inputTokens: num(u?.["input_tokens"]) + num(u?.["cache_creation_input_tokens"]) + cacheRead,
        cachedInputTokens: cacheRead,
        outputTokens: num(u?.["output_tokens"]),
        ...(typeof result["total_cost_usd"] === "number" ? { apiEquivalentUsd: result["total_cost_usd"] } : {}),
      };
      return { ok: true, text, ...(model !== undefined ? { model } : {}), usage, ...withLimits, latencyMs };
    }

    const message =
      (typeof result?.["result"] === "string" && result["result"] !== "" ? result["result"] : undefined) ??
      firstError(result?.["errors"]) ??
      lastLine(spawned.stderr) ??
      `claude exited with code ${spawned.code}`;
    const error = limits?.status === "limited" ? "rate_limited" : classifyCliFailure(message);
    return { ok: false, error, message: truncate(message), ...withLimits, latencyMs };
  }
}

/** Parses a `rate_limit_event`'s `rate_limit_info`. Exported for tests. */
export function parseClaudeRateLimit(info: unknown, observedAt: string): LimitSignal | undefined {
  const record = asRecord(info);
  if (record === undefined) return undefined;
  const windows: LimitWindow[] = [];
  const unified = asRecord(record["unifiedWindows"]);
  if (unified !== undefined) {
    for (const [name, value] of Object.entries(unified)) {
      const w = asRecord(value);
      if (w !== undefined) windows.push(toWindow(name, w));
    }
  }
  if (windows.length === 0 && typeof record["rateLimitType"] === "string") {
    windows.push(toWindow(record["rateLimitType"], record));
  }
  const status = record["status"];
  return {
    observedAt,
    status: status === "rejected" ? "limited" : status === "allowed_warning" ? "warning" : "allowed",
    windows,
  };
}

function toWindow(name: string, w: Record<string, unknown>): LimitWindow {
  const window: LimitWindow = { name };
  if (typeof w["utilization"] === "number") window.usedPercent = Math.min(100, Math.max(0, Math.round(w["utilization"] * 1000) / 10));
  if (typeof w["resetsAt"] === "number") window.resetsAt = new Date(w["resetsAt"] * 1000).toISOString();
  return window;
}

function firstError(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  const first: unknown = errors[0];
  return typeof first === "string" ? first : undefined;
}
