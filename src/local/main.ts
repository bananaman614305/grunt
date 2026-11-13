#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import { serve } from '@hono/node-server';
import { createLocalApp } from './api.js';
import { Freebuff, positive } from './freebuff.js';
import { Sources } from './source.js';
import { FreeLLMAPI } from './freellmapi.js';
import { Codex } from './codex.js';
import { OpenCode } from './opencode.js';
import { Dots } from './dots.js';
import type { Source } from './source.js';
import { bundledRegistry } from '../registry.js';
import type { Registry } from '../registry.js';
import { RegistrySync } from './registry.js';
import { configDir, command } from './wizard.js';
import { setupFallbacks } from './fallback-setup.js';
import { BrowserSquire } from './setup.js';
export const HOST = '127.0.0.1';
export function configure(env = process.env, registry: () => Registry = () => bundledRegistry) {
  const url = env.MILO_FREELLMAPI_URL ?? 'http://127.0.0.1:3001/v1';
  let key = env.MILO_FREELLMAPI_KEY ?? '';
  let pending: Promise<string> | undefined;
  const loadKey = async () => {
    if (key) return key;
    pending ??= import('./setup.js').then(module => module.loadRouterKey(url)).then(value => key = value).catch(() => {
      console.error('grunt router login unavailable or invalid; will retry on the next request. Check the local router and its saved login.');
      return '';
    }).finally(() => { pending = undefined; });
    return pending;
  };
  const connection = { url, loadKey };
  const dots = new Dots({ env, timeout: positive(env.MILO_DOTS_TIMEOUT_MS, 300000) });
  const registered: Source[] = [dots, new Codex(env.MILO_CODEX_MODEL ? { model: env.MILO_CODEX_MODEL } : {}), new FreeLLMAPI(connection), new FreeLLMAPI({ ...connection, id: 'kilo', model: 'kilo-auto/free' }), new OpenCode({ model: () => env.MILO_OPENCODE_MODEL ?? registry().adapters.find(a => a.id === 'opencode')?.model ?? 'big-pickle', ...(env.MILO_OPENCODE_URL ? { url: env.MILO_OPENCODE_URL } : {}) }), new Freebuff({ toolBridge: env.MILO_FREEBUFF_JSON_BRIDGE === '1' })];
  const ids = env.MILO_SOURCES?.split(',').map(id => id.trim()) ?? ['freebuff', 'opencode'];
  const routing = ids.every(id => ['freebuff', 'opencode'].includes(id)) ? { registry } : undefined;
  return new Sources(ids.map(id => { const source = registered.find(s => s.id === id); if (!source) throw new Error(`Unknown grunt source: ${id}`); return source; }), routing);
}
export function start(env = process.env) {
  let registry = structuredClone(bundledRegistry);
  const sources = configure(env, () => registry);
  const directory = configDir(env);
  const sync = new RegistrySync({ directory, ...(env.GRUNT_REGISTRY_URL ? { url: env.GRUNT_REGISTRY_URL } : {}),
    changed: current => { registry = current; }, notify: console.error,
    ensure: async (adapter, signal) => {
      if (!sources.sources.some(source => source.id === adapter.id)) return;
      sources.preparing.add(adapter.id);
      const squire = new BrowserSquire({ background: true, signal });
      try {
        const result = await setupFallbacks({ directory, run: (binary, args) => command(binary, args, false, signal), notify: console.error, adapters: [adapter.id], squire, signal,
          connect: () => squire.connect() });
        if (result.unavailable.length) throw new Error('Adapter setup incomplete');
        sources.healthy(adapter.id);
      } finally { sources.preparing.delete(adapter.id); await squire.close(); }
    }
  });
  // Load the private cache before accepting tasks, without waiting for the network.
  // Mark adapters as preparing until their first background setup finishes.
  const ready = sync.load().then(() => { for (const adapter of sync.enabled) if (sources.sources.some(source => source.id === adapter.id)) sources.preparing.add(adapter.id); });
  void ready.then(() => sync.start()).catch(() => console.error('Registry sync could not start; using the bundled list')).finally(() => sources.preparing.clear());
  // Warm the saved login without delaying the server; failed loads retry lazily.
  void sources.sources.find(source => source.id === 'freellmapi' || source.id === 'kilo')?.available();
  const port = positive(env.MILO_PORT, 8788);
  if (port > 65535) throw new Error('MILO_PORT must be at most 65535');
  const app = createLocalApp(sources, { port, dotsEnv: env, log: cwd => console.error(`grunt working directory: ${cwd}`) });
  const server = serve({ fetch: async request => { await ready; return app.fetch(request); }, hostname: HOST, port }, () => console.error(`grunt model API: http://${HOST}:${port}/v1`));
  // A distinct source list prevents FreeLLMAPI -> grunt -> FreeLLMAPI recursion.
  const fallback = env.MILO_FREEBUFF_BRIDGE !== '0' && sources.sources.some(s => s.id === 'freellmapi' || s.id === 'kilo') ? new Sources([new Freebuff({ toolBridge: env.MILO_FREEBUFF_JSON_BRIDGE === '1' })]) : undefined;
  const bridge = fallback ? serve({ fetch: createLocalApp(fallback, { port: 8789 }).fetch, hostname: HOST, port: 8789 }) : undefined;
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await sync.close(); await sources.close(); await fallback?.close(); bridge?.close(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv[2] === 'dots' && process.argv[3] === 'link') {
    const { dotsLink } = await import('./dots-link.js');
    try { await dotsLink(process.argv[4]); }
    catch { console.error('Dots pairing failed. Use the fallback code from the Allow page: usegrunt dots link <code>.'); process.exitCode = 1; }
  } else if (['setup', 'add'].includes(process.argv[2] ?? '') || (!process.argv[2] && basename(process.argv[1]) === 'usegrunt' && process.env.GRUNT_DAEMON !== '1')) {
    const { wizard } = await import('./wizard.js');
    try {
      if (process.argv[2] === 'add' && !process.argv[3]) throw new Error('Usage: usegrunt add <provider>');
      await wizard(process.argv[2] === 'add' ? process.argv[3] : undefined);
    }
    catch (error) { console.error(error instanceof Error ? error.message : 'grunt setup failed'); process.exitCode = 1; }
  } else start();
}
