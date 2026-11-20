# Antseed-Vikey buyer provisioning

`npx usegrunt add antseed-vikey` uses `setupAntseedVikey()` to install a private
buyer under the user's Grunt configuration after its source-specific disclosure
is approved. No separate provider account or existing owner installation is
needed. It remains an explicit experimental source outside default onboarding
until the required usable-input qualification passes. Provisioning is not
evidence of usable context, model quality, a successful inference, or free quota.

Initial installation coverage is Linux x64 with glibc, Node22 or Node24, and a
working user systemd manager. Unsupported platforms skip this source while other
sources remain available. An existing different buyer unit or occupied port8381
is preserved, rather than silently taken over.

The installer uses CLI0.1.253 and router-local0.1.53 with a complete npm lock
graph. It invokes `npm ci --ignore-scripts` with empty npm configuration, then
verifies a published SHA256 digest before extracting only the SQLite native
binding. Node22 ABI127 and Node24 ABI137 assets are pinned from the
[better-sqlite3 v12.11.1 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1).
There is no unpinned native-build fallback. The optional node-datachannel binding
is not installed; the pinned Antseed node supports its TCP fallback.

The complete dependency graph is compressed in `src/local/antseed-vikey-lock.ts`
and bounded to256KiB when decoded. Its plaintext SHA256 is verified at runtime.
To inspect it from the source checkout:

```bash
node --import tsx --input-type=module -e 'import {antseedLock} from "./src/local/antseed-vikey-setup.ts"; console.log(JSON.stringify(JSON.parse(antseedLock()), null, 2))'
```

The buyer has its own private HOME and state. A fresh local protocol identity is
created by Antseed when it first starts; no existing wallet or provider key is
imported. Settlement is disabled, automatic wallet sweeping is disabled, input
and output prices are capped at zero, and the seller peer is pinned. The service
starts with an empty environment plus its explicit settings, and both plugin
refresh and version notifications are disabled. It never enables a paid route.
The adapter independently verifies the exact peer, service and zero prices
before dispatch, and verifies reply pricing headers afterward.

The setup helper waits for the existing adapter's metadata-only availability
check. It sends no inference itself. The onboarding pipeline remains responsible
for its bounded functional check, current provider consent, and model/context
qualification. Existing authentication, user state, quotas and running workers
are not reset by provisioning.

An installed runtime whose recorded core hashes, configuration or router lookup
have changed fails closed. Setup does not repair it over a running service.
