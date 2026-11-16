import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenCode } from './opencode.js';
import { idleEvents } from './fixtures/opencode-events.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-opencode-worker-'));
  await writeFile(join(directory, 'opencode'), '#!' + process.execPath + '\n' +
    'console.log("http://127.0.0.1:19778"); setInterval(() => {}, 1000);\n', { mode: 0o700 });
  vi.stubEnv('PATH', directory + ':' + process.env.PATH);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

const request = { model: 'opencode', cwd: '/tmp', messages: [{ role: 'user', content: 'Reply OK.' }], tools: [], stream: false };

it('removes inherited MCP schemas before prompting its own worker, once per working directory', async () => {
  const disconnected = new Set<string>(), calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const cwd = new Headers(init?.headers).get('x-opencode-directory')!;
    calls.push(path);
    if (path === '/mcp') return Response.json({ 'large tools': { status: 'connected' }, offline: { status: 'disabled' } });
    if (path === '/mcp/large%20tools/disconnect') { disconnected.add(cwd); return Response.json(true); }
    if (path === '/event') return idleEvents();
    if (path.endsWith('/message')) {
      if (!disconnected.has(cwd)) throw new Error('Inherited tool catalog causes compaction loop');
      return Response.json({ parts: [{ type: 'text', text: 'OK' }] });
    }
    return Response.json({ id: 'worker_session' });
  };
  const worker = new OpenCode({ fetcher });
  try {
    expect((await worker.complete(request, AbortSignal.timeout(5000))).text).toBe('OK');
    await worker.complete({ ...request, messages: [...request.messages, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Again.' }] }, AbortSignal.timeout(5000));
    await worker.complete({ ...request, cwd: directory }, AbortSignal.timeout(5000));
    expect(calls.filter(path => path === '/mcp')).toHaveLength(2);
    expect(calls.filter(path => path.endsWith('/disconnect'))).toEqual(['/mcp/large%20tools/disconnect', '/mcp/large%20tools/disconnect']);
  } finally { await worker.close(); }
});

it('stops before sending a prompt when worker MCP disconnection fails', async () => {
  const calls: string[] = [];
  let failing = true;
  const worker = new OpenCode({ fetcher: async url => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path === '/mcp') return Response.json({ arbitrary: { status: 'connected' } });
    if (path.endsWith('/disconnect')) return failing ? new Response('synthetic upstream detail', { status: 500 }) : Response.json(true);
    if (path === '/event') return idleEvents();
    return Response.json({ id: 'worker_session', parts: [{ type: 'text', text: 'unexpected' }] });
  } });
  try {
    await expect(worker.complete(request, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'upstream', message: 'OpenCode returned HTTP 500' });
    expect(calls).not.toContain('/session');
    failing = false;
    expect((await worker.complete(request, AbortSignal.timeout(5000))).text).toBe('unexpected');
    expect(calls.filter(path => path === '/mcp')).toHaveLength(2);
  } finally { await worker.close(); }
});

it('leaves a user-owned OpenCode server and its MCP connections alone', async () => {
  const paths: string[] = [];
  const worker = new OpenCode({ url: 'http://127.0.0.1:19778', fetcher: async url => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path === '/event') return idleEvents();
    return Response.json({ id: 'external_session', parts: [{ type: 'text', text: 'OK' }] });
  } });
  try {
    expect((await worker.complete(request, AbortSignal.timeout(5000))).text).toBe('OK');
    expect(paths).not.toContain('/mcp');
  } finally { await worker.close(); }
});

it('keeps shared worker preparation alive when one of two callers cancels', async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = new OpenCode({ fetcher: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/mcp') {
      started();
      await Promise.race([gate, new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))]);
      return Response.json({});
    }
    if (path === '/event') return idleEvents();
    return Response.json({ id: 'worker_session', parts: [{ type: 'text', text: 'OK' }] });
  } });
  const caller = new AbortController();
  try {
    const first = worker.complete(request, caller.signal).then(value => ({ value }), error => ({ error }));
    await ready;
    const second = worker.complete(request, AbortSignal.timeout(5000)).then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setTimeout(resolve, 10));
    caller.abort();
    expect(await first).toMatchObject({ error: { name: 'AbortError' } });
    release();
    expect(await second).toEqual({ value: { text: 'OK' } });
  } finally { release(); await worker.close(); }
});
