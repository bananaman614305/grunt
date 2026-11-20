# Free-Pi guarded integration

The `freepi` adapter uses Free-Pi's acknowledged OpenAI-compatible API at
`https://api.freepi.ai/v1/chat/completions`. It requests only
`deepseek-v4.1-flash` and verifies the exact observed upstream model
`deepseek-ai/deepseek-v41-flash-1017`. GLM is not included in this qualification.

Before account activation, the user must expressly approve Free-Pi's material
trace-sale terms. Free-Pi can sell coding-session traces; redaction is not
guaranteed and there is no ordinary opt-out. A saved approval alone does not
make private content suitable: every request must also carry the local client's
reviewed-public-context attestation. Worker/handoff and image requests are
excluded. The integration preserves sponsored response text.

Foreground setup uses the official GitHub device flow reflected in
`free-pi-cli@0.6.25`, consent contract `4`. Trusty Squire handles the GitHub
confirmation with the user's identity. It does not add cards, buy credits,
collect referral rewards, enable plans or create duplicate accounts. Credentials
stay in a mode-0600 per-user file under Grunt's private configuration.

## Free-only guard

The current target has a temporary unlimited-free promotion. Each inference
requires the current exact free model offer and the reviewed current client
contract. A changed offer or client contract requires review. Daily free
allowance is account-dependent; its size is not published as a universal token
quota. The qualified account reported 15,000 credits / $1.125 daily, resetting at
00:00 UTC. Those are observations, not promises for all users. Its promotional
DeepSeek probes did not consume this allowance.

Every request checks `/me/stats` immediately before inference: all seven
mandatory spendable wallet fields and any of the two recognized optional
wallets must equal zero. Missing mandatory fields, nonzero paid/earned/gifted
balances, unknown spending controls, guest accounts, exhausted allowance or an
unverifiable reset stop the route. The same checks run after inference. A
successful request that consumes the final free allowance may return its result;
the next preflight stops at the reported reset. Generic 429s retain provider
Retry-After, without inventing a daily reset.

A per-account mutex shared across Grunt configuration directories prevents
concurrent Grunt requests on this account. A private SQLite write transaction owns this mutex. The operating system
releases it if the process crashes; Grunt never steals a live owner's lock or
deletes a lock file based on time or a PID. This does not control another client, account top-ups performed
outside Grunt, or server-side accounting changes between a preflight and dispatch.
The provider documents manual prepaid packs; the qualification account has never
supplied payment details. There is no proven server-side atomic `free_only`
request option. The integration must remain disabled for accounts with payment
arrangements or nonzero wallets; it must not claim it can neutralize arbitrary
postpaid or auto-recharge accounts.

## Qualification, 20 November 2026

Synthetic-only official API probes returned:

| Probe | Input tokens | Output tokens | Result |
| --- | ---: | ---: | --- |
| Exact hello | 40 | 19 | Exact expected marker |
| Inert structured function call | 344 | 66 | Exact function and JSON arguments |
| Long synthetic context | 201,074 | 29 | Exact expected marker |

All three returned HTTP 200, the pinned upstream model, zero wallets before and
after, and unchanged daily free allowance. No game, private project or personal
payload was submitted. Production game use requires its own appropriate consent
and full request review; these synthetic results do not authorize it.

Sources: [models and limits](https://freepi.ai/docs/models-and-limits),
[model](https://freepi.ai/models/deepseek-v4.1-flash),
[terms](https://freepi.ai/terms), [privacy](https://freepi.ai/privacy),
[credits](https://freepi.ai/credits), and the official npm package
`free-pi-cli@0.6.25` (git head `5a0f628ba3b023d981a4969fd2ef2510f9e3905b`).
