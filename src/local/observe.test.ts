import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { DiagnosticsStore, observeAttemptDispatch, observeAttemptQueue } from './diagnostics.js';
import { observeCommand } from './observe-cli.js';
import type { Observation } from './observe.js';
import { SourceError, Sources, truncatedCompletion } from './source.js';
import type { Source } from './source.js';

const host = 'http://127.0.0.1:8788';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

async function localApp(routes: Source[], options: { maxEvents?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-observe-'));
  const store = await DiagnosticsStore.open({ directory, runtimeVersion: '1.2.3', ...options });
  const sources = new Sources(routes);
  sources.setDiagnostics(store);
  cleanups.push(async () => { await sources.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const app = createLocalApp(sources, { cwd: directory, observation: () => ({
    version: '1.2.3', startedAt: Date.now() - 1500, port: 8788, config: {
      telemetry: false, backgroundAccountAcquisition: false, registry: 'custom',
      redactedSettings: ['OPENCODE_URL']
    }
  }) });
  return { app, store, directory };
}

it('shows a live queue, failed route, dispatch and first progress before the response settles', async () => {
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
  const progressed = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
  const prompt = 'private-prompt-é', answer = 'private-answer-é';
  const storedSecret = 'sk-never-share-this-secret';
  let position = 2;
  const denied: Source = { id: 'denied', acceptsRequest: () => false, available: vi.fn(), complete: vi.fn() };
  const quota: Source = { id: 'quota', available: async () => true, complete: async () => {
    observeAttemptDispatch({ model: 'quota-model', account: 'vaulted' });
    throw new SourceError('quota', `provider echoed ${storedSecret} and ${prompt}`, 60, undefined, { httpStatus: 429 });
  } };
  const fallback: Source = { id: 'fallback', available: async () => true, reportsProgress: true, complete: async (_request, _signal, progress) => {
    observeAttemptQueue(() => position);
    entered.resolve();
    await proceed.promise;
    observeAttemptDispatch({ model: 'served/model', account: 'anonymous', maxOutputTokens: 4096 });
    progress?.();
    progressed.resolve();
    await reply.promise;
    return truncatedCompletion(answer, { prompt_tokens: 17, completion_tokens: 8,
      ...{ completion_tokens_details: { reasoning_tokens: 3 } } }, 'max_tokens');
  } };
  const { app, store } = await localApp([denied, quota, fallback]);
  const turn = app.request(`${host}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Grunt-Caller': 'beeline-ruby', Authorization: `Bearer ${storedSecret}` },
    body: JSON.stringify({ model: 'grunt', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }) });
  const read = async () => {
    const response = await app.request(`${host}/v1/observe?limit=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = await response.text();
    for (const secret of [storedSecret, prompt, answer, 'provider echoed']) expect(json).not.toContain(secret);
    return JSON.parse(json) as Observation;
  };
  try {
    await entered.promise;
    expect(await read()).toMatchObject({
      version: 1,
      daemon: { version: '1.2.3', uptimeMs: expect.any(Number), readiness: 'ready', config: {
        host: '127.0.0.1', port: 8788, routing: 'ordered_chain', redactedSettings: ['OPENCODE_URL']
      } },
      diagnostics: { historyAvailable: true, health: { available: true, droppedEvents: 0 },
        losses: { persistentDroppedEvents: 0, droppedLateEvents: 0, overflowEvents: 0 } },
      inFlight: [{ caller: 'beeline-ruby', endpoint: 'chat', model: 'grunt', selectedRoute: 'fallback',
        state: 'queued', stateDurationMs: expect.any(Number), queuePosition: 2, promptBytes: Buffer.byteLength(prompt), responseBytes: null,
        maxOutputTokens: 4096, attempts: [
          { provider: 'quota', model: 'quota-model', account: 'vaulted', startedAt: expect.any(Number), firstTokenAt: null, endedAt: expect.any(Number),
            outcome: 'failed', errorCode: 'quota', httpStatus: 429, errorText: 'Provider quota or rate limit was reached (HTTP 429)', retryAfterSeconds: 60 },
          { provider: 'fallback', endedAt: null, outcome: null, account: null }
        ],
        routeDecisions: expect.arrayContaining([{ route: 'denied', decision: 'skipped', reason: 'context_not_approved', at: expect.any(Number) }])
      }],
      completed: [],
      routes: expect.arrayContaining([expect.objectContaining({ id: 'quota', state: 'limited', retryAt: expect.any(Number) })])
    });
    expect(denied.complete).not.toHaveBeenCalled();
    position = 1;
    expect((await read()).inFlight[0]?.queuePosition).toBe(1);
    proceed.resolve();
    await progressed.promise;
    const live = (await read()).inFlight[0]!;
    expect(live).toMatchObject({ state: 'receiving_output', queuePosition: null });
    expect(live.attempts[1]).toMatchObject({ account: 'anonymous', model: 'served/model', firstTokenAt: expect.any(Number),
      lastProgressAt: live.attempts[1]!.firstTokenAt, maxOutputTokens: 4096 });

    reply.resolve();
    const response = await turn;
    expect(response.status).toBe(200);
    const report = await read();
    expect(report.inFlight).toEqual([]);
    expect(report.completed).toMatchObject([{ id: response.headers.get('X-Grunt-Request-Id'), outcome: 'passed', endedAt: expect.any(Number),
      responseBytes: Buffer.byteLength(answer), attempts: [{ outcome: 'failed' }, {
        outcome: 'passed', endedAt: expect.any(Number), firstTokenAt: live.attempts[1]!.firstTokenAt,
        finishReason: 'length', providerFinishReason: 'max_tokens', tokens: { input: 17, output: 8, reasoning: 3, outputExcludingReasoning: 5 }
      }]
    }]);
    expect(JSON.stringify(await store.trace(live.id))).not.toMatch(/private-prompt|private-answer|never-share/);
  } finally {
    proceed.resolve();
    reply.resolve();
    await turn;
  }
});

it('uses the existing journal for recent history and the same local response for CLI output', async () => {
  const { app, store, directory } = await localApp([{ id: 'fixture', available: async () => true, complete: async () => ({ text: 'response' }) }]);
  const oldest = randomUUID(), newest = randomUUID(), priorProcess = randomUUID(), at = Date.now() - 100;
  for (const [requestId, type, offset] of [[oldest, 'request.start', 0], [newest, 'request.start', 5],
    [newest, 'request.finish', 10], [oldest, 'request.finish', 15]] as const) {
    store.record({ version: 1, id: randomUUID(), type, requestId, at: at + offset, kind: 'user', actor: 'client' });
  }
  await store.flush();
  const sibling = await DiagnosticsStore.open({ directory });
  try { sibling.record({ version: 1, id: randomUUID(), requestId: priorProcess, type: 'request.start', at: at + 20, kind: 'user', actor: 'client' }); }
  finally { await sibling.close(); }
  const output = vi.fn();
  const fetcher: typeof fetch = async input => app.request(String(input));
  await observeCommand(['--json', '--limit', '1', '--port', '8788'], { output, fetcher });
  const report = JSON.parse(output.mock.calls[0]![0] as string) as Observation;
  expect(report.inFlight).toEqual([]);
  expect(report.completed.map(item => item.id)).toEqual([oldest]);
  await observeCommand(['--limit', '2'], { output, fetcher, env: { GRUNT_PORT: '8788' } });
  expect(output.mock.calls[1]?.[0]).toContain('Completed (2)');
  expect(output.mock.calls[1]?.[0]).toContain(newest);
  expect(output.mock.calls[1]?.[0]).not.toContain(priorProcess);
  const liveOnly = await app.request(`${host}/v1/observe?limit=0`);
  expect(await liveOnly.json()).toMatchObject({ completed: [] });
  expect((await app.request(`${host}/v1/observe?limit=-1`)).status).toBe(400);
  expect((await app.request(`${host}/v1/observe`, { headers: { Origin: 'https://external.example' } })).status).toBe(403);
  expect((await app.request('http://external.example/v1/observe')).status).toBe(403);
});

it('shows a request completed across separate batches when incidents fill the journal', async () => {
  const maxEvents = 50;
  const fixture: Source = { id: 'fixture', available: async () => true, complete: async () => ({ text: 'response' }) };
  const { app, store } = await localApp([fixture], { maxEvents });
  const at = Date.now() - 100;
  store.record({ version: 1, id: randomUUID(), requestId: randomUUID(), type: 'request.finish', at,
    kind: 'user', actor: 'client', outcome: 'failed' });
  for (let i = 1; i < maxEvents; i++) {
    store.record({ version: 1, id: randomUUID(), requestId: randomUUID(), type: 'transport.finish', at,
      kind: 'diagnostic', outcome: 'failed' });
  }
  const fullJournal = (await store.list()).events;
  expect(fullJournal).toHaveLength(maxEvents);
  expect(fullJournal.every(event => event.outcome === 'failed')).toBe(true);

  const requestId = randomUUID(), startedAt = at + 10, endedAt = at + 20;
  store.record({ version: 1, id: randomUUID(), requestId, type: 'request.start', at: startedAt, kind: 'user', actor: 'client' });
  await store.flush();
  store.record({ version: 1, id: randomUUID(), requestId, type: 'request.finish', at: endedAt,
    kind: 'user', actor: 'client', outcome: 'passed' });
  await store.flush();

  const response = await app.request(`${host}/v1/observe?limit=1`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ completed: [{ id: requestId, outcome: 'passed', startedAt, endedAt }] });
  expect((await store.list()).events).toHaveLength(maxEvents);
});
