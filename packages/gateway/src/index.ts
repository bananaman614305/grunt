/**
 * `createGateway` wires the real pieces: the `codex` and `claude` CLI
 * backends, the usage meter on the decision-log SQLite file, and the
 * classifier (Jev when a key is set, the local heuristic otherwise).
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  ClaudeBackend,
  CodexBackend,
  JevClient,
  Router,
  SubscriptionRouter,
  UsageMeter,
  UsageStore,
  heuristicClassify,
  jevClassifier,
  withHeuristicFallback,
} from "@milo/core";
import type { Classifier, SelectionPolicy, SubscriptionBackend, SubscriptionId } from "@milo/core";
import { createApp } from "./app.js";
import type { Logger } from "./app.js";

export { createApp, decisionHeaders, modelIds, parseModel } from "./app.js";
export type { AppDeps, Logger } from "./app.js";

export type BackendOptions = {
  /** Default true. */
  enabled?: boolean;
  /** Binary path or name. Default `codex` / `claude` on PATH. */
  binary?: string;
  /** Default model passed to the CLI. Absent: the CLI's own default. */
  model?: string;
};

export type GatewayOptions = {
  /** libsql URL of the decision log; the usage meter lives in the same file. */
  decisionLogUrl: string;
  /** Scratch directory the CLIs run in. Default `<tmpdir>/milo-work`. */
  workdir?: string;
  backends?: Partial<Record<SubscriptionId, BackendOptions>>;
  /** Milo's Jev key. Absent: the local heuristic classifies every request. */
  jevApiKey?: string;
  policy?: Partial<SelectionPolicy>;
  /** Per-call ceiling for one CLI run. Default 10 minutes. */
  timeoutMs?: number;
  /** Milliseconds a subscription counts as limited after a rate-limit error whose reset is unknown. Default 15 minutes. */
  cooldownMs?: number;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Test seam: build backends instead of spawning the real CLIs. */
  createBackends?: (workdir: string) => SubscriptionBackend[];
};

export type Gateway = {
  app: Hono;
  router: SubscriptionRouter;
  close(): Promise<void>;
};

const consoleLogger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: "info", msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: "error", msg, ...meta })),
};

export async function createGateway(opts: GatewayOptions): Promise<Gateway> {
  const logger = opts.logger ?? consoleLogger;
  const workdir = opts.workdir ?? join(tmpdir(), "milo-work");
  mkdirSync(workdir, { recursive: true });

  const backends = opts.createBackends?.(workdir) ?? realBackends(opts, workdir);
  if (backends.length === 0) throw new Error("No subscription backend is enabled.");

  const store = await UsageStore.open(opts.decisionLogUrl);
  const meter = new UsageMeter({ store, ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {}) });
  await meter.load();

  let classify: Classifier = async (messages) => heuristicClassify(messages);
  if (opts.jevApiKey !== undefined && opts.jevApiKey !== "") {
    const jevRouter = new Router({ jev: new JevClient({ apiKey: opts.jevApiKey }) });
    classify = withHeuristicFallback(jevClassifier(jevRouter), (error) =>
      logger.warn("jev classification failed; used the heuristic", { error: String(error) }),
    );
  }

  const router = new SubscriptionRouter({
    backends,
    meter,
    store,
    classify,
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    onError: (msg, meta) => logger.warn(msg, meta),
  });

  const labels = Object.fromEntries(backends.map((b) => [b.id, b.label])) as Partial<Record<SubscriptionId, string>>;
  const app = createApp({ router, labels, store, logger, now: Date.now });

  return {
    app,
    router,
    close: async () => {
      store.close();
    },
  };
}

function realBackends(opts: GatewayOptions, workdir: string): SubscriptionBackend[] {
  const env = opts.env ?? process.env;
  const common = { workdir, env, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) };
  const out: SubscriptionBackend[] = [];
  const codex = opts.backends?.codex;
  if (codex?.enabled !== false) {
    out.push(
      new CodexBackend({
        ...common,
        ...(codex?.binary !== undefined ? { binary: codex.binary } : {}),
        ...(codex?.model !== undefined ? { model: codex.model } : {}),
      }),
    );
  }
  const claude = opts.backends?.claude;
  if (claude?.enabled !== false) {
    out.push(
      new ClaudeBackend({
        ...common,
        ...(claude?.binary !== undefined ? { binary: claude.binary } : {}),
        ...(claude?.model !== undefined ? { model: claude.model } : {}),
      }),
    );
  }
  return out;
}
