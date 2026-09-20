#!/usr/bin/env node
/**
 * Prices context pruning (ADR-014): given a long-history conversation, report
 * the input tokens BEFORE pruning vs AFTER, so the whole point of the gate --
 * fewer input tokens re-sent every turn -- is a measured number.
 *
 * Runs the PURE pipeline (`prunableWindow` + `decidePrune`) with a simulated
 * Jev verdict, so it needs no network and no key; it is the same code the
 * gateway runs, minus the one Jev call. The bundled fixture is a synthetic
 * long agent session (a system brief, several finished tool loops, then the
 * current request); point it at your own with `--fixture <path.json>` (a JSON
 * array of OpenAI chat messages).
 *
 *   pnpm --filter @milo/evals exec tsx scripts/prune-measure.ts
 *   pnpm --filter @milo/evals exec tsx scripts/prune-measure.ts --fixture history.json --finished 0.9 --prunable 3
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHARS_PER_TOKEN,
  decidePrune,
  estimatePromptTokens,
  prunableWindow,
  pruneNote,
} from "@milo/core";
import type { ChatMessage } from "@milo/core";

const INVOKE_CWD = process.env["INIT_CWD"] ?? process.cwd();

/** A synthetic long agent session: finished early work, then the live ask. */
function syntheticHistory(): ChatMessage[] {
  const filler = (label: string, n: number): string =>
    `${label}\n` + `Detailed working notes and intermediate output for ${label}. `.repeat(n);
  const messages: ChatMessage[] = [
    { role: "system", content: filler("You are a repository sub-agent. Follow the plan and use the tools.", 60) },
  ];
  // Three finished tool loops the current request no longer depends on.
  for (let loop = 1; loop <= 3; loop += 1) {
    messages.push({ role: "user", content: filler(`Sub-task ${loop}: investigate and fix module ${loop}.`, 220) });
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `call_${loop}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
    messages.push({ role: "tool", content: filler(`File contents and grep output for module ${loop}.`, 260), tool_call_id: `call_${loop}` });
    messages.push({ role: "assistant", content: filler(`Sub-task ${loop} done: patched module ${loop}, tests green.`, 160) });
  }
  messages.push({ role: "user", content: "All sub-tasks passed. Now write a one-paragraph summary of what changed." });
  return messages;
}

function parseArgs(argv: string[]): { fixture?: string; finished: number; prunable: number; fill?: number } {
  const args: { fixture?: string; finished: number; prunable: number; fill?: number } = { finished: 0.92, prunable: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) continue;
    if (flag === "--fixture") {
      args.fixture = value;
      i += 1;
    } else if (flag === "--finished") {
      args.finished = Number(value);
      i += 1;
    } else if (flag === "--prunable") {
      args.prunable = Number(value);
      i += 1;
    } else if (flag === "--fill") {
      args.fill = Number(value);
      i += 1;
    }
  }
  return args;
}

function loadFixture(path: string): ChatMessage[] {
  const raw = readFileSync(resolve(INVOKE_CWD, path), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("fixture must be a JSON array of chat messages");
  return parsed as ChatMessage[];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const messages = args.fixture !== undefined ? loadFixture(args.fixture) : syntheticHistory();

  const tokensBefore = estimatePromptTokens(messages);
  // Fill ratio: measured over a large default context window unless overridden.
  const fill = args.fill ?? tokensBefore / 128_000;
  const window = prunableWindow(messages);
  const decision = decidePrune({ finishedSafe: args.finished, prunable: args.prunable }, fill, window);

  let after = messages;
  if (decision.prune && decision.from !== undefined && decision.to !== undefined) {
    const note: ChatMessage = { role: "system", content: pruneNote(decision.to - decision.from) };
    after = [...messages.slice(0, decision.from), note, ...messages.slice(decision.to)];
  }
  const tokensAfter = estimatePromptTokens(after);
  const saved = tokensBefore - tokensAfter;
  const pct = tokensBefore > 0 ? (saved / tokensBefore) * 100 : 0;

  const line = (label: string, value: string): string => `${label.padEnd(22)}${value}`;
  process.stdout.write("Context pruning measurement (ADR-014)\n");
  process.stdout.write(`${"-".repeat(48)}\n`);
  process.stdout.write(line("messages before", String(messages.length)) + "\n");
  process.stdout.write(line("messages after", String(after.length)) + "\n");
  process.stdout.write(line("fill ratio", fill.toFixed(3)) + "\n");
  process.stdout.write(line("acting floor", decision.floor.toFixed(2)) + "\n");
  process.stdout.write(line("verdict", decision.prune ? `prune [${decision.from}, ${decision.to})` : "keep") + "\n");
  process.stdout.write(line("reason", decision.reason) + "\n");
  process.stdout.write(`${"-".repeat(48)}\n`);
  process.stdout.write(line("input tokens before", `${tokensBefore} (~${CHARS_PER_TOKEN} chars/token)`) + "\n");
  process.stdout.write(line("input tokens after", String(tokensAfter)) + "\n");
  process.stdout.write(line("input tokens saved", `${saved} (${pct.toFixed(1)}%)`) + "\n");
}

main();
