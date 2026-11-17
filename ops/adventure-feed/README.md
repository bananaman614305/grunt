# Amazing Adventure activity

On Chad, run `grunt-adventure live` for the terminal feed. It polls the runner's
private Pi session and the read-only status endpoint on loopback port 8793 every
two seconds. Progress comes from completed, visible assistant text. The
projector filters code fences, inline code, links, paths and common
credential patterns. Tool entries contain the tool's name and outcome.

The owner dashboard at `/admin/#activity` shows the answering provider, the
last successful provider, provider issues and the latest 40 progress or tool
entries. Model labels come from the configured route. The web view refreshes
about every five seconds while visible.

The publisher reads the `Current task` and `Next steps` sections of Grunt's
`GRUNT_STATUS.md` checkpoint. The overview labels the checkpoint with its update
time. It also shows recent milestones from public Amazing Adventure pull request
metadata, cached for four minutes. The dashboard displays the actual draft,
review, merged or closed state and builds links from pull request numbers. The
checkpoint and timeline travel with the private activity snapshot.

The publisher also samples project work every five seconds. Give its service
write access to the private `uptime/` directory under the adventure state root.
The SQLite ledger survives publisher restarts and retains eight days of data.
The browser shows rolling 24-hour and seven-day totals. Model calls, tool
execution and brief handoffs count as active work. The monitor records provider
waits, stalls, paused or offline time, and time between work cycles as downtime.
A model-only interval can be counted as provider downtime after the pool reports
that attempt failed. The percentage uses measured time. Older time and gaps in
monitoring remain unmeasured. The monitor also checks the running Pi process for\na quiet shell tool when its start event has not reached the cycle log yet.

Chad can run `activity.py upload` as a separate user service. It uses the
existing private collector environment file for the ingestion credential
and approved instance ID. It sends the projected snapshot only to the existing
Fly gateway over HTTPS. The handler serves it to signed-in owners and stores
one snapshot per approved instance in memory for up to two minutes after
the publisher's last update. Recent entries come from the past day of the
local session. The activity feed is separate from request diagnostics and
their exports. Normal Grunt installations opt in explicitly through an owner
operator.

Run projection tests with `python3 -m unittest discover -s ops/adventure-feed`.
