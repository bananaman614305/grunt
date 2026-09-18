/**
 * Flag parsing and task selection for the agentic benchmark runner.
 * Kept apart from `run.ts` (which spawns processes) so both are unit-testable
 * without pi or a gateway.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_GATEWAY = "http://127.0.0.1:8787/v1";
export const DEFAULT_TIMEOUT_SECONDS = 600;

export type AgenticOptions = {
  /** Task ids to run, or "all". */
  tasks: string[] | "all";
  /** Gateway base URL; recorded in the report and used for `/v1/decisions`. */
  gateway: string;
  /** Directory reports are written into. */
  out: string;
  /** Explicit path for the JSON report; default is next to the markdown. */
  json?: string;
  /** Per-task budget for the pi run, in milliseconds. */
  timeoutMs: number;
  /** Keep each task's temp workdir instead of deleting it. */
  keep: boolean;
  /** Sets PI_CODING_AGENT_DIR for the pi child (provider/model config dir). */
  piAgentDir?: string;
};

export function parseAgenticArgs(argv: string[], defaultOut: string): AgenticOptions {
  const options: AgenticOptions = {
    tasks: "all",
    gateway: DEFAULT_GATEWAY,
    out: defaultOut,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    keep: false,
  };

  const take = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--tasks": {
        const value = take(arg, argv[++i]);
        options.tasks = value === "all" ? "all" : value.split(",").map((s) => s.trim()).filter((s) => s !== "");
        if (options.tasks !== "all" && options.tasks.length === 0) throw new Error("--tasks got an empty list");
        break;
      }
      case "--gateway":
        options.gateway = take(arg, argv[++i]);
        break;
      case "--out":
        options.out = take(arg, argv[++i]);
        break;
      case "--json":
        options.json = take(arg, argv[++i]);
        break;
      case "--timeout": {
        const seconds = Number(take(arg, argv[++i]));
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout needs a positive number of seconds");
        options.timeoutMs = seconds * 1000;
        break;
      }
      case "--keep":
        options.keep = true;
        break;
      case "--pi-agent-dir":
        options.piAgentDir = take(arg, argv[++i]);
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return options;
}

/**
 * Resolve the selection against the task directories on disk. Ids come back
 * sorted; asking for a task that does not exist is an error rather than a
 * silent skip, so a typo cannot shrink the benchmark unnoticed.
 */
export function selectTasks(tasksDir: string, selection: string[] | "all"): string[] {
  const available = readdirSync(tasksDir)
    .filter((name) => {
      try {
        return statSync(join(tasksDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  if (selection === "all") return available;

  const known = new Set(available);
  const missing = selection.filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(", ")}`);
  return [...new Set(selection)].sort();
}
