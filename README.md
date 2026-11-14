<h1 align="center">grunt</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="npm version" src="https://img.shields.io/npm/v/usegrunt"></a>
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="node" src="https://img.shields.io/node/v/usegrunt"></a>
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="downloads" src="https://img.shields.io/npm/dm/usegrunt"></a>
</p>

<p align="center"><strong>Free AI inference, pooled on your machine.</strong></p>

<p align="center">free AI quota · one local agent</p>

## What grunt does

usegrunt installs grunt, a small daemon that runs on this machine. It pools the free AI inference quota offered by many services and serves it as one agent at a local address. Your coding tools talk to grunt; grunt sends each request to a free service that can answer it.

Website: https://grunt.run. The `milo` and `milo-local` commands remain aliases for this release.

## Install

```bash
npx usegrunt
```

Setup will: (1) Connect Trusty Squire (one Google sign-in). (2) Pull the current list of free services from the grunt registry. (3) Sign up for each service, connect it to grunt and test it. (4) Connect grunt to the coding tools installed here. Configuration, harness snippets, and internals are in the [reference](https://github.com/bananaman614305/milo/blob/main/docs/reference.md).
