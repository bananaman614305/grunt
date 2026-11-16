# Maintainer provider scouting

This operator-only job runs on Chad at **09:00 and 21:00 America/New_York**.
The server timezone follows Eastern daylight saving changes. It searches the
internet for additional recurring free providers, qualifies them and can release
successful integrations through the supervised pipeline below. It is separate
from the daemon's daily maintenance checks and is not installed on users'
machines by `npx usegrunt`. There is no GitHub Actions workflow for scouting or
release.

The job uses the operator's existing Codex ChatGPT sign-in and live web search;
subscription usage and limits still apply. Trusty Squire handles eligible free
account signup and vaulted access. The [policy](POLICY.md) requires current
primary sources, recurring free access, at least 200,000 context tokens and
DeepSeek V4.1 Flash, GLM 5.3 Flash or verified comparable or better coding quality.
One-time credits, restricted affiliations, mandatory payments, SMS or Discord
onboarding do not qualify. Data sharing must be disclosed and retain Grunt's
provider-specific consent.

## Install and run

From the checkout on Chad:

```sh
python3 ops/provider-scout/scout.py install --source-repo "$PWD"
usegrunt-scout status
usegrunt-scout run --smoke  # live research only
usegrunt-scout run          # qualification and configured supervised pipeline
```

Installation copies the trusted runner, policy, schemas and pipeline modules to
`~/.local/lib/usegrunt-scout`, creates a separate scout-owned checkout and adds
one marked block to the existing crontab. It verifies the server timezone and
keeps a private crontab backup. Reinstalling replaces this job's block and
preserves other projects' jobs and the scout's private release configuration.

Automatic release requires `release_enabled: true` in the supervisor's private
configuration, a working sandbox toolchain and a successful npm publisher
authentication preflight. The npm credential is referenced through Squire;
never place its value or vault reference in public reports or repository files.
A research or integration result alone does not enable release. Missing
publisher access or approval blocks promotion rather than silently skipping a
gate.

## Qualification and release

1. **Discover and qualify.** Every run performs live web research, deduplicates
   provider/model offers and resumes promising pending work. Official sources
   must establish the exact model, context, recurring entitlement, limits,
   signup requirements and data policy. Smoke runs stop at research.
2. **Reuse access or sign up.** The constrained Squire proxy permits
   service-filtered account metadata and supported browser/signup operations.
   Only metadata lookup is preapproved; other actions retain automatic approval
   review. Keys and credential-bearing grants stay in the trusted backend,
   outside model output. Reuse existing accounts and pending Squire workflows.
3. **Implement in isolation.** The worker uses an owned candidate clone and
   private configuration, preserves existing guards and integrates onboarding,
   consent, exact-model defaults and registry metadata. It prepares a clean
   commit, a newer patch version, a newer registry publication timestamp and
   preliminary hello/tool evidence bound to that commit and registry hash.
4. **Validate and review.** The trusted supervisor verifies the repository,
   current main base, allowed change scope, eligibility and evidence. A fresh
   read-only reviewer independently checks current provider facts, terms,
   consent and the exact code change. Reviewers receive no Squire access.
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
   same commit after supervisor checks and trusted probing. Both independent
   reviews must approve all model, context, free-access, terms, signup, consent
   and code-scope checks. A worker's success flags cannot authorize promotion.
7. **Merge and publish.** With release enabled, the supervisor verifies
   publication access, opens or reuses the candidate PR and merges the exact
   approved head through the normal GitHub path. It builds and publishes the
   matching npm artifact through protected Squire-backed access, then verifies
   the public package and bundled registry. GitHub Actions remain unused.

A signup, preliminary reply or locally passing test is not a release. A source
joins the automatic pool only after the protected release pipeline succeeds.
New users receive its bundled registry with the new npm release when they run
`npx usegrunt`; existing installations receive the new runtime with
`npx usegrunt update` (`npx usegrunt@latest update` for older CLIs). Normal
provider-specific setup and consent still apply. These pipeline tests do not
claim that a newly discovered real provider has passed live qualification.

## Protected state and blocked work

Runs do not overlap. The worker's writable workspace is separate from the
supervisor's installed policy, configuration, review receipts, trusted probe
evidence and release checkpoints. State directories are private to the operator.
Inherited API keys are excluded from worker/check environments; raw tool
transcripts, credential values and upstream error payloads are not retained.
Reviewers are read-only and have no MCP integrations. Candidate checks cannot
access the operator's home directory or supervisor state.

`~/.local/state/usegrunt-scout/ledger.json` tracks decisions by provider domain
and model. Reports live under `reports/`; `last-run.json` and `cron.log` record
execution status. Inspect them with `usegrunt-scout status`. These are local
reports, not email or chat notifications. Missing web search, expired login,
malformed output and timeouts are failures or explicit blockers, not successful
empty searches.

Human OAuth confirmation, MFA, CAPTCHA, changed consent and publisher approval
remain genuine blockers. The job records pending approval/setup work and stops
that attempt; it does not bypass challenges or wait indefinitely. Complete the
ordinary authentication or private Squire handoff before rerunning. Subsequent
runs reuse pending work and protected release checkpoints. A retry preserves
the exact source/model/commit identity and checks existing merge/publication
state before continuing, avoiding a second merge or duplicate publish.

To stop scheduling, use `crontab -e` and remove only the block between
`# BEGIN usegrunt-provider-scout` and `# END usegrunt-provider-scout`. A running
job can be stopped by sending TERM to the `pid` in `last-run.json`; the runner
cleans up its own process group. Do not kill the shared browser or Squire broker.

## Local verification

```sh
python3 -m unittest discover -s ops/provider-scout -p 'test_*.py'
node --test ops/provider-scout/test_probe.mjs
```

The fixtures use synthetic candidates, injected runners and local servers.
They do not create accounts, make inference calls to real providers, merge PRs
or publish packages.
