# Router

The registry lists every free route Grunt knows, ranked by the daily scout.
The daemon opens routes greedily from that list, best-rated first, until it has
`MAX_OPEN_ROUTES` (N = 6) open. Once any tool-capable route is open, it drives
the signups for the rest. Every request records success, failure and latency
per route. The router turns that record into a score and a back-off, and
retires a route that keeps failing. Every six hours the daemon re-reads the
registry and runs the same pass again. This reuses `StickyRouter`,
`SourceStatus`, `RegistrySync`, `SourceRecovery` and `setupFallbacks`. There is
no new service.

## 1. Greedy first pass, driver, cap

- **Order.** Each pass takes the registry's adapters that Grunt ships, sorted
  by `fit` (`great`, then `possible`), then by `weight`. It skips adapters
  that are disabled, retired, already open, or rated `poor`.
- **Consent.** A provider with a data-sharing policy is attempted only when
  its consent receipt is already recorded. This is the existing
  `readDataSharingConsent` check. The pass adds no other approval step. The
  registry is the vetted list.
- **Cap.** A route is *open* when its source reports `available()` and the
  router has not retired it. The pass runs signups one at a time and stops as
  soon as N routes are open. So the cap holds even when the registry lists
  more than N routes (test: "stops at N = 6 open routes when the registry
  lists more"). A pass also makes
  at most N signup attempts. Untried candidates come first; failed candidates
  rotate to the end after each attempt, so repeated failures can't starve the rest.
- **Driver.** Before each signup, the pass checks for an open tool-capable
  route. If there is one, it hands Squire a fallback operator: the first coding
  harness found on `PATH` (Pi, Codex, OpenCode, Claude Code), pointed at the
  local `grunt` model. Otherwise Squire's drive runs alone. So the first route
  that signs up becomes the driver for the rest. A registry-flagged route that
  is already open is ranked first, so it drives from the start.
- **Best route, not first.** The driver asks for model `grunt` and carries
  tools. The router therefore sends each turn to the best-scoring open
  tool-capable route. A newly opened, better route takes over on the next
  task. In setup, the anonymous OpenCode operator is replaced as soon as an
  account route passes the tool-call probe.
- **Driver failure.** If the driver's route is benched or retired mid-signup,
  the sticky router hands the same task to the next eligible tool-capable
  route, with the usual handoff prompt. If none is left, the harness fails with
  `quota exhausted`, that signup drops, and the next signup in the pass runs
  without a driver (test: "hands the driver's task to the next tool-capable
  route when its bound route is retired").

## 2. Score, back-off, retirement

- **Score.** Each success or failure updates the route's reliability, latency
  and failure cost in `SourceStatus`, and this persists in routing history.
  The weighted draw uses `registry weight × routingWeight` (existing code).
- **Back-off.** On a failure, the route is benched for 15 minutes. Each
  repeat of the same failure within 6 hours of the previous one doubles the
  bench, up to a ceiling of 2 hours. A quota failure uses the provider's reset
  time instead.
- **Retirement.** On the **5th consecutive identical failure**, each within
  6 hours of the last, the route is retired. Quota failures never count
  toward this. A retired route gets no traffic, including explicitly named
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
- OpenCode's free-limit signal fails fast as a quota error, and that cools
  down the whole OpenCode pool.
