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

Setup is Trusty Squire, the free-service list, sign-in, then your coding tools.

[Reference](https://github.com/bananaman614305/milo/blob/main/docs/reference.md).

FreeLLMAPI sources include existing Groq access, optional keyed Kilo (free Nemotron 3 Ultra first, then `kilo-auto/free`). Setup reuses a saved `kilo` vault credential through Squire egress grants and skips keyed Kilo when absent. If Nemotron disappears from Kilo's catalog, setup uses `kilo-auto/free`. Existing sources, including the anonymous Kilo and Freebuff fallbacks, stay available.

Kilo free models may log prompts or use them for training; avoid sensitive prompts. Their free limits are unknown. Kilo quota errors fall through FreeLLMAPI's fallback chain. Requests allow a long timeout for Nemotron reasoning.

Squire egress grants use the first allowed host and the stored authentication shape. Kilo needs `ai-gateway.kilo.ai` first.. A key that works with a one-off vault request can still require these grant metadata settings.
