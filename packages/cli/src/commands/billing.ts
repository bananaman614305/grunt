/**
 * `milo billing <subcommand>`: operator access to the billing database
 * (ADR-007) and the Stripe/OpenRouter provisioning it depends on. Every
 * subcommand takes `--db <url>`, falling back to `MILO_DATABASE_URL`, and
 * opens/closes its own `BillingStore` -- there is no long-lived connection
 * between commands.
 */
import { parseArgs } from "node:util";
import { DATABASE_URL_ENV, grantCredit } from "@milo/billing";
import type { Account, ApiKey, LedgerEntry } from "@milo/core";
import { microToUsd, usdToMicro } from "@milo/core";
import { reconcileUsage } from "@milo/provisioning";
import { ensureStripeProducts, registerWebhook } from "@milo/stripe";
import type { CliDeps } from "../deps.js";
import { formatTable } from "../format.js";

export const help = `Usage: milo billing <subcommand> [options]

Operate the billing database and its Stripe / OpenRouter provisioning.

Subcommands:
  accounts                    List accounts, newest first
  grant <accountId> <usd>     Grant (or claw back) credit by hand
  keys <accountId>            List an account's Milo keys
  revoke-key <keyId>          Revoke one Milo key
  usage <accountId>           Summarize an account's usage
  ledger <accountId>          List an account's ledger entries
  stripe-setup                Ensure Stripe products, prices, and the webhook exist
  reconcile                   True up OpenRouter usage against the ledger

Run "milo billing <subcommand> --help" for subcommand-specific options.
Every subcommand takes --db <url> (default: \$${DATABASE_URL_ENV}).
`;

/** `$0.1500` -- four decimal places, since a per-request decision fee is $0.00005. */
function usd(micro: number): string {
  return `$${microToUsd(micro).toFixed(4)}`;
}

function resolveDbUrl(flag: string | undefined, deps: CliDeps): string | undefined {
  const value = flag ?? deps.env[DATABASE_URL_ENV];
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function missingDbUrlError(command: string): string {
  return `milo billing ${command}: --db or ${DATABASE_URL_ENV} is required\n`;
}

function parsePositiveInt(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

const ACCOUNTS_HELP = `Usage: milo billing accounts [options]

List accounts, newest first.

Options:
  --db <url>     Billing database URL (default: \$${DATABASE_URL_ENV})
  --limit <n>    Max rows to print (default: 50)
  -h, --help     Show this help
`;

export function formatAccountsTable(accounts: Account[]): string {
  if (accounts.length === 0) return "(no accounts)";
  return formatTable(
    ["ID", "EMAIL", "STATUS", "BALANCE", "CREATED"],
    accounts.map((a) => [a.id, a.email, a.status, usd(a.balanceMicroUsd), a.createdAt]),
  );
}

async function runAccounts(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { db: { type: "string" }, limit: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo billing accounts: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(ACCOUNTS_HELP);
    return 0;
  }

  const limit = parsePositiveInt(parsed.values.limit);
  if (limit === null) {
    deps.stderr.write(`milo billing accounts: --limit must be a positive integer, got "${parsed.values.limit}"\n`);
    return 1;
  }

  const dbUrl = resolveDbUrl(parsed.values.db, deps);
  if (dbUrl === undefined) {
    deps.stderr.write(missingDbUrlError("accounts"));
    return 1;
  }

  const store = await deps.openBillingStore(dbUrl);
  try {
    const accounts = await store.listAccounts(limit !== undefined ? { limit } : undefined);
    deps.stdout.write(`${formatAccountsTable(accounts)}\n`);
    return 0;
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// grant
// ---------------------------------------------------------------------------

const GRANT_HELP = `Usage: milo billing grant <accountId> <usd> --note <text> [options]

Puts credit on an account by hand -- a goodwill grant, a support refund, a
migration from an old balance. <usd> may be negative to claw credit back.
Posted through the same ledger as every other balance change (ADR-007), with
--note as its reference.

Options:
  --note <text>  Required. Becomes the ledger entry's reference.
  --db <url>     Billing database URL (default: \$${DATABASE_URL_ENV})
  -h, --help     Show this help
`;

async function runGrant(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { db: { type: "string" }, note: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
  } catch (error) {
    deps.stderr.write(`milo billing grant: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(GRANT_HELP);
    return 0;
  }

  const [accountId, usdAmount, extra] = parsed.positionals;
  if (accountId === undefined || usdAmount === undefined) {
    deps.stderr.write(`milo billing grant: missing <accountId> <usd>\n\n${GRANT_HELP}`);
    return 1;
  }
  if (extra !== undefined) {
    deps.stderr.write(`milo billing grant: unexpected argument "${extra}"\n\n${GRANT_HELP}`);
    return 1;
  }

  const usdValue = Number(usdAmount);
  if (!Number.isFinite(usdValue) || usdValue === 0) {
    deps.stderr.write(`milo billing grant: <usd> must be a non-zero number, got "${usdAmount}"\n`);
    return 1;
  }

  const note = parsed.values.note;
  if (note === undefined || note.trim() === "") {
    deps.stderr.write(`milo billing grant: --note is required\n\n${GRANT_HELP}`);
    return 1;
  }

  const dbUrl = resolveDbUrl(parsed.values.db, deps);
  if (dbUrl === undefined) {
    deps.stderr.write(missingDbUrlError("grant"));
    return 1;
  }

  const store = await deps.openBillingStore(dbUrl);
  try {
    const entry = await grantCredit(store, accountId, usdToMicro(usdValue), note);
    deps.stdout.write(
      `Granted ${usd(entry.amountMicroUsd)} to ${accountId}. New balance: ${usd(entry.balanceAfterMicroUsd)}. ` +
        `Ledger entry ${entry.id}.\n`,
    );
    return 0;
  } catch (error) {
    deps.stderr.write(`milo billing grant: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

const KEYS_HELP = `Usage: milo billing keys <accountId> [options]

List an account's Milo keys (mk_...), newest first. Revoked keys are
included, marked in the STATUS column.

Options:
  --db <url>   Billing database URL (default: \$${DATABASE_URL_ENV})
  -h, --help   Show this help
`;

export function formatKeysTable(keys: ApiKey[]): string {
  if (keys.length === 0) return "(no keys)";
  return formatTable(
    ["ID", "NAME", "PREFIX", "STATUS", "CREATED", "LAST USED"],
    keys.map((k) => [
      k.id,
      k.name,
      k.prefix,
      k.revokedAt ? "revoked" : "active",
      k.createdAt,
      k.lastUsedAt ?? "never",
    ]),
  );
}

async function runKeys(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { db: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
  } catch (error) {
    deps.stderr.write(`milo billing keys: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(KEYS_HELP);
    return 0;
  }

  const [accountId, extra] = parsed.positionals;
  if (accountId === undefined) {
    deps.stderr.write(`milo billing keys: missing <accountId>\n\n${KEYS_HELP}`);
    return 1;
  }
  if (extra !== undefined) {
    deps.stderr.write(`milo billing keys: unexpected argument "${extra}"\n\n${KEYS_HELP}`);
    return 1;
  }

  const dbUrl = resolveDbUrl(parsed.values.db, deps);
  if (dbUrl === undefined) {
    deps.stderr.write(missingDbUrlError("keys"));
    return 1;
  }

  const store = await deps.openBillingStore(dbUrl);
  try {
    const keys = await store.listApiKeys(accountId);
    deps.stdout.write(`${formatKeysTable(keys)}\n`);
    return 0;
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// revoke-key
// ---------------------------------------------------------------------------

const REVOKE_KEY_HELP = `Usage: milo billing revoke-key <keyId> [options]

Revoke one Milo key. A no-op if it is already revoked or does not exist.

Options:
  --db <url>   Billing database URL (default: \$${DATABASE_URL_ENV})
  -h, --help   Show this help
`;

async function runRevokeKey(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { db: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
  } catch (error) {
    deps.stderr.write(`milo billing revoke-key: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(REVOKE_KEY_HELP);
    return 0;
  }

  const [keyId, extra] = parsed.positionals;
  if (keyId === undefined) {
    deps.stderr.write(`milo billing revoke-key: missing <keyId>\n\n${REVOKE_KEY_HELP}`);
    return 1;
  }
  if (extra !== undefined) {
    deps.stderr.write(`milo billing revoke-key: unexpected argument "${extra}"\n\n${REVOKE_KEY_HELP}`);
    return 1;
  }

  const dbUrl = resolveDbUrl(parsed.values.db, deps);
  if (dbUrl === undefined) {
    deps.stderr.write(missingDbUrlError("revoke-key"));
    return 1;
  }

  const store = await deps.openBillingStore(dbUrl);
  try {
    await store.revokeApiKey(keyId);
    deps.stdout.write(`Revoked key ${keyId}.\n`);
    return 0;
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

const USAGE_HELP = `Usage: milo billing usage <accountId> [options]

Summarize an account's usage: request count, what was charged, what
OpenRouter charged Milo upstream, and a per-model request count.

Options:
  --since <iso>  Only include usage at or after this ISO 8601 timestamp
  --db <url>     Billing database URL (default: \$${DATABASE_URL_ENV})
  -h, --help     Show this help
`;

type UsageSummary = {
  requests: number;
  chargedMicroUsd: number;
  upstreamCostMicroUsd: number;
  byModel: Record<string, number>;
};

export function formatUsageSummary(summary: UsageSummary): string {
  const lines = [
    `Requests: ${summary.requests}`,
    `Charged: ${usd(summary.chargedMicroUsd)}`,
    `Upstream cost: ${usd(summary.upstreamCostMicroUsd)}`,
    "By model:",
  ];
  const models = Object.entries(summary.byModel);
  if (models.length === 0) lines.push("  (none)");
  for (const [model, count] of models) lines.push(`  ${model}: ${count}`);
  return lines.join("\n");
}

async function runUsage(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        db: { type: "string" },
        since: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (error) {
    deps.stderr.write(`milo billing usage: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(USAGE_HELP);
    return 0;
  }

  const [accountId, extra] = parsed.positionals;
  if (accountId === undefined) {
    deps.stderr.write(`milo billing usage: missing <accountId>\n\n${USAGE_HELP}`);
    return 1;
  }
  if (extra !== undefined) {
    deps.stderr.write(`milo billing usage: unexpected argument "${extra}"\n\n${USAGE_HELP}`);
    return 1;
  }

  const since = parsed.values.since;
  if (since !== undefined && Number.isNaN(Date.parse(since))) {
    deps.stderr.write(`milo billing usage: --since is not a valid ISO 8601 timestamp: "${since}"\n`);
    return 1;
  }

  const dbUrl = resolveDbUrl(parsed.values.db, deps);
  if (dbUrl === undefined) {
    deps.stderr.write(missingDbUrlError("usage"));
    return 1;
  }

  const store = await deps.openBillingStore(dbUrl);
  try {
    const summary = await store.usageSummary(accountId, since);
    deps.stdout.write(`${formatUsageSummary(summary)}\n`);
    return 0;
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------

const LEDGER_HELP = `Usage: milo billing ledger <accountId> [options]

List an account's ledger entries, newest first.

Options:
  --limit <n>  Max rows to print (default: 50)
  --db <url>   Billing database URL (default: \$${DATABASE_URL_ENV})
  -h, --help   Show this help
`;

export function formatLedgerTable(entries: LedgerEntry[]): string {
  if (entries.length === 0) return "(no ledger entries)";
  return formatTable(
    ["ID", "KIND", "AMOUNT", "BALANCE AFTER", "REFERENCE", "CREATED"],
    entries.map((e) => [e.id, e.kind, usd(e.amountMicroUsd), usd(e.balanceAfterMicroUsd), e.reference, e.createdAt]),
  );
}

async function runLedger(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { db: { type: "string" }, limit: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
  } catch (error) {
    deps.stderr.write(`milo billing ledger: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(LEDGER_HELP);
    return 0;
  }

  const [accountId, extra] = parsed.positionals;
  if (accountId === undefined) {
    deps.stderr.write(`milo billing ledger: missing <accountId>\n\n${LEDGER_HELP}`);
    return 1;
  }
  if (extra !== undefined) {
    deps.stderr.write(`milo billing ledger: unexpected argument "${extra}"\n\n${LEDGER_HELP}`);
    return 1;
  }

  const limit = parsePositiveInt(parsed.values.limit);
  if (limit === null) {
    deps.stderr.write(`milo billing ledger: --limit must be a positive integer, got "${parsed.values.limit}"\n`);
    return 1;
  }

  const dbUrl = resolveDbUrl(parsed.values.db, deps);
  if (dbUrl === undefined) {
    deps.stderr.write(missingDbUrlError("ledger"));
    return 1;
  }

  const store = await deps.openBillingStore(dbUrl);
  try {
    const entries = await store.listLedger(accountId, limit !== undefined ? { limit } : undefined);
    deps.stdout.write(`${formatLedgerTable(entries)}\n`);
    return 0;
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// stripe-setup
// ---------------------------------------------------------------------------

const STRIPE_SETUP_HELP = `Usage: milo billing stripe-setup --webhook-url <url> [options]

Ensures the "Milo credits" Stripe product and one price per credit pack
exist, and that a webhook endpoint is registered at --webhook-url for
checkout.session.completed and charge.refunded. Looked up by name/lookup-key
and by url, so this is safe to run again.

The webhook's signing secret is only ever returned the first time its
endpoint is created. This command prints it exactly once, on that first
run -- store it as STRIPE_WEBHOOK_SECRET immediately; Stripe will not show
it again, and running stripe-setup again against the same --webhook-url
prints no secret at all.

Options:
  --webhook-url <url>   Required. Public URL Stripe should POST events to.
  -h, --help            Show this help

Environment:
  STRIPE_SECRET_KEY   Stripe secret key (required)
`;

async function runStripeSetup(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { "webhook-url": { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo billing stripe-setup: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(STRIPE_SETUP_HELP);
    return 0;
  }

  const webhookUrl = parsed.values["webhook-url"];
  if (webhookUrl === undefined || webhookUrl.trim() === "") {
    deps.stderr.write(`milo billing stripe-setup: --webhook-url is required\n\n${STRIPE_SETUP_HELP}`);
    return 1;
  }

  let stripe;
  try {
    // A placeholder lets the client construct even the very first time,
    // before any real STRIPE_WEBHOOK_SECRET exists: ensureStripeProducts and
    // registerWebhook never read `stripe.webhookSecret`, only signature
    // verification (elsewhere) does.
    stripe = deps.createStripeClient({ webhookSecret: deps.env["STRIPE_WEBHOOK_SECRET"] ?? "unset" });
  } catch (error) {
    deps.stderr.write(`milo billing stripe-setup: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const products = await ensureStripeProducts(stripe);
  deps.stdout.write(`Product: ${products.productId}\n`);
  for (const [packId, priceId] of Object.entries(products.priceIds)) {
    deps.stdout.write(`  ${packId}: ${priceId}\n`);
  }

  const webhook = await registerWebhook(stripe, webhookUrl);
  deps.stdout.write(`Webhook endpoint: ${webhook.id} (${webhookUrl})\n`);
  if (webhook.secret !== undefined) {
    deps.stdout.write(`Signing secret (shown once): ${webhook.secret}\n`);
    deps.stdout.write("Store this as STRIPE_WEBHOOK_SECRET now -- Stripe will not show it again.\n");
  } else {
    deps.stdout.write("Webhook endpoint already existed; its signing secret is unchanged.\n");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

const RECONCILE_HELP = `Usage: milo billing reconcile [options]

Reconciles OpenRouter's reported spend on each account's sub-key against
what Milo actually charged, and posts a ledger adjustment for any gap this
finds (ADR-007) -- the case where a stream was cut before its usage chunk
arrived, so OpenRouter billed the sub-key for tokens Milo never charged for.
Idempotent: running it again immediately posts nothing new.

Options:
  --limit <n>  Max accounts to consider in one run (default: 500)
  --db <url>   Billing database URL (default: \$${DATABASE_URL_ENV})
  -h, --help   Show this help

Environment:
  OPENROUTER_PROVISIONING_KEY   OpenRouter provisioning key (required)
`;

async function runReconcile(args: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { db: { type: "string" }, limit: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
    });
  } catch (error) {
    deps.stderr.write(`milo billing reconcile: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (parsed.values.help) {
    deps.stdout.write(RECONCILE_HELP);
    return 0;
  }

  const limit = parsePositiveInt(parsed.values.limit);
  if (limit === null) {
    deps.stderr.write(`milo billing reconcile: --limit must be a positive integer, got "${parsed.values.limit}"\n`);
    return 1;
  }

  const dbUrl = resolveDbUrl(parsed.values.db, deps);
  if (dbUrl === undefined) {
    deps.stderr.write(missingDbUrlError("reconcile"));
    return 1;
  }

  let client;
  try {
    client = deps.createProvisioningClient();
  } catch (error) {
    deps.stderr.write(`milo billing reconcile: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const store = await deps.openBillingStore(dbUrl);
  try {
    const accounts = await store.listAccounts(limit !== undefined ? { limit } : undefined);
    const summary = await reconcileUsage({ store, client, accounts });
    for (const result of summary.accounts) {
      deps.stdout.write(
        `${result.accountId}  discrepancy ${usd(result.discrepancyMicroUsd)}  ${result.posted ? "posted" : "ok"}\n`,
      );
    }
    deps.stdout.write(`Accounts checked: ${summary.accounts.length}. Total posted: ${usd(summary.totalPostedMicroUsd)}\n`);
    return 0;
  } finally {
    await store.close();
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type Subcommand = (args: string[], deps: CliDeps) => Promise<number>;

const SUBCOMMANDS: Record<string, Subcommand> = {
  accounts: runAccounts,
  grant: runGrant,
  keys: runKeys,
  "revoke-key": runRevokeKey,
  usage: runUsage,
  ledger: runLedger,
  "stripe-setup": runStripeSetup,
  reconcile: runReconcile,
};

export async function run(args: string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;

  if (subcommand === undefined) {
    deps.stderr.write(help);
    return 1;
  }
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    deps.stdout.write(help);
    return 0;
  }

  const impl = SUBCOMMANDS[subcommand];
  if (!impl) {
    deps.stderr.write(`milo billing: unknown subcommand "${subcommand}"\n\n${help}`);
    return 1;
  }

  return impl(rest, deps);
}
