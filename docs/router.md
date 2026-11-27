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
enables acquisition.

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
- **Idle first.** A first draw and a fallback (the bound source failed or is
  benched) prefer routes with no active request and use a busy route only when
  no idle one is eligible. Both wait for pending admission checks of sources that
  would join the draw (each check bounded at five seconds) before sharing a busy
  route; a first draw waits at most `FIRST_DRAW_IDLE_WAIT_MS` (3 s) in total, and
  a pending check of a bridged source does not hold a tools request. A healthy
  bound task keeps its route even when it is busy and never waits. Admission
  checks are cached for 30 s and start only while a request is routed, at most
  four at a time, most promising first (answered positively most recently, then
  never checked, then last denied), so parallel subagents that start on a cold
  or half-expired cache still spread. A draw claims its route in the same
  tick, before any await (the fallback handoff runs git status and diff) and
  until the attempt ends, so tasks starting together spread over distinct idle
  routes; with fewer idle routes than tasks the rest share as before. The claim
  is released when the attempt succeeds, fails or is cancelled, or the selection
  is dropped.
- **Stalled inference.** An automatic inference request that stays silent for
  eight seconds may race one idle backup with fresh positive availability in
  the same tool draw tier. Both routes retain their dispatch and consent
  guards. The first valid stream text or completion binds the task. Grunt
  cancels the other attempt without counting a failure. Named sources and
  agents that may perform local work keep a single attempt.
- **Native tool sources first.** For a request with function tools that names no
  source, a first draw and a fallback pick among the eligible sources that call
  tools through the provider's own interface before any JSON-bridged source
  (`mistral-vibe`, `perch`, `pollinations`; a source marks itself with
  `jsonToolBridge`). The bridged model is only told in prose to answer with a tool
  envelope, and one declined to use the Agent tool, so it serves tool work only
  when no native source is eligible: all are benched, limited, unavailable or
  already tried by this call. A bridged-only pool works as before. When a bridged
  source is ready but a native tool source's admission check is still running,
  the draw waits for that check (bounded like any admission check). Only the draw
  set narrows, in the tier order idle native, busy native, then bridged. Weights,
  scores, consent, quota and cooldown are unchanged, and the weighted draw inside the
  chosen set is the same. The 0.10.5 and 0.10.6 spreading holds: parallel subagents
  each claim a distinct idle native source. With more subagents than idle native
  sources the rest share busy native sources (as the idle-first rule already shared
  busy routes) and do not move to an idle bridged one; a native source that is
  limited by that load returns 429, is benched and the fallback reaches the next
  native source, then a bridged one. A task already bound to a bridged source keeps
  it while it answers: it is mid-session, a switch costs a handoff for no
  observed failure, and the bridged route has already returned valid envelopes for
  that task. It leaves only when it fails (or by the usual performance switch).
  Text-only requests, explicit source selection and routes with no tool support
  are unaffected. The switch is the `NATIVE_TOOL_SOURCES_FIRST` constant in
  `src/local/routing.ts`.
- **Images.** Grunt forwards no image data to any source, and a request that
  holds an image can only go to an adapter whose registry entry lists `image`
  (none of the free pool does). When no source could take it, the local API
  replaces each image block, including one inside a tool result and any in the
  conversation history, with a short note such as `[image omitted (image/png,
  3 bytes): no free source on this route accepts images; inspect it with tools
  instead]`, then routes the request as text. Only the media type and decoded size
  appear, never the data, a URL or a path, and the same image always gives the
  same note, so the task key and caches do not move. A conversation poisoned by an
  earlier image recovers on its next request. The image is kept, and the request
  routed as sent, when an eligible adapter lists image input: for a tools request
  one that is tool-capable, for an explicit model the named source. An
  image-capable source that is benched for no more than five minutes
  (`IMAGE_WAIT_SECONDS`) still counts, so the answer is a true 429 with its retry
  time. Beyond that it is not worth holding the conversation for it and the image is
  replaced. If a request with an image still reaches the router and no source lists
  image input, the answer is an invalid-request error (HTTP 400) that names the
  modality, not a quota error.
- **Back-off.** Upstream failures, timeouts and refusals normally bench the
  route for 15 minutes. Each identical repeat within 6 hours doubles that
  delay, up to 2 hours. An invalid function-call response starts at 30 seconds
  instead. Explicit HTTP 5xx retry hints bypass multiplication and are bounded
  to 1 second–24 hours. Local request-shape refusals (`failureReason`
  `request_*`: unsupported tools, a tool schema or tool conversation the
  adapter refused before any provider was reached) set no back-off at all. A source
  uses a five-minute base for gateway errors (HTTP 502, 503, 504, 524),
  connection resets/timeouts, cut streams and output deadlines. MillionSeek
  uses a thirty-minute base. Consecutive outages double that delay up to two
  hours. A parallel failure inside the delay does not extend the slow cooldown.
  Alternating outage symptoms share one retirement streak. Invalid function
  calls have their own escalating tool hold. Text successes preserve it until
  a tool turn succeeds or a synthetic function probe returns the requested valid call.
  An overlapping outage or quota hold keeps its own deadline. Text turns can
  resume when that deadline passes while tool turns still await tool recovery. Quota failures use the provider's reset time instead;
  successful recovery preserves that quota deadline. Missing installations
  and expired logins stay barred until a successful health check.
  On the first upgrade to Kilo's free-model rotation, routing history clears
  the legacy Particle-only Kilo quota hold so other free models can be tried.
  Other holds and subsequent quota holds from exhausting the pool persist.
- **Retirement.** On the **5th consecutive failure of the same class**, each within
  6 hours of the last, the route is retired. Quota failures never count
  toward this, and neither do local request-shape refusals or hinted server errors
  outside the outage class. Gateway outages count even with a Retry-After hint. Identical
  non-quota failures still count during a quota hold. A retired route gets no
  traffic, including explicitly named requests, until it reopens (below),
  doesn't count as open (so the next pass opens a replacement), and isn't
  re-signed up.
- **Return.** Four things bring a retired route back:
  - maintenance can check the route when its cooldown expires, under the same
    cross-process lock and quiet gap as daily checks. A due retired route may
    take a single live trial when no other eligible route remains. Success
    clears retirement. Failed trials double the reopen delay up to four hours,
    with a minimum of the applicable slow-upstream cooldown;
  - a successful reply, which includes the daily access check (that check
    probes the source directly);
  - a newer registry publication that changes its entry (a weight-only change
    does not count, because every registry write rescales its tier);
  - a restart more than 6 hours after its last failure, because history keeps
    back-offs for 6 hours.

## 3. Slow loop, hot-add and scout mapping

- **Loop.** `RegistrySync` fetches the registry every `REGISTRY_INTERVAL`
  (6 h, aligned to UTC midnight), keeping the ETag and the newer-publication
  rule. After each fetch it starts the [route feedback exchange](#4-route-feedback)
  without waiting for it, and starts one acquisition pass. So do the earlier
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
- **Hot-add.** In the automatic pool, a newly listed shipped or declarative
  (`install: "declarative:openai"`) adapter becomes a routable source at once,
  with no restart. A manual `GRUNT_SOURCES` list stays fixed.
- **Scout to registry.** The daemon never reads the scout's sheet. The scout,
  or a bot following `GET /v1/registry/instructions`, writes three optional
  fields per adapter through the registry API (`PUT /v1/registry/entries/{id}`;
  see [reference](reference.md#sources-and-app-sessions)):

| Scout column | Registry field | Effect in the daemon |
|---|---|---|
| Fit Great / Possible / Poor | `fit: "great" \| "possible" \| "poor"` | Great and Possible are opened, in that order. Poor routes are never opened, but still route if already open. A missing `fit` counts as Possible. |
| Status Active / Expiring soon / Inactive | `status: "active" \| "expiring" \| "inactive"` | Expiring and Inactive retire the route and are never opened. A missing `status` counts as Active. |
| Expiry date | `expires: "YYYY-MM-DD"` | After that UTC day, the route counts as Inactive. |

For an ephemeral OpenAI-compatible free API promo that requires no custom
TypeScript adapter or npm release, the scout can publish a declarative entry
directly to `adapters` with `install: "declarative:openai"`, `kind: "model"`,
`modalities: ["text"]`, a pinned `model`, public HTTPS `signup`, page-by-page
`hints`, required `expires` (`YYYY-MM-DD`), and a strictly validated
`declarative` object:

| Field | Required | Rule |
|---|---|---|
| `baseUrl` | yes | Public HTTPS origin (`https://api.example.com`) with no path, custom port, credentials, query, fragment, IP literal, loopback, link-local, RFC1918, or `.local`/`.internal` host. |
| `apiPath` | yes | Normalized path starting with `/` (e.g. `/v1/chat/completions`), no `..`, `//`, query, or control characters. |
| `zeroPriceCheck` | yes | `"models_catalog"` (live `GET modelsEndpoint` check requiring exact pinned model with zero pricing before every dispatch) or `"none"`. |
| `modelsEndpoint` | with `models_catalog` | Normalized path starting with `/` (e.g. `/v1/models`). |
| `stream` | no | Boolean; when `true`, uses SSE transport with exact model and zero-cost checks. |
| `disclosure` | yes | Non-blank data-sharing disclosure (up to 1500 characters). |
| `policyVersion` | yes | Version tag matching `/^[A-Za-z0-9._-]{1,64}$/` (changing it invalidates older consent receipts). |
| `policyUrl` | yes | Public HTTPS URL for the provider's privacy/terms page. |
| `name` | no | Human-readable provider name (up to 100 characters). |
| `minContextLength` | no | Minimum integer context window checked against catalog metadata when `zeroPriceCheck` is `"models_catalog"`. |

Every declarative adapter enforces the same invariants as built-in adapters:
native function-tool calling, HTTPS-only pinned origin matching the Squire
grant's allowed host (or Squire's egress proxy), exact response `model`
attestation, refusal of any non-zero cost fields in catalog or usage responses,
versioned explicit data-sharing receipts, and immediate retirement when
`expires` passes or `status` becomes `expiring` or `inactive`. Arbitrary code,
shell commands, and unknown fields in `declarative` are rejected by the
validator.

An offering that needs custom client logic beyond `declarative:openai` stays a
"needs adapter" signal for the operator scout's release pipeline.
It is written to the registry's `candidates` list, which every client ignores.
Unknown `npm:*` registry ids that no shipped adapter matches are likewise
ignored by the daemon.

One more optional adapter field raises the chance that Squire's drive finishes a
signup alone. It is an add-on: the signup driver model stays the fallback.

- `hints` (up to 2000 characters): what the user sees on the provider's signup
  pages, the controls to press and the Grunt-supplied values to type (`grunt`,
  `free`, the Squire email), in order. Both `usegrunt setup` and `usegrunt add`
  read hints from the synced registry, the same source as the provider routes,
  so a registry publication updates them for every user without a release. Grunt places them in the
  `operate_drive` goal before the shared safety rules (data sharing, no paid
  plan, terms), which stay last. If the full goal would exceed the drive's
  4000-character limit, the hints are dropped for that call. A registry write
  that has a `signup` must include `hints`.

Hints match an entry by id, or by the entry's `signup` host when a setup
drives under a different vault service name.

Values named in hints or goals must also be supplied in `operate_drive` facts;
goal text alone does not authorize typing them. Grunt supplies `key_name`,
`plan` and `project_name`, with provider-specific key names taking precedence.
When a provider supplies `key_name`, both the initial drive and the signup
agent's drive use it for `project_name` too, so either name fact gives the same
value for an Alias field. Otherwise, `project_name` defaults to `grunt`.
Kenari also receives its pinned free model as the `model` fact. Each Zro key
creation attempt receives a `key_name` of the form `grunt-YYYYMMDD-HHMM`, the
UTC minute it started. When Squire returns `low_confidence` on an observed key
name, alias or label field and the provider supplied its own `key_name`, Grunt
answers an offered `key_name` fact once. If Squire instead offers the field as
a target, Grunt supplies the value under that field's label and resumes on it
once, retaining the fact across polling yields until session cleanup. Other
stops follow the [signup reporting rules](reference.md#free-api-and-account-setup).

Squire's `operate_drive` `store` (where the drive saves a key it reveals) never
comes directly from an arbitrary registry blob. Grunt derives it from the vault
service the signup checks: that service, the label (`Grunt Free` for declarative
adapters) and the validated API host its shipped or declarative source reads,
and `auth_shape` `bearer`. Without `store`, only a fallback operator's
`operate_extract` can capture the key.

## 4. Route feedback

After every registry sync, each router sends today's running totals and any
retained totals from yesterday, on by default. Acknowledged yesterday totals
are then discarded. For each listed route with recorded activity, reports contain
counts of successful replies (`ok`), upstream/timeout/refused failures (`failed`), quota failures
(`quota`), logged-out/not-installed failures (`auth`), background signup
outcomes (`signup_ok`, `signup_failed`), the smoothed success latency rounded to
100 ms, and whether the route is retired. Each report includes the schema and
client versions and UTC day. A random install id, kept in `registry-install`
(mode 0600) in the config directory, lets the registry replace a day's cumulative
totals instead of adding them. Nothing else is sent: no prompts,
responses, tool data, keys, grants, emails, provider error text, request ids,
model names, paths, hosts or IPs. Counters live in memory, so a restart loses
part of a day.

The registry turns the last 14 days into a 0–100 score per route:
reliability `(S+1)/(S+F+2)` over capped, 3-day-half-life weighted successes and
failures, times a freshness that halves every 3 days without a success. A route
with reports but no success in the window scores 0; one with no reports has no
score (`unknown`). A reported route is `live` if its last success was fewer
than three UTC days ago, otherwise `dead`, even if its score is still positive.
`GET /v1/registry/scores` serves the scores, their states and
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
