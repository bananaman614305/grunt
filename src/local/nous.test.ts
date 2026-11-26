import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { NOUS_FREE_MODEL, Nous, nousFreeAccountPolicy, nousHermesPaths } from './nous.js';
import { Sources } from './source.js';
import type { ModelRequest } from './source.js';

const origin = 'https://inference-api.nousresearch.com';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-nous-test-')); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

const free = {
  id: NOUS_FREE_MODEL,
  context_length: 1_000_000,
  pricing: { prompt: '0', completion: '0', input_cache_read: '0', input_cache_write: '0' },
  supported_parameters: ['tools', 'tool_choice']
};
const request: ModelRequest = { model: 'nous', messages: [{ role: 'user', content: 'Hello' }], tools: [], cwd: '/', stream: false };

function fixture(catalog: unknown = [free]) {
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input) === `${origin}/v1/models`) return Response.json({ data: catalog });
    return Response.json({ choices: [{ message: { content: 'Hello' } }] });
  });
  const loadGrant = vi.fn(async () => ({ base_url: origin, token: 'synthetic-oauth-token' }));
  const source = new Nous({ directory, fetcher, loadGrant });
  return { source, fetcher, loadGrant };
}

async function hermesFixture(mode: 'sse' | 'stall' | 'json' | 'quota') {
  const env = { GRUNT_HERMES_ROOT: join(directory, 'hermes') };
  const paths = nousHermesPaths(directory, env);
  const proxy = join(paths.root, 'hermes_cli', 'proxy');
  await mkdir(join(paths.root, 'venv', 'bin'), { recursive: true });
  await mkdir(join(proxy, 'adapters'), { recursive: true });
  await mkdir(paths.home, { mode: 0o700 });
  const python = execFileSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 5000 }).trim();
  await symlink(python, paths.python);
  await writeFile(join(paths.home, 'auth.json'), '{}', { mode: 0o600 });
  await writeFile(join(proxy, '..', 'auth.py'), String.raw`
def get_provider_auth_state(_):
    return {'portal_base_url': 'https://portal.nousresearch.com'}

def resolve_nous_access_token(**_):
    return 'synthetic'
`);
  await writeFile(join(proxy, 'adapters', 'nous_portal.py'), 'class NousPortalAdapter: pass\n');
  await writeFile(join(proxy, 'server.py'), 'def create_app(adapter): return adapter\n');
  await writeFile(join(paths.root, 'aiohttp.py'), String.raw`
import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace

print('Hermes library log')
mode = ${JSON.stringify(mode)}

class Response:
    def __init__(self, status=200, content_type='application/json', headers=None, payload=None, chunks=()):
        self.status, self.content_type, self.headers = status, content_type, headers or {}
        self.ok, self.payload, self.chunks = status < 300, payload, chunks
        self.content = self

    async def __aenter__(self): return self
    async def __aexit__(self, *_): pass
    async def json(self): return self.payload

    async def iter_chunked(self, _):
        for chunk in self.chunks:
            yield chunk
        if mode == 'stall':
            await asyncio.sleep(60)

class ClientSession:
    def __init__(self, **_): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *_): pass

    def get(self, *_args, **_kwargs):
        access = dict.fromkeys(['allowed', 'paid_access', 'active_subscription_is_paid', 'has_active_subscription'], False)
        access.update(dict.fromkeys(['subscription_credits_remaining', 'purchased_credits_remaining', 'total_usable_credits'], 0))
        return Response(payload={'paid_service_access': access, 'purchased_credits_remaining': 0})

    def post(self, _url, data, **_):
        payload = json.loads(data)
        assert payload['model'] == ${JSON.stringify(NOUS_FREE_MODEL)} and payload['stream'] is True
        assert payload['stream_options'] == {'include_usage': True}
        if mode == 'quota':
            return Response(status=429, headers={'Retry-After': '60', 'x-ratelimit-reset-requests-1h': '240'},
                            chunks=[b'{"error":{"resets_in_seconds":180}}'])
        if mode == 'json':
            return Response(chunks=[b'{"choices":[{"message":{"content":"Hello"}}]}'])
        chunks = [b'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n']
        if mode == 'sse':
            chunks.append(b'data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        return Response(content_type='text/event-stream', chunks=chunks)

class Runner:
    def __init__(self, *_args, **_kwargs): pass
    async def setup(self): pass
    async def cleanup(self): pass

class Site:
    def __init__(self, _, path): self.path = path
    async def start(self):
        Path(self.path).touch()
        Path('process.json').write_text(json.dumps({'pid': os.getpid(), 'path': self.path}))

web = SimpleNamespace(AppRunner=Runner, UnixSite=Site)
ClientTimeout = UnixConnector = SimpleNamespace
`);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ data: [free] })));
  await recordDataSharingConsent(directory, ['nous']);
  return { source: new Nous({ directory, env }), processInfo: join(paths.root, 'process.json') };
}

it.each([false, true])('stops a stalled Hermes SSE child after its first delta (client stream: %s)', async stream => {
  const { source, processInfo } = await hermesFixture('stall');
  const sources = new Sources([Object.assign(source, { firstOutputMs: 2000, idleMs: 50 })]);
  const onText = vi.fn();
  try {
    await expect(sources.complete({ ...request, stream }, AbortSignal.timeout(4000), onText)).rejects.toMatchObject({
      code: 'timeout', replay: stream ? 'unsafe' : 'safe', message: expect.stringContaining('no further output')
    });
    expect(onText).toHaveBeenCalledTimes(stream ? 1 : 0);
    const child = JSON.parse(await readFile(processInfo, 'utf8')) as { pid: number; path: string };
    await vi.waitFor(async () => {
      expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      await expect(lstat(join(child.path, '..'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  } finally { await sources.close(); }
});

it.each(['sse', 'json', 'quota'] as const)('preserves %s replies through the Hermes bridge', async mode => {
  const { source } = await hermesFixture(mode);
  try {
    const reply = source.complete(request, AbortSignal.timeout(2000));
    if (mode === 'quota') await expect(reply).rejects.toMatchObject({ code: 'quota', retryAfter: 240 });
    else await expect(reply).resolves.toEqual({ text: 'Hello' });
  } finally { await source.close(); }
});

it('routes a Grunt reply through the pinned Nous model after a fresh public catalog check', async () => {
  await recordDataSharingConsent(directory, ['nous']);
  const { source, fetcher } = fixture();
  const sources = new Sources([source]);
  try {
    const app = createLocalApp(sources, { port: 0 });
    const response = await app.fetch(new Request('http://127.0.0.1:0/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nous', messages: [{ role: 'user', content: 'Say hello' }] })
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-grunt-source')).toBe('nous');
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'Hello' } }] });
    expect(fetcher).toHaveBeenLastCalledWith(`${origin}/v1/chat/completions`, expect.objectContaining({
      body: expect.stringContaining(`"model":"${NOUS_FREE_MODEL}"`)
    }));
    const catalogCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/models'));
    expect(catalogCalls.length).toBeGreaterThan(0);
    for (const [, init] of catalogCalls) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  } finally { await sources.close(); }
});

it.each([
  { ...free, id: 'qwen/qwen4-max' },
  { ...free, context_length: 199_999 },
  { ...free, pricing: { prompt: '0', completion: '0.2' } },
  { ...free, pricing: { ...free.pricing, input_cache_write: '0.2' } },
  { ...free, pricing: { prompt: '0' } },
  { ...free, supported_parameters: [] }
])('refuses inference when the catalog entry does not qualify', async model => {
  await recordDataSharingConsent(directory, ['nous']);
  const { source, fetcher, loadGrant } = fixture([model]);
  try {
    await expect(source.complete({ model: 'nous', messages: [], tools: [] }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'refused' });
    expect(loadGrant).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${origin}/v1/models`, expect.anything());
  } finally { await source.close(); }
});

it('performs no network access when the user has not approved Nous', async () => {
  const { source, fetcher, loadGrant } = fixture();
  try {
    expect(await source.available()).toBe(false);
    await expect(source.complete({ model: 'nous', messages: [], tools: [] }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'refused' });
    expect(loadGrant).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await source.close(); }
});

it('learns the longest grounded reset from the Nous quota response', async () => {
  await recordDataSharingConsent(directory, ['nous']);
  const { source, fetcher } = fixture();
  fetcher.mockImplementation(async input => String(input).endsWith('/models')
    ? Response.json({ data: [free] })
    : Response.json({ error: { resets_in_seconds: 180, message: 'private-error' } }, {
      status: 429, headers: { 'x-ratelimit-reset-requests-1h': '240', 'Retry-After': '60' }
    }));
  try {
    await expect(source.complete({ model: 'nous', messages: [], tools: [] }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'quota', retryAfter: 240, message: 'nous returned HTTP 429' });
  } finally { await source.close(); }
});

it('requires zero paid entitlement, funds and subscription charges', () => {
  const access = { allowed: false, paid_access: false, has_active_subscription: false,
    active_subscription_is_paid: false, subscription_credits_remaining: 0,
    purchased_credits_remaining: 0, total_usable_credits: 0, subscription_monthly_charge: null };
  const free = { subscription: null, purchased_credits_remaining: 0, paid_service_access: access };
  const cases = [
    free,
    { ...free, subscription: { plan: 'Free', monthly_charge: 0 } },
    { ...free, subscription: { plan: 'Plus', monthly_charge: 20 } },
    { ...free, purchased_credits_remaining: 1 },
    { ...free, paid_service_access: { ...access, active_subscription_is_paid: true } },
    { ...free, paid_service_access: { ...access, allowed: false, paid_access: true } },
    { ...free, paid_service_access: { ...access, total_usable_credits: 1 } },
    { ...free, paid_service_access: {} }
  ];
  const script = `import json, sys\n${nousFreeAccountPolicy}\nprint(json.dumps([free_account(case) for case in json.load(sys.stdin)]))`;
  const outcome = execFileSync('python3', ['-I', '-c', script], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 5000 });
  expect(JSON.parse(outcome)).toEqual([true, true, false, false, false, false, false, false]);
});
