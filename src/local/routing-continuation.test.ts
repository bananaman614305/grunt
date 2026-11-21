import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { StickyRouter } from './routing.js';
import { SourceStatus } from './source-status.js';
import { withRoutingWorkload } from './routing-history.js';

const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'Continue the synthetic task.' }], cwd: '/tmp', tools: [{ type: 'function', function: { name: 'read', parameters: {} } }], stream: false };
const routers: StickyRouter[] = [];
afterEach(async () => { await Promise.all(routers.splice(0).map(router => router.close())); vi.restoreAllMocks(); });

async function fixture(options: { samples?: number; slowMs?: number; fastMs?: number; seedTools?: boolean } = {}) {
  let now = 1000, slowMs = options.slowMs ?? 60000, fastMs = options.fastMs ?? 2000;
  const slow: Source & { complete: ReturnType<typeof vi.fn> } = { id: 'kilo', supportsFunctionTools: true, available: vi.fn(async () => true), complete: vi.fn(async () => { now += slowMs; return { text: 'slow' }; }) };
  const fast: Source & { complete: ReturnType<typeof vi.fn> } = { id: 'numes', supportsFunctionTools: true, available: vi.fn(async () => true), complete: vi.fn(async () => { now += fastMs; return { text: 'fast' }; }) };
  const observation = new SourceStatus([slow.id, fast.id], () => now), pending = new Set<string>();
  const registry = { ...bundledRegistry, adapters: [slow, fast].map(source => ({ ...bundledRegistry.adapters.find(adapter => adapter.id === source.id)!, weight: 1, fit: 'great' as const })) };
  const router = new StickyRouter([slow, fast], { observation, registry: () => registry, random: () => 0, now: () => now, pending });
  routers.push(router);
  const seedRequest = options.seedTools === false ? { ...request, tools: [] } : request;
  for (const source of [slow, fast]) for (let i = 0; i < (options.samples ?? 5); i++) {
    await observation.complete(source, seedRequest, new AbortController().signal);
  }
  slow.complete.mockClear(); fast.complete.mockClear();
  const run = (input = request) => router.complete(input, AbortSignal.timeout(1000));
  return { router, observation, slow, fast, pending, run, registry, advance: (ms: number) => { now += ms; }, speed: (slow: number, fast: number) => { slowMs = slow; fastMs = fast; }, elapsed: () => now };
}

it('moves a slow automatic Pi continuation only after two successful boundaries support the same measured improvement', async () => {
  const f = await fixture();
  expect((await f.run()).text).toBe('slow');
  expect((await f.run()).text).toBe('slow');
  const before = f.elapsed();
  expect((await f.run()).text).toBe('fast');
  expect(f.elapsed() - before).toBe(2000);
  expect(f.slow.complete).toHaveBeenCalledTimes(2);
  expect(f.fast.complete).toHaveBeenCalledOnce();
  const input = f.fast.complete.mock.calls[0]![0] as ModelRequest;
  expect(input.handoffPrompt).toContain('Continue the synthetic task.');
  expect(input.messages.slice(0, request.messages.length)).toEqual(request.messages);
});

it.each([{ samples: 4 }, { slowMs: 30000 }, { seedTools: false }])('keeps a healthy binding with insufficient matching evidence or net advantage: %j', async options => {
  const f = await fixture(options);
  for (let i = 0; i < 3; i++) expect((await f.run()).text).toBe('slow');
  expect(f.fast.complete).not.toHaveBeenCalled();
});

it('never changes an explicit source or a native-tool binding for performance', async () => {
  const explicit = await fixture();
  for (let i = 0; i < 4; i++) expect((await explicit.run({ ...request, model: explicit.slow.id })).text).toBe('slow');
  expect(explicit.fast.complete).not.toHaveBeenCalled();
  const native = await fixture();
  native.slow.supportsFunctionTools = false;
  // Without Pi tools the native agent may remain bound, but is never proactively migrated.
  for (let i = 0; i < 4; i++) expect((await native.run({ ...request, tools: [] })).text).toBe('slow');
  expect(native.fast.complete).not.toHaveBeenCalled();
});

it('honors an explicit source after the same user-turn key was automatically bound elsewhere', async () => {
  const f = await fixture();
  expect((await f.run()).text).toBe('slow');
  expect((await f.run({ ...request, model: f.fast.id })).text).toBe('fast');
  // Explicit selection does not replace the separate automatic continuation.
  expect((await f.run()).text).toBe('slow');
  expect(f.fast.complete).toHaveBeenCalledOnce();
});

it('does not mistake stale or background-only observations for current continuation evidence', async () => {
  const f = await fixture();
  await f.run();
  f.advance(10 * 60 * 1000 + 1);
  for (let i = 0; i < 3; i++) expect((await f.run()).text).toBe('slow');
  expect(f.fast.complete).not.toHaveBeenCalled();
  const background = await fixture({ samples: 0 });
  for (const source of [background.slow, background.fast]) for (let i = 0; i < 5; i++) await withRoutingWorkload('background-tools', () => background.observation.complete(source, request, new AbortController().signal));
  background.fast.complete.mockClear();
  for (let i = 0; i < 3; i++) expect((await background.run()).text).toBe('slow');
  expect(background.fast.complete).not.toHaveBeenCalled();
});

it('charges retransmitted context/cache cost before deciding whether switching is worthwhile', async () => {
  const f = await fixture(), large = { ...request, messages: [{ role: 'user', content: 'x'.repeat(128 * 1024) }] };
  for (let i = 0; i < 4; i++) expect((await f.run(large)).text).toBe('slow');
  expect(f.fast.complete).not.toHaveBeenCalled();
});

it('keeps the exact approved payload when a scoped provider is the measured alternative', async () => {
  const f = await fixture(), approved = { ...request, publicContext: true as const };
  f.fast.acceptsRequest = input => input.publicContext === true;
  await f.run(approved); await f.run(approved);
  expect((await f.run(approved)).text).toBe('fast');
  expect(f.fast.complete.mock.calls[0]![0]).toEqual(approved);
});

it.each(['pending', 'cooldown', 'consent', 'unavailable', 'fit'] as const)('does not promote a faster route rejected by %s guards', async guard => {
  const f = await fixture();
  await f.run(); await f.run();
  if (guard === 'pending') f.pending.add(f.fast.id);
  if (guard === 'cooldown') await f.router.recordFailure(f.fast.id, new SourceError('quota', 'Synthetic quota', 120));
  if (guard === 'consent') f.fast.acceptsRequest = () => false;
  if (guard === 'unavailable') { vi.mocked(f.fast.available).mockResolvedValue(false); await f.observation.available(f.fast); }
  if (guard === 'fit') f.registry.adapters[1]!.fit = 'possible';
  expect((await f.run()).text).toBe('slow');
  expect(f.fast.complete).not.toHaveBeenCalled();
});

it('does not migrate to a faster route with worse observed reliability', async () => {
  const f = await fixture();
  await f.run(); await f.run();
  await expect(f.observation.complete({ ...f.fast, complete: async () => { throw new SourceError('upstream', 'Synthetic failed sample'); } }, request, new AbortController().signal)).rejects.toThrow();
  for (let i = 0; i < 3; i++) expect((await f.run()).text).toBe('slow');
  expect(f.fast.complete).not.toHaveBeenCalled();
});

it('does not migrate onto another request already using the faster route', async () => {
  const f = await fixture();
  await f.run(); await f.run();
  let finish!: () => void;
  const busy = f.observation.complete({ ...f.fast, complete: () => new Promise(resolve => { finish = () => resolve({ text: 'other task' }); }) }, request, new AbortController().signal);
  try {
    expect((await f.run()).text).toBe('slow');
    expect(f.fast.complete).not.toHaveBeenCalled();
  } finally { finish(); await busy; }
});

it('holds the new binding for at least five minutes even if alternate measurements reverse', async () => {
  const f = await fixture();
  await f.run(); await f.run(); expect((await f.run()).text).toBe('fast');
  f.speed(250, 60000);
  for (let i = 0; i < 5; i++) await f.observation.complete(f.slow, request, new AbortController().signal);
  const before = f.slow.complete.mock.calls.length;
  for (let i = 0; i < 3; i++) expect((await f.run()).text).toBe('fast');
  expect(f.slow.complete).toHaveBeenCalledTimes(before);
});

it('preserves an in-flight bound request and rejects an overlapping task without starting another inference', async () => {
  const f = await fixture();
  await f.run(); await f.run();
  let finish!: () => void;
  f.fast.complete.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ text: 'finished' }); }));
  const pending = f.run();
  await vi.waitFor(() => expect(f.fast.complete).toHaveBeenCalledOnce());
  await expect(f.run()).rejects.toMatchObject({ code: 'upstream' });
  expect(f.slow.complete).toHaveBeenCalledTimes(2);
  expect(f.fast.complete).toHaveBeenCalledOnce();
  finish(); expect((await pending).text).toBe('finished');
});
