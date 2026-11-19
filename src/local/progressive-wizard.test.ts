import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { wizard } from './wizard.js';
import { bundledRegistry } from '../registry.js';
import type { setupFallbacks } from './fallback-setup.js';

vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(async () => []), confirm: vi.fn(async () => false), isCancel: (value: unknown) => typeof value === 'symbol',
  intro: vi.fn(), outro: vi.fn(), note: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), step: vi.fn(), message: vi.fn(), success: vi.fn(), error: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), error: vi.fn(), clear: vi.fn() })
}));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-progressive-wizard-')); vi.stubEnv('GRUNT_CONFIG_DIR', directory); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const actions = (ids = ['kilo', 'perch']) => ({
  preflight: vi.fn(async () => {}), connectSquire: vi.fn(async () => {}),
  setup: vi.fn(async () => ({})), installedSources: vi.fn(async () => ''),
  loadRegistry: vi.fn(async () => ({ registry: { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => ids.includes(adapter.id)) }, origin: 'remote' as const })),
  approveDataSharing: vi.fn(async () => ({ approved: ids, skipped: [] })),
  installService: vi.fn(async () => {}), checkService: vi.fn(async () => {}),
  checkServiceSources: vi.fn(async () => {}), checkFallbackServices: vi.fn(async () => {}),
  connectHarnesses: vi.fn(async () => []),
  setupFallbacks: vi.fn(async (_options: Parameters<typeof setupFallbacks>[0]) => ({ unavailable: [] as string[] }))
});
it('serves and connects coding tools after the first verified provider while another signup is still waiting', async () => {
  const first = deferred(), late = deferred(), stub = actions();
  stub.setupFallbacks.mockImplementation(async options => {
    await options.onSettled?.('kilo', true);
    first.resolve();
    await late.promise;
    await options.onSettled?.('perch', false);
    return { unavailable: ['perch'] };
  });
  const running = wizard(undefined, stub);
  const finished = running.then(() => true, () => false);
  await first.promise;
  try {
    expect(stub.installService).toHaveBeenCalledExactlyOnceWith(['kilo', 'perch'], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(stub.checkFallbackServices).toHaveBeenCalledWith(expect.any(Array), expect.any(Number), expect.any(Function), ['kilo'], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(stub.connectHarnesses).toHaveBeenCalledOnce();
    expect(stub.connectSquire).not.toHaveBeenCalled();
  } finally { late.resolve(); await finished; }
});

it('lets anonymous verification finish while the single shared Squire bootstrap is waiting', async () => {
  const google = deferred(), first = deferred(), stub = actions();
  stub.connectSquire.mockImplementation(async () => { await google.promise; });
  stub.setupFallbacks.mockImplementation(async options => {
    const bootstrap = Promise.all([options.connect?.(), options.connect?.()]);
    await options.onSettled?.('kilo', true);
    first.resolve();
    await bootstrap;
    await options.onSettled?.('perch', true);
    return { unavailable: [] };
  });
  const running = wizard(undefined, stub);
  await first.promise;
  try {
    expect(stub.connectSquire).toHaveBeenCalledOnce();
    expect(stub.connectHarnesses).toHaveBeenCalledOnce();
    expect(stub.checkFallbackServices).toHaveBeenCalledTimes(1);
  } finally { google.resolve(); await running; }
  expect(stub.installService).toHaveBeenCalledOnce();
  expect(stub.checkFallbackServices).toHaveBeenCalledTimes(2);
});

it('returns success when a later provider fails after a usable provider was verified', async () => {
  const stub = actions();
  stub.setupFallbacks.mockImplementation(async options => {
    await options.onSettled?.('kilo', true);
    await options.onSettled?.('perch', false);
    return { unavailable: ['perch'] };
  });
  await expect(wizard(undefined, stub)).resolves.toBeUndefined();
  expect(stub.connectHarnesses).toHaveBeenCalledOnce();
  expect(stub.checkFallbackServices).toHaveBeenCalledTimes(1);
  const { readSetupSession } = await import('./setup-session.js');
  expect(await readSetupSession(directory)).toBeUndefined();
});

it('fails when no provider can answer and closes only its setup lease', async () => {
  const stub = actions();
  stub.setupFallbacks.mockResolvedValue({ unavailable: ['kilo', 'perch'] });
  await expect(wizard(undefined, stub)).rejects.toThrow('No adapters passed verification');
  expect(stub.connectHarnesses).not.toHaveBeenCalled();
  expect(stub.checkFallbackServices).not.toHaveBeenCalled();
  const { readSetupSession } = await import('./setup-session.js');
  expect(await readSetupSession(directory)).toBeUndefined();
});

it('checks each successful settlement once and rejects a provider outside the selected pool', async () => {
  const stub = actions();
  stub.setupFallbacks.mockImplementation(async options => {
    await Promise.all([options.onSettled?.('kilo', true), options.onSettled?.('kilo', true)]);
    await expect(options.onSettled?.('freebuff', true)).rejects.toThrow('Unexpected provider setup result');
    return { unavailable: ['perch'] };
  });
  await wizard(undefined, stub);
  expect(stub.checkFallbackServices).toHaveBeenCalledTimes(1);
  expect(stub.connectHarnesses).toHaveBeenCalledOnce();
});

it('limits live source checks to three while admitting every later provider without a service restart', async () => {
  const ids = ['opencode', 'kilo', 'zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit'];
  const stub = actions(ids), three = deferred(), release = deferred();
  let active = 0, peak = 0;
  stub.checkFallbackServices.mockImplementation(async () => {
    active++; peak = Math.max(peak, active); if (active === 3) three.resolve();
    await release.promise; active--;
  });
  stub.setupFallbacks.mockImplementation(async options => {
    await Promise.all(ids.map(id => options.onSettled?.(id, true)));
    return { unavailable: [] };
  });
  const running = wizard(undefined, stub);
  await three.promise;
  try { expect(active).toBe(3); expect(stub.checkFallbackServices).toHaveBeenCalledTimes(3); }
  finally { release.resolve(); await running; }
  expect(peak).toBe(3);
  expect(stub.checkFallbackServices).toHaveBeenCalledTimes(ids.length);
  expect(stub.installService).toHaveBeenCalledOnce();
  expect(stub.connectHarnesses).toHaveBeenCalledOnce();
});

it('selects coding tools before provider jobs and applies those choices at the first answer', async () => {
  const stub = actions(), late = deferred(), first = deferred(), order: string[] = [];
  const apply = vi.fn(async () => { order.push('apply'); return []; });
  const prepareHarnesses = vi.fn(async () => { order.push('choose'); return apply; });
  stub.setupFallbacks.mockImplementation(async options => {
    order.push('providers'); await options.onSettled?.('kilo', true); first.resolve();
    await late.promise; return { unavailable: ['perch'] };
  });
  const running = wizard(undefined, { ...stub, prepareHarnesses });
  await first.promise;
  try { expect(order).toEqual(['choose', 'providers', 'apply']); expect(stub.connectHarnesses).not.toHaveBeenCalled(); }
  finally { late.resolve(); await running; }
  expect(apply).toHaveBeenCalledOnce();
});

it('rediscovers tools after installation only when none existed initially', async () => {
  const stub = actions(), first = deferred(), late = deferred();
  const plan = Object.assign(vi.fn(async () => []), { discoverLater: true as const });
  stub.setupFallbacks.mockImplementation(async options => {
    await options.onSettled?.('kilo', true); first.resolve();
    await late.promise; return { unavailable: ['perch'] };
  });
  const running = wizard(undefined, { ...stub, prepareHarnesses: async () => plan });
  await first.promise;
  try { expect(plan).toHaveBeenCalledOnce(); expect(stub.connectHarnesses).not.toHaveBeenCalled(); }
  finally { late.resolve(); await running; }
  expect(stub.connectHarnesses).toHaveBeenCalledOnce();
});

it('does not rediscover tools when the user deliberately selected none', async () => {
  const stub = actions();
  const plan = vi.fn(async () => []);
  await wizard(undefined, { ...stub, prepareHarnesses: async () => plan });
  expect(plan).toHaveBeenCalledOnce();
  expect(stub.connectHarnesses).not.toHaveBeenCalled();
});

it('closes its private session and shared client when service installation fails before provider jobs', async () => {
  const { BrowserSquire } = await import('./setup.js');
  const squire = new BrowserSquire();
  const close = vi.spyOn(squire, 'close').mockResolvedValue();
  const stub = actions();
  stub.installService.mockRejectedValue(new Error('service unavailable'));
  await expect(wizard(undefined, { ...stub, createSquire: () => squire })).rejects.toThrow('service unavailable');
  expect(stub.setupFallbacks).not.toHaveBeenCalled();
  expect(stub.connectSquire).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  const { readSetupSession } = await import('./setup-session.js');
  expect(await readSetupSession(directory)).toBeUndefined();
});

it('keeps a source out of automatic readiness until its attributed verification finishes', async () => {
  const { readSetupSession } = await import('./setup-session.js');
  const stub = actions(), probe = deferred(), first = deferred(), late = deferred();
  const verify = vi.fn(async (_unavailable: string[], _port: number, _notify: (line: string) => void, ids: string[]) => {
    if (ids[0] !== 'kilo') return;
    const state = await readSetupSession(directory);
    expect(state?.owned.has('kilo')).toBe(true);
    expect(state?.pending.has('kilo')).toBe(true);
    first.resolve();
    await probe.promise;
  });
  stub.setupFallbacks.mockImplementation(async options => {
    await options.onSettled?.('kilo', true);
    const state = await readSetupSession(directory);
    expect(state?.pending.has('kilo')).toBe(false);
    expect(state?.owned.has('kilo')).toBe(true);
    expect(state?.pending.has('perch')).toBe(true);
    await late.promise;
    return { unavailable: ['perch'] };
  });
  const running = wizard(undefined, { ...stub, checkFallbackServices: verify });
  await first.promise;
  try { expect(stub.connectHarnesses).not.toHaveBeenCalled(); }
  finally { probe.resolve(); late.resolve(); await running; }
});

it('does not announce readiness after losing its setup ownership during an exact-source check', async () => {
  const sessions = await import('./setup-session.js');
  const { BrowserSquire } = await import('./setup.js');
  const controller = new AbortController();
  const fakeSession = { verify: vi.fn(async () => {}), release: vi.fn(async () => {}), hold: vi.fn(async () => {}),
    setApprovals: vi.fn(async () => {}), useKiloAccount: vi.fn(async () => {}), close: vi.fn(async () => {}), signal: controller.signal };
  vi.spyOn(sessions, 'beginSetupSession').mockResolvedValue(fakeSession);
  const squire = new BrowserSquire(), close = vi.spyOn(squire, 'close').mockResolvedValue();
  const stub = actions(), entered = deferred();
  const check = vi.fn(async (_unavailable: string[], _port: number, _notify: (line: string) => void, _ids: string[], wait?: { signal?: AbortSignal }) => {
    await new Promise<void>((_resolve, reject) => {
      wait!.signal!.addEventListener('abort', () => reject(wait!.signal!.reason), { once: true });
      entered.resolve();
    });
  });
  stub.setupFallbacks.mockImplementation(async options => {
    const checking = options.onSettled?.('kilo', true);
    await entered.promise;
    controller.abort(new Error('setup ownership lost'));
    await checking;
    return { unavailable: ['perch'] };
  });
  await expect(wizard(undefined, { ...stub, createSquire: () => squire, checkFallbackServices: check })).rejects.toThrow('setup ownership lost');
  expect(fakeSession.release).not.toHaveBeenCalled();
  expect(fakeSession.hold).toHaveBeenCalledWith('kilo');
  expect(stub.connectHarnesses).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(fakeSession.close).toHaveBeenCalledOnce();
});

it('does not run a Squire installer after an aborted connection probe', async () => {
  const { connectSquire } = await import('./wizard.js');
  const { BrowserSquire } = await import('./setup.js');
  const controller = new AbortController();
  vi.spyOn(BrowserSquire.prototype, 'connect').mockImplementation(async () => {
    controller.abort(new Error('cancel bootstrap'));
    throw new Error('connection closed');
  });
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const run = vi.fn(async () => {}), hasBroker = vi.fn(async () => false);
  await expect(connectSquire({ signal: controller.signal, run, hasBroker })).rejects.toThrow('cancel bootstrap');
  expect(run).not.toHaveBeenCalled();
  expect(hasBroker).not.toHaveBeenCalled();
});

it('isolates the Squire bootstrap child configuration from concurrent OpenCode setup and inherited provider grants', async () => {
  const { connectSquire } = await import('./wizard.js');
  const { BrowserSquire } = await import('./setup.js');
  const { configureOpenCode } = await import('./harnesses.js');
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg'));
  const provider = join(directory, 'opencode-free.json');
  const providerText = JSON.stringify({ provider: { opencode: { options: { apiKey: 'synthetic-provider-grant' } } } });
  await writeFile(provider, providerText, { mode: 0o600 });
  vi.stubEnv('OPENCODE_CONFIG', provider);
  vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValueOnce(new Error('missing broker')).mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const entered = deferred(), resume = deferred();
  let selected: string | undefined;
  const run = vi.fn(async (_binary: string, _args: string[], _interactive?: boolean, _signal?: AbortSignal, env?: NodeJS.ProcessEnv) => {
    selected = env?.OPENCODE_CONFIG;
    expect(selected).toBe(join(directory, 'squire-opencode.json'));
    expect((await stat(selected!)).mode & 0o777).toBe(0o600);
    entered.resolve();
    await resume.promise;
    // Controlled official-installer analogue: merge only its selected client file.
    const contents = JSON.parse(await readFile(selected!, 'utf8'));
    contents.mcp = { squire: { command: ['synthetic-squire'] } };
    await writeFile(selected!, JSON.stringify(contents), { mode: 0o600 });
  });
  const connecting = connectSquire({ hasBroker: async () => false, run, installer: '/synthetic/installer.js' });
  await entered.promise;
  try { await configureOpenCode(19878); }
  finally { resume.resolve(); await connecting; }
  expect(process.env.OPENCODE_CONFIG).toBe(provider);
  expect(await readFile(provider, 'utf8')).toBe(providerText);
  const global = JSON.parse(await readFile(join(directory, 'xdg/opencode/opencode.json'), 'utf8'));
  expect(global.provider.grunt).toBeDefined();
  expect(global.mcp).toBeUndefined();
  expect(JSON.parse(await readFile(selected!, 'utf8')).mcp.squire).toBeDefined();
  expect(run).toHaveBeenCalledOnce();
});

it('refuses a symlinked private Squire bootstrap client file before launching the installer', async () => {
  const { connectSquire } = await import('./wizard.js');
  const { BrowserSquire } = await import('./setup.js');
  vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValue(new Error('missing broker'));
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const protectedFile = join(directory, 'protected-user-config.json');
  await writeFile(protectedFile, '{"preserved":true}', { mode: 0o600 });
  await symlink(protectedFile, join(directory, 'squire-opencode.json'));
  const run = vi.fn(async () => {});
  await expect(connectSquire({ hasBroker: async () => false, run, installer: '/synthetic/installer.js' })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(await readFile(protectedFile, 'utf8')).toBe('{"preserved":true}');
});

it.each([true, false])('checks anonymous access before Squire and signups (harness available: %s)', async available => {
  const order: string[] = [];
  const stub = actions(['kilo', 'zro']);
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const squire = new BrowserSquire();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const selected = HARNESSES[0]!;
  const chooseHarness = vi.fn(async () => { order.push('harness'); return available ? selected : undefined; });
  const connectHarness = vi.fn(async () => { order.push('completion'); return { change: undefined, answer: 'ready' }; });
  const signupHarness = vi.fn(() => async () => {});
  const probeOperator = vi.fn(async () => true);
  stub.checkFallbackServices.mockImplementation(async (_failed, _port, _notify, ids) => { order.push(ids![0]!); });
  stub.connectSquire.mockImplementation(async () => { order.push('squire'); });
  stub.setupFallbacks.mockImplementation(async options => {
    order.push('signup');
    expect(options.adapters).toEqual(['zro']);
    await options.onSettled?.('zro', false, 'needs human verification');
    return { unavailable: ['zro'] };
  });
  await wizard(undefined, { ...stub, chooseHarness, connectHarness, signupHarness, probeOperator, createSquire: () => squire });
  expect(order).toEqual(['harness', 'kilo', ...(available ? ['completion'] : []), 'squire', 'signup']);
  expect(signupHarness).toHaveBeenCalledTimes(Number(available));
  expect(log.mock.calls.map(call => call[0])).toEqual([
    available ? '✓ harness: pi' : '… harness: Squire with human handoff',
    '✓ data sharing: on, no new sources', '✓ local service: running on port 8788',
    ...(available ? ['✓ model: grunt (kilo anonymous)'] : []),
    '✓ Trusty Squire: already set up and signed in, skipped', '1 ready; needs you: zro', 'Ready'
  ]);
});

it('prints the Zro terms handoff once and continues to the next provider', async () => {
  const { BrowserSquire } = await import('./setup.js');
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? {
    status: 'budget', session_id: 'zro-tab', observation: { dom: 'Please read and accept the terms to continue' }
  } : {});
  const handoff = vi.spyOn(squire, 'humanHandoff');
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stub = actions(['zro', 'tokenharbor']);
  stub.setupFallbacks.mockImplementation(async options => {
    const id = options.adapters![0]!;
    if (id === 'zro') {
      await expect(squire.signup(id, 'https://zro.moonmath.ai/sign-up', 'Verify free access')).rejects.toThrow('needs Terms of Service acceptance');
      await options.onSettled?.(id, false, squire.signupFailure(id));
      return { unavailable: [id] };
    }
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).toMatch(/zro\s+needs you \(review the Terms of Service in the browser\)/);
    await options.onSettled?.(id, true);
    return { unavailable: [] };
  });
  await wizard(undefined, { ...stub, chooseHarness: async () => undefined, createSquire: () => squire });
  expect(stub.setupFallbacks).toHaveBeenCalledTimes(2);
  expect(handoff).not.toHaveBeenCalled();
  expect(output.mock.calls.map(([chunk]) => String(chunk)).join('').match(/zro\s+needs you/g)).toHaveLength(1);
});

it('bootstraps with Jev, switches to a verified operator and re-bootstraps when its quota runs out', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_ANONYMOUS', '1');
  const { HARNESSES } = await import('./harnesses.js');
  const { BrowserSquire } = await import('./setup.js');
  const squire = new BrowserSquire();
  let driver: Parameters<BrowserSquire['useSignupAgent']>[0];
  vi.spyOn(squire, 'useSignupAgent').mockImplementation(agent => { driver = agent; });
  const events: string[] = [];
  let instances = 0;
  const stub = actions(['kilo', 'pollinations', 'beatapi', 'zro', 'tokenharbor']);
  stub.setupFallbacks.mockImplementation(async options => {
    const id = options.adapters![0]!;
    events.push(`${id}:${driver ? 'harness' : 'jev'}`);
    if (id === 'kilo') expect(options.kiloAccount).toBe(true);
    if (id === 'beatapi' && !events.includes('tokenharbor:harness')) {
      await expect(driver!({ service: id, url: 'https://test.invalid', goal: 'test', tools: [], signal: new AbortController().signal, call: async () => ({}) })).rejects.toThrow('quota');
      await options.onSettled?.(id, false, 'quota exhausted');
      return { unavailable: [id] };
    }
    await options.onSettled?.(id, id !== 'kilo', id === 'kilo' ? 'provider refused' : undefined);
    return { unavailable: id === 'kilo' ? [id] : [] };
  });
  const probeOperator = vi.fn(async (_port, id: string) => { events.push(`tool:${id}`); return true; });
  const connectHarness = vi.fn(async () => ({ change: undefined, answer: 'ready' }));
  await wizard(undefined, {
    ...stub, chooseHarness: async () => HARNESSES[0], createSquire: () => squire, probeOperator, connectHarness,
    signupHarness: () => { const instance = ++instances; return async () => { if (instance === 1) throw new Error('quota exhausted'); }; }
  });
  expect(events).toEqual(['kilo:jev', 'pollinations:jev', 'tool:pollinations', 'beatapi:harness', 'zro:jev', 'tool:zro', 'tokenharbor:harness', 'beatapi:harness']);
  expect(connectHarness).toHaveBeenCalledTimes(2);
});
