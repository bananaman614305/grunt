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

- Every owner enabled at rollout has a confirmed complete Google account email
  address. Additional owners can remain disabled until their addresses are
  confirmed. Bare account names are not accepted and no addresses are inferred.
- A dedicated Grunt Google OAuth web client exists. Unrelated applications'
  clients, secrets and redirect registrations must not be reused or changed.
- An authorized operator can update the existing Cloudflare Pages project and
  the `grunt.run` DNS zone.
- An authorized operator can deploy to the existing `milo-gateway` Fly app and
  provision its admin secrets through a protected backend or private input.
- The admin changes have passed their tests, independent review and the
  canonical exact-head GitHub CI check before landing.

The public CI and existing Fly `deploy` workflow are enabled. Backend pushes to
`main` deploy through GitHub Actions; `workflow_dispatch` also supports an explicit
run. Site and npm publication workflows remain separately disabled. Registry
updates follow the [registry publication contract](reference.md#sources-and-app-sessions).
Use standard Ubuntu runners for CI, without paid runners or artifact/cache uploads.

The deployment job runs `flyctl secrets sync --app milo-gateway --stage` before
deploying. Flyctl tracks the minimum secrets version locally, so a fresh runner
must synchronize settings staged by another machine or through the Machines API.
The sync step stages only; the following deployment activates the settings with
the tested image. See [Fly's secrets sync command](https://docs.fly.io/flyctl/cmd/fly_secrets_sync).

As of 2026-11-17, the production Pages site and Fly backend are deployed, the
verified first owner's login settings are active, and the Chad collector sends
sanitized diagnostics. Custom API DNS and the first real Google sign-in remain
pending. The second owner can be added later; their address does not block the
first owner's access.

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
| `GRUNT_ADMIN_PLAYTEST_URL` | Optional HTTPS `*.pages.dev` URL for the versioned Amazing Adventure build approved for playtesting. The owner Play tab opens it in a new browser tab. |

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

## Adoption and registry dashboard

The Fly image serves the dashboard at `/admin/adoption`. Requests for the root
of `dashboard.grunt.run` on this app open that page. Attach the dashboard
hostname to the existing Fly app, publish its Fly-issued DNS records, and
register `https://dashboard.grunt.run/admin/auth/callback` on the dedicated
Google web client. Keep existing callback URLs. The dashboard uses the existing
confirmed owner allowlist and same-host HTTPS session. Test each owner's Google
login. The machine read token cannot retrieve account analytics.

Day, week and month start at UTC midnight today, six days ago and twenty-nine
days ago. Hosted accounts are identified by the existing gateway key fingerprint.
The account's most recent attempt in the period supplies its reported country
and coarse device class. Missing dimensions appear as Unknown. Only complete
upstream input and output measurements contribute to metered tokens. New
attribution starts with deployment. Historical routing estimates stay separate.
Submitting the hosted chat setup form registers the key fingerprint once through
`POST /agent/register`. Saved-key reconnects and direct message requests do
not create signup events. Earlier activity has no known signup time. The funnel
includes registered accounts that send no messages, and follows
attempt, successful reply and later-day success within seven days. It excludes
accounts whose observation window predates metering or has yet to finish.

Country reporting requires a proxied Cloudflare route for exactly
`api.grunt.run/agent/messages`. Deploy `src/edge/country.ts` as a Cloudflare
Worker on that route. Provision the same dedicated random secret (at least
32 characters) as `GRUNT_COUNTRY_INGRESS_SECRET` on the Worker and Fly app.
The Worker replaces caller-supplied internal headers with Cloudflare's
request geography and the private origin credential. Direct Fly requests,
missing configuration and unavailable geography produce Unknown. Legacy
country values are cleared when migrating previous attribution records.

The registry reads the live published catalog. Anonymous router daily reports
supply attempts, success counts and smoothed latency. Old reports are rolled up
without installation IDs before normal expiry. History before retained reports
cannot be recovered. Counts reflect delivered reports, including retries;
cancelled calls and unsent router activity are outside coverage. Enrolled
collector observations supply probe pass rate, confirmed free
replies and observed models within retained diagnostic history. The collector lacks session boundaries, so session duration remains unreported. Kilo reports the model and zero billing after
its existing response checks pass. A missing billing report remains unknown.

### Nightly fleet audit

The existing HTTPS registry feedback exchange issues a scoped bearer to the
reporting installation. The gateway signs the digest of a separate private installation proof with
`GRUNT_FLEET_SIGNING_SECRET` (or the configured admin session secret, using a
separate HMAC context). Clients receive only the scoped bearer, and request it
only at the owned registry endpoints. Rotating the secret invalidates issued
tokens. Installation identity proves continuity, not a distinct human user.
The daemon's registry sync uploads closed UTC hours from its
bounded diagnostics store, catching up at most seven days. The fleet upload
honors `GRUNT_FLEET_REPORTING=0`, `GRUNT_SETUP_NO_DATA_SHARING=1` and custom
registry destinations. Offline, unenrolled and earlier clients have unknown coverage.

The scheduled reader uses its existing admin read bearer on
`GET https://milo-gateway.fly.dev/admin/api/fleet-audit?day=YYYY-MM-DD`
(the custom API domain uses the same path). The date defaults to yesterday UTC.
Failure and slow-success comparisons apply the audit day's per-installation
denominator shares to both windows. A contributing installation with no baseline
denominator makes that metric ineligible. Raw counts remain visible alongside
the adjusted rate. Match each returned handle against existing #grunt work, including completed work,
before creating a backlog item. Store the confirmed Beeline ID against the handle.
Build and run `node scripts/fleet-report.mjs YYYY-MM-DD audit.json items.json report.html`
with that handle-to-ID JSON object. Use `--plan` in place of the output filename
to group evidence by stable handle. Only entries with a null work ID need
reconciliation and creation; persist each confirmed mapping before continuing. For unavailable data pass a dash for both input
files. The top-ranked handle is the default for a human reply of go.
