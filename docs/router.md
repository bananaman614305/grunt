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
disable background account acquisition after registry syncs and request
failures. Registry refresh, automatic source discovery, routing, existing
provider access and daily health checks continue. Explicit foreground
`usegrunt setup` and `usegrunt add` keep their normal behavior. The default
enables acquisition; the legacy `MILO_BACKGROUND_ACCOUNT_ACQUISITION` alias is
accepted, with `GRUNT_*` taking precedence.

## 1. Greedy first pass, driver, cap

- **Order.** Each pass takes the registry's adapters that Grunt ships, sorted
  by `fit` (`great`, then `possible`), then by `weight`. It skips adapters
  that are disabled, retired, already open, or rated `poor`.
- **Consent.** A provider with a data-sharing policy is attempted only when
  its consent receipt is already recorded. This is the existing
  `readDataSharingConsent` check. The pass adds no other approval step. The
  registry is the vetted list.
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
  until its timeout fails that signup and does not switch drivers; other
  errors and cancellation do not move it either. If no candidate succeeds,
  that attempt fails and driver selection runs again before the next
  signup. Foreground setup tries the remaining free-model drivers on the same
  signup. An unavailable routed driver or exhausted free-model chain instead
  defers the failed signup, switching drivers before subsequent signups and the
  deferred retry pass.

## 2. Score, back-off, retirement

- **Score.** Each success or failure updates the route's reliability, latency
  and failure cost in `SourceStatus`, and this persists in routing history.
  The weighted draw uses `registry weight × routingWeight` (existing code).
- **Back-off.** Upstream failures, timeouts and refusals normally bench the
  route for 15 minutes. Each identical repeat within 6 hours doubles that
  delay, up to 2 hours. An invalid function-call response starts at 30 seconds
  instead. Explicit HTTP 5xx retry hints bypass multiplication and are bounded
  to 1 second–24 hours. Quota failures use the provider's reset time instead;
  successful recovery preserves that quota deadline. Missing installations
  and expired logins stay barred until a successful health check.
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
  - a newer registry publication that still lists it;
  - a restart more than 6 hours after its last failure, because history keeps
    back-offs for 6 hours.

## 3. Slow loop, hot-add and scout mapping

- **Loop.** `RegistrySync` fetches the registry every `REGISTRY_INTERVAL`
  (6 h, aligned to UTC midnight), keeping the ETag and the newer-publication
  rule. After each fetch it starts one acquisition pass. So do the earlier
  recovery triggers: quota, logged-out and not-installed failures. Only one
  pass runs at a time, and none runs while foreground `usegrunt setup` holds
  its session.
- **Hot-add.** In the automatic pool, a newly listed adapter that Grunt ships
  becomes a routable source at once, with no restart. A manual `GRUNT_SOURCES`
  list stays fixed.
- **Scout to registry.** The daemon never reads the scout's sheet. The scout,
  or a small publish step, writes three optional fields per adapter into
  `registry/adapters.json`, then publishes as today:

| Scout column | Registry field | Effect in the daemon |
|---|---|---|
| Fit Great / Possible / Poor | `fit: "great" \| "possible" \| "poor"` | Great and Possible are opened, in that order. Poor routes are never opened, but still route if already open. A missing `fit` counts as Possible. |
| Status Active / Expiring soon / Inactive | `status: "active" \| "expiring" \| "inactive"` | Expiring and Inactive retire the route and are never opened. A missing `status` counts as Active. |
| Expiry date | `expires: "YYYY-MM-DD"` | After that UTC day, the route counts as Inactive. |

An offering with no Grunt adapter is a "needs adapter" signal for the scout's
release pipeline (`ops/provider-scout`). Adapters still ship by release. The
router ignores registry ids that no shipped adapter matches, so the daemon
skips them.

## Operator fixes in this change

- The fallback operator may type or pass only values Grunt supplies: the plan
  (`free`), the key or project name (`grunt`), and the Squire-connected email.
- Once Squire reports a signup complete, every later operator tool call gets
  a final "finished, stop" reply instead of a replay of the stale page.
- OpenCode free-limit handling is described in the
  [OpenCode reference](reference.md#opencode-app-driver).
