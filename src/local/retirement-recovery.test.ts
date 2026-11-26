import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import type { Registry } from '../registry.js';
import { JsonToolBridge } from './json-tool-bridge.js';
import { RETIRED_REOPEN_MS, MAX_RETIRED_REOPEN_MS, retiredReopenDelay } from './routing-history.js';
import { RETIRE_AFTER_FAILURES } from './routing.js';
import { SourceError, Sources, requestRefusal } from './source.js';
import type { ModelRequest, Source } from './source.js';

// Retirement must follow provider health: local request-shape refusals never count, short Retry-After hints are
// cooldowns, and a retired route gets one real trial after a bounded wait instead of waiting a day.
afterEach(() => vi.restoreAllMocks());
const registry: Registry = { ...bundledRegistry, adapters: ['opencode', 'kilo'].map(id => ({ ...bundledRegistry.adapters.find(adapter => adapter.id === id)!, weight: 0.5 })) };
const ask = (content: string): ModelRequest => ({ model: 'grunt', messages: [{ role: 'user', content }], cwd: '/tmp', tools: [], stream: false });
const source = (id: string, fail?: () => SourceError): Source => ({ id, supportsFunctionTools: true, available: vi.fn(async () => true),
  complete: vi.fn(async () => { if (fail) throw fail(); return { text: `${id} done` }; }) });
const MIN = 60 * 1000;
function pool(fail: () => SourceError) {
  let now = Date.parse('2026-11-20T00:00:00Z');
  const a = source('opencode', fail), b = source('kilo');
  const sources = new Sources([a, b], { registry: () => registry, random: () => 0, now: () => now });
  return { a, b, sources, advance: (ms: number) => { now += ms; } };
}
let tasks = 0;
const turn = (routes: ReturnType<typeof pool>) => routes.sources.complete(ask(`task ${++tasks}`), AbortSignal.timeout(1000));
async function retire(routes: ReturnType<typeof pool>) {
  for (let i = 0; i < RETIRE_AFTER_FAILURES; i++) {
    await turn(routes);
    if (!routes.sources.retired('opencode')) routes.advance(2 * 60 * MIN + 1);
  }
  expect(routes.sources.retired('opencode')).toBe(true);
}

it.each(['request_tools', 'request_tool_schema', 'request_body', 'request_size'] as const)('never retires or cools down a route for a local %s refusal', async failureReason => {
  const routes = pool(() => new SourceError('refused', 'Synthetic', undefined, undefined, { failureReason }));
  try {
    for (let i = 0; i < RETIRE_AFTER_FAILURES * 2; i++) {
      await expect(turn(routes)).resolves.toEqual({ text: 'kilo done' });
      expect(routes.sources.retired('opencode')).toBe(false);
    }
    // Still drawn every time: a refusal never benched it.
    expect(routes.a.complete).toHaveBeenCalledTimes(RETIRE_AFTER_FAILURES * 2);
    expect(routes.sources.status().sources.find(row => row.id === 'opencode')!.state).not.toBe('error');
  } finally { await routes.sources.close(); }
});

it('marks the JsonToolBridge conversation refusal as a local request refusal', () => {
  const broken = { model: 'grunt', cwd: '/tmp', stream: false, tools: [], messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'orphan', tool_call_id: 'nope' }] };
  let error: unknown;
  try { new JsonToolBridge(broken); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(SourceError);
  expect(error).toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_tools' } });
  expect(requestRefusal('x', 'request_tool_schema').diagnostics).toEqual({ failureReason: 'request_tool_schema' });
});

it('treats a 503 with a short Retry-After as a cooldown that never retires the route', async () => {
  const routes = pool(() => new SourceError('upstream', 'Overloaded', 20, undefined, { httpStatus: 503 }));
  try {
    for (let i = 0; i < RETIRE_AFTER_FAILURES * 2; i++) {
      await turn(routes);
      expect(routes.sources.retired('opencode')).toBe(false);
      routes.advance(21 * 1000);
    }
    expect(routes.a.complete).toHaveBeenCalledTimes(RETIRE_AFTER_FAILURES * 2);
  } finally { await routes.sources.close(); }
});

it('computes a bounded doubling reopen wait', () => {
  expect([0, 1, 2, 3, 4, 5, 20].map(retiredReopenDelay)).toEqual([15, 30, 60, 120, 240, 240, 240].map(m => m * MIN));
  expect(RETIRED_REOPEN_MS).toBe(15 * MIN);
  expect(MAX_RETIRED_REOPEN_MS).toBe(240 * MIN);
});

it('gives a retired route one real request after 15 minutes, doubling the wait per failed trial up to the cap', async () => {
  const routes = pool(() => new SourceError('upstream', 'Synthetic outage'));
  try {
    await retire(routes);
    let calls = vi.mocked(routes.a.complete).mock.calls.length;
    for (const wait of [15, 30, 60, 120, 240, 240]) {
      vi.mocked(routes.b.available).mockResolvedValue(true);
      routes.advance(wait * MIN - 2 * MIN);
      await expect(turn(routes)).resolves.toEqual({ text: 'kilo done' });
      expect(routes.sources.retired('opencode')).toBe(true);
      expect(routes.a.complete).toHaveBeenCalledTimes(calls);
      vi.mocked(routes.b.available).mockResolvedValue(false);
      routes.advance(3 * MIN);
      expect(routes.sources.retired('opencode')).toBe(false);
      await expect(turn(routes)).rejects.toMatchObject({ code: 'quota' });
      expect(routes.a.complete).toHaveBeenCalledTimes(++calls);
      expect(routes.sources.retired('opencode')).toBe(true);
    }
  } finally { await routes.sources.close(); }
});

it('clears retirement when the trial request succeeds', async () => {
  const routes = pool(() => new SourceError('upstream', 'Synthetic outage'));
  try {
    await retire(routes);
    routes.advance(16 * MIN);
    await expect(turn(routes)).resolves.toEqual({ text: 'kilo done' });
    expect(routes.a.complete).toHaveBeenCalledTimes(RETIRE_AFTER_FAILURES);
    vi.mocked(routes.b.available).mockResolvedValue(false);
    routes.advance(MIN);
    vi.mocked(routes.a.complete).mockResolvedValueOnce({ text: 'opencode back' });
    await expect(turn(routes)).resolves.toEqual({ text: 'opencode back' });
    expect(routes.sources.retired('opencode')).toBe(false);
    vi.mocked(routes.b.available).mockResolvedValue(true);
    routes.advance(MIN);
    // A later failure starts a fresh streak instead of re-retiring at once.
    await expect(turn(routes)).resolves.toBeDefined();
    routes.advance(16 * MIN);
    await turn(routes);
    expect(routes.sources.retired('opencode')).toBe(false);
  } finally { await routes.sources.close(); }
});

it('lets only one request through while a half-open trial is in flight', async () => {
  const routes = pool(() => new SourceError('upstream', 'Synthetic outage'));
  try {
    await retire(routes);
    routes.advance(16 * MIN);
    let finish!: () => void;
    vi.mocked(routes.a.complete).mockClear();
    vi.mocked(routes.a.complete).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ text: 'opencode back' }); }));
    vi.mocked(routes.b.available).mockResolvedValue(false);
    const first = turn(routes);
    await vi.waitFor(() => expect(routes.a.complete).toHaveBeenCalledTimes(1));
    await expect(turn(routes)).rejects.toMatchObject({ code: 'quota' });
    vi.mocked(routes.b.available).mockResolvedValue(true);
    routes.advance(MIN);
    await expect(turn(routes)).resolves.toEqual({ text: 'kilo done' });
    await expect(turn(routes)).resolves.toEqual({ text: 'kilo done' });
    expect(routes.a.complete).toHaveBeenCalledTimes(1);
    finish();
    await expect(first).resolves.toEqual({ text: 'opencode back' });
    expect(routes.sources.retired('opencode')).toBe(false);
  } finally { await routes.sources.close(); }
});

it('still never retires a route for quota with a reset time', async () => {
  const routes = pool(() => new SourceError('quota', 'Daily limit', 60));
  try {
    for (let i = 0; i < RETIRE_AFTER_FAILURES + 2; i++) { await turn(routes); routes.advance(61 * 1000); }
    expect(routes.sources.retired('opencode')).toBe(false);
  } finally { await routes.sources.close(); }
});
