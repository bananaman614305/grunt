# ADR-016: Browser automation as a Jev decision layer

Status: accepted (v0 foundation), 2026-09-18. Builds on ADR-005 (Jev-only
routing), ADR-013 (agentic gates), and ADR-015 (the worker fleet, whose
"capability, not orchestrator" shape this mirrors). New package
`packages/browse`; no change to `packages/core/src/types.ts`.

## Context

Browser automation is the next capability a frontier agent wants to fan work
out to. The hard part is not the clicking — Playwright, Puppeteer, CDP, and
hosted operate services all click well. The hard part is the *senses*: given a
page, what kind of page is this, which element serves the goal, is this a wall
a human must clear, is this action irreversible, and did the last action work?
Those are classification questions, and Milo already holds a calibrated, cheap
classifier — Jev — and a habit of asking it content-free questions.

Two failure modes shape the decision. First, "Milo grows a browser": Milo
ships or forks a browser tool and becomes a second Playwright. That is a large,
undifferentiated surface Milo would maintain forever, and it duplicates tools
that already exist. Second, the privacy hole: the naive way to classify a page
is to feed its HTML or a screenshot to a model. That drags raw page content —
and any credential typed into it — through the classifier.

## Decision

Milo's contribution to browser automation is the **Jev decision layer** — the
cheap, calibrated senses — while the actual clicking is done by a **pluggable
driver** — the muscle. Milo ships no browser and forks no third-party tool.

The contrast is the whole design (as with ADR-015). The user's frontier agent
(or a fleet worker) stays in charge: it decides what goal to pursue, reads the
result, and decides the next move. `runBrowseTask` is a capability it delegates
one bounded objective to. Milo supplies the gates; the driver supplies the
muscle; the caller supplies the judgment and any secret field values.

### The pluggable driver (the muscle)

A `Driver` is an INTERFACE with four methods — `navigate`, `click`, `type`,
`readback` — not a browser Milo owns. Three implementations back it behind the
same interface:

- **`PlaywrightDriver`** (the default, `playwright-driver.ts`) — a
  Playwright-over-CDP session the operator already runs. Playwright is an
  optional peer the caller installs; the import is dynamic and untested glue.
- **a Squire-operate adapter** — Trusty Squire already exposes
  observe/act/verify tools over a hosted browser and can seal credentials into
  a page. An adapter maps `readback`→operate_observe, `click`/`type`→
  operate_act. Milo does **not** fork Squire; it would call it behind the
  interface. Described here, not implemented in v0.
- **a computer-use adapter** — a screenshot+mouse agent whose accessibility
  tree is reduced to the same content-free candidate list.

The interface's hard rule: the driver hands *up* only a `PageObservation` —
url, title, and a content-free `ElementCandidate` list (role, short label,
optional testid, bbox). It never surfaces raw DOM or a screenshot, so raw page
content cannot reach a gate by construction (`PageObservation` has no `html`
field to put it in).

### The five gates (the Milo-native value)

Each gate is one pure function = one `/v1/systemone` call over a compact,
content-free state, written in the router's `questions.ts` style
(`packages/browse/src/questions.ts`, `gates.ts`):

- **`observe`** (**choice**) → page kind `login | form | dashboard | result |
  error | captcha | consent | other`, with confidence.
- **`locate`** (**choice** over candidate ids + a reserved `__none__`) → which
  element best serves the goal, with confidence. Low confidence and abstention
  are surfaced so the caller can escalate rather than guess.
- **`verify`** (**noul**) → did the action achieve intent? Confidence is how
  decisive the verdict is.
- **`gate`** (**noul**) → is this a captcha / 2FA / consent wall a human must
  clear?
- **`sensitive`** (**noul**) → the **safety gate**: is this action
  irreversible, money-moving, or destructive enough to need human confirmation
  first?

Every gate sends only the compact candidate list (role/label/testid/bbox), the
goal string, url, and title. **Never** raw HTML, **never** a screenshot,
**never** the text typed into a field. `candidateSummary` is the one element
serialiser and it has no field that could carry markup or a value.

### The safety gate

`sensitive` runs before every action. When it fires, the loop pauses via
`onNeedsHuman` *before* touching the element — a transfer, a delete, an
irreversible send never happens without a person confirming. This is separate
from `gate` (a wall the page puts up) because a dangerous action can sit on an
ordinary, fully-automatable page.

### The loop and the trace

`runBrowseTask` loops observe → (done?) → gate → locate → sensitive → act →
verify, pausing for a human on a wall or a sensitive action, escalating on low
confidence or a repeatedly failed verify, and stopping when the page-kind
satisfies the goal. It is pure over its injected `driver` and `jev`. It records
a **content-free trace**: page-kinds, action kinds and opaque refs,
gate/sensitive verdicts, confidences — never a url, an element label, a
screenshot, or a typed value. Field values the caller supplies for `type` flow
straight into the driver and are never sent to a gate or written to the trace.

### Surface

One MCP tool, `browse_task` (`mcp.ts`), is the frontier agent's whole
interface, same "capability, not agent" contract as the fleet. Its schema takes
input *key names*, never values; the host binds them to sealed credentials. The
MCP server *transport* is a documented stub in v0.

## Rejected: "Milo grows a browser"

Milo ships or forks a browser and maintains a full automation tool. Rejected:
it is a large undifferentiated surface that duplicates Playwright/Squire, and
it buys nothing Milo is uniquely good at. Milo's edge is the calibrated
classifier and the content-free discipline, not the clicking. Keeping the
driver pluggable lets the muscle be whatever the operator already trusts.

## Scope and honesty

**v0 foundation.** Real and unit-tested with fakes: the driver interface and
`FakeDriver`, the five gates and their questions, the task loop and its
content-free trace, and the MCP handler. *Not* exercised by `pnpm test`, by
design: `PlaywrightDriver` (`playwright-driver.ts`) and the CLI (`cli.ts`) —
the live glue that drives a real browser and calls the real Jev API.

Deliberate v0 limits: the loop's moves are click and type-a-supplied-value; it
does not free-form fill forms with invented data, plan multi-tab flows, or act
on a verdict beyond pausing/escalating. Login credentials are supplied by the
caller (ideally sealed via Squire), never invented or logged.

**Cost is the honest caveat.** Each decision is one Jev call; a step can spend
up to five (observe, gate, locate, sensitive, verify). Jev calls are cheap and
calibrated — that is the point — but the browser/driver is the real resource,
and a long task is many gate calls. A horizon optimization is to skip gates
that a cheaper signal already settles (only `gate` when the page-kind looks
like a wall, only `sensitive` before a committing action).

## Post-launch horizon

Not in v0: the Squire-operate and computer-use adapters themselves; acting on a
verdict automatically; multi-tab / multi-page flows; a live MCP transport;
folding gate calls together into one multi-question `/v1/systemone` call to cut
per-step cost. These wait until the foundation has run against a real browser.
