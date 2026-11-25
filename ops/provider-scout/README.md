# Maintainer provider scouting

This operator-only job runs on Chad **every four hours** (01:00, 05:00, 09:00, 13:00, 17:00 and 21:00 America/New_York).
The server timezone follows Eastern daylight saving changes. It searches the
internet for additional recurring free providers, qualifies them and can release
successful integrations through the supervised pipeline below. It is separate
from the daemon's daily maintenance checks and is not installed on users'
machines by `npx usegrunt`. Scouting and npm publication run on Chad. Normal
GitHub Actions CI runs only after the Grunt repository is public.

The job uses the operator's existing Codex ChatGPT sign-in and live web search;
subscription usage and limits still apply. Trusty Squire handles eligible free
account signup and vaulted access. The [policy](POLICY.md) requires current
primary sources, recurring free access, at least 200,000 usable input tokens
(198,000 for the approved 100milionseek DeepSeek V4.1 Flash free route), and
DeepSeek V4.1 Flash, GLM 5.3 Flash or verified comparable or better coding quality.
One-time credits, restricted affiliations, mandatory payments, SMS or Discord
onboarding do not qualify. Data sharing must be disclosed and retain Grunt's
provider-specific consent. Ordinary retention, training, staff review or unknown
ZDR guarantees alone do not disqualify a free source. The absence of a free-route
ZDR catalog flag establishes no privacy promise or incompatibility by itself.
Alan's standing approval covers bounded synthetic qualification under those
ordinary conditions; stronger explicit conditions beyond that approval need a
specific human decision.

## Install and run

From the checkout on Chad:

```sh
python3 ops/provider-scout/scout.py install --source-repo "$PWD"
usegrunt-scout status
usegrunt-scout run --smoke  # live research only
usegrunt-scout run          # qualification and configured supervised pipeline
```

The supervisor requires Linux, Python 3.11 or later, Node 22 or later, Git,
the signed-in Codex CLI and bubblewrap for isolated candidate checks/probes.
Release additionally uses the authenticated GitHub CLI and protected Squire
publisher access. These are operator prerequisites, separate from user setup.
The canonical repository is `bananaman614305/grunt`; installation records this
identity in the private supervisor configuration.

Installation copies the trusted runner, policy, schemas and pipeline modules to
`~/.local/lib/usegrunt-scout`, creates a separate scout-owned checkout and adds
one marked block to the existing crontab. It verifies the server timezone and
keeps a private crontab backup. Reinstalling replaces this job's block and
preserves other projects' jobs and the scout's private release configuration.

Automatic release requires `release_enabled: true` in the supervisor's private
`~/.local/state/usegrunt-scout/config.json`, a working sandbox toolchain and a
successful npm publisher authentication preflight. The npm credential is referenced through Squire;
never place its value or vault reference in public reports or repository files.
A research or integration result alone does not enable release. Missing
publisher access or approval blocks promotion rather than silently skipping a
gate.

## Qualification and release

1. **Discover and qualify.** Every run performs live web research, deduplicates
   provider/model offers and resumes promising pending work. Official sources
   must establish the exact model, context, recurring entitlement, limits,
   signup requirements and data policy. Full runs can prepare any number of
   qualifying candidates within the time budget. Smoke runs stop at research.
2. **Reuse access or sign up.** The constrained Squire proxy permits
   service-filtered account metadata and supported browser/signup operations.
   Only metadata lookup is preapproved; other actions retain automatic approval
   review. Keys and credential-bearing grants stay in the trusted backend,
   outside model output. Reuse existing accounts and pending Squire workflows.
   The proxy's `scout_install_grant` helper checks the exact service/reference
   and installs a native API-adapter config under `workspace/candidate-configs`;
   its result contains only the relative config path and installation status.
3. **Implement in isolation.** The worker uses an owned candidate clone and
   private configuration, preserves existing guards and integrates onboarding,
   consent, exact-model defaults and registry metadata. It prepares a clean
   commit, a newer patch version, a newer registry publication timestamp and
   preliminary hello/tool evidence bound to that commit and registry hash.
   A missing source-specific sharing policy stays integration_pending while
   the worker implements an accurate disclosure, URL and version. After that,
   the existing `recordDataSharingConsent` helper can record its fingerprint in
   the candidate's private config under the standing operator approval. Consent
   from Kilo or another source does not transfer by underlying model; an
   OpenRouter source needs its own policy. Mark a policy with
   `approval: 'explicit'` when users must opt in. The setup wizard groups
   pending explicit policies into a single prompt, and a change to one of
   those policies requires a fresh approval for that source.
   The scout never prewrites their receipts or tests with confidential code.
4. **Validate and review.** The trusted supervisor verifies the repository,
   current main base, allowed change scope, eligibility and evidence. A fresh
   read-only reviewer independently checks current provider facts, terms,
   consent enforcement and the exact code change before authorizing isolated
   checks and probes. At this stage, unrun supervisor checks are pending rather
   than failed. The reviewer checks policy/fingerprint guards in code, without
   reading private consent or credential files; the isolated source checks its
   actual consent receipt before inference. Reviewers receive no Squire access.
5. **Check and probe independently.** The supervisor runs frozen-lockfile
   installation with dependency scripts disabled, then lint, tests and build in
   a sandbox. Only installation receives network access. It independently sends
   a bounded synthetic hello and inert native tool call through Grunt to the
   exact provider in an isolated child process. The child cannot access
   supervisor state; the trusted parent writes the attestation. A fallback reply
   cannot pass. Protected evidence records the
   observations and binds them to the reviewed head and registry. Documented
   context capacity is distinct from a context length actually exercised.
6. **Review the finished result.** A second fresh read-only review checks the
   same commit after supervisor checks and trusted probing, requiring successful
   protected results and actual enforcement of the reviewed consent guard.
   Standing approval or preliminary worker evidence cannot replace those results.
   Both independent reviews must approve all model, context, free-access,
   terms, signup, consent and code-scope checks. A worker's success flags cannot
   authorize promotion.
7. **Merge and publish.** With release enabled, the supervisor verifies
   publication access and public repository visibility before pushing a candidate
   branch or opening its PR. It requires successful normal CI for the exact
   reviewed head and honors branch protection before merging through the normal
   GitHub path. Pending checks remain deferred and resume on the next pass;
   failed checks block release. The supervisor never disables Actions or bypasses
   checks with an administrator merge. It builds and publishes the
   matching npm artifact through protected Squire-backed access, then verifies
   the public package and bundled registry. Private repositories cannot start
   this CI-backed promotion path.

   The supervisor advances qualified candidates in sequence until its deadline.
   A blocked candidate leaves the others eligible. Work awaiting the supervisor
   remains in the ledger. When a merge advances main, candidates built on the
   earlier head need a rebase and fresh checks before they can proceed.

A signup, preliminary reply or locally passing test is not a release. A source
joins the automatic pool only after the protected release pipeline succeeds.
New users receive its bundled registry with the new npm release when they run
`npx usegrunt`; existing installations receive the new runtime with
`npx usegrunt update` (`npx usegrunt@latest update` for older CLIs). Normal
provider-specific setup and consent still apply. These pipeline tests do not
claim that a newly discovered real provider has passed live qualification.

## Finishing candidates

Every run reconciles the ledger with the fetched registry and the owner
decisions, then offers the qualification worker a bounded, ordered set of
offers. Trusted lifecycle code (`lifecycle.py`) owns all of this; a worker
report cannot set it, and the report schema has no `released`, `retired` or
`excluded` status.

- **Ledger-only statuses.** `released` is a source the supervisor shipped or that
  the registry lists (matching signup host and exact model); `retired` is a
  source removed from Grunt (a released row whose provider left a usable
  registry, or an operator decision); `excluded` is an owner exclusion. The
  previous status is kept as `status_before` and restored if the decision is
  lifted. Rows are re-labelled, never removed.
- **Finish lane.** Due offers are ordered furthest-along first (supervisor rework,
  then integration with an account, then other integration, setup, researched),
  and rotate by how often each was offered, so one stuck candidate cannot starve
  an equal peer. At most 2 finish, 1 verify and 6 offers in total go to the worker
  each run; new discoveries come before the backlog. Everything else stays due.
  A candidate offered six times without a returned review is parked.
- **No re-review without new evidence.** A review that changes the structured
  facts (status, setup, context, gates, sources, head, probe flags) resumes at the
  next run. Rewording prose is not evidence: an unchanged review backs off, a
  second parks the candidate for 14 days, and ten reviews park it regardless. New
  first-party change evidence from discovery reopens it.
- **Rework.** A head the supervisor blocked before promotion (validate, review,
  checks, probe) goes back to the worker (`rework` carries the safe reason, stage
  and detail) up to three times. Promotion and publication blocks, anything with a
  merge, and the safety stops (`reviewer_integration_violation`, `worker_cancelled`,
  `missing_or_writable_squire_guard`, `workspace_sandbox_preflight_failed`) are never
  sent back or retried: their own checkpoint owns them. A head superseded because
  main advanced is a rebase, counted separately (up to eight) so it does not use up
  the three. A resubmission with the same head, evidence and facts is not reviewed
  again; the stored result is returned. A flaky `local_checks_not_passed` gets one
  retry. A worker outage during a stage defers it (three strikes, then
  `stage_retries_exhausted`); a worker timeout caused by the run budget cutting the
  stage short is not a strike. After six hours an unchanged outage-blocked head is
  handed back to the supervisor (not the worker), at most three times.
- **A relabel is not eligibility.** The verify and finish lanes only ask a worker
  to bring evidence. Whatever it returns still passes `qualify()`: a failing gate is
  rejected (now verified), an unclear gate stays `researched`, and
  `ready_for_review` needs a valid, fresh, exact-head proof and release request. The
  supervisor then repeats both independent reviews, the sandboxed checks and the
  trusted probe. No lane, status or reason code lowers any of those gates.
- **Claimed or verified.** Discovery labels are claims. A label-only rejection from
  discovery (one-time credit, below baseline, high friction, context under the
  minimum) is kept as `rejected` with basis `claimed`, but is queued for the verify
  lane, which asks the worker to confirm or refute the failing gate with
  first-party evidence. Admission policy (200,000 usable input tokens, recurring
  free access, coding quality) is unchanged; only `POLICY.md` owner decisions
  change it. Unclear or unverified quality or context stays `researched` with
  `reason_codes` such as `quality_unverified`, and is retried only within the
  bounds above.
- **Safe reasons.** Supervisor results carry `stage` (validate, review_pre, checks,
  probe, review_post, promotion) and a fixed `detail`: our own worker reason or
  validation message slug, or an exception class name. Provider text, paths and
  reviewer prose are never persisted. Worker failures name their phase
  (`worker_launch_failed`, `worker_result_not_json`, `worker_result_missing`, ...).
- **Budgets.** `timeout_seconds` (new installs: 9000, never more than 10800, so a
  run cannot overlap the next four-hour cron) is split: half of the release share
  resumes earlier pending promotions, half is held for new candidates, and
  discovery (up to 600 s) and qualification (up to 2400 s) are clipped to what the
  release stages leave. A stage with less than its minimum left is skipped and
  reported (`discovery_skipped_budget`, `qualification_skipped_budget`), and no
  release candidate starts with under ten minutes left. Existing installs keep
  their configured `timeout_seconds` (2700 yields a tight plan; raise it).

`usegrunt-scout migrate [--registry PATH] [--write]` runs the reconciliation as a
dry run unless `--write`, prints before and after counts, and on `--write` copies
the ledger to `ledger.json.pre-lifecycle-<time>` (mode 0600) first. It is
idempotent and refuses to finish if a candidate row would disappear. A scheduled
run performs the same migration automatically, with one backup the first time
(an existing `pre-lifecycle` backup is reused if a run fails before saving). Only
the fetched main snapshot may retire a row; when release is disabled the scout
falls back to the working-tree registry, which can be stale, and that fallback can
mark rows released but never retired. A merged head still awaiting publication
(`publication_pending`) is not labelled released by the registry; only the
supervisor does that. An offer counts toward rotation or parking only after the
worker completed a run, so a worker outage never parks candidates it did not see.
A run that fails still rotates the offered rows behind their peers
(`qualification_failed_offers`), runs the rows that have not failed first and
a suspect row alone, and parks nothing on its own: a row is parked
(`failed_with_healthy_peers`, 14 days) only after 12 failed offers and only if a
qualification run completed elsewhere in between. A back-to-back backup is reused
only when the ledger still matches it byte for byte. `usegrunt-scout status` lists
under `stuck` a count plus candidate ids and fixed codes (`rework_exhausted`,
`promotion_blocked`, `outage_retries_exhausted`, `safety_stop`, `rebase_exhausted`) for
heads that will not move on their own, and the parked candidates.
`usegrunt-scout retire --homepage URL --reason TEXT` (and `unretire`) record a
source removed from Grunt, distinct from an owner exclusion; Clixad is retired by
default. Discovery runs four passes; the fourth diffs public free-LLM lists
against every host already in the ledger, sweeps for newer models, and runs
Chinese-language first-party queries, excluding relay, mirror and shared-key sites.

## Protected state and blocked work

Whole runs do not overlap. The concurrent discovery workers have no Squire
or other MCP integrations and use a read-only filesystem sandbox. The
qualification worker's writable workspace is separate from the
supervisor's installed policy, configuration, review receipts, trusted probe
evidence and release checkpoints. State directories are private to the operator.
Inherited API keys are excluded from worker/check environments; raw tool
transcripts, credential values and upstream error payloads are not retained.
Reviewers are read-only and have no MCP integrations. Candidate checks cannot
access the operator's home directory or supervisor state.

`~/.local/state/usegrunt-scout/ledger.json` is the master record of provider and
model decisions, search queries, pending reviews, and reviewed observations.
The scout imports retained reports into the search index and normalizes query
case and spacing. Reports under `reports/` retain the evidence for each run.
`usegrunt-scout status` displays the search and pending-review counts.
Missing web search, expired login, malformed output and timeouts are recorded
as failures.

The ledger also stores trusted `owner_exclusions`. Explicit cancellations stay
excluded across model, pricing and signup changes; research workers cannot
reopen them. Existing owner exclusions for FreeInference, AxForge, CCode,
Meldport and Packet.ai are initialized when an older ledger is loaded. An
operator can explicitly record or revoke a decision without editing the ledger:

```sh
usegrunt-scout exclude --homepage https://provider.example --reason 'Owner opted out'
usegrunt-scout allow --homepage https://provider.example --reason 'Owner explicitly reopened qualification'
```

These commands take the same exclusive lock as a scheduled run. `allow` only
removes the owner exclusion: it grants no account, payment, model, privacy or
release authority. Existing eligibility and promotion checks still apply.

Discovery compares offers against the full master record. Discovery, ingestion,
pending work and release bookkeeping share the same canonical provider/model
identity. Historical `www`/known gateway aliases are merged; resolving a generic
`unverified` model removes its stale placeholder without merging distinct exact
models or replacing a protected release identity. Revisiting an offer requires a first-party source and specific
before-and-after facts about allowance, usable context, quality, signup,
permitted use, or supply. Qualification receives only new offers or documented
changes. A rejection confirmed by a qualification review is terminal until such
a change. A rejection that rests only on the discovery pass's own labels is
recorded as `rejection_basis: claimed` and earns one verification pass (see
[Finishing candidates](#finishing-candidates)). Unexamined work
stays queued. Examined but unfinished research, setup and integration work also
stays queued, with its last review and next retry time. A review that changed
nothing starts a 12-hour delay (24 hours for blocked setup), doubling to at most
seven days; a second review with no new structured evidence parks the candidate
for 14 days. The supervisor migrates older completed-review records that
discarded this unfinished work. A retry resumes the remaining account/probe/integration step,
rather than asking discovery to find the provider again. Approval-held and
CAPTCHA/human-verification-held work has no automatic retry time. The status
command distinguishes total pending work from currently due reviews.
Unresolved human gates use the structured `qualification_blocker` code; a
mention of a CAPTCHA in freeform notes does not hold work. Canonical migration
preserves approval/human holds and their current evidence across aliases and
generic-model resolution, independently of protected release identity and
pending-map insertion order. A stale null retry without structured held state
does not permanently suppress otherwise retryable qualification.
The trusted controller also supplies current-ledger holds to the release
pipeline. Both fresh processing and deferred checkpoint resumption check that
map before reviews, checks, probes or promotion, so an older qualified
checkpoint cannot bypass a newer approval or human-verification hold. The map
is refreshed after qualification updates the ledger.

The qualification worker can inspect free-account metadata and perform bounded
synthetic verification through Squire when documented signup is eligible. An
unpublished allowance is not itself a permanent rejection, but no inference or
large-context probe can precede verified free access and zero-spend guards.

Public source evidence can include known documentation selectors, such as
`?section=models`, `?tab=pricing` or `?view=limits`. Homepages and proposal URLs
remain query-free. Unknown selectors, signed/credential-bearing queries,
fragments, malformed authorities and literal private/local addresses are
rejected by the shared report and release URL policy.

A malformed candidate row is quarantined with only its row number and a fixed
error code; valid neighbors still enter the ledger. Duplicate candidate IDs are
quarantined together. Reports record accepted/quarantined counts, and rejected
payloads and potentially repeated envelope text are removed from the persisted
worker result. A rejected current row cannot revive an older ledger entry for
promotion. Invalid report envelopes, missing web research and exceeded run
budgets still fail the entire pass.

Human OAuth confirmation, MFA, CAPTCHA, consent beyond the standing operator
approval and publisher approval
remain genuine blockers. The job records pending approval/setup work and stops
that attempt; it does not bypass challenges or wait indefinitely. Complete the
ordinary authentication or private Squire handoff before rerunning. Subsequent
runs reuse pending work and protected release checkpoints. A retry preserves
the exact source/model/commit identity and checks existing merge/publication
state before continuing, avoiding a second merge or duplicate publish.
Uncertain ordinary retention/training guarantees are disclosed rather than
treated as these blockers. Explicit requirements such as public posting of
identifiable code or selling identifiable project data need a specific decision;
paid fallback, prohibited downstream use and key exposure remain hard stops.

To stop scheduling, use `crontab -e` and remove only the block between
`# BEGIN usegrunt-provider-scout` and `# END usegrunt-provider-scout`. A running
job can be stopped by sending TERM to the `pid` in `last-run.json`; the runner
cleans up its own process group. Do not kill the shared browser or Squire broker.

## Compatibility with older installations

New runtime configuration uses `GRUNT_CONFIG_DIR`, `GRUNT_SOURCES` and
`~/.config/grunt`. The supervisor may reuse an existing BrowserSquire runtime
under `~/.config/milo` when the new runtime is absent; this fallback does not
move credentials or expose them to the worker. Both production configuration
directories are excluded from candidate probes.

Installation recognizes `https://github.com/bananaman614305/milo.git` only as an
explicit migration origin. All new clones, fetches, candidate validation and
release operations use `https://github.com/bananaman614305/grunt.git`.

## Local verification

```sh
python3 -m unittest discover -s ops/provider-scout -p 'test_*.py'
node --test ops/provider-scout/test_probe.mjs ops/provider-scout/test_provision.mjs
```

The fixtures use synthetic candidates, injected runners and local servers.
They do not create accounts, make inference calls to real providers, merge PRs
or publish packages.
