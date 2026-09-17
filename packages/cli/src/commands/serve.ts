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
  --port <n>        Port to listen on (overrides PORT, which overrides config)
  --db <url>        Decision log libsql URL (overrides MILO_DB, which overrides config)
  -h, --help        Show this help

Environment:
  JEV_API_KEY             Milo's Jev key (required for the jev backends)
  MILO_DECISION_BACKEND   jev | system-one-open | jev-with-fallback
  SYSTEM_ONE_OPEN_URL     Base URL of a system-one-open deployment
  PORT                    Port to listen on (overridden by --port; overrides config)
  MILO_DB                 Decision log libsql URL (overridden by --db; overrides config)

Precedence for port and the decision log URL: flag beats environment variable
beats config file beats built-in default.
`;

const FILE_SCHEME = "file:";
const PORT_ENV = "PORT";
const DECISION_LOG_ENV = "MILO_DB";

/**
 * Creates the parent directory of a `file:` decision log URL, resolving a
 * relative path under `cwd` first. A Fly volume (or any bind mount) is
 * mounted empty, so an absolute path like `file:/data/decisions.db` needs
 * its parent directory created too, not just relative dev paths.
 */
function ensureLogDirectory(url: string, cwd: string): void {
  if (!url.startsWith(FILE_SCHEME)) return;
  const filePath = url.slice(FILE_SCHEME.length);
  if (filePath === "" || filePath === ":memory:") return;
  const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  mkdirSync(dirname(resolved), { recursive: true });
}

/** Parses a port value from a flag or environment variable; `undefined` when absent or blank. */
function parsePositiveIntPort(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
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

  // Precedence: flag beats environment variable beats config file beats
  // built-in default. `config.port` / `config.decisionLog` already resolve
  // "config file beats default" (see config.ts), so PORT / MILO_DB only need
  // to be layered in below the flag and above whatever `config` produced.
  let port = config.port;
  const envPort = parsePositiveIntPort(deps.env[PORT_ENV]);
  if (envPort === null) {
    deps.stderr.write(`milo serve: ${PORT_ENV} must be a positive integer, got "${deps.env[PORT_ENV]}"\n`);
    return 1;
  }
  if (envPort !== undefined) port = envPort;

  if (parsed.values.port !== undefined) {
    const parsedPort = parsePositiveIntPort(parsed.values.port);
    if (parsedPort === undefined || parsedPort === null) {
      deps.stderr.write(`milo serve: --port must be a positive integer, got "${parsed.values.port}"\n`);
      return 1;
    }
    port = parsedPort;
  }

  const envDb = deps.env[DECISION_LOG_ENV];
  let decisionLogUrl = config.decisionLog;
  if (envDb !== undefined && envDb.trim() !== "") decisionLogUrl = envDb;
  if (parsed.values.db !== undefined) decisionLogUrl = parsed.values.db;
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
