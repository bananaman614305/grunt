/** `milo serve [--config <path>] [--port <n>] [--host <addr>] [--db <url>]`. */
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { GatewayOptions } from "@milo/gateway";
import { loadConfig } from "../config.js";
import type { MiloConfig } from "../config.js";
import type { CliDeps, ServeOptions } from "../deps.js";

export const help = `Usage: milo serve [options]

Start the local Milo router. It answers OpenAI-compatible requests by running
your own logged-in \`codex\` and \`claude\` CLIs, picking the subscription by
task type and how much of each plan is left.

Options:
  --config <path>   Path to milo.config.json (default: ./milo.config.json if present)
  --port <n>        Port to listen on (overrides PORT, which overrides config)
  --host <addr>     Interface to listen on (default 127.0.0.1; the gateway has no API key)
  --db <url>        Decision log libsql URL (overrides MILO_DB, which overrides config)
  -h, --help        Show this help

Environment:
  JEV_API_KEY   Optional. With it, Jev classifies each request; without it, a
                local keyword heuristic does.
  PORT          Port to listen on (overridden by --port; overrides config)
  MILO_DB       Decision log libsql URL (overridden by --db; overrides config)

Milo never reads your Claude or ChatGPT login. It runs the official CLIs as
child processes, which use their own logins. ANTHROPIC_API_KEY and
OPENAI_API_KEY are removed from the CLIs' environment so they spend your
subscription, not a pay-per-token key.
`;

const FILE_SCHEME = "file:";
const PORT_ENV = "PORT";
const DECISION_LOG_ENV = "MILO_DB";

/** Creates the parent directory of a `file:` decision log URL. */
export function ensureLogDirectory(url: string, cwd: string): void {
  if (!url.startsWith(FILE_SCHEME)) return;
  const filePath = url.slice(FILE_SCHEME.length);
  if (filePath === "" || filePath === ":memory:") return;
  const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  mkdirSync(dirname(resolved), { recursive: true });
}

/** Parses a port value; `undefined` when absent or blank, `null` when invalid. */
function parsePort(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/** The gateway options a config file and environment produce. Exported for `milo usage`. */
export function gatewayOptionsFrom(config: MiloConfig, decisionLogUrl: string, env: NodeJS.ProcessEnv): GatewayOptions {
  const subs = config.subscriptions;
  const backends: NonNullable<GatewayOptions["backends"]> = {};
  for (const id of ["codex", "claude"] as const) {
    const b = subs[id];
    if (b === undefined) continue;
    backends[id] = {
      enabled: b.enabled,
      ...(b.binary !== undefined ? { binary: b.binary } : {}),
      ...(b.model !== undefined ? { model: b.model } : {}),
    };
  }
  const policy: NonNullable<GatewayOptions["policy"]> = {
    ...(subs.reservePercent !== undefined ? { reservePercent: subs.reservePercent } : {}),
    ...(subs.balanceMarginPercent !== undefined ? { balanceMarginPercent: subs.balanceMarginPercent } : {}),
  };
  const jevApiKey = env["JEV_API_KEY"]?.trim();
  return {
    decisionLogUrl,
    backends,
    policy,
    env,
    ...(subs.workdir !== undefined ? { workdir: subs.workdir } : {}),
    ...(subs.timeoutMs !== undefined ? { timeoutMs: subs.timeoutMs } : {}),
    ...(subs.cooldownMs !== undefined ? { cooldownMs: subs.cooldownMs } : {}),
    ...(jevApiKey !== undefined && jevApiKey !== "" ? { jevApiKey } : {}),
  };
}

/** Flag beats environment variable beats config file for the decision log URL. */
export function resolveDecisionLog(config: MiloConfig, env: NodeJS.ProcessEnv, flag: string | undefined): string {
  let url = config.decisionLog;
  const fromEnv = env[DECISION_LOG_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") url = fromEnv;
  if (flag !== undefined) url = flag;
  return url;
}

/**
 * Returns the exit code on a startup failure, or `undefined` on success --
 * the open server keeps the process running until SIGINT/SIGTERM.
 */
export async function run(args: string[], deps: CliDeps): Promise<number | undefined> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        config: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        db: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo serve: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  let config: MiloConfig;
  try {
    config = loadConfig(parsed.values.config).config;
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let port = config.port;
  const envPort = parsePort(deps.env[PORT_ENV]);
  if (envPort === null) {
    deps.stderr.write(`milo serve: ${PORT_ENV} must be a positive integer, got "${deps.env[PORT_ENV]}"\n`);
    return 1;
  }
  if (envPort !== undefined) port = envPort;
  if (parsed.values.port !== undefined) {
    const flagPort = parsePort(parsed.values.port);
    if (flagPort === undefined || flagPort === null) {
      deps.stderr.write(`milo serve: --port must be a positive integer, got "${parsed.values.port}"\n`);
      return 1;
    }
    port = flagPort;
  }
  const hostname = parsed.values.host ?? config.hostname;

  const decisionLogUrl = resolveDecisionLog(config, deps.env, parsed.values.db);
  ensureLogDirectory(decisionLogUrl, process.cwd());

  const options = gatewayOptionsFrom(config, decisionLogUrl, deps.env);
  let gateway;
  try {
    gateway = await deps.createGateway(options);
  } catch (error) {
    deps.stderr.write(`milo serve: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Read plan limits once before taking traffic, so the first request
  // already routes on real numbers where a CLI can report them.
  await gateway.router.refreshLimits(0);

  const serveOptions: ServeOptions = { fetch: gateway.app.fetch, port, hostname };
  const server = deps.serve(serveOptions);

  const baseUrl = `http://${hostname}:${port}`;
  const classifier = options.jevApiKey !== undefined ? "jev" : "local heuristic";
  deps.stdout.write(
    `milo: listening on ${baseUrl} (backends: ${gateway.router.available.join(", ")}; classifier: ${classifier})\n`,
  );
  for (const snapshot of gateway.router.capacity()) {
    const left = snapshot.remainingPercent !== undefined ? `${snapshot.remainingPercent}% left` : "capacity unknown";
    deps.stdout.write(`milo:   ${snapshot.backend}: ${left}${snapshot.window !== undefined ? ` (${snapshot.window})` : ""}\n`);
  }
  deps.stdout.write(`milo: set OPENAI_BASE_URL=${baseUrl}/v1 and use model: "milo/auto"\n`);
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    deps.stderr.write(
      `milo serve: warning: listening on ${hostname}; anyone who can reach it can spend your subscriptions.\n`,
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.stdout.write(`milo: received ${signal}, shutting down\n`);
    server.close(() => {
      void gateway.close();
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return undefined;
}
