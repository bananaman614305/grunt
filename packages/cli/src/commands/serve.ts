/** `milo serve [--config <path>] [--port <n>] [--db <url>]`. */
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { POLICY_VERSION } from "@milo/core";
import type { GatewayOptions } from "@milo/gateway";
import { loadConfig, resolveDecisionBackend } from "../config.js";
import type { CliDeps, ServeOptions } from "../deps.js";

export const help = `Usage: milo serve [options]

Start the Milo gateway server. Reads Milo's Jev key from the JEV_API_KEY
environment variable, unless the decision backend is "system-one-open",
which needs no key.

Options:
  --config <path>   Path to milo.config.json (default: ./milo.config.json if present)
  --port <n>        Port to listen on (overrides config)
  --db <url>        Decision log libsql URL (overrides config)
  -h, --help        Show this help

Environment:
  JEV_API_KEY             Milo's Jev key (required for the jev backends)
  MILO_DECISION_BACKEND   jev | system-one-open | jev-with-fallback
  SYSTEM_ONE_OPEN_URL     Base URL of a system-one-open deployment
`;

const FILE_SCHEME = "file:";

/** Creates the parent directory of a `file:` decision log URL that resolves under `cwd`. */
function ensureLogDirectory(url: string, cwd: string): void {
  if (!url.startsWith(FILE_SCHEME)) return;
  const filePath = url.slice(FILE_SCHEME.length);
  if (filePath === "" || filePath === ":memory:" || isAbsolute(filePath)) return;
  mkdirSync(dirname(resolve(cwd, filePath)), { recursive: true });
}

/**
 * Returns the exit code on a startup failure, or `undefined` on success --
 * the process is meant to keep running (the open server keeps the event
 * loop alive) until SIGINT/SIGTERM, at which point `runCli`'s caller does
 * not call `process.exit` on our behalf.
 */
export async function run(args: string[], deps: CliDeps): Promise<number | undefined> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        config: { type: "string" },
        port: { type: "string" },
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

  // The config is read first: which decision backend is configured decides
  // whether a Jev key is needed at all (ADR-004).
  let loaded;
  let decisionBackend;
  try {
    loaded = loadConfig(parsed.values.config);
    decisionBackend = resolveDecisionBackend(loaded.config, deps.env);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { config } = loaded;
  const backendKind = decisionBackend?.kind ?? "jev";

  const jevApiKey = deps.env["JEV_API_KEY"] ?? "";
  if (!jevApiKey && backendKind !== "system-one-open") {
    deps.stderr.write(
      `milo serve: JEV_API_KEY is not set. Export JEV_API_KEY with Milo's Jev key before running ` +
        `\`milo serve\`, or set MILO_DECISION_BACKEND=system-one-open to route with the open backend, ` +
        `which needs no key.\n`,
    );
    return 1;
  }

  let port = config.port;
  if (parsed.values.port !== undefined) {
    const parsedPort = Number(parsed.values.port);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
      deps.stderr.write(`milo serve: --port must be a positive integer, got "${parsed.values.port}"\n`);
      return 1;
    }
    port = parsedPort;
  }

  const decisionLogUrl = parsed.values.db ?? config.decisionLog;
  ensureLogDirectory(decisionLogUrl, process.cwd());

  const gatewayOptions: GatewayOptions = {
    jevApiKey,
    decisionLogUrl,
    ...(decisionBackend !== undefined ? { decisionBackend } : {}),
    ...(config.roster !== undefined ? { roster: config.roster } : {}),
    ...(config.rateLimit !== undefined ? { rateLimit: config.rateLimit } : {}),
    ...(config.referer !== undefined ? { referer: config.referer } : {}),
    ...(config.title !== undefined ? { title: config.title } : {}),
    ...(config.jevTimeoutMs !== undefined ? { jevTimeoutMs: config.jevTimeoutMs } : {}),
  };

  const gateway = await deps.createGateway(gatewayOptions);

  const serveOptions: ServeOptions = {
    fetch: gateway.app.fetch,
    port,
    ...(config.hostname !== undefined ? { hostname: config.hostname } : {}),
  };
  const server = deps.serve(serveOptions);

  const displayHost = config.hostname ?? "localhost";
  const baseUrl = `http://${displayHost}:${port}`;
  deps.stdout.write(
    `milo: gateway listening on ${baseUrl} (policy ${POLICY_VERSION}, decisions via ${backendKind})\n`,
  );
  deps.stdout.write(`milo: set OPENAI_BASE_URL=${baseUrl}/v1 and use model: "milo/auto"\n`);

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
