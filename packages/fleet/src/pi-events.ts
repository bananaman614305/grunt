/**
 * Parser for the JSONL event stream `pi -p --mode json` writes to stdout.
 *
 * VENDORED, unchanged in behaviour, from `packages/evals/agentic/pi-events.ts`
 * (ADR-013 phase B). The agentic parser is standalone by design -- it imports
 * nothing and treats pi's event vocabulary as untrusted -- so the fleet reuses
 * it rather than depending on `@milo/evals`, which is a dev/eval package. Keep
 * the two copies in sync; if a third consumer appears, promote it into
 * `@milo/core`. The ordered per-event view the supervisor needs lives in
 * `./events.ts`, which classifies the same lines this aggregator counts.
 *
 * The stream is one JSON object per line. We care about three families:
 *
 *   - `message_end` events carrying an assistant message with `usage`
 *     (a completed assistant turn -- the turn counter and the token totals),
 *   - tool execution events (`tool_execution_start` and start variants),
 *     counted per tool name,
 *   - everything else, which is skipped.
 *
 * pi's exact event vocabulary is not a contract we control, so the parser is
 * deliberately tolerant: unknown event types and unparseable lines are
 * counted but never fatal, and usage fields are read under both camelCase
 * and snake_case names.
 */

export type PiUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider-reported USD cost summed over turns; 0 when pi reports none. */
  costUsd: number;
};

export type PiRunStats = {
  /** Completed assistant messages. */
  turns: number;
  /** Tool executions by tool name. */
  toolCalls: Record<string, number>;
  toolCallTotal: number;
  usage: PiUsage;
  /** Lines that were not valid JSON objects. */
  malformedLines: number;
};

export const TOOL_START_TYPES = new Set([
  "tool_execution_start",
  "tool_call_start",
  "tool_start",
  "tool_use",
]);

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readUsage(usage: Record<string, unknown>): PiUsage {
  const cost = record(usage["cost"]);
  const flatCost = num(usage["cost"]);
  return {
    input: num(usage["input"]) || num(usage["input_tokens"]) || num(usage["inputTokens"]),
    output: num(usage["output"]) || num(usage["output_tokens"]) || num(usage["outputTokens"]),
    cacheRead: num(usage["cacheRead"]) || num(usage["cache_read_input_tokens"]),
    cacheWrite: num(usage["cacheWrite"]) || num(usage["cache_creation_input_tokens"]),
    costUsd: cost !== undefined ? num(cost["total"]) : flatCost || num(usage["totalCost"]),
  };
}

/** Feed stdout chunks as they arrive; call `end()` once, then read `stats()`. */
export class PiEventParser {
  private buffer = "";
  private ended = false;
  private readonly result: PiRunStats = {
    turns: 0,
    toolCalls: {},
    toolCallTotal: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    malformedLines: 0,
  };

  feed(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.takeLine(line);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.takeLine(this.buffer);
    this.buffer = "";
  }

  stats(): PiRunStats {
    return this.result;
  }

  private takeLine(raw: string): void {
    const line = raw.trim();
    if (line === "") return;
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line));
    } catch {
      event = undefined;
    }
    if (event === undefined) {
      this.result.malformedLines += 1;
      return;
    }
    const type = typeof event["type"] === "string" ? event["type"] : "";

    if (type === "message_end") {
      const message = record(event["message"]);
      const role = message?.["role"];
      if (typeof role === "string" && role !== "assistant") return;
      this.result.turns += 1;
      const usage = message === undefined ? undefined : record(message["usage"]);
      if (usage !== undefined) {
        const turn = readUsage(usage);
        this.result.usage.input += turn.input;
        this.result.usage.output += turn.output;
        this.result.usage.cacheRead += turn.cacheRead;
        this.result.usage.cacheWrite += turn.cacheWrite;
        this.result.usage.costUsd += turn.costUsd;
      }
      return;
    }

    if (TOOL_START_TYPES.has(type)) {
      const name =
        [event["toolName"], event["tool_name"], event["name"]].find(
          (v): v is string => typeof v === "string" && v !== "",
        ) ?? "unknown";
      this.result.toolCalls[name] = (this.result.toolCalls[name] ?? 0) + 1;
      this.result.toolCallTotal += 1;
    }
  }
}

/** One-shot convenience over `PiEventParser` for a fully buffered stream. */
export function parsePiEvents(text: string): PiRunStats {
  const parser = new PiEventParser();
  parser.feed(text);
  parser.end();
  return parser.stats();
}
