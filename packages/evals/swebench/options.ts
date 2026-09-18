/**
 * Flag parsing for the SWE-bench generator. Kept apart from `generate.ts`
 * (which clones repos and spawns pi) so the whole surface is unit-testable
 * without a network, Docker, or the agent.
 *
 * Instance selection itself lives in `instances.ts` (it operates on loaded
 * instances, not on directories); this module only turns argv into options.
 */

export const DEFAULT_GATEWAY = "http://127.0.0.1:8787/v1";
/** SWE-bench tasks are long: 30 minutes per instance by default. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;
/** The predictions shape names the agent, not the underlying model. */
export const DEFAULT_MODEL_NAME = "milo/auto";

export type SwebenchOptions = {
  /** Local JSONL dataset export the operator supplies. */
  dataset: string;
  /** Instance ids to run, or "all". */
  instances: string[] | "all";
  /** Cap on the number of selected instances; undefined means no cap. */
  limit?: number;
  /** Directory of pre-cloned bare repos, to avoid re-download at run time. */
  repoCache?: string;
  /** Gateway base URL; recorded and used for `/v1/decisions` attribution. */
  gateway: string;
  /** Directory predictions.jsonl and run.json are written into. */
  out: string;
  /** Per-instance budget for the pi run, in milliseconds. */
  timeoutMs: number;
  /** model_name_or_path written into predictions.jsonl. */
  modelName: string;
  /** Keep each instance's temp workdir instead of deleting it. */
  keep: boolean;
  /** Sets PI_CODING_AGENT_DIR for the pi child (provider/model config dir). */
  piAgentDir?: string;
};

export function parseSwebenchArgs(argv: string[], defaultOut: string): SwebenchOptions {
  const options: SwebenchOptions = {
    dataset: "",
    instances: "all",
    gateway: DEFAULT_GATEWAY,
    out: defaultOut,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    modelName: DEFAULT_MODEL_NAME,
    keep: false,
  };

  const take = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dataset":
        options.dataset = take(arg, argv[++i]);
        break;
      case "--instances": {
        const value = take(arg, argv[++i]);
        options.instances =
          value === "all" ? "all" : value.split(",").map((s) => s.trim()).filter((s) => s !== "");
        if (options.instances !== "all" && options.instances.length === 0) {
          throw new Error("--instances got an empty list");
        }
        break;
      }
      case "--limit": {
        const n = Number(take(arg, argv[++i]));
        if (!Number.isInteger(n) || n <= 0) throw new Error("--limit needs a positive integer");
        options.limit = n;
        break;
      }
      case "--repo-cache":
        options.repoCache = take(arg, argv[++i]);
        break;
      case "--gateway":
        options.gateway = take(arg, argv[++i]);
        break;
      case "--out":
        options.out = take(arg, argv[++i]);
        break;
      case "--timeout": {
        const seconds = Number(take(arg, argv[++i]));
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout needs a positive number of seconds");
        options.timeoutMs = seconds * 1000;
        break;
      }
      case "--model-name":
        options.modelName = take(arg, argv[++i]);
        break;
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

  if (options.dataset === "") throw new Error("--dataset <path> is required");
  return options;
}
