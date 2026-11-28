import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, expect, it, onTestFinished } from 'vitest';
import { createLocalApp } from './api.js';
import { DiagnosticsStore, observeAttemptDispatch } from './diagnostics.js';
import { Sources } from './source.js';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

async function daemon(body: unknown, status = 200, diagnostics: {
  observe?: unknown;
  metrics?: (url: URL) => unknown;
} = {}) {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const reply = url.pathname === '/v1/status' ? body
      : url.pathname === '/v1/observe' ? diagnostics.observe
      : url.pathname === '/v1/diagnostics/metrics' ? diagnostics.metrics?.(url)
      : undefined;
    response.writeHead(reply === undefined ? 404 : status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply ?? {}));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  return { port: address.port, paths };
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  // If the status branch accidentally falls through to daemon startup, an
  // invalid source selection fails instead of signing up or claiming a port.
  return execute(process.execPath, ['--import', 'tsx', entry, ...args], {
    env: { ...process.env, NO_COLOR: '1', GRUNT_SOURCES: 'synthetic-never-start', ...env }, timeout: 15000,
  });
}

it('runs the real CLI status entry point without starting setup or probing models', async () => {
  const snapshot = { version: 1, updatedAt: Date.now(), activeRequests: 0,
    sources: [{ id: 'perch', state: 'ready', active: 0, model: 'deepseek-flash-starter', lastReplyMs: 1234 }] };
  const { port, paths } = await daemon(snapshot);
  const { stdout, stderr } = await cli(['status', '--port', String(port), '--json']);
  expect(JSON.parse(stdout)).toMatchObject(snapshot);
  expect(stderr).not.toContain('grunt model API');
  expect(paths).toEqual(['GET /v1/status']);
});

it('prints a single plain snapshot for a piped watch command', async () => {
  const { port, paths } = await daemon({ version: 1, updatedAt: Date.now(), activeRequests: 1,
    sources: [{ id: 'kilo', state: 'answering', active: 1, model: 'particle-ai/particle-1:free' }] });
  const { stdout } = await cli(['status', '--watch', '--port', String(port)]);
  expect(stdout.toLowerCase()).toContain('kilo');
  expect(stdout.toLowerCase()).toContain('answering');
  expect(stdout).not.toContain('\u001b');
  expect(paths).toEqual(['GET /v1/status']);
});

it('lists a route only after provider dispatch while a real loopback request is pending', async () => {
  const preflight = Promise.withResolvers<void>(), dispatch = Promise.withResolvers<void>();
  const dispatched = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const directory = await mkdtemp(join(tmpdir(), 'grunt-status-dispatch-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = await DiagnosticsStore.open({ directory });
  const sources = new Sources([{ id: 'fixture', available: async () => true, complete: async () => {
    preflight.resolve();
    await dispatch.promise;
    observeAttemptDispatch({ model: 'fixture/flash' });
    dispatched.resolve();
    await finish.promise;
    return { text: 'fixture reply' };
  } }]);
  sources.setDiagnostics(store);
  onTestFinished(async () => { await sources.close(); await store.close(); });
  let port = 0;
  const app = createLocalApp(sources, { cwd: directory, get port() { return port; } });
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.once('listening', resolve));
  port = (server.address() as { port: number }).port;
  const turn = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ model: 'grunt', messages: [{ role: 'user', content: 'A fixture request' }] })
  });
  const earlyReply = turn.then(response => { throw new Error(`Grunt answered early (HTTP ${response.status})`); });
  const status = () => cli(['status', '--port', String(port)]);
  try {
    await Promise.race([preflight.promise, earlyReply]);
    expect((await status()).stdout).toContain('Serving now: none (requests queued, in preflight, or finishing)');

    dispatch.resolve();
    await Promise.race([dispatched.promise, earlyReply]);
    expect((await status()).stdout).toContain('Serving now: fixture / fixture/flash');

    finish.resolve();
    expect((await turn).status).toBe(200);
  } finally {
    dispatch.resolve();
    finish.resolve();
    await turn.then(response => response.text()).catch(() => undefined);
  }
}, 20_000);

it('reports concurrent live routes, measured zero, estimates, and separate cooldown and reset times', async () => {
  const now = Date.now();
  const retryAt = now + 60_000;
  const resetAt = now + 600_000;
  const iso = (at: number) => new Date(at).toISOString();
  const snapshot = {
    version: 1, updatedAt: now, activeRequests: 2, poolState: 'working',
    sources: [
      { id: 'kilo', state: 'answering', active: 1, model: 'Free model rotation' },
      { id: 'perch', state: 'answering', active: 1 },
      { id: 'millionseek', state: 'limited', active: 0, lastSuccessAt: now - 2000,
        quotaWindow: { startedAt: now - 85400000, resetAt },
        quotaObserved: { unit: 'tokens', used: 1_000, remaining: 0, limit: 1_000, source: 'provider_header', observedAt: now - 1000 } },
      { id: 'kenari', state: 'ready', active: 0 },
      { id: 'zro', state: 'unavailable', active: 0, detail: 'private diagnostic text' },
      { id: 'apinex', state: 'disabled', active: 0 }
    ]
  };
  const observe = {
    version: 1,
    inFlight: [
      { kind: 'user', state: 'waiting_for_output', caller: 'private caller', attempts: [
        { provider: 'failed-route', model: 'old-model', endedAt: now },
        { provider: 'kilo', model: 'particle/flash:free', endedAt: null, dispatches: [{ at: now }] }
      ] },
      { kind: 'user', state: 'receiving_output', attempts: [{ provider: 'perch', model: 'perch-flash', endedAt: null }] },
      { kind: 'user', state: 'queued', attempts: [{ provider: 'queued-route', model: 'queued-model', endedAt: null }] },
      { kind: 'maintenance', state: 'waiting_for_output', attempts: [{ provider: 'health-check', model: 'probe-model', endedAt: null }] }
    ],
    routes: [{ id: 'millionseek', cooldown: { until: retryAt, reason: 'quota' } }]
  };
  const { port, paths } = await daemon(snapshot, 200, { observe, metrics: url => {
    const since = Number(url.searchParams.get('since'));
    return {
      version: 1, window: { until: Number(url.searchParams.get('until')), alignedSince: since },
      coverage: { available: true, startedAt: since - 1, deduplicationFloor: 0, droppedEvents: 0, droppedLateEvents: 0, overflowEvents: 0 },
      limits: { retentionDays: 30 },
      buckets: [{ hour: since, dimensions: { type: 'attempt.finish', source: 'kenari' }, count: 7,
        inputTokens: 0, outputTokens: 0, unknownInput: 7, unknownOutput: 7 }]
    };
  } });

  const { stdout } = await cli(['status', '--port', String(port)]);

  expect(stdout).toContain('Serving now: kilo / particle/flash:free, perch / perch-flash');
  expect(stdout).toContain(`Last successful route: millionseek at ${iso(now - 2000)}`);
  expect(stdout).toContain('Used 1000 tokens · remaining 0 tokens · limit 1000 tokens (measured via provider header');
  expect(stdout).toContain(`quota reset ${iso(resetAt)} · cooldown ${iso(retryAt)}`);
  expect(stdout).toContain('Used 7 requests · remaining 43 requests · limit 50 requests (estimate from local usage, day/account)');
  expect(stdout).toContain('zro · unavailable\n    Used unknown · remaining unknown · quota reset unknown');
  expect(stdout).toContain('apinex · disabled');
  expect(stdout).not.toMatch(/private|failed-route|queued-route|health-check|\u001b/);
  expect(paths).toHaveLength(3);
  expect(paths).toEqual(expect.arrayContaining(['GET /v1/status', 'GET /v1/observe?limit=0', expect.stringMatching(/^GET \/v1\/diagnostics\/metrics\?since=\d+&until=\d+$/)]));
});

it('reports idle and keeps the last success separate from the configured model', async () => {
  const now = Date.now();
  const { port, paths } = await daemon({ version: 1, updatedAt: now, activeRequests: 0, poolState: 'idle',
    sources: [{ id: 'zro', state: 'ready', active: 0, model: 'configured-flash', lastSuccessAt: now - 1000,
      quotaObserved: { unit: 'credits', used: 0, remaining: 2.5, source: 'provider_api', observedAt: now - 1000 } }] },
  200, { observe: { version: 1, inFlight: [], routes: [] } });
  const { stdout } = await cli(['status'], { GRUNT_PORT: String(port) });
  expect(stdout).toContain('Serving now: idle\nLast successful route: zro at ');
  expect(stdout).toContain('configured model configured-flash');
  expect(stdout).toContain('Used 0 credits · remaining 2.5 credits (measured via provider API');
  expect(paths).toEqual(['GET /v1/status', 'GET /v1/observe?limit=0']);
});

it('keeps confirmed status when observation or quota diagnostics are absent or incomplete', async () => {
  const now = Date.now();
  const snapshot = { version: 1, updatedAt: now, activeRequests: 1, sources: [
    { id: 'kenari', state: 'answering', active: 1, model: 'configured-model', lastSuccessAt: now - 1000 },
    { id: 'pollinations', state: 'ready', active: 0,
      quotaObserved: { unit: 'credits', remaining: 0, source: 'provider_api', observedAt: now - 1000 } }
  ] };
  const olderDaemon = await daemon(snapshot);
  const partialDaemon = await daemon(snapshot, 200, {
    observe: { version: 1, inFlight: [{ kind: 'user', state: 'receiving_output', attempts: [
      { provider: 'kenari', model: 'https://private-endpoint.invalid', endedAt: null }
    ] }], routes: [] },
    metrics: url => ({
      version: 1, window: { until: Number(url.searchParams.get('until')), alignedSince: Number(url.searchParams.get('since')) },
      coverage: { available: true, startedAt: now, deduplicationFloor: 0, droppedEvents: 0, droppedLateEvents: 0, overflowEvents: 0 },
      limits: { retentionDays: 30 }, buckets: []
    })
  });
  const [older, partial] = await Promise.all([olderDaemon, partialDaemon].map(({ port }) => cli(['status', '--port', String(port)])));
  expect(older!.stdout).toContain('Serving now: unknown (live route diagnostics unavailable)');
  expect(partial!.stdout).toContain('Serving now: kenari / unknown');
  for (const { stdout } of [older!, partial!]) {
    expect(stdout).toContain('kenari · answering · 1 active · configured model configured-model\n    Used unknown · remaining unknown');
    expect(stdout).toContain('Used unknown · remaining 0 credits (measured via provider API');
    expect(stdout).not.toMatch(/private-endpoint|estimate from local usage/);
  }
});

it('reports unreachable status without fetching diagnostics or exposing the response body', async () => {
  const { port, paths } = await daemon({ error: 'private daemon error' }, 503);
  await expect(cli(['status', '--port', String(port)])).rejects.toMatchObject({
    code: 1, stdout: '', stderr: `Grunt status unavailable on 127.0.0.1:${port}. Run usegrunt setup if the daemon is stopped.\n`
  });
  expect(paths).toEqual(['GET /v1/status']);
});

it('shows CLI help without booting the daemon', async () => {
  const { stdout } = await cli(['--help']);
  expect(stdout).toContain('update');
  expect(stdout).toContain('status');
  expect(stdout).toContain('--watch');
});

it('rejects unknown commands and invalid update arguments without starting the daemon or setup', async () => {
  await expect(cli(['updat'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown grunt command') });
  await expect(cli(['update', '--unexpected'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage: usegrunt update') });
});

it('reports that the removed workers and jobs commands no longer exist, for old scripts and help text', async () => {
  for (const args of [['workers', 'run'], ['workers', 'connect', 'pi'], ['workers', 'mcp']]) {
    await expect(cli(args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('subworkers were removed') });
  }
  for (const args of [['jobs', 'run', 'true'], ['jobs', 'status']]) {
    await expect(cli(args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('background jobs were removed') });
  }
  const help = (await cli(['--help'])).stdout;
  expect(help).not.toContain('workers'); expect(help).not.toContain('jobs');
}, 30_000);

it('asks for initial setup when update has no installed runtime, without running the wizard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-cli-update-missing-'));
  try {
    await expect(cli(['update'], { GRUNT_CONFIG_DIR: directory })).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('run npx usegrunt setup first')
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
