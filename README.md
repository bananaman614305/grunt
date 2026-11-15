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

Setup connects Trusty Squire, installs and connects the vetted Freebuff, OpenCode, Kilo and Zro pool, plus opt-in Token Harbor (up to three services at once), tests each service, then connects your coding tools. Browser verification is queued when a provider needs you. Pi is optional.

[Reference](https://github.com/bananaman614305/milo/blob/main/docs/reference.md).

New installs offer Zro's daily free DeepSeek V4.1 Flash and, after one grouped data-sharing approval, Freebuff, OpenCode, Kilo Auto and Token Harbor's weekly free route. `usegrunt add groq`, `usegrunt add cerebras`, `usegrunt add kilo`, `usegrunt add zro` and `usegrunt add tokenharbor` remain available. NVIDIA stays optional while its account verification is unvetted. Existing `freellmapi` routes keep their Nemotron-first Kilo chain; the default `kilo` source selects `kilo-auto/free`. Repeat setup preserves previously connected API sources.

Within OpenCode, new conversations rotate across DeepSeek V4.1 Flash Free,
GLM 5.3 Flash Free and Big Pickle. Follow-ups keep their model, and quota errors
try another free model. These models may share provider limits; the pool does
not create extra credit balances or purchase credits.

Zro setup confirms the Free plan, no purchased usage balance and no payment method before connecting it. Keep that account free: Zro uses the same model ID on its paid plans, so changing the account outside grunt can change billing. Token Harbor uses its explicit `:free` model ID and requires approval for retained prompts, staff review and upstream-provider training. Setup asks once for Freebuff, OpenCode (including Big Pickle), Kilo and Token Harbor together, showing each provider's disclosure. It remembers the approved policy versions in a private local receipt. Declining or cancelling skips those providers and continues with Zro. Changed or newly added policies require another grouped approval. Background setup never prompts, and both signup and routing require the current receipt.

Kilo free models may log prompts or use them for training; avoid sensitive prompts. Their free limits are unknown. Kilo quota errors fall through FreeLLMAPI's fallback chain. Requests allow a long timeout for Nemotron reasoning.

Squire egress grants use the first allowed host and the stored authentication shape. Kilo setup uses `api.kilo.ai` first, bearer authentication, and `/api/gateway` beneath the grant. Provider keys stay in Squire.
