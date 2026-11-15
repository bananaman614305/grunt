<h1 align="center">grunt</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="npm version" src="https://img.shields.io/npm/v/usegrunt"></a>
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="node" src="https://img.shields.io/node/v/usegrunt"></a>
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="downloads" src="https://img.shields.io/npm/dm/usegrunt"></a>
</p>

<p align="center"><strong>Free AI inference, pooled on your machine.</strong></p>

```bash
npx usegrunt
```

usegrunt installs grunt on this machine. It pools free AI quota and serves one local agent.

https://grunt.run. `milo` and `milo-local` remain aliases.

The 0.6.6 pool has eleven sources: OpenCode, Kilo, Zro, Token Harbor, Runcrate, Mistral Vibe Free, LiveKit, Pollinations, BeatAPI, Clixad and Perch. Setup connects Trusty Squire once, connects up to six services at once with up to three browser operations, tests each, then connects your coding tools. Provider-specific human verification is grouped or queued when needed. Pi is optional.

[Reference](https://github.com/bananaman614305/milo/blob/main/docs/reference.md) · [Vision](https://github.com/bananaman614305/milo/blob/main/VISION.md) · [Changelog](https://github.com/bananaman614305/milo/blob/main/CHANGELOG.md) · [Project instructions](https://github.com/bananaman614305/milo/blob/main/CLAUDE.md).

In 0.6.6, one grouped data-sharing approval covers nine active providers. Setup reuses the person's Google or GitHub identity; each provider can still require its own verification. `usegrunt add <provider>` remains available for supported providers. Runcrate needs a GitHub account at least 30 days old. Mistral uses its native Vibe Free coding allowance, not ordinary API credit. NVIDIA stays optional while account verification is unvetted; Cloudflare Qwen is excluded by choice. The default `kilo` source selects `particle-ai/particle-1:free`. Repeat setup preserves eligible previously connected API sources.

LiveKit adds DeepSeek V4.1 Flash through its free Build plan, using one free project and the official CLI's browser login. The documented included inference allowance is $2.50 per calendar month with a hard stop and no card. Keep the account on Build. LiveKit documents [zero data retention and no training for inference](https://docs.livekit.io/agents/models/inference/), so it needs no sharing approval. The route passed short-prompt, tool-call and 210,077-token context checks through Grunt.

The four additions are BeatAPI, Pollinations, Clixad and Perch. BeatAPI's ongoing free DeepSeek route permits one successful request per minute and leaves its separate $2 welcome credit untouched. Pollinations' fixed community GLM route needs a numeric zero-budget, Quest-only key and a positive unused Quest balance; the zero-priced route does not spend its one-time first-key reward. Clixad uses its native free GLM route with a zero wallet balance. Perch uses active Starter access with 20,000 Perch Tokens per month, the optional Data Program off, and both memory switches off. Native CLI output limits are local checks and cannot hard-cap upstream generation; keep Clixad's wallet at zero and Perch on Starter. See the reference for model-attestation and billing limits.

Within OpenCode, new conversations rotate across DeepSeek V4.1 Flash Free,
GLM 5.3 Flash Free and Big Pickle. Follow-ups keep their model, and quota errors
try another free model. These models may share provider limits; the pool does
not create extra credit balances or purchase credits.

Zro setup confirms the Free plan, no purchased usage balance and no payment method before connecting it. Keep that account free: Zro uses the same model ID on its paid plans, so changing the account outside grunt can change billing. Token Harbor uses its explicit `:free` model ID. Runcrate requires no paid balance, no card and automatic top-ups off; Mistral Vibe keeps pay-as-you-go off. Setup shows provider-specific data-sharing disclosures together and remembers approved policy versions in a private receipt. Declining or cancelling skips those providers and continues with Zro and LiveKit, subject to their free-account checks. Changed or newly added policies require another grouped approval. Background setup never prompts, and both signup and routing require the current receipt where required.

Freebuff and APInex are retired from all grunt routing in 0.6.6. Freebuff's native application is preserved; its saved source selection and legacy fallback no longer enable routing, and no port-8789 bridge starts. APInex changed its recurring daily entitlement to require a $5 top-up; grunt makes no purchase, and a one-time Telegram reward is excluded. Old sharing receipts cannot reactivate either source.

Kilo Particle 1 is post-trained from DeepSeek V4.1 Flash; it is a distinct model with a listed one-million-token context. Its free route requires no account or API key and supports native function calls. Anonymous access is limited to 200 requests per hour per IP and upstream capacity; it uses no one-time credits. The catalog permits training on prompts, so the changed Kilo disclosure requires fresh grouped approval. Standard DeepSeek routes remain paid; Auto Free is a changing pool and is no longer the default in 0.6.6.

API-provider keys stay in Squire. The anonymous Kilo Particle route uses no credential; grunt verifies the exact model and zero reported cost before accepting its answer.
