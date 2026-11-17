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
