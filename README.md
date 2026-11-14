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

Run `usegrunt add kilo` to connect Kilo and restart grunt with its API sources enabled. This reuses saved Squire access or opens Kilo's free signup flow. Requests using model `grunt`, `milo`, or `freellmapi` try free Nemotron 3 Ultra before `kilo-auto/free`; model `kilo` selects Auto explicitly. Freebuff and OpenCode remain available. Repeat setup preserves the API sources. If Nemotron disappears from Kilo's catalog, setup uses Auto.

Kilo free models may log prompts or use them for training; avoid sensitive prompts. Their free limits are unknown. Kilo quota errors fall through FreeLLMAPI's fallback chain. Requests allow a long timeout for Nemotron reasoning.

Squire egress grants use the first allowed host and the stored authentication shape. Kilo setup uses `api.kilo.ai` first, bearer authentication, and `/api/gateway` beneath the grant. Provider keys stay in Squire.
