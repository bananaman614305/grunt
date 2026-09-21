/**
 * `milo configure [--config <path>] [--pi-config <path>] [--base-url <url>]
 * [--no-pi] [--no-verify]` — the first-run wizard.
 *
 * Four steps, each one safe to fail alone:
 *
 *  1. Ensure `milo.config.json` exists. When one does, it is **merged
 *     additively** — every value the user already wrote stays, only missing
 *     fields are added (the default roster when none is set) — and the
 *     pre-merge file is copied to `<config>.bak` first, under the same name
 *     the path had. A new file is scaffolded with the default roster so the
 *     user can see and edit what the gateway will pick.
 *  2. Merge a `milo` **provider** into the pi coding agent's
 *     `~/.pi/agent/models.json` (additively, with a `.bak` first), so pi can
 *     pick `milo/auto` from its model list. The provider's key is
 *     `$OPENROUTER_API_KEY` — an environment-variable reference, never a
 *     literal — so nothing secret is written anywhere.
 *  3. **Prompt for keys** only when the environment is missing them:
 *     Milo's Jev key (`JEV_API_KEY`, required by the default "typesafe"
 *     transport) and the user's OpenRouter key. Keys stay in memory for the
 *     smoke request and are never written to a file or echoed.
 *  4. **Smoke verify**: start the gateway on an ephemeral port, send one
 *     routed chat completion with `model: "milo/auto"`, and print the
 *     `x-milo-model` response header — proof that Jev classified, policy
 *     chose, and OpenRouter answered.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_ROSTER, PI_PROVIDER_ID, piProviderBlock } from "@milo/core";
import type { Roster } from "@milo/core";
import { DEFAULT_CONFIG_FILENAME, DEFAULT_DECISION_LOG_URL, DEFAULT_PORT, configSchema, loadConfig } from "../config.js";
import type { CliDeps } from "../deps.js";
import type { ServeResult } from "../deps.js";

export const help = `Usage: milo configure [options]

Set up a local Milo: write milo.config.json (additive merge with a .bak
backup, default roster filled in), add a "milo" provider to the pi coding
agent's models.json (additive, with a .bak), then smoke-verify the gateway by
routing one request and printing its x-milo-model header.

Options:
  --config <path>     Path to milo.config.json (default: ./milo.config.json)
  --pi-config <path>  pi's models.json to merge the provider into
                      (default: ~/.pi/agent/models.json)
  --base-url <url>    The origin the pi provider should point at
                      (default: http://<config hostname>:<config port>)
  --no-pi             Do not touch pi's models.json
  --no-verify         Write config only; do not start the gateway or smoke it
  -h, --help          Show this help

Environment:
  JEV_API_KEY             Milo's Jev key; prompted when missing (never stored)
  OPENROUTER_API_KEY      Your OpenRouter key; prompted when missing (never stored)
  MILO_MODE               Routing mode (roster/deepseek), as in milo serve
  MILO_JEV_TRANSPORT      Jev transport (typesafe/openrouter), as in milo serve
`;

const CONFIG_BACKUP_SUFFIX = ".bak";
const PI_BACKUP_SUFFIX = ".bak";

/** The outcome of the config-file step, for the progress lines. */
type ConfigOutcome = {
  /** The merged object that was written. */
  merged: Record<string, unknown>;
  /** A pre-existing file was copied to `<path>.bak` before writing. */
  backedUp: boolean;
  /** The user's own file already had a roster; nothing was materialized. */
  hadRoster: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Writes `text` to `path`, creating any missing parent directories first (a
 * fresh home has no `~/.pi/agent/` yet, and `--config` may point into a
 * directory that does not exist). A failed write is reported to stderr and
 * returns false instead of throwing an uncaught error.
 */
function writeFileSafely(path: string, text: string, deps: CliDeps): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return true;
  } catch (error) {
    deps.stderr.write(
      `milo configure: could not write "${path}": ${error instanceof Error ? error.message : String(error)}
`,
    );
    return false;
  }
}

/**
 * Step 1: additive merge of the config file with a backup. Returns the merged
 * raw object, or writes an error and returns `null`.
 */
function writeConfig(path: string, deps: CliDeps): ConfigOutcome | null {
  const existed = existsSync(path);
  let raw: Record<string, unknown> = {};
  let backedUp = false;

  if (existed) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      deps.stderr.write(
        `milo configure: could not read "${path}": ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      deps.stderr.write(
        `milo configure: "${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return null;
    }
    if (!isObject(parsed)) {
      deps.stderr.write(`milo configure: "${path}" must contain a JSON object\n`);
      return null;
    }

    // Refuse a file the gateway would refuse: same schema, same error text,
    // so configure never writes a config milo serve would reject.
    const check = configSchema.safeParse(parsed);
    if (!check.success) {
      deps.stderr.write(`milo configure: "${path}" is invalid (as milo serve would see it)\n`);
      return null;
    }

    // Backup the exact bytes, not a re-serialization, so nothing the user
    // wrote -- formatting included -- is lost.
    if (!writeFileSafely(`${path}${CONFIG_BACKUP_SUFFIX}`, text, deps)) return null;
    backedUp = true;
    raw = parsed;
  }

  // Additive: the user's fields win untouched; only missing ones are added.
  // The one field this wizard materializes is the roster -- the thing a
  // first-runnner most wants to see and edit.
  const hadRoster = raw.roster !== undefined;
  const merged: Record<string, unknown> = { ...raw };
  if (!hadRoster) merged.roster = DEFAULT_ROSTER;
  if (!existed) {
    merged.port = DEFAULT_PORT;
    merged.hostname = "127.0.0.1";
    merged.decisionLog = DEFAULT_DECISION_LOG_URL;
  }

  if (!writeFileSafely(path, `${JSON.stringify(merged, null, 2)}\n`, deps)) return null;
  return { merged, backedUp, hadRoster };
}

/** `~/.pi/agent/models.json`, or the `--pi-config` override (resolved under cwd). */
function piConfigPath(flag: string | undefined, cwd: string): string {
  return flag !== undefined ? resolve(cwd, flag) : join(homedir(), ".pi", "agent", "models.json");
}

/**
 * Step 2: merge the `milo` provider into pi's models.json additively: every
 * provider the user already has is kept, the `milo` entry is set (or updated)
 * under `providers`, and the pre-merge file is backed up. Returns false on a
 * refusal, true otherwise.
 */
function writePiProvider(piPath: string, baseUrl: string, roster: Roster, deps: CliDeps): boolean {
  const existed = existsSync(piPath);
  let existing: Record<string, unknown> = {};

  if (existed) {
    let text: string;
    try {
      text = readFileSync(piPath, "utf8");
    } catch (error) {
      deps.stderr.write(
        `milo configure: could not read "${piPath}": ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      deps.stderr.write(
        `milo configure: "${piPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return false;
    }
    if (!isObject(parsed)) {
      deps.stderr.write(`milo configure: "${piPath}" must contain a JSON object\n`);
      return false;
    }
    if (!writeFileSafely(`${piPath}${PI_BACKUP_SUFFIX}`, text, deps)) return false;
    existing = parsed;
  }

  const providers = isObject(existing.providers) ? existing.providers : {};
  const merged = {
    ...existing,
    providers: { ...providers, [PI_PROVIDER_ID]: piProviderBlock(`${baseUrl.replace(/\/+$/, "")}/v1`, roster) },
  };
  if (!writeFileSafely(piPath, `${JSON.stringify(merged, null, 2)}\n`, deps)) return false;
  return true;
}

/** Waits (bounded) for the serve listener to report the real port. */
async function waitForPort(getPort: () => number | undefined, timeoutMs = 5000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (getPort() === undefined && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return getPort();
}

/** Closes a serve handle, waiting for its callback like the real server does. */
function closeServer(server: ServeResult): Promise<void> {
  return new Promise((resolvePromise) => {
    const result = server.close(() => resolvePromise());
    if (result !== undefined && typeof (result as { then?: unknown }).then === "function") {
      void (result as Promise<void>).then(resolvePromise);
    }
  });
}

/**
 * Step 4: start the gateway on an ephemeral port and route one request.
 * Returns true when the response carried an `x-milo-model` header.
 */
async function smokeVerify(
  deps: CliDeps,
  opts: {
    jevApiKey: string;
    openRouterKey: string;
    jevTransport: "typesafe" | "openrouter";
    mode?: "roster" | "deepseek";
    roster?: Roster;
    jevTimeoutMs?: number;
  },
): Promise<boolean> {
  const gateway = await deps.createGateway({
    jevApiKey: opts.jevApiKey,
    decisionLogUrl: ":memory:",
    jevTransport: opts.jevTransport,
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.roster !== undefined ? { roster: opts.roster } : {}),
    ...(opts.jevTimeoutMs !== undefined ? { jevTimeoutMs: opts.jevTimeoutMs } : {}),
  });

  let actualPort: number | undefined;
  const server = deps.serve(
    { fetch: gateway.app.fetch, port: 0, hostname: "127.0.0.1" },
    (info) => {
      actualPort = info.port;
    },
  );

  const port = await waitForPort(() => actualPort);
  if (port === undefined) {
    deps.stderr.write("milo configure: the smoke gateway never reported a port\n");
    await closeServer(server);
    await gateway.close();
    return false;
  }

  let ok = false;
  try {
    const res = await deps.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.openRouterKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "milo/auto",
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    const model = res.headers.get("x-milo-model");
    if (res.ok && model !== null) {
      deps.stdout.write(`milo: smoke verify OK — routed to ${model} (x-milo-model: ${model})\n`);
      ok = true;
    } else {
      const body = await res.text();
      const excerpt = body.replace(/\s+/g, " ").slice(0, 200);
      deps.stderr.write(
        `milo configure: smoke verify failed (HTTP ${res.status})${excerpt === "" ? "" : `: ${excerpt}`}\n`,
      );
    }
  } catch (error) {
    deps.stderr.write(
      `milo configure: smoke verify request failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    await closeServer(server);
    await gateway.close();
  }
  return ok;
}

export async function run(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        config: { type: "string" },
        "pi-config": { type: "string" },
        "base-url": { type: "string" },
        "no-pi": { type: "boolean" },
        "no-verify": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo configure: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    deps.stdout.write(help);
    return 0;
  }

  const cwd = process.cwd();
  const configPath = resolve(cwd, parsed.values.config ?? DEFAULT_CONFIG_FILENAME);

  // Step 1: the config file. The gateway's own schema is the gate, so a
  // config configure writes is a config serve can read.
  const outcome = writeConfig(configPath, deps);
  if (outcome === null) return 1;
  const { merged } = outcome;

  // Step 2: the pi provider. `milo configure` ends at the file writes if the
  // user asked for config only; the smoke step below is optional.
  if (parsed.values["no-pi"]) {
    const configNote = `milo: wrote ${configPath} with the default roster${outcome.hadRoster ? " (yours kept)" : ""}`;
    deps.stdout.write(
      `${configNote}${outcome.backedUp ? ` — backup at ${configPath}${CONFIG_BACKUP_SUFFIX}` : ""} ` +
        `(pi's models.json left alone)\n`,
    );
  } else {
    // The pi provider points at this deployment: --base-url when given, else
    // the local gateway the config describes. The provider references
    // $OPENROUTER_API_KEY, so no key value ever reaches these files.
    const host = typeof merged.hostname === "string" ? merged.hostname : "127.0.0.1";
    const port = typeof merged.port === "number" ? merged.port : DEFAULT_PORT;
    const localBase = `http://${host}:${port}`;
    const baseUrl = parsed.values["base-url"] ?? localBase;

    const piPath = piConfigPath(parsed.values["pi-config"], cwd);
    if (!writePiProvider(piPath, baseUrl, merged.roster as Roster, deps)) return 1;
    const backupNote =
      outcome.backedUp || existsSync(`${piPath}${PI_BACKUP_SUFFIX}`)
        ? ` — pre-merge copies kept as <.bak> next to each file`
        : "";
    deps.stdout.write(`milo: added "milo" provider to ${piPath} (models.json; pi picks milo/auto from it)${backupNote}\n`);
    deps.stdout.write(
      `milo: wrote ${configPath} with the default roster${outcome.hadRoster ? " (yours kept)" : ""}\n`,
    );
  }

  if (parsed.values["no-verify"]) {
    deps.stdout.write(
      `milo: configure done (no verify). Run "milo serve" later, with JEV_API_KEY and OPENROUTER_API_KEY exported.\n`,
    );
    return 0;
  }

  // The validated config drives the smoke run, so what is verified is exactly
  // what was written.
  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { config } = loaded;

  // Same transport resolution as `milo serve`: MILO_JEV_TRANSPORT beats
  // config beats the "typesafe" default; an unknown value is refused.
  let jevTransport = config.jevTransport;
  const envTransport = deps.env["MILO_JEV_TRANSPORT"]?.trim();
  if (envTransport !== undefined && envTransport !== "") {
    if (envTransport !== "typesafe" && envTransport !== "openrouter") {
      deps.stderr.write(
        `milo configure: MILO_JEV_TRANSPORT must be "typesafe" or "openrouter", got "${envTransport}"\n`,
      );
      return 1;
    }
    jevTransport = envTransport;
  }

  let mode = config.mode;
  const envMode = deps.env["MILO_MODE"]?.trim();
  if (envMode !== undefined && envMode !== "") {
    if (envMode !== "roster" && envMode !== "deepseek") {
      deps.stderr.write(`milo configure: MILO_MODE must be "roster" or "deepseek", got "${envMode}"\n`);
      return 1;
    }
    mode = envMode;
  }

  // Step 3: keys, prompted only when the environment is missing them. The
  // answers live in memory for the smoke request and nowhere else: nothing a
  // key is typed into is ever written to a file.
  let jevApiKey = deps.env["JEV_API_KEY"]?.trim() ?? "";
  if (jevTransport === "typesafe" && jevApiKey === "") {
    const prompted = await deps.prompt("Milo's Jev key (JEV_API_KEY, sk-...): ", true);
    if (prompted === undefined) {
      deps.stderr.write(
        "milo configure: no JEV_API_KEY; the smoke test needs Milo's Jev key to route.\n" +
          'Export it (and OPENROUTER_API_KEY) before running "milo serve". Configure wrote the files.\n',
      );
      return 0;
    }
    jevApiKey = prompted;
  }

  let openRouterKey = deps.env["OPENROUTER_API_KEY"]?.trim() ?? "";
  if (openRouterKey === "") {
    const prompted = await deps.prompt("Your OpenRouter API key (sk-or-...): ", true);
    if (prompted === undefined) {
      deps.stderr.write(
        "milo configure: no OPENROUTER_API_KEY; the smoke test cannot reach OpenRouter.\n" +
          'Export it before running "milo serve". Configure wrote the files.\n',
      );
      return 0;
    }
    openRouterKey = prompted;
  }

  // Step 4: prove the whole path works end to end and print what routed it.
  const ok = await smokeVerify(deps, {
    jevApiKey,
    openRouterKey,
    jevTransport,
    mode,
    ...(config.roster !== undefined ? { roster: config.roster } : {}),
    ...(config.jevTimeoutMs !== undefined ? { jevTimeoutMs: config.jevTimeoutMs } : {}),
  });

  if (ok) {
    const host = config.hostname ?? "127.0.0.1";
    deps.stdout.write(
      `milo: configure done. Run "milo serve" (listening on http://${host}:${config.port}) and point a ` +
        `client at it with your OpenRouter key and model "milo/auto".\n`,
    );
    return 0;
  }
  return 1;
}