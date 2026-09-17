/**
 * Server-rendered account pages (ADR-007): no framework, no auth on the
 * shell itself -- every page below is static HTML plus a small inline
 * script that authenticates to the JSON billing API (`routes/billing-api.ts`,
 * built in parallel) client-side with a Milo key the visitor pastes in.
 *
 * The key never touches this server: it lives only in the browser's
 * `sessionStorage` and is attached as `Authorization: Bearer` on each fetch
 * the inline script makes. These routes carry no `Authorization` check of
 * their own and read no cookie -- there is nothing here for a session to
 * leak.
 *
 * Security rules for this file specifically:
 *  - Anything interpolated from a request (currently only `/account/success`'s
 *    `session_id` query param) goes through `esc()` before it reaches the
 *    HTML string.
 *  - The inline client scripts render API data with `textContent` /
 *    `createElement`, never `innerHTML`, so a hostile model name or key
 *    label returned by the API cannot inject markup.
 *  - Pricing (margin, per-request fee) is always read from the API's
 *    `pricing` object at runtime; nothing about what Milo charges is
 *    hard-coded into this file.
 */

import type { Hono } from "hono";
import { CREDIT_PACKS } from "@milo/core";
import type { AppDeps } from "../app.js";

/** Shared with the root landing page's own escaping (`app.ts`'s `esc`). */
function esc(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );
}

/**
 * The same look as the root page (`app.ts`'s `landingPage`): system font,
 * `Canvas`/`CanvasText` so it follows the browser's own theme, a narrow
 * centered column. Extended with form/table/button rules the root page
 * doesn't need, and a phone-width breakpoint since these pages take real
 * input rather than just being read.
 */
const SHELL_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 20px 64px; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 32px; margin: 0 0 8px; letter-spacing: -0.01em; }
  h2 { font-size: 18px; margin: 28px 0 10px; }
  p { margin: 0 0 12px; }
  a { color: inherit; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
  .note { font-size: 14px; opacity: .75; }
  .warn { font-size: 14px; color: #b45309; }
  .error { font-size: 14px; color: #dc2626; }
  .big { font-size: 32px; font-weight: 600; margin: 0 0 4px; font-variant-numeric: tabular-nums; }
  input, button { font: inherit; padding: 9px 12px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 30%, Canvas); }
  input { background: Canvas; color: CanvasText; width: 100%; max-width: 360px; }
  button { background: color-mix(in srgb, CanvasText 92%, Canvas); color: Canvas; border: none; cursor: pointer; }
  button:hover { opacity: .9; }
  button.secondary { background: color-mix(in srgb, CanvasText 8%, Canvas); color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 30%, Canvas); }
  .row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .packs { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 16px; font-size: 14px; }
  .table-wrap { overflow-x: auto; }
  th, td { text-align: left; padding: 6px 10px 6px 0; vertical-align: top;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); }
  th { opacity: .6; font-weight: 500; }
  form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 16px; }
  section#dashboard { display: block; }
  @media (max-width: 480px) {
    .row { flex-direction: column; }
    input { max-width: none; }
  }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${SHELL_STYLE}</style>
</head>
<body><main>
${body}
</main></body></html>`;
}

/**
 * Shared by every page's inline script: a `fetch` wrapper that attaches the
 * Milo key from `sessionStorage` as a bearer token, parses the JSON body
 * (tolerating an empty one), and throws with the API's own error message on
 * a non-2xx response so callers can show it directly.
 */
const CLIENT_API_HELPER = `
var MILO_KEY_STORAGE = "milo_key";

function miloApiFetch(path, opts) {
  opts = opts || {};
  var key = sessionStorage.getItem(MILO_KEY_STORAGE);
  var headers = {};
  for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
  if (key) headers["authorization"] = "Bearer " + key;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  var init = { method: opts.method, headers: headers, body: opts.body };
  return fetch(path, init).then(function (response) {
    return response.text().then(function (text) {
      var data = {};
      if (text) {
        try { data = JSON.parse(text); } catch (parseError) { data = {}; }
      }
      if (!response.ok) {
        var message =
          (data && data.error && data.error.message) ||
          (data && data.message) ||
          ("HTTP " + response.status);
        throw new Error(message);
      }
      return data;
    });
  });
}

function miloUsd(value) {
  var num = Number(value);
  if (!isFinite(num)) return "-";
  return "$" + num.toFixed(4).replace(/0+$/, "").replace(/\\.$/, "");
}

function miloClearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
`;

// ---------------------------------------------------------------------------
// GET /account
// ---------------------------------------------------------------------------

function accountPagePacksHtml(): string {
  return CREDIT_PACKS.map(
    (pack) => `<button type="button" class="pack-btn" data-pack-id="${esc(pack.id)}">${esc(pack.label)}</button>`,
  ).join("\n    ");
}

function accountPageBody(): string {
  return `<h1>Milo account</h1>

<section id="signin">
  <p>Paste your Milo key (<code>mk_...</code>) to view your account. It is
  kept only in this browser tab's session storage and is never sent anywhere
  but Milo's own API.</p>
  <form id="signin-form">
    <input id="signin-key" type="password" placeholder="mk_..." autocomplete="off" required>
    <button type="submit">Sign in</button>
  </form>
  <p id="signin-error" class="error" hidden></p>
  <p class="note">No account yet? <a href="/account/new">Create one</a>.</p>
</section>

<section id="dashboard" hidden>
  <div class="row">
    <div>
      <h2 style="margin-top:0">Balance</h2>
      <p id="balance" class="big">-</p>
      <p id="pricing-line" class="note"></p>
    </div>
    <button type="button" class="secondary" id="signout-btn">Sign out</button>
  </div>

  <h2>Buy credits</h2>
  <div class="packs">
    ${accountPagePacksHtml()}
  </div>
  <button type="button" class="secondary" id="portal-btn">Manage billing</button>

  <h2>API keys</h2>
  <div class="table-wrap">
    <table id="keys-table">
      <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
      <tbody id="keys-body"></tbody>
    </table>
  </div>
  <form id="create-key-form">
    <input id="new-key-name" placeholder="Key name" required>
    <button type="submit">Create key</button>
  </form>
  <div id="new-secret" hidden>
    <p><strong>New key secret (shown once):</strong> <code id="new-secret-value"></code>
    <button type="button" class="secondary" id="copy-secret-btn">Copy</button></p>
    <p class="warn">Save this now -- Milo cannot show it again.</p>
  </div>

  <h2>Usage</h2>
  <p id="usage-summary" class="note">-</p>
  <div class="table-wrap">
    <table id="usage-table">
      <thead><tr><th>Model</th><th>Requests</th></tr></thead>
      <tbody id="usage-body"></tbody>
    </table>
  </div>

  <h2>Recent records</h2>
  <div class="table-wrap">
    <table id="records-table">
      <thead><tr><th>Time</th><th>Model</th><th>Charged</th></tr></thead>
      <tbody id="records-body"></tbody>
    </table>
  </div>

  <p><a href="/setup.md">Setup guide for agents</a></p>
</section>

<script>
${CLIENT_API_HELPER}
(function () {
  function $(id) { return document.getElementById(id); }

  function showDashboard() {
    $("signin").hidden = true;
    $("dashboard").hidden = false;
  }

  function signOut() {
    sessionStorage.removeItem(MILO_KEY_STORAGE);
    $("dashboard").hidden = true;
    $("signin").hidden = false;
  }

  function renderKeys(keys) {
    var body = $("keys-body");
    miloClearChildren(body);
    (keys || []).forEach(function (key) {
      var tr = document.createElement("tr");

      var tdName = document.createElement("td");
      tdName.textContent = key.name;
      tr.appendChild(tdName);

      var tdPrefix = document.createElement("td");
      tdPrefix.textContent = key.prefix;
      tr.appendChild(tdPrefix);

      var tdCreated = document.createElement("td");
      tdCreated.textContent = key.createdAt;
      tr.appendChild(tdCreated);

      var tdLastUsed = document.createElement("td");
      tdLastUsed.textContent = key.lastUsedAt || "never";
      tr.appendChild(tdLastUsed);

      var tdStatus = document.createElement("td");
      tdStatus.textContent = key.revokedAt ? "revoked" : "active";
      tr.appendChild(tdStatus);

      var tdAction = document.createElement("td");
      if (!key.revokedAt) {
        var revokeBtn = document.createElement("button");
        revokeBtn.type = "button";
        revokeBtn.className = "secondary";
        revokeBtn.textContent = "Revoke";
        revokeBtn.addEventListener("click", function () { revokeKey(key.id); });
        tdAction.appendChild(revokeBtn);
      }
      tr.appendChild(tdAction);

      body.appendChild(tr);
    });
  }

  function renderAccount(data) {
    $("balance").textContent = miloUsd(data.balanceUsd);
    var pricing = data.pricing || {};
    if (pricing.margin !== undefined && pricing.decisionFeeUsd !== undefined) {
      $("pricing-line").textContent =
        "You pay OpenRouter's price plus " + (pricing.margin * 100) +
        "% and $" + pricing.decisionFeeUsd + " per routed request";
    } else {
      $("pricing-line").textContent = "";
    }
    renderKeys(data.keys);
  }

  function renderUsage(data) {
    var summary = data.summary || {};
    $("usage-summary").textContent =
      "Requests: " + (summary.requests || 0) +
      "  \\u00b7  Charged: " + miloUsd(summary.chargedUsd || 0) +
      "  \\u00b7  Upstream cost: " + miloUsd(summary.upstreamCostUsd || 0);

    var usageBody = $("usage-body");
    miloClearChildren(usageBody);
    var byModel = summary.byModel || {};
    Object.keys(byModel).forEach(function (model) {
      var tr = document.createElement("tr");
      var tdModel = document.createElement("td");
      tdModel.textContent = model;
      tr.appendChild(tdModel);
      var tdCount = document.createElement("td");
      tdCount.textContent = String(byModel[model]);
      tr.appendChild(tdCount);
      usageBody.appendChild(tr);
    });

    var recordsBody = $("records-body");
    miloClearChildren(recordsBody);
    (data.records || []).slice(0, 20).forEach(function (record) {
      var tr = document.createElement("tr");
      var tdTime = document.createElement("td");
      tdTime.textContent = record.createdAt || "-";
      tr.appendChild(tdTime);
      var tdModel = document.createElement("td");
      tdModel.textContent = record.model || "-";
      tr.appendChild(tdModel);
      var tdCharged = document.createElement("td");
      tdCharged.textContent = record.chargedUsd !== undefined ? miloUsd(record.chargedUsd) : "-";
      tr.appendChild(tdCharged);
      recordsBody.appendChild(tr);
    });
  }

  function loadAccount() {
    return miloApiFetch("/v1/account").then(function (data) {
      renderAccount(data);
      return miloApiFetch("/v1/account/usage");
    }).then(function (usage) {
      renderUsage(usage);
    });
  }

  function revokeKey(id) {
    miloApiFetch("/v1/account/keys/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function () { return miloApiFetch("/v1/account"); })
      .then(renderAccount)
      .catch(function (err) { alert("Could not revoke key: " + err.message); });
  }

  $("signin-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var value = $("signin-key").value.trim();
    if (!value) return;
    sessionStorage.setItem(MILO_KEY_STORAGE, value);
    $("signin-error").hidden = true;
    showDashboard();
    loadAccount().catch(function (err) {
      signOut();
      $("signin-error").textContent = err.message;
      $("signin-error").hidden = false;
    });
  });

  $("signout-btn").addEventListener("click", signOut);

  $("create-key-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var name = $("new-key-name").value.trim();
    if (!name) return;
    miloApiFetch("/v1/account/keys", { method: "POST", body: JSON.stringify({ name: name }) })
      .then(function (result) {
        $("new-secret-value").textContent = result.secret;
        $("new-secret").hidden = false;
        $("new-key-name").value = "";
        return miloApiFetch("/v1/account");
      })
      .then(renderAccount)
      .catch(function (err) { alert("Could not create key: " + err.message); });
  });

  $("copy-secret-btn").addEventListener("click", function () {
    var text = $("new-secret-value").textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
  });

  var packButtons = document.querySelectorAll(".pack-btn");
  for (var i = 0; i < packButtons.length; i++) {
    packButtons[i].addEventListener("click", function (event) {
      var packId = event.currentTarget.getAttribute("data-pack-id");
      miloApiFetch("/v1/account/checkout", { method: "POST", body: JSON.stringify({ packId: packId }) })
        .then(function (result) { window.location.href = result.url; })
        .catch(function (err) { alert("Checkout failed: " + err.message); });
    });
  }

  $("portal-btn").addEventListener("click", function () {
    miloApiFetch("/v1/account/portal", { method: "POST" })
      .then(function (result) { window.location.href = result.url; })
      .catch(function (err) { alert("Could not open the billing portal: " + err.message); });
  });

  if (sessionStorage.getItem(MILO_KEY_STORAGE)) {
    showDashboard();
    loadAccount().catch(function (err) {
      signOut();
      $("signin-error").textContent = err.message;
      $("signin-error").hidden = false;
    });
  }
})();
</script>`;
}

// ---------------------------------------------------------------------------
// GET /account/new
// ---------------------------------------------------------------------------

function accountNewBody(): string {
  return `<h1>Create a Milo account</h1>
<p class="note">Signup is by email only for now -- there is no password and
no email verification yet. Anyone who later has your account id can create
new keys against it from <a href="/account">/account</a>, so keep the key
below safe.</p>

<form id="signup-form">
  <input id="signup-email" type="email" placeholder="you@example.com" autocomplete="email" required>
  <button type="submit">Create account</button>
</form>
<p id="signup-error" class="error" hidden></p>

<div id="signup-result" hidden>
  <p>Account created: <code id="result-account-id"></code></p>
  <p><strong>Your Milo key (shown once):</strong> <code id="result-key"></code>
  <button type="button" class="secondary" id="copy-key-btn">Copy</button></p>
  <p class="warn">Save this now -- Milo cannot show it again.</p>
  <p><a href="/account">Go to your account</a></p>
</div>

<script>
${CLIENT_API_HELPER}
(function () {
  function $(id) { return document.getElementById(id); }

  $("signup-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var email = $("signup-email").value.trim();
    if (!email) return;
    $("signup-error").hidden = true;
    miloApiFetch("/v1/signup", { method: "POST", body: JSON.stringify({ email: email }) })
      .then(function (data) {
        $("result-account-id").textContent = data.accountId;
        $("result-key").textContent = data.key;
        $("signup-result").hidden = false;
        $("signup-form").hidden = true;
      })
      .catch(function (err) {
        $("signup-error").textContent = err.message;
        $("signup-error").hidden = false;
      });
  });

  $("copy-key-btn").addEventListener("click", function () {
    var text = $("result-key").textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
  });
})();
</script>`;
}

// ---------------------------------------------------------------------------
// GET /account/success and /account/cancel
// ---------------------------------------------------------------------------

/** `sessionId` is untrusted request input; the caller must have already escaped it. */
function accountSuccessBody(escapedSessionId: string | undefined): string {
  const sessionLine =
    escapedSessionId !== undefined
      ? `<p class="note">Checkout session: <code>${escapedSessionId}</code></p>`
      : "";
  return `<h1>Payment received</h1>
<p>Your credits will appear in your balance within about a minute, once
Milo's webhook finishes processing the payment.</p>
${sessionLine}
<p><a href="/account">Go to your account</a></p>`;
}

function accountCancelBody(): string {
  return `<h1>Checkout canceled</h1>
<p>No charge was made. <a href="/account">Return to your account</a>.</p>`;
}

export function registerAccountPages(app: Hono, _deps: AppDeps): void {
  app.get("/account", (c) => c.html(shell("Milo account", accountPageBody())));

  app.get("/account/new", (c) => c.html(shell("Create a Milo account", accountNewBody())));

  app.get("/account/success", (c) => {
    const sessionId = c.req.query("session_id");
    const escaped = sessionId === undefined ? undefined : esc(sessionId);
    return c.html(shell("Milo -- payment received", accountSuccessBody(escaped)));
  });

  app.get("/account/cancel", (c) => c.html(shell("Milo -- checkout canceled", accountCancelBody())));
}
