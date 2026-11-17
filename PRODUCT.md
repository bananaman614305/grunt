# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Grunt's owners inspect their own Grunt installations, starting with Chad. The
owner often works from a mobile phone while the daemon runs on a remote server.
The same diagnostic information must be usable by a human operator and an
authorized diagnostic agent.

## Product Purpose

Grunt routes coding requests through vetted free intelligence providers. The
private admin console explains what happened to each request, which provider
attempts failed, how fallback behaved, and whether maintenance and scouting are
making progress.

## Operating Context

- The public website is `grunt.run`; the requested console is `/admin`.
- The existing local terminal dashboard remains supported.
- The approved Chad inference daemon listens on loopback port 8792.
- Google sign-in is restricted to two explicitly configured owner identities.
  Exact email addresses are kept in private deployment configuration and must
  be verified before production access is enabled.
- Other users' installations are not automatically enrolled in telemetry.

## Capabilities and Constraints

- Persistent request and provider-attempt history, including safe HTTP and CLI
  diagnostics, routing outcomes and fallback.
- Provider state, usage, maintenance, scout/release progress and system health.
- Measured token counts are distinct from estimates and missing reports.
- First release is read-only apart from refresh, sign-out and diagnostic export.
- Diagnostic data excludes credentials, OAuth capability links, prompts,
  responses, source code and private working-directory paths.
- The explicitly enabled Amazing Adventure feed shows visible progress messages and tool names with outcomes. Its latest projected snapshot stays separate from diagnostics and exports.
- Viewing the console does not send inference or create accounts.
- Existing inference network restrictions, services and other projects remain
  intact.

## Brand Commitments

Use the existing Grunt name and worker mark. Preserve the website's recognizable
navy, warm off-white and work-light gold palette. Diagnostic copy is direct,
precise and distinguishes observed facts from unconfirmed causes.

## Evidence on Hand

The existing website and assets are in `site/`. The terminal status projection
is implemented in `src/local/source-status.ts`. The admin console must show
actual collected data; no example provider health, usage or charts ship as real
telemetry.

## Accessibility & Inclusion

Support narrow mobile screens and keyboard operation. Color is accompanied by
state text. Respect reduced motion and preserve readable contrast in dense
tables and error states.
