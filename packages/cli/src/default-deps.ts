/** The real `CliDeps`, wired to the actual gateway, log, env, and network. */
import { serve } from "@hono/node-server";
import { PgBillingStore } from "@milo/billing";
import { DecisionLog } from "@milo/core";
import { createGateway } from "@milo/gateway";
import { OpenRouterProvisioningClient } from "@milo/provisioning";
import { createStripeClient } from "@milo/stripe";
import type { CliDeps } from "./deps.js";

export function defaultDeps(): CliDeps {
  return {
    createGateway,
    openLog: (url: string) => DecisionLog.open(url),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    serve,
    openBillingStore: (url: string) => PgBillingStore.open({ url }),
    createStripeClient: (opts) => createStripeClient(opts),
    createProvisioningClient: () => new OpenRouterProvisioningClient(),
  };
}
