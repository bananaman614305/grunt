/**
 * The Hono app: auth, routes, and the small dependency bundle the route
 * modules share.
 *
 * `createApp` takes everything it needs as `AppDeps` and constructs nothing
 * itself, so a test can drive the whole surface with a stub router, a stub
 * OpenRouter client and an in-memory decision log without a server socket.
 * `createGateway` in `index.ts` is the only place that wires real objects.
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import {
  DEFAULT_ROSTER,
  DEFAULT_ROSTER_INFO,
  POLICY_VERSION,
  ROSTER_NOTE,
  ROUTED_MODEL_ID,
  TIERS,
  defaultRosterModel,
} from "@milo/core";
import type {
  DecisionRecord,
  DecisionLog,
  Encryptor,
  JevClientLike,
  OpenRouterClient,
  Roster,
  Router,
  RoutingMode,
  Tier,
} from "@milo/core";
import type { AnthropicUpstream } from "./anthropic.js";
import { billingAuth } from "./billing.js";
import type { BillingRuntime } from "./billing.js";
import { anthropicErrorResponse, errorResponse } from "./errors.js";
import { hashKey } from "./rate-limit.js";
import type { RateLimiter } from "./rate-limit.js";
import { applyTenantHeaders, bodyTooLarge, getTenantStatus } from "./tenant-limits.js";
import type { TenantLimits } from "./tenant-limits.js";
import { registerAccountPages } from "./routes/account-pages.js";
import { registerBillingRoutes } from "./routes/billing-api.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerDecisionsRoutes } from "./routes/decisions.js";
import { registerMessagesRoute } from "./routes/messages.js";
import { registerModelsRoute } from "./routes/models.js";
import { registerPreferencesRoutes } from "./routes/preferences.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerProxyRoute } from "./routes/proxy.js";
import { registerRosterRoute } from "./routes/roster.js";
import { registerResponsesRoute } from "./routes/responses.js";
import { registerVerifyRoute } from "./routes/verify.js";
import { registerStaticRoutes } from "./routes/static.js";

/** Structurally identical to `GatewayOptions["logger"]`, which is pinned. */
export type Logger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
};

/**
 * What `/healthz` and `/` report as the decision backend. Jev is the only one
 * (ADR-005), but the key stays in both payloads so a dashboard that reads it
 * does not break.
 */
export const DECISION_BACKEND = "jev";

/** The one `/v1` route that exists for people who have no key yet. */
const SIGNUP_PATH = "/v1/signup";

export type AppDeps = {
  router: Router;
  /**
   * The routing mode this deployment runs (ADR-012), for the disclosure
   * surfaces (`/healthz`, `GET /`). The router carries the mode that
   * actually routes; this field only reports it, and defaults to
   * `"roster"` like everything else.
   */
  mode?: RoutingMode;
  /**
   * The tier-to-model table this deployment is actually running, so `/` and
   * `/v1/roster` disclose what will be picked rather than what ships.
   * Defaults to `DEFAULT_ROSTER` for a caller that constructs `AppDeps` by
   * hand.
   */
  roster?: Roster;
  openRouter: OpenRouterClient;
  /** OpenRouter's Anthropic-compatible surface, for `/v1/messages`. */
  anthropic: AnthropicUpstream;
  log: DecisionLog;
  /**
   * Jev on Milo's own key, shared by the gateway's two non-routing uses:
   * ranking best-of-N samples (ADR-010) and resolving preference capture
   * (ADR-011). Optional so a hand-built `AppDeps` degrades softly -- a
   * sampled decision answers with the first successful sample marked
   * `ranking_failed`, and capture simply no-ops.
   */
  jev?: JevClientLike;
  /**
   * Whether the router's Jev classification call runs on the caller's
   * forwarded OpenRouter key (ADR-021). True only under the `"openrouter"`
   * Jev transport; when true, each routed request carries its resolved
   * upstream key as `RouteRequest.jevKey`. False (the default) leaves
   * `jevKey` unset, so no key is ever attached to a routing request under the
   * TypeSafe transport.
   */
  forwardJevKey?: boolean;
  /**
   * Personal-fact memory (ADR-017). Present only when the deployment has an
   * encryption key -- the gateway builds `encryptor` from the billing
   * AES-256-GCM envelope keyed by `MILO_ENCRYPTION_KEY`. Absent means the
   * feature degrades to disabled: no capture, no injection, and `GET
   * /v1/memory` answers empty. A fact store with no envelope must not store
   * plaintext, so it stores nothing.
   */
  factMemory?: { encryptor: Encryptor };
  /**
   * Two-stage fact retrieval (ADR-018). Present only alongside `factMemory`
   * and when retrieval is enabled: `model` and `baseUrl` are the embeddings
   * endpoint the gateway calls with the caller's forwarded key to pre-rank a
   * caller's facts before the Jev gate. Absent means the pre-filter is off and
   * the gate falls open to asking Jev about every fact, exactly as ADR-017
   * shipped it.
   */
  factRetrieval?: { model: string; baseUrl: string; fetch?: (input: string, init?: RequestInit) => Promise<Response> };
  rateLimiter: RateLimiter;
  /**
   * Tenant guardrails: per-key request/token rate limits, a rolling-window
   * spend cap, and request-shape bounds, all independently optional. Absent
   * means none of it runs -- the pre-existing `rateLimiter` above (Jev spend
   * on the routed path only, ADR-003) is untouched either way. Set from
   * `GatewayOptions.tenantLimits`.
   */
  tenantLimits?: TenantLimits;
  /**
   * Best-of-N execution knobs (ADR-010). Absent means the defaults:
   * `sampleTimeoutMs` caps each sample's wall clock; `minRanked` is how many
   * ranked samples the fan-out waits for before an early return may fire.
   */
  sampling?: { sampleTimeoutMs?: number; minRanked?: number };
  /**
   * Context pruning (ADR-014). Absent or `enabled` false means the gate is
   * off for every request unless one opts in with `milo: { prune: true }`.
   * `minContextTokens` is the token floor a conversation must exceed before
   * pruning is considered (default 40,000); `contextWindowTokens` is the
   * fill-ratio denominator for a model whose context window is unknown
   * (default 128,000).
   */
  pruning?: { enabled?: boolean; minContextTokens?: number; contextWindowTokens?: number };
  logger: Logger;
  /** Injectable clock for upstream latency. */
  now: () => number;
  /** Fire and forget, but tracked so `close()` can drain it. */
  recordUpstream(id: string, upstream: NonNullable<DecisionRecord["upstream"]>): void;
  /**
   * Milo-issued keys, credits and metering (ADR-007). Absent means this
   * deployment is bring-your-own-key only: nothing changes for a BYOK caller,
   * and an `mk_` bearer is refused with 401.
   */
  billing?: BillingRuntime;
  /**
   * Registers work that outlives the request that started it -- the charge
   * for a streamed response -- so `close()` can drain it. Optional: without
   * it the work still runs, it just is not waited for on shutdown.
   */
  track?(work: Promise<unknown>): void;
};

/** The raw `Authorization` header. Valid by the time any route runs. */
export function authorization(c: Context): string {
  return c.req.header("authorization") ?? "";
}

/** The bearer token, or `""` if the header is missing or not bearer-shaped. */
function bearerToken(c: Context): string {
  return c.req.header("authorization")?.match(/^Bearer\s+(\S.*)$/i)?.[1]?.trim() ?? "";
}

/**
 * The user's OpenRouter key, from whichever header carried it.
 *
 * The Anthropic SDK and Claude Code send a key as `x-api-key`; every other
 * client Milo serves sends `Authorization: Bearer`. Both name the same thing
 * -- the user's OpenRouter key -- so `/v1/messages` accepts either. Bearer
 * wins when both are present, since that is the one OpenRouter documents.
 */
export function credential(c: Context): string {
  const bearer = bearerToken(c);
  if (bearer !== "") return bearer;
  return c.req.header("x-api-key")?.trim() ?? "";
}

/**
 * The credential as OpenRouter wants it. Used both as the outgoing
 * `Authorization` header and as the rate limiter's bucket key, so one key
 * gets one bucket whichever header it arrived in.
 */
export function upstreamAuthorization(c: Context): string {
  return `Bearer ${credential(c)}`;
}

/**
 * The caller's identity as anything but the request itself is allowed to know
 * it: the SHA-256 of the normalized credential, which is the same function
 * (`hashKey`) and the same value the rate limiter buckets on.
 *
 * It is computed from `upstreamAuthorization` rather than the raw header, so
 * one key is one identity whichever header carried it and whatever spacing it
 * arrived with. This is what a per-key roster is stored under (ADR-008): Milo
 * keeps no key material (ADR-003), so a hash is the only handle it has, and a
 * hash is all it needs -- it is stable per key and reveals nothing.
 */
export function keyHash(c: Context): string {
  return hashKey(upstreamAuthorization(c));
}

/** Whether a path is part of the Anthropic-dialect surface. */
export function isAnthropicPath(pathname: string): boolean {
  return pathname === "/v1/messages" || pathname.startsWith("/v1/messages/");
}

/**
 * The upstream headers worth handing to the client: the content type (so an
 * SSE stream still reads as one) and OpenRouter's request id (so a user can
 * quote it in a support thread). Everything else -- lengths and encodings
 * that may no longer hold, cookies, CORS -- is dropped by omission.
 */
export function passThroughHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  const requestId = upstream.headers.get("x-request-id");
  if (requestId !== null) headers.set("x-request-id", requestId);
  return headers;
}

/**
 * Every `/v1/*` request carries the user's OpenRouter key. The gateway only
 * checks that one is present -- validating it is OpenRouter's job, and Milo
 * has no way to do it without spending a call. The value is read here and
 * never logged, stored, or echoed back.
 *
 * Under `/v1/messages` a non-empty `x-api-key` counts, because that is where
 * the Anthropic SDK and Claude Code put the key (Claude Code's
 * `ANTHROPIC_API_KEY` sends `x-api-key`, `ANTHROPIC_AUTH_TOKEN` sends
 * `Authorization: Bearer`, and a user should not have to know which). Both
 * leave as one bearer token; see `routes/messages.ts`. The refusal wears the
 * dialect of the route it guards, so each client's error classes parse it.
 *
 * `POST /v1/signup` is the one exception: it is how somebody with no key at
 * all gets their first one (ADR-007), so it cannot demand one. It has a rate
 * limit of its own instead (`routes/billing-api.ts`).
 */
const requireKey: MiddlewareHandler = async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  // Signing up is how a user gets their first key, so it cannot require one.
  if (pathname === SIGNUP_PATH) {
    await next();
    return;
  }
  const anthropic = isAnthropicPath(pathname);

  if ((anthropic ? credential(c) : bearerToken(c)) === "") {
    return anthropic
      ? anthropicErrorResponse(
          c,
          401,
          "No OpenRouter API key provided. Send it as `x-api-key: <key>` or `Authorization: Bearer <key>`.",
          "authentication_error",
        )
      : errorResponse(
          c,
          401,
          "No OpenRouter API key provided. Send it as `Authorization: Bearer <key>`.",
          "authentication_error",
          "missing_authorization",
        );
  }

  await next();
  return;
};

/**
 * Abuse protection's cheapest check: a `Content-Length` over the configured
 * ceiling is refused before the body is even read, so an oversized upload
 * costs Milo nothing but a header comparison. Only checks what
 * `tenantLimits.maxBodyBytes` names; absent (the default) this middleware
 * does nothing for every request, which is the "unconfigured deployment is
 * unchanged" guarantee tenant limits promise everywhere else.
 */
function tenantBodySizeGuard(deps: AppDeps): MiddlewareHandler {
  return async (c, next) => {
    const maxBytes = deps.tenantLimits?.config.maxBodyBytes;
    if (maxBytes !== undefined && bodyTooLarge(c.req.header("content-length"), maxBytes)) {
      const message = `Request body exceeds the ${maxBytes}-byte limit Milo allows for this deployment.`;
      return isAnthropicPath(new URL(c.req.url).pathname)
        ? anthropicErrorResponse(c, 413, message, "invalid_request_error")
        : errorResponse(c, 413, message, "invalid_request_error", "request_too_large");
    }
    await next();
    return;
  };
}

/**
 * Discloses whatever the tenant-limits guard found for this request as
 * `x-milo-ratelimit-*` / `x-milo-spend-*` headers, on every response --
 * refusal or success -- once a route has run it (`enforceTenantLimits` in
 * `routes/shared.ts`). A request that never reached a guarded route (a
 * passthrough that failed before parsing, `/healthz`, the proxy route) simply
 * recorded no status, and this middleware then does nothing: `c.res.headers`
 * is mutated only when there is something to disclose.
 */
function tenantHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const status = getTenantStatus(c);
    if (status !== undefined) applyTenantHeaders(c.res.headers, status);
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // No auth: a health probe must work before anyone has a key.
  app.get("/healthz", (c) =>
    c.json({ ok: true, policyVersion: POLICY_VERSION, decisionBackend: DECISION_BACKEND, mode: deps.mode ?? "roster" }),
  );

  // A landing answer for people who open the bare address. Browsers get a
  // short page; programs get JSON.
  app.get("/", (c) => {
    const url = new URL("/v1", c.req.url);
    const proto = c.req.header("x-forwarded-proto");
    if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
    const baseUrl = url.toString();
    const origin = baseUrl.slice(0, -"/v1".length);
    const roster = deps.roster ?? DEFAULT_ROSTER;
    const info = {
      name: "milo",
      description:
        'OpenRouter with an actual routing mechanism. Point an OpenAI-compatible client at /v1 with your OpenRouter key and use model "milo/auto".',
      baseUrl,
      routedModel: ROUTED_MODEL_ID,
      policyVersion: POLICY_VERSION,
      decisionBackend: DECISION_BACKEND,
      mode: deps.mode ?? "roster",
      roster: {
        version: DEFAULT_ROSTER_INFO.version,
        tiers: Object.fromEntries(TIERS.map((tier) => [tier, [...(roster[tier] ?? [])]])) as Record<
          Tier,
          string[]
        >,
      },
      rosterNote: ROSTER_NOTE,
      endpoints: [
        "/healthz",
        "/v1/chat/completions",
        "/v1/messages",
        "/v1/responses",
        "/v1/models",
        "/v1/roster",
        "/v1/preferences",
        "/v1/memory",
        "/v1/decisions/:id",
      ],
      docs: "https://github.com/bananaman614305/milo",
      setup: `${origin}/setup.md`,
      skill: `${origin}/skill.md`,
    };
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) return c.json(info);
    return c.html(landingPage(info));
  });

  // No auth: an agent has to be able to read these before it has a key.
  registerStaticRoutes(app);

  app.use("/v1/*", requireKey);
  // Cheapest abuse check first: an oversized body is refused before a
  // billing lookup is even attempted.
  app.use("/v1/*", tenantBodySizeGuard(deps));
  // Resolves `mk_` keys to an account and everything else to BYOK, once per
  // request, before any route reads the caller (ADR-007).
  app.use("/v1/*", billingAuth(deps));
  // Wraps every route below: applies whatever tenant-limits status a route
  // recorded to the outgoing response, refusal or success alike.
  app.use("/v1/*", tenantHeadersMiddleware());

  registerChatRoute(app, deps);
  registerMessagesRoute(app, deps);
  registerResponsesRoute(app, deps);
  registerModelsRoute(app, deps);
  registerRosterRoute(app, deps);
  registerPreferencesRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerVerifyRoute(app, deps);
  registerDecisionsRoutes(app, deps);
  // billing JSON routes
  if (deps.billing !== undefined) registerBillingRoutes(app, deps);
  registerAccountPages(app, deps); // account HTML pages
  // Last: it claims every `/v1/*` method and path the routes above did not.
  registerProxyRoute(app, deps);

  app.onError((err, c) => {
    deps.logger.error("unhandled gateway error", { error: err.message });
    return errorResponse(c, 500, "Milo failed to handle this request.", "api_error", "internal_error");
  });

  return app;
}

/** One row per tier: the tier's models and what each charges for output. */
function rosterRows(tiers: Record<Tier, string[]>, esc: (v: string) => string): string {
  return TIERS.map((tier) => {
    const ids = tiers[tier] ?? [];
    const models = ids.map((id) => esc(id)).join("<br>");
    const prices = ids
      .map((id) => {
        const known = defaultRosterModel(id);
        return known === undefined ? "&mdash;" : `$${known.outputUsdPerM}`;
      })
      .join("<br>");
    return `<tr><td class="tier">${esc(tier)}</td><td class="model">${models}</td><td class="price">${prices}</td></tr>`;
  }).join("\n");
}

function landingPage(info: {
  baseUrl: string;
  routedModel: string;
  policyVersion: string;
  decisionBackend: string;
  roster: { version: string; tiers: Record<Tier, string[]> };
  rosterNote: string;
  docs: string;
  setup: string;
  skill: string;
}): string {
  const esc = (v: string): string => v.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Milo</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 40px 20px 64px; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 40px; margin: 0 0 8px; letter-spacing: -0.01em; }
  p.lede { font-size: 18px; margin: 0 0 28px; opacity: .85; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 0 0 28px; }
  dt { opacity: .6; } dd { margin: 0; font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
  pre { background: color-mix(in srgb, CanvasText 8%, Canvas); padding: 14px 16px; overflow-x: auto; border-radius: 6px;
        font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; }
  a { color: inherit; }
  .ok { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #2e9e5b; margin-right: 6px; }
  table.roster { border-collapse: collapse; width: 100%; margin: 0 0 12px; font-size: 14px; }
  table.roster th, table.roster td { text-align: left; padding: 5px 10px 5px 0; vertical-align: top;
        border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); }
  table.roster th { opacity: .6; font-weight: 500; }
  table.roster td.tier { font-weight: 600; text-transform: capitalize; white-space: nowrap; }
  table.roster td.model { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
  table.roster td.price { white-space: nowrap; font-variant-numeric: tabular-nums; }
  p.note { font-size: 14px; opacity: .8; margin: 0 0 28px; }
</style></head>
<body><main>
<h1>Milo</h1>
<p class="lede">OpenRouter with an actual routing mechanism. Send <code>model: "milo/auto"</code> and a small decision model picks the right tier for each request from the task's type and difficulty.</p>
<dl>
  <dt>Status</dt><dd><span class="ok"></span>up, policy ${esc(info.policyVersion)}, decisions via ${esc(info.decisionBackend)}</dd>
  <dt>Base URL</dt><dd>${esc(info.baseUrl)}</dd>
  <dt>Model</dt><dd>${esc(info.routedModel)}</dd>
  <dt>Docs</dt><dd><a href="${esc(info.docs)}">${esc(info.docs)}</a></dd>
</dl>
<h2 style="font-size:18px;margin:0 0 8px">Use it</h2>
<pre>export OPENAI_BASE_URL=${esc(info.baseUrl)}
export OPENAI_API_KEY=&lt;your OpenRouter key&gt;
# any OpenAI SDK call with model="milo/auto"</pre>
<h2 style="font-size:18px;margin:0 0 8px">What Milo picks by default</h2>
<table class="roster"><thead><tr><th>Tier</th><th>Models, in preference order</th><th>Output $/M</th></tr></thead><tbody>
${rosterRows(info.roster.tiers, esc)}
</tbody></table>
<p class="note">${esc(info.rosterNote)} Roster version ${esc(info.roster.version)}; the full table, with prices and weekly usage ranks, is at <code>/v1/roster</code>.</p>
<p>Every routed response carries <code>x-milo-*</code> headers naming the decision. Fetch <code>/v1/decisions/&lt;id&gt;</code> with the same key to read why.</p>
<p>For agents: <a href="${esc(info.setup)}">${esc(info.setup)}</a> walks through setup end to end; the same content is installable as a skill from <a href="${esc(info.skill)}">${esc(info.skill)}</a>.</p>
</main></body></html>`;
}
