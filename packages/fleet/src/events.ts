/**
 * The ordered, per-event view of a worker's pi stream that the supervisor
 * reasons over. `PiEventParser` (./pi-events.ts) aggregates the same lines
 * into totals; this module keeps the *sequence* -- which tool ran when, how
 * long the worker has been quiet, whether any edit has landed -- because the
 * signal firstmate-style process supervisors lack is content over time, not a
 * running count.
 *
 * A `WorkerEvent` is deliberately small: a kind, a monotonic timestamp, and
 * the one field that kind carries. The supervisor never sees raw pi JSON or
 * any message content -- only this shape -- so no generated text rides into
 * the Jev supervision call beyond the coarse summary `supervisor.ts` builds.
 */

import { num, record, TOOL_START_TYPES } from "./pi-events.js";

/** Tool names whose execution means the worker changed files on disk. */
export const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch", "str_replace", "create_file"]);

export type WorkerEvent =
  | { kind: "turn"; at: number; outputTokens: number }
  | { kind: "tool"; at: number; tool: string; edits: boolean }
  | { kind: "malformed"; at: number };

/**
 * Classify one JSONL line from pi into at most one `WorkerEvent`. `at` is the
 * wall-clock the line arrived (injected, so tests are deterministic). Lines
 * that are not turns or tool starts return `undefined` and are dropped from
 * the window; an unparseable line becomes a `malformed` marker so a worker
 * emitting only garbage still looks like activity to liveness but produces no
 * progress signal.
 */
export function classifyLine(raw: string, at: number): WorkerEvent | undefined {
  const line = raw.trim();
  if (line === "") return undefined;

  let event: Record<string, unknown> | undefined;
  try {
    event = record(JSON.parse(line));
  } catch {
    return { kind: "malformed", at };
  }
  if (event === undefined) return { kind: "malformed", at };

  const type = typeof event["type"] === "string" ? event["type"] : "";

  if (type === "message_end") {
    const message = record(event["message"]);
    const role = message?.["role"];
    if (typeof role === "string" && role !== "assistant") return undefined;
    const usage = message === undefined ? undefined : record(message["usage"]);
    const output = usage === undefined ? 0 : num(usage["output"]) || num(usage["output_tokens"]);
    return { kind: "turn", at, outputTokens: output };
  }

  if (TOOL_START_TYPES.has(type)) {
    const name =
      [event["toolName"], event["tool_name"], event["name"]].find(
        (v): v is string => typeof v === "string" && v !== "",
      ) ?? "unknown";
    return { kind: "tool", at, tool: name, edits: EDIT_TOOL_NAMES.has(name.toLowerCase()) };
  }

  return undefined;
}

/**
 * A growing buffer of a worker's ordered events. The worker runtime feeds pi
 * stdout lines into `feedLine`; the supervisor reads a trailing window with
 * `recent`. `lastActivityAt` backs the idle gate, and `list()` is the whole
 * ordered log for the final result record.
 */
export class WorkerEventLog {
  private readonly events: WorkerEvent[] = [];

  feedLine(raw: string, at: number): void {
    const event = classifyLine(raw, at);
    if (event !== undefined) this.events.push(event);
  }

  /** All events, oldest first. */
  list(): readonly WorkerEvent[] {
    return this.events;
  }

  /** The last `n` events, oldest first. */
  recent(n: number): WorkerEvent[] {
    return n >= this.events.length ? [...this.events] : this.events.slice(this.events.length - n);
  }

  /** Timestamp of the most recent event, or `undefined` if none yet. */
  lastActivityAt(): number | undefined {
    const last = this.events[this.events.length - 1];
    return last?.at;
  }
}
