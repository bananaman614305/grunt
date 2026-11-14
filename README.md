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

Setup connects Trusty Squire, installs and connects the vetted Freebuff, OpenCode and Kilo pool (up to three services at once), tests each service, then connects your coding tools. Browser verification is queued when a provider needs you.

[Reference](https://github.com/bananaman614305/milo/blob/main/docs/reference.md).

New installs route tasks across Freebuff, OpenCode and Kilo Auto. `usegrunt add groq`, `usegrunt add cerebras` and `usegrunt add kilo` remain available. Existing `freellmapi` routes keep their Nemotron-first Kilo chain; the default `kilo` source selects `kilo-auto/free`. Repeat setup preserves previously connected API sources.

Kilo free models may log prompts or use them for training; avoid sensitive prompts. Their free limits are unknown. Kilo quota errors fall through FreeLLMAPI's fallback chain. Requests allow a long timeout for Nemotron reasoning.

Squire egress grants use the first allowed host and the stored authentication shape. Kilo setup uses `api.kilo.ai` first, bearer authentication, and `/api/gateway` beneath the grant. Provider keys stay in Squire.
