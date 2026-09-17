/**
 * Gateway entry point. This contract is fixed so the CLI (task 2.2) can be
 * built in parallel with the gateway (task 2.1). The gateway task replaces
 * the body of `createGateway`; the signature and option names stay.
 */
import type { Hono } from "hono";
import type { DecisionLog, Roster } from "@milo/core";

export type GatewayOptions = {
  /** Milo's own Jev key. Read from JEV_API_KEY by the CLI. Never logged. */
  jevApiKey: string;
  /** Tier to model mapping. Defaults to DEFAULT_ROSTER from core. */
  roster?: Roster;
  /** libsql URL for the decision log: ":memory:" or "file:/path/milo.db". Default ":memory:". */
  decisionLogUrl?: string;
  /** Upstream base URLs, overridable for tests. */
  openRouterBaseUrl?: string;
  jevBaseUrl?: string;
  /** Routed requests allowed per minute per OpenRouter-key hash. Default 120. */
  rateLimit?: { routedPerMinute: number };
  /** OpenRouter app attribution headers. */
  referer?: string;
  title?: string;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
  /** Minimal logger; defaults to console with keys never included. */
  logger?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void; error(msg: string, meta?: Record<string, unknown>): void };
};

export type Gateway = {
  app: Hono;
  log: DecisionLog;
  close(): Promise<void>;
};

export async function createGateway(_options: GatewayOptions): Promise<Gateway> {
  throw new Error("createGateway is implemented by wave 2 task 2.1");
}
