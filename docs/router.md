# Router

The registry lists free routes Grunt knows and accepts ratings from the daily scout.
The daemon opens routes greedily from that list, best-rated first, until it has
`MAX_OPEN_ROUTES` (N = 6) open. The signup driver selection and handoff rules
are described below. Every request records success, failure and latency
per route. The router turns that record into a score and a back-off, and
retires a route that keeps failing. Every six hours the daemon re-reads the
registry and runs the same pass again. This reuses `StickyRouter`,
`SourceStatus`, `RegistrySync`, `SourceRecovery` and `setupFallbacks`. There is
no new service.

Set `GRUNT_BACKGROUND_ACCOUNT_ACQUISITION=0` before starting the daemon to
disable background account acquisition for all [acquisition triggers](#3-slow-loop-hot-add-and-scout-mapping).
Registry refresh, automatic source discovery, routing, existing
provider access and daily health checks continue. Explicit foreground
`usegrunt setup` and `usegrunt add` keep their normal behavior. The default
enables acquisition; the legacy `MILO_BACKGROUND_ACCOUNT_ACQUISITION` alias is
accepted, with `GRUNT_*` taking precedence.

## 1. Greedy first pass, driver, cap

- **Order.** Each pass takes the registry's adapters that Grunt ships, sorted
  by `fit` (`great`, then `possible`), then by `weight`. It skips adapters
  that are disabled, retired, already open, or rated `poor`.
- **Consent.** Before acquiring providers, the daemon applies the default
  approval and opt-out rules in the [setup reference](reference.md#free-api-and-account-setup).
  The registry is the vetted list.
- **Cap.** A route is *open* when its source reports `available()` and the
  router permits dispatch (including registry, setup and cooldown checks).
  The pass runs signups one at a time and stops as soon as N routes are open;
  it does not close routes already opened by setup or earlier use. A pass
  also makes at most N signup attempts. Untried candidates come first; failed candidates
  rotate to the end after each attempt, so repeated failures can't starve the rest.
- **Driver.** Before each signup, the pass checks for an open tool-capable
  route eligible for the signup request. When a coding harness is installed,
  it hands Squire a fallback operator: the first harness found on `PATH`
  (Pi, Codex, OpenCode, Claude Code), pointed at the local `grunt` model.
  The first route that signs up and is eligible for the private, tool-capable signup request
  can drive the rest. An eligible route already open can drive from the start.
  After the routed driver come the free models that installed harness CLIs
  reach on their own, bypassing the router:
  - OpenCode, with current data-sharing approval and `opencode` on `PATH`, even
    when its route is not open: each non-Google free model the anonymous CLI lists
    (`opencode models opencode`), Big Pickle first and still tried if catalog
    listing fails. Discovery, probes and signups use private temporary config,
    data and state directories, with inherited `OPENCODE_API_KEY` and config
    overrides cleared. OpenCode executes its own tools rather than returning
    tool calls to another harness.
  - Pi, with `pi` on `PATH`: each `:free` or `-free` model of the person's own
    Pi providers, except loopback providers and Google models (including
    Gemini and Gemma). Pi runs from a private temporary copy of their Pi models
    file and API-key entries, without their
    extensions, sessions or MCP servers. OAuth entries are not copied, so the
    temporary driver cannot rotate their refresh tokens.
  Without a routed driver or an eligible installed harness CLI, Squire's drive
  runs alone.
  Public-only routes cannot drive private signup traffic.
- **Driver routing.** The routed driver asks for model `grunt` and carries tools.
  The router draws an eligible tool-capable route using its weights and
  observations, then keeps that task bound until a handoff is needed. Newly
  opened routes participate in later task draws.
- **Foreground setup.** With a coding harness selected, setup can use those
  free harness models even if a different harness was chosen. When no operator
  is driving, including after an operator becomes unavailable or setup
  provisions OpenCode successfully, it probes them in the order above and
  drives with the first that answers; the rest follow it. If none answers,
  Squire's drive runs alone. A missing CLI or failed probe can be reconsidered
  at these later checks. OpenCode's models require its current data-sharing
  approval, and `GRUNT_SETUP_NO_ANONYMOUS=1` disables all of them.
  The anonymous operator is replaced as soon as an account route passes the
  tool-call probe. Policy receipts follow the
  [setup reference](reference.md#free-api-and-account-setup).
- **Driver failure.** If the driver's route is benched or retired mid-signup,
  the sticky router hands the same task to the next eligible tool-capable
  route, with the usual handoff prompt. If a driver's model reports an error
  (exhausted quota or a rate limit such as 429 or 402, no available model, a
  provider 5xx or another failed request, including OpenCode's logged stream
  error), an unavailable CLI or a required sign-in, the same signup moves to
  the next candidate in the order above. A driver that made no tool call is
  replaced by a fresh start. Once one has acted, the next continues the same
  Squire browser session and is told not to start over. A driver that hangs
  until its timeout does not switch drivers; the signup continues in the same
  Squire session after outstanding operator calls finish. Operator calls run
  one at a time; the four-minute operator deadline and
  eight-round browser recovery limit still bound retries. Other errors and
  cancellation do not move it either. If no candidate succeeds, that attempt
  fails and driver selection runs again before the next
  signup. Foreground setup tries the remaining free-model drivers on the same
  signup. An unavailable routed driver or exhausted free-model chain instead
  defers the failed signup, switching drivers before subsequent signups and the
  deferred retry pass.

## 2. Score, back-off, retirement

- **Score.** Each success or failure updates the route's reliability, latency
  and failure cost in `SourceStatus`, and this persists in routing history.
  The weighted draw uses `registry weight × routingWeight × registry score
  factor`. The factor comes from the registry's liveliness score for the route
  (`GET /v1/registry/scores`, read after each registry sync): `0.5 + score/100`,
  so 0.5 at score 0, 1 at 50 and 1.5 at 100. A route with no score keeps
  factor 1.
- **Back-off.** Upstream failures, timeouts and refusals normally bench the
  route for 15 minutes. Each identical repeat within 6 hours doubles that
  delay, up to 2 hours. An invalid function-call response starts at 30 seconds
  instead. Explicit HTTP 5xx retry hints bypass multiplication and are bounded
  to 1 second–24 hours. Quota failures use the provider's reset time instead;
  successful recovery preserves that quota deadline. Missing installations
  and expired logins stay barred until a successful health check.
  On the first upgrade to Kilo's free-model rotation, routing history clears
  the legacy Particle-only Kilo quota hold so other free models can be tried.
  Other holds and subsequent quota holds from exhausting the pool persist.
- **Retirement.** On the **5th consecutive identical failure**, each within
  6 hours of the last, the route is retired. Quota failures never count
  toward this; identical non-quota failures still count during a quota hold
  and when retry hints set the delay. Later failures cannot clear established
  retirement. A retired route gets no traffic, including explicitly named
  requests, doesn't count as open (so the next pass
  opens a replacement), and isn't re-signed up.
- **Return.** Three things bring a retired route back:
  - a successful reply, which includes the daily access check (that check
    probes the source directly);
  - a newer registry publication that changes its entry (a weight-only change
    does not count, because every registry write rescales its tier);
  - a restart more than 6 hours after its last failure, because history keeps
    back-offs for 6 hours.

## 3. Slow loop, hot-add and scout mapping

- **Loop.** `RegistrySync` fetches the registry every `REGISTRY_INTERVAL`
  (6 h, aligned to UTC midnight), keeping the ETag and the newer-publication
  rule. After each fetch it sends route feedback, reads the registry scores
  (see [Route feedback](#4-route-feedback)) and starts one acquisition pass. So do the earlier
  recovery triggers: quota, logged-out and not-installed failures. So does a
  route leaving the open set (an observed availability loss, bench, quota hold,
  retirement or bar) when
  fewer than 2 routes remain open, if a candidate remains whose signup has
  not failed since the last registry fetch. Successful signups remain eligible
  for reacquisition. A pass never starts another; failed signups wait for the
  next fetch unless a request-failure trigger retries them. Only one
  pass runs at a time, a trigger during a pass joins it, and none runs while
  foreground `usegrunt setup` holds its session. After the
  [setup flow](reference.md#free-api-and-account-setup) releases its session,
  the daemon's next read of the
  session (setup makes one status read) starts a pass for the remaining
  signups. The route a pass is signing up shows as connecting in status.
- **Hot-add.** In the automatic pool, a newly listed adapter that Grunt ships
  becomes a routable source at once, with no restart. A manual `GRUNT_SOURCES`
  list stays fixed.
- **Scout to registry.** The daemon never reads the scout's sheet. The scout,
  or a bot following `GET /v1/registry/instructions`, writes three optional
  fields per adapter through the registry API (`PUT /v1/registry/entries/{id}`;
  see [reference](reference.md#sources-and-app-sessions)):

| Scout column | Registry field | Effect in the daemon |
|---|---|---|
| Fit Great / Possible / Poor | `fit: "great" \| "possible" \| "poor"` | Great and Possible are opened, in that order. Poor routes are never opened, but still route if already open. A missing `fit` counts as Possible. |
| Status Active / Expiring soon / Inactive | `status: "active" \| "expiring" \| "inactive"` | Expiring and Inactive retire the route and are never opened. A missing `status` counts as Active. |
| Expiry date | `expires: "YYYY-MM-DD"` | After that UTC day, the route counts as Inactive. |

An offering with no Grunt adapter is a "needs adapter" signal for the scout's
release pipeline (`ops/provider-scout`). It is written to the registry's
`candidates` list, which every client ignores. Adapters still ship by release.
The router ignores registry ids that no shipped adapter matches, so the daemon
skips them.

One more optional adapter field raises the chance that Squire's drive finishes a
signup alone. It is an add-on: the signup driver model stays the fallback.

- `hints` (up to 2000 characters): what the user sees on the provider's signup
  pages, the controls to press and the Grunt-supplied values to type (`grunt`,
  `free`, the Squire email), in order. Setup reads hints from the synced
  registry, the same source as the provider routes, so a registry publication
  updates them for every user without a release. Grunt places them in the
  `operate_drive` goal before the shared safety rules (data sharing, no paid
  plan, terms), which stay last. If the full goal would exceed the drive's
  4000-character limit, the hints are dropped for that call. A registry write
  that has a `signup` must include `hints`.

Hints match an entry by id, or by the entry's `signup` host when a setup
drives under a different vault service name.

Squire's `operate_drive` `store` (where the drive saves a key it reveals) never
comes from the registry. Grunt derives it from the vault service the signup
checks: that service, the label and API host its shipped source reads, and
`auth_shape` `bearer`. Without `store`, only a fallback operator's
`operate_extract` can capture the key.

## 4. Route feedback

Each router sends the registry one small report per UTC day after every
registry sync, on by default: for each listed route, counts of successful
replies (`ok`), upstream/timeout/refused failures (`failed`), quota failures
(`quota`), logged-out/not-installed failures (`auth`), background signup
outcomes (`signup_ok`, `signup_failed`), the success latency rounded to 100 ms,
and whether the route is retired. A random install id, kept in
`registry-install` in the config directory, lets the registry replace a day's
cumulative totals instead of adding them. Nothing else is sent: no prompts,
responses, keys, provider error text, model names, paths or hosts. Counters live
in memory, so a restart loses part of a day.

The registry turns the last 14 days into a 0–100 score per route:
reliability `(S+1)/(S+F+2)` over capped, 3-day-half-life weighted successes and
failures, times a freshness that halves every 3 days without a success. A route
with no success in the window scores 0 (`dead`); one with no reports has no
score (`unknown`). `GET /v1/registry/scores` serves the scores, their states and
sample counts, and the daemon feeds them into the weighted draw (§2).

## Operator fixes in this change

- The fallback operator may type into any observed field except a password or
  passcode field, and its `operate_drive` facts pass through except password or
  passcode facts; Grunt's own facts win. It can also solve a CAPTCHA, navigate
  to a web page, press a key and sign in with Google or GitHub OAuth. Raw vault
  access, payment, upload, dialog and inbox tools stay out of its reach. Drive
  answers and direct click/select choices retain payment and existing-key-change
  label filters.
- Once Squire reports a signup complete, every later operator tool call gets
  a final "finished, stop" reply instead of a replay of the stale page.
- OpenCode free-limit handling is described in the
  [OpenCode reference](reference.md#opencode-app-driver).
