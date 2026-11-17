# Private admin deployment

The owner console is served at `https://grunt.run/admin/`. Its static page is
part of the existing `site/` deployment. Google login and the admin API run on
the existing Fly app at `https://api.grunt.run/admin/*`. Chad sends a projected,
redacted diagnostic feed to that API over outbound HTTPS.

This is an owner-operated installation. It does not enroll other users or
upload their diagnostics automatically. The local inference daemon stays on its
existing loopback port, currently `8792` on Chad. The collector does not open an
inbound port or forward inference traffic.

## Deployment prerequisites

Before enabling live access, verify all of the following:

- The two owners have confirmed their complete Google account email addresses.
  Bare account names are not accepted and no addresses are inferred.
- A dedicated Grunt Google OAuth web client exists. Unrelated applications'
  clients, secrets and redirect registrations must not be reused or changed.
- An authorized operator can update the existing Cloudflare Pages project and
  the `grunt.run` DNS zone.
- An authorized operator can deploy to the existing `milo-gateway` Fly app and
  provision its admin secrets through a protected backend or private input.
- The admin changes have passed their tests, independent review and the
  canonical exact-head GitHub CI check before landing.

Only the public CI workflow is enabled. Site, deployment, publication and
registry workflows remain separately disabled; this rollout does not require
enabling them. Use standard Ubuntu runners for CI, without paid runners or
artifact/cache uploads.

## Hosting and DNS

Preserve the Fly app `milo-gateway`, its `milo_data` volume and existing database
configuration. Preserve the current Pages project and the marketing site at
the apex. The backend keeps its existing internal service port `8787`.

Initial read-only discovery found:

- `grunt.run` resolves through Cloudflare but returned HTTP `403` from this
  server. That response alone does not identify its current Pages origin or
  access rules.
- The existing signed-in Cloudflare identity had one account, with a Super admin
  membership, but that account showed no domains and no Workers/Pages projects.
  Its account selector offered no other existing memberships. Signing in alone
  therefore did not establish access to the account that owns `grunt.run`.
- `api.grunt.run` returned `NXDOMAIN`.
- `milo-gateway` was deployed with one started machine in `iad` and the default
  hostname `milo-gateway.fly.dev`.
- A certificate for `api.grunt.run` already existed on that app, with status
  `Awaiting configuration`.
- The app had an allocated IPv6 address and no allocated IPv4 address. Do not
  invent an A record, allocate a dedicated address or change proxy settings
  without reviewing the current configuration.

Recheck live state before applying DNS changes. These are read-only commands
for an operator with app-scoped Fly access:

```sh
fly status --app milo-gateway --json
fly ips list --app milo-gateway
fly certs show api.grunt.run --app milo-gateway
fly certs setup api.grunt.run --app milo-gateway
dig +short A api.grunt.run
dig +short AAAA api.grunt.run
dig +short CNAME _acme-challenge.api.grunt.run
```

`flyctl` can be used in place of `fly`. On Chad the existing executable is
`~/.fly/bin/flyctl`; it is not necessarily on `PATH`. The local interactive
profile initially required login. An existing app-specific vaulted deployment
credential was independently verified through backend-injected, read-only Fly
API requests. Neither that credential nor a temporary egress token belongs in
terminal output, source, diagnostic bundles or documentation.

Configure the API subdomain using the routing records returned by the app's
current `fly ips list` and `fly certs setup`. The DNS-01 validation instruction
observed for the existing certificate was:

```text
CNAME _acme-challenge.api.grunt.run -> api.grunt.run.e52kor1.flydns.net.
```

Verify that value with Fly before using it. This challenge record validates TLS;
it does not replace the API hostname's traffic-routing record. Do not create a
second certificate merely because DNS has not been configured. An authorized
operator can run `fly certs check api.grunt.run --app milo-gateway` after the
records are published, then verify HTTPS before enabling browser login or the
collector. Review both IPv4 and IPv6 client reachability and any Cloudflare proxy
configuration. See [Fly custom-domain instructions](https://docs.fly.io/networking/custom-domain).

## Google owner login

Use a dedicated Google OAuth **Web application** client. Register exactly:

```text
https://api.grunt.run/admin/auth/callback
```

The browser begins login at `/admin/auth/google` on the API origin. Google
returns to the API callback; successful owner login returns the browser to
`https://grunt.run/admin/`. A Google account outside the configured owner list
cannot create an owner session.

Request only the identity scopes used by this implementation: `openid`, `email`
and `profile`. Google documents a testing-mode exception for these basic sign-in
scopes: users need not be added as test users, and the normal seven-day test
authorization expiry does not apply. The backend owner allowlist remains the
authorization boundary. If test users are configured, use only confirmed full
addresses. See [Google's audience rules](https://support.google.com/cloud/answer/15549945)
and [OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).
Do not enable Gmail, Drive or other account permissions for the dashboard. No
Google Cloud billing account is required by the dashboard itself; stop if a
setup path asks to activate a paid service.

The backend verifies Google identity and checks the explicit email allowlist.
Its session cookie is Secure, HttpOnly, host-only on the API hostname and scoped
to `/admin`. Cross-origin UI requests use credentials with an exact allowed UI
origin. Logout requires its CSRF token and an allowed Origin. The optional
machine read token does not grant browser sessions or ingestion privileges.

Missing or malformed owner/auth configuration fails closed with `503`.
Deployment must not introduce a development login, anonymous data fallback,
wildcard owner or shared browser token to work around incomplete setup.

## Backend configuration

Provision these values on the existing Fly app using protected secret input.
Do not put secret values in Git, a public Pages build, command arguments, shell
history or this document.

| Variable | Purpose |
| --- | --- |
| `GRUNT_ADMIN_OWNERS` | Comma-separated, complete, confirmed owner email addresses; no default. |
| `GRUNT_ADMIN_GOOGLE_CLIENT_ID` | Dedicated Grunt Google web client ID. |
| `GRUNT_ADMIN_GOOGLE_CLIENT_SECRET` | Matching Google client secret, available only to the backend. |
| `GRUNT_ADMIN_SESSION_SECRET` | Independently generated session protection secret of at least 32 bytes. |
| `GRUNT_ADMIN_UI_ORIGIN` | Exact HTTPS UI origin; production is `https://grunt.run`. |
| `GRUNT_ADMIN_PUBLIC_URL` | Exact HTTPS API origin; production is `https://api.grunt.run`. |
| `GRUNT_ADMIN_INSTANCES` | Explicit comma-separated instance IDs accepted by ingestion, such as `chad`. |
| `GRUNT_ADMIN_INGEST_KEY` | Dedicated collector authentication secret; separate from Google/session secrets. |
| `GRUNT_ADMIN_READ_TOKEN` | Optional dedicated token for read-only diagnostic API access. |

The static UI receives only the public API origin; it must never contain the
client secret, session secret, ingestion key or machine read token. Keep the
backend database on the existing persistent volume. Deploy the reviewed app
without renaming or replacing the app, volume or database and without changing
its machine size/count as a side effect.

## Chad collector

Follow [the collector runbook](admin-collector.md) for its private environment
file and service setup. The entry point is `node dist/admin/collector.js`.
Its production destination is `https://api.grunt.run/admin/ingest`.

The receiver's `GRUNT_ADMIN_INSTANCES` must include the collector's exact
`GRUNT_ADMIN_INSTANCE_ID`. The collector and receiver share the dedicated
`GRUNT_ADMIN_INGEST_KEY`; they do not share an owner's browser cookie or Google
credential. The collector's daemon port remains `8792` on Chad. Its cursor is
private local state and advances only after the remote acknowledgement.

Start the collector only after the API hostname, certificate and ingestion
configuration have been verified. Startup must not trigger provider signups,
inference probes or changes to another project's services. The collector reads
cached local diagnostics and uploads only the approved projection.

## Acceptance checks

1. Verify the production UI loads at `/admin/` and the API certificate is valid.
2. In a clean browser, confirm private API requests are denied before login and
   no diagnostic data appears in the public static HTML.
3. Sign in as each confirmed owner. Confirm an unrelated Google account is
   denied, and removing an owner from configuration also denies its old session.
4. Confirm the UI's cross-origin requests work only from its configured origin;
   disallowed origins and invalid logout CSRF tokens remain denied.
5. With the configured collector, confirm a new Chad heartbeat and projected
   diagnostics arrive. Invalid ingestion credentials and unlisted instance IDs
   must be denied. A machine read token must not authorize ingestion or logout.
6. Restart the backend in a controlled window and verify persistent diagnostic
   history remains. Check the existing relay, `/health` and registry routes.
7. Confirm viewing the dashboard does not consume inference allowance. Inspect
   exports for the absence of keys, cookies, OAuth codes, signed handoff URLs,
   prompt text, source code and raw upstream error payloads.

For rollback, retain the existing Fly/Pages release identifiers and restore the
previous reviewed artifact. Stop only the newly owned collector service if
needed. Do not delete the existing database, volume, provider grants or other
projects' processes. Rotating the admin session secret invalidates owner sessions;
rotating the ingestion key requires updating both ends of the collector link.
