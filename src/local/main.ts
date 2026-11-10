#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createLocalApp } from './api.js';
import { Freebuff, positive } from './freebuff.js';
import { Gateway, Sources } from './source.js';
import type { Source } from './source.js';
export const HOST = '127.0.0.1';
export function configure(env = process.env) {
  const registered: Source[] = [...(env.MILO_GATEWAY_URL ? [new Gateway(env.MILO_GATEWAY_URL, env.MILO_GATEWAY_KEY ?? '')] : []), new Freebuff()];
  const ids = env.MILO_SOURCES?.split(',').map(id => id.trim()) ?? registered.map(s => s.id);
  return new Sources(ids.map(id => { const source = registered.find(s => s.id === id); if (!source) throw new Error(`Unknown Milo source: ${id}`); return source; }));
}
export function start() {
  const sources = configure();
  const port = positive(process.env.MILO_PORT, 8788);
  if (port > 65535) throw new Error('MILO_PORT must be at most 65535');
  const app = createLocalApp(sources, { port, log: cwd => console.error(`Milo working directory: ${cwd}`) });
  const server = serve({ fetch: app.fetch, hostname: HOST, port }, () => console.error(`Milo model API: http://${HOST}:${port}/v1`));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await sources.close(); server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) start();
