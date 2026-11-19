import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { createLocalApp } from './api.js';
import { approveDataSharing, recordDataSharingConsent } from './data-sharing.js';
import { Goedel } from './goedel.js';
import { RegistrySource } from './registry-source.js';
import { SourceError, Sources, type ModelRequest } from './source.js';

let directory: string;
const grant = { base_url: 'https://api.goedelmachines.com', token: 'sk-gm-free-test' };
const model = 'deepseek/deepseek-v4.1-flash';
const key = (tier = 'free') => Response.json({ data: { tier } }, { headers: { 'X-Data-Policy': 'retained' } });
const toolCall = { id: 'call-one', type: 'function', function: { name: 'setup_ready', arguments: '{}' } };
const reply = (responseModel = model) => Response.json({ model: responseModel,
  choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [toolCall] } }],
  usage: { prompt_tokens: 20, completion_tokens: 10 } });
const request = (): ModelRequest => ({ model: 'grunt', messages: [{ role: 'user', content: 'Synthetic probe.' }], tools: [], cwd: directory, stream: false });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-goedel-test-'));
  await recordDataSharingConsent(directory, ['goedel']);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('allows public-context automatic requests and normalizes native tool calls', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/v1/key') ? key() : reply());
  const source = new Goedel({ directory, fetcher, loadGrant: async () => grant });
  const sources = new Sources([source], { registry: () => bundledRegistry });
  const app = createLocalApp(sources, { cwd: directory });
  const call = (headers: Record<string, string>, payload: object) => app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ...request(), ...payload })
  });
  try {
    const denied = await call({}, { model: 'goedel', publicContext: true });
    expect(await denied.json()).toMatchObject({ error: { code: 'refused' } });
    expect(fetcher).not.toHaveBeenCalled();
    const allowed = await call({ 'X-Grunt-Context': 'public' }, { tools: [
      { type: 'function', function: { name: 'setup_ready', parameters: { type: 'object' } } }
    ] });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('X-Grunt-Source')).toBe('goedel');
    expect(await allowed.json()).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [toolCall] } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 } });
    const [url, init] = fetcher.mock.calls.at(-1)!;
    expect(url).toBe('https://api.goedelmachines.com/v1/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model });
    expect(allowed.headers.has('X-Grunt-Context')).toBe(false);
  } finally { await sources.close(); }
});

it.each([false, true])('skips Gödel before provider contact on unclassified traffic (mixed=%s)', async mixed => {
  const fetcher = vi.fn<typeof fetch>();
  const source = new Goedel({ directory, fetcher, loadGrant: async () => grant });
  const complete = vi.spyOn(source, 'complete');
  const registry = () => bundledRegistry;
  const sources = new Sources([mixed ? new RegistrySource(source, registry) : source,
    { id: 'kilo', available: async () => true, complete: async () => ({ text: 'other' }) }],
  mixed ? undefined : { registry, random: () => 0 });
  try {
    await expect(sources.complete(request(), AbortSignal.timeout(5000))).resolves.toMatchObject({ text: 'other' });
    if (!mixed) await expect(sources.complete({ ...request(), publicContext: true, worker: { id: 'synthetic-worker', onSource() {} } },
      AbortSignal.timeout(5000))).resolves.toMatchObject({ text: 'other' });
    expect(complete).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await sources.close(); }
});

it('stops before sending messages with a paid key, revoked consent, or an unchecked handoff', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => key('paid'));
  const squireGrant = { base_url: 'https://trusty-squire-api.fly.dev/test-grant', token: 'test' };
  const source = new Goedel({ directory, fetcher, loadGrant: async () => squireGrant });
  const signal = AbortSignal.timeout(5000);
  const publicRequest = { ...request(), publicContext: true } as const;
  try {
    await expect(source.complete(publicRequest, signal)).rejects.toMatchObject({ code: 'logged_out' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([squireGrant.base_url + '/v1/key']);
    fetcher.mockClear();
    await expect(source.complete({ ...publicRequest, handoffPrompt: 'private diff' }, signal)).rejects.toMatchObject({ code: 'refused' });
    await approveDataSharing({ directory, providers: ['goedel'], env: { GRUNT_SETUP_NO_DATA_SHARING: '1' } });
    await expect(source.complete(publicRequest, signal)).rejects.toMatchObject({ code: 'logged_out' });
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await source.close(); }
});

it('rejects a different upstream model', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/v1/key') ? key() : reply('another-model'));
  const source = new Goedel({ directory, fetcher, loadGrant: async () => grant });
  try {
    await expect(source.complete({ ...request(), publicContext: true }, AbortSignal.timeout(5000))).rejects.toBeInstanceOf(SourceError);
  } finally { await source.close(); }
});


it('uses the fixed public probe for daily maintenance', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/v1/key') ? key()
    : Response.json({ model, choices: [{ message: { content: 'Hello.' } }] }));
  const source = new Goedel({ directory, fetcher, loadGrant: async () => grant });
  const sources = new Sources([source], { registry: () => bundledRegistry });
  try {
    await expect(sources.check('goedel', AbortSignal.timeout(5000))).resolves.toMatchObject({ outcome: 'passed', evidence: 'reply' });
    const [, init] = fetcher.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body)).messages).toEqual([{ role: 'user', content: 'Say hello in one short sentence.' }]);
  } finally { await sources.close(); }
});
