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

Setup connects Trusty Squire and offers eight vetted free sources: Freebuff, OpenCode, Kilo, Zro, Token Harbor, Runcrate, APInex and Mistral Vibe Free. It connects up to three services at once, tests each, then connects your coding tools. Browser verification is queued when a provider needs you. Pi is optional.

[Reference](https://github.com/bananaman614305/milo/blob/main/docs/reference.md).

One grouped data-sharing approval covers the providers that require it, including Runcrate, APInex and Mistral Vibe Free. `usegrunt add <provider>` remains available for supported providers. Runcrate needs a GitHub account at least 30 days old; APInex needs a personal Gmail Google login and daily free check-in. Mistral uses its native Vibe Free coding allowance, not ordinary API credit. NVIDIA stays optional while account verification is unvetted; Cloudflare Qwen is excluded by choice. Existing `freellmapi` routes keep their Nemotron-first Kilo chain; the default `kilo` source selects `kilo-auto/free`. Repeat setup preserves previously connected API sources.

Within OpenCode, new conversations rotate across DeepSeek V4.1 Flash Free,
GLM 5.3 Flash Free and Big Pickle. Follow-ups keep their model, and quota errors
try another free model. These models may share provider limits; the pool does
not create extra credit balances or purchase credits.

Zro setup confirms the Free plan, no purchased usage balance and no payment method before connecting it. Keep that account free: Zro uses the same model ID on its paid plans, so changing the account outside grunt can change billing. Token Harbor uses its explicit `:free` model ID. Runcrate requires no paid balance, no card and automatic top-ups off; APInex uses only its `free/` route and never spends wallet funds; Mistral Vibe keeps pay-as-you-go off. Setup shows provider-specific data-sharing disclosures together and remembers approved policy versions in a private receipt. Declining or cancelling skips those providers and continues with Zro. Changed or newly added policies require another grouped approval. Background setup never prompts, and both signup and routing require the current receipt.

Kilo free models may log prompts or use them for training; avoid sensitive prompts. Their free limits are unknown. Kilo quota errors fall through FreeLLMAPI's fallback chain. Requests allow a long timeout for Nemotron reasoning.

Squire egress grants use the first allowed host and the stored authentication shape. Kilo setup uses `api.kilo.ai` first, bearer authentication, and `/api/gateway` beneath the grant. Provider keys stay in Squire.
