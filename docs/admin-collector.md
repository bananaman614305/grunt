# Owner diagnostics collector

The collector sends sanitized observations from an explicitly configured Grunt
installation to the private owner dashboard. It is not enabled by normal
`npx usegrunt` onboarding and does not collect other users' diagnostics.

The collector reads the existing loopback daemon. It opens no listening port,
does not change the daemon's Host or Origin checks, and never generates a model
request, signs up for a provider, refreshes a credential, or runs a shell command.

## Configure an owned installation

After building the runtime, run:

```sh
node dist/admin/collector.js
```

Supply these variables through a private environment file or the service manager;
do not place the ingestion key in command-line arguments, source control or a
browser:

| Variable | Purpose |
| --- | --- |
| `GRUNT_ADMIN_INGEST_KEY` | Dedicated machine ingestion credential accepted by the admin backend. Required. It is separate from Google owner login and read-only agent access. |
| `GRUNT_ADMIN_INSTANCE_ID` | Backend-approved installation ID, for example `chad`. Required. |
| `GRUNT_ADMIN_COLLECTOR_URL` | Defaults to `https://api.grunt.run/admin/ingest`. HTTPS, the exact ingestion path, and an owned Grunt hostname are required. The preserved `milo-gateway.fly.dev` origin is also accepted for operator deployment verification. |
| `GRUNT_ADMIN_DAEMON_PORT` | Local daemon port. Defaults to `8792`; otherwise falls back to `GRUNT_PORT` / `MILO_PORT` when supplied. |
| `GRUNT_CONFIG_DIR` | Existing private daemon configuration directory. The normal `MILO_CONFIG_DIR` and existing-directory migration compatibility remain supported. |

The backend must independently allow the installation ID. The key permits
ingestion only; it does not create an owner session or grant diagnostic reads.
All requests disable redirects. Query strings, credentials in URLs, custom
ports, arbitrary hostnames and plain HTTP ingestion are rejected.

Use the same owner account and configuration directory as the daemon. Its
directory must be owned, canonical and mode `0700`. A service environment file
containing secrets must be mode `0600`. Do not replace the existing daemon's
service or its custom port/settings to install the collector. A separate
collector service can invoke the command above and receive only its own private
environment variables.

## What is transmitted

Every normal cycle reads:

- `/v1/status` for the cached provider and subworker snapshot;
- `/v1/diagnostics/summary` for the persistent stream identity;
- `/v1/diagnostics/events` for up to 200 oldest unacknowledged events;
- the private maintenance state and explicitly projected scout state, when present;
- numeric system resource data and runtime versions.

The collector constructs allowlisted metadata records before sending them and
validates the resulting batch again using the backend's shared schema. The wire
format excludes prompts, replies, code, working directories, raw errors,
headers, native output, account data, signed browser links, vault references and
configuration files. Subworker snapshots contain job IDs, states, source IDs, timestamps
and optional activity labels. Missing token counts remain absent. A daemon connection
failure produces a nullable snapshot with an explicit unavailable observation;
it does not create a healthy provider result.

Scout progress contains fixed status and reason codes. Protected release
checkpoint evidence is read only from the current candidate's validated commit
path, using private owned files without following symlinks. An old-head review
cannot describe a repaired candidate. Pending checks and absent probe evidence
remain unknown. Publication is marked only after a protected released result.
Report prose, review reasons, credential references and private paths are never
transmitted.

## Delivery and recovery

The normal interval is 25 seconds plus up to five seconds of jitter. Failed
uploads back off, capped at roughly five minutes. Requests and response sizes
are bounded, and shutdown cancels in-flight network requests. Logs contain fixed
connection/retry messages rather than upstream response text.

`admin-collector-state.json` stores the installation, destination, diagnostic
stream identity, acknowledged cursor and acknowledgment time under the private
configuration directory. It is mode `0600`, written atomically, and never
contains the ingestion key. Symlinked, public or malformed checkpoints fail
closed.

The cursor advances only after the backend explicitly acknowledges a valid
batch. A failed or interrupted delivery is replayed; the backend deduplicates
events by installation and event ID. First connection begins with the oldest
retained local history. A changed diagnostic database stream resets the cursor
so a prior database's larger sequence number cannot skip the new history.

The overview's lifetime usage begins with the available successful user
replies. The backend keeps aggregate counts per installation and provider
after detailed traces expire. A bounded set of recent usage receipts prevents
duplicate totals on replay. Replies with missing token counts still count
toward the reply total.

An offline collector cannot upload its own outage. The dashboard must therefore
use the backend's last-received time to mark an installation stale or offline.
Missing diagnostics on an older daemon appear as unavailable until that runtime
is updated; the collector does not start or upgrade it implicitly.
