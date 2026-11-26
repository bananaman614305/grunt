import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DECLARATIVE_OPENAI_INSTALL, bundledRegistry } from '../registry.js';
import type { DeclarativeAdapter, Registry } from '../registry.js';
import { approveDataSharing, declarativeDataSharingPolicy, recordDataSharingConsent } from './data-sharing.js';
import {
  DECLARATIVE_STORE_LABEL,
  DeclarativeApi,
  createPublicHttpsFetcher,
  declarativeSquireStore,
  declarativeTransport,
  isCatalogOfferZeroPrice,
  isPublicResolvedAddress,
  isUsageZeroCost,
  setupDeclarativeApi
} from './declarative-api.js';
import { setupFallbacks } from './fallback-setup.js';
import { configure } from './main.js';
import { readDeclarativeProviderGrant, writeDeclarativeProviderGrant } from './provider-grant.js';
import { squireStore } from './setup.js';
import { Sources } from './source.js';
import type { ModelRequest, Tool } from './source.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const PROMO_HOST = 'api.promo.example';
const PROMO_ORIGIN = `https://${PROMO_HOST}`;
const PROMO_MODEL = 'deepseek-v4.1-flash:free';

function promoAdapter(overrides: Partial<DeclarativeAdapter> = {}): DeclarativeAdapter {
  return {
    id: 'promo-free',
    kind: 'model',
    tier: 'experimental',
    weight: 0.05,
    modalities: ['text'],
    install: DECLARATIVE_OPENAI_INSTALL,
    model: PROMO_MODEL,
    signup: 'https://promo.example/signup',
    hints: "On /signup press 'Continue with Google'. On /keys press 'Create key', type grunt, press 'Copy'.",
    expires: '2026-12-31',
    declarative: {
      baseUrl: PROMO_ORIGIN,
      apiPath: '/v1/chat/completions',
      modelsEndpoint: '/v1/models',
      zeroPriceCheck: 'models_catalog',
      disclosure: 'Prompts and tool context pass through Promo API and its upstream inference host.',
      policyVersion: '2026-11-25',
      policyUrl: 'https://promo.example/privacy',
      name: 'Promo Free',
      minContextLength: 65536
    },
    ...overrides
  };
}

let directory: string;
const servers: (() => Promise<void>)[] = [];

const nativeFetch = globalThis.fetch;

async function startSyntheticServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const seen: { url: string; method: string; auth: string | null }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const port = address.port;
  servers.push(() => new Promise(resolve => server.close(() => resolve())));

  // Assert exact HTTPS origin pinning before forwarding to the local synthetic test server.
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url: url.href, method: init?.method ?? 'GET', auth: headers.get('authorization') });
    if (url.origin !== PROMO_ORIGIN && url.origin !== 'https://trusty-squire-api.fly.dev') {
      throw new Error(`Unexpected outbound origin: ${url.origin}`);
    }
    const targetPath = url.origin === 'https://trusty-squire-api.fly.dev'
      ? url.pathname.replace(/^\/v1\/egress\/g_[A-Za-z0-9_-]+/, '')
      : url.pathname;
    return nativeFetch(`http://127.0.0.1:${port}${targetPath}${url.search}`, init);
  };
  return { fetcher, seen, port };
}

const sampleTool: Tool = {
  type: 'function',
  function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
};

const sampleRequest = (model = 'promo-free', tools: Tool[] = []): ModelRequest => ({
  model,
  messages: [{ role: 'user', content: 'Hello promo' }],
  tools,
  cwd: directory,
  stream: false
});

async function approve(adapter: DeclarativeAdapter) {
  await recordDataSharingConsent(directory, [adapter.id], [declarativeDataSharingPolicy(adapter)]);
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  directory = await mkdtemp(join(tmpdir(), 'grunt-declarative-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (servers.length) await servers.pop()!();
  await rm(directory, { recursive: true, force: true });
});

it('serves verified zero-price completions and native function tool calls against a synthetic server', async () => {
  const adapter = promoAdapter();
  await approve(adapter);
  const { fetcher, seen } = await startSyntheticServer((req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({
        data: [{ id: PROMO_MODEL, pricing: { prompt: '0', completion: '0' }, context_length: 131072, capabilities: { tool_calling: true } }]
      }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const payload = JSON.parse(body) as { model: string; tools?: Tool[] };
      expect(payload.model).toBe(PROMO_MODEL);
      if (payload.tools?.length) {
        res.end(JSON.stringify({
          model: PROMO_MODEL,
          choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }],
          usage: { prompt_tokens: 42, completion_tokens: 9, total_cost: 0 }
        }));
      } else {
        res.end(JSON.stringify({
          model: PROMO_MODEL,
          choices: [{ finish_reason: 'stop', message: { content: 'Promo ready' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, cost: '0.00' }
        }));
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const source = new DeclarativeApi(adapter.id, {
    directory,
    adapter: () => adapter,
    fetcher,
    now: () => NOW,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-promo-token' })
  });

  expect(source.inferenceOnly).toBe(true);
  expect(source.supportsFunctionTools).toBe(true);
  expect(await source.available()).toBe(true);

  const textReply = await source.complete(sampleRequest('grunt'), AbortSignal.timeout(3000));
  expect(textReply).toMatchObject({ text: 'Promo ready', servedModel: PROMO_MODEL, free: true, inputTokens: 12, outputTokens: 4 });

  const toolReply = await source.complete(sampleRequest('promo-free', [sampleTool]), AbortSignal.timeout(3000));
  expect(toolReply).toMatchObject({
    text: '',
    servedModel: PROMO_MODEL,
    free: true,
    calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]
  });
  expect(seen.every(call => call.auth === 'Bearer synthetic-promo-token')).toBe(true);
  expect(seen.every(call => call.url.startsWith(PROMO_ORIGIN))).toBe(true);
  await source.close();
});

it('supports SSE streaming transport with tool calls and rejects non-zero cost in streamed usage', async () => {
  const adapter = promoAdapter({
    declarative: { ...promoAdapter().declarative, zeroPriceCheck: 'none', stream: true }
  });
  await approve(adapter);
  let chargeCost = 0;
  const { fetcher } = await startSyntheticServer((_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const chunks = [
      { model: PROMO_MODEL, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_sse', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 15, completion_tokens: 7, total_cost: chargeCost } }
    ];
    res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  });

  const source = new DeclarativeApi(adapter.id, {
    directory,
    adapter: () => adapter,
    fetcher,
    now: () => NOW,
    loadGrant: async () => ({ base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_stream123', token: 'synthetic-proxy-token' })
  });
  expect(source.reportsProgress).toBe(true);
  const progress = vi.fn();
  const reply = await source.complete(sampleRequest('promo-free', [sampleTool]), AbortSignal.timeout(3000), progress);
  expect(reply).toMatchObject({
    servedModel: PROMO_MODEL,
    free: true,
    calls: [{ id: 'call_sse', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]
  });
  expect(progress).toHaveBeenCalled();

  chargeCost = 0.002;
  await expect(source.complete(sampleRequest('promo-free', [sampleTool]), AbortSignal.timeout(3000)))
    .rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('non-zero usage cost') });
  await source.close();
});

it.each([
  ['paid prompt price', [{ id: PROMO_MODEL, pricing: { prompt: '0.0001', completion: '0' }, context_length: 131072 }]],
  ['paid input price', [{ id: PROMO_MODEL, pricing: { unit: 'USD_PER_1M_TOKENS', input: 0.5, output: 0 }, context_length: 131072 }]],
  ['is_free false', [{ id: PROMO_MODEL, is_free: false, pricing: { prompt: '0', completion: '0' }, context_length: 131072 }]],
  ['no positive zero-price proof', [{ id: PROMO_MODEL, context_length: 131072 }]],
  ['duplicate model entries', [{ id: PROMO_MODEL, is_free: true, context_length: 131072 }, { id: PROMO_MODEL, is_free: true, context_length: 131072 }]],
  ['missing pinned model', [{ id: 'other-model', is_free: true, context_length: 131072 }]],
  ['context too small', [{ id: PROMO_MODEL, is_free: true, context_length: 8192 }]],
  ['tools disabled in catalog', [{ id: PROMO_MODEL, is_free: true, context_length: 131072, capabilities: { tool_calling: false } }]]
])('rejects catalog zero-price violations before inference: %s', async (_label, data) => {
  const adapter = promoAdapter();
  await approve(adapter);
  const { fetcher, seen } = await startSyntheticServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data })); return; }
    res.end(JSON.stringify({ model: PROMO_MODEL, choices: [{ message: { content: 'must not run' } }] }));
  });
  const source = new DeclarativeApi(adapter.id, {
    directory, adapter: () => adapter, fetcher, now: () => NOW,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });
  expect(await source.available()).toBe(false);
  await expect(source.complete(sampleRequest(), AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'refused' });
  expect(seen.some(call => call.url.endsWith('/chat/completions'))).toBe(false);
  await source.close();
});

it('rejects substituted model names and non-zero usage cost fields in JSON completions', async () => {
  const adapter = promoAdapter({ declarative: { ...promoAdapter().declarative, zeroPriceCheck: 'none' } });
  await approve(adapter);
  let payload: Record<string, unknown> = {
    model: 'paid-model-v9',
    choices: [{ finish_reason: 'stop', message: { content: 'substituted' } }]
  };
  const { fetcher } = await startSyntheticServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  const source = new DeclarativeApi(adapter.id, {
    directory, adapter: () => adapter, fetcher, now: () => NOW,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });

  await expect(source.complete(sampleRequest(), AbortSignal.timeout(3000)))
    .rejects.toMatchObject({ code: 'upstream', message: expect.stringContaining('unexpected model') });

  payload = {
    model: PROMO_MODEL,
    choices: [{ finish_reason: 'stop', message: { content: 'billed' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.01 }
  };
  await expect(source.complete(sampleRequest(), AbortSignal.timeout(3000)))
    .rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('non-zero usage cost') });

  expect(isUsageZeroCost({ prompt_tokens: 5, cost_details: { upstream_cost: 0.001 } })).toBe(false);
  expect(isUsageZeroCost({ prompt_tokens: 5, cost_details: { upstream_cost: 0 } })).toBe(true);
  expect(isCatalogOfferZeroPrice({ is_free: true, pricing: { prompt: '0', completion: '0' } })).toBe(true);
  await source.close();
});

it('enforces hard stop at expires cutoff, status retirement, hostile grant hosts, and changed policy versions', async () => {
  let currentAdapter = promoAdapter({ expires: '2026-12-31' });
  let clock = Date.parse('2026-12-31T23:59:59Z');
  await approve(currentAdapter);
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith('/v1/models')) {
      return Response.json({ data: [{ id: PROMO_MODEL, is_free: true, context_length: 131072 }] });
    }
    return Response.json({ model: PROMO_MODEL, choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  });

  const source = new DeclarativeApi(currentAdapter.id, {
    directory,
    adapter: () => currentAdapter,
    fetcher,
    now: () => clock,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });

  // Still valid 1 second before expiry cutoff.
  expect(await source.available()).toBe(true);
  fetcher.mockClear();

  // Hard stop at exact UTC expiry boundary (2027-01-01T00:00:00Z): zero network calls.
  clock = Date.parse('2027-01-01T00:00:00Z');
  expect(await source.available()).toBe(false);
  await expect(source.complete(sampleRequest(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();

  // Status inactive/expiring immediately stops dispatch.
  clock = NOW;
  for (const status of ['inactive', 'expiring'] as const) {
    currentAdapter = promoAdapter({ status });
    expect(await source.available()).toBe(false);
    await expect(source.complete(sampleRequest(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  }
  expect(fetcher).not.toHaveBeenCalled();

  // Policy version change invalidates older consent receipt.
  currentAdapter = promoAdapter({ declarative: { ...promoAdapter().declarative, policyVersion: '2026-12-01' } });
  expect(await source.available()).toBe(false);
  await expect(source.complete(sampleRequest(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('data sharing is not approved') });
  expect(fetcher).not.toHaveBeenCalled();

  // Hostile grant host never receives the Bearer token.
  currentAdapter = promoAdapter();
  const hostile = new DeclarativeApi(currentAdapter.id, {
    directory,
    adapter: () => currentAdapter,
    fetcher,
    now: () => NOW,
    loadGrant: async () => ({ base_url: 'https://attacker.example', token: 'synthetic-secret-token' })
  });
  expect(await hostile.available()).toBe(false);
  await expect(hostile.complete(sampleRequest(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
  await Promise.all([source.close(), hostile.close()]);
});

it('hot-adds a declarative adapter into an automatic pool without restart, routes tools, and retires immediately on status/expiry change', async () => {
  const promo = promoAdapter({ declarative: { ...promoAdapter().declarative, zeroPriceCheck: 'none' } });
  await approve(promo);
  await writeDeclarativeProviderGrant(promo.id, { base_url: PROMO_ORIGIN, token: 'synthetic-hotadd-key' }, directory);

  const { port } = await startSyntheticServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      model: PROMO_MODEL,
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_hot', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.ts"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }));
  });
  vi.spyOn(declarativeTransport, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  vi.spyOn(declarativeTransport, 'request').mockImplementation(((options: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
    expect(options.hostname).toBe('93.184.216.34');
    expect(options.servername).toBe(PROMO_HOST);
    return httpRequest({ hostname: '127.0.0.1', port, path: String(options.path), method: String(options.method), headers: options.headers as Record<string, string> }, cb);
  }) as never);

  let current: Registry = { ...bundledRegistry, adapters: [bundledRegistry.adapters.find(a => a.id === 'kilo')!] };
  const automatic = configure({ GRUNT_CONFIG_DIR: directory }, () => current);
  const manual = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: 'kilo' }, () => current);
  try {
    expect(automatic.sources.map(source => source.id)).toEqual(['kilo']);

    // Registry sync hot-adds the declarative promo with zero restart.
    current = {
      ...bundledRegistry,
      published: new Date(Date.parse(bundledRegistry.published) + 5000).toISOString(),
      adapters: [{ ...current.adapters[0]!, weight: 0.8 }, { ...promo, weight: 0.2 }]
    };
    automatic.adopt(current);
    manual.adopt(current);
    expect(automatic.sources.map(source => source.id)).toEqual(['kilo', 'promo-free']);
    expect(manual.sources.map(source => source.id)).toEqual(['kilo']);

    // Route directly to the hot-added declarative adapter with native tools.
    const reply = await automatic.complete(sampleRequest('promo-free', [sampleTool]), AbortSignal.timeout(3000));
    expect(reply.calls).toEqual([{ id: 'call_hot', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.ts"}' } }]);

    // Marking the promo inactive in the registry immediately blocks routing.
    current = {
      ...current,
      published: new Date(Date.parse(current.published) + 5000).toISOString(),
      adapters: [current.adapters[0]!, { ...promo, weight: 0.2, status: 'inactive' }]
    };
    await expect(automatic.complete(sampleRequest('promo-free'), AbortSignal.timeout(3000))).rejects.toThrow();
  } finally {
    await Promise.all([automatic.close(), manual.close()]);
  }
});

it('sets up a declarative adapter via Squire using registry signup, hints, and derived store, and refuses expired promos before connecting', async () => {
  const promo = promoAdapter();
  const registry: Registry = {
    ...bundledRegistry,
    adapters: [bundledRegistry.adapters[0]!, { ...promo, weight: 0.2 }]
  };
  expect(declarativeSquireStore(promo)).toEqual({
    service: 'promo-free',
    label: DECLARATIVE_STORE_LABEL,
    api_hosts: [PROMO_HOST],
    auth_shape: 'bearer'
  });
  expect(squireStore('promo-free', registry)).toEqual(declarativeSquireStore(promo));

  // Expired promo refuses before touching Squire.
  const connect = vi.fn(async () => {});
  await expect(setupDeclarativeApi(promoAdapter({ expires: '2026-11-24' }), {
    directory,
    squire: { credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } },
    notify: vi.fn(),
    connect,
    background: false,
    now: () => NOW
  })).rejects.toMatchObject({ reason: 'free promotion expired' });
  expect(connect).not.toHaveBeenCalled();

  // Approve data sharing via approveDataSharing with extraPolicies.
  const consent = await approveDataSharing({
    directory,
    providers: [promo.id],
    extraPolicies: [declarativeDataSharingPolicy(promo)],
    notice: () => {}
  });
  expect(consent.approved).toEqual([promo.id]);

  const { fetcher, port } = await startSyntheticServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: PROMO_MODEL, is_free: true, context_length: 131072 }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  vi.spyOn(declarativeTransport, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  vi.spyOn(declarativeTransport, 'request').mockImplementation(((options: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
    expect(options.hostname).toBe('93.184.216.34');
    expect(options.servername).toBe(PROMO_HOST);
    return httpRequest({ hostname: '127.0.0.1', port, path: String(options.path), method: String(options.method), headers: options.headers as Record<string, string> }, cb);
  }) as never);

  let signedUp = false;
  const squire = {
    signup: vi.fn(async (service: string, url: string) => {
      expect(service).toBe('promo-free');
      expect(url).toBe('https://promo.example/signup');
      signedUp = true;
    }),
    call: vi.fn(async (name: string) => {
      expect(name).toBe('list_credentials');
      return {
        credentials: signedUp ? [{
          service: 'promo-free',
          label: DECLARATIVE_STORE_LABEL,
          reference: 'vault://promo-free-1',
          allowed_hosts: [PROMO_HOST],
          field_names: ['api_key'],
          auth_strategy: 'api_key'
        }] : []
      };
    }),
    credentials: {
      list: vi.fn(async () => []),
      grant: vi.fn(async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-squire-token' }))
    },
    runs: { start: vi.fn(), get: vi.fn() }
  };

  const result = await setupFallbacks({
    directory,
    adapters: [promo.id],
    registry: () => registry,
    squire: squire as never,
    connect: async () => {},
    run: async () => {},
    notify: () => {}
  });
  expect(result.unavailable).toEqual([]);
  expect(squire.signup).toHaveBeenCalledOnce();
  expect((await stat(join(directory, 'promo-free.json'))).mode & 0o777).toBe(0o600);
  expect(await readDeclarativeProviderGrant(promo.id, directory)).toEqual({ base_url: PROMO_ORIGIN, token: 'synthetic-squire-token' });

  // Second run reuses the saved grant without calling Squire signup again.
  const notifications: string[] = [];
  await setupDeclarativeApi(promo, {
    directory, squire, notify: line => notifications.push(line), background: false, fetcher, now: () => NOW
  });
  expect(squire.signup).toHaveBeenCalledOnce();
  expect(notifications).toContain('promo-free: declarative free route reused');

  // Verify Sources routes through the newly provisioned declarative grant cleanly.
  const sources = new Sources([new DeclarativeApi(promo.id, { directory, registry: () => registry, fetcher, now: () => NOW })], { registry: () => registry, now: () => NOW });
  expect(await sources.sources[0]!.available()).toBe(true);
  await sources.close();
});

it.each([
  ['loopback IPv4', [{ address: '127.0.0.1', family: 4 }]],
  ['RFC1918 10/8', [{ address: '10.0.0.42', family: 4 }]],
  ['RFC1918 172.16/12', [{ address: '172.16.5.4', family: 4 }]],
  ['RFC1918 192.168/16', [{ address: '192.168.1.10', family: 4 }]],
  ['link-local metadata', [{ address: '169.254.169.254', family: 4 }]],
  ['loopback IPv6', [{ address: '::1', family: 6 }]],
  ['IPv4-mapped loopback', [{ address: '::ffff:127.0.0.1', family: 6 }]],
  ['link-local IPv6', [{ address: 'fe80::1', family: 6 }]],
  ['mixed public and private DNS records', [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]],
  ['empty DNS answer', []]
])('enforces public resolved IPs at connection time for catalog and completion requests: %s', async (_label, records) => {
  expect(isPublicResolvedAddress('93.184.216.34')).toBe(true);
  expect(isPublicResolvedAddress('127.0.0.1')).toBe(false);
  expect(isPublicResolvedAddress('::ffff:127.0.0.1')).toBe(false);

  const lookup = vi.fn(async () => records) as unknown as typeof declarativeTransport.lookup;
  const request = vi.fn() as unknown as typeof declarativeTransport.request;
  const adapter = promoAdapter();
  await approve(adapter);

  const catalogSource = new DeclarativeApi(adapter.id, {
    directory, adapter: () => adapter, lookup, httpsRequest: request, now: () => NOW,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });
  expect(await catalogSource.available()).toBe(false);
  await expect(catalogSource.complete(sampleRequest(), AbortSignal.timeout(2000)))
    .rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('not a public IP') });
  expect(request).not.toHaveBeenCalled();

  const completionOnly = promoAdapter({ declarative: { ...promoAdapter().declarative, zeroPriceCheck: 'none' } });
  const completionSource = new DeclarativeApi(completionOnly.id, {
    directory, adapter: () => completionOnly, lookup, httpsRequest: request, now: () => NOW,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });
  await expect(completionSource.complete(sampleRequest(), AbortSignal.timeout(2000)))
    .rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('not a public IP') });
  expect(request).not.toHaveBeenCalled();
  await Promise.all([catalogSource.close(), completionSource.close()]);
});

it('pins the verified public IP and preserves TLS servername on outbound connections and rejects redirects', async () => {
  const { port } = await startSyntheticServer((req, res) => {
    if (req.url === '/redirect') {
      res.statusCode = 302;
      res.setHeader('Location', 'https://127.0.0.1/secret');
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof declarativeTransport.lookup;
  const seenOptions: Record<string, unknown>[] = [];
  const request = ((options: Record<string, unknown>, cb: (res: IncomingMessage) => void) => {
    seenOptions.push(options);
    return httpRequest({ hostname: '127.0.0.1', port, path: String(options.path), method: String(options.method), headers: options.headers as Record<string, string> }, cb);
  }) as unknown as typeof declarativeTransport.request;
  const publicFetch = createPublicHttpsFetcher({ lookup, request });

  const ok = await publicFetch(`${PROMO_ORIGIN}/v1/models`, { headers: { Authorization: 'Bearer synthetic' } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
  expect(seenOptions[0]).toMatchObject({ hostname: '93.184.216.34', servername: PROMO_HOST, family: 4, port: 443 });
  expect((seenOptions[0]!.headers as Record<string, string>).host).toBe(PROMO_HOST);

  await expect(publicFetch(`${PROMO_ORIGIN}/redirect`)).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('redirect') });
});

it('rejects a registry update that mutates the adapter mid-preflight (TOCTOU)', async () => {
  let current = promoAdapter();
  await approve(current);
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith('/v1/models')) {
      // Simulate a registry sync replacing the model / baseUrl / policy while /models is in flight.
      current = promoAdapter({
        model: 'paid-model-swapped',
        declarative: { ...current.declarative, baseUrl: 'https://other.example', policyVersion: '2026-12-02' }
      });
      return Response.json({ data: [{ id: PROMO_MODEL, is_free: true, context_length: 131072 }] });
    }
    return Response.json({ model: 'paid-model-swapped', choices: [{ finish_reason: 'stop', message: { content: 'must not dispatch' } }] });
  });
  const source = new DeclarativeApi(current.id, {
    directory, adapter: () => current, fetcher, now: () => NOW,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });

  await expect(source.complete(sampleRequest(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions'))).toHaveLength(0);
  await source.close();
});

it('rejects nonzero monetary fields in catalog offers even alongside a free flag, and on every SSE stream event', async () => {
  for (const paidOffer of [
    { id: PROMO_MODEL, is_free: true, input_price: 0.25, context_length: 131072 },
    { id: PROMO_MODEL, free: true, fee: '0.01', context_length: 131072 },
    { id: PROMO_MODEL, is_free: true, billing: { prompt_usd: 0.001 }, context_length: 131072 },
    { id: PROMO_MODEL, is_free: true, rates: { output: 0.5 }, context_length: 131072 },
    { id: PROMO_MODEL, pricing: { prompt: '0', completion: '0', extra_fee: '0.0001' }, context_length: 131072 }
  ]) {
    expect(isCatalogOfferZeroPrice(paidOffer, 65536, NOW)).toBe(false);
  }

  // Earlier stream event reports nonzero cost; final stream event overwrites usage with zero cost.
  const streamAdapter = promoAdapter({
    declarative: { ...promoAdapter().declarative, zeroPriceCheck: 'none', stream: true }
  });
  await approve(streamAdapter);
  const { fetcher } = await startSyntheticServer((_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const chunks = [
      { model: PROMO_MODEL, choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }], usage: { prompt_tokens: 5, total_cost: 0.005 } },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_cost: 0 } }
    ];
    res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  const source = new DeclarativeApi(streamAdapter.id, {
    directory, adapter: () => streamAdapter, fetcher, now: () => NOW,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });
  await expect(source.complete(sampleRequest(), AbortSignal.timeout(3000)))
    .rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('non-zero usage cost') });
  await source.close();
});

it.each(['expires', 'inactive', 'mutated'] as const)('rechecks registry entry and expiry after pending DNS lookup before opening catalog or completion HTTPS (%s)', async change => {
  // 1) Catalog (/models) DNS pending while promo expires, retires, or mutates.
  let clock = Date.parse('2026-12-31T23:59:59Z');
  let catalogAdapter = promoAdapter({ expires: '2026-12-31' });
  await approve(catalogAdapter);
  let resolveCatalogDns!: (records: { address: string; family: number }[]) => void;
  const catalogLookup = vi.fn(() => new Promise<{ address: string; family: number }[]>(resolve => { resolveCatalogDns = resolve; })) as unknown as typeof declarativeTransport.lookup;
  const catalogHttps = vi.fn() as unknown as typeof declarativeTransport.request;
  const catalogSource = new DeclarativeApi(catalogAdapter.id, {
    directory, adapter: () => catalogAdapter, lookup: catalogLookup, httpsRequest: catalogHttps, now: () => clock,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });
  const pendingCatalog = catalogSource.complete(sampleRequest(), AbortSignal.timeout(3000));
  await vi.waitFor(() => expect(catalogLookup).toHaveBeenCalledOnce());
  if (change === 'expires') clock = Date.parse('2027-01-01T00:00:00Z');
  if (change === 'inactive') catalogAdapter = promoAdapter({ expires: '2026-12-31', status: 'inactive' });
  if (change === 'mutated') catalogAdapter = promoAdapter({ expires: '2026-12-31', model: 'swapped-model' });
  resolveCatalogDns([{ address: '93.184.216.34', family: 4 }]);
  await expect(pendingCatalog).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('expired or changed before connection') });
  expect(catalogHttps).not.toHaveBeenCalled();
  await catalogSource.close();

  // 2) Completion (/chat/completions) DNS pending while promo expires, retires, or mutates.
  clock = Date.parse('2026-12-31T23:59:59Z');
  let completionAdapter = promoAdapter({ expires: '2026-12-31', declarative: { ...promoAdapter().declarative, zeroPriceCheck: 'none' } });
  let resolveCompletionDns!: (records: { address: string; family: number }[]) => void;
  const completionLookup = vi.fn(() => new Promise<{ address: string; family: number }[]>(resolve => { resolveCompletionDns = resolve; })) as unknown as typeof declarativeTransport.lookup;
  const completionHttps = vi.fn() as unknown as typeof declarativeTransport.request;
  const completionSource = new DeclarativeApi(completionAdapter.id, {
    directory, adapter: () => completionAdapter, lookup: completionLookup, httpsRequest: completionHttps, now: () => clock,
    loadGrant: async () => ({ base_url: PROMO_ORIGIN, token: 'synthetic-key' })
  });
  const pendingCompletion = completionSource.complete(sampleRequest(), AbortSignal.timeout(3000));
  await vi.waitFor(() => expect(completionLookup).toHaveBeenCalledOnce());
  if (change === 'expires') clock = Date.parse('2027-01-01T00:00:00Z');
  if (change === 'inactive') completionAdapter = promoAdapter({ expires: '2026-12-31', status: 'expiring', declarative: { ...promoAdapter().declarative, zeroPriceCheck: 'none' } });
  if (change === 'mutated') completionAdapter = promoAdapter({ expires: '2026-12-31', declarative: { ...promoAdapter().declarative, zeroPriceCheck: 'none', apiPath: '/v2/paid/completions' } });
  resolveCompletionDns([{ address: '93.184.216.34', family: 4 }]);
  await expect(pendingCompletion).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('expired or changed before connection') });
  expect(completionHttps).not.toHaveBeenCalled();
  await completionSource.close();
});
