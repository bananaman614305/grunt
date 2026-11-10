#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createLocalApp } from './api.js';
import { Freebuff, positive } from './freebuff.js';
import { Sources } from './source.js';
import { FreeLLMAPI } from './freellmapi.js';
import { Codex } from './codex.js';
import { OpenCode } from './opencode.js';
import { Dots } from './dots.js';
import type { Source } from './source.js';
export const HOST = '127.0.0.1';
export function configure(env = process.env) {
  const connection = { url: env.MILO_FREELLMAPI_URL ?? 'http://127.0.0.1:3001/v1', key: env.MILO_FREELLMAPI_KEY ?? '' };
  const dots = new Dots({ env, timeout: positive(env.MILO_DOTS_TIMEOUT_MS, 300000) });
  const registered: Source[] = [dots, new Codex(env.MILO_CODEX_MODEL ? { model: env.MILO_CODEX_MODEL } : {}), new FreeLLMAPI(connection), new FreeLLMAPI({ ...connection, id: 'kilo', model: 'kilo-auto/free' }), new OpenCode({ model: env.MILO_OPENCODE_MODEL ?? 'big-pickle', ...(env.MILO_OPENCODE_URL ? { url: env.MILO_OPENCODE_URL } : {}) }), new Freebuff()];
  const ids = env.MILO_SOURCES?.split(',').map(id => id.trim()) ?? ['freellmapi', 'opencode', 'kilo'];
  return new Sources(ids.map(id => { const source = registered.find(s => s.id === id); if (!source) throw new Error(`Unknown Milo source: ${id}`); return source; }));
}
export function start(env = process.env) {
  const sources = configure(env);
  const port = positive(process.env.MILO_PORT, 8788);
  if (port > 65535) throw new Error('MILO_PORT must be at most 65535');
  const app = createLocalApp(sources, { port, dotsEnv: env, log: cwd => console.error(`Milo working directory: ${cwd}`) });
  const server = serve({ fetch: app.fetch, hostname: HOST, port }, () => console.error(`Milo model API: http://${HOST}:${port}/v1`));
  // A distinct source list prevents FreeLLMAPI -> Milo -> FreeLLMAPI recursion.
  const fallback = sources.sources.some(s => s.id === 'freellmapi' || s.id === 'kilo') ? new Sources([new Freebuff()]) : undefined;
  const bridge = fallback ? serve({ fetch: createLocalApp(fallback, { port: 8789 }).fetch, hostname: HOST, port: 8789 }) : undefined;
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await sources.close(); await fallback?.close(); bridge?.close(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv[2] === 'dots' && process.argv[3] === 'link') {
    const { dotsLink } = await import('./dots-link.js');
    try { await dotsLink(process.argv[4]); }
    catch { console.error('Dots pairing failed. Use the fallback code from the Allow page: milo dots link <code>.'); process.exitCode = 1; }
  } else if (process.argv[2] === 'setup') {
    const { setup } = await import('./setup.js');
    try { const connection = await setup(); start({ ...process.env, MILO_FREELLMAPI_KEY: connection.key }); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Milo setup failed'); process.exitCode = 1; }
  } else start();
}
