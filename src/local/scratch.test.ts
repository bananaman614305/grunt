import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLocalApp, decode } from './api.js';
import { Sources } from './source.js';
import { bundledRegistry } from '../registry.js';

afterEach(() => vi.unstubAllEnvs());
const body = (first = 'plant tomatoes') => ({ model: 'opencode', messages: [{ role: 'user', content: first }] });
it.each(['chat', 'messages', 'responses'])('decodes %s into a stable conversation scratch folder', api => {
  vi.stubEnv('XDG_STATE_HOME', '/tmp/grunt-scratch-test');
  const input = { ...body(), input: 'plant tomatoes' };
  const first = decode(input, api, undefined);
  expect(dirname(first.cwd)).toBe('/tmp/grunt-scratch-test/grunt/scratch');
  expect(first.cwd).not.toBe(process.cwd());
  expect(first.cwd).not.toBe(homedir());
  expect(decode({ ...body('paint a fence'), input: 'paint a fence' }, api, undefined).cwd).not.toBe(first.cwd);
  const messages = [...input.messages, { role: 'assistant', content: 'okay' }, { role: 'user', content: 'next step' }];
  expect(decode({ ...input, messages, input: messages }, api, undefined).cwd).toBe(first.cwd);
  expect(decode({ ...input, cwd: '/explicit' }, api, undefined).cwd).toBe('/explicit');
  expect(decode({ ...input, system: 'Working directory: /hint', instructions: 'Working directory: /hint' }, api, undefined).cwd).toBe('/hint');
  expect(decode(input, api, '/caller').cwd).toBe('/caller');
});
it('uses the home state directory when XDG_STATE_HOME is empty', () => {
  vi.stubEnv('XDG_STATE_HOME', '');
  expect(dirname(decode(body(), 'chat', undefined).cwd)).toBe(join(homedir(), '.local/state/grunt/scratch'));
});
// Reproduction scratch-cwd: public API -> routing realpath -> adapter's observed folder.
it('creates scratch before routing and reports its use in the log', async () => {
  const state = await mkdtemp(join(tmpdir(), 'grunt-scratch-'));
  vi.stubEnv('XDG_STATE_HOME', state);
  const log = vi.fn();
  const source = { id: 'opencode', available: async () => true, complete: async (request: { cwd: string }) => ({ text: await realpath(request.cwd) }) };
  const app = createLocalApp(new Sources([source], { registry: () => bundledRegistry }), { log });
  const send = async (input: unknown) => {
    const response = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    return (await response.json()).choices[0].message.content;
  };
  try {
    const first = await send(body());
    expect(dirname(first)).toBe(join(state, 'grunt/scratch'));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('cwd=scratch'));
    expect(await send({ ...body(), messages: [...body().messages, { role: 'assistant', content: 'okay' }, { role: 'user', content: 'next' }] })).toBe(first);
    expect(await send(body('paint a fence'))).not.toBe(first);
    expect(await send({ ...body(), cwd: state })).toBe(state);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('cwd=request'));
  } finally { await rm(state, { recursive: true, force: true }); }
});
