/**
 * Test-only fake `codex` and `claude` binaries: real executables that the
 * backends spawn as child processes, which record what they were given and
 * print scripted output. Excluded from the build (tsconfig.json).
 *
 * Each fake writes `{ args, input, cwd, env }` to `$FAKE_LOG` and picks its
 * output from `$FAKE_SCENARIO`.
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRELUDE = `#!/usr/bin/env node
const fs = require("fs");
const scenario = process.env.FAKE_SCENARIO || "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const record = (args, input) => {
  if (!process.env.FAKE_LOG) return;
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({
    args, input, cwd: process.cwd(),
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      KEEP_ME: process.env.KEEP_ME ?? null,
    },
  }));
};
const readStdin = (fn) => { let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => fn(input)); };
`;

const CODEX = `${PRELUDE}
const args = process.argv.slice(2);
if (args[0] === "app-server") {
  const rl = require("readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") out({ id: msg.id, result: { userAgent: "fake" } });
    if (msg.method === "account/rateLimits/read") {
      if (scenario === "limits_fail") { out({ id: msg.id, error: { message: "nope" } }); return; }
      out({ method: "account/updated", params: {} });
      out({ id: msg.id, result: { rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1900000000 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1900500000 },
        rateLimitReachedType: null,
      } } });
    }
  });
} else {
  readStdin((input) => {
    record(args, input);
    out({ type: "thread.started", thread_id: "t1" });
    out({ type: "item.completed", item: { id: "i0", type: "error", message: "Under-development features enabled" } });
    out({ type: "turn.started" });
    if (scenario === "rate_limited") {
      out({ type: "error", message: "You've hit your usage limit. Try again at 3:04 PM." });
      out({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again at 3:04 PM." } });
      process.exit(1);
    }
    if (scenario === "slow") { setTimeout(() => {}, 60000); return; }
    out({ type: "item.completed", item: { id: "i1", type: "reasoning", text: "thinking" } });
    out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "pong from codex" } });
    out({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 7, reasoning_output_tokens: 0 } });
  });
}
`;

const CLAUDE = `${PRELUDE}
const args = process.argv.slice(2);
readStdin((input) => {
  record(args, input);
  out({ type: "system", subtype: "init", tools: [], model: "claude-sonnet-5-5", apiKeySource: "none" });
  const rejected = scenario === "rate_limited";
  out({ type: "rate_limit_event", rate_limit_info: {
    status: rejected ? "rejected" : "allowed_warning",
    resetsAt: 1900000000, rateLimitType: "seven_day", utilization: rejected ? 1 : 0.83,
    unifiedWindows: {
      seven_day: { utilization: rejected ? 1 : 0.83, resetsAt: 1900000000, status: rejected ? "rejected" : "allowed_warning" },
      five_hour: { utilization: 0.2, resetsAt: 1899990000, status: "allowed" },
    },
  } });
  if (rejected) {
    out({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Your limit will reset at 12am." });
    process.exit(1);
  }
  if (scenario === "error") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["something broke"] });
    process.exit(1);
  }
  out({ type: "stream_event", event: { type: "message_start", message: { model: "claude-sonnet-5-5" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong " } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from claude" } } });
  out({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "pong from claude" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "pong from claude", total_cost_usd: 0.0123,
    usage: { input_tokens: 5, cache_creation_input_tokens: 300, cache_read_input_tokens: 600, output_tokens: 9 } });
});
`;

export type FakeClis = { dir: string; codex: string; claude: string; log: string };

export function writeFakeClis(): FakeClis {
  const dir = mkdtempSync(join(tmpdir(), "milo-fake-cli-"));
  const codex = join(dir, "codex");
  const claude = join(dir, "claude");
  writeFileSync(codex, CODEX);
  writeFileSync(claude, CLAUDE);
  chmodSync(codex, 0o755);
  chmodSync(claude, 0o755);
  return { dir, codex, claude, log: join(dir, "invocation.json") };
}
