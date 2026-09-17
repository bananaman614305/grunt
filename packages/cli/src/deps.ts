/**
 * Everything a command touches that is not pure: the gateway constructor,
 * the decision log opener, the environment, standard streams, and the HTTP
 * server starter. Every command takes these as a parameter instead of
 * importing the real thing, so tests exercise the CLI's own logic without a
 * network, a real gateway, or a real listening socket.
 */
import type { Account, BillingStore, DecisionLog } from "@milo/core";
import type { Gateway, GatewayOptions } from "@milo/gateway";
import type { OpenRouterProvisioningClient } from "@milo/provisioning";
import type { StripeClient } from "@milo/stripe";

export type Writer = { write(chunk: string): void };

/**
 * What `milo billing` needs beyond the pinned `BillingStore` contract:
 * `listAccounts` (an operator listing, not part of the per-account API) and
 * `close`. `@milo/billing`'s `PgBillingStore` has both; a test fake only
 * needs to implement this same shape.
 */
export type BillingAdminStore = BillingStore & {
  listAccounts(opts?: { limit?: number }): Promise<Account[]>;
  close(): Promise<void>;
};

/** The subset of `@hono/node-server`'s `Options` the CLI relies on. */
export type ServeOptions = {
  fetch: (request: Request) => Response | Promise<Response>;
  port?: number;
  hostname?: string;
};

export type ServeResult = {
  close(callback?: (err?: Error) => void): unknown;
};

export type ServeFn = (
  options: ServeOptions,
  listeningListener?: (info: { address: string; port: number }) => void,
) => ServeResult;

export type CliDeps = {
  createGateway: (options: GatewayOptions) => Promise<Gateway>;
  openLog: (url: string) => Promise<DecisionLog>;
  env: NodeJS.ProcessEnv;
  stdout: Writer;
  stderr: Writer;
  serve: ServeFn;
  /** Opens (and migrates) the billing database at `url`, for `milo billing`. */
  openBillingStore: (url: string) => Promise<BillingAdminStore>;
  /**
   * Reads `STRIPE_SECRET_KEY` from `env`. `opts.webhookSecret` overrides
   * `STRIPE_WEBHOOK_SECRET` -- `milo billing stripe-setup` passes a
   * placeholder so it can mint the real secret before one has ever been set.
   */
  createStripeClient: (opts?: { webhookSecret?: string }) => StripeClient;
  /** Reads `OPENROUTER_PROVISIONING_KEY` from `env`, for `milo billing reconcile`. */
  createProvisioningClient: () => OpenRouterProvisioningClient;
};
