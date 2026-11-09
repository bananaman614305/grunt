import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createLocalApp, decode } from './api.js';
import { Freebuff, parseChat } from './freebuff.js';
import { Gateway, Sources, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { configure, HOST } from './main.js';
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const fake = (id = 'second-app'): Source => ({ id, available: async () => true, complete: async r => ({ text: r.messages.at(-1)!.content }) });
const paths = ['chat/completions', 'messages', 'responses'];
afterEach(() => vi.unstubAllEnvs());
describe('harness wire contracts', () => {
  for (const [name, path, api] of [['pi', paths[0], 'chat'], ['opencode', paths[0], 'chat'], ['claude', paths[1], 'messages'], ['codex', paths[2], 'responses']] as const) {
    for (const stream of [false, true]) it(`${name} ${stream ? 'SSE' : 'JSON'} through an independently registered app`, async () => {
      const body = await fixture(name); body.stream = stream;
      expect(body.tools.length).toBeGreaterThan(0);
      body.model = 'second-app';
      const app = createLocalApp(new Sources([fake()]));
      const response = await app.request(`/v1/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      expect(response.status).toBe(200);
      if (!stream) {
        const result = await response.json();
        if (api === 'chat') { expect(result.object).toBe('chat.completion'); expect(result.choices[0]).toMatchObject({ index: 0, finish_reason: 'stop', message: { role: 'assistant' } }); expect(typeof result.choices[0].message.content).toBe('string'); }
        if (api === 'messages') expect(result).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: expect.any(String) }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } });
        if (api === 'responses') expect(result).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: expect.any(String), annotations: [] }] }] });
      } else {
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const frames = (await response.text()).trim().split('\n\n').filter(f => f.includes('data:'));
        const data = frames.map(f => f.split('\n').find(l => l.startsWith('data:'))!.slice(5).trim());
        if (api === 'chat') {
          expect(data.pop()).toBe('[DONE]');
          const chunks = data.map(d => JSON.parse(d));
          for (const c of chunks) expect(c).toMatchObject({ id: expect.any(String), object: 'chat.completion.chunk', created: expect.any(Number), choices: [{ index: 0, delta: expect.any(Object) }] });
          expect(chunks[0].choices[0].delta.role).toBe('assistant');
          expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
        } else {
          const items = data.map(d => JSON.parse(d));
          const expected = api === 'messages' ? ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'] : ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed'];
          expect(items.map(i => i.type)).toEqual(expected);
          items.forEach((item, index) => { expect(frames[index]).toContain(`event: ${item.type}`); if (api === 'responses') expect(item.sequence_number).toBe(index); });
          if (api === 'messages') { expect(items[0].message.content).toEqual([]); expect(items[2].delta).toMatchObject({ type: 'text_delta', text: expect.any(String) }); }
          else { expect(items[4]).toMatchObject({ output_index: 0, content_index: 0, item_id: expect.any(String), delta: expect.any(String) }); expect(items.at(-1).response.status).toBe('completed'); }
        }
      }
    });
  }
});
it('models, failover, last typed error and loopback binding', async () => {
  const bad: Source = { ...fake('bad'), complete: async () => { throw new SourceError('quota', 'Free hours exhausted'); } };
  const app = createLocalApp(new Sources([bad, fake()]));
  expect((await (await app.request('/v1/models')).json()).data.map((m: { id: string }) => m.id)).toEqual(['milo', 'bad', 'second-app']);
  const body = JSON.stringify({ model: 'milo', messages: [{ role: 'user', content: 'hello' }] });
  expect((await (await app.request('/v1/chat/completions', { method: 'POST', body })).json()).choices[0].message.content).toBe('hello');
  for (const path of paths) {
    const response = await createLocalApp(new Sources([bad])).request(`/v1/${path}`, { method: 'POST', body: JSON.stringify({ input: 'hello', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('quota');
  }
  const server = serve({ fetch: app.fetch, hostname: HOST, port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  expect(server.address()).toMatchObject({ address: '127.0.0.1' });
  await new Promise<void>(resolve => server.close(() => resolve()));
  expect(() => configure({ MILO_SOURCES: 'unknown' })).toThrow('Unknown');
});
it('gateway only calls configured origin, preserves tools, rejects redirects and fails over availability errors', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'gateway reply' } }] }));
  const gateway = new Gateway('https://configured.invalid/v1', 'synthetic', fetcher);
  const request = decode(await fixture('pi'), 'chat', '/tmp');
  expect(await gateway.complete(request, new AbortController().signal)).toMatchObject({ text: 'gateway reply' });
  expect(fetcher.mock.calls[0]![0]).toBe('https://configured.invalid/v1/chat/completions');
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic' } });
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).tools).toEqual(request.tools);
  const bad = new Gateway('https://configured.invalid/v1', '', async () => { throw new Error('offline'); });
  expect(await new Sources([bad, fake()]).complete(request, new AbortController().signal)).toMatchObject({ text: request.messages.at(-1)!.content });
});
it('cwd inference and changed Freebuff format fail clearly', async () => {
  const sample = await fixture('freebuff');
  expect(parseChat(sample, sample[1].content)).toBe('bridge works 42');
  expect(() => parseChat({}, '')).toThrow('format changed');
  expect(decode(await fixture('claude'), 'messages', '/fallback').cwd).toBe('/tmp/milo-harness-cwd');
  expect(decode({ input: 'hi', instructions: '<cwd>/tmp/codex</cwd>' }, 'responses', '/fallback').cwd).toBe('/tmp/codex');
  expect(decode({ messages: [{ role: 'user', content: 'hi' }] }, 'chat', '/fallback').cwd).toBe('/fallback');
  expect(() => decode({ input: 'hi', cwd: 'relative' }, 'responses', '/fallback')).toThrow('absolute');
});
it('fake Freebuff on real tmux isolates concurrent identical requests, queues, cleans up, times out and makes no fetch calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'milo-app-'));
  const originalPath = process.env.PATH;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('local path must not fetch'));
  const driver = new Freebuff({ home: dir, pool: 2, timeout: 8000, startup: 200, poll: 20 });
  try {
    await copyFile(new URL('./fixtures/fake-freebuff.cjs', import.meta.url), join(dir, 'freebuff')); await chmod(join(dir, 'freebuff'), 0o755);
    vi.stubEnv('PATH', `${dir}:${originalPath}`); vi.stubEnv('MILO_TEST_HOME', dir);
    expect(await driver.available()).toBe(true);
    const request: ModelRequest = { model: 'freebuff', messages: [{ role: 'user', content: 'same prompt' }], tools: [], stream: false, cwd: dir };
    const app = createLocalApp(new Sources([driver]));
    const results = await Promise.all(Array.from({ length: 3 }, () => app.request('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ ...request, messages: request.messages }) }).then(r => r.json())));
    expect(results.map(r => r.choices[0].message.content)).toEqual(['same prompt', 'same prompt', 'same prompt']);
    expect(fetcher).not.toHaveBeenCalled();
    const timeout = new Freebuff({ home: dir, timeout: 500, startup: 100, poll: 20 });
    await expect(timeout.complete({ ...request, messages: [{ role: 'user', content: 'NEVER_COMPLETE' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
    await timeout.close();
    vi.stubEnv('PATH', dir);
    await expect(driver.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'not_installed' });
    vi.stubEnv('PATH', '/nonexistent');
    expect(await driver.available()).toBe(false);
  } finally { vi.stubEnv('PATH', originalPath ?? ''); await driver.close(); fetcher.mockRestore(); await rm(dir, { recursive: true, force: true }); }
}, 15000);
it('gateway tool replies retain their wire shapes and tool results survive translation', async () => {
  const tool = { id: 'call_1', type: 'function' as const, function: { name: 'read', arguments: '{"path":"a.txt"}' } };
  const source: Source = { ...fake(), complete: async () => ({ text: '', calls: [tool] }) };
  const app = createLocalApp(new Sources([source]));
  for (const path of paths) {
    const response = await app.request(`/v1/${path}`, { method: 'POST', body: JSON.stringify({ input: 'read', messages: [{ role: 'user', content: 'read' }] }) });
    const result = await response.json();
    if (path === 'messages') expect(result).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } }] });
    if (path === 'responses') expect(result.output).toMatchObject([{ type: 'function_call', call_id: 'call_1', arguments: tool.function.arguments }]);
    if (path === 'chat/completions') expect(result.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { tool_calls: [tool] } });
  }
  const turn = decode({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'file contents' }] }] }] }, 'messages', '/tmp');
  expect(turn.messages).toEqual([{ role: 'assistant', content: '', tool_calls: [tool] }, { role: 'tool', content: 'file contents', tool_call_id: 'call_1' }]);
});
it('README includes copyable config for each harness', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  for (const name of ['opencode', 'pi', 'Claude Code', 'Codex']) expect(readme).toContain(name);
  for (const key of ['baseURL', 'openai-completions', 'ANTHROPIC_BASE_URL', 'wire_api = "responses"']) expect(readme).toContain(key);
});
