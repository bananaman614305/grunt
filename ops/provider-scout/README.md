# Maintainer provider scouting

An operator-only cron job for Chad, separate from the Grunt daemon and daily user
maintenance. It runs at **09:00 and 21:00 America/New_York**, using the server's
timezone so daylight saving changes follow Eastern time. It uses the existing
Codex ChatGPT sign-in, live web search and Trusty Squire MCP configuration.
Codex subscription usage/limits still apply; there is no GitHub Actions workflow.

Install from the checkout on Chad:

```sh
python3 ops/provider-scout/scout.py install --source-repo "$PWD"
usegrunt-scout status
usegrunt-scout run --smoke  # real web research, no signup or inference
usegrunt-scout run          # full qualification pass
```

Installation copies the runner, schema and policy into
`~/.local/lib/usegrunt-scout`, creates a separate scout-owned checkout, and adds
one marked block to the existing crontab. Other projects' entries are preserved.
The installer verifies that the server timezone is America/New_York and retains
a private crontab backup. Reinstalling replaces that block, not other jobs.

Runs do not overlap. Each has a 45-minute deadline; smoke research is limited to
15 minutes. The standalone worker (`--no-daemon`) uses a workspace sandbox with network access, existing
Squire grants and its own checkout/worktrees. Its subprocess environment excludes
inherited API keys. Raw tool transcripts and upstream error payloads are not
retained. The workspace is writable; the supervisor's configuration, installed
policy and ledger are outside the worker's writable roots. An expired login,
missing web search, malformed output or timeout is
reported as a failed run rather than a successful empty search.

`~/.local/state/usegrunt-scout/ledger.json` deduplicates offers by provider domain
and model. Reports live under `reports/`; `last-run.json` and `cron.log` record
execution status. State and reports are private to the operator. These are local
reports, not email or chat notifications. Inspect status here or from the CLI.

The policy carries the approved model-quality, >=200K context, recurring-free,
signup-friction and data-sharing requirements. Qualified signups reuse Squire;
human verification is retained as pending work. Isolated integration must prove
an exact-source Grunt reply, native tool call and free-access guards before a
candidate can be marked ready for review. A documented context size is distinct
from a context limit exercised in a live test. Candidate evidence remains subject
to maintainer review; it is not automatic production approval.

Successful candidates can produce draft PRs. The job does not merge, publish npm,
deploy, change the production registry or enable providers on users' machines.
Those steps stay in the existing release/review pipeline. This cron job is not
included in the npm package or installed for ordinary `npx usegrunt` users.

To stop the job, use `crontab -e` and remove only the block between
`# BEGIN usegrunt-provider-scout` and `# END usegrunt-provider-scout`. A running
worker can be stopped by sending TERM to the `pid` in `last-run.json`; the runner
cleans up its own process group. Do not kill the shared browser or Squire broker.

Local verification:

```sh
python3 -m unittest discover -s ops/provider-scout -p 'test_*.py'
```
