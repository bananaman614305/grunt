# Milo browser automation

Milo browse is a capability your frontier agent (or a fleet worker) **calls** to
drive a web page toward a goal. It is not an agent of its own, and it is not a
browser. See ADR-016 for the decision record; this is the working guide.

## What it is

Milo's contribution to browser automation is the **decision layer** — cheap,
calibrated Jev "senses" that tell an automation what it is looking at and what
to do next — while the actual clicking is done by a **pluggable driver**, the
muscle. Milo ships no browser and forks no third-party tool.

```
  your frontier agent
        │  goal ("export last month's report")
        ▼
  runBrowseTask ──▶ Jev gates  (observe · locate · verify · gate · sensitive)
        │                 the SENSES  (Milo's value)
        ▼
     Driver     ──▶  Playwright / Squire-operate / computer-use
                       the MUSCLE  (pluggable, not Milo's)
```

The frontier agent stays in charge: it picks the goal, reads the result, and
decides the next move. Milo supplies the gates; the driver supplies the muscle;
you supply the judgment and any secret field values.

## The pluggable driver

A `Driver` is an interface with four methods — `navigate`, `click`, `type`,
`readback` — not a browser Milo owns. Any of these can back it:

- **Playwright over CDP** (the default, `playwright-driver.ts`) — a Playwright
  session you already run. Playwright is an optional peer you install; Milo does
  not bundle it. This is documented glue, not exercised by the test suite.
- **Squire operate** — Trusty Squire exposes observe/act/verify tools over a
  hosted browser and can seal credentials into a page. An adapter maps
  `readback`→operate_observe and `click`/`type`→operate_act. Milo would *call*
  Squire behind the interface; it does not fork it.
- **computer-use** — a screenshot+mouse agent whose accessibility tree is
  reduced to the same content-free candidate list.

The interface's hard rule: the driver hands **up** only a `PageObservation` —
url, title, and a content-free `ElementCandidate` list (role, short label,
optional testid, bbox). It never surfaces raw DOM or a screenshot. Whatever
`readback` returns is what a gate may see, so the reduction to a candidate list
*is* the privacy boundary. `PageObservation` has no `html` field to smuggle
markup through.

## The five gates

Each gate is one pure function and one `/v1/systemone` call over a compact,
content-free state, written in the router's `questions.ts` style. This is the
Milo-native value.

| gate        | question type | answers                                             |
|-------------|---------------|-----------------------------------------------------|
| `observe`   | choice        | page kind: login/form/dashboard/result/error/captcha/consent/other + confidence |
| `locate`    | choice        | which candidate id best serves the goal (or `__none__`) + confidence |
| `verify`    | noul          | did the action achieve intent? + confidence         |
| `gate`      | noul          | is this a captcha / 2FA / consent wall for a human?  |
| `sensitive` | noul          | is this action irreversible / money-moving / destructive? |

Every gate sends only the compact candidate list (role/label/testid/bbox), the
goal string, url, and title — **never** raw HTML, a screenshot, or the text
typed into a field.

## The safety gate

`sensitive` runs before every action. When it fires — a transfer, a delete, an
irreversible send — the loop pauses through `onNeedsHuman` **before** touching
the element, and the caller confirms (or not). It is separate from `gate`: a
`gate` is a wall the page puts up (a captcha), a `sensitive` action is a
dangerous move that can sit on an otherwise ordinary, automatable page.

## How a frontier agent (or fleet worker) uses it

Call the `browse_task` MCP tool (or `runBrowseTask` directly) with a goal and a
step cap. Provide a `Driver` bound to your browser session. Read the returned
status and content-free trace, then decide the next move:

- `done` — the page-kind satisfied the goal.
- `needs_human` — paused on a wall (`gate`) or a sensitive action; your hook
  fired. Clear it (solve the captcha, confirm the payment) and call again.
- `escalated` — the loop was not confident enough to act (low `locate`
  confidence, no matching candidate, or a repeatedly failed `verify`). Take
  over or refine the goal.
- `max_steps` — hit the step cap.

Credentials: pass field values in `inputs` keyed by testid or ref (via the MCP
tool, declare `inputKeys` and let the host bind them to sealed Squire
credentials). Milo types them straight into the page. They are **never** sent to
a gate and **never** written to the trace. Milo never invents field values.

A fleet worker (ADR-015) can call `browse_task` exactly as the frontier agent
does — browse is just another capability in the worker's tool list.

## v0 limits

- The loop's moves are click and type-a-supplied-value. It does not free-form
  fill forms with invented data, plan multi-tab flows, or act on a verdict
  beyond pausing/escalating.
- `PlaywrightDriver` and the CLI are live glue, not covered by `pnpm test`. The
  Squire-operate and computer-use adapters are described, not implemented.
- The MCP server transport is a documented stub (`describeMcpServer`); bring
  your own JSON-RPC transport and forward the call to the handler.

## Cost

Each decision is one Jev call; a single step can spend up to five (observe,
gate, locate, sensitive, verify). Jev calls are cheap and calibrated — that is
the whole point — but the **browser/driver is the real resource**, and a long
task is many gate calls. If cost matters, skip gates a cheaper signal already
settles (only `gate` when the page looks like a wall, only `sensitive` before a
committing action), or fold the per-step questions into one multi-question call
(a horizon item).

## CLI

`milo-browse` dry-runs the gate layer against a scripted page (a browse
counterpart to `milo explain`), so you can see what the gates decide without a
browser:

```
JEV_API_KEY=... milo-browse --goal "export the report" --screens page.json --max 6
milo-browse --describe        # print the browse_task MCP tool stub
```

`page.json` is `{ "screens": [ { "url": "...", "title": "...", "elements": [...] } ] }`.
