---
name: grunt-status
description: Report which provider and model Grunt is serving, provider states, usage, remaining quota, and reset or cooldown times from the local Grunt daemon.
---

Run the installed `usegrunt status` on the host that runs the Grunt daemon. The command uses the configured local port. Pass `--port <port>` if the user supplies a different local port.

Lead with **Serving now** and include all active provider/model pairs. When idle, report the last successful route separately if known. Summarize each provider’s state, used and remaining quota, and reset time. Keep estimates labeled as estimates, keep reported zeroes, and give cooldown separately from quota reset. Report unavailable data as unknown.

Share the status summary only. Omit launch commands, configuration paths, and raw diagnostics. If the command or daemon is unavailable on this host, say so. Do not start setup, start a daemon, or send a probe.
