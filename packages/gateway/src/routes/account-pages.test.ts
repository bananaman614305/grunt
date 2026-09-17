/**
 * The account pages are a static shell plus inline client-side scripts (see
 * `account-pages.ts`'s module doc): no auth, no server-side data except a
 * query param on `/account/success`. These tests exercise the HTTP surface
 * directly rather than through a browser -- there is nothing here a browser
 * would add except running the inline `<script>`, which is out of scope for
 * a Node test.
 *
 * `registerAccountPages` takes `AppDeps` only so the one-line call site in
 * `app.ts` type-checks against the `deps` already in scope there; the pages
 * read nothing off it, so an empty stub is enough here.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CREDIT_PACKS } from "@milo/core";
import type { AppDeps } from "../app.js";
import { registerAccountPages } from "./account-pages.js";

function buildApp(): Hono {
  const app = new Hono();
  registerAccountPages(app, {} as AppDeps);
  return app;
}

async function getHtml(app: Hono, path: string): Promise<{ status: number; contentType: string | null; body: string }> {
  const res = await app.request(path);
  return { status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
}

describe("registerAccountPages", () => {
  it("serves /account with no auth, a title, a viewport meta, and the credit packs", async () => {
    const { status, contentType, body } = await getHtml(buildApp(), "/account");

    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/html/);
    expect(body).toContain("<title>Milo account</title>");
    expect(body).toContain('name="viewport"');
    expect(body).toContain('id="signin-form"');
    expect(body).toContain('id="dashboard"');
    for (const pack of CREDIT_PACKS) {
      expect(body).toContain(`data-pack-id="${pack.id}"`);
      expect(body).toContain(`>${pack.label}<`);
    }
    // The pricing line is filled in client-side from the API's own
    // `pricing` object, never hard-coded into the shell.
    expect(body).not.toMatch(/plus \d+%/);
    expect(body).toContain("pricing.margin");
    expect(body).toContain("pricing.decisionFeeUsd");
  });

  it("client script renders API data with textContent/createElement, never innerHTML", async () => {
    const { body } = await getHtml(buildApp(), "/account");
    expect(body).not.toContain(".innerHTML");
  });

  it("serves /account/new with a signup form and a title", async () => {
    const { status, contentType, body } = await getHtml(buildApp(), "/account/new");

    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/html/);
    expect(body).toContain("<title>Create a Milo account</title>");
    expect(body).toContain('name="viewport"');
    expect(body).toContain('id="signup-form"');
    expect(body).toContain('type="email"');
    expect(body).toContain('href="/account"');
  });

  it("serves /account/cancel with a link back", async () => {
    const { status, body } = await getHtml(buildApp(), "/account/cancel");
    expect(status).toBe(200);
    expect(body).toContain("Checkout canceled");
    expect(body).toContain('href="/account"');
  });

  it("/account/success shows the session id safely", async () => {
    const { status, body } = await getHtml(buildApp(), "/account/success?session_id=cs_test_abc123");
    expect(status).toBe(200);
    expect(body).toContain("cs_test_abc123");
    expect(body).toContain("Payment received");
    expect(body).toContain('href="/account"');
  });

  it("/account/success escapes a hostile session_id query value", async () => {
    const hostile = "<script>alert(1)</script>";
    const { status, body } = await getHtml(
      buildApp(),
      `/account/success?session_id=${encodeURIComponent(hostile)}`,
    );

    expect(status).toBe(200);
    expect(body).not.toContain(hostile);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("/account/success works with no session_id at all", async () => {
    const { status, body } = await getHtml(buildApp(), "/account/success");
    expect(status).toBe(200);
    expect(body).toContain("Payment received");
  });

  it("escapes a hostile value in every page that could ever echo a query string back", async () => {
    // Belt and suspenders: every route this module registers, hit with a
    // hostile query string, must never reflect it unescaped even if it
    // doesn't use it today.
    const app = buildApp();
    const hostile = '"><img src=x onerror=alert(1)>';
    for (const path of ["/account", "/account/new", "/account/cancel", "/account/success"]) {
      const res = await app.request(`${path}?q=${encodeURIComponent(hostile)}`);
      const body = await res.text();
      expect(body).not.toContain(hostile);
    }
  });
});
