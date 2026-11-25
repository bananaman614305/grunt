import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { StickyRouter } from './routing.js';
import { SourceError } from './source.js';
import { ConsentSource } from './consent-source.js';
import { Freebuff } from './freebuff.js';
import { Kilo } from './kilo.js';
import { MistralVibe } from './mistral-vibe.js';
import { Perch } from './perch.js';
import { Pollinations } from './pollinations.js';
import { Zro } from './zro.js';
import type { Completion, ModelRequest, Source } from './source.js';

// A request with function tools draws from native tool-calling sources before JSON-bridged ones
// (mistral-vibe, perch, pollinations). A model behind the bridge is only asked, in prose, to answer with a
// tool envelope and once declined to use the Agent tool, so it serves tool work only when nothing native can.
const routers: StickyRouter[] = [];
afterEach(async () => { await Promise.all(routers.splice(0).map(router => router.close())); });
const read = { type: 'function' as const, function: { name: 'read', parameters: { type: 'object' } } };
const ask = (content: string, patch: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'grunt', messages: [{ role: 'user', content }], cwd: '/tmp', tools: [read], stream: false, ...patch });
const text = (content: string, patch: Partial<ModelRequest> = {}) => ask(content, { tools: [], ...patch });
const source = (id: string, bridged = false): Source => ({ id, supportsFunctionTools: true, ...(bridged ? { jsonToolBridge: true } : {}), available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: id })) });
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
// Bridged sources come first in the source list, so a fixed draw of 0 would pick one if bridged sources were still drawn.
function pool(items: Source[], attempt: (source: Source, request: ModelRequest, signal: AbortSignal) => Promise<Completion>, extra: Partial<ConstructorParameters<typeof StickyRouter>[1]> = {}, weights: Record<string, number> = {}) {
  const router = new StickyRouter(items, {
    registry: () => ({ ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: weights[item.id] ?? 1 })) }),
    random: () => 0, attempt, ...extra
  });
  routers.push(router);
  return router;
}
const answer = async (item: Source) => ({ text: item.id });
const mixed = () => [source('mistral-vibe', true), source('perch', true), source('kilo'), source('livekit'), source('runcrate')];

it.each([0, 0.2, 0.5, 0.99])('draws a native source for a first request with tools whatever the draw (%s)', async random => {
  const picked: string[] = [];
  const router = pool(mixed(), async item => { picked.push(item.id); return answer(item); }, { random: () => random });
  const result = await router.complete(ask('first draw'), AbortSignal.timeout(2000));
  expect(['kilo', 'livekit', 'runcrate']).toContain(result.text);
  expect(picked).toEqual([result.text]);
});

it('keeps the pool weights among native sources', async () => {
  const picks = async (random: number) => {
    const picked: string[] = [];
    const router = pool(mixed(), async item => { picked.push(item.id); return answer(item); }, { random: () => random }, { 'mistral-vibe': 100, perch: 100, kilo: 1, livekit: 3, runcrate: 1 });
    await router.complete(ask(`weights ${random}`), AbortSignal.timeout(2000));
    return picked[0];
  };
  // Draw points over the 5 native weight units, in source order kilo (1), livekit (3), runcrate (1).
  expect(await picks(0.1)).toBe('kilo'); expect(await picks(0.5)).toBe('livekit'); expect(await picks(0.95)).toBe('runcrate');
});

it('still draws a bridged source for a text-only request, with the unchanged weighted draw', async () => {
  const picked: string[] = [];
  const router = pool(mixed(), async item => { picked.push(item.id); return answer(item); });
  await router.complete(text('no tools'), AbortSignal.timeout(2000));
  expect(picked).toEqual(['mistral-vibe']);
});

it('serves from a bridged source when no native source is eligible', async () => {
  const picked: string[] = [];
  const bridged = [source('mistral-vibe', true), source('perch', true), source('kilo')];
  const router = pool(bridged, async item => { picked.push(item.id); return answer(item); }, { disabled: new Set(['kilo']), random: () => 0.9 });
  await expect(router.complete(ask('bridged only'), AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'perch' });
  expect(picked).toEqual(['perch']);
});

it('serves from a bridged-only pool', async () => {
  const router = pool([source('mistral-vibe', true), source('perch', true)], answer);
  await expect(router.complete(ask('all bridged'), AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'mistral-vibe' });
});

it('falls back to another native source, then to a bridged one only when every native source has failed', async () => {
  const picked: string[] = [];
  const router = pool(mixed(), async item => {
    picked.push(item.id);
    if (['kilo', 'livekit', 'runcrate'].includes(item.id)) throw new SourceError('upstream', 'overloaded', 30);
    return answer(item);
  });
  await expect(router.complete(ask('fallback'), AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'mistral-vibe' });
  expect(picked.slice(0, 3).sort()).toEqual(['kilo', 'livekit', 'runcrate']);
  expect(picked.slice(3)).toEqual(['mistral-vibe']);
});

it('does not take a bridged source while a native fallback is eligible', async () => {
  const picked: string[] = [];
  const router = pool(mixed(), async item => { picked.push(item.id); if (item.id === 'kilo') throw new SourceError('quota', 'limit', 3600); return answer(item); });
  await expect(router.complete(ask('native fallback'), AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'livekit' });
  expect(picked).toEqual(['kilo', 'livekit']);
});

it('lets a task bound to a bridged source keep it, and leaves it only when it fails', async () => {
  const picked: string[] = [];
  const disabled = new Set(['kilo', 'livekit', 'runcrate']);
  let failBridged = false;
  const router = pool(mixed(), async item => {
    picked.push(item.id);
    if (item.id === 'mistral-vibe' && failBridged) throw new SourceError('upstream', 'down', 30);
    return answer(item);
  }, { disabled });
  const request = ask('bound session');
  await router.complete(request, AbortSignal.timeout(2000));
  expect(picked).toEqual(['mistral-vibe']);
  // Native sources become eligible mid-session. The task is bound, so it stays.
  disabled.clear();
  const next = { ...request, messages: [...request.messages, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'ok', tool_call_id: 'c1' }] };
  await router.complete(next, AbortSignal.timeout(2000));
  expect(picked).toEqual(['mistral-vibe', 'mistral-vibe']);
  // A failure releases the binding: the fallback draws native first.
  failBridged = true;
  const result = await router.complete(next, AbortSignal.timeout(2000));
  expect(['kilo', 'livekit', 'runcrate']).toContain(result.text);
});

it('does not apply to an explicit source selection', async () => {
  const picked: string[] = [];
  const router = pool(mixed(), async item => { picked.push(item.id); return answer(item); });
  await router.complete(ask('explicit', { model: 'mistral-vibe' }), AbortSignal.timeout(2000));
  expect(picked).toEqual(['mistral-vibe']);
});

it('does not change which sources are eligible: a benched native source is skipped, and a quota-limited pool uses the bridged one', async () => {
  const items = [source('mistral-vibe', true), source('kilo')];
  vi.mocked(items[1]!.available).mockResolvedValue(false);
  const router = pool(items, answer);
  await expect(router.complete(ask('native unavailable'), AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'mistral-vibe' });
});

it('waits for a native availability check instead of drawing a bridged source on a cold cache', async () => {
  const open = gate(), items = mixed();
  for (const item of items) if (item.id !== 'kilo') vi.mocked(item.available).mockResolvedValue(item.id === 'mistral-vibe' || item.id === 'perch');
  vi.mocked(items.find(item => item.id === 'kilo')!.available).mockImplementation(async () => { await open.promise; return true; });
  const picked: string[] = [];
  const router = pool(items.filter(item => item.id !== 'livekit' && item.id !== 'runcrate'), async item => { picked.push(item.id); return answer(item); });
  const running = router.complete(ask('cold cache'), AbortSignal.timeout(3000));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(picked).toEqual([]);
  open.open();
  await expect(running).resolves.toMatchObject({ text: 'kilo' });
});

it('spreads concurrent tool tasks across idle native sources and never to a bridged one', async () => {
  const picked: string[] = [], hold = gate();
  const router = pool(mixed(), async item => { picked.push(item.id); await hold.promise; return answer(item); });
  const tasks = [1, 2, 3].map(n => router.complete(ask(`subagent ${n}`), AbortSignal.timeout(5000)));
  await vi.waitFor(() => expect(picked).toHaveLength(3));
  expect([...picked].sort()).toEqual(['kilo', 'livekit', 'runcrate']);
  hold.open();
  await Promise.all(tasks);
});

it('shares busy native sources when there are more subagents than idle native sources, leaving bridged ones unused', async () => {
  const picked: string[] = [], hold = gate();
  const router = pool(mixed(), async item => { picked.push(item.id); await hold.promise; return answer(item); });
  const tasks = [1, 2, 3, 4, 5].map(n => router.complete(ask(`crowd ${n}`), AbortSignal.timeout(5000)));
  await vi.waitFor(() => expect(picked).toHaveLength(5));
  expect(new Set(picked.slice(0, 3)).size).toBe(3);
  expect(picked.filter(id => id === 'mistral-vibe' || id === 'perch')).toEqual([]);
  hold.open();
  await Promise.all(tasks);
});

it('spreads concurrent text-only tasks across all idle sources as before', async () => {
  const picked: string[] = [], hold = gate();
  const router = pool(mixed(), async item => { picked.push(item.id); await hold.promise; return answer(item); });
  const tasks = [1, 2, 3, 4, 5].map(n => router.complete(text(`plain ${n}`), AbortSignal.timeout(5000)));
  await vi.waitFor(() => expect(picked).toHaveLength(5));
  expect(new Set(picked).size).toBe(5);
  hold.open();
  await Promise.all(tasks);
});

it('marks exactly the JSON-bridged adapters, and keeps the mark through a consent guard', async () => {
  const bridged = [new MistralVibe(), new Perch(), new Pollinations(), new Freebuff({ toolBridge: true })];
  const native = [new Kilo(), new Zro(), new Freebuff()];
  expect(bridged.map(item => item.jsonToolBridge)).toEqual([true, true, true, true]);
  expect(native.map(item => item.jsonToolBridge === true)).toEqual([false, false, false]);
  expect(new ConsentSource(bridged[0]!, '/nonexistent').jsonToolBridge).toBe(true);
  expect(new ConsentSource(native[0]!, '/nonexistent').jsonToolBridge).toBeUndefined();
  await Promise.all([...bridged, ...native].map(item => item.close?.()));
});
