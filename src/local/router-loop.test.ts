import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry, localOptInAdapters } from '../registry.js';
import type { Registry } from '../registry.js';
import { configure } from './main.js';
import { recordDataSharingConsent, requiresDataSharing } from './data-sharing.js';
import { MAX_OPEN_ROUTES, SourceRecovery } from './recovery.js';
import { recommendedAdapters, RETIRE_AFTER_FAILURES } from './routing.js';
import { beginSetupSession, readSetupSession } from './setup-session.js';
import { SourceError, Sources } from './source.js';
import type { ModelRequest, Source } from './source.js';
import type { SignupAgent } from './signup-mcp.js';

// Router loop behaviour from docs/router.md, tested on synthetic sources only.
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'grunt-router-loop-')); dirs.push(dir); return dir; };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
// Every candidate below has its data-sharing consent recorded, as setup would.
const consented = async (ids: string[]) => { const dir = await directory(); await recordDataSharingConsent(dir, ids.filter(id => requiresDataSharing(id))); return dir; };
const registry: Registry = { ...bundledRegistry, adapters: ['opencode', 'kilo'].map(id => ({ ...bundledRegistry.adapters.find(adapter => adapter.id === id)!, weight: 0.5 })) };
const tools = [{ type: 'function' as const, function: { name: 'operate_drive', parameters: {} } }];
const ask = (content: string, withTools = false): ModelRequest => ({ model: 'grunt', messages: [{ role: 'user', content }], cwd: '/tmp', tools: withTools ? tools : [], stream: false });
const source = (id: string, fail?: () => SourceError): Source => ({ id, supportsFunctionTools: true, available: vi.fn(async () => true),
  complete: vi.fn(async () => { if (fail) throw fail(); return { text: `${id} done` }; }) });
function pool(fail: () => SourceError) {
  let now = Date.parse('2026-11-20T00:00:00Z');
  const a = source('opencode', fail), b = source('kilo');
  const sources = new Sources([a, b], { registry: () => registry, random: () => 0, now: () => now });
  return { a, b, sources, advance: (ms: number) => { now += ms; } };
}
// Each failure lands after the previous bench (<= 2 h) and within the 6 h window.
let tasks = 0;
async function failRepeatedly(routes: ReturnType<typeof pool>, times: number) {
  for (let i = 0; i < times; i++) {
    // A new task each time, so stickiness to the fallback route does not hide the failing one.
    await routes.sources.complete(ask(`task ${++tasks}`), AbortSignal.timeout(1000));
    routes.advance(2 * 60 * 60 * 1000 + 1);
  }
}

it(`retires a route on its ${RETIRE_AFTER_FAILURES}th consecutive identical failure, and a health check brings it back`, async () => {
  const routes = pool(() => new SourceError('upstream', 'Synthetic outage'));
  await failRepeatedly(routes, RETIRE_AFTER_FAILURES - 1);
  expect(routes.sources.retired('opencode')).toBe(false);
  await failRepeatedly(routes, 1);
  expect(routes.sources.retired('opencode')).toBe(true);
  const calls = vi.mocked(routes.a.complete).mock.calls.length;
  routes.advance(24 * 60 * 60 * 1000);
  await expect(routes.sources.complete(ask('after retirement'), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'kilo done' });
  expect(routes.a.complete).toHaveBeenCalledTimes(calls);
  // A newer registry listing it, or a passing daily check, gives it a fresh try.
  routes.sources.unretire(['opencode']);
  expect(routes.sources.retired('opencode')).toBe(false);
  vi.mocked(routes.a.complete).mockResolvedValueOnce({ text: 'opencode back' });
  await expect(routes.sources.complete(ask('fresh try'), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'opencode back' });
});

it('never retires a route for quota, which is availability rather than failure', async () => {
  const routes = pool(() => new SourceError('quota', 'Synthetic daily limit', 60));
  await failRepeatedly(routes, RETIRE_AFTER_FAILURES + 2);
  expect(routes.sources.retired('opencode')).toBe(false);
});

it('hands the driver\'s task to the next tool-capable route when its bound route is retired', async () => {
  const routes = pool(() => new SourceError('upstream', 'Synthetic outage'));
  vi.mocked(routes.a.complete).mockResolvedValueOnce({ text: 'opencode drives' });
  const turn = ask('Set up the free zro provider', true);
  await expect(routes.sources.complete(turn, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'opencode drives' });
  await failRepeatedly(routes, RETIRE_AFTER_FAILURES);
  expect(routes.sources.retired('opencode')).toBe(true);
  await expect(routes.sources.complete(turn, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'kilo done' });
  const handed = vi.mocked(routes.b.complete).mock.calls.at(-1)![0];
  expect(handed.handoffPrompt).toMatch(/Original task:\nSet up the free zro provider[\s\S]*Do not restart/);
});

it('does not route a scout-retired (expiring or inactive) adapter', async () => {
  const listed = { ...registry, adapters: registry.adapters.map(adapter => adapter.id === 'opencode' ? { ...adapter, status: 'expiring' as const } : adapter) };
  const a = source('opencode'), b = source('kilo');
  const sources = new Sources([a, b], { registry: () => listed, random: () => 0 });
  await expect(sources.complete(ask('hello'), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'kilo done' });
  expect(a.complete).not.toHaveBeenCalled();
});

function pass(ids: string[], opened: number, succeeds: (id: string) => boolean) {
  const order: { id: string; agent: boolean }[] = [];
  let open = opened;
  const agent: SignupAgent = async () => {};
  const setup = vi.fn(async (options: { adapters?: string[]; agent?: SignupAgent }) => {
    const id = options.adapters![0]!;
    order.push({ id, agent: options.agent === agent });
    if (succeeds(id)) { open++; return { unavailable: [] }; }
    return { unavailable: [id] };
  });
  return { order, setup, options: { candidates: async () => ids, open: async () => open, driver: async () => open > 0 ? agent : undefined, notify: () => {}, setup: setup as never } };
}

it(`stops at N = ${MAX_OPEN_ROUTES} open routes when the registry lists more`, async () => {
  const ids = ['tokenharbor', 'runcrate', 'beatapi', 'zro', 'kenari', 'numes', 'goedel', 'darus', 'fikra', 'openference'];
  const run = pass(ids, 2, () => true);
  const recovery = new SourceRecovery({ directory: await consented(ids), ...run.options });
  recovery.trigger(); await settle(); await recovery.close();
  expect(run.order.map(entry => entry.id)).toEqual(ids.slice(0, MAX_OPEN_ROUTES - 2));
});

it('lets the first route that signs up drive the rest, and makes at most N attempts per pass', async () => {
  const ids = ['tokenharbor', 'runcrate', 'beatapi', 'zro', 'kenari', 'numes', 'goedel', 'darus'];
  const run = pass(ids, 0, id => id === 'runcrate');
  const recovery = new SourceRecovery({ directory: await consented(ids), ...run.options });
  recovery.trigger(); await settle(); await recovery.close();
  expect(run.order).toEqual(ids.slice(0, MAX_OPEN_ROUTES).map((id, index) => ({ id, agent: index > 1 })));
});

it('moves last pass\'s failed signups to the end so they cannot starve the rest', async () => {
  const ids = ['tokenharbor', 'runcrate', 'beatapi', 'zro', 'kenari', 'numes', 'goedel', 'darus'];
  const run = pass(ids, 0, () => false);
  const recovery = new SourceRecovery({ directory: await consented(ids), ...run.options });
  recovery.trigger(); await settle();
  expect(run.order).toHaveLength(MAX_OPEN_ROUTES);
  recovery.trigger(); await settle();
  expect(run.order).toHaveLength(2 * MAX_OPEN_ROUTES);
  expect(run.order.slice(MAX_OPEN_ROUTES, MAX_OPEN_ROUTES + 2).map(entry => entry.id)).toEqual(['goedel', 'darus']);
  await recovery.close();
});

it('skips the pass while foreground setup owns signups', async () => {
  const run = pass(['zro'], 0, () => true);
  const dir = await directory();
  const session = await beginSetupSession(dir, ['zro']);
  const recovery = new SourceRecovery({ directory: dir, ...run.options });
  try {
    recovery.trigger(); await settle(); await recovery.close();
    expect(run.setup).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it('hot-adds a newly listed shipped adapter in the automatic pool, not in a manual source list', async () => {
  const dir = await directory();
  const nvidia = { id: 'nvidia', kind: 'model' as const, tier: 'experimental' as const, weight: 0.01, modalities: ['text' as const], install: 'builtin:nvidia' };
  const automatic = configure({ GRUNT_CONFIG_DIR: dir }, () => bundledRegistry);
  expect(automatic.sources.map(source => source.id)).not.toContain('nvidia');
  automatic.adopt({ ...bundledRegistry, adapters: [...bundledRegistry.adapters, nvidia] });
  expect(automatic.sources.map(source => source.id)).toContain('nvidia');
  expect(automatic.status().sources.map(row => row.id)).toContain('nvidia');
  const manual = configure({ GRUNT_CONFIG_DIR: dir, GRUNT_SOURCES: 'kilo' }, () => bundledRegistry);
  manual.adopt({ ...bundledRegistry, adapters: [...bundledRegistry.adapters, nvidia] });
  expect(manual.sources.map(source => source.id)).toEqual(['kilo']);
  await Promise.all([automatic.close(), manual.close()]);
});

it('lets a background signup use the driver instead of dropping for a foreground signup', async () => {
  const { BrowserSquire, setupProviders } = await import('./setup.js');
  const agent = vi.fn<SignupAgent>(async run => { await run.call('operate_drive', {}); await run.call('operate_drive', {}); });
  const squire = new BrowserSquire({ background: true, agent });
  const client = (squire as unknown as { client: { listTools(): Promise<unknown> } }).client;
  vi.spyOn(client, 'listTools').mockResolvedValue({ tools: [{ name: 'operate_drive', inputSchema: { type: 'object' } }] });
  let drives = 0;
  vi.spyOn(squire, 'call').mockImplementation(async name => name !== 'operate_drive' ? {}
    : ++drives === 1 ? { status: 'low_confidence', session_id: 'zro-tab', options: {} } : { status: 'complete', session_id: 'zro-tab' });
  vi.spyOn(squire.credentials, 'list').mockImplementation(async () => drives > 1 ? [{ service: 'zro', reference: 'synthetic', field_names: ['api_key'] }] : []);
  vi.spyOn(squire.credentials, 'grant').mockResolvedValue({ base_url: 'https://squire.test', token: 'synthetic' });
  const result = await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
  expect(agent).toHaveBeenCalledOnce();
  expect(result.dropped).toEqual([]);
  await squire.close();
});

it('excludes a benched route from usable capacity even when its catalog stays available', async () => {
  const routes = pool(() => new SourceError('upstream', 'Synthetic outage'));
  try {
    expect(routes.sources.dispatchEligible('opencode')).toBe(true);
    await routes.sources.complete(ask('bench driver'), AbortSignal.timeout(1000));
    expect(await routes.a.available()).toBe(true);
    expect(routes.sources.dispatchEligible('opencode')).toBe(false);
    expect(routes.sources.dispatchEligible('kilo')).toBe(true);
    routes.advance(15 * 60 * 1000 + 1);
    expect(routes.sources.dispatchEligible('opencode')).toBe(true);
    routes.sources.pending.add('opencode');
    expect(routes.sources.dispatchEligible('opencode')).toBe(false);
  } finally { await routes.sources.close(); }
});

it.each(['inactive', 'expiring', 'expired'] as const)('blocks %s scout routes in fixed chains and setup probes', async state => {
  const { RegistrySource } = await import('./registry-source.js');
  const adapter = bundledRegistry.adapters.find(adapter => adapter.id === 'zro')!;
  const listed: Registry = { ...bundledRegistry, adapters: [{ ...adapter,
    ...(state === 'expired' ? { expires: '2000-01-01' } : { status: state }) }] };
  for (const fixed of [false, true]) {
    const a = source('zro');
    const sources = new Sources([fixed ? new RegistrySource(a, () => listed) : a], fixed ? undefined : { registry: () => listed });
    try {
      await expect(sources.complete({ ...ask('retired'), model: 'zro' }, AbortSignal.timeout(1000))).rejects.toThrow();
      sources.pending.add('zro'); sources.verifying.add('zro');
      await expect(sources.complete({ ...ask('probe retired'), model: 'zro' }, AbortSignal.timeout(1000))).rejects.toThrow();
      expect(a.complete).not.toHaveBeenCalled();
    } finally { await sources.close(); }
  }
});

it('preserves published scout retirement for a local opt-in', async () => {
  const listed: Registry = { ...bundledRegistry, adapters: [...bundledRegistry.adapters, {
    id: 'antseed-vikey', kind: 'model', tier: 'experimental', weight: 0.01, modalities: ['text'],
    install: 'builtin:antseed-vikey', status: 'inactive'
  }] };
  const sources = configure({ GRUNT_CONFIG_DIR: await directory(), GRUNT_OPT_IN_SOURCES: 'antseed-vikey' }, () => listed);
  const opted = sources.sources.find(source => source.id === 'antseed-vikey')!;
  const complete = vi.spyOn(opted, 'complete').mockResolvedValue({ text: 'must not answer' });
  try {
    await expect(sources.complete({ ...ask('opt-in'), model: 'antseed-vikey' }, AbortSignal.timeout(1000))).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  } finally { await sources.close(); }
});

it('reaches every candidate across capped passes with persistent failures', async () => {
  const ids = ['tokenharbor', 'runcrate', 'beatapi', 'zro', 'kenari', 'numes', 'goedel', 'darus', 'fikra', 'openference', 'pollinations', 'livekit', 'millionseek'];
  const run = pass(ids, 0, () => false);
  const dir = await consented(ids);
  const recovery = new SourceRecovery({ directory: dir, ...run.options });
  try {
    for (let i = 1; i <= 5; i++) {
      recovery.trigger();
      await vi.waitFor(() => expect(run.order).toHaveLength(i * MAX_OPEN_ROUTES));
      await vi.waitFor(async () => expect(await readSetupSession(dir)).toBeUndefined());
    }
    expect(run.order.slice(0, ids.length).map(entry => entry.id)).toEqual(ids);
    expect(run.order.slice(ids.length, 2 * ids.length).map(entry => entry.id)).toEqual(ids);
  } finally { await recovery.close(); }
});

it.each(['earlier signup', 'driver discovery', 'expiry'] as const)('rechecks recommendation after %s before opening the next route', async change => {
  let now = Date.parse('2026-11-20T23:59:59Z');
  const listed: Registry = { ...bundledRegistry, adapters: ['zro', 'runcrate'].map(id => ({
    ...bundledRegistry.adapters.find(adapter => adapter.id === id)!, fit: 'great', status: 'active', expires: '2026-11-20'
  })) };
  const dir = await consented(['zro', 'runcrate']);
  const recommended = () => recommendedAdapters(listed, now).map(adapter => adapter.id);
  let drivers = 0;
  const setup = vi.fn(async (options: { adapters?: string[] }) => {
    if (options.adapters![0] === 'zro') {
      if (change === 'earlier signup') listed.adapters[1]!.status = 'inactive';
      if (change === 'expiry') now += 2000;
    }
    return { unavailable: [] };
  });
  const recovery = new SourceRecovery({ directory: dir, candidates: async () => recommended(),
    eligible: id => recommended().includes(id), open: async () => 0,
    driver: async () => {
      await Promise.resolve();
      if (++drivers === 2 && change === 'driver discovery') listed.adapters[1]!.status = 'inactive';
      return undefined;
    }, setup: setup as never, notify: () => {} });
  try {
    recovery.trigger();
    await vi.waitFor(() => expect(setup).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await readSetupSession(dir)).toBeUndefined());
    expect(setup.mock.calls.map(([options]) => options.adapters)).toEqual([['zro']]);
  } finally { await recovery.close(); }
});

it.each(['freepi', 'goedel'] as const)('excludes %s from private signup traffic while allowing reviewed public requests', async id => {
  const { FreePi } = await import('./freepi.js');
  const { Goedel } = await import('./goedel.js');
  const dir = await directory();
  const route = id === 'freepi' ? new FreePi({ directory: dir }) : new Goedel({ directory: dir });
  const sources = new Sources([route], { registry: () => bundledRegistry });
  const request = ask('Complete a provider signup', true);
  try {
    expect(sources.dispatchEligible(id)).toBe(true);
    expect(sources.dispatchEligible(id, request)).toBe(false);
    expect(sources.dispatchEligible(id, { ...request, publicContext: true })).toBe(true);
    await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow();
  } finally { await sources.close(); }
});

it.each(['unmanaged', 'no receipt', 'authorized'] as const)('uses automatic-pool authorization for hot-adds: %s', async mode => {
  const { writeAutomaticPool } = await import('./automatic-pool.js');
  const dir = await directory();
  const initial: Registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => ['opencode', 'kilo'].includes(adapter.id)) };
  if (mode === 'authorized') await writeAutomaticPool(dir, ['opencode', 'kilo']);
  const sources = configure({ GRUNT_CONFIG_DIR: dir, GRUNT_SOURCES: 'opencode,kilo',
    ...(mode !== 'unmanaged' ? { GRUNT_DAEMON: '1' } : {}) }, () => initial);
  const added = { id: 'nvidia', kind: 'model' as const, tier: 'experimental' as const, weight: 0.01, modalities: ['text' as const], install: 'builtin:nvidia' };
  try {
    sources.adopt({ ...initial, adapters: [...initial.adapters, added] });
    expect(sources.sources.map(source => source.id)).toEqual(mode === 'authorized' ? ['opencode', 'kilo', 'nvidia'] : ['opencode', 'kilo']);
  } finally { await sources.close(); }
});

it.each(['automatic', 'managed custom', 'manual'] as const)('matches restart enrollment after hot-add for a %s pool', async mode => {
  const { writeAutomaticPool } = await import('./automatic-pool.js');
  const dir = await directory();
  let current: Registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => ['opencode', 'kilo'].includes(adapter.id)) };
  const configured = mode === 'managed custom' ? ['opencode', 'kilo', 'freellmapi'] : ['opencode', 'kilo'];
  if (mode === 'managed custom') await writeAutomaticPool(dir, configured);
  const env = { GRUNT_CONFIG_DIR: dir,
    ...(mode !== 'automatic' ? { GRUNT_SOURCES: configured.join(',') } : {}),
    ...(mode === 'managed custom' ? { GRUNT_DAEMON: '1' } : {}) };
  const sources = configure(env, () => current);
  const additions = [
    ...localOptInAdapters,
    { id: 'reflection-beam', kind: 'model' as const, tier: 'experimental' as const, weight: 0.01, modalities: ['text' as const], install: 'builtin:reflection-beam', model: 'reflection/beam-free' }
  ];
  current = { ...current, adapters: [...current.adapters, ...additions] };
  const restarted = configure(env, () => current);
  try {
    sources.adopt(current);
    sources.adopt(current);
    const ids = sources.sources.map(source => source.id);
    expect(ids).toEqual(restarted.sources.map(source => source.id));
    for (const id of ['crowllm', 'antseed-vikey', 'reflection-beam']) {
      expect(ids.includes(id)).toBe(mode !== 'manual');
    }
  } finally { await Promise.all([sources.close(), restarted.close()]); }
});

it('keeps retirement visible in status and model listings after the cooldown ends', async () => {
  const routes = pool(() => new SourceError('upstream', 'Synthetic outage'));
  try {
    await failRepeatedly(routes, RETIRE_AFTER_FAILURES);
    expect(await routes.a.available()).toBe(true);
    const projected = () => routes.sources.status().sources.find(row => row.id === 'opencode')!;
    expect(projected().state).toBe('unavailable');
    expect(await routes.sources.models()).toEqual(['grunt', 'kilo']);
    expect(routes.sources.retired('opencode')).toBe(true);
    await expect(routes.sources.complete({ ...ask('explicit retired request'), model: 'opencode' }, AbortSignal.timeout(1000))).rejects.toThrow();
    routes.sources.unretire(['opencode']);
    expect(await routes.sources.models()).toEqual(['grunt', 'opencode', 'kilo']);
    expect(routes.sources.retired('opencode')).toBe(false);
    vi.mocked(routes.a.complete).mockResolvedValueOnce({ text: 'recovered' });
    await expect(routes.sources.complete({ ...ask('revived request'), model: 'opencode' }, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'recovered' });
    expect(projected().state).toBe('ready');
  } finally { await routes.sources.close(); }
});
