/**
 * Per-key rosters over HTTP (ADR-007): `PUT`, `GET` and `DELETE /v1/roster`,
 * and what a routed request from the same key then does.
 *
 * Both upstreams are one injected `fetch` dispatched on host, as in
 * `app.test.ts`: `api.typesafe.ai` answers as Jev from the recorded fixtures,
 * `openrouter.ai` serves a small model catalogue and a completion. Nothing
 * here touches the network.
 *
 * The invariant every test in this file is really guarding: the user's
 * OpenRouter key goes in the `Authorization` header and comes out nowhere --
 * not in the roster table, not in a log line, not in a response body.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ROSTER, DEFAULT_ROSTER_INFO } from "@milo/core";
import { createGateway } from "../index.js";
import type { Gateway, GatewayOptions } from "../index.js";

const KEY = "sk-or-v1-NEVERLEAKTHIS0123456789abcdef";
const OTHER_KEY = "sk-or-v1-SOMEONEELSE9876543210fedcba";
const AUTH = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const OTHER_AUTH = { authorization: `Bearer ${OTHER_KEY}`, "content-type": "application/json" };

const HASH = createHash("sha256").update(`Bearer ${KEY}`, "utf8").digest("hex");

/**
 * A catalogue wide enough to exercise every band: one model per tier, a
 * premium model above the top band, one that caps output below the 60,000
 * floor, and one that cannot call a tool.
 */
const CATALOGUE = [
  model("cheap/one", 0.07, 0.14, { maxOutputTokens: 128_000 }),
  model("cheap/two", 0.09, 0.3, {}),
  model("middle/one", 0.2, 1.2, { maxOutputTokens: 128_000 }),
  model("top/one", 1.4, 4.4, { maxOutputTokens: 200_000 }),
  model("premium/opus", 15, 75, { maxOutputTokens: 64_000 }),
  model("short/one", 0.1, 0.2, { maxOutputTokens: 8_000 }),
  model("no-tools/one", 0.1, 0.2, { tools: false }),
  // A shipped default, so a user list that names one still shows its numbers.
  model("deepseek/deepseek-v4-flash", 0.07, 0.14, { maxOutputTokens: 384_000 }),
];

function model(
  id: string,
  inUsdPerM: number,
  outUsdPerM: number,
  opts: { maxOutputTokens?: number; tools?: boolean },
): Record<string, unknown> {
  return {
    id,
    name: id,
    // OpenRouter prices in USD per token, as strings.
    pricing: { prompt: String(inUsdPerM / 1e6), completion: String(outUsdPerM / 1e6) },
    context_length: 256_000,
    top_provider: {
      context_length: 256_000,
      max_completion_tokens: opts.maxOutputTokens ?? null,
    },
    supported_parameters: opts.tools === false ? ["max_tokens"] : ["max_tokens", "tools"],
  };
}

type Fixture = {
  requestId: string;
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
};

function fixture(name: string): Fixture {
  const url = new URL(`../../../core/src/router/__fixtures__/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Fixture;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type LogLine = { level: string; msg: string; meta?: Record<string, unknown> };

let gateway: Gateway;
let lines: LogLine[];
/** Which Jev fixture the next routed request gets. `flaky-test` is frontier. */
let jevFixture: string;
let modelsCalls: number;

const upstreamFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);

  if (url.host === "api.typesafe.ai") {
    const f = fixture(jevFixture);
    return Promise.resolve(json({ model: f.model, answers: f.answers, usage: f.usage }));
  }
  if (url.host === "openrouter.ai") {
    if (url.pathname.endsWith("/models")) {
      modelsCalls += 1;
      return Promise.resolve(json({ data: CATALOGUE }));
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return Promise.resolve(
      json({
        id: "gen-1",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  }
  throw new Error(`unexpected upstream host: ${url.host}`);
}) as typeof fetch;

function capturingLogger(): NonNullable<GatewayOptions["logger"]> {
  const push =
    (level: string) =>
    (msg: string, meta?: Record<string, unknown>): void => {
      lines.push(meta === undefined ? { level, msg } : { level, msg, meta });
    };
  return { info: push("info"), warn: push("warn"), error: push("error") };
}

async function start(overrides: Partial<GatewayOptions> = {}): Promise<Gateway> {
  gateway = await createGateway({
    jevApiKey: "jev-test-key",
    fetch: upstreamFetch,
    logger: capturingLogger(),
    ...overrides,
  });
  return gateway;
}

function put(body: unknown, headers = AUTH): Promise<Response> {
  return gateway.app.request("/v1/roster", { method: "PUT", headers, body: JSON.stringify(body) });
}

function chat(headers = AUTH): Promise<Response> {
  return gateway.app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "milo/auto",
      messages: [
        { role: "system", content: "You are a sub-agent in an engineering crew." },
        { role: "user", content: "The gateway test fails one run in five in CI. Find out why." },
      ],
    }),
  });
}

type View = {
  rosterSource: string;
  storedAt?: string;
  usingDefaults: boolean;
  table: string;
  tiers: Record<string, Array<Record<string, unknown>>>;
  overrides: Record<string, string>;
};

beforeEach(() => {
  lines = [];
  jevFixture = "flaky-test";
  modelsCalls = 0;
  gateway = undefined as unknown as Gateway;
});

afterEach(async () => {
  await gateway?.close();
});

// ---------------------------------------------------------------------------

describe("PUT /v1/roster", () => {
  it("needs a key like every other /v1 route", async () => {
    await start();
    const res = await gateway.app.request("/v1/roster", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: ["cheap/one"] }),
    });
    expect(res.status).toBe(401);
  });

  it("tiers a flat model list by output price", async () => {
    await start();
    const res = await put({ models: ["top/one", "cheap/one", "middle/one", "premium/opus"] });
    expect(res.status).toBe(200);

    const body = (await res.json()) as View;
    expect(tierIds(body)).toEqual({
      // The user's own order is kept inside a tier.
      fast: ["cheap/one"],
      mid: ["middle/one"],
      frontier: ["top/one", "premium/opus"],
    });
    expect(body.rosterSource).toBe("user");
    expect(body.usingDefaults).toBe(false);
    expect(body.storedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("answers with the prices and the tier assignment it just made", async () => {
    await start();
    const body = (await (await put({ models: ["cheap/one", "top/one"] })).json()) as View;

    expect(body.tiers.fast?.[0]).toMatchObject({
      id: "cheap/one",
      source: "user",
      isTierDefault: true,
      inputUsdPerM: 0.07,
      outputUsdPerM: 0.14,
      maxOutputTokens: 128_000,
    });
    // And as a table an agent can paste in front of the user once.
    expect(body.table).toContain("| Tier | Model | In $/M | Out $/M | Max output |");
    expect(body.table).toContain("| fast | `cheap/one` | 0.07 | 0.14 | 128000 |");
    expect(body.table).toContain("| frontier | `top/one` | 1.4 | 4.4 | 200000 |");
  });

  it("keeps a premium model the user asked for, on frontier", async () => {
    await start();
    const body = (await (await put({ models: ["premium/opus"] })).json()) as View;
    // $75/M is far above the default roster's $5 ceiling, which exists to stop
    // Milo *choosing* such a model on its own. This user chose it.
    expect(tierIds(body).frontier).toEqual(["premium/opus"]);
  });

  it("sorts a small-output or tool-less model last in its tier", async () => {
    await start();
    const body = (await (await put({ models: ["short/one", "no-tools/one", "cheap/one"] })).json()) as View;
    expect(tierIds(body).fast).toEqual(["cheap/one", "short/one", "no-tools/one"]);
  });

  it("still knows a shipped default's usage rank when a user names one", async () => {
    await start();
    const body = (await (await put({ models: ["deepseek/deepseek-v4-flash"] })).json()) as View;
    expect(body.tiers.fast?.[0]).toMatchObject({
      id: "deepseek/deepseek-v4-flash",
      source: "default",
      usageRank: 2,
    });
  });

  it("takes explicit tiers as given", async () => {
    await start();
    const res = await put({
      tiers: { fast: ["cheap/one", "cheap/two"], mid: ["middle/one"], frontier: ["premium/opus"] },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as View;
    expect(tierIds(body)).toEqual({
      fast: ["cheap/one", "cheap/two"],
      mid: ["middle/one"],
      frontier: ["premium/opus"],
    });
  });

  it("lets an explicit tier list place a model the price bands would not", async () => {
    await start();
    // `top/one` is a $4.40 frontier model by price; the user wants it on fast.
    const body = (await (await put({ tiers: { fast: ["top/one"], mid: [], frontier: [] } })).json()) as View;
    expect(tierIds(body).fast).toEqual(["top/one"]);
  });

  it("rejects an id OpenRouter does not have, and names it", async () => {
    await start();
    const res = await put({ models: ["cheap/one", "typo/model", "also/missing"] });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("unknown_model");
    expect(body.error.message).toContain("typo/model");
    expect(body.error.message).toContain("also/missing");
    expect(body.error.message).not.toContain("cheap/one");

    // Nothing was stored: a roster is accepted whole or not at all.
    expect(await gateway.log.listRosters()).toHaveLength(0);
  });

  it("checks ids in an explicit tier list too", async () => {
    await start();
    const res = await put({ tiers: { fast: ["typo/model"], mid: [], frontier: [] } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("typo/model");
  });

  it("refuses a body that names neither models nor tiers, or both", async () => {
    await start();
    for (const body of [{}, { models: ["cheap/one"], tiers: { fast: ["cheap/one"] } }]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_roster");
    }
  });

  it("refuses an empty or mistyped model list", async () => {
    await start();
    for (const body of [{ models: [] }, { models: "cheap/one" }, { models: [""] }, { tiers: { fast: [1] } }]) {
      expect((await put(body)).status).toBe(400);
    }
  });

  it("refuses a body that is not a JSON object", async () => {
    await start();
    const res = await gateway.app.request("/v1/roster", { method: "PUT", headers: AUTH, body: "nonsense" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request_body");
  });

  it("replaces the stored roster rather than merging into it", async () => {
    await start();
    await put({ models: ["cheap/one", "middle/one"] });
    const body = (await (await put({ models: ["top/one"] })).json()) as View;

    expect(tierIds(body)).toEqual({ fast: [], mid: [], frontier: ["top/one"] });
    expect(await gateway.log.listRosters()).toHaveLength(1);
  });
});

describe("GET /v1/roster", () => {
  it("returns the running default when this key stored nothing", async () => {
    await start();
    const res = await gateway.app.request("/v1/roster", { headers: AUTH });
    const body = (await res.json()) as View;

    expect(body.rosterSource).toBe("default");
    expect(body.storedAt).toBeUndefined();
    expect(tierIds(body).fast).toEqual(DEFAULT_ROSTER.fast);
  });

  it("says when the deployment, rather than the caller, chose the roster", async () => {
    await start({ roster: { fast: ["cheap/one"], mid: ["middle/one"], frontier: ["top/one"] } });
    const body = (await (await gateway.app.request("/v1/roster", { headers: AUTH })).json()) as View;

    expect(body.rosterSource).toBe("config");
    expect(body.tiers.fast?.[0]).toMatchObject({ id: "cheap/one", source: "config" });
  });

  it("returns the caller's stored roster, marked as theirs", async () => {
    await start();
    await put({ models: ["cheap/one", "top/one"] });

    const body = (await (await gateway.app.request("/v1/roster", { headers: AUTH })).json()) as View;
    expect(body.rosterSource).toBe("user");
    expect(body.storedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(tierIds(body)).toEqual({ fast: ["cheap/one"], mid: [], frontier: ["top/one"] });
    expect(body.tiers.fast?.[0]).toMatchObject({ id: "cheap/one", source: "user" });
  });

  it("spends no OpenRouter call, so a stored id carries no price", async () => {
    await start();
    await put({ models: ["cheap/one"] });
    const before = modelsCalls;

    const body = (await (await gateway.app.request("/v1/roster", { headers: AUTH })).json()) as View;
    expect(modelsCalls).toBe(before);
    expect(body.tiers.fast?.[0]).toEqual({ id: "cheap/one", source: "user", isTierDefault: true });
  });

  it("tells the reader how to store and how to revert", async () => {
    await start();
    const body = (await (await gateway.app.request("/v1/roster", { headers: AUTH })).json()) as View;
    expect(body.overrides.perKey).toContain("PUT /v1/roster");
    expect(body.overrides.perKey).toContain("DELETE /v1/roster");
  });

  it("does not show one key's roster to another", async () => {
    await start();
    await put({ models: ["cheap/one"] });

    const body = (await (await gateway.app.request("/v1/roster", { headers: OTHER_AUTH })).json()) as View;
    expect(body.rosterSource).toBe("default");
    expect(tierIds(body).fast).toEqual(DEFAULT_ROSTER.fast);
  });
});

describe("DELETE /v1/roster", () => {
  it("removes the stored roster and answers with what takes its place", async () => {
    await start();
    await put({ models: ["cheap/one"] });

    const res = await gateway.app.request("/v1/roster", { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as View & { deleted: boolean };
    expect(body.deleted).toBe(true);
    expect(body.rosterSource).toBe("default");
    expect(tierIds(body).fast).toEqual(DEFAULT_ROSTER.fast);

    // And the next read agrees.
    const after = (await (await gateway.app.request("/v1/roster", { headers: AUTH })).json()) as View;
    expect(after.rosterSource).toBe("default");
    expect(await gateway.log.listRosters()).toHaveLength(0);
  });

  it("says so when there was nothing stored", async () => {
    await start();
    const res = await gateway.app.request("/v1/roster", { method: "DELETE", headers: AUTH });
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(false);
  });

  it("deletes only the caller's own", async () => {
    await start();
    await put({ models: ["cheap/one"] });
    await put({ models: ["top/one"] }, OTHER_AUTH);

    await gateway.app.request("/v1/roster", { method: "DELETE", headers: AUTH });

    const other = (await (await gateway.app.request("/v1/roster", { headers: OTHER_AUTH })).json()) as View;
    expect(other.rosterSource).toBe("user");
    expect(tierIds(other).frontier).toEqual(["top/one"]);
  });
});

describe("routing with a stored roster", () => {
  it("routes the storing key's request to a model from its own roster", async () => {
    await start();
    await put({ models: ["cheap/one", "middle/one", "top/one"] });

    const res = await chat(); // flaky-test fixture: balanced posture -> frontier
    expect(res.status).toBe(200);
    expect(res.headers.get("x-milo-tier")).toBe("frontier");
    expect(res.headers.get("x-milo-model")).toBe("top/one");
  });

  it("uses the stored roster's own tier defaults, tier by tier", async () => {
    await start();
    jevFixture = "trivial-rename";
    await put({ models: ["cheap/one", "middle/one", "top/one"] });

    const res = await chat();
    expect(res.headers.get("x-milo-tier")).toBe("fast");
    expect(res.headers.get("x-milo-model")).toBe("cheap/one");
  });

  it("leaves another key on the deployment's roster", async () => {
    await start({ roster: { fast: ["cheap/two"], mid: ["middle/one"], frontier: ["top/one"] } });
    await put({ models: ["premium/opus"] });

    const mine = await chat();
    expect(mine.headers.get("x-milo-model")).toBe("premium/opus");

    const theirs = await chat(OTHER_AUTH);
    expect(theirs.headers.get("x-milo-model")).toBe("top/one");
  });

  it("still lets `milo.candidates` filter within the stored roster", async () => {
    await start();
    await put({ models: ["cheap/one", "middle/one", "top/one"] });

    const res = await gateway.app.request("/v1/chat/completions", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "milo/auto",
        messages: [{ role: "user", content: "The gateway test fails one run in five in CI. Find out why." }],
        milo: { candidates: ["middle/one"] },
      }),
    });

    expect(res.headers.get("x-milo-model")).toBe("middle/one");
  });

  it("routes the Anthropic surface off the same stored roster", async () => {
    await start();
    await put({ models: ["cheap/one", "middle/one", "top/one"] });

    const res = await gateway.app.request("/v1/messages", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        model: "milo/auto",
        max_tokens: 64,
        system: "You are a sub-agent in an engineering crew.",
        messages: [
          { role: "user", content: "The gateway test fails one run in five in CI. Find out why." },
        ],
      }),
    });

    expect(res.headers.get("x-milo-model")).toBe("top/one");
  });

  it("falls back to the default roster when nothing is stored", async () => {
    await start();
    const res = await chat();
    expect(res.headers.get("x-milo-model")).toBe(DEFAULT_ROSTER.frontier[0]);
    expect(DEFAULT_ROSTER_INFO.tiers.frontier[0]?.id).toBe(DEFAULT_ROSTER.frontier[0]);
  });
});

describe("the key itself", () => {
  it("is stored only as a hash, and never logged or echoed", async () => {
    await start();
    const res = await put({ models: ["cheap/one"] });
    await chat();

    // One row, keyed by the SHA-256 of the normalized credential.
    const rows = await gateway.log.listRosters();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyHash).toBe(HASH);
    expect(rows[0]?.source).toBe("user");
    expect(rows[0]?.modelCount).toBe(1);

    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain(KEY);
    expect(dumped).not.toContain("sk-or-");

    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("sk-or-");
    // The write is visible to an operator by hash, which is the point.
    expect(lines.some((l) => l.msg === "stored per-key roster" && l.meta?.["keyHash"] === HASH)).toBe(true);

    expect(await res.text()).not.toContain(KEY);
  });

  it("gives the same identity whichever header carried it", async () => {
    await start();
    await put({ models: ["cheap/one"] });

    // `/v1/messages` accepts `x-api-key`; it must find the same stored roster.
    const res = await gateway.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: "milo/auto",
        max_tokens: 64,
        messages: [{ role: "user", content: "rename the variable" }],
      }),
    });

    expect(res.headers.get("x-milo-model")).toBe("cheap/one");
  });
});

describe("onboarding text", () => {
  it("tells an agent to ask before configuring, with the call to make", async () => {
    await start();
    const res = await gateway.app.request("http://milo.test/setup.md");
    const text = await res.text();

    expect(text).toContain("## Ask before configuring");
    expect(text).toContain("Which OpenRouter models do you already use?");
    expect(text).toContain("Which should Milo choose from?");
    // The exact call, against this deployment's own address.
    expect(text).toContain("curl -sS -X PUT http://milo.test/v1/roster");
    expect(text).toContain('-d \'{"models":["deepseek/deepseek-v4-flash","openai/gpt-5.6-luna","anthropic/claude-opus-5"]}\'');
    expect(text).toContain('"tiers": {');
    expect(text).toContain("Show that table to the user once");
    expect(text).toContain('If they say "just pick"');
    expect(text).toContain("Only a SHA-256 hash of the key");
    expect(text).toContain("curl -sS -X DELETE http://milo.test/v1/roster");
    // Before the setup steps, not after them.
    expect(text.indexOf("## Ask before configuring")).toBeLessThan(text.indexOf("## 1. Get an OpenRouter key"));
  });

  it("says the same thing in the skill", async () => {
    await start();
    const text = await (await gateway.app.request("/skill.md")).text();

    expect(text).toContain("## Ask before configuring");
    expect(text).toContain("Which OpenRouter models do you already use?");
    expect(text).toContain("PUT https://milo-gateway.fly.dev/v1/roster");
    expect(text).toContain("DELETE https://milo-gateway.fly.dev/v1/roster");
    expect(text.indexOf("## Ask before configuring")).toBeLessThan(
      text.indexOf("## Before you configure anything"),
    );
  });
});

/** Just the ids, per tier, out of a roster view. */
function tierIds(view: View): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(view.tiers).map(([tier, entries]) => [tier, entries.map((e) => String(e["id"]))]),
  );
}
