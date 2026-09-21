/** `milo serve [--config <path>] [--port <n>] [--db <url>]`. */
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PRICING, POLICY_VERSION } from "@milo/core";
import { PgBillingStore } from "@milo/billing";
import { OpenRouterProvisioningClient } from "@milo/provisioning";
import { createStripeClient } from "@milo/stripe";
import type { GatewayOptions } from "@milo/gateway";
import { loadConfig } from "../config.js";
import type { CliDeps, ServeOptions } from "../deps.js";

export const help = `Usage: milo serve [options]

Start the Milo gateway server. Reads Milo's Jev key from the JEV_API_KEY
environment variable.

Options:
  --config <path>   Path to milo.config.json (default: ./milo.config.json if present)
  --port <n>        Port to listen on (overrides PORT, which overrides config)
  --db <url>        Decision log libsql URL (overrides MILO_DB, which overrides config)
  -h, --help        Show this help

Environment:
  JEV_API_KEY             Milo's Jev key (required under the "typesafe"
                          transport; unused, and optional, under "openrouter")
  PORT                    Port to listen on (overridden by --port; overrides config)
  MILO_DB                 Decision log libsql URL (overridden by --db; overrides config)
  MILO_MODE               Routing mode: "roster" (default) or "deepseek" (the
                          ADR-012 compute controller); overrides config "mode"
  MILO_JEV_TRANSPORT      Jev transport: "typesafe" (default) or "openrouter"
                          (route EVERY Jev call -- classification and every
                          auxiliary feature -- through OpenRouter on the
                          caller's own forwarded key, ADR-021/ADR-022);
                          overrides config "jevTransport". Under "openrouter",
                          JEV_API_KEY is unused and need not be set.

Milo-issued keys and prepaid credits (all optional; without MILO_DATABASE_URL
the deployment is bring-your-own-key only and an mk_ key gets a 401):
  MILO_DATABASE_URL       Postgres URL for accounts, keys, ledger and usage
  MILO_ENCRYPTION_KEY     base64 of 32 bytes; encrypts the OpenRouter sub-key
  MILO_MARGIN             fraction on top of upstream cost (default 0.15)
  STRIPE_SECRET_KEY       enables credit checkout and the customer portal
  STRIPE_WEBHOOK_SECRET   verifies POST /billing/stripe/webhook
  OPENROUTER_PROVISIONING_KEY  mints and limits each account's sub-key

Precedence for port and the decision log URL: flag beats environment variable
beats config file beats built-in default.
`;

const FILE_SCHEME = "file:";
const PORT_ENV = "PORT";
const DECISION_LOG_ENV = "MILO_DB";
const MODE_ENV = "MILO_MODE";
const JEV_TRANSPORT_ENV = "MILO_JEV_TRANSPORT";
const BILLING_DB_ENV = "MILO_DATABASE_URL";
const ENCRYPTION_KEY_ENV = "MILO_ENCRYPTION_KEY";
const MARGIN_ENV = "MILO_MARGIN";

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

  let loaded;
  try {
    loaded = loadConfig(parsed.values.config);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { config } = loaded;

  // Jev transport (ADR-021): MILO_JEV_TRANSPORT beats the config's
  // "jevTransport" beats the "typesafe" default. An unknown value is refused
  // rather than guessed at, because the two transports call different hosts.
  // Resolved before the JEV_API_KEY check below, because whether Milo's own
  // key is required depends on it (ADR-022).
  let jevTransport = config.jevTransport;
  const envJevTransport = deps.env[JEV_TRANSPORT_ENV]?.trim();
  if (envJevTransport !== undefined && envJevTransport !== "") {
    if (envJevTransport !== "typesafe" && envJevTransport !== "openrouter") {
      deps.stderr.write(
        `milo serve: ${JEV_TRANSPORT_ENV} must be "typesafe" or "openrouter", got "${envJevTransport}"\n`,
      );
      return 1;
    }
    jevTransport = envJevTransport;
  }

  // Milo's own Jev key is required ONLY under the "typesafe" transport. Under
  // "openrouter" (ADR-022) every Jev call authenticates with the caller's own
  // forwarded OpenRouter key, so Milo's key is never used and need not be set.
  const jevApiKey = deps.env["JEV_API_KEY"] ?? "";
  if (jevTransport === "typesafe" && !jevApiKey) {
    deps.stderr.write(
      `milo serve: JEV_API_KEY is not set. Export JEV_API_KEY with Milo's Jev key before running ` +
        `\`milo serve\`, or set ${JEV_TRANSPORT_ENV}=openrouter to bill Jev to the caller's forwarded key.\n`,
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

  // Routing mode (ADR-012): MILO_MODE beats the config's "mode" beats the
  // "roster" default. An unknown value is refused rather than guessed at,
  // because the two modes route to different models entirely.
  let mode = config.mode;
  const envMode = deps.env[MODE_ENV]?.trim();
  if (envMode !== undefined && envMode !== "") {
    if (envMode !== "roster" && envMode !== "deepseek") {
      deps.stderr.write(`milo serve: ${MODE_ENV} must be "roster" or "deepseek", got "${envMode}"\n`);
      return 1;
    }
    mode = envMode;
  }

  let billing: GatewayOptions["billing"];
  try {
    billing = await buildBilling(deps.env);
  } catch (error) {
    deps.stderr.write(`milo serve: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const gatewayOptions: GatewayOptions = {
    jevApiKey,
    decisionLogUrl,
    mode,
    jevTransport,
    ...(billing !== undefined ? { billing } : {}),
    ...(config.roster !== undefined ? { roster: config.roster } : {}),
    ...(config.rateLimit !== undefined ? { rateLimit: config.rateLimit } : {}),
    ...(config.upstream !== undefined
      ? {
          upstream: {
            ...(config.upstream.maxConcurrentPerModel !== undefined
              ? { maxConcurrentPerModel: config.upstream.maxConcurrentPerModel }
              : {}),
            ...(config.upstream.retry !== undefined
              ? {
                  retry: {
                    ...(config.upstream.retry.maxAttempts !== undefined
                      ? { maxAttempts: config.upstream.retry.maxAttempts }
                      : {}),
                    ...(config.upstream.retry.baseDelayMs !== undefined
                      ? { baseDelayMs: config.upstream.retry.baseDelayMs }
                      : {}),
                    ...(config.upstream.retry.maxDelayMs !== undefined
                      ? { maxDelayMs: config.upstream.retry.maxDelayMs }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(config.referer !== undefined ? { referer: config.referer } : {}),
    ...(config.title !== undefined ? { title: config.title } : {}),
    ...(config.jevTimeoutMs !== undefined ? { jevTimeoutMs: config.jevTimeoutMs } : {}),
    ...(config.sampling !== undefined
      ? {
          sampling: {
            enabled: config.sampling.enabled,
            ...(config.sampling.sampleTimeoutMs !== undefined
              ? { sampleTimeoutMs: config.sampling.sampleTimeoutMs }
              : {}),
            ...(config.sampling.minRanked !== undefined ? { minRanked: config.sampling.minRanked } : {}),
          },
        }
      : {}),
    ...(config.pruning !== undefined
      ? {
          pruning: {
            enabled: config.pruning.enabled,
            ...(config.pruning.minContextTokens !== undefined
              ? { minContextTokens: config.pruning.minContextTokens }
              : {}),
            ...(config.pruning.contextWindowTokens !== undefined
              ? { contextWindowTokens: config.pruning.contextWindowTokens }
              : {}),
          },
        }
      : {}),
    ...(config.factRetrieval !== undefined
      ? {
          factRetrieval: {
            enabled: config.factRetrieval.enabled,
            ...(config.factRetrieval.model !== undefined ? { model: config.factRetrieval.model } : {}),
            ...(config.factRetrieval.baseUrl !== undefined ? { baseUrl: config.factRetrieval.baseUrl } : {}),
          },
        }
      : {}),
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
  deps.stdout.write(`milo: gateway listening on ${baseUrl} (policy ${POLICY_VERSION}, mode ${mode})\n`);
  if (billing !== undefined) {
    deps.stdout.write(
      `milo: Milo keys enabled (margin ${billing.pricing?.margin ?? DEFAULT_PRICING.margin}` +
        `${billing.stripe === undefined ? ", no Stripe" : ""}` +
        `${billing.provisioning === undefined ? ", no provisioning" : ""})\n`,
    );
  }
  deps.stdout.write(`milo: set OPENAI_BASE_URL=${baseUrl}/v1 and use model: "milo/auto"\n`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.stdout.write(`milo: received ${signal}, shutting down\n`);
    server.close(() => {
      void gateway.close();
      // The store is this command's to close: `createGateway` was handed it,
      // it did not open it.
      void closeBilling(billing);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return undefined;
}

/**
 * The billing runtime, from the environment (ADR-007). `MILO_DATABASE_URL` is
 * the switch: without it a deployment has no accounts and `milo serve` starts
 * exactly as it always did. With it, the encryption key is required too --
 * every account's OpenRouter sub-key is stored encrypted with it, and a
 * gateway that cannot decrypt one cannot serve the account at all, so
 * refusing to start is better than 503-ing every Milo key at request time.
 *
 * Stripe and provisioning are separately optional so a staging deployment can
 * run Milo keys without taking payments: checkout and the portal answer 503
 * without Stripe, and an account with no sub-key yet answers 503 without a
 * provisioning key.
 */
async function buildBilling(env: NodeJS.ProcessEnv): Promise<GatewayOptions["billing"]> {
  const url = env[BILLING_DB_ENV];
  if (url === undefined || url.trim() === "") return undefined;

  const encryptionKey = env[ENCRYPTION_KEY_ENV];
  if (encryptionKey === undefined || encryptionKey === "") {
    throw new Error(
      `${BILLING_DB_ENV} is set, so ${ENCRYPTION_KEY_ENV} is required (base64 of 32 random bytes).`,
    );
  }

  const margin = parseMargin(env[MARGIN_ENV]);
  const store = await PgBillingStore.open({ url: url.trim() });

  const billing: NonNullable<GatewayOptions["billing"]> = {
    store,
    encryptionKey,
    pricing: { ...DEFAULT_PRICING, margin },
  };

  const stripeSecret = env["STRIPE_SECRET_KEY"];
  const webhookSecret = env["STRIPE_WEBHOOK_SECRET"];
  if (stripeSecret !== undefined && stripeSecret !== "" && webhookSecret !== undefined && webhookSecret !== "") {
    billing.stripe = createStripeClient({ secretKey: stripeSecret, webhookSecret });
  }

  const provisioningKey = env["OPENROUTER_PROVISIONING_KEY"];
  if (provisioningKey !== undefined && provisioningKey !== "") {
    billing.provisioning = new OpenRouterProvisioningClient({ provisioningKey });
  }

  return billing;
}

/** `MILO_MARGIN` as a fraction, or the default. Refuses a negative margin. */
function parseMargin(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PRICING.margin;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${MARGIN_ENV} must be a non-negative number, got "${raw}"`);
  }
  return parsed;
}

async function closeBilling(billing: GatewayOptions["billing"]): Promise<void> {
  const store = billing?.store as { close?: () => Promise<void> } | undefined;
  await store?.close?.();
}
